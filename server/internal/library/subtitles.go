package library

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"anda/internal/httpx"
	"anda/internal/media"
)

// Subtitles from Stremio subtitle addons (ANDA_SUBTITLE_ADDONS), for films whose release
// has none built in, or not in your language. The server fetches the file (only ones an
// addon listed, only from public addresses) and hands the player WebVTT.

// SubtitleOption is one addon subtitle as the client sees it.
type SubtitleOption struct {
	Key    string `json:"key"` // opaque; fetch it at /api/library/{id}/subtitles/{key}.vtt
	Lang   string `json:"lang,omitempty"`
	Source string `json:"source"` // addon name
	url    string
}

type addonSubtitle struct {
	ID   string `json:"id"`
	URL  string `json:"url"`
	Lang string `json:"lang"`
}

const (
	maxSubtitleBytes = 2 << 20
	subsPerLang      = 3 // the addon's first few per language are plenty
)

type subCache struct {
	mu    sync.Mutex
	lists map[string]cached[[]SubtitleOption] // by catalog ID
	files map[string][]byte                   // by key: converted WebVTT
}

func (s *Service) handleSubtitles(w http.ResponseWriter, r *http.Request) {
	if !s.authed(w, r) {
		return
	}
	id := r.PathValue("id")
	if !validID(id) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such film.")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"subtitles": s.subtitleList(r.Context(), id)})
}

func (s *Service) handleSubtitleFile(w http.ResponseWriter, r *http.Request) {
	if !s.authed(w, r) {
		return
	}
	id, key := r.PathValue("id"), strings.TrimSuffix(r.PathValue("file"), ".vtt")
	s.subs.mu.Lock()
	vtt, ok := s.subs.files[key]
	s.subs.mu.Unlock()
	if !ok {
		var pick *SubtitleOption
		for _, o := range s.subtitleList(r.Context(), id) {
			if o.Key == key {
				pick = &o
				break
			}
		}
		if pick == nil {
			httpx.Error(w, http.StatusNotFound, "not_found", "That subtitle isn't available any more.")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		fetch := s.fetch
		if fetch == nil {
			fetch = fetchPublic
		}
		raw, err := fetch(ctx, pick.url)
		cancel()
		if err != nil {
			s.Log.Warn("subtitle download", "id", id, "err", err)
			httpx.Error(w, http.StatusBadGateway, "unavailable", "Couldn't get that subtitle.")
			return
		}
		vtt = toWebVTT(raw)
		s.subs.mu.Lock()
		if len(s.subs.files) >= 64 {
			clear(s.subs.files)
		}
		s.subs.files[key] = vtt
		s.subs.mu.Unlock()
	}
	w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
	w.Header().Set("Cache-Control", "private, max-age=86400")
	w.Write(vtt)
}

// subtitleList asks every subtitle addon for a film's subtitles, a few per language.
func (s *Service) subtitleList(ctx context.Context, id string) []SubtitleOption {
	s.subs.mu.Lock()
	if c, ok := s.subs.lists[id]; ok && time.Since(c.at) < cacheTTL {
		s.subs.mu.Unlock()
		return c.v
	}
	s.subs.mu.Unlock()

	var mu sync.Mutex
	var wg sync.WaitGroup
	list := []SubtitleOption{}
	for _, base := range s.SubtitleAddons {
		wg.Add(1)
		go func() {
			defer wg.Done()
			actx, cancel := context.WithTimeout(ctx, 12*time.Second)
			defer cancel()
			var out struct {
				Subtitles []addonSubtitle `json:"subtitles"`
			}
			if err := s.addons.get(actx, base, "/subtitles/movie/"+url.PathEscape(id)+".json", &out); err != nil {
				s.Log.Warn("subtitle addon", "addon", base, "id", id, "err", err)
				return
			}
			name := s.addonName(actx, base)
			perLang := map[string]int{}
			mu.Lock()
			defer mu.Unlock()
			for _, a := range out.Subtitles {
				lang := media.NormLang(a.Lang)
				if !plausibleURL(a.URL) || perLang[lang] >= subsPerLang {
					continue
				}
				perLang[lang]++
				sum := sha256.Sum256([]byte(a.URL))
				list = append(list, SubtitleOption{Key: hex.EncodeToString(sum[:10]), Lang: lang, Source: name, url: a.URL})
			}
		}()
	}
	wg.Wait()

	s.subs.mu.Lock()
	if len(s.subs.lists) >= cacheEntries {
		clear(s.subs.lists)
	}
	s.subs.lists[id] = cached[[]SubtitleOption]{list, time.Now()}
	s.subs.mu.Unlock()
	return list
}

// publicClient refuses to connect anywhere but public addresses, checked on the address
// actually dialled (so a name can't resolve to a public IP for a check and a private one
// for the fetch).
var publicClient = &http.Client{
	Timeout: 20 * time.Second,
	Transport: &http.Transport{
		Proxy: nil,
		DialContext: (&net.Dialer{
			Timeout: 10 * time.Second,
			Control: func(_, address string, _ syscall.RawConn) error {
				ap, err := netip.ParseAddrPort(address)
				if err != nil || !publicAddr(ap.Addr()) {
					return errPrivateURL
				}
				return nil
			},
		}).DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 15 * time.Second,
	},
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 || !plausibleURL(req.URL.String()) {
			return errors.New("too many or unsafe redirects")
		}
		return nil
	},
}

func fetchPublic(ctx context.Context, raw string) ([]byte, error) {
	if !plausibleURL(raw) {
		return nil, errPrivateURL
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	res, err := publicClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("subtitle: %s", res.Status)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, maxSubtitleBytes+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxSubtitleBytes {
		return nil, errors.New("subtitle file too large")
	}
	return b, nil
}

var srtTime = regexp.MustCompile(`(\d{1,2}:\d{2}:\d{2}),(\d{3})`)

// toWebVTT turns an SRT (or already-WebVTT) file into UTF-8 WebVTT. Old SRT files are
// often Windows-1252, which would show accents as garbage; those are converted.
func toWebVTT(b []byte) []byte {
	b = bytes.TrimPrefix(b, []byte("\xef\xbb\xbf"))
	if !utf8.Valid(b) {
		b = fromCP1252(b)
	}
	b = bytes.ReplaceAll(b, []byte("\r\n"), []byte("\n"))
	b = bytes.ReplaceAll(b, []byte("\r"), []byte("\n"))
	if bytes.HasPrefix(b, []byte("WEBVTT")) {
		return b
	}
	b = srtTime.ReplaceAll(b, []byte("$1.$2"))
	return append([]byte("WEBVTT\n\n"), b...)
}

// Windows-1252's 0x80–0x9F; the rest of its range matches Latin-1 (= the same code points).
var cp1252 = [32]rune{
	'€', '\u0081', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u008d', 'Ž', '\u008f',
	'\u0090', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u009d', 'ž', 'Ÿ',
}

func fromCP1252(b []byte) []byte {
	var out bytes.Buffer
	out.Grow(len(b) + len(b)/8)
	for _, c := range b {
		switch {
		case c < 0x80:
			out.WriteByte(c)
		case c < 0xA0:
			out.WriteRune(cp1252[c-0x80])
		default:
			out.WriteRune(rune(c))
		}
	}
	return out.Bytes()
}
