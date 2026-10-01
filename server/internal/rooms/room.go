package rooms

import (
	"cmp"
	"context"
	"slices"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"anda/internal/protocol"
	"anda/internal/store"
)

// Sender delivers encoded messages to one connection. Send must not block; it returns
// false if the connection is gone or too slow (the connection then closes itself).
type Sender interface {
	Send(msg []byte) bool
}

const (
	chatHistory  = 50
	maxChatRunes = 1000

	// Chat rate limit: a burst of chatBurst, refilling one message per chatRefill.
	chatBurst  = 5
	chatRefill = time.Second
	// Reactions: a burst of reactBurst (a flurry of laughs is fine), then one per reactRefill.
	reactBurst  = 8
	reactRefill = 400 * time.Millisecond
	// Typing repeats are relayed at most this often; anything faster is dropped.
	typingEvery = 2 * time.Second
)

type member struct {
	user     protocol.User
	sender   Sender // nil while away
	status   string
	joinedAt int64 // join order, for host promotion
	epoch    int   // bumped on every attach/detach, so stale grace timers do nothing

	chatTokens float64
	chatAt     time.Time

	reactTokens float64
	reactAt     time.Time

	typing   bool      // last relayed: their composer has text in it
	typingAt time.Time // when "typing" was last relayed

	seekTokens   float64
	seekAt       time.Time
	reportTokens float64
	reportAt     time.Time
	stallSince   time.Time // zero unless currently stalling
	skipUntil    time.Time // host said "don't wait" for them

	connection string    // good | fair | poor; "" until their first buffer report
	lastStall  time.Time // most recent report of stalling

	lastAction time.Time // last thing they did themselves (not automatic reports)
	askedAt    time.Time // when "Still watching?" was sent; zero if not waiting on an answer
}

// Room is one live room. All state is owned by its goroutine; everything else talks to it
// through do, so events apply one at a time and never race.
type Room struct {
	m     *Manager
	info  store.Room
	inbox chan func()
	done  chan struct{}

	members  map[int64]*member
	joinSeq  int64
	host     int64
	chat     []protocol.ChatMessage
	lastSave time.Time
	// What was last written as where the room left off, and when (see savePlayback).
	savedMedia int64
	savedPos   float64
	savedAt    time.Time
	pb         playback
	ended      bool // the owner ended it; the goroutine exits after this event
}

func newRoom(m *Manager, info store.Room, history []store.ChatMessage) *Room {
	r := &Room{
		m:       m,
		info:    info,
		inbox:   make(chan func()), // unbuffered: an accepted event is always processed
		done:    make(chan struct{}),
		members: make(map[int64]*member),
		pb:      newPlayback(),
	}
	for _, c := range history {
		r.chat = append(r.chat, toProtoChat(c, ""))
	}
	return r
}

// do runs f on the room goroutine. It returns false if the room has shut down.
func (r *Room) do(f func()) bool {
	select {
	case r.inbox <- f:
		return true
	case <-r.done:
		return false
	}
}

func (r *Room) run() {
	idle := time.NewTimer(r.m.idleTimeout)
	defer idle.Stop()
	tick := time.NewTicker(r.m.TickEvery)
	defer tick.Stop()
	for {
		select {
		case f := <-r.inbox:
			f()
			if r.ended {
				r.shutdown()
				return
			}
			if len(r.members) == 0 {
				idle.Reset(r.m.idleTimeout)
			} else {
				idle.Stop()
			}
		case now := <-tick.C:
			r.tick(now)
		case <-idle.C:
			if len(r.members) == 0 {
				r.shutdown()
				return
			}
		}
	}
}

// shutdown removes the room and lets go of its film (a download nobody else is watching
// can stop: plan, "Empty room: clean up ... including any running transcode or torrent").
func (r *Room) shutdown() {
	r.savePlayback(time.Now(), true)
	r.m.remove(r)
	close(r.done)
	if r.pb.media != nil {
		id := r.pb.media.ID
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			r.m.media.Release(ctx, id)
		}()
	}
}

// join adds u, or re-attaches them if they're already a member (reconnect, new tab).
func (r *Room) join(u protocol.User, s Sender) {
	mem, ok := r.members[u.ID]
	if ok {
		mem.sender = s
		mem.epoch++
		mem.lastAction, mem.askedAt = time.Now(), time.Time{} // coming back counts as being here
		if mem.status != protocol.StatusOnline {
			mem.status = protocol.StatusOnline
			r.broadcastExcept(s, protocol.TypeMemberUpdate, protocol.MemberUpdate{UserID: u.ID, Username: u.Username, Status: mem.status})
		}
	} else {
		r.joinSeq++
		now := time.Now()
		mem = &member{user: u, sender: s, status: protocol.StatusOnline, joinedAt: r.joinSeq,
			chatTokens: chatBurst, chatAt: now, seekTokens: seekBurst, seekAt: now,
			reactTokens: reactBurst, reactAt: now,
			reportTokens: reportBurst, reportAt: now, lastAction: now}
		r.members[u.ID] = mem
		if r.host == 0 {
			r.host = u.ID
		}
		r.broadcastExcept(s, protocol.TypeMemberUpdate, protocol.MemberUpdate{UserID: u.ID, Username: u.Username, Status: mem.status})
		r.touch()
	}
	s.Send(protocol.Encode(protocol.TypeRoomState, r.snapshot()))
}

// detach marks a member away when their socket drops. If they don't come back within
// the grace period they're removed.
func (r *Room) detach(userID int64, s Sender) {
	mem, ok := r.members[userID]
	if !ok || mem.sender != s {
		return // already re-attached through a newer socket
	}
	mem.sender = nil
	mem.status = protocol.StatusAway
	mem.typing = false // clients drop "typing" for anyone who goes away
	mem.epoch++
	epoch := mem.epoch
	r.broadcast(protocol.TypeMemberUpdate, protocol.MemberUpdate{UserID: userID, Username: mem.user.Username, Status: mem.status})
	r.dropBlocker(userID) // the room doesn't wait for people who aren't there
	r.pauseIfAllAway()
	time.AfterFunc(r.m.awayGrace, func() {
		r.do(func() {
			if mem, ok := r.members[userID]; ok && mem.epoch == epoch {
				r.leave(userID)
			}
		})
	})
}

func (r *Room) leave(userID int64) {
	mem, ok := r.members[userID]
	if !ok {
		return
	}
	r.dropBlocker(userID)
	delete(r.members, userID)
	r.broadcast(protocol.TypeMemberUpdate, protocol.MemberUpdate{UserID: userID, Username: mem.user.Username, Status: protocol.StatusLeft})
	if r.host == userID {
		// The host had the away grace to come back; now hand over to whoever has been here
		// longest, preferring someone who's actually online.
		r.host = 0
		var first *member
		for _, m := range r.members {
			better := first == nil ||
				(m.status == protocol.StatusOnline && first.status != protocol.StatusOnline) ||
				(m.status == first.status && m.joinedAt < first.joinedAt)
			if better {
				first = m
			}
		}
		if first != nil {
			r.host = first.user.ID
			r.broadcast(protocol.TypeHostChanged, protocol.HostChanged{Host: r.host})
		}
	}
	r.pauseIfAllAway()
}

// end tells everyone the room is over and empties it. The room is already deleted.
func (r *Room) end(by protocol.User) {
	r.broadcast(protocol.TypeRoomEnded, protocol.RoomEnded{By: by})
	clear(r.members)
	r.ended = true
}

func (r *Room) sendChat(userID int64, s Sender, in protocol.ChatSend) {
	mem, ok := r.members[userID]
	if !ok {
		s.Send(protocol.EncodeError(protocol.ErrNotInRoom, "Join the room first."))
		return
	}
	text := strings.TrimSpace(in.Text)
	if text == "" || utf8.RuneCountInString(text) > maxChatRunes {
		s.Send(protocol.EncodeError(protocol.ErrBadMessage, "Messages are 1 to 1000 characters."))
		return
	}
	now := time.Now()
	mem.chatTokens = min(chatBurst, mem.chatTokens+now.Sub(mem.chatAt).Seconds()/chatRefill.Seconds())
	mem.chatAt = now
	if mem.chatTokens < 1 {
		s.Send(protocol.EncodeError(protocol.ErrRateLimited, "Slow down a little."))
		return
	}
	mem.chatTokens--
	mem.typing = false // the message itself tells everyone they've stopped
	r.active(mem)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	saved, err := r.m.chat.AddChatMessage(ctx, store.ChatMessage{
		RoomID: r.info.ID, UserID: userID, Username: mem.user.Username, Text: text, CreatedAt: now,
	})
	if err != nil {
		r.m.log.Error("save chat message", "room", r.info.Code, "err", err)
		s.Send(protocol.EncodeError(protocol.ErrInternal, "Couldn't send that message."))
		return
	}
	msg := toProtoChat(saved, in.ClientMsgID)
	r.chat = append(r.chat, msg)
	if len(r.chat) > chatHistory {
		r.chat = r.chat[len(r.chat)-chatHistory:]
	}
	r.broadcast(protocol.TypeChatMessage, msg)
	r.touch()
}

func (r *Room) snapshot() protocol.RoomState {
	ordered := make([]*member, 0, len(r.members))
	for _, m := range r.members {
		ordered = append(ordered, m)
	}
	slices.SortFunc(ordered, func(a, b *member) int { return cmp.Compare(a.joinedAt, b.joinedAt) })
	members := make([]protocol.Member, len(ordered))
	for i, m := range ordered {
		members[i] = protocol.Member{UserID: m.user.ID, Username: m.user.Username, Status: m.status, Connection: m.connection}
	}
	chat := make([]protocol.ChatMessage, len(r.chat))
	for i, c := range r.chat {
		c.ClientMsgID = "" // only meaningful on the live echo
		chat[i] = c
	}
	return protocol.RoomState{
		Code: r.info.Code, Host: r.host, Members: members,
		Media: r.pb.media, Playback: r.pb.state(time.Now()), Blockers: r.blockerList(),
		Locked: r.pb.locked, Seq: r.pb.seq, Chat: chat, LastAction: resumed(r.pb.lastAction),
	}
}

// visit is what a profile shows of a live room: who's in it and what's on.
func (r *Room) visit() Visit {
	var v Visit
	online := make([]*member, 0, len(r.members))
	for _, m := range r.members {
		if m.status == protocol.StatusOnline {
			online = append(online, m)
		}
	}
	sort.Slice(online, func(i, j int) bool { return online[i].joinedAt < online[j].joinedAt })
	v.Online = len(online)
	for _, m := range online[:min(len(online), visitNames)] {
		v.Here = append(v.Here, m.user.Username)
	}
	if r.pb.media != nil {
		v.Film, v.Poster = r.pb.media.Title, r.pb.media.Poster
	}
	return v
}

func (r *Room) onlineCount() int {
	n := 0
	for _, m := range r.members {
		if m.status == protocol.StatusOnline {
			n++
		}
	}
	return n
}

func (r *Room) broadcast(typ string, payload any) { r.broadcastExcept(nil, typ, payload) }

// broadcastExcept encodes once and fans the same bytes out to every attached member.
func (r *Room) broadcastExcept(skip Sender, typ string, payload any) {
	b := protocol.Encode(typ, payload)
	for _, m := range r.members {
		if m.sender != nil && m.sender != skip {
			m.sender.Send(b)
		}
	}
}

// touch records activity, at most once a minute.
func (r *Room) touch() {
	now := time.Now()
	if now.Sub(r.lastSave) < time.Minute {
		return
	}
	r.lastSave = now
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := r.m.rooms.TouchRoom(ctx, r.info.ID, now); err != nil {
		r.m.log.Warn("touch room", "room", r.info.Code, "err", err)
	}
}

func toProtoChat(c store.ChatMessage, clientMsgID string) protocol.ChatMessage {
	return protocol.ChatMessage{
		ID:          c.ID,
		Sender:      protocol.User{ID: c.UserID, Username: c.Username},
		Text:        c.Text,
		Time:        protocol.UnixMs(c.CreatedAt),
		ClientMsgID: clientMsgID,
	}
}

func resumed(action string) string {
	if action == "resume" {
		return action
	}
	return ""
}
