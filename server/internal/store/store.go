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
	// DeleteRoom removes the room with its chat and member history.
	DeleteRoom(ctx context.Context, id int64) error

	// RecordVisit notes that userID joined roomID at at (first or again).
	RecordVisit(ctx context.Context, roomID, userID int64, at time.Time) error
	// VisitedRooms lists up to limit rooms userID has been in, most recently joined first.
	VisitedRooms(ctx context.Context, userID int64, limit int) ([]VisitedRoom, error)
	// ForgetVisit drops roomID from userID's list; the room itself stays.
	ForgetVisit(ctx context.Context, roomID, userID int64) error
}

type VisitedRoom struct {
	Room
	OwnerName    string
	LastJoinedAt time.Time
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
	Status        string // downloading | ready (the file itself)
	Path          string // relative to the media directory
	LastWatchedAt time.Time

	HLSState   string // pending | remuxing | ready | incompatible | failed
	HLSError   string
	VideoCodec string
	AudioCodec string
	Duration   float64 // seconds, once probed
}

// HLS states.
const (
	HLSPending      = "pending"
	HLSRemuxing     = "remuxing"
	HLSReady        = "ready"
	HLSIncompatible = "incompatible"
	HLSFailed       = "failed"
)

type MediaStore interface {
	// UpsertLocalMedia registers a ready file found on disk, keyed by its path. A file
	// whose size changed goes back to HLS pending.
	UpsertLocalMedia(ctx context.Context, title, path string, size int64) (Media, error)
	MediaByID(ctx context.Context, id int64) (Media, error)
	// ReadyMedia lists films that can be played (file ready and HLS ready), most recently
	// watched first.
	ReadyMedia(ctx context.Context) ([]Media, error)
	// MediaNeedingHLS lists files that still need probing/remuxing (pending, or remuxing
	// when a previous run was interrupted).
	MediaNeedingHLS(ctx context.Context) ([]Media, error)
	SetHLSState(ctx context.Context, id int64, state, errMsg string) error
	SetProbe(ctx context.Context, id int64, videoCodec, audioCodec string, duration float64) error
	TouchMedia(ctx context.Context, id int64, at time.Time) error
}
