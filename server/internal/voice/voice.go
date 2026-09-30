// Package voice hands out LiveKit access tokens, so people in a room can talk and share
// cameras through the LiveKit SFU (plan, step 7). Media never touches this service: the
// browser connects to LiveKit directly with the token; the LiveKit room is the Anda room code.
package voice

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"anda/internal/httpx"
	"anda/internal/rooms"
	"anda/internal/store"
)

// tokenTTL only bounds joining: once connected, LiveKit refreshes the token itself.
const tokenTTL = 2 * time.Hour

type Service struct {
	// URL is the LiveKit URL the browser connects to: absolute (wss://lk.example), or a path
	// ("/livekit") served through the same host as Anda, completed from the request.
	URL    string
	Key    string // LiveKit API key
	Secret string // LiveKit API secret
	// InRoom reports whether the user is currently a member of the live room.
	InRoom       func(code string, userID int64) bool
	Authenticate func(*http.Request) (store.User, error)
	Log          *slog.Logger
	now          func() time.Time
}

func (s *Service) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/rooms/{code}/voice", s.handleToken)
}

func (s *Service) handleToken(w http.ResponseWriter, r *http.Request) {
	u, err := s.Authenticate(r)
	if err != nil {
		httpx.Error(w, http.StatusUnauthorized, "unauthenticated", "Log in first.")
		return
	}
	if s.URL == "" || s.Key == "" || s.Secret == "" {
		httpx.Error(w, http.StatusServiceUnavailable, "voice_unavailable", "Voice isn't set up on this server.")
		return
	}
	code, ok := rooms.NormalizeCode(r.PathValue("code"))
	// Only people in the room right now: a token is a key to its microphones and cameras.
	if !ok || !s.InRoom(code, u.ID) {
		httpx.Error(w, http.StatusForbidden, "not_in_room", "Join the room first.")
		return
	}
	token, err := s.token(code, u)
	if err != nil {
		s.Log.Error("voice token", "err", err)
		httpx.Error(w, http.StatusInternalServerError, "internal", "Couldn't start voice.")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]string{"url": s.publicURL(r), "token": token})
}

func (s *Service) publicURL(r *http.Request) string {
	if !strings.HasPrefix(s.URL, "/") {
		return s.URL
	}
	scheme := "ws"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "wss"
	}
	return scheme + "://" + r.Host + s.URL
}

// grant is LiveKit's "video" claim.
type grant struct {
	RoomJoin          bool     `json:"roomJoin"`
	Room              string   `json:"room"`
	CanPublish        bool     `json:"canPublish"`
	CanSubscribe      bool     `json:"canSubscribe"`
	CanPublishData    bool     `json:"canPublishData"`
	CanPublishSources []string `json:"canPublishSources"`
}

type claims struct {
	Issuer    string `json:"iss"`
	Subject   string `json:"sub"` // participant identity: the Anda user ID
	Name      string `json:"name"`
	NotBefore int64  `json:"nbf"`
	ExpiresAt int64  `json:"exp"`
	Video     grant  `json:"video"`
}

func (s *Service) token(room string, u store.User) (string, error) {
	now := time.Now()
	if s.now != nil {
		now = s.now()
	}
	c := claims{
		Issuer: s.Key, Subject: strconv.FormatInt(u.ID, 10), Name: u.Username,
		NotBefore: now.Add(-10 * time.Second).Unix(), ExpiresAt: now.Add(tokenTTL).Unix(),
		Video: grant{
			RoomJoin: true, Room: room, CanPublish: true, CanSubscribe: true,
			// Mic and camera only; chat stays on Anda's own socket.
			CanPublishSources: []string{"microphone", "camera"},
		},
	}
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	body, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	signing := header + "." + base64.RawURLEncoding.EncodeToString(body)
	mac := hmac.New(sha256.New, []byte(s.Secret))
	mac.Write([]byte(signing))
	return signing + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}
