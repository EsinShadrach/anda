package media

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"anda/internal/store"
	"anda/internal/torrent"
)

// Torrent films are prepared while they download: ffmpeg reads the file from Stremio's
// server (reading is what drives the download, in order) and writes an HLS "event"
// playlist that grows as it goes, so the room can start watching after the first
// segments. When the whole file is through, the playlist is closed and the film joins
// the ready shelf; the HLS copy is the cache from then on.

const maxConcurrentTorrents = 2 // plan: one or two films streaming at once on this VM

// torrentJobs tracks preparations in flight, and what the UI shows about them.
type torrentJobs struct {
	mu       sync.Mutex
	running  map[int64]*jobProgress
	slots    chan struct{}
	initOnce sync.Once
}

type jobProgress struct {
	preparedSeconds float64
	started         time.Time
	cancel          context.CancelFunc // stops the download and remux
}

func (s *Service) jobs() *torrentJobs {
	s.tj.initOnce.Do(func() {
		s.tj.running = make(map[int64]*jobProgress)
		s.tj.slots = make(chan struct{}, maxConcurrentTorrents)
	})
	return &s.tj
}

var ErrIncompatible = errors.New("media: this release can't play in browsers")

// PrepareTorrent registers a Library pick and starts preparing it if needed. It returns
// right away; the film is playable once its playlist has a few segments (see Progress).
func (s *Service) PrepareTorrent(ctx context.Context, t store.TorrentMedia, sources []string) (store.Media, error) {
	switch {
	case t.SourceURL != "":
		// A direct link: no torrent engine needed. The Library has already checked it.
		if u, err := url.Parse(t.SourceURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") {
			return store.Media{}, fmt.Errorf("media: bad source url")
		}
	case s.Torrent == nil:
		return store.Media{}, errors.New("media: no torrent engine configured")
	case !torrent.ValidInfoHash(t.InfoHash):
		return store.Media{}, fmt.Errorf("media: bad info hash")
	}
	m, err := s.Store.UpsertTorrentMedia(ctx, t)
	if err != nil {
		return store.Media{}, err
	}
	switch m.HLSState {
	case store.HLSReady:
		return m, nil
	case store.HLSIncompatible:
		return m, ErrIncompatible
	case store.HLSFailed:
		if err := s.Store.SetHLSState(ctx, m.ID, store.HLSPending, ""); err != nil {
			return m, err
		}
		m.HLSState = store.HLSPending
	}
	s.startTorrent(m, sources)
	return m, nil
}

func (s *Service) startTorrent(m store.Media, sources []string) {
	j := s.jobs()
	j.mu.Lock()
	if _, ok := j.running[m.ID]; ok {
		j.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(s.ctx)
	j.running[m.ID] = &jobProgress{started: time.Now(), cancel: cancel}
	j.mu.Unlock()

	go func() {
		defer func() {
			cancel()
			j.mu.Lock()
			delete(j.running, m.ID)
			j.mu.Unlock()
		}()
		select {
		case j.slots <- struct{}{}:
		case <-ctx.Done():
			s.stopped(m)
			return
		}
		defer func() { <-j.slots }()
		s.prepareTorrent(ctx, m, sources)
	}()
}

// Release is called when no room shows a film any more. If it's still downloading, the
// download stops (plan: an empty room cleans up its torrent); picking it again restarts it.
func (s *Service) Release(ctx context.Context, id int64) {
	if s.InUse != nil && s.InUse()[id] {
		return // another room is watching it
	}
	j := s.jobs()
	j.mu.Lock()
	jp, ok := j.running[id]
	j.mu.Unlock()
	if ok {
		s.Log.Info("stopping download nobody is watching", "media", id)
		jp.cancel()
	}
}

// stopped records a preparation cancelled before it finished.
func (s *Service) stopped(m store.Media) {
	if err := s.Store.SetHLSState(s.ctx, m.ID, store.HLSFailed, "stopped: no room was watching"); err != nil {
		s.Log.Error("set hls state", "err", err)
	}
}

func (s *Service) prepareTorrent(ctx context.Context, m store.Media, sources []string) {
	log := s.Log.With("media", m.ID, "title", m.Title, "hash", m.InfoHash)
	fail := func(state string, err error) {
		os.RemoveAll(s.hlsDir(m.ID))
		if ctx.Err() != nil { // cancelled by Release, not a real failure
			log.Info("torrent preparation stopped")
			s.stopped(m)
		} else {
			log.Warn("torrent not prepared", "state", state, "reason", err)
			if err := s.Store.SetHLSState(s.ctx, m.ID, state, err.Error()); err != nil {
				log.Error("set hls state", "err", err)
			}
		}
		s.removeTorrent(m)
	}

	if err := s.Store.SetHLSState(ctx, m.ID, store.HLSRemuxing, ""); err != nil {
		log.Error("set hls state", "err", err)
		return
	}
	s.evict(ctx, m.SizeBytes, m.ID) // make room first
	src := m.SourceURL
	if src == "" {
		if s.Torrent == nil {
			fail(store.HLSFailed, errors.New("no torrent engine configured"))
			return
		}
		if err := s.Torrent.Create(ctx, m.InfoHash, sources); err != nil {
			fail(store.HLSFailed, err)
			return
		}
		src = s.Torrent.StreamURL(m.InfoHash, m.FileIdx)
	}

	// Probing needs the file's header (and for MP4 its index); Stremio fetches those pieces first.
	pctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	p, err := runProbe(pctx, src)
	cancel()
	if err != nil {
		fail(store.HLSFailed, fmt.Errorf("couldn't read the file from its source: %w", err))
		return
	}
	if err := s.Store.SetProbe(ctx, m.ID, p.VideoCodec, p.AudioCodec, p.Duration); err != nil {
		log.Error("save probe", "err", err)
	}
	if ok, why := compatible(p); !ok {
		fail(store.HLSIncompatible, errors.New(why))
		return
	}

	dir := s.hlsDir(m.ID)
	os.RemoveAll(dir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fail(store.HLSFailed, err)
		return
	}
	start := time.Now()
	if err := writeTracks(dir, p); err != nil {
		fail(store.HLSFailed, err)
		return
	}
	if err := s.remuxLive(ctx, m.ID, src, dir, p); err != nil {
		fail(store.HLSFailed, err)
		return
	}
	// File first, then HLS: readers treat hls_state=ready as "done", so it goes last.
	if err := s.Store.SetMediaStatus(ctx, m.ID, "ready"); err != nil {
		log.Error("set status", "err", err)
	}
	if err := s.Store.SetHLSState(ctx, m.ID, store.HLSReady, ""); err != nil {
		log.Error("set hls state", "err", err)
	}
	s.removeTorrent(m)
	log.Info("library film ready", "took", time.Since(start).Round(time.Second), "duration", p.Duration)
	s.evict(ctx, 0, m.ID) // never the film that just arrived
}

// remuxLive runs ffmpeg from the torrent stream into an event playlist, recording how
// much of the film is prepared from its -progress output.
func (s *Service) remuxLive(ctx context.Context, id int64, url, dir string, p probe) error {
	args := []string{
		"-hide_banner", "-loglevel", "error", "-nostdin", "-nostats",
		// A torrent can stall for a while between pieces; keep waiting rather than give up.
		"-rw_timeout", "180000000", // µs
		"-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_on_network_error", "1", "-reconnect_delay_max", "30",
		"-protocol_whitelist", netProtocols,
		"-progress", "pipe:1",
		"-i", url,
	}
	// "event": the playlists grow while downloading; ENDLIST is appended when done.
	args = append(args, outputArgs(p, "event")...)
	name := "ffmpeg"
	if nice, err := exec.LookPath("nice"); err == nil {
		name, args = nice, append([]string{"-n", "10", "ffmpeg"}, args...)
	}
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	var stderr strings.Builder
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	sc := bufio.NewScanner(stdout)
	for sc.Scan() {
		if v, ok := strings.CutPrefix(sc.Text(), "out_time_us="); ok {
			if us, err := strconv.ParseInt(v, 10, 64); err == nil && us > 0 {
				s.setPrepared(id, float64(us)/1e6)
			}
		}
	}
	if err := cmd.Wait(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return fmt.Errorf("ffmpeg: %w: %s", err, msg)
	}
	return nil
}

func (s *Service) setPrepared(id int64, sec float64) {
	j := s.jobs()
	j.mu.Lock()
	defer j.mu.Unlock()
	if p, ok := j.running[id]; ok {
		p.preparedSeconds = sec
	}
}

// removeTorrent drops a torrent from the engine once its film is prepared or abandoned.
func (s *Service) removeTorrent(m store.Media) {
	if m.InfoHash == "" || s.Torrent == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s.Torrent.Remove(ctx, m.InfoHash)
}

// resumeTorrents restarts preparations a previous run left unfinished.
func (s *Service) resumeTorrents(ctx context.Context) {
	list, err := s.Store.TorrentMediaInProgress(ctx)
	if err != nil {
		s.Log.Error("list unfinished torrents", "err", err)
		return
	}
	for _, m := range list {
		if m.SourceURL == "" && s.Torrent == nil {
			continue
		}
		s.startTorrent(m, nil)
	}
}

// Progress is what the room shows while a torrent film is being prepared.
type Progress struct {
	State           string  `json:"state"` // preparing | ready | incompatible | failed
	Error           string  `json:"error,omitempty"`
	PreparedSeconds float64 `json:"prepared_seconds"`
	Duration        float64 `json:"duration"`
	Downloaded      int64   `json:"downloaded"`
	SizeBytes       int64   `json:"size_bytes"`
	Speed           float64 `json:"speed"` // bytes/s
	Peers           int     `json:"peers"`
	Direct          bool    `json:"direct,omitempty"` // a direct link: no peers or byte counts
}

func (s *Service) Progress(ctx context.Context, id int64) (Progress, error) {
	m, err := s.Store.MediaByID(ctx, id)
	if err != nil {
		return Progress{}, err
	}
	p := Progress{Duration: m.Duration, SizeBytes: m.SizeBytes, Direct: m.SourceURL != ""}
	switch m.HLSState {
	case store.HLSReady:
		p.State, p.PreparedSeconds, p.Downloaded = "ready", m.Duration, m.SizeBytes
		return p, nil
	case store.HLSIncompatible, store.HLSFailed:
		p.State, p.Error = m.HLSState, m.HLSError
		return p, nil
	}
	p.State = "preparing"
	j := s.jobs()
	j.mu.Lock()
	if jp, ok := j.running[id]; ok {
		p.PreparedSeconds = jp.preparedSeconds
	}
	j.mu.Unlock()
	if s.Torrent != nil && m.Source == "torrent" && m.InfoHash != "" {
		sctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		if st, err := s.Torrent.Stats(sctx, m.InfoHash, m.FileIdx); err == nil {
			p.Downloaded, p.Speed, p.Peers = st.Downloaded, st.DownloadSpeed, st.Peers
			if st.StreamLen > 0 {
				p.SizeBytes = st.StreamLen
				p.Downloaded = int64(st.StreamProgress * float64(st.StreamLen))
			}
		}
	}
	return p, nil
}

// evict deletes the least recently watched finished torrent films until the torrent cache
// (plus `incoming` bytes about to arrive) fits under CacheBytes. Films a room is showing,
// and `keep` (the film being prepared), are never evicted.
func (s *Service) evict(ctx context.Context, incoming, keep int64) {
	if s.CacheBytes <= 0 {
		return
	}
	list, err := s.Store.ReadyTorrentMedia(ctx)
	if err != nil {
		s.Log.Error("list cache", "err", err)
		return
	}
	sizes := make(map[int64]int64, len(list))
	total := incoming
	for _, m := range list {
		sizes[m.ID] = dirSize(s.hlsDir(m.ID))
		total += sizes[m.ID]
	}
	var inUse map[int64]bool
	if s.InUse != nil {
		inUse = s.InUse()
	}
	for _, m := range list { // least recently watched first
		if total <= s.CacheBytes {
			return
		}
		if inUse[m.ID] || m.ID == keep {
			continue
		}
		if err := os.RemoveAll(s.hlsDir(m.ID)); err != nil {
			s.Log.Error("evict", "media", m.ID, "err", err)
			continue
		}
		if err := s.Store.DeleteMedia(ctx, m.ID); err != nil {
			s.Log.Error("evict row", "media", m.ID, "err", err)
		}
		total -= sizes[m.ID]
		s.Log.Info("evicted", "media", m.ID, "title", m.Title, "freed_mb", sizes[m.ID]>>20)
	}
}

func dirSize(dir string) int64 {
	var n int64
	filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if info, err := d.Info(); err == nil {
				n += info.Size()
			}
		}
		return nil
	})
	return n
}
