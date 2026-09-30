package library

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"anda/internal/store"
)

func TestToWebVTT(t *testing.T) {
	srt := "\xef\xbb\xbf1\r\n00:00:01,000 --> 00:00:03,250\r\nHello\r\n"
	if got := string(toWebVTT([]byte(srt))); got != "WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.250\nHello\n" {
		t.Fatalf("srt: %q", got)
	}
	// Windows-1252 "Ça va" and a curly apostrophe.
	if got := string(toWebVTT([]byte("1\n00:00:01,000 --> 00:00:02,000\n\xc7a va \x92\n"))); !strings.Contains(got, "Ça va ’") {
		t.Fatalf("cp1252: %q", got)
	}
	if got := string(toWebVTT([]byte("WEBVTT\n\n00:01.000 --> 00:02.000\nhi\n"))); !strings.HasPrefix(got, "WEBVTT\n\n00:01.000") {
		t.Fatalf("vtt passthrough: %q", got)
	}
}

func TestSubtitleAddons(t *testing.T) {
	addon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/manifest.json":
			w.Write([]byte(`{"name":"Subs"}`))
		case "/subtitles/movie/tt0000001.json":
			w.Write([]byte(`{"subtitles":[
				{"id":"1","url":"https://subs.example.com/a.srt","lang":"eng"},
				{"id":"2","url":"https://subs.example.com/b.srt","lang":"fre"},
				{"id":"3","url":"http://127.0.0.1:8080/api/me","lang":"eng"}
			]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer addon.Close()
	fetched := 0
	s := &Service{
		SubtitleAddons: []string{addon.URL},
		Authenticate:   func(*http.Request) (store.User, error) { return store.User{ID: 1}, nil },
		Log:            slog.New(slog.NewTextHandler(io.Discard, nil)),
		fetch: func(_ context.Context, url string) ([]byte, error) {
			fetched++
			return []byte("1\n00:00:01,000 --> 00:00:02,000\nfrom " + url + "\n"), nil
		},
	}
	mux := http.NewServeMux()
	s.Register(mux)
	get := func(path string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		return w
	}

	var out struct{ Subtitles []SubtitleOption }
	json.NewDecoder(get("/api/library/tt0000001/subtitles").Body).Decode(&out)
	if len(out.Subtitles) != 2 || out.Subtitles[0].Source != "Subs" { // the private one is dropped
		t.Fatalf("list: %+v", out.Subtitles)
	}
	var en string
	for _, o := range out.Subtitles {
		if o.Lang == "en" {
			en = o.Key
		}
	}
	w := get("/api/library/tt0000001/subtitles/" + en + ".vtt")
	if w.Code != 200 || w.Header().Get("Content-Type") != "text/vtt; charset=utf-8" ||
		!strings.Contains(w.Body.String(), "00:00:01.000 --> 00:00:02.000\nfrom https://subs.example.com/a.srt") {
		t.Fatalf("file: %d %q", w.Code, w.Body)
	}
	get("/api/library/tt0000001/subtitles/" + en + ".vtt")
	if fetched != 1 {
		t.Fatalf("second request should be cached, fetched %d times", fetched)
	}
	if w := get("/api/library/tt0000001/subtitles/deadbeef.vtt"); w.Code != 404 {
		t.Fatalf("unknown key: %d", w.Code)
	}
}
