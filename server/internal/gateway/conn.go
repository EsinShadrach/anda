package gateway

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"anda/internal/protocol"
)

// conn is one browser socket. Rooms write to it through Send, which never blocks: a
// client that falls outboxSize messages behind is disconnected rather than slowing
// the room down for everyone.
type conn struct {
	ws   *websocket.Conn
	user protocol.User

	out          chan outMsg
	closed       chan struct{}
	closeOnce    sync.Once
	closePending atomic.Bool // a final message is queued; let the writer flush it
}

type outMsg struct {
	data []byte
	// closeCode, when set, closes the socket after data is written.
	closeCode websocket.StatusCode
}

func (c *conn) Send(b []byte) bool {
	select {
	case <-c.closed:
		return false
	default:
	}
	select {
	case c.out <- outMsg{data: b}:
		return true
	case <-c.closed:
		return false
	default:
		c.closeWith(closeTooSlow, "too slow")
		return false
	}
}

// sendAndClose queues a final message; the writer closes the socket after sending it.
func (c *conn) sendAndClose(b []byte, code websocket.StatusCode) {
	c.closePending.Store(true)
	select {
	case c.out <- outMsg{data: b, closeCode: code}:
	case <-c.closed:
	default:
		c.closeWith(code, "")
	}
}

func (c *conn) closeWith(code websocket.StatusCode, reason string) {
	c.closeOnce.Do(func() {
		close(c.closed)
		go c.ws.Close(code, reason) // Close waits for the peer's reply; don't block the caller
	})
}

// finish ends the socket once the handler is done with it, first giving a queued final
// message (an error, replaced, reconnect_later) a moment to reach the client.
func (c *conn) finish() {
	if c.closePending.Load() {
		select {
		case <-c.closed:
		case <-time.After(time.Second):
		}
	}
	c.closeNow()
}

func (c *conn) closeNow() {
	c.closeOnce.Do(func() {
		close(c.closed)
		c.ws.CloseNow()
	})
}

func (c *conn) writeLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-c.closed:
			return
		case m := <-c.out:
			wctx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := c.ws.Write(wctx, websocket.MessageText, m.data)
			cancel()
			if err != nil {
				c.closeNow()
				return
			}
			if m.closeCode != 0 {
				c.closeWith(m.closeCode, "")
				return
			}
		}
	}
}

// pingLoop sends WebSocket ping frames; a peer that doesn't answer is dropped.
func (c *conn) pingLoop(ctx context.Context) {
	t := time.NewTicker(pingInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-c.closed:
			return
		case <-t.C:
			pctx, cancel := context.WithTimeout(ctx, pingTimeout)
			err := c.ws.Ping(pctx)
			cancel()
			if err != nil {
				c.closeNow()
				return
			}
		}
	}
}

func (c *conn) read(ctx context.Context) (protocol.Envelope, error) {
	for {
		typ, data, err := c.ws.Read(ctx)
		if err != nil {
			return protocol.Envelope{}, err
		}
		if typ != websocket.MessageText {
			continue
		}
		var env protocol.Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			c.Send(protocol.EncodeError(protocol.ErrBadMessage, "Messages must be JSON."))
			continue
		}
		if env.V != protocol.Version {
			c.sendAndClose(protocol.EncodeError(protocol.ErrVersion, "Anda was updated. Please refresh the page."), websocket.StatusPolicyViolation)
			return protocol.Envelope{}, context.Canceled
		}
		return env, nil
	}
}
