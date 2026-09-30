// Package rooms owns rooms: creating them, and the live state of each (members, host,
// chat) in one goroutine per room.
package rooms

import (
	"context"
	"crypto/rand"
	"errors"
	"log/slog"
	"math/big"
	"strings"
	"sync"
	"time"

	"anda/internal/protocol"
	"anda/internal/store"
)

// codeAlphabet has no vowels (so codes can't spell words) and no look-alikes (0/O, 1/I/L).
const (
	codeAlphabet = "BCDFGHJKMNPQRSTVWXZ23456789"
	codeLen      = 6
)

var (
	ErrNotFound = errors.New("rooms: room not found")
	ErrNotOwner = errors.New("rooms: not the room's owner")
)

// historyLimit caps the rooms listed on someone's profile.
const historyLimit = 50

// MediaInfo resolves films for set_media (media.Service in production).
type MediaInfo interface {
	Info(ctx context.Context, id int64) (protocol.Media, error)
	Touch(ctx context.Context, id int64)
	// Release says no room is showing the film any more (room closed, or switched away);
	// a download still in progress for it can stop.
	Release(ctx context.Context, id int64)
}

type Manager struct {
	rooms store.Rooms
	chat  store.Chat
	media MediaInfo
	log   *slog.Logger

	// awayGrace is how long a disconnected member stays in the room before leaving.
	awayGrace time.Duration
	// idleTimeout is how long an empty room stays in memory.
	idleTimeout time.Duration

	// IdleAfter: someone connected but idle this long is asked "Still watching?".
	IdleAfter time.Duration
	// AnswerWithin: no answer to "Still watching?" by then marks them away.
	AnswerWithin time.Duration
	// TickEvery is how often rooms check for the end of the film and idle members.
	TickEvery time.Duration

	mu   sync.Mutex
	live map[string]*Room
}

func NewManager(rooms store.Rooms, chat store.Chat, media MediaInfo, log *slog.Logger) *Manager {
	return &Manager{
		rooms:        rooms,
		chat:         chat,
		media:        media,
		log:          log,
		awayGrace:    60 * time.Second,
		idleTimeout:  5 * time.Minute,
		IdleAfter:    3 * time.Hour,
		AnswerWithin: 2 * time.Minute,
		TickEvery:    5 * time.Second,
		live:         make(map[string]*Room),
	}
}

// Create makes a room owned by ownerID with a fresh code.
func (m *Manager) Create(ctx context.Context, ownerID int64) (store.Room, error) {
	for range 5 {
		code, err := newCode()
		if err != nil {
			return store.Room{}, err
		}
		room, err := m.rooms.CreateRoom(ctx, code, ownerID)
		if errors.Is(err, store.ErrCodeTaken) {
			continue
		}
		if err == nil {
			m.recordVisit(ctx, room.ID, ownerID)
		}
		return room, err
	}
	return store.Room{}, errors.New("rooms: no free code after 5 tries")
}

// Lookup returns the stored room for a code, or ErrNotFound.
func (m *Manager) Lookup(ctx context.Context, code string) (store.Room, error) {
	code, ok := NormalizeCode(code)
	if !ok {
		return store.Room{}, ErrNotFound
	}
	room, err := m.rooms.RoomByCode(ctx, code)
	if errors.Is(err, store.ErrNotFound) {
		return store.Room{}, ErrNotFound
	}
	return room, err
}

// Join adds u to the room (or re-attaches them) and sends them room_state through s.
// It returns the normalized code.
func (m *Manager) Join(ctx context.Context, code string, u protocol.User, s Sender) (string, error) {
	code, ok := NormalizeCode(code)
	if !ok {
		return "", ErrNotFound
	}
	for {
		r, err := m.getOrLoad(ctx, code)
		if err != nil {
			return "", err
		}
		if r.do(func() { r.join(u, s) }) {
			m.recordVisit(ctx, r.info.ID, u.ID)
			return code, nil
		}
		// The room shut down between lookup and join; load it again.
	}
}

// Visit is a room on someone's profile, with what's happening in it right now.
type Visit struct {
	store.VisitedRoom
	Online int    // members connected now
	Film   string // title of the film on screen, "" if none or the room isn't live
}

// Visited lists the rooms userID has been in, most recently joined first.
func (m *Manager) Visited(ctx context.Context, userID int64) ([]Visit, error) {
	rooms, err := m.rooms.VisitedRooms(ctx, userID, historyLimit)
	if err != nil {
		return nil, err
	}
	out := make([]Visit, len(rooms))
	for i, v := range rooms {
		out[i] = Visit{VisitedRoom: v}
		if r := m.get(v.Code); r != nil {
			sum := make(chan Visit, 1)
			if r.do(func() { sum <- Visit{Online: r.onlineCount(), Film: r.filmTitle()} }) {
				live := <-sum
				out[i].Online, out[i].Film = live.Online, live.Film
			}
		}
	}
	return out, nil
}

// End deletes a room for good, on its owner's say-so. Anyone inside is told and sent out.
func (m *Manager) End(ctx context.Context, code string, by protocol.User) error {
	room, err := m.Lookup(ctx, code)
	if err != nil {
		return err
	}
	if room.OwnerID != by.ID {
		return ErrNotOwner
	}
	// Delete first, so nobody can load the room again once the live one is gone.
	if err := m.rooms.DeleteRoom(ctx, room.ID); err != nil {
		return err
	}
	if r := m.get(room.Code); r != nil {
		r.do(func() { r.end(by) })
	}
	return nil
}

// Forget takes a room off userID's list without touching the room.
func (m *Manager) Forget(ctx context.Context, code string, userID int64) error {
	room, err := m.Lookup(ctx, code)
	if err != nil {
		return err
	}
	return m.rooms.ForgetVisit(ctx, room.ID, userID)
}

func (m *Manager) recordVisit(ctx context.Context, roomID, userID int64) {
	if err := m.rooms.RecordVisit(ctx, roomID, userID, time.Now()); err != nil {
		m.log.Warn("record room visit", "room", roomID, "user", userID, "err", err)
	}
}

// Detach marks the user away if s is still their current socket in that room.
func (m *Manager) Detach(code string, userID int64, s Sender) {
	if r := m.get(code); r != nil {
		r.do(func() { r.detach(userID, s) })
	}
}

func (m *Manager) Leave(code string, userID int64) {
	if r := m.get(code); r != nil {
		r.do(func() { r.leave(userID) })
	}
}

func (m *Manager) Chat(code string, userID int64, s Sender, msg protocol.ChatSend) {
	r := m.get(code)
	if r == nil || !r.do(func() { r.sendChat(userID, s, msg) }) {
		s.Send(protocol.EncodeError(protocol.ErrNotInRoom, "Join the room first."))
	}
}

// Playback applies a playback message (play, pause, seek, set_media, buffer_report,
// skip_wait, lock_controls) from userID in the room with code. The payload is already
// decoded into the matching protocol type.
func (m *Manager) Playback(code string, userID int64, s Sender, msg any) {
	r := m.get(code)
	ok := r != nil && r.do(func() {
		switch p := msg.(type) {
		case protocol.Play:
			r.play(userID, s, p)
		case protocol.Seek:
			r.seek(userID, s, p)
		case protocol.Pause:
			r.pause(userID, s, p)
		case protocol.SetMedia:
			r.setMedia(userID, s, p)
		case protocol.BufferReport:
			r.bufferReport(userID, p)
		case protocol.SkipWait:
			r.skipWait(userID, s, p)
		case protocol.LockControls:
			r.lockControls(userID, s, p)
		case protocol.HostTransfer:
			r.hostTransfer(userID, s, p)
		case stillHere:
			r.stillHere(userID)
		}
	})
	if !ok {
		s.Send(protocol.EncodeError(protocol.ErrNotInRoom, "Join the room first."))
	}
}

// StillHere is the payload-less answer to still_there, as a Playback message.
type stillHere struct{}

var StillHere any = stillHere{}

// Online returns how many members are connected to a live room (0 if not live).
func (m *Manager) Online(code string) int {
	r := m.get(code)
	if r == nil {
		return 0
	}
	n := make(chan int, 1)
	if !r.do(func() { n <- r.onlineCount() }) {
		return 0
	}
	return <-n
}

// InRoom reports whether a user is currently a member of the live room (online or away).
func (m *Manager) InRoom(code string, userID int64) bool {
	r := m.get(code)
	if r == nil {
		return false
	}
	in := make(chan bool, 1)
	if !r.do(func() { _, ok := r.members[userID]; in <- ok }) {
		return false
	}
	return <-in
}

func (m *Manager) get(code string) *Room {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.live[code]
}

func (m *Manager) getOrLoad(ctx context.Context, code string) (*Room, error) {
	if r := m.get(code); r != nil {
		return r, nil
	}
	// Load outside the lock so one slow query doesn't stall every room.
	info, err := m.rooms.RoomByCode(ctx, code)
	if errors.Is(err, store.ErrNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	history, err := m.chat.RecentChatMessages(ctx, info.ID, chatHistory)
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if r := m.live[code]; r != nil {
		return r, nil // someone else loaded it meanwhile
	}
	r := newRoom(m, info, history)
	m.live[code] = r
	go r.run()
	return r, nil
}

func (m *Manager) remove(r *Room) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.live[r.info.Code] == r {
		delete(m.live, r.info.Code)
	}
}

// NormalizeCode uppercases a user-typed code and drops spaces and dashes.
func NormalizeCode(code string) (string, bool) {
	code = strings.ToUpper(strings.NewReplacer(" ", "", "-", "").Replace(code))
	if len(code) != codeLen {
		return "", false
	}
	for _, c := range code {
		if !strings.ContainsRune(codeAlphabet, c) {
			return "", false
		}
	}
	return code, true
}

func newCode() (string, error) {
	b := make([]byte, codeLen)
	max := big.NewInt(int64(len(codeAlphabet)))
	for i := range b {
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", err
		}
		b[i] = codeAlphabet[n.Int64()]
	}
	return string(b), nil
}

// MediaInUse reports the films live rooms are showing, so the cache never evicts them.
func (m *Manager) MediaInUse() map[int64]bool {
	m.mu.Lock()
	live := make([]*Room, 0, len(m.live))
	for _, r := range m.live {
		live = append(live, r)
	}
	m.mu.Unlock()
	out := map[int64]bool{}
	for _, r := range live {
		ch := make(chan int64, 1)
		if r.do(func() {
			if r.pb.media != nil {
				ch <- r.pb.media.ID
			} else {
				ch <- 0
			}
		}) {
			if id := <-ch; id != 0 {
				out[id] = true
			}
		}
	}
	return out
}
