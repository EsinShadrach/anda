package media

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"anda/internal/store"
	"anda/internal/torrent"
)

// fakeStremio serves files by "info hash" like Stremio's server does.
func fakeStremio(t *testing.T, files map[string]string) (*httptest.Server, *atomic.Int32) {
	var removed atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		switch {
		case len(parts) == 2 && parts[1] == "create":
			w.Write([]byte(`{}`))
		case len(parts) == 2 && parts[1] == "remove":
			removed.Add(1)
			w.Write([]byte(`{}`))
		case len(parts) == 3 && parts[2] == "stats.json":
			w.Write([]byte(`{"peers":7,"downloadSpeed":1000000,"streamLen":1000,"streamProgress":0.5}`))
		case len(parts) == 2:
			path, ok := files[parts[0]]
			if !ok {
				http.NotFound(w, r)
				return
			}
			http.ServeFile(w, r, path) // Range support, like the real thing
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &removed
}

func TestTorrentPrepareAndEvict(t *testing.T) {
	for _, bin := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skip(bin + " not installed")
		}
	}
	dir := t.TempDir()
	clip := func(name, vcodec string) string {
		p := filepath.Join(dir, name)
		out, err := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error",
			"-f", "lavfi", "-i", "testsrc=size=160x90:rate=24:duration=14",
			"-f", "lavfi", "-i", "sine=frequency=440:duration=14",
			"-c:v", vcodec, "-g", "48", "-c:a", "aac", "-pix_fmt", "yuv420p", "-shortest", p).CombinedOutput()
		if err != nil {
			t.Fatalf("make %s: %v %s", name, err, out)
		}
		return p
	}
	good := strings.Repeat("a", 40)
	good2 := strings.Repeat("b", 40)
	bad := strings.Repeat("c", 40)
	srv, removed := fakeStremio(t, map[string]string{
		good:  clip("good.mp4", "libx264"),
		good2: clip("good2.mp4", "libx264"),
		bad:   clip("bad.mp4", "mpeg4"),
	})

	db, err := store.OpenSQLite(context.Background(), filepath.Join(dir, "anda.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var inUse atomic.Pointer[map[int64]bool] // read by the pipeline goroutine
	setInUse := func(m map[int64]bool) { inUse.Store(&m) }
	setInUse(nil)
	s := &Service{
		Dir: filepath.Join(dir, "media"), HLSDir: filepath.Join(dir, "hls"), Store: db,
		Log:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		Torrent: torrent.New(srv.URL),
		InUse:   func() map[int64]bool { return *inUse.Load() },
		ctx:     ctx,
	}

	waitState := func(id int64, want string) store.Media {
		t.Helper()
		deadline := time.Now().Add(30 * time.Second)
		for time.Now().Before(deadline) {
			m, _ := db.MediaByID(ctx, id)
			if m.HLSState == want {
				return m
			}
			time.Sleep(50 * time.Millisecond)
		}
		m, _ := db.MediaByID(ctx, id)
		t.Fatalf("media %d: state %q (%s), want %q", id, m.HLSState, m.HLSError, want)
		return m
	}

	m, err := s.PrepareTorrent(ctx, store.TorrentMedia{Title: "Good", CatalogID: "tt1", InfoHash: good, SizeBytes: 1000}, nil)
	if err != nil {
		t.Fatal(err)
	}
	ready := waitState(m.ID, store.HLSReady)
	if ready.Status != "ready" || ready.Source != "torrent" || ready.VideoCodec != "h264" || ready.Duration < 13 {
		t.Fatalf("ready film: %+v", ready)
	}
	playlist, _ := os.ReadFile(filepath.Join(s.hlsDir(m.ID), "stream_v.m3u8"))
	if !strings.Contains(string(playlist), "#EXT-X-PLAYLIST-TYPE:EVENT") || !strings.Contains(string(playlist), "#EXT-X-ENDLIST") {
		t.Fatalf("finished event playlist should be closed:\n%s", playlist)
	}
	if info, err := s.Info(ctx, m.ID); err != nil || info.State != "ready" {
		t.Fatalf("info: %+v %v", info, err)
	}
	if p, _ := s.Progress(ctx, m.ID); p.State != "ready" || p.PreparedSeconds < 13 {
		t.Fatalf("progress: %+v", p)
	}
	if removed.Load() == 0 {
		t.Fatal("engine should be removed once the film is ready")
	}
	shelf, _ := db.ReadyMedia(ctx)
	if len(shelf) != 1 || shelf[0].ID != m.ID {
		t.Fatalf("ready shelf: %+v", shelf)
	}

	// Picking it again is instant: it's cached.
	again, err := s.PrepareTorrent(ctx, store.TorrentMedia{Title: "Good", InfoHash: good}, nil)
	if err != nil || again.ID != m.ID || again.HLSState != store.HLSReady {
		t.Fatalf("second pick: %+v %v", again, err)
	}

	// A release browsers can't play is caught by ffprobe and never gets a playlist.
	b, _ := s.PrepareTorrent(ctx, store.TorrentMedia{Title: "Bad", InfoHash: bad}, nil)
	if got := waitState(b.ID, store.HLSIncompatible); !strings.Contains(got.HLSError, "H.264") {
		t.Fatalf("incompatible reason: %q", got.HLSError)
	}
	if _, err := os.Stat(s.hlsDir(b.ID)); !os.IsNotExist(err) {
		t.Fatal("incompatible film left files behind")
	}

	// Eviction: with the cache capped below two films, preparing the second evicts the
	// least recently watched first, unless a room is showing it.
	s.CacheBytes = dirSize(s.hlsDir(m.ID)) + 1
	setInUse(map[int64]bool{m.ID: true})
	m2, _ := s.PrepareTorrent(ctx, store.TorrentMedia{Title: "Good 2", InfoHash: good2, SizeBytes: 10}, nil)
	waitState(m2.ID, store.HLSReady)
	if _, err := db.MediaByID(ctx, m.ID); err != nil {
		t.Fatal("a film in use must not be evicted")
	}
	setInUse(nil)
	s.evict(ctx, 0, 0)
	if _, err := db.MediaByID(ctx, m.ID); err == nil {
		t.Fatal("least recently watched film should be evicted once free")
	}
	if _, err := os.Stat(s.hlsDir(m.ID)); !os.IsNotExist(err) {
		t.Fatal("evicted film's files should be gone")
	}
	if _, err := db.MediaByID(ctx, m2.ID); err != nil {
		t.Fatal("the newer film should stay")
	}
}

func TestDirectLinkPrepare(t *testing.T) {
	for _, bin := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skip(bin + " not installed")
		}
	}
	dir := t.TempDir()
	clip := filepath.Join(dir, "film.mp4")
	if out, err := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "testsrc=size=160x90:rate=24:duration=8",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=8",
		"-c:v", "libx264", "-g", "48", "-c:a", "ac3", "-pix_fmt", "yuv420p", "-shortest", clip).CombinedOutput(); err != nil {
		t.Fatalf("make clip: %v %s", err, out)
	}
	// A plain web server, like a CDN behind an addon's direct link (range requests and all).
	web := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, clip)
	}))
	defer web.Close()

	db, err := store.OpenSQLite(context.Background(), filepath.Join(dir, "anda.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := &Service{ // no torrent engine at all
		Dir: filepath.Join(dir, "media"), HLSDir: filepath.Join(dir, "hls"), Store: db,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		ctx: ctx,
	}

	if _, err := s.PrepareTorrent(ctx, store.TorrentMedia{Title: "Nope", SourceURL: "file://" + clip}, nil); err == nil {
		t.Fatal("a file:// source must be refused")
	}
	m, err := s.PrepareTorrent(ctx, store.TorrentMedia{Title: "Linked", CatalogID: "tt2", SourceURL: web.URL + "/film.mp4"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if p, _ := s.Progress(ctx, m.ID); !p.Direct {
		t.Fatalf("progress should say direct: %+v", p)
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		got, _ := db.MediaByID(ctx, m.ID)
		if got.HLSState == store.HLSReady {
			if got.SourceURL == "" || got.InfoHash != "" || got.Duration < 7 || got.AudioCodec != "ac3" {
				t.Fatalf("ready: %+v", got)
			}
			break
		}
		if got.HLSState == store.HLSFailed || time.Now().After(deadline) {
			t.Fatalf("state %q: %s", got.HLSState, got.HLSError)
		}
		time.Sleep(50 * time.Millisecond)
	}
	// The same link again is the same film, already cached.
	again, err := s.PrepareTorrent(ctx, store.TorrentMedia{Title: "Linked", SourceURL: web.URL + "/film.mp4"}, nil)
	if err != nil || again.ID != m.ID || again.HLSState != store.HLSReady {
		t.Fatalf("second pick: %+v %v", again, err)
	}
	if shelf, _ := db.ReadyTorrentMedia(ctx); len(shelf) != 1 {
		t.Fatalf("direct films share the Library cache: %+v", shelf)
	}

	// Files gone behind the database's back: at startup the film stops claiming to be
	// ready, and picking it again prepares it afresh.
	os.RemoveAll(s.hlsDir(m.ID))
	s.verifyReady(ctx)
	if got, _ := db.MediaByID(ctx, m.ID); got.HLSState != store.HLSFailed {
		t.Fatalf("missing files: state %q", got.HLSState)
	}
	if shelf, _ := db.ReadyMedia(ctx); len(shelf) != 0 {
		t.Fatalf("missing film still on the shelf: %+v", shelf)
	}
	if again, err := s.PrepareTorrent(ctx, store.TorrentMedia{Title: "Linked", SourceURL: web.URL + "/film.mp4"}, nil); err != nil || again.HLSState != store.HLSPending {
		t.Fatalf("pick again after missing files: %+v %v", again, err)
	}
}
