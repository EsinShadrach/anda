// Package store holds persistent data behind interfaces, so SQLite can later be swapped
// for Postgres (and sessions for Redis) without touching the packages that use it.
package store

import (
	"context"
	"errors"
	"time"
)

var (
	ErrNotFound      = errors.New("store: not found")
	ErrUsernameTaken = errors.New("store: username taken")
)

type User struct {
	ID           int64
	Username     string
	PasswordHash string
	CreatedAt    time.Time
}

type Session struct {
	ID         string // hashed token
	UserID     int64
	ExpiresAt  time.Time
	LastSeenAt time.Time
}

type Users interface {
	CreateUser(ctx context.Context, username, passwordHash string) (User, error)
	// UserByUsername matches case-insensitively.
	UserByUsername(ctx context.Context, username string) (User, error)
	UserByID(ctx context.Context, id int64) (User, error)
}

type Sessions interface {
	CreateSession(ctx context.Context, s Session) error
	// SessionByID returns ErrNotFound for missing or expired sessions.
	SessionByID(ctx context.Context, id string) (Session, error)
	TouchSession(ctx context.Context, id string, lastSeen, expires time.Time) error
	DeleteSession(ctx context.Context, id string) error
	DeleteExpiredSessions(ctx context.Context, now time.Time) (int64, error)
}
