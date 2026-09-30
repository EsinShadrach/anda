package library

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"anda/internal/httpx"
	"anda/internal/media"
	"anda/internal/protocol"
	"anda/internal/store"
)

const (
	cacheTTL     = 30 * time.Minute
	cacheEntries = 256
)

// Preparer starts preparing a picked torrent (media.Service in production).
type Preparer interface {
	PrepareTorrent(ctx context.Context, t store.TorrentMedia, sources []string) (store.Media, error)
	Info(ctx context.Context, id int64) (protocol.Media, error)
}

type Service struct {
	Catalog      string   // catalog addon base URL, e.g. https://v3-cinemeta.strem.io
	StreamAddons []string // stream addon base URLs; the built-in open films are always included
	Media        Preparer
	Authenticate func(*http.Request) (store.User, error)
	Log          *slog.Logger

	addons *addonClient

	mu      sync.Mutex
	metas   map[string]cached[Meta]
	streams map[string]cached[streamSet] // by catalog ID: the full list, hidden ones included
	names   map[string]string            // addon base → display name
}

type cached[T any] struct {
	v  T
	at time.Time
}

func (s *Service) init() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.addons == nil {
		s.addons = newAddonClient()
		s.metas = map[string]cached[Meta]{}
		s.streams = map[string]cached[streamSet]{}
		s.names = map[string]string{}
	}
}

func (s *Service) Register(mux *http.ServeMux) {
	s.init()
	mux.HandleFunc("GET /api/library/search", s.handleSearch)
	mux.HandleFunc("GET /api/library/{id}/streams", s.handleStreams)
	mux.HandleFunc("POST /api/library/{id}/streams/{key}/prepare", s.handlePrepare)
}

// Film is a search result.
type Film struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Year   string `json:"year,omitempty"`
	Poster string `json:"poster,omitempty"`
	Free   bool   `json:"free,omitempty"` // one of the built-in open films
}

func (s *Service) handleSearch(w http.ResponseWriter, r *http.Request) {
	if !s.authed(w, r) {
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) > 100 {
		q = q[:100]
	}
	var out []Film
	seen := map[string]bool{}
	add := func(f Film) {
		if f.ID != "" && !seen[f.ID] {
			seen[f.ID] = true
			out = append(out, f)
		}
	}
	// Open films first when they match (and as suggestions for an empty search). Their
	// posters come from the catalog, fetched in parallel (cached after the first time).
	open := searchOpen(q)
	posters := make([]string, len(open))
	var wg sync.WaitGroup
	for i, f := range open {
		wg.Add(1)
		go func() {
			defer wg.Done()
			m, _ := s.meta(r.Context(), f.IMDb)
			posters[i] = m.Poster
		}()
	}
	wg.Wait()
	for i, f := range open {
		add(Film{ID: f.IMDb, Name: f.Name, Year: f.Year, Poster: posters[i], Free: true})
	}
	if q != "" && s.Catalog != "" {
		metas, err := s.addons.search(r.Context(), s.Catalog, q)
		if err != nil {
			s.Log.Warn("catalog search", "q", q, "err", err)
			if len(out) == 0 {
				httpx.Error(w, http.StatusBadGateway, "catalog_unavailable", "Search is unavailable right now.")
				return
			}
		}
		for _, m := range metas {
			if len(out) >= 30 {
				break
			}
			if m.Type != "" && m.Type != "movie" {
				continue
			}
			add(Film{ID: m.ID, Name: m.Name, Year: m.year(), Poster: m.Poster, Free: isOpenFilm(m.ID)})
		}
	}
	if out == nil {
		out = []Film{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"films": out})
}

type metaJSON struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Year        string   `json:"year,omitempty"`
	Poster      string   `json:"poster,omitempty"`
	Background  string   `json:"background,omitempty"`
	Description string   `json:"description,omitempty"`
	Runtime     string   `json:"runtime,omitempty"`
	Genres      []string `json:"genres,omitempty"`
}

func (s *Service) handleStreams(w http.ResponseWriter, r *http.Request) {
	if !s.authed(w, r) {
		return
	}
	id := r.PathValue("id")
	if !validID(id) {
		httpx.Error(w, http.StatusNotFound, "not_found", "No such film.")
		return
	}
	m, _ := s.meta(r.Context(), id)
	if m.Name == "" {
		for _, f := range openFilms {
			if f.IMDb == id {
				m.Name, m.ReleaseInfo = f.Name, f.Year
			}
		}
	}
	set := s.streamList(r.Context(), id)
	shown := []Stream{}
	hidden := map[string]int{}
	for _, st := range set.streams {
		if st.hidden != "" {
			hidden[st.hidden]++
			continue
		}
		shown = append(shown, st)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"meta": metaJSON{
			ID: id, Name: m.Name, Year: m.year(), Poster: m.Poster, Background: m.Background,
			Description: m.Description, Runtime: m.Runtime, Genres: m.Genres,
		},
		"streams": shown,
		"hidden":  hidden,                            // reason → count: video | audio | size | not a torrent
		"failed":  append([]string{}, set.failed...), // sources that didn't answer
	})
}

func (s *Service) handlePrepare(w http.ResponseWriter, r *http.Request) {
	if !s.authed(w, r) {
		return
	}
	id, key := r.PathValue("id"), r.PathValue("key")
	// Only streams we listed ourselves: a client can't make the server fetch an arbitrary torrent.
	var pick *Stream
	for _, st := range s.streamList(r.Context(), id).streams {
		if st.Key == key && st.hidden == "" {
			pick = &st
			break
		}
	}
	if pick == nil {
		httpx.Error(w, http.StatusNotFound, "stream_not_found", "That stream isn't available any more. Pick another.")
		return
	}
	m, _ := s.meta(r.Context(), id)
	title := m.Name
	if title == "" {
		title = pick.Release
	}
	film, err := s.Media.PrepareTorrent(r.Context(), store.TorrentMedia{
		Title: title, CatalogID: id, InfoHash: pick.infoHash, FileIdx: pick.fileIdx,
		SizeBytes: pick.SizeBytes, Poster: m.Poster, Year: m.year(),
	}, pick.sources)
	if errors.Is(err, media.ErrIncompatible) {
		httpx.Error(w, http.StatusUnprocessableEntity, "incompatible", "That release can't play in browsers. Pick another.")
		return
	}
	if err != nil {
		s.Log.Error("prepare torrent", "id", id, "err", err)
		httpx.Error(w, http.StatusInternalServerError, "internal", "Couldn't start that stream.")
		return
	}
	httpx.JSON(w, http.StatusAccepted, map[string]any{"film": map[string]any{
		"id": film.ID, "title": film.Title, "state": stateOf(film),
	}})
}

func stateOf(m store.Media) string {
	if m.HLSState == store.HLSReady {
		return "ready"
	}
	return "preparing"
}

// streamList returns every stream for a film from the built-in source and each stream
// addon (queried in parallel), classified and sorted. The full list is kept, as the plan
// asks, so another source can be picked later.
// streamSet is every stream found for a film, plus the sources that failed to answer.
type streamSet struct {
	streams []Stream
	failed  []string // addon names
}

func (s *Service) streamList(ctx context.Context, id string) streamSet {
	s.mu.Lock()
	if c, ok := s.streams[id]; ok && time.Since(c.at) < cacheTTL {
		s.mu.Unlock()
		return c.v
	}
	s.mu.Unlock()
	var failed []string

	var list []Stream
	for _, a := range openStreams(id) {
		list = append(list, classify(a, openSourceName))
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	for _, base := range s.StreamAddons {
		wg.Add(1)
		go func() {
			defer wg.Done()
			actx, cancel := context.WithTimeout(ctx, 12*time.Second)
			defer cancel()
			found, err := s.addons.streams(actx, base, id)
			name := s.addonName(actx, base)
			if err != nil {
				s.Log.Warn("stream addon", "addon", base, "id", id, "err", err)
				mu.Lock()
				failed = append(failed, name)
				mu.Unlock()
				return
			}
			mu.Lock()
			for _, a := range found {
				list = append(list, classify(a, name))
			}
			mu.Unlock()
		}()
	}
	wg.Wait()
	sortStreams(list)
	set := streamSet{streams: list, failed: failed}
	if len(failed) > 0 {
		return set // don't cache a partial answer; the next look retries the failed source
	}

	s.mu.Lock()
	if len(s.streams) >= cacheEntries {
		clear(s.streams)
	}
	s.streams[id] = cached[streamSet]{set, time.Now()}
	s.mu.Unlock()
	return set
}

func (s *Service) meta(ctx context.Context, id string) (Meta, error) {
	s.mu.Lock()
	if c, ok := s.metas[id]; ok && time.Since(c.at) < cacheTTL {
		s.mu.Unlock()
		return c.v, nil
	}
	s.mu.Unlock()
	if s.Catalog == "" {
		return Meta{}, nil
	}
	mctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	m, err := s.addons.meta(mctx, s.Catalog, id)
	if err != nil {
		s.Log.Warn("catalog meta", "id", id, "err", err)
		return Meta{}, err
	}
	s.mu.Lock()
	if len(s.metas) >= cacheEntries {
		clear(s.metas)
	}
	s.metas[id] = cached[Meta]{m, time.Now()}
	s.mu.Unlock()
	return m, nil
}

func (s *Service) addonName(ctx context.Context, base string) string {
	s.mu.Lock()
	name, ok := s.names[base]
	s.mu.Unlock()
	if ok {
		return name
	}
	name = s.addons.addonName(ctx, base)
	s.mu.Lock()
	s.names[base] = name
	s.mu.Unlock()
	return name
}

func (s *Service) authed(w http.ResponseWriter, r *http.Request) bool {
	if _, err := s.Authenticate(r); err != nil {
		httpx.Error(w, http.StatusUnauthorized, "not_signed_in", "Not signed in.")
		return false
	}
	return true
}

// validID accepts catalog IDs like tt1234567 (and other short, URL-safe addon IDs).
func validID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == ':' || c == '_' || c == '-' || c == '.') {
			return false
		}
	}
	return true
}
