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
	"strconv"
	"strings"
	"testing"

	"anda/internal/store"
)

func TestCompatible(t *testing.T) {
	cases := []struct {
		p    probe
		want bool
	}{
		{probe{VideoCodec: "h264", Profile: "High", PixFmt: "yuv420p", AudioCodec: "aac"}, true},
		{probe{VideoCodec: "h264", Profile: "Main", PixFmt: "yuv420p"}, true}, // no audio is fine
		{probe{VideoCodec: "hevc", PixFmt: "yuv420p", AudioCodec: "aac"}, false},
		{probe{VideoCodec: "h264", Profile: "High 10", PixFmt: "yuv420p10le", AudioCodec: "aac"}, false},
		{probe{VideoCodec: "h264", Profile: "High", PixFmt: "yuv420p", AudioCodec: "ac3"}, false},
		{probe{VideoCodec: "h264", Profile: "High", PixFmt: "yuv420p", AudioCodec: "dts"}, false},
		{probe{AudioCodec: "aac"}, false},
	}
	for _, c := range cases {
		if got, why := compatible(c.p); got != c.want {
			t.Errorf("compatible(%+v) = %v (%s), want %v", c.p, got, why, c.want)
		}
	}
}

// TestPrepareAndServe runs the real pipeline on tiny generated clips: one browsers can
// play (H.264/AAC) and one they can't (MPEG-4 Part 2 video).
func TestPrepareAndServe(t *testing.T) {
	for _, bin := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skip(bin + " not installed")
		}
	}
	dir := t.TempDir()
	mediaDir := filepath.Join(dir, "media")
	os.MkdirAll(mediaDir, 0o755)
	clip := func(name string, vcodec ...string) {
		args := append([]string{"-hide_banner", "-loglevel", "error",
			"-f", "lavfi", "-i", "testsrc=size=160x90:rate=24:duration=8",
			"-f", "lavfi", "-i", "sine=frequency=440:duration=8"}, vcodec...)
		args = append(args, "-c:a", "aac", "-pix_fmt", "yuv420p", "-shortest", filepath.Join(mediaDir, name))
		if out, err := exec.Command("ffmpeg", args...).CombinedOutput(); err != nil {
			t.Fatalf("make %s: %v %s", name, err, out)
		}
	}
	clip("Good Film.mp4", "-c:v", "libx264", "-g", "48")
	clip("Old Codec.mp4", "-c:v", "mpeg4")

	db, err := store.OpenSQLite(context.Background(), filepath.Join(dir, "anda.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	s := &Service{
		Dir: mediaDir, HLSDir: filepath.Join(dir, "hls"), Store: db,
		Authenticate: func(*http.Request) (store.User, error) { return store.User{ID: 1}, nil },
		Log:          slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	ctx := context.Background()
	if err := s.scan(ctx); err != nil {
		t.Fatal(err)
	}
	pending, err := db.MediaNeedingHLS(ctx)
	if err != nil || len(pending) != 2 {
		t.Fatalf("pending: %v %v", len(pending), err)
	}
	for _, m := range pending {
		s.prepare(ctx, m)
	}

	ready, _ := db.ReadyMedia(ctx)
	if len(ready) != 1 || ready[0].Title != "Good Film" || ready[0].Duration < 7.5 || ready[0].VideoCodec != "h264" {
		t.Fatalf("ready shelf: %+v", ready)
	}
	for _, m := range pending {
		got, _ := db.MediaByID(ctx, m.ID)
		if got.Title == "Old Codec" && (got.HLSState != store.HLSIncompatible || !strings.Contains(got.HLSError, "H.264")) {
			t.Fatalf("old codec: %+v", got)
		}
	}
	good := ready[0]
	if _, err := s.Info(ctx, good.ID); err != nil {
		t.Fatalf("info: %v", err)
	}

	// A rescan with nothing changed leaves the film ready.
	s.scan(ctx)
	if again, _ := db.ReadyMedia(ctx); len(again) != 1 {
		t.Fatal("rescan un-readied the film")
	}

	mux := http.NewServeMux()
	s.Register(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	get := func(path string) (int, string, string) {
		res, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, res.Header.Get("Content-Type"), string(b)
	}
	base := "/media/" + strconv.FormatInt(good.ID, 10) + "/"
	code, ct, body := get(base + "index.m3u8")
	if code != 200 || ct != "application/vnd.apple.mpegurl" || !strings.Contains(body, "#EXT-X-MAP:URI=\"init.mp4\"") || !strings.Contains(body, "seg_00000.m4s") {
		t.Fatalf("playlist: %d %s\n%s", code, ct, body)
	}
	if code, ct, _ := get(base + "seg_00000.m4s"); code != 200 || ct != "video/iso.segment" {
		t.Fatalf("segment: %d %s", code, ct)
	}
	if code, _, _ := get(base + "init.mp4"); code != 200 {
		t.Fatalf("init: %d", code)
	}
	for _, bad := range []string{base + "..%2Fanda.db", base + "evil.sh", "/media/999/index.m3u8"} {
		if code, _, _ := get(bad); code != 404 {
			t.Fatalf("%s: got %d, want 404", bad, code)
		}
	}
}
