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
	// Where it left off: the film on screen (0 if none) and its position in seconds.
	MediaID       int64
	MediaPosition float64
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
	// SaveRoomPlayback records the film on screen (0 for none) and its position.
	SaveRoomPlayback(ctx context.Context, id, mediaID int64, position float64) error
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

	Source    string // local | torrent
	CatalogID string // e.g. an IMDb ID, for torrent films
	InfoHash  string
	FileIdx   int
	SourceURL string // direct-link Library films, instead of InfoHash
	Poster    string
	Year      string
}

// TorrentMedia describes a film picked from a Library stream.
type TorrentMedia struct {
	Title     string
	CatalogID string
	InfoHash  string
	FileIdx   int
	SourceURL string // set instead of InfoHash for a direct link
	SizeBytes int64
	Poster    string
	Year      string
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

	// UpsertTorrentMedia returns the film for (info hash, file), creating it as
	// downloading/pending if it's new.
	UpsertTorrentMedia(ctx context.Context, t TorrentMedia) (Media, error)
	SetMediaStatus(ctx context.Context, id int64, status string) error
	// TorrentMediaInProgress lists torrent films whose preparation was interrupted.
	TorrentMediaInProgress(ctx context.Context) ([]Media, error)
	// ReadyTorrentMedia lists finished torrent films, least recently watched first
	// (eviction order).
	ReadyTorrentMedia(ctx context.Context) ([]Media, error)
	DeleteMedia(ctx context.Context, id int64) error
}
