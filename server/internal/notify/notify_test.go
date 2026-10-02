package notify

import (
	"bufio"
	"context"
	"io"
	"log/slog"
	"mime/quotedprintable"
	"net"
	"strings"
	"testing"
	"time"

	"anda/internal/rooms"
)

func TestFormatStart(t *testing.T) {
	subject, body := Format(rooms.PartyEvent{Room: "HKP73K", Started: true,
		People: []string{"rafe", "chimamanda"}, Films: []string{"Sintel"}, Position: 75})
	if subject != "rafe and chimamanda are watching Sintel" {
		t.Errorf("subject = %q", subject)
	}
	if body != "rafe and chimamanda are watching Sintel in room HKP73K, 1:15 in.\n" {
		t.Errorf("body = %q", body)
	}

	subject, body = Format(rooms.PartyEvent{Room: "HKP73K", Started: true, People: []string{"rafe", "chimamanda", "tobi"}})
	if subject != "rafe, chimamanda and tobi are together in room HKP73K" || !strings.Contains(body, "Nothing is on screen yet") {
		t.Errorf("no film: %q / %q", subject, body)
	}
}

func TestFormatEnd(t *testing.T) {
	subject, body := Format(rooms.PartyEvent{Room: "HKP73K",
		People: []string{"rafe", "chimamanda", "tobi"}, Films: []string{"Sintel", "Tears of Steel"},
		Stayed: []string{"chimamanda"}, Position: 4350, Duration: 6840, Length: 102 * time.Minute})
	if subject != "rafe, chimamanda and tobi watched Sintel and Tears of Steel for 1h 42m" {
		t.Errorf("subject = %q", subject)
	}
	for _, want := range []string{
		"The watch party in room HKP73K is over.",
		"Who came: rafe, chimamanda, tobi",
		"Watched: Sintel, Tears of Steel",
		"Got to: 1:12:30 of 1:54:00",
		"Together for: 1h 42m",
		"chimamanda is still in the room.",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("body is missing %q:\n%s", want, body)
		}
	}
}

func TestFormatEndFinished(t *testing.T) {
	_, body := Format(rooms.PartyEvent{Room: "HKP73K", People: []string{"rafe", "tobi"},
		Films: []string{"Sintel"}, Position: 6800, Duration: 6840, Length: 2 * time.Hour})
	if !strings.Contains(body, "Got to: the end\n") {
		t.Errorf("body = %q", body)
	}
	_, body = Format(rooms.PartyEvent{Room: "HKP73K", People: []string{"rafe", "tobi"},
		Films: []string{"Sintel (trailer)"}, Position: 30, Duration: 52, Length: time.Minute})
	if !strings.Contains(body, "Got to: 0:30 of 0:52\n") {
		t.Errorf("short film: %q", body)
	}
}

func TestNames(t *testing.T) {
	for _, c := range []struct {
		in   []string
		want string
	}{
		{[]string{"a"}, "a"},
		{[]string{"a", "b"}, "a and b"},
		{[]string{"a", "b", "c", "d"}, "a, b, c and d"},
		{[]string{"a", "b", "c", "d", "e", "f"}, "a, b, c and 3 others"},
	} {
		if got := names(c.in); got != c.want {
			t.Errorf("names(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestHourlyLimit(t *testing.T) {
	m := New("x:587", "", "", "", slog.New(slog.DiscardHandler))
	t0 := time.Unix(1000, 0)
	for i := range perHour {
		if !m.allow(t0.Add(time.Duration(i) * time.Second)) {
			t.Fatalf("refused message %d", i)
		}
	}
	if m.allow(t0.Add(time.Minute)) {
		t.Fatal("allowed one over the limit")
	}
	if !m.allow(t0.Add(time.Hour + time.Minute)) {
		t.Fatal("still refusing an hour later")
	}
}

// A real send, through a minimal SMTP server on localhost (PlainAuth allows that without TLS).
func TestSend(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	got := make(chan string, 1)
	go fakeSMTP(t, ln, got)

	m := New(ln.Addr().String(), "anda@example.com", "app-password", "rafe@example.com", slog.New(slog.DiscardHandler))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := m.send(ctx, message{"rafe and chimamanda are watching Sintel", "Line one.\nLine two.\n"}); err != nil {
		t.Fatal(err)
	}
	transcript := <-got
	for _, want := range []string{
		"AUTH PLAIN",
		"MAIL FROM:<anda@example.com>",
		"RCPT TO:<rafe@example.com>",
		"Subject: rafe and chimamanda are watching Sintel\r\n",
		"To: <rafe@example.com>",
	} {
		if !strings.Contains(transcript, want) {
			t.Errorf("transcript is missing %q:\n%s", want, transcript)
		}
	}
	_, data, _ := strings.Cut(transcript, "\r\n\r\n")
	body, _ := io.ReadAll(quotedprintable.NewReader(strings.NewReader(data)))
	if !strings.Contains(string(body), "Line one.\r\nLine two.") {
		t.Errorf("body = %q", body)
	}
}

func TestCheck(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	got := make(chan string, 1)
	go fakeSMTP(t, ln, got)
	m := New(ln.Addr().String(), "anda@example.com", "app-password", "rafe@example.com", slog.New(slog.DiscardHandler))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := m.Check(ctx); err != nil {
		t.Fatal(err)
	}
	if transcript := <-got; !strings.Contains(transcript, "AUTH PLAIN") || strings.Contains(transcript, "MAIL FROM") {
		t.Errorf("check should log in and send nothing:\n%s", transcript)
	}
}

func TestComposeEncodesNonASCIISubjects(t *testing.T) {
	m := New("x:587", "anda@example.com", "", "rafe@example.com", slog.New(slog.DiscardHandler))
	raw := string(m.compose(message{"chimamanda and tobi are watching Amélie 🎬", "x"}, time.Unix(0, 0)))
	if !strings.Contains(raw, "Subject: =?utf-8?q?") {
		t.Errorf("subject not encoded:\n%s", raw)
	}
}

func fakeSMTP(t *testing.T, ln net.Listener, got chan<- string) {
	conn, err := ln.Accept()
	if err != nil {
		return
	}
	defer conn.Close()
	r := bufio.NewReader(conn)
	reply := func(s string) { io.WriteString(conn, s+"\r\n") }
	var all strings.Builder
	reply("220 fake ESMTP")
	inData := false
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			got <- all.String()
			return
		}
		all.WriteString(line)
		if inData {
			if line == ".\r\n" {
				inData = false
				reply("250 queued")
			}
			continue
		}
		switch cmd := strings.ToUpper(strings.TrimSpace(line)); {
		case strings.HasPrefix(cmd, "EHLO"):
			reply("250-fake")
			reply("250 AUTH PLAIN")
		case strings.HasPrefix(cmd, "AUTH"):
			reply("235 ok")
		case strings.HasPrefix(cmd, "DATA"):
			inData = true
			reply("354 go ahead")
		case strings.HasPrefix(cmd, "QUIT"):
			reply("221 bye")
			got <- all.String()
			return
		default:
			reply("250 ok")
		}
	}
}
