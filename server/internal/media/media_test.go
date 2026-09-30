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

func TestOutputArgs(t *testing.T) {
	p := probe{
		Audio: []streamInfo{
			{Index: 0, Codec: "truehd", Lang: "en", Default: true},
			{Index: 1, Codec: "aac", Lang: "fr"},
		},
		Subs: []streamInfo{
			{Index: 0, Codec: "hdmv_pgs_subtitle", Lang: "en"}, // image-based: skipped
			{Index: 1, Codec: "subrip", Lang: "es"},
		},
	}
	got := strings.Join(outputArgs(p, "vod"), " ")
	for _, want := range []string{
		"-map 0:v:0 -map 0:a:0 -map 0:a:1 -c:v copy",
		"-c:a:0 aac -b:a:0 160k -ac:a:0 2", // TrueHD becomes AAC stereo
		"-c:a:1 copy",                      // AAC is copied
		"v:0,agroup:aud,name:v a:0,agroup:aud,name:a0,language:en,default:yes a:1,agroup:aud,name:a1,language:fr",
		"-master_pl_name index.m3u8",
		"-map 0:s:1 -c:s webvtt -f webvtt sub_0.vtt",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in\n%s", want, got)
		}
	}
	if strings.Contains(got, "0:s:0") {
		t.Error("image subtitles should be skipped")
	}
	if got := strings.Join(outputArgs(probe{}, "event"), " "); !strings.Contains(got, "-var_stream_map v:0,name:v ") {
		t.Errorf("no audio: %s", got)
	}
	for title, want := range map[string]string{
		"GalaxyRG - Spider-Man.Across.The.Spider-Verse.2023.1080p.WEBRip.1600MB.DD5.1.x264-GalaxyRG": "",
		"Film.2019.720p.BluRay": "",
		"Commentary":            "Commentary",
		"English 5.1":           "English 5.1",
		"Director's commentary": "Director's commentary",
	} {
		if got := trackTitle(title); got != want {
			t.Errorf("trackTitle(%q) = %q, want %q", title, got, want)
		}
	}
	if NormLang("fre") != "fr" || NormLang("ENG") != "en" || NormLang("und") != "" || NormLang("x y") != "" {
		t.Error("normLang")
	}
}

// A film with two audio languages and subtitles comes out as renditions a player can pick.
func TestTracksPipeline(t *testing.T) {
	for _, bin := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skip(bin + " not installed")
		}
	}
	dir := t.TempDir()
	srt := filepath.Join(dir, "en.srt")
	os.WriteFile(srt, []byte("1\n00:00:01,000 --> 00:00:03,000\nHello there\n"), 0o644)
	src := filepath.Join(dir, "film.mkv")
	if out, err := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "testsrc=size=160x90:rate=24:duration=8",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-f", "lavfi", "-i", "sine=frequency=660:duration=8", "-i", srt,
		"-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:s",
		"-c:v", "libx264", "-g", "48", "-pix_fmt", "yuv420p", "-c:a:0", "ac3", "-c:a:1", "aac", "-c:s", "srt",
		"-metadata:s:a:0", "language=eng", "-metadata:s:a:0", "title=Director", "-metadata:s:a:1", "language=fre",
		"-metadata:s:s:0", "language=eng", src).CombinedOutput(); err != nil {
		t.Fatalf("make film: %v %s", err, out)
	}
	p, err := runProbe(context.Background(), src)
	if err != nil || len(p.Audio) != 2 || len(p.Subs) != 1 || p.Audio[0].Lang != "en" || p.Audio[1].Lang != "fr" {
		t.Fatalf("probe: %+v %v", p, err)
	}
	s := &Service{HLSDir: filepath.Join(dir, "hls")}
	if err := remux(context.Background(), src, s.hlsDir(1), p); err != nil {
		t.Fatal(err)
	}
	master, _ := os.ReadFile(filepath.Join(s.hlsDir(1), "index.m3u8"))
	for _, want := range []string{`TYPE=AUDIO`, `LANGUAGE="en"`, `LANGUAGE="fr"`, "stream_v.m3u8"} {
		if !strings.Contains(string(master), want) {
			t.Fatalf("master playlist missing %s:\n%s", want, master)
		}
	}
	for i, want := range []string{"aac", "aac"} { // AC3 converted, AAC copied
		out, _ := exec.Command("ffprobe", "-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0",
			filepath.Join(s.hlsDir(1), "init_a"+strconv.Itoa(i)+".mp4")).Output()
		if strings.TrimSpace(string(out)) != want {
			t.Fatalf("audio %d codec: %q", i, out)
		}
	}
	vtt, _ := os.ReadFile(filepath.Join(s.hlsDir(1), "sub_0.vtt"))
	if !strings.HasPrefix(string(vtt), "WEBVTT") || !strings.Contains(string(vtt), "00:01.000 --> 00:03.000") {
		t.Fatalf("subtitle:\n%s", vtt)
	}
	audio, subs := s.readTracks(1)
	if len(audio) != 2 || audio[0].Label != "Director" || !audio[0].Default || audio[1].Lang != "fr" ||
		len(subs) != 1 || subs[0].Lang != "en" || subs[0].URL != "/media/1/sub_0.vtt" {
		t.Fatalf("tracks: %+v %+v", audio, subs)
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
		filepath.Join(s.hlsDir(surround.ID), "init_a0.mp4")).Output()
	vout, _ := exec.Command("ffprobe", "-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0",
		filepath.Join(s.hlsDir(surround.ID), "init_v.mp4")).Output()
	if err != nil || !strings.Contains(string(out), "aac") || !strings.Contains(string(vout), "h264") {
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
	if code != 200 || ct != "application/vnd.apple.mpegurl" || !strings.Contains(body, "stream_v.m3u8") {
		t.Fatalf("master playlist: %d %s\n%s", code, ct, body)
	}
	code, _, body = get(base + "stream_v.m3u8")
	if code != 200 || !strings.Contains(body, "#EXT-X-MAP:URI=\"init_v.mp4\"") || !strings.Contains(body, "seg_v_00000.m4s") {
		t.Fatalf("video playlist: %d\n%s", code, body)
	}
	if code, ct, _ := get(base + "seg_v_00000.m4s"); code != 200 || ct != "video/iso.segment" {
		t.Fatalf("segment: %d %s", code, ct)
	}
	for _, f := range []string{"init_v.mp4", "stream_a0.m3u8", "init_a0.mp4"} {
		if code, _, _ := get(base + f); code != 200 {
			t.Fatalf("%s: %d", f, code)
		}
	}
	for _, bad := range []string{base + "..%2Fanda.db", base + "evil.sh", "/media/999/index.m3u8"} {
		if code, _, _ := get(bad); code != 404 {
			t.Fatalf("%s: got %d, want 404", bad, code)
		}
	}
}
