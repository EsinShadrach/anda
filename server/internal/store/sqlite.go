package store

import (
	"context"
	"database/sql"
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
