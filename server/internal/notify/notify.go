// Package notify emails the person running Anda when a watch party starts and ends: who's
// there, and what they're watching. Mail goes out over SMTP (Gmail with an app password,
// or any provider's SMTP), from a queue, so a slow mail server never holds up a room.
package notify

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"fmt"
	"log/slog"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/smtp"
	"strings"
	"time"

	"anda/internal/rooms"
)

// perHour caps the mail sent in any hour, so a bug or a flapping room can't flood an inbox.
const perHour = 20

// Mailer sends party emails. Make one with New.
type Mailer struct {
	Addr     string // SMTP server, host:port (587 STARTTLS, or 465 TLS)
	User     string // SMTP login, usually the sending address
	Password string
	From     string // the sending address
	To       string // who's told
	Log      *slog.Logger

	queue chan message
	sent  []time.Time // send times within the last hour
}

type message struct{ subject, body string }

// New returns a Mailer that sends through addr, logging in as user, from user to to.
func New(addr, user, password, to string, log *slog.Logger) *Mailer {
	return &Mailer{Addr: addr, User: user, Password: password, From: user, To: to, Log: log,
		queue: make(chan message, 32)}
}

// Run sends queued mail until ctx is done.
func (m *Mailer) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case msg := <-m.queue:
			if !m.allow(time.Now()) {
				m.Log.Warn("notify: hourly limit reached, dropped", "subject", msg.subject)
				continue
			}
			sctx, cancel := context.WithTimeout(ctx, 30*time.Second)
			err := m.send(sctx, msg)
			cancel()
			if err != nil {
				m.Log.Error("notify: send", "subject", msg.subject, "err", err)
			} else {
				m.Log.Info("notify: sent", "subject", msg.subject)
			}
		}
	}
}

// Party queues the email for a party starting or ending. It never blocks.
func (m *Mailer) Party(ev rooms.PartyEvent) {
	subject, body := Format(ev)
	select {
	case m.queue <- message{subject, body}:
	default:
		m.Log.Warn("notify: queue full, dropped", "subject", subject)
	}
}

func (m *Mailer) allow(now time.Time) bool {
	kept := m.sent[:0]
	for _, t := range m.sent {
		if now.Sub(t) < time.Hour {
			kept = append(kept, t)
		}
	}
	m.sent = kept
	if len(m.sent) >= perHour {
		return false
	}
	m.sent = append(m.sent, now)
	return true
}

// Format writes the subject and body for a party event.
func Format(ev rooms.PartyEvent) (subject, body string) {
	who := names(ev.People)
	var b strings.Builder
	if ev.Started {
		if len(ev.Films) == 0 {
			subject = fmt.Sprintf("%s are together in room %s", who, ev.Room)
			fmt.Fprintf(&b, "%s are in room %s. Nothing is on screen yet.\n", who, ev.Room)
		} else {
			subject = fmt.Sprintf("%s are watching %s", who, ev.Films[0])
			fmt.Fprintf(&b, "%s are watching %s in room %s", who, ev.Films[0], ev.Room)
			if ev.Position >= 60 {
				fmt.Fprintf(&b, ", %s in", clock(ev.Position))
			}
			b.WriteString(".\n")
		}
		return subject, b.String()
	}

	what := "nothing in particular"
	if len(ev.Films) > 0 {
		what = names(ev.Films)
	}
	subject = fmt.Sprintf("%s watched %s for %s", who, what, span(ev.Length))
	fmt.Fprintf(&b, "The watch party in room %s is over.\n\n", ev.Room)
	fmt.Fprintf(&b, "Who came: %s\n", strings.Join(ev.People, ", "))
	if len(ev.Films) > 0 {
		fmt.Fprintf(&b, "Watched: %s\n", strings.Join(ev.Films, ", "))
		// Near the end counts as the end: credits roll, and positions are sampled every few seconds.
		switch {
		case ev.Duration > 0 && ev.Position >= ev.Duration-min(120, ev.Duration*0.05):
			b.WriteString("Got to: the end\n")
		case ev.Duration > 0:
			fmt.Fprintf(&b, "Got to: %s of %s\n", clock(ev.Position), clock(ev.Duration))
		case ev.Position > 0:
			fmt.Fprintf(&b, "Got to: %s\n", clock(ev.Position))
		}
	}
	fmt.Fprintf(&b, "Together for: %s\n", span(ev.Length))
	if len(ev.Stayed) > 0 {
		fmt.Fprintf(&b, "\n%s is still in the room.\n", names(ev.Stayed))
	}
	return subject, b.String()
}

// names joins a list the way you'd say it: "a", "a and b", "a, b and c", "a, b, c and 2 others".
func names(list []string) string {
	switch n := len(list); {
	case n == 0:
		return "nobody"
	case n == 1:
		return list[0]
	case n <= 4:
		return strings.Join(list[:n-1], ", ") + " and " + list[n-1]
	default:
		return strings.Join(list[:3], ", ") + fmt.Sprintf(" and %d others", n-3)
	}
}

// clock formats seconds as 1:02:03 or 2:03.
func clock(sec float64) string {
	s := int(sec)
	if s >= 3600 {
		return fmt.Sprintf("%d:%02d:%02d", s/3600, s/60%60, s%60)
	}
	return fmt.Sprintf("%d:%02d", s/60, s%60)
}

// span formats a duration as "1h 42m", "42 min" or "under a minute".
func span(d time.Duration) string {
	mins := int(d.Round(time.Minute) / time.Minute)
	switch {
	case mins < 1:
		return "under a minute"
	case mins < 60:
		return fmt.Sprintf("%d min", mins)
	default:
		return fmt.Sprintf("%dh %02dm", mins/60, mins%60)
	}
}

// Check logs in to the SMTP server without sending anything, so a wrong password shows up
// in the log at startup rather than when the first party ends.
func (m *Mailer) Check(ctx context.Context) error {
	c, err := m.dial(ctx)
	if err != nil {
		return err
	}
	defer c.Close()
	return c.Quit()
}

func (m *Mailer) send(ctx context.Context, msg message) error {
	c, err := m.dial(ctx)
	if err != nil {
		return err
	}
	defer c.Close()
	if err := c.Mail(m.From); err != nil {
		return err
	}
	if err := c.Rcpt(m.To); err != nil {
		return err
	}
	w, err := c.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write(m.compose(msg, time.Now())); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return c.Quit()
}

// dial connects and logs in: TLS from the start on port 465, STARTTLS otherwise.
func (m *Mailer) dial(ctx context.Context) (*smtp.Client, error) {
	host, port, err := net.SplitHostPort(m.Addr)
	if err != nil {
		return nil, err
	}
	tlsConf := &tls.Config{ServerName: host}
	d := &net.Dialer{Timeout: 15 * time.Second}
	var conn net.Conn
	if port == "465" {
		conn, err = (&tls.Dialer{NetDialer: d, Config: tlsConf}).DialContext(ctx, "tcp", m.Addr)
	} else {
		conn, err = d.DialContext(ctx, "tcp", m.Addr)
	}
	if err != nil {
		return nil, err
	}
	if dl, ok := ctx.Deadline(); ok {
		conn.SetDeadline(dl)
	}
	c, err := smtp.NewClient(conn, host)
	if err != nil {
		conn.Close()
		return nil, err
	}
	if ok, _ := c.Extension("STARTTLS"); ok {
		if err := c.StartTLS(tlsConf); err != nil {
			c.Close()
			return nil, err
		}
	}
	if m.User != "" {
		if err := c.Auth(smtp.PlainAuth("", m.User, m.Password, host)); err != nil {
			c.Close()
			return nil, err
		}
	}
	return c, nil
}

func (m *Mailer) compose(msg message, now time.Time) []byte {
	id := make([]byte, 12)
	rand.Read(id)
	domain := "anda.local"
	if at := strings.LastIndexByte(m.From, '@'); at >= 0 {
		domain = m.From[at+1:]
	}
	var b bytes.Buffer
	fmt.Fprintf(&b, "From: %s <%s>\r\n", mime.QEncoding.Encode("utf-8", "Anda"), m.From)
	fmt.Fprintf(&b, "To: <%s>\r\n", m.To)
	fmt.Fprintf(&b, "Subject: %s\r\n", mime.QEncoding.Encode("utf-8", msg.subject))
	fmt.Fprintf(&b, "Date: %s\r\n", now.Format(time.RFC1123Z))
	fmt.Fprintf(&b, "Message-ID: <%s@%s>\r\n", hex.EncodeToString(id), domain)
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
	b.WriteString("Content-Transfer-Encoding: quoted-printable\r\n\r\n")
	qp := quotedprintable.NewWriter(&b)
	qp.Write([]byte(strings.ReplaceAll(msg.body, "\n", "\r\n")))
	qp.Close()
	return b.Bytes()
}
