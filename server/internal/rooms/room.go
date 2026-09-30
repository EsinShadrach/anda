package rooms

import (
	"cmp"
	"context"
	"slices"
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
)

type member struct {
	user     protocol.User
	sender   Sender // nil while away
	status   string
	joinedAt int64 // join order, for host promotion
	epoch    int   // bumped on every attach/detach, so stale grace timers do nothing

	chatTokens float64
	chatAt     time.Time

	seekTokens   float64
	seekAt       time.Time
	reportTokens float64
	reportAt     time.Time
	stallSince   time.Time // zero unless currently stalling
	skipUntil    time.Time // host said "don't wait" for them
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
	pb       playback
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
	for {
		select {
		case f := <-r.inbox:
			f()
			if len(r.members) == 0 {
				idle.Reset(r.m.idleTimeout)
			} else {
				idle.Stop()
			}
		case <-idle.C:
			if len(r.members) == 0 {
				r.m.remove(r)
				close(r.done)
				return
			}
		}
	}
}

// join adds u, or re-attaches them if they're already a member (reconnect, new tab).
func (r *Room) join(u protocol.User, s Sender) {
	mem, ok := r.members[u.ID]
	if ok {
		mem.sender = s
		mem.epoch++
		if mem.status != protocol.StatusOnline {
			mem.status = protocol.StatusOnline
			r.broadcastExcept(s, protocol.TypeMemberUpdate, protocol.MemberUpdate{UserID: u.ID, Username: u.Username, Status: mem.status})
		}
	} else {
		r.joinSeq++
		now := time.Now()
		mem = &member{user: u, sender: s, status: protocol.StatusOnline, joinedAt: r.joinSeq,
			chatTokens: chatBurst, chatAt: now, seekTokens: seekBurst, seekAt: now,
			reportTokens: reportBurst, reportAt: now}
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
	mem.epoch++
	epoch := mem.epoch
	r.broadcast(protocol.TypeMemberUpdate, protocol.MemberUpdate{UserID: userID, Username: mem.user.Username, Status: mem.status})
	r.dropBlocker(userID) // the room doesn't wait for people who aren't there
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
		r.host = 0
		var first *member
		for _, m := range r.members {
			if first == nil || m.joinedAt < first.joinedAt {
				first = m
			}
		}
		if first != nil {
			r.host = first.user.ID
			r.broadcast(protocol.TypeHostChanged, protocol.HostChanged{Host: r.host})
		}
	}
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
		members[i] = protocol.Member{UserID: m.user.ID, Username: m.user.Username, Status: m.status}
	}
	chat := make([]protocol.ChatMessage, len(r.chat))
	for i, c := range r.chat {
		c.ClientMsgID = "" // only meaningful on the live echo
		chat[i] = c
	}
	return protocol.RoomState{
		Code: r.info.Code, Host: r.host, Members: members,
		Media: r.pb.media, Playback: r.pb.state(time.Now()), Blockers: r.blockerList(),
		Locked: r.pb.locked, Seq: r.pb.seq, Chat: chat,
	}
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
