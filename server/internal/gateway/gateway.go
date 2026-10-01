// Package gateway terminates browser WebSockets: the hello/welcome handshake, resume
// tokens, one live socket per account, liveness pings, and routing messages to rooms.
package gateway

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	mrand "math/rand/v2"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"anda/internal/protocol"
	"anda/internal/rooms"
	"anda/internal/store"
)

const (
	helloTimeout = 10 * time.Second
	pingInterval = 15 * time.Second
	pingTimeout  = 10 * time.Second
	writeTimeout = 10 * time.Second
	readLimit    = 16 << 10
	outboxSize   = 64

	// resumeWindow is how long a dropped session's resume token stays valid.
	resumeWindow = 60 * time.Second
)

// Close codes the client acts on. 4000–4999 are free for applications.
const (
	closeReplaced = websocket.StatusCode(4001) // don't auto-reconnect
	closeTooSlow  = websocket.StatusCode(4002)
	closeShutdown = websocket.StatusCode(4003) // reconnect after the delay sent in reconnect_later
)

type Gateway struct {
	authenticate func(*http.Request) (store.User, error)
	rooms        *rooms.Manager
	origins      []string
	log          *slog.Logger

	mu       sync.Mutex
	sessions map[int64]*session // by user ID; one per account
	conns    map[*conn]struct{}
	stopping bool
}

// session is an account's presence on the gateway. It outlives individual sockets for
// resumeWindow, so a reconnect can pick up where it left off.
type session struct {
	user     protocol.User
	token    string
	conn     *conn  // current socket, nil while disconnected
	roomCode string // room the account is in, "" if none
	gen      int    // bumped on every attach, so stale expiry timers do nothing
}

// New builds a gateway. origins lists extra allowed Origin hosts (e.g. "localhost:3000"
// for the Next dev server); same-origin requests are always allowed.
func New(authenticate func(*http.Request) (store.User, error), rm *rooms.Manager, origins []string, log *slog.Logger) *Gateway {
	return &Gateway{
		authenticate: authenticate,
		rooms:        rm,
		origins:      origins,
		log:          log,
		sessions:     make(map[int64]*session),
		conns:        make(map[*conn]struct{}),
	}
}

func (g *Gateway) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /ws", g.serveWS)
}

func (g *Gateway) serveWS(w http.ResponseWriter, r *http.Request) {
	u, err := g.authenticate(r)
	if err != nil {
		http.Error(w, "not signed in", http.StatusUnauthorized)
		return
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: g.origins})
	if err != nil {
		return // Accept already wrote the response
	}
	ws.SetReadLimit(readLimit)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &conn{
		ws:     ws,
		user:   protocol.User{ID: u.ID, Username: u.Username},
		out:    make(chan outMsg, outboxSize),
		closed: make(chan struct{}),
	}
	if !g.track(c) {
		ws.Close(closeShutdown, "server restarting")
		return
	}
	defer g.untrack(c)
	go c.writeLoop(ctx)
	go c.pingLoop(ctx)

	defer c.finish()
	hello, ok := c.readHello(ctx)
	if !ok {
		return
	}
	sess := g.attach(ctx, c, hello)
	g.readLoop(ctx, c, sess)
	g.detach(c, sess)
}

func (c *conn) readHello(ctx context.Context) (protocol.Hello, bool) {
	hctx, cancel := context.WithTimeout(ctx, helloTimeout)
	defer cancel()
	env, err := c.read(hctx) // also rejects other protocol versions
	if err != nil {
		return protocol.Hello{}, false
	}
	var h protocol.Hello
	if env.Type != protocol.TypeHello || (len(env.Payload) > 0 && json.Unmarshal(env.Payload, &h) != nil) {
		c.sendAndClose(protocol.EncodeError(protocol.ErrHelloFirst, "Expected hello."), websocket.StatusPolicyViolation)
		return protocol.Hello{}, false
	}
	return h, true
}

// attach makes c the account's current socket. A valid resume token picks the session
// back up (and re-enters its room); otherwise the newest socket wins and any older one
// is told it was replaced.
func (g *Gateway) attach(ctx context.Context, c *conn, h protocol.Hello) *session {
	g.mu.Lock()
	sess := g.sessions[c.user.ID]
	if sess == nil {
		sess = &session{user: c.user}
		g.sessions[c.user.ID] = sess
	}
	resumed := h.ResumeToken != "" && sess.token != "" &&
		subtle.ConstantTimeCompare([]byte(h.ResumeToken), []byte(sess.token)) == 1
	old := sess.conn
	sess.conn = c
	sess.token = newToken()
	sess.gen++
	token, code := sess.token, sess.roomCode
	g.mu.Unlock()

	if old != nil {
		if resumed {
			old.closeNow() // a half-dead socket from the same tab
		} else {
			old.sendAndClose(protocol.Encode(protocol.TypeReplaced, nil), closeReplaced)
			if code != "" {
				// Until this tab joins, the account shows as away in its old room.
				g.rooms.Detach(code, c.user.ID, old)
			}
		}
	}

	room := ""
	if resumed {
		room = code
	}
	c.Send(protocol.Encode(protocol.TypeWelcome, protocol.Welcome{
		UserID: c.user.ID, ResumeToken: token, ServerTime: protocol.UnixMs(time.Now()), Resumed: resumed, Room: room,
	}))
	if room != "" {
		_, err := g.rooms.Join(ctx, room, c.user, c)
		switch {
		case errors.Is(err, rooms.ErrNotFound): // ended while this socket was away
			g.setRoom(sess, c, "")
			c.Send(protocol.EncodeError(protocol.ErrRoomNotFound, "That room has ended."))
		case err != nil:
			g.log.Error("rejoin on resume", "room", room, "err", err)
			g.setRoom(sess, c, "")
			c.Send(protocol.EncodeError(protocol.ErrInternal, "Couldn't rejoin the room."))
		}
	}
	return sess
}

// detach runs when c's socket ends. The room marks the member away, and the session
// stays resumable for resumeWindow.
func (g *Gateway) detach(c *conn, sess *session) {
	g.mu.Lock()
	if sess.conn != c {
		g.mu.Unlock()
		return // replaced; the newer socket owns the session now
	}
	sess.conn = nil
	gen, code := sess.gen, sess.roomCode
	g.mu.Unlock()

	if code != "" {
		g.rooms.Detach(code, c.user.ID, c)
	}
	time.AfterFunc(resumeWindow, func() {
		g.mu.Lock()
		defer g.mu.Unlock()
		if s := g.sessions[c.user.ID]; s == sess && s.conn == nil && s.gen == gen {
			delete(g.sessions, c.user.ID)
		}
	})
}

func (g *Gateway) readLoop(ctx context.Context, c *conn, sess *session) {
	for {
		env, err := c.read(ctx)
		if err != nil {
			return
		}
		if !g.isCurrent(sess, c) {
			return // replaced while this message was in flight
		}
		switch env.Type {
		case protocol.TypeJoinRoom:
			var p protocol.JoinRoom
			if !decode(c, env, &p) {
				continue
			}
			if prev := g.roomOf(sess); prev != "" {
				if norm, ok := rooms.NormalizeCode(p.Code); !ok || norm != prev {
					g.rooms.Leave(prev, c.user.ID)
					g.setRoom(sess, c, "")
				}
			}
			code, err := g.rooms.Join(ctx, p.Code, c.user, c)
			if errors.Is(err, rooms.ErrNotFound) {
				c.Send(protocol.EncodeError(protocol.ErrRoomNotFound, "No room with that code."))
				continue
			}
			if err != nil {
				g.log.Error("join room", "err", err)
				c.Send(protocol.EncodeError(protocol.ErrInternal, "Couldn't join the room."))
				continue
			}
			g.setRoom(sess, c, code)

		case protocol.TypeLeaveRoom:
			if code := g.roomOf(sess); code != "" {
				g.rooms.Leave(code, c.user.ID)
				g.setRoom(sess, c, "")
			}

		case protocol.TypeChatSend:
			var p protocol.ChatSend
			if !decode(c, env, &p) {
				continue
			}
			code := g.roomOf(sess)
			if code == "" {
				c.Send(protocol.EncodeError(protocol.ErrNotInRoom, "Join the room first."))
				continue
			}
			g.rooms.Chat(code, c.user.ID, c, p)

		case protocol.TypeReactionSend:
			var p protocol.ReactionSend
			if !decode(c, env, &p) {
				continue
			}
			if code := g.roomOf(sess); code != "" {
				g.rooms.React(code, c.user.ID, c, p)
			}

		case protocol.TypeTypingSend:
			var p protocol.TypingSend
			if !decode(c, env, &p) {
				continue
			}
			if code := g.roomOf(sess); code != "" {
				g.rooms.Typing(code, c.user.ID, c, p)
			}

		case protocol.TypeTimePing:
			var p protocol.TimePing
			if decode(c, env, &p) {
				c.Send(protocol.Encode(protocol.TypeTimePong, protocol.TimePong{ClientTime: p.ClientTime, ServerTime: protocol.UnixMs(time.Now())}))
			}

		case protocol.TypePlay, protocol.TypePause, protocol.TypeSeek, protocol.TypeSetMedia,
			protocol.TypeBufferReport, protocol.TypeSkipWait, protocol.TypeLockControls,
			protocol.TypeHostTransfer, protocol.TypeStillHere:
			msg, ok := decodePlayback(c, env)
			if !ok {
				continue
			}
			code := g.roomOf(sess)
			if code == "" {
				c.Send(protocol.EncodeError(protocol.ErrNotInRoom, "Join the room first."))
				continue
			}
			g.rooms.Playback(code, c.user.ID, c, msg)

		default:
			c.Send(protocol.EncodeError(protocol.ErrBadMessage, "Unknown message type "+env.Type+"."))
		}
	}
}

// Shutdown tells every client to reconnect after a random delay, so a restart doesn't
// bring them all back in the same instant, then closes the sockets.
func (g *Gateway) Shutdown() {
	g.mu.Lock()
	g.stopping = true
	conns := make([]*conn, 0, len(g.conns))
	for c := range g.conns {
		conns = append(conns, c)
	}
	g.mu.Unlock()
	for _, c := range conns {
		delay := 2 + mrand.IntN(7) // 2–8s: one small instance, sessions resume within 60s
		c.sendAndClose(protocol.Encode(protocol.TypeReconnectLater, protocol.ReconnectLater{Delay: delay}), closeShutdown)
	}
	// Give the writers a moment to flush.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		g.mu.Lock()
		n := len(g.conns)
		g.mu.Unlock()
		if n == 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (g *Gateway) track(c *conn) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.stopping {
		return false
	}
	g.conns[c] = struct{}{}
	return true
}

func (g *Gateway) untrack(c *conn) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.conns, c)
}

func (g *Gateway) isCurrent(sess *session, c *conn) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return sess.conn == c
}

func (g *Gateway) roomOf(sess *session) string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return sess.roomCode
}

func (g *Gateway) setRoom(sess *session, c *conn, code string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if sess.conn == c {
		sess.roomCode = code
	}
}

func decode(c *conn, env protocol.Envelope, v any) bool {
	if err := json.Unmarshal(env.Payload, v); err != nil {
		c.Send(protocol.EncodeError(protocol.ErrBadMessage, "Invalid "+env.Type+" payload."))
		return false
	}
	return true
}

// decodePlayback turns a playback envelope into its typed payload.
func decodePlayback(c *conn, env protocol.Envelope) (any, bool) {
	switch env.Type {
	case protocol.TypePlay:
		return decodeAs[protocol.Play](c, env)
	case protocol.TypePause:
		return decodeAs[protocol.Pause](c, env)
	case protocol.TypeSeek:
		return decodeAs[protocol.Seek](c, env)
	case protocol.TypeSetMedia:
		return decodeAs[protocol.SetMedia](c, env)
	case protocol.TypeBufferReport:
		return decodeAs[protocol.BufferReport](c, env)
	case protocol.TypeSkipWait:
		return decodeAs[protocol.SkipWait](c, env)
	case protocol.TypeLockControls:
		return decodeAs[protocol.LockControls](c, env)
	case protocol.TypeHostTransfer:
		return decodeAs[protocol.HostTransfer](c, env)
	case protocol.TypeStillHere:
		return rooms.StillHere, true
	}
	return nil, false
}

func decodeAs[T any](c *conn, env protocol.Envelope) (any, bool) {
	var p T
	ok := decode(c, env, &p)
	return p, ok
}

func newToken() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b) // crypto/rand.Read never fails on supported platforms
	return base64.RawURLEncoding.EncodeToString(b)
}
