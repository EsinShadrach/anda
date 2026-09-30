package auth

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"anda/internal/store"
)

func newServer(t *testing.T, dbPath string) *httptest.Server {
	t.Helper()
	db, err := store.OpenSQLite(context.Background(), dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	mux := http.NewServeMux()
	New(db, db, Config{}, slog.New(slog.NewTextHandler(io.Discard, nil))).Register(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func newClient(t *testing.T) *http.Client {
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Client{Jar: jar}
}

func post(t *testing.T, c *http.Client, url, body string) int {
	t.Helper()
	res, err := c.Post(url, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	return res.StatusCode
}

func get(t *testing.T, c *http.Client, url string) (int, string) {
	t.Helper()
	res, err := c.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func TestAuthFlow(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "anda.db")
	srv := newServer(t, dbPath)
	c := newClient(t)

	if code := post(t, c, srv.URL+"/api/auth/signup", `{"username":"Rafe","password":"hunter22!"}`); code != http.StatusCreated {
		t.Fatalf("signup: got %d", code)
	}
	if code, body := get(t, c, srv.URL+"/api/me"); code != http.StatusOK || !strings.Contains(body, `"Rafe"`) {
		t.Fatalf("me after signup: %d %s", code, body)
	}
	// Usernames are unique case-insensitively.
	if code := post(t, newClient(t), srv.URL+"/api/auth/signup", `{"username":"rafe","password":"whatever12"}`); code != http.StatusConflict {
		t.Fatalf("duplicate signup: got %d", code)
	}
	if code := post(t, c, srv.URL+"/api/auth/signup", `{"username":"no spaces","password":"hunter22!"}`); code != http.StatusBadRequest {
		t.Fatalf("bad username: got %d", code)
	}

	// Sessions survive a restart: a new server on the same file accepts the old cookie.
	srv2 := newServer(t, dbPath)
	srvURL, cookies := srv.URL, c.Jar.Cookies(mustURL(t, srv.URL))
	c.Jar.SetCookies(mustURL(t, srv2.URL), cookies)
	if code, _ := get(t, c, srv2.URL+"/api/me"); code != http.StatusOK {
		t.Fatalf("me after restart: %d", code)
	}

	if code := post(t, c, srvURL+"/api/auth/logout", ``); code != http.StatusNoContent {
		t.Fatalf("logout: got %d", code)
	}
	if code, _ := get(t, c, srvURL+"/api/me"); code != http.StatusUnauthorized {
		t.Fatalf("me after logout: %d", code)
	}
	// The old cookie no longer works anywhere once the session is deleted.
	c.Jar.SetCookies(mustURL(t, srv2.URL), cookies)
	if code, _ := get(t, c, srv2.URL+"/api/me"); code != http.StatusUnauthorized {
		t.Fatalf("old cookie after logout: %d", code)
	}

	// Login is case-insensitive on the username.
	if code := post(t, c, srvURL+"/api/auth/login", `{"username":"RAFE","password":"hunter22!"}`); code != http.StatusOK {
		t.Fatalf("login: got %d", code)
	}
}

func TestLoginRateLimit(t *testing.T) {
	srv := newServer(t, filepath.Join(t.TempDir(), "anda.db"))
	c := newClient(t)
	post(t, c, srv.URL+"/api/auth/signup", `{"username":"tobi","password":"correct-horse"}`)

	for i := range 5 {
		if code := post(t, c, srv.URL+"/api/auth/login", `{"username":"tobi","password":"wrong-guess"}`); code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: got %d", i+1, code)
		}
	}
	// Even the right password is refused while the account is locked out.
	if code := post(t, c, srv.URL+"/api/auth/login", `{"username":"tobi","password":"correct-horse"}`); code != http.StatusTooManyRequests {
		t.Fatalf("after 5 failures: got %d", code)
	}
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}
