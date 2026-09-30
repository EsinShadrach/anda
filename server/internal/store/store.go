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
	ErrCodeTaken     = errors.New("store: room code taken")
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

type Room struct {
	ID           int64
	Code         string
	OwnerID      int64
	CreatedAt    time.Time
	LastActiveAt time.Time
}

type ChatMessage struct {
	ID        int64
	RoomID    int64
	UserID    int64
	Username  string
	Text      string
	CreatedAt time.Time
}

type Rooms interface {
	// CreateRoom returns ErrCodeTaken if code is already used.
	CreateRoom(ctx context.Context, code string, ownerID int64) (Room, error)
	RoomByCode(ctx context.Context, code string) (Room, error)
	TouchRoom(ctx context.Context, id int64, at time.Time) error
}

type Chat interface {
	AddChatMessage(ctx context.Context, m ChatMessage) (ChatMessage, error)
	// RecentChatMessages returns up to limit messages, oldest first.
	RecentChatMessages(ctx context.Context, roomID int64, limit int) ([]ChatMessage, error)
}

type Media struct {
	ID            int64
	Title         string
	SizeBytes     int64
	Status        string // downloading | ready
	Path          string // relative to the media directory
	LastWatchedAt time.Time
}

type MediaStore interface {
	// UpsertLocalMedia registers a ready file found on disk, keyed by its path.
	UpsertLocalMedia(ctx context.Context, title, path string, size int64) (Media, error)
	MediaByID(ctx context.Context, id int64) (Media, error)
	// ReadyMedia lists ready films, most recently watched first.
	ReadyMedia(ctx context.Context) ([]Media, error)
	TouchMedia(ctx context.Context, id int64, at time.Time) error
}
