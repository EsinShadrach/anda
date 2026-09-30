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

var ErrNotFound = errors.New("rooms: room not found")

type Manager struct {
	rooms store.Rooms
	chat  store.Chat
	log   *slog.Logger

	// awayGrace is how long a disconnected member stays in the room before leaving.
	awayGrace time.Duration
	// idleTimeout is how long an empty room stays in memory.
	idleTimeout time.Duration

	mu   sync.Mutex
	live map[string]*Room
}

func NewManager(rooms store.Rooms, chat store.Chat, log *slog.Logger) *Manager {
	return &Manager{
		rooms:       rooms,
		chat:        chat,
		log:         log,
		awayGrace:   60 * time.Second,
		idleTimeout: 5 * time.Minute,
		live:        make(map[string]*Room),
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
			return code, nil
		}
		// The room shut down between lookup and join; load it again.
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
