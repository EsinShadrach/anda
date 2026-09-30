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
	"slices"
	"strconv"
	"strings"
	"testing"

	"anda/internal/store"
)

func TestCodecArgs(t *testing.T) {
	if got := strings.Join(codecArgs(probe{AudioCodec: "aac"}), " "); got != "-c copy" {
		t.Errorf("aac: %s", got)
	}
	if got := strings.Join(codecArgs(probe{}), " "); got != "-c copy" {
		t.Errorf("no audio: %s", got)
	}
	if got := strings.Join(codecArgs(probe{AudioCodec: "truehd"}), " "); !strings.Contains(got, "-c:v copy") || !strings.Contains(got, "-c:a aac") {
		t.Errorf("truehd: %s", got)
	}
}

func TestCompatible(t *testing.T) {
	cases := []struct {
		p    probe
		want bool
	}{
		{probe{VideoCodec: "h264", Profile: "High", PixFmt: "yuv420p", AudioCodec: "aac"}, true},
		{probe{VideoCodec: "h264", Profile: "Main", PixFmt: "yuv420p"}, true}, // no audio is fine
		{probe{VideoCodec: "hevc", PixFmt: "yuv420p", AudioCodec: "aac"}, false},
		{probe{VideoCodec: "h264", Profile: "High 10", PixFmt: "yuv420p10le", AudioCodec: "aac"}, false},
		{probe{VideoCodec: "h264", Profile: "High", PixFmt: "yuv420p", AudioCodec: "ac3"}, true}, // audio gets converted
		{probe{VideoCodec: "h264", Profile: "High", PixFmt: "yuv420p", AudioCodec: "dts"}, true},
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
		if !slices.Contains(vcodec, "-c:a") {
			args = append(args, "-c:a", "aac")
		}
		args = append(args, "-pix_fmt", "yuv420p", "-shortest", filepath.Join(mediaDir, name))
		if out, err := exec.Command("ffmpeg", args...).CombinedOutput(); err != nil {
			t.Fatalf("make %s: %v %s", name, err, out)
		}
	}
	clip("Good Film.mp4", "-c:v", "libx264", "-g", "48")
	clip("Surround Film.mkv", "-c:v", "libx264", "-g", "48", "-c:a", "ac3")
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
	if err != nil || len(pending) != 3 {
		t.Fatalf("pending: %v %v", len(pending), err)
	}
	for _, m := range pending {
		s.prepare(ctx, m)
	}

	ready, _ := db.ReadyMedia(ctx)
	byTitle := map[string]store.Media{}
	for _, m := range ready {
		byTitle[m.Title] = m
	}
	if len(ready) != 2 || byTitle["Good Film"].Duration < 7.5 || byTitle["Good Film"].VideoCodec != "h264" {
		t.Fatalf("ready shelf: %+v", ready)
	}
	// AC3 audio was converted to AAC; the video was copied.
	surround := byTitle["Surround Film"]
	if surround.AudioCodec != "ac3" {
		t.Fatalf("surround probe: %+v", surround)
	}
	out, err := exec.Command("ffprobe", "-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0",
		filepath.Join(s.hlsDir(surround.ID), "init.mp4")).Output()
	if err != nil || !strings.Contains(string(out), "aac") || !strings.Contains(string(out), "h264") {
		t.Fatalf("surround HLS codecs: %q %v", out, err)
	}
	for _, m := range pending {
		got, _ := db.MediaByID(ctx, m.ID)
		if got.Title == "Old Codec" && (got.HLSState != store.HLSIncompatible || !strings.Contains(got.HLSError, "H.264")) {
			t.Fatalf("old codec: %+v", got)
		}
	}
	good := byTitle["Good Film"]
	if _, err := s.Info(ctx, good.ID); err != nil {
		t.Fatalf("info: %v", err)
	}

	// A rescan with nothing changed leaves the film ready.
	s.scan(ctx)
	if again, _ := db.ReadyMedia(ctx); len(again) != 2 {
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
