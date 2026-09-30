// Package media owns the films on disk: registering what's in the media directory,
// preparing HLS for the ones browsers can play, and serving the playlists and segments.
// The torrent cache (step 5) lands here too.
package media

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"anda/internal/httpx"
	"anda/internal/protocol"
	"anda/internal/store"
	"anda/internal/torrent"
)

// Containers worth probing. Whether the streams inside are playable is ffprobe's call.
var containers = map[string]bool{".mp4": true, ".m4v": true, ".mkv": true, ".mov": true, ".webm": true}

// hlsFile is every name a prepared film's directory can hold.
var hlsFile = regexp.MustCompile(`^(index\.m3u8|init\.mp4|seg_\d{5}\.m4s)$`)

const rescanEvery = 5 * time.Minute

type Service struct {
	Dir          string // source files
	HLSDir       string // prepared playlists and segments, one directory per film
	Store        store.MediaStore
	Authenticate func(*http.Request) (store.User, error)
	Log          *slog.Logger

	// Torrent is Stremio's streaming server; nil disables Library downloads.
	Torrent *torrent.Client
	// CacheBytes caps finished torrent films on disk; least recently watched go first.
	CacheBytes int64
	// InUse reports films a live room is showing (never evicted).
	InUse func() map[int64]bool

	ctx   context.Context
	queue chan store.Media
	tj    torrentJobs
}

// Run scans the media directory now and every few minutes, and prepares new films one at
// a time until ctx ends.
func (s *Service) Run(ctx context.Context) {
	s.ctx = ctx
	s.queue = make(chan store.Media, 64)
	go s.worker(ctx)
	s.verifyReady(ctx)
	s.resumeTorrents(ctx)
	t := time.NewTicker(rescanEvery)
	defer t.Stop()
	for {
		if err := s.scan(ctx); err != nil {
			s.Log.Error("media scan", "err", err)
		}
		s.enqueuePending(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (s *Service) worker(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case m := <-s.queue:
			s.prepare(ctx, m)
		}
	}
}

func (s *Service) enqueuePending(ctx context.Context) {
	list, err := s.Store.MediaNeedingHLS(ctx)
	if err != nil {
		s.Log.Error("list pending media", "err", err)
		return
	}
	for _, m := range list {
		select {
		case s.queue <- m:
		default:
			return // queue full; the next rescan picks the rest up
		}
	}
}

// scan registers every candidate file under Dir. Titles come from file names:
// "Big Buck Bunny.m4v" becomes "Big Buck Bunny".
func (s *Service) scan(ctx context.Context) error {
	if err := os.MkdirAll(s.Dir, 0o755); err != nil {
		return err
	}
	n := 0
	err := filepath.WalkDir(s.Dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !containers[strings.ToLower(filepath.Ext(path))] {
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
	s.Log.Debug("media scan", "dir", s.Dir, "files", n)
	return err
}

func (s *Service) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/library/ready", s.handleReady)
	mux.HandleFunc("GET /media/{id}/{file}", s.handleHLS)
	mux.HandleFunc("GET /api/media/{id}/progress", s.handleProgress)
}

// Info returns the protocol description of a playable film, for set_media and room_state.
func (s *Service) Info(ctx context.Context, id int64) (protocol.Media, error) {
	m, err := s.Store.MediaByID(ctx, id)
	if err != nil {
		return protocol.Media{}, err
	}
	if m.Status == "ready" && m.HLSState == store.HLSReady {
		return toProto(m), nil
	}
	// A torrent film still being prepared can go on the room's screen right away: players
	// poll its progress and start once enough of it exists.
	if m.Source == "torrent" && (m.HLSState == store.HLSPending || m.HLSState == store.HLSRemuxing) {
		return toProto(m), nil
	}
	return protocol.Media{}, store.ErrNotFound
}

func (s *Service) handleProgress(w http.ResponseWriter, r *http.Request) {
	if _, err := s.Authenticate(r); err != nil {
		httpx.Error(w, http.StatusUnauthorized, "not_signed_in", "Not signed in.")
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such film.")
		return
	}
	p, err := s.Progress(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such film.")
		return
	}
	if err != nil {
		s.Log.Error("media progress", "err", err)
		httpx.Error(w, http.StatusInternalServerError, "internal", "Something went wrong.")
		return
	}
	httpx.JSON(w, http.StatusOK, p)
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

// handleHLS serves a prepared film's playlist, init segment and media segments. The
// directory only exists once a remux finished, so its presence means "ready".
func (s *Service) handleHLS(w http.ResponseWriter, r *http.Request) {
	if _, err := s.Authenticate(r); err != nil {
		http.Error(w, "not signed in", http.StatusUnauthorized)
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	name := r.PathValue("file")
	if err != nil || !hlsFile.MatchString(name) {
		http.NotFound(w, r)
		return
	}
	// os.Root keeps the lookup inside this film's directory.
	root, err := os.OpenRoot(s.hlsDir(id))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer root.Close()
	f, err := root.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	switch {
	case strings.HasSuffix(name, ".m3u8"):
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Header().Set("Cache-Control", "private, no-cache")
	case strings.HasSuffix(name, ".m4s"):
		w.Header().Set("Content-Type", "video/iso.segment")
		w.Header().Set("Cache-Control", "private, max-age=86400")
	default:
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Cache-Control", "private, max-age=86400")
	}
	http.ServeContent(w, r, "", info.ModTime(), f)
}

func toProto(m store.Media) protocol.Media {
	state := "ready"
	if m.HLSState != store.HLSReady {
		state = "preparing"
	}
	return protocol.Media{
		ID:        m.ID,
		Title:     m.Title,
		URL:       "/media/" + strconv.FormatInt(m.ID, 10) + "/index.m3u8",
		Duration:  m.Duration,
		Poster:    m.Poster,
		Year:      m.Year,
		CatalogID: m.CatalogID,
		State:     state,
	}
}

// verifyReady checks that every film marked ready still has its HLS files. If they're gone
// (the HLS directory was cleared, or a volume was swapped), a local film is prepared again,
// and a Library film is marked failed so picking it again downloads it afresh; otherwise
// it would sit on the shelf and never play.
func (s *Service) verifyReady(ctx context.Context) {
	list, err := s.Store.ReadyMedia(ctx)
	if err != nil {
		s.Log.Error("list ready films", "err", err)
		return
	}
	for _, m := range list {
		if _, err := os.Stat(filepath.Join(s.hlsDir(m.ID), "index.m3u8")); err == nil {
			continue
		}
		state, msg := store.HLSPending, ""
		if m.Source == "torrent" {
			state, msg = store.HLSFailed, "prepared files are missing; pick it again"
		}
		s.Log.Warn("prepared film has no files", "media", m.ID, "title", m.Title, "now", state)
		if err := s.Store.SetHLSState(ctx, m.ID, state, msg); err != nil {
			s.Log.Error("set hls state", "err", err)
		}
	}
}
