package voice

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"anda/internal/store"
)

func TestTokenEndpoint(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	s := &Service{
		URL: "wss://anda.example/livekit", Key: "APIkey", Secret: "s3cret-s3cret-s3cret-s3cret-s3cret",
		InRoom: func(code string, id int64) bool { return code == "BCDFGH" && id == 7 },
		Authenticate: func(r *http.Request) (store.User, error) {
			switch r.Header.Get("X-User") {
			case "rafe":
				return store.User{ID: 7, Username: "rafe"}, nil
			case "chimamanda":
				return store.User{ID: 8, Username: "chimamanda"}, nil
			}
			return store.User{}, errors.New("no session")
		},
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		now: func() time.Time { return now },
	}
	mux := http.NewServeMux()
	s.Register(mux)
	call := func(user, code string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/api/rooms/"+code+"/voice", nil)
		req.Header.Set("X-User", user)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)
		return w
	}

	if w := call("", "BCDFGH"); w.Code != 401 {
		t.Fatalf("no session: %d", w.Code)
	}
	if w := call("chimamanda", "BCDFGH"); w.Code != 403 {
		t.Fatalf("not in the room: %d", w.Code)
	}
	w := call("rafe", "bcdfgh") // codes are case-insensitive
	if w.Code != 200 {
		t.Fatalf("member: %d %s", w.Code, w.Body)
	}
	var out struct{ URL, Token string }
	json.NewDecoder(w.Body).Decode(&out)
	if out.URL != s.URL {
		t.Fatalf("url: %q", out.URL)
	}

	// A valid HS256 JWT, signed with the secret, granting exactly this room.
	parts := strings.Split(out.Token, ".")
	if len(parts) != 3 {
		t.Fatalf("token: %q", out.Token)
	}
	mac := hmac.New(sha256.New, []byte(s.Secret))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if base64.RawURLEncoding.EncodeToString(mac.Sum(nil)) != parts[2] {
		t.Fatal("bad signature")
	}
	body, _ := base64.RawURLEncoding.DecodeString(parts[1])
	var c claims
	if err := json.Unmarshal(body, &c); err != nil {
		t.Fatal(err)
	}
	if c.Issuer != "APIkey" || c.Subject != "7" || c.Name != "rafe" || c.Video.Room != "BCDFGH" || !c.Video.RoomJoin ||
		c.ExpiresAt != now.Add(tokenTTL).Unix() || c.NotBefore > now.Unix() || c.Video.CanPublishData {
		t.Fatalf("claims: %+v", c)
	}

	// A path is completed from the request, as served through Caddy.
	s.URL = "/livekit"
	req := httptest.NewRequest("POST", "https://anda.example/api/rooms/BCDFGH/voice", nil)
	req.Header.Set("X-User", "rafe")
	req.Header.Set("X-Forwarded-Proto", "https")
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	json.NewDecoder(w.Body).Decode(&out)
	if out.URL != "wss://anda.example/livekit" {
		t.Fatalf("relative url: %q", out.URL)
	}

	s.Secret = ""
	if w := call("rafe", "BCDFGH"); w.Code != 503 {
		t.Fatalf("unconfigured: %d", w.Code)
	}
}
