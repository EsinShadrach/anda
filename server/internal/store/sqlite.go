package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/pressly/goose/v3"
	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"

	"anda/migrations"
)

// SQLite implements Users and Sessions on a single SQLite file.
type SQLite struct {
	db *sql.DB
}

// OpenSQLite opens (creating if needed) the database at path and applies pending migrations.
func OpenSQLite(ctx context.Context, path string) (*SQLite, error) {
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)&_pragma=synchronous(NORMAL)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// SQLite allows one writer at a time; a single connection avoids SQLITE_BUSY churn
	// and is plenty for this workload.
	db.SetMaxOpenConns(1)
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, err
	}

	goose.SetBaseFS(migrations.FS)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("sqlite3"); err != nil {
		db.Close()
		return nil, err
	}
	if err := goose.UpContext(ctx, db, "."); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return &SQLite{db: db}, nil
}

func (s *SQLite) Close() error { return s.db.Close() }

func (s *SQLite) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }

func (s *SQLite) CreateUser(ctx context.Context, username, passwordHash string) (User, error) {
	now := time.Now()
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)`,
		username, passwordHash, now.Unix())
	if err != nil {
		var se *sqlite.Error
		if errors.As(err, &se) && se.Code() == sqlite3.SQLITE_CONSTRAINT_UNIQUE {
			return User{}, ErrUsernameTaken
		}
		return User{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return User{}, err
	}
	return User{ID: id, Username: username, PasswordHash: passwordHash, CreatedAt: time.Unix(now.Unix(), 0)}, nil
}

func (s *SQLite) UserByUsername(ctx context.Context, username string) (User, error) {
	return s.scanUser(s.db.QueryRowContext(ctx,
		`SELECT id, username, password_hash, created_at FROM users WHERE username = ?`, username))
}

func (s *SQLite) UserByID(ctx context.Context, id int64) (User, error) {
	return s.scanUser(s.db.QueryRowContext(ctx,
		`SELECT id, username, password_hash, created_at FROM users WHERE id = ?`, id))
}

func (s *SQLite) scanUser(row *sql.Row) (User, error) {
	var u User
	var created int64
	if err := row.Scan(&u.ID, &u.Username, &u.PasswordHash, &created); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return User{}, ErrNotFound
		}
		return User{}, err
	}
	u.CreatedAt = time.Unix(created, 0)
	return u, nil
}

func (s *SQLite) CreateSession(ctx context.Context, sess Session) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO sessions (id, user_id, expires_at, last_seen_at) VALUES (?, ?, ?, ?)`,
		sess.ID, sess.UserID, sess.ExpiresAt.Unix(), sess.LastSeenAt.Unix())
	return err
}

func (s *SQLite) SessionByID(ctx context.Context, id string) (Session, error) {
	var sess Session
	var expires, lastSeen int64
	err := s.db.QueryRowContext(ctx,
		`SELECT id, user_id, expires_at, last_seen_at FROM sessions WHERE id = ? AND expires_at > ?`,
		id, time.Now().Unix()).Scan(&sess.ID, &sess.UserID, &expires, &lastSeen)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Session{}, ErrNotFound
		}
		return Session{}, err
	}
	sess.ExpiresAt = time.Unix(expires, 0)
	sess.LastSeenAt = time.Unix(lastSeen, 0)
	return sess, nil
}

func (s *SQLite) TouchSession(ctx context.Context, id string, lastSeen, expires time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?`,
		lastSeen.Unix(), expires.Unix(), id)
	return err
}

func (s *SQLite) DeleteSession(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE id = ?`, id)
	return err
}

func (s *SQLite) DeleteExpiredSessions(ctx context.Context, now time.Time) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at <= ?`, now.Unix())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (s *SQLite) CreateRoom(ctx context.Context, code string, ownerID int64) (Room, error) {
	now := time.Unix(time.Now().Unix(), 0)
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO rooms (code, owner_id, created_at, last_active_at) VALUES (?, ?, ?, ?)`,
		code, ownerID, now.Unix(), now.Unix())
	if err != nil {
		var se *sqlite.Error
		if errors.As(err, &se) && se.Code() == sqlite3.SQLITE_CONSTRAINT_UNIQUE {
			return Room{}, ErrCodeTaken
		}
		return Room{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return Room{}, err
	}
	return Room{ID: id, Code: code, OwnerID: ownerID, CreatedAt: now, LastActiveAt: now}, nil
}

func (s *SQLite) RoomByCode(ctx context.Context, code string) (Room, error) {
	var r Room
	var created, active int64
	err := s.db.QueryRowContext(ctx,
		`SELECT id, code, owner_id, created_at, last_active_at, COALESCE(media_id, 0), media_position
		 FROM rooms WHERE code = ?`, code).
		Scan(&r.ID, &r.Code, &r.OwnerID, &created, &active, &r.MediaID, &r.MediaPosition)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Room{}, ErrNotFound
		}
		return Room{}, err
	}
	r.CreatedAt = time.Unix(created, 0)
	r.LastActiveAt = time.Unix(active, 0)
	return r, nil
}

func (s *SQLite) SaveRoomPlayback(ctx context.Context, id, mediaID int64, position float64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE rooms SET media_id = NULLIF(?, 0), media_position = ? WHERE id = ?`,
		mediaID, position, id)
	return err
}

func (s *SQLite) TouchRoom(ctx context.Context, id int64, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE rooms SET last_active_at = ? WHERE id = ?`, at.Unix(), id)
	return err
}

func (s *SQLite) DeleteRoom(ctx context.Context, id int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM rooms WHERE id = ?`, id)
	return err
}

func (s *SQLite) RecordVisit(ctx context.Context, roomID, userID int64, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO room_members (room_id, user_id, first_joined_at, last_joined_at) VALUES (?, ?, ?, ?)
		ON CONFLICT (user_id, room_id) DO UPDATE SET last_joined_at = excluded.last_joined_at`,
		roomID, userID, at.Unix(), at.Unix())
	return err
}

func (s *SQLite) VisitedRooms(ctx context.Context, userID int64, limit int) ([]VisitedRoom, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT r.id, r.code, r.owner_id, r.created_at, r.last_active_at, u.username, m.last_joined_at
		FROM room_members m
		JOIN rooms r ON r.id = m.room_id
		JOIN users u ON u.id = r.owner_id
		WHERE m.user_id = ?
		ORDER BY m.last_joined_at DESC, r.id DESC LIMIT ?`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []VisitedRoom
	for rows.Next() {
		var v VisitedRoom
		var created, active, joined int64
		if err := rows.Scan(&v.ID, &v.Code, &v.OwnerID, &created, &active, &v.OwnerName, &joined); err != nil {
			return nil, err
		}
		v.CreatedAt = time.Unix(created, 0)
		v.LastActiveAt = time.Unix(active, 0)
		v.LastJoinedAt = time.Unix(joined, 0)
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *SQLite) ForgetVisit(ctx context.Context, roomID, userID int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM room_members WHERE room_id = ? AND user_id = ?`, roomID, userID)
	return err
}

func (s *SQLite) AddChatMessage(ctx context.Context, m ChatMessage) (ChatMessage, error) {
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO chat_messages (room_id, user_id, text, created_at) VALUES (?, ?, ?, ?)`,
		m.RoomID, m.UserID, m.Text, m.CreatedAt.UnixMilli())
	if err != nil {
		return ChatMessage{}, err
	}
	m.ID, err = res.LastInsertId()
	return m, err
}

func (s *SQLite) RecentChatMessages(ctx context.Context, roomID int64, limit int) ([]ChatMessage, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT m.id, m.room_id, m.user_id, u.username, m.text, m.created_at
		FROM chat_messages m JOIN users u ON u.id = m.user_id
		WHERE m.room_id = ? ORDER BY m.id DESC LIMIT ?`, roomID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ChatMessage
	for rows.Next() {
		var m ChatMessage
		var created int64
		if err := rows.Scan(&m.ID, &m.RoomID, &m.UserID, &m.Username, &m.Text, &created); err != nil {
			return nil, err
		}
		m.CreatedAt = time.UnixMilli(created)
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, nil
}

func (s *SQLite) UpsertLocalMedia(ctx context.Context, title, path string, size int64) (Media, error) {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO media (title, size_bytes, status, path) VALUES (?, ?, 'ready', ?)
		ON CONFLICT (path) DO UPDATE SET
			status = 'ready',
			hls_state = CASE WHEN media.size_bytes = excluded.size_bytes THEN media.hls_state ELSE 'pending' END,
			size_bytes = excluded.size_bytes`,
		title, size, path)
	if err != nil {
		return Media{}, err
	}
	return s.scanMedia(s.db.QueryRowContext(ctx, mediaCols+` WHERE path = ?`, path))
}

func (s *SQLite) MediaByID(ctx context.Context, id int64) (Media, error) {
	return s.scanMedia(s.db.QueryRowContext(ctx, mediaCols+` WHERE id = ?`, id))
}

func (s *SQLite) ReadyMedia(ctx context.Context) ([]Media, error) {
	return s.mediaList(ctx, mediaCols+` WHERE status = 'ready' AND hls_state = 'ready' ORDER BY COALESCE(last_watched_at, 0) DESC, title`)
}

func (s *SQLite) MediaNeedingHLS(ctx context.Context) ([]Media, error) {
	return s.mediaList(ctx, mediaCols+` WHERE source = 'local' AND status = 'ready' AND hls_state IN ('pending', 'remuxing') ORDER BY id`)
}

func (s *SQLite) SetHLSState(ctx context.Context, id int64, state, errMsg string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE media SET hls_state = ?, hls_error = NULLIF(?, '') WHERE id = ?`, state, errMsg, id)
	return err
}

func (s *SQLite) SetProbe(ctx context.Context, id int64, videoCodec, audioCodec string, duration float64) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE media SET video_codec = NULLIF(?, ''), audio_codec = NULLIF(?, ''), duration_seconds = ? WHERE id = ?`,
		videoCodec, audioCodec, duration, id)
	return err
}

func (s *SQLite) mediaList(ctx context.Context, query string) ([]Media, error) {
	rows, err := s.db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Media
	for rows.Next() {
		m, err := s.scanMedia(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *SQLite) TouchMedia(ctx context.Context, id int64, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE media SET last_watched_at = ? WHERE id = ?`, at.Unix(), id)
	return err
}

const mediaCols = `SELECT id, title, size_bytes, status, path, COALESCE(last_watched_at, 0),
	hls_state, COALESCE(hls_error, ''), COALESCE(video_codec, ''), COALESCE(audio_codec, ''), COALESCE(duration_seconds, 0),
	source, COALESCE(catalog_id, ''), COALESCE(info_hash, ''), COALESCE(file_idx, 0), COALESCE(poster, ''), COALESCE(year, ''),
	COALESCE(source_url, '')
	FROM media`

func (s *SQLite) scanMedia(row interface{ Scan(...any) error }) (Media, error) {
	var m Media
	var watched int64
	if err := row.Scan(&m.ID, &m.Title, &m.SizeBytes, &m.Status, &m.Path, &watched,
		&m.HLSState, &m.HLSError, &m.VideoCodec, &m.AudioCodec, &m.Duration,
		&m.Source, &m.CatalogID, &m.InfoHash, &m.FileIdx, &m.Poster, &m.Year, &m.SourceURL); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Media{}, ErrNotFound
		}
		return Media{}, err
	}
	if watched > 0 {
		m.LastWatchedAt = time.Unix(watched, 0)
	}
	return m, nil
}

func (s *SQLite) UpsertTorrentMedia(ctx context.Context, t TorrentMedia) (Media, error) {
	// A unique placeholder path; Library films live in the HLS dir.
	path := fmt.Sprintf("torrent/%s/%d", t.InfoHash, t.FileIdx)
	if t.SourceURL != "" {
		sum := sha256.Sum256([]byte(t.SourceURL))
		path = "url/" + hex.EncodeToString(sum[:12])
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO media (title, size_bytes, status, path, source, catalog_id, info_hash, file_idx, source_url, poster, year)
		VALUES (?, ?, 'downloading', ?, 'torrent', NULLIF(?, ''), NULLIF(?, ''), ?, NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''))
		ON CONFLICT (path) DO NOTHING`,
		t.Title, t.SizeBytes, path, t.CatalogID, t.InfoHash, t.FileIdx, t.SourceURL, t.Poster, t.Year)
	if err != nil {
		return Media{}, err
	}
	return s.scanMedia(s.db.QueryRowContext(ctx, mediaCols+` WHERE path = ?`, path))
}

func (s *SQLite) SetMediaStatus(ctx context.Context, id int64, status string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE media SET status = ? WHERE id = ?`, status, id)
	return err
}

func (s *SQLite) TorrentMediaInProgress(ctx context.Context) ([]Media, error) {
	return s.mediaList(ctx, mediaCols+` WHERE source = 'torrent' AND hls_state IN ('pending', 'remuxing') ORDER BY id`)
}

func (s *SQLite) ReadyTorrentMedia(ctx context.Context) ([]Media, error) {
	return s.mediaList(ctx, mediaCols+` WHERE source = 'torrent' AND status = 'ready' AND hls_state = 'ready'
		ORDER BY COALESCE(last_watched_at, 0), id`)
}

func (s *SQLite) DeleteMedia(ctx context.Context, id int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM media WHERE id = ?`, id)
	return err
}
