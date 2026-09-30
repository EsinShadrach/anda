package media

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// A lower-quality copy of each heavy film, so viewers on slow connections don't stall: a 480p
// "rung" beside the original in the film's master playlist. hls.js measures each viewer's
// own connection and switches between them segment by segment; the room's sync is on
// position, so people on different rungs still watch together.
//
// It's also the fast-start path. Video is copied, so the original's segments are as long as
// its keyframe spacing (often 6-10s, i.e. 1-3 MB before the first frame). The rung has a
// keyframe every 2s, so its segments are ~2s (~80-220 KB); the player starts and resumes
// after seeks on it and climbs to full quality within a few seconds. Measured through a
// link like the user's (150 ms RTT, 17 Mbit/s): first frame 2.0s -> 0.58s, seek 1.8s ->
// 0.48s, full quality after ~2.5s.
//
// One vCPU can't encode in real time for a room, but it can in the background: measured on
// the VM, 480p encodes at ~2.5-3x real time (~40-50 min of CPU for a 2h film). So: for HD
// films that are heavy (video over rungMinKbps) or slow to start (segments longer than
// rungLongSegment on average), one film at a time, at the lowest priority, after the film is
// fully prepared. It shows in Pulse's numbers while it runs; ANDA_LOW_RUNG=off turns it off.
//
// Files, beside the original (see tracks.go): stream_l.m3u8, init_l.mp4, seg_l_NNNNN.m4s.
// They're made in .low/ and moved in when complete; only then does index.m3u8 list them.

const (
	rungMinKbps     = 2000 // video bitrate above which a film gets a low rung
	rungLongSegment = 3.0  // average original segment (s) above which it gets one for fast starts
	rungKeyEvery    = 2.0  // seconds between the rung's keyframes (= its segment length)
	rungHeight      = 480
	rungMaxrate     = 900 // kbit/s ceiling for the low rung's video
)

// queueRung asks for a film's low rung; makeRung decides whether it needs one.
func (s *Service) queueRung(id int64) {
	if !s.LowRung || s.rungs == nil {
		return
	}
	select {
	case s.rungs <- id:
	default: // a long queue will be rebuilt from the ready films at the next start
	}
}

func (s *Service) rungWorker(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case id := <-s.rungs:
			if err := s.makeRung(ctx, id); err != nil && ctx.Err() == nil {
				s.Log.Warn("low-quality copy", "media", id, "err", err)
			}
		}
	}
}

// queueAllRungs looks at every ready film once at startup, for ones prepared before this
// ran or whose encode was interrupted.
func (s *Service) queueAllRungs(ctx context.Context) {
	list, err := s.Store.ReadyMedia(ctx)
	if err != nil {
		return
	}
	for _, m := range list {
		s.queueRung(m.ID)
	}
}

// makeRung encodes the low rung for a film, if it's a heavy one without one yet.
func (s *Service) makeRung(ctx context.Context, id int64) error {
	dir := s.hlsDir(id)
	src := filepath.Join(dir, "stream_v.m3u8")
	if _, err := os.Stat(filepath.Join(dir, "stream_l.m3u8")); err == nil {
		return nil // already has one
	}
	segs, done, err := readPlaylist(src)
	if err != nil || !done || len(segs) == 0 {
		return nil // old layout, or still downloading
	}
	var total float64
	for _, d := range segs {
		total += d
	}
	kbps := float64(dirSizeMatching(dir, "seg_v_")) * 8 / total / 1000
	w, h, err := videoSize(ctx, filepath.Join(dir, "init_v.mp4"))
	if err != nil {
		return err
	}
	avgSeg := total / float64(len(segs))
	if h <= rungHeight || (kbps < rungMinKbps && avgSeg <= rungLongSegment) {
		return nil
	}

	log := s.Log.With("media", id, "video_kbps", int(kbps), "avg_segment", fmt.Sprintf("%.1fs", avgSeg), "size", fmt.Sprintf("%dx%d", w, h))
	log.Info("making low-quality copy")
	start := time.Now()
	tmp := filepath.Join(dir, ".low")
	os.RemoveAll(tmp)
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return err
	}
	defer os.RemoveAll(tmp)

	keys := rungKeyframes(segs)
	args := []string{
		"-hide_banner", "-loglevel", "error", "-nostdin",
		"-i", src,
		"-map", "0:v:0", "-an",
		"-vf", fmt.Sprintf("scale=-2:%d", rungHeight),
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-profile:v", "high", "-pix_fmt", "yuv420p",
		"-maxrate", fmt.Sprintf("%dk", rungMaxrate), "-bufsize", fmt.Sprintf("%dk", rungMaxrate*2),
		"-g", "100000", "-keyint_min", "100000", "-sc_threshold", "0",
		"-threads", "1",
	}
	if len(keys) > 0 {
		args = append(args, "-force_key_frames", strings.Join(keys, ","))
	}
	args = append(args,
		"-f", "hls", "-hls_time", "1", "-hls_playlist_type", "vod", "-hls_segment_type", "fmp4",
		// Relative names, run inside tmp: the playlist must refer to its files by name.
		"-hls_fmp4_init_filename", "init_l.mp4", "-hls_segment_filename", "seg_l_%05d.m4s",
		"stream_l.m3u8",
	)
	name := "ffmpeg"
	if nice, err := exec.LookPath("nice"); err == nil {
		name, args = nice, append([]string{"-n", "19", "ffmpeg"}, args...)
	}
	// ~3x real time on the VM; give it plenty, and stop with the service.
	ectx, cancel := context.WithTimeout(ctx, time.Duration(total)*time.Second+30*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ectx, name, args...)
	cmd.Dir = tmp
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("ffmpeg: %w: %.300s", err, strings.TrimSpace(string(out)))
	}
	lowSegs, lowDone, err := readPlaylist(filepath.Join(tmp, "stream_l.m3u8"))
	if err != nil || !lowDone || len(lowSegs) == 0 {
		return fmt.Errorf("low rung playlist incomplete: %v", err)
	}

	// Move it in (files first, playlist last), then list it in the master playlist.
	entries, err := os.ReadDir(tmp)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.Name() != "stream_l.m3u8" {
			if err := os.Rename(filepath.Join(tmp, e.Name()), filepath.Join(dir, e.Name())); err != nil {
				return err
			}
		}
	}
	if err := os.Rename(filepath.Join(tmp, "stream_l.m3u8"), filepath.Join(dir, "stream_l.m3u8")); err != nil {
		return err
	}
	lw, lh, _ := videoSize(ctx, filepath.Join(dir, "init_l.mp4"))
	// The playlist, not init_l.mp4 alone: ffprobe reports level -99 without any samples.
	codec, _ := avcCodec(ctx, filepath.Join(dir, "stream_l.m3u8"))
	lowKbps := float64(dirSizeMatching(dir, "seg_l_")) * 8 / total / 1000
	peak := peakKbps(dir, "seg_l_", lowSegs)
	if err := addVariant(filepath.Join(dir, "index.m3u8"), variant{
		uri: "stream_l.m3u8", width: lw, height: lh, codec: codec, avgKbps: lowKbps, peakKbps: peak,
	}); err != nil {
		return err
	}
	log.Info("low-quality copy ready", "took", time.Since(start).Round(time.Second), "low_kbps", int(lowKbps))
	return nil
}

// rungKeyframes lists the rung's keyframe times: every original segment boundary (so every
// switch point of the original is one of the rung's too), plus one every rungKeyEvery seconds
// in between (so the rung's segments stay small). A segment starts at each keyframe
// (hls_time is shorter than any gap).
func rungKeyframes(segs []float64) []string {
	var keys []string
	t, next := 0.0, rungKeyEvery
	// ffmpeg keys the first frame at or after each time; 5 ms early so rounding to three
	// decimals (3.91667 -> 3.917) can't push it onto the next frame.
	add := func(at float64) { keys = append(keys, strconv.FormatFloat(at-0.005, 'f', 3, 64)) }
	for _, d := range segs[:len(segs)-1] {
		end := t + d
		for ; next < end-rungKeyEvery/2; next += rungKeyEvery {
			add(next) // grid points not too close to the coming boundary
		}
		add(end)
		t, next = end, end+rungKeyEvery
	}
	for ; next < t+segs[len(segs)-1]-rungKeyEvery/2; next += rungKeyEvery {
		add(next)
	}
	return keys
}

// readPlaylist returns a media playlist's segment durations and whether it's complete.
func readPlaylist(path string) ([]float64, bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, false, err
	}
	defer f.Close()
	var segs []float64
	done := false
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if v, ok := strings.CutPrefix(line, "#EXTINF:"); ok {
			d, _ := strconv.ParseFloat(strings.TrimSuffix(strings.SplitN(v, ",", 2)[0], ","), 64)
			segs = append(segs, d)
		}
		if line == "#EXT-X-ENDLIST" {
			done = true
		}
	}
	return segs, done, sc.Err()
}

func dirSizeMatching(dir, prefix string) int64 {
	entries, _ := os.ReadDir(dir)
	var n int64
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), prefix) {
			if info, err := e.Info(); err == nil {
				n += info.Size()
			}
		}
	}
	return n
}

// peakKbps is the highest single-segment bitrate, which HLS's BANDWIDTH should reflect.
func peakKbps(dir, prefix string, durs []float64) float64 {
	peak := 0.0
	for i, d := range durs {
		info, err := os.Stat(filepath.Join(dir, fmt.Sprintf("%s%05d.m4s", prefix, i)))
		if err != nil || d <= 0 {
			continue
		}
		peak = math.Max(peak, float64(info.Size())*8/d/1000)
	}
	return peak
}

func videoSize(ctx context.Context, path string) (int, int, error) {
	out, err := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-select_streams", "v:0",
		"-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path).Output()
	if err != nil {
		return 0, 0, fmt.Errorf("ffprobe %s: %w", filepath.Base(path), err)
	}
	var w, h int
	if _, err := fmt.Sscanf(strings.TrimSpace(string(out)), "%dx%d", &w, &h); err != nil {
		return 0, 0, err
	}
	return w, h, nil
}

// avcCodec is the RFC 6381 codec string (avc1.PPCCLL) for an H.264 file, which players use
// to check they can decode a variant before picking it.
func avcCodec(ctx context.Context, path string) (string, error) {
	out, err := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-select_streams", "v:0",
		"-show_entries", "stream=profile,level", "-of", "json", path).Output()
	if err != nil {
		return "", err
	}
	var raw struct {
		Streams []struct {
			Profile string `json:"profile"`
			Level   int    `json:"level"`
		} `json:"streams"`
	}
	if json.Unmarshal(out, &raw) != nil || len(raw.Streams) == 0 {
		return "", errors.New("no video stream")
	}
	pc := map[string]string{"High": "6400", "Main": "4d40", "Baseline": "42e0", "Constrained Baseline": "42e0"}[raw.Streams[0].Profile]
	if pc == "" {
		pc = "6400"
	}
	level := raw.Streams[0].Level
	if level <= 0 || level > 62 {
		level = 31 // unknown: 3.1 covers 480p comfortably
	}
	return fmt.Sprintf("avc1.%s%02x", pc, level), nil
}

type variant struct {
	uri               string
	width, height     int
	codec             string
	avgKbps, peakKbps float64
}

// addVariant lists another video rung in a master playlist, sharing the original's audio
// group, and writes it atomically so a player never reads half a file.
func addVariant(master string, v variant) error {
	b, err := os.ReadFile(master)
	if err != nil {
		return err
	}
	text := string(b)
	if strings.Contains(text, "\n"+v.uri) {
		return nil
	}
	// The original's STREAM-INF tells us its audio group and audio codec.
	audioGroup, audioCodec := "", ""
	for _, line := range strings.Split(text, "\n") {
		if !strings.HasPrefix(line, "#EXT-X-STREAM-INF:") {
			continue
		}
		if i := strings.Index(line, `AUDIO="`); i >= 0 {
			audioGroup = line[i+7:]
			audioGroup = audioGroup[:strings.Index(audioGroup, `"`)]
		}
		if strings.Contains(line, "mp4a.40.2") {
			audioCodec = ",mp4a.40.2"
		}
		break
	}
	const audioKbps = 160
	attrs := fmt.Sprintf("BANDWIDTH=%d,AVERAGE-BANDWIDTH=%d,RESOLUTION=%dx%d,CODECS=\"%s%s\"",
		int((v.peakKbps+audioKbps)*1000), int((v.avgKbps+audioKbps)*1000), v.width, v.height, v.codec, audioCodec)
	if audioGroup != "" {
		attrs += fmt.Sprintf(`,AUDIO="%s"`, audioGroup)
	}
	text = strings.TrimRight(text, "\n") + "\n#EXT-X-STREAM-INF:" + attrs + "\n" + v.uri + "\n"
	tmp := master + ".tmp"
	if err := os.WriteFile(tmp, []byte(text), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, master)
}
