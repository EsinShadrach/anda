package og

import (
	"bytes"
	"context"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRender(t *testing.T) {
	for _, c := range []Card{
		{},
		{Code: "BCDFGH", Host: "rafe"},
		{Code: "BCDFGH", Host: "chimamanda", Film: strings.Repeat("A very long film title ", 12), Year: "2009"},
	} {
		b, err := Render(c)
		if err != nil {
			t.Fatal(err)
		}
		cfg, err := jpeg.DecodeConfig(bytes.NewReader(b))
		if err != nil || cfg.Width != Width || cfg.Height != Height {
			t.Errorf("%+v: %v %dx%d", c, err, cfg.Width, cfg.Height)
		}
	}
}

func TestWrap(t *testing.T) {
	f := face(sansSemi, 60)
	lines := wrap(f, "Movie night,\nwherever everyone is.", 2000, 0, 3)
	if len(lines) != 2 || lines[0] != "Movie night," {
		t.Errorf("explicit break: %q", lines)
	}
	long := strings.Repeat("word ", 60)
	lines = wrap(f, long, 600, 0, 3)
	if len(lines) != 3 || !strings.HasSuffix(lines[2], "…") || !truncated(lines, long) {
		t.Errorf("long: %q", lines)
	}
	for _, l := range lines {
		if measure(f, l, 0) > 600 {
			t.Errorf("too wide: %q", l)
		}
	}
}

func TestHead(t *testing.T) {
	allowed := true
	s := &Service{
		Invite: func(_ context.Context, code string) (Invite, bool) {
			if code != "bcdfgh" {
				return Invite{}, false
			}
			return Invite{Code: "BCDFGH", Host: "rafe", Film: `Cloudy <with> a "Chance"`, Year: "2009", Online: 2}, true
		},
		Allow: func(*http.Request) bool { return allowed },
	}
	req := func(target string) *http.Request {
		r := httptest.NewRequest("GET", target, nil)
		r.Host = "anda.example"
		r.Header.Set("X-Forwarded-Proto", "https")
		return r
	}
	head := s.Head(req("/room?code=bcdfgh"), "room")
	for _, want := range []string{
		`<meta property="og:title" content="Join the screening: Cloudy &lt;with&gt; a &#34;Chance&#34;"/>`,
		`<meta property="og:description" content="rafe is hosting · 2 watching now · watch together on Anda"/>`,
		`<meta property="og:url" content="https://anda.example/room?code=BCDFGH"/>`,
		`<meta property="og:image" content="https://anda.example/api/invites/BCDFGH/card.jpg?v=`,
		`<meta name="twitter:card" content="summary_large_image"/>`,
	} {
		if !strings.Contains(head, want) {
			t.Errorf("room head lacks %s\n%s", want, head)
		}
	}
	// Unknown rooms, other pages and lookups over the limit get Anda's own card.
	allowed = false
	for _, h := range []string{s.Head(req("/room?code=bcdfgh"), "room"), s.Head(req("/room?code=zzzzzz"), "room"), s.Head(req("/me"), "me")} {
		if !strings.Contains(h, `content="https://anda.example/api/card.jpg"`) || strings.Contains(h, "Cloudy") {
			t.Errorf("generic head: %s", h)
		}
	}
}

func TestPublicAddr(t *testing.T) {
	s := &Service{}
	for _, u := range []string{"http://127.0.0.1/p.jpg", "http://10.0.0.5/p.jpg", "http://[::1]/p.jpg", "file:///etc/passwd"} {
		if _, err := s.fetchPoster(context.Background(), u); err == nil {
			t.Errorf("%s: fetched", u)
		}
	}
}
