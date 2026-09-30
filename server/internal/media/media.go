// Package media owns the films on disk: registering what's in the media directory and
// streaming it to players. HLS remuxing (step 4) and the torrent cache (step 5) land here.
package media

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"anda/internal/httpx"
	"anda/internal/protocol"
	"anda/internal/store"
)

// Playable containers the browser can stream directly (H.264/AAC in MP4).
var playable = map[string]bool{".mp4": true, ".m4v": true}

type Service struct {
	Dir          string
	Store        store.MediaStore
	Authenticate func(*http.Request) (store.User, error)
	Log          *slog.Logger
}

// Scan registers every playable file under Dir. Titles come from file names:
// "Big Buck Bunny.mp4" becomes "Big Buck Bunny".
func (s *Service) Scan(ctx context.Context) error {
	if err := os.MkdirAll(s.Dir, 0o755); err != nil {
		return err
	}
	n := 0
	err := filepath.WalkDir(s.Dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !playable[strings.ToLower(filepath.Ext(path))] {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(s.Dir, path)
		if err != nil {
			return err
		}
		title := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
		if _, err := s.Store.UpsertLocalMedia(ctx, title, filepath.ToSlash(rel), info.Size()); err != nil {
			return err
		}
		n++
		return nil
	})
	s.Log.Info("media scan", "dir", s.Dir, "files", n)
	return err
}

func (s *Service) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/library/ready", s.handleReady)
	mux.HandleFunc("GET /media/{id}/video", s.handleVideo)
}

// Info returns the protocol description of a ready film, for set_media and room_state.
func (s *Service) Info(ctx context.Context, id int64) (protocol.Media, error) {
	m, err := s.Store.MediaByID(ctx, id)
	if err != nil {
		return protocol.Media{}, err
	}
	if m.Status != "ready" {
		return protocol.Media{}, store.ErrNotFound
	}
	return toProto(m), nil
}

func (s *Service) Touch(ctx context.Context, id int64) {
	if err := s.Store.TouchMedia(ctx, id, time.Now()); err != nil {
		s.Log.Warn("touch media", "id", id, "err", err)
	}
}

type readyJSON struct {
	protocol.Media
	SizeBytes     int64 `json:"size_bytes"`
	LastWatchedAt int64 `json:"last_watched_at,omitempty"` // unix ms
}

func (s *Service) handleReady(w http.ResponseWriter, r *http.Request) {
	if _, err := s.Authenticate(r); err != nil {
		httpx.Error(w, http.StatusUnauthorized, "not_signed_in", "Not signed in.")
		return
	}
	list, err := s.Store.ReadyMedia(r.Context())
	if err != nil {
		s.Log.Error("ready media", "err", err)
		httpx.Error(w, http.StatusInternalServerError, "internal", "Something went wrong.")
		return
	}
	out := make([]readyJSON, 0, len(list))
	for _, m := range list {
		j := readyJSON{Media: toProto(m), SizeBytes: m.SizeBytes}
		if !m.LastWatchedAt.IsZero() {
			j.LastWatchedAt = m.LastWatchedAt.UnixMilli()
		}
		out = append(out, j)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"films": out})
}

// handleVideo streams a film with Range support (http.ServeContent), so players can seek
// without downloading everything before that point.
func (s *Service) handleVideo(w http.ResponseWriter, r *http.Request) {
	if _, err := s.Authenticate(r); err != nil {
		http.Error(w, "not signed in", http.StatusUnauthorized)
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	m, err := s.Store.MediaByID(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) || (err == nil && m.Status != "ready") {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		s.Log.Error("load media", "id", id, "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	// os.Root keeps the stored relative path from escaping the media directory.
	root, err := os.OpenRoot(s.Dir)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	defer root.Close()
	f, err := root.Open(filepath.FromSlash(m.Path))
	if err != nil {
		s.Log.Warn("open media", "id", id, "path", m.Path, "err", err)
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Cache-Control", "private, max-age=86400")
	http.ServeContent(w, r, "", info.ModTime(), f)
}

func toProto(m store.Media) protocol.Media {
	return protocol.Media{ID: m.ID, Title: m.Title, URL: "/media/" + strconv.FormatInt(m.ID, 10) + "/video"}
}
