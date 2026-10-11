package og

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"html"
	"image"
	_ "image/jpeg" // posters
	_ "image/png"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "golang.org/x/image/webp"
)

// Invite is what a room's preview shows.
type Invite struct {
	Code   string
	Host   string
	Film   string // on screen, or where the room left off; "" if nothing yet
	Year   string
	Poster string // URL; "" without one
	Online int    // people in the room now
}

// Service serves the cards and writes the tags that point at them. Chat apps fetch an invite
// link signed out, so a room's preview goes through the same limit as the invite preview.
type Service struct {
	// Invite looks up a room by code; ok is false when there's no such room.
	Invite func(ctx context.Context, code string) (inv Invite, ok bool)
	// Allow says whether r may look up a room (signed in, or within the signed-out limit).
	Allow func(r *http.Request) bool
	Log   *slog.Logger

	once   sync.Once
	client *http.Client

	mu    sync.Mutex        // one render at a time: the VM has a single vCPU
	cards map[string][]byte // card version -> JPEG
}

const maxCards = 32 // ~100 KB each

const andaDescription = "Movie night, wherever everyone is. Start a room, share the code, watch in sync."

func (s *Service) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/card.jpg", s.handleAnda)
	mux.HandleFunc("GET /api/invites/{code}/card.jpg", s.handleInvite)
}

func (s *Service) handleAnda(w http.ResponseWriter, r *http.Request) {
	b, err := s.card(r.Context(), Invite{})
	if err != nil {
		s.Log.Error("render card", "err", err)
		http.Error(w, "couldn't draw the card", http.StatusInternalServerError)
		return
	}
	writeJPEG(w, r, b, "public, max-age=86400")
}

func (s *Service) handleInvite(w http.ResponseWriter, r *http.Request) {
	if !s.Allow(r) {
		http.Error(w, "too many lookups", http.StatusTooManyRequests)
		return
	}
	inv, ok := s.Invite(r.Context(), r.PathValue("code"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	b, err := s.card(r.Context(), inv)
	if err != nil {
		s.Log.Error("render card", "code", inv.Code, "err", err)
		http.Error(w, "couldn't draw the card", http.StatusInternalServerError)
		return
	}
	// The URL carries the card's version (?v=), so a changed room gets a new URL.
	writeJPEG(w, r, b, "public, max-age=3600")
}

func writeJPEG(w http.ResponseWriter, r *http.Request, b []byte, cache string) {
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", cache)
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(b))
}

// card returns inv's card, drawing it on the first request for this version.
func (s *Service) card(ctx context.Context, inv Invite) ([]byte, error) {
	v := version(inv)
	s.mu.Lock()
	b, ok := s.cards[v]
	s.mu.Unlock()
	if ok {
		return b, nil
	}

	c := Card{Code: inv.Code, Host: inv.Host, Film: inv.Film, Year: inv.Year}
	posterMissing := false
	if inv.Poster != "" {
		p, err := s.fetchPoster(ctx, inv.Poster)
		if err != nil {
			s.Log.Warn("card poster", "code", inv.Code, "err", err)
			posterMissing = true
		}
		c.Poster = p
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := Render(c)
	if err != nil {
		return nil, err
	}
	if !posterMissing { // try the poster again next time
		if s.cards == nil || len(s.cards) >= maxCards {
			s.cards = make(map[string][]byte)
		}
		s.cards[v] = b
	}
	return b, nil
}

// version changes whenever anything drawn on inv's card does (not the head count, which
// is only in the description).
func version(inv Invite) string {
	h := sha256.Sum256([]byte(strings.Join([]string{inv.Code, inv.Host, inv.Film, inv.Year, inv.Poster}, "\x00")))
	return hex.EncodeToString(h[:5])
}

var errPrivateAddr = errors.New("poster isn't on a public address")

// fetchPoster downloads and decodes a poster. Poster URLs come from catalog addons, so the
// fetch only reaches public addresses, and refuses huge files and images.
func (s *Service) fetchPoster(ctx context.Context, raw string) (image.Image, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return nil, fmt.Errorf("bad poster URL %q", raw)
	}
	s.once.Do(func() {
		d := &net.Dialer{Timeout: 5 * time.Second, Control: func(_, address string, _ syscall.RawConn) error {
			ap, err := netip.ParseAddrPort(address)
			if err != nil || !publicAddr(ap.Addr()) {
				return errPrivateAddr
			}
			return nil
		}}
		s.client = &http.Client{Timeout: 8 * time.Second, Transport: &http.Transport{
			DialContext: d.DialContext, TLSHandshakeTimeout: 5 * time.Second, MaxIdleConns: 2,
		}}
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, err
	}
	res, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("poster: %s", res.Status)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, 8<<20+1))
	if err != nil {
		return nil, err
	}
	if len(b) > 8<<20 {
		return nil, errors.New("poster over 8 MB")
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	if cfg.Width*cfg.Height > 12_000_000 {
		return nil, fmt.Errorf("poster too large (%dx%d)", cfg.Width, cfg.Height)
	}
	img, _, err := image.Decode(bytes.NewReader(b))
	return img, err
}

func publicAddr(ip netip.Addr) bool {
	ip = ip.Unmap()
	return ip.IsValid() && ip.IsGlobalUnicast() && !ip.IsPrivate() && !ip.IsLoopback() &&
		!ip.IsLinkLocalUnicast() && !cgnat.Contains(ip)
}

// 100.64.0.0/10 (carrier-grade NAT, also Tailscale) isn't covered by IsPrivate.
var cgnat = netip.MustParsePrefix("100.64.0.0/10")

// Head is the Open Graph tags for a page of the web app ("index", "room", ...): a room's
// card for /room?code=..., Anda's own everywhere else.
func (s *Service) Head(r *http.Request, page string) string {
	base := baseURL(r)
	t := struct{ title, desc, url, image, alt string }{
		title: "Anda",
		desc:  andaDescription,
		url:   base + "/",
		image: base + "/api/card.jpg",
		alt:   "Anda: movie night, wherever everyone is.",
	}
	if page != "index" {
		t.url = base + "/" + page
	}
	if code := r.URL.Query().Get("code"); page == "room" && code != "" && s.Allow(r) {
		if inv, ok := s.Invite(r.Context(), code); ok {
			t.url = base + "/room?code=" + url.QueryEscape(inv.Code)
			t.image = base + "/api/invites/" + url.PathEscape(inv.Code) + "/card.jpg?v=" + version(inv)
			var desc []string
			if inv.Film != "" {
				t.title = "Join the screening: " + inv.Film
				t.alt = fmt.Sprintf("%s, in room %s on Anda", inv.Film, inv.Code)
			} else {
				t.title = "Join " + inv.Host + "’s room on Anda"
				t.alt = fmt.Sprintf("%s’s room %s on Anda", inv.Host, inv.Code)
			}
			if inv.Host != "" {
				desc = append(desc, inv.Host+" is hosting")
			}
			switch {
			case inv.Online == 1:
				desc = append(desc, "1 watching now")
			case inv.Online > 1:
				desc = append(desc, fmt.Sprintf("%d watching now", inv.Online))
			}
			if inv.Film == "" {
				desc = append(desc, "nothing on yet")
			}
			desc = append(desc, "watch together on Anda")
			t.desc = strings.Join(desc, " · ")
			if inv.Host == "" { // a username keeps its case; the phrases after it start small
				t.desc = strings.ToUpper(t.desc[:1]) + t.desc[1:]
			}
		}
	}
	tag := func(attr, key, val string) string {
		return fmt.Sprintf(`<meta %s="%s" content="%s"/>`, attr, key, html.EscapeString(val))
	}
	return strings.Join([]string{
		tag("property", "og:type", "website"),
		tag("property", "og:site_name", "Anda"),
		tag("property", "og:title", t.title),
		tag("property", "og:description", t.desc),
		tag("property", "og:url", t.url),
		tag("property", "og:image", t.image),
		tag("property", "og:image:type", "image/jpeg"),
		tag("property", "og:image:width", fmt.Sprint(Width)),
		tag("property", "og:image:height", fmt.Sprint(Height)),
		tag("property", "og:image:alt", t.alt),
		tag("name", "twitter:card", "summary_large_image"),
	}, "")
}

// baseURL is the site's origin as the visitor sees it (behind Caddy: https).
func baseURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}
