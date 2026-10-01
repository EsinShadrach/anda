// Package auth handles accounts and cookie sessions: username + password only.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"log/slog"
	"math"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"anda/internal/httpx"
	"anda/internal/store"
)

const (
	CookieName = "anda_session"

	sessionIdle   = 30 * 24 * time.Hour // expire after 30 days of inactivity
	touchInterval = time.Hour           // don't write last_seen_at on every request

	minPassword = 8
	maxPassword = 256
)

var usernameRE = regexp.MustCompile(`^[A-Za-z0-9_]{3,20}$`)

type Config struct {
	// SecureCookie sets the Secure flag; true whenever served over HTTPS.
	SecureCookie bool
	// TrustProxy reads the client IP from X-Forwarded-For. Only safe when every request
	// comes through a proxy that sets it (Caddy overwrites client-sent values by default).
	TrustProxy bool
}

type Service struct {
	users    store.Users
	sessions store.Sessions
	cfg      Config
	log      *slog.Logger

	loginPerAccount *limiter
	loginPerIP      *limiter
	signupPerIP     *limiter
	previewPerIP    *limiter

	dummyOnce sync.Once
	dummyHash string
}

func New(users store.Users, sessions store.Sessions, cfg Config, log *slog.Logger) *Service {
	return &Service{
		users:           users,
		sessions:        sessions,
		cfg:             cfg,
		log:             log,
		loginPerAccount: newLimiter(5, 15*time.Minute),
		loginPerIP:      newLimiter(20, 15*time.Minute),
		signupPerIP:     newLimiter(10, time.Hour),
		previewPerIP:    newLimiter(60, 15*time.Minute),
	}
}

func (s *Service) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/auth/signup", s.handleSignup)
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)
	mux.HandleFunc("GET /api/me", s.handleMe)
}

// RunJanitor clears expired sessions and stale rate-limit entries until ctx ends.
func (s *Service) RunJanitor(ctx context.Context) {
	t := time.NewTicker(15 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			if n, err := s.sessions.DeleteExpiredSessions(ctx, now); err != nil {
				s.log.Error("delete expired sessions", "err", err)
			} else if n > 0 {
				s.log.Info("deleted expired sessions", "count", n)
			}
			s.loginPerAccount.sweep(now)
			s.loginPerIP.sweep(now)
			s.signupPerIP.sweep(now)
			s.previewPerIP.sweep(now)
		}
	}
}

// UserFromRequest returns the signed-in user for r, or store.ErrNotFound.
// The WebSocket gateway uses it to authenticate the upgrade with the same cookie.
func (s *Service) UserFromRequest(r *http.Request) (store.User, error) {
	c, err := r.Cookie(CookieName)
	if err != nil || c.Value == "" {
		return store.User{}, store.ErrNotFound
	}
	id := hashToken(c.Value)
	sess, err := s.sessions.SessionByID(r.Context(), id)
	if err != nil {
		return store.User{}, err
	}
	if now := time.Now(); now.Sub(sess.LastSeenAt) > touchInterval {
		if err := s.sessions.TouchSession(r.Context(), id, now, now.Add(sessionIdle)); err != nil {
			s.log.Warn("touch session", "err", err)
		}
	}
	return s.users.UserByID(r.Context(), sess.UserID)
}

type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type userJSON struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
}

func (s *Service) handleSignup(w http.ResponseWriter, r *http.Request) {
	ip := s.clientIP(r)
	now := time.Now()
	if ok, wait := s.signupPerIP.blocked(ip, now); ok {
		tooMany(w, wait, "Too many sign-ups from this network. Try again later.")
		return
	}
	var c credentials
	if !httpx.Decode(w, r, &c) {
		return
	}
	if !usernameRE.MatchString(c.Username) {
		httpx.Error(w, http.StatusBadRequest, "invalid_username", "Usernames are 3 to 20 letters, numbers or underscores.")
		return
	}
	if n := utf8.RuneCountInString(c.Password); n < minPassword || len(c.Password) > maxPassword {
		httpx.Error(w, http.StatusBadRequest, "invalid_password", "Passwords need at least 8 characters.")
		return
	}
	hash, err := hashPassword(c.Password)
	if err != nil {
		s.internal(w, "hash password", err)
		return
	}
	u, err := s.users.CreateUser(r.Context(), c.Username, hash)
	if errors.Is(err, store.ErrUsernameTaken) {
		httpx.Error(w, http.StatusConflict, "username_taken", "That username is taken.")
		return
	}
	if err != nil {
		s.internal(w, "create user", err)
		return
	}
	s.signupPerIP.add(ip, now)
	if err := s.startSession(w, r, u.ID); err != nil {
		s.internal(w, "create session", err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"user": userJSON{u.ID, u.Username}})
}

func (s *Service) handleLogin(w http.ResponseWriter, r *http.Request) {
	var c credentials
	if !httpx.Decode(w, r, &c) {
		return
	}
	ip := s.clientIP(r)
	account := strings.ToLower(c.Username)
	now := time.Now()
	for _, check := range []struct {
		l   *limiter
		key string
	}{{s.loginPerIP, ip}, {s.loginPerAccount, account}} {
		if ok, wait := check.l.blocked(check.key, now); ok {
			tooMany(w, wait, "Too many failed logins. Try again later.")
			return
		}
	}

	u, err := s.users.UserByUsername(r.Context(), c.Username)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.internal(w, "load user", err)
		return
	}
	var ok bool
	if err == nil {
		ok, err = verifyPassword(c.Password, u.PasswordHash)
		if err != nil {
			s.internal(w, "verify password", err)
			return
		}
	} else {
		// Hash anyway so unknown usernames take as long as wrong passwords.
		_, _ = verifyPassword(c.Password, s.dummy())
	}
	if !ok {
		s.loginPerIP.add(ip, now)
		s.loginPerAccount.add(account, now)
		httpx.Error(w, http.StatusUnauthorized, "bad_credentials", "Wrong username or password.")
		return
	}
	s.loginPerAccount.reset(account)
	if err := s.startSession(w, r, u.ID); err != nil {
		s.internal(w, "create session", err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"user": userJSON{u.ID, u.Username}})
}

func (s *Service) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(CookieName); err == nil && c.Value != "" {
		if err := s.sessions.DeleteSession(r.Context(), hashToken(c.Value)); err != nil {
			s.internal(w, "delete session", err)
			return
		}
	}
	s.setCookie(w, "", -1)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Service) handleMe(w http.ResponseWriter, r *http.Request) {
	u, err := s.UserFromRequest(r)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusUnauthorized, "not_signed_in", "Not signed in.")
		return
	}
	if err != nil {
		s.internal(w, "load session", err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"user": userJSON{u.ID, u.Username}})
}

func (s *Service) startSession(w http.ResponseWriter, r *http.Request, userID int64) error {
	// Replace any session this browser already had.
	if c, err := r.Cookie(CookieName); err == nil && c.Value != "" {
		_ = s.sessions.DeleteSession(r.Context(), hashToken(c.Value))
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	now := time.Now()
	err := s.sessions.CreateSession(r.Context(), store.Session{
		ID: hashToken(token), UserID: userID, ExpiresAt: now.Add(sessionIdle), LastSeenAt: now,
	})
	if err != nil {
		return err
	}
	s.setCookie(w, token, int(sessionIdle.Seconds()))
	return nil
}

func (s *Service) setCookie(w http.ResponseWriter, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   s.cfg.SecureCookie,
		SameSite: http.SameSiteLaxMode,
	})
}

func (s *Service) dummy() string {
	s.dummyOnce.Do(func() {
		s.dummyHash, _ = hashPassword("anda-dummy-password")
	})
	return s.dummyHash
}

// AllowPreview counts a signed-out look at an invite (whose room, who's in it) against the
// client's IP: plenty for real invite links, far too few to walk the code space.
func (s *Service) AllowPreview(r *http.Request) bool {
	ip, now := s.clientIP(r), time.Now()
	if blocked, _ := s.previewPerIP.blocked(ip, now); blocked {
		return false
	}
	s.previewPerIP.add(ip, now)
	return true
}

func (s *Service) clientIP(r *http.Request) string {
	if s.cfg.TrustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			// The proxy appends the real client last.
			parts := strings.Split(xff, ",")
			return strings.TrimSpace(parts[len(parts)-1])
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (s *Service) internal(w http.ResponseWriter, what string, err error) {
	s.log.Error(what, "err", err)
	httpx.Error(w, http.StatusInternalServerError, "internal", "Something went wrong.")
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func tooMany(w http.ResponseWriter, wait time.Duration, msg string) {
	w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(wait.Seconds()))))
	httpx.Error(w, http.StatusTooManyRequests, "rate_limited", msg)
}
