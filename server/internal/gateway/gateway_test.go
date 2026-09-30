package gateway

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"anda/internal/auth"
	"anda/internal/protocol"
	"anda/internal/rooms"
	"anda/internal/store"
)

type env struct {
	srv *httptest.Server
	t   *testing.T
}

func newEnv(t *testing.T) *env {
	t.Helper()
	db, err := store.OpenSQLite(context.Background(), filepath.Join(t.TempDir(), "anda.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	a := auth.New(db, db, auth.Config{}, log)
	rm := rooms.NewManager(db, db, fakeMedia{}, log)
	mux := http.NewServeMux()
	a.Register(mux)
	(&rooms.Handlers{Manager: rm, Users: db, Authenticate: a.UserFromRequest, Log: log}).Register(mux)
	New(a.UserFromRequest, rm, nil, log).Register(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return &env{srv: srv, t: t}
}

// signup returns the session cookie for a new account.
func (e *env) signup(name string) string {
	e.t.Helper()
	res, err := http.Post(e.srv.URL+"/api/auth/signup", "application/json",
		strings.NewReader(`{"username":"`+name+`","password":"password123"}`))
	if err != nil {
		e.t.Fatal(err)
	}
	res.Body.Close()
	for _, c := range res.Cookies() {
		if c.Name == auth.CookieName {
			return c.Name + "=" + c.Value
		}
	}
	e.t.Fatalf("signup %s: no cookie (status %d)", name, res.StatusCode)
	return ""
}

func (e *env) createRoom(cookie string) string {
	e.t.Helper()
	req, _ := http.NewRequest("POST", e.srv.URL+"/api/rooms", nil)
	req.Header.Set("Cookie", cookie)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	var out struct {
		Room struct{ Code string } `json:"room"`
	}
	json.NewDecoder(res.Body).Decode(&out)
	return out.Room.Code
}

type client struct {
	t  *testing.T
	ws *websocket.Conn
}

func (e *env) dial(cookie string) *client {
	e.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(e.srv.URL, "http")+"/ws",
		&websocket.DialOptions{HTTPHeader: http.Header{"Cookie": {cookie}}})
	if err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() { ws.CloseNow() })
	return &client{t: e.t, ws: ws}
}

func (c *client) send(typ string, payload any) {
	c.t.Helper()
	b, _ := json.Marshal(payload)
	msg, _ := json.Marshal(protocol.Envelope{Type: typ, V: protocol.Version, Payload: b})
	if err := c.ws.Write(context.Background(), websocket.MessageText, msg); err != nil {
		c.t.Fatal(err)
	}
}

// expect reads until a message of type typ arrives and decodes its payload into v.
func (c *client) expect(typ string, v any) {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		_, data, err := c.ws.Read(ctx)
		if err != nil {
			c.t.Fatalf("waiting for %s: %v", typ, err)
		}
		var env protocol.Envelope
		json.Unmarshal(data, &env)
		if env.Type == typ {
			if v != nil {
				json.Unmarshal(env.Payload, v)
			}
			return
		}
	}
}

func (c *client) hello(token string) protocol.Welcome {
	c.t.Helper()
	c.send(protocol.TypeHello, protocol.Hello{ResumeToken: token})
	var w protocol.Welcome
	c.expect(protocol.TypeWelcome, &w)
	return w
}

func TestRoomCodeHasNoVowels(t *testing.T) {
	e := newEnv(t)
	cookie := e.signup("rafe")
	for range 20 {
		code := e.createRoom(cookie)
		if len(code) != 6 || strings.ContainsAny(code, "AEIOUY01L") {
			t.Fatalf("bad code %q", code)
		}
	}
}

func TestJoinChatPresence(t *testing.T) {
	e := newEnv(t)
	rafe, chioma := e.signup("rafe"), e.signup("chioma")
	code := e.createRoom(rafe)

	a := e.dial(rafe)
	a.hello("")
	a.send(protocol.TypeJoinRoom, protocol.JoinRoom{Code: strings.ToLower(code)}) // codes are case-insensitive
	var st protocol.RoomState
	a.expect(protocol.TypeRoomState, &st)
	if len(st.Members) != 1 || st.Host == 0 {
		t.Fatalf("first join: %+v", st)
	}

	b := e.dial(chioma)
	b.hello("")
	b.send(protocol.TypeJoinRoom, protocol.JoinRoom{Code: code})
	b.expect(protocol.TypeRoomState, &st)
	if len(st.Members) != 2 {
		t.Fatalf("second join members: %+v", st.Members)
	}
	var mu protocol.MemberUpdate
	a.expect(protocol.TypeMemberUpdate, &mu)
	if mu.Username != "chioma" || mu.Status != protocol.StatusOnline {
		t.Fatalf("presence: %+v", mu)
	}

	b.send(protocol.TypeChatSend, protocol.ChatSend{Text: "  hello  ", ClientMsgID: "c1"})
	var m protocol.ChatMessage
	a.expect(protocol.TypeChatMessage, &m)
	if m.Text != "hello" || m.Sender.Username != "chioma" {
		t.Fatalf("chat: %+v", m)
	}
	b.expect(protocol.TypeChatMessage, &m) // sender gets the echo with its client ID
	if m.ClientMsgID != "c1" {
		t.Fatalf("echo: %+v", m)
	}

	// Chioma drops: Rafe sees her go away.
	b.ws.CloseNow()
	a.expect(protocol.TypeMemberUpdate, &mu)
	if mu.Status != protocol.StatusAway {
		t.Fatalf("after drop: %+v", mu)
	}
}

func TestResumeAndReplace(t *testing.T) {
	e := newEnv(t)
	rafe := e.signup("rafe")
	code := e.createRoom(rafe)

	a := e.dial(rafe)
	w := a.hello("")
	a.send(protocol.TypeJoinRoom, protocol.JoinRoom{Code: code})
	a.expect(protocol.TypeRoomState, nil)
	a.send(protocol.TypeChatSend, protocol.ChatSend{Text: "before the drop"})
	a.expect(protocol.TypeChatMessage, nil)

	// Reconnect with the resume token: room_state arrives without asking to join.
	a.ws.CloseNow()
	a2 := e.dial(rafe)
	w2 := a2.hello(w.ResumeToken)
	if !w2.Resumed {
		t.Fatal("expected resumed")
	}
	var st protocol.RoomState
	a2.expect(protocol.TypeRoomState, &st)
	if st.Code != code || len(st.Chat) != 1 || st.Members[0].Status != protocol.StatusOnline {
		t.Fatalf("resumed state: %+v", st)
	}

	// A second tab (no token) replaces the first.
	tab2 := e.dial(rafe)
	if tab2.hello("").Resumed {
		t.Fatal("new tab should not resume")
	}
	a2.expect(protocol.TypeReplaced, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _, err := a2.ws.Read(ctx)
	if websocket.CloseStatus(err) != closeReplaced {
		t.Fatalf("replaced socket close: %v", err)
	}
	// The old token is dead too.
	if e.dial(rafe).hello(w2.ResumeToken).Resumed {
		t.Fatal("stale token resumed")
	}
}

// A session that left its room (e.g. tried a bad code) resumes with no room, so the client
// knows to join rather than wait for a room_state that isn't coming.
func TestResumeOutsideRoom(t *testing.T) {
	e := newEnv(t)
	rafe := e.signup("rafe")
	code := e.createRoom(rafe)

	a := e.dial(rafe)
	w := a.hello("")
	a.send(protocol.TypeJoinRoom, protocol.JoinRoom{Code: code})
	a.expect(protocol.TypeRoomState, nil)
	a.send(protocol.TypeJoinRoom, protocol.JoinRoom{Code: "ZZZZZZ"})
	a.expect(protocol.TypeError, nil)
	a.ws.CloseNow()

	a2 := e.dial(rafe)
	w2 := a2.hello(w.ResumeToken)
	if !w2.Resumed || w2.Room != "" {
		t.Fatalf("resume outside a room: %+v", w2)
	}
	a2.send(protocol.TypeJoinRoom, protocol.JoinRoom{Code: code})
	a2.expect(protocol.TypeRoomState, nil)

	a2.ws.CloseNow()
	a3 := e.dial(rafe)
	if w3 := a3.hello(w2.ResumeToken); w3.Room != code {
		t.Fatalf("resume inside a room: %+v", w3)
	}
	a3.expect(protocol.TypeRoomState, nil)
}

func TestBadVersionAndUnauthenticated(t *testing.T) {
	e := newEnv(t)
	res, err := http.Get(e.srv.URL + "/ws")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no cookie: %d", res.StatusCode)
	}

	c := e.dial(e.signup("tobi"))
	msg, _ := json.Marshal(protocol.Envelope{Type: protocol.TypeHello, V: 0})
	c.ws.Write(context.Background(), websocket.MessageText, msg)
	var pe protocol.Error
	c.expect(protocol.TypeError, &pe)
	if pe.Code != protocol.ErrVersion {
		t.Fatalf("version error: %+v", pe)
	}
}
