package media

import (
	"context"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestLowRung(t *testing.T) {
	for _, bin := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skip(bin + " not installed")
		}
	}
	dir := t.TempDir()
	film := func(name, vf, bitrate string) string {
		p := filepath.Join(dir, name)
		// Noise makes the encoder spend bits, like real footage; a 2s GOP gives several
		// segment boundaries in 12s.
		if out, err := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error",
			"-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24:duration=12",
			"-f", "lavfi", "-i", "sine=frequency=440:duration=12",
			"-vf", vf, "-c:v", "libx264", "-b:v", bitrate, "-g", "48", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", p).CombinedOutput(); err != nil {
			t.Fatalf("make %s: %v %s", name, err, out)
		}
		return p
	}
	s := &Service{HLSDir: filepath.Join(dir, "hls"), LowRung: true, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	prep := func(id int64, src string) string {
		p, err := runProbe(context.Background(), src)
		if err != nil {
			t.Fatal(err)
		}
		if err := remux(context.Background(), src, s.hlsDir(id), p); err != nil {
			t.Fatal(err)
		}
		return s.hlsDir(id)
	}

	heavy := prep(1, film("heavy.mp4", "noise=alls=40:allf=t", "5M"))
	if err := s.makeRung(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	orig, _, _ := readPlaylist(filepath.Join(heavy, "stream_v.m3u8"))
	low, done, err := readPlaylist(filepath.Join(heavy, "stream_l.m3u8"))
	if err != nil || !done || len(low) != len(orig) || len(orig) < 2 {
		t.Fatalf("low rung: %d segments (done=%v, %v), original %d", len(low), done, err, len(orig))
	}
	for i := range orig { // cut at the same moments, so players can switch at any boundary
		if d := low[i] - orig[i]; d > 0.1 || d < -0.1 {
			t.Fatalf("segment %d: low %.3fs vs original %.3fs", i, low[i], orig[i])
		}
	}
	master, _ := os.ReadFile(filepath.Join(heavy, "index.m3u8"))
	if strings.Count(string(master), "#EXT-X-STREAM-INF") != 2 || !strings.Contains(string(master), "RESOLUTION=854x480") ||
		!regexp.MustCompile(`CODECS="avc1\.6400[0-9a-f]{2},mp4a\.40\.2"`).Match(master) || !strings.Contains(string(master), `AUDIO="group_aud"`) {
		t.Fatalf("master:\n%s", master)
	}
	if _, err := os.Stat(filepath.Join(heavy, ".low")); !os.IsNotExist(err) {
		t.Fatal("temp dir left behind")
	}
	origKbps := float64(dirSizeMatching(heavy, "seg_v_")) * 8 / 12 / 1000
	lowKbps := float64(dirSizeMatching(heavy, "seg_l_")) * 8 / 12 / 1000
	if lowKbps > origKbps/2 || lowKbps > rungMaxrate*1.5 {
		t.Fatalf("low rung not lighter: %.0f vs %.0f kbit/s", lowKbps, origKbps)
	}
	// And it's servable: every file the playlists name passes the serving rules.
	for _, f := range []string{"stream_l.m3u8", "init_l.mp4", "seg_l_00000.m4s", "stream_v.m3u8", "stream_a0.m3u8"} {
		if !hlsFile.MatchString(f) {
			t.Errorf("%s isn't served", f)
		}
	}

	// Running again changes nothing.
	s.makeRung(context.Background(), 1)
	if again, _ := os.ReadFile(filepath.Join(heavy, "index.m3u8")); string(again) != string(master) {
		t.Fatal("second run changed the master playlist")
	}

	// A light film doesn't get one.
	light := prep(2, film("light.mp4", "null", "600k"))
	s.makeRung(context.Background(), 2)
	if _, err := os.Stat(filepath.Join(light, "stream_l.m3u8")); !os.IsNotExist(err) {
		t.Fatal("light film got a low rung")
	}
}
