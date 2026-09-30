package media

import (
	"context"
	"io"
	"log/slog"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
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
	filmGOP := func(name, bitrate, gop string) string {
		p := filepath.Join(dir, name)
		if out, err := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error",
			"-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24:duration=24",
			"-f", "lavfi", "-i", "sine=frequency=440:duration=24",
			"-c:v", "libx264", "-b:v", bitrate, "-g", gop, "-keyint_min", gop, "-sc_threshold", "0",
			"-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", p).CombinedOutput(); err != nil {
			t.Fatalf("make %s: %v %s", name, err, out)
		}
		return p
	}
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
	if err != nil || !done || len(low) == 0 {
		t.Fatalf("low rung: %d segments (done=%v, %v)", len(low), done, err)
	}
	// Short segments for fast starts, and every original boundary is one of the rung's.
	lowStarts := map[int]bool{}
	at := 0.0
	for _, d := range low {
		if d > rungKeyEvery+0.1 {
			t.Fatalf("low rung segment of %.2fs, want <= %.1fs: %v", d, rungKeyEvery, low)
		}
		lowStarts[int(math.Round(at*10))] = true
		at += d
	}
	at = 0
	for _, d := range orig {
		if !lowStarts[int(math.Round(at*10))] {
			t.Fatalf("original boundary at %.3fs isn't a rung boundary\noriginal %v\nlow %v\nkeys %v", at, orig, low, rungKeyframes(orig))
		}
		at += d
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

	// A rung made the old way (following the original's long segments) gets redone.
	old := "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:12\n#EXT-X-MAP:URI=\"init_l.mp4\"\n#EXTINF:12.0,\nseg_l_00000.m4s\n#EXT-X-ENDLIST\n"
	os.WriteFile(filepath.Join(heavy, "stream_l.m3u8"), []byte(old), 0o644)
	os.WriteFile(filepath.Join(heavy, "seg_l_00099.m4s"), []byte("stale"), 0o644)
	if err := s.makeRung(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	redone, _, _ := readPlaylist(filepath.Join(heavy, "stream_l.m3u8"))
	if len(redone) != len(low) || slices.Max(redone) > rungKeyEvery+0.1 {
		t.Fatalf("old rung not redone: %v", redone)
	}
	if _, err := os.Stat(filepath.Join(heavy, "seg_l_00099.m4s")); !os.IsNotExist(err) {
		t.Fatal("stale segment left behind")
	}
	if again, _ := os.ReadFile(filepath.Join(heavy, "index.m3u8")); strings.Count(string(again), "stream_l.m3u8") != 1 {
		t.Fatalf("master lists the rung %d times", strings.Count(string(again), "stream_l.m3u8"))
	}

	// Running again changes nothing.
	s.makeRung(context.Background(), 1)
	if again, _ := os.ReadFile(filepath.Join(heavy, "index.m3u8")); string(again) != string(master) {
		t.Fatal("second run changed the master playlist")
	}

	// A light film with frequent keyframes (2s segments) starts fast already: none.
	light := prep(2, film("light.mp4", "null", "600k"))
	s.makeRung(context.Background(), 2)
	if _, err := os.Stat(filepath.Join(light, "stream_l.m3u8")); !os.IsNotExist(err) {
		t.Fatal("light, short-GOP film got a low rung")
	}
	// A light film with keyframes 10s apart would start slowly: it gets one.
	slow := prep(3, filmGOP("slow-start.mp4", "600k", "240"))
	if err := s.makeRung(context.Background(), 3); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(slow, "stream_l.m3u8")); err != nil {
		t.Fatal("long-GOP film got no fast-start rung")
	}
}
