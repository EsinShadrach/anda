package site

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSite(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) {
		p := filepath.Join(dir, name)
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, []byte(body), 0o644)
	}
	write("index.html", "home")
	write("room.html", "room page")
	write("404.html", "not here")
	write("_next/static/chunks/app.js", "js")
	os.WriteFile(filepath.Join(t.TempDir(), "secret"), []byte("x"), 0o644)
	h := Handler{Dir: dir}
	get := func(p string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", p, nil))
		return w
	}
	cases := []struct {
		path, body, cache string
		code              int
	}{
		{"/", "home", "no-cache", 200},
		{"/room", "room page", "no-cache", 200},
		{"/room?code=BCDFGH", "room page", "no-cache", 200},
		{"/_next/static/chunks/app.js", "js", "public, max-age=31536000, immutable", 200},
		{"/nope", "not here", "no-cache", 404},
		{"/../../etc/passwd", "not here", "no-cache", 404},
		{"/api/unknown", "404 page not found\n", "", 404},
	}
	for _, c := range cases {
		w := get(c.path)
		if w.Code != c.code || !strings.Contains(w.Body.String(), c.body) || w.Header().Get("Cache-Control") != c.cache {
			t.Errorf("%s: %d %q cache=%q", c.path, w.Code, w.Body, w.Header().Get("Cache-Control"))
		}
	}
	if w := get("/room"); w.Header().Get("Content-Type") != "text/html; charset=utf-8" {
		t.Errorf("content type: %q", w.Header().Get("Content-Type"))
	}
}

func TestSiteHead(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "room.html"), []byte("<html><head><title>Anda</title></head><body>room</body></html>"), 0o644)
	os.WriteFile(filepath.Join(dir, "app.js"), []byte("js"), 0o644)
	var pages []string
	h := Handler{Dir: dir, Head: func(r *http.Request, page string) string {
		pages = append(pages, page+"?"+r.URL.RawQuery)
		return `<meta property="og:title" content="x"/>`
	}}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/room?code=BCDFGH", nil))
	want := `<title>Anda</title><meta property="og:title" content="x"/></head>`
	if w.Code != 200 || !strings.Contains(w.Body.String(), want) || w.Header().Get("Cache-Control") != "no-cache" {
		t.Errorf("room: %d %q cache=%q", w.Code, w.Body, w.Header().Get("Cache-Control"))
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/app.js", nil))
	if w.Body.String() != "js" {
		t.Errorf("app.js: %q", w.Body)
	}
	if len(pages) != 1 || pages[0] != "room?code=BCDFGH" {
		t.Errorf("Head called for %q", pages)
	}
}
