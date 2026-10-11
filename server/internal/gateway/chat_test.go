package gateway

import (
	"path/filepath"
	"strings"
	"testing"

	"anda/internal/protocol"
)

func TestChatReplies(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "anda.db")
	e := newEnvAt(t, dbPath)
	rafe, chimamanda := e.signup("rafe"), e.signup("chimamanda")
	code := e.createRoom(rafe)
	a, b := e.dial(rafe), e.dial(chimamanda)
	for _, c := range []*client{a, b} {
		c.hello("")
		c.send(protocol.TypeJoinRoom, protocol.JoinRoom{Code: code})
		c.expect(protocol.TypeRoomState, nil)
	}

	long := strings.Repeat("é", protocol.QuoteRunes+40)
	a.send(protocol.TypeChatSend, protocol.ChatSend{Text: long})
	var orig protocol.ChatMessage
	b.expect(protocol.TypeChatMessage, &orig)
	a.expect(protocol.TypeChatMessage, nil) // rafe's own echo

	b.send(protocol.TypeChatSend, protocol.ChatSend{Text: "@rafe same", ReplyTo: orig.ID})
	var m protocol.ChatMessage
	a.expect(protocol.TypeChatMessage, &m)
	q := m.ReplyTo
	if q == nil || q.ID != orig.ID || q.Sender.Username != "rafe" || q.Text != strings.Repeat("é", protocol.QuoteRunes) {
		t.Fatalf("reply: %+v quote=%+v", m, q)
	}

	// A message that isn't in this room can't be answered.
	b.send(protocol.TypeChatSend, protocol.ChatSend{Text: "hm", ReplyTo: orig.ID + 100})
	var perr protocol.Error
	b.expect(protocol.TypeError, &perr)
	if perr.Code != protocol.ErrBadMessage {
		t.Fatalf("reply to a missing message: %+v", perr)
	}

	// After a restart the history still carries the quote.
	e2 := newEnvAt(t, dbPath)
	c := e2.dial(rafe)
	c.hello("")
	c.send(protocol.TypeJoinRoom, protocol.JoinRoom{Code: code})
	var st protocol.RoomState
	c.expect(protocol.TypeRoomState, &st)
	if len(st.Chat) != 2 || st.Chat[0].ReplyTo != nil || st.Chat[1].ReplyTo == nil || st.Chat[1].ReplyTo.ID != orig.ID ||
		st.Chat[1].ReplyTo.Sender.Username != "rafe" || len([]rune(st.Chat[1].ReplyTo.Text)) != protocol.QuoteRunes {
		t.Fatalf("history after restart: %+v", st.Chat)
	}
}
