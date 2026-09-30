package media

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"anda/internal/store"
)

// probe is what ffprobe says about a file's first video and audio streams.
type probe struct {
	VideoCodec string
	Profile    string
	PixFmt     string
	AudioCodec string
	Duration   float64
}

func runProbe(ctx context.Context, path string) (probe, error) {
	out, err := exec.CommandContext(ctx, "ffprobe", "-v", "error", "-print_format", "json",
		"-show_streams", "-show_format", path).Output()
	if err != nil {
		return probe{}, fmt.Errorf("ffprobe: %w", err)
	}
	var raw struct {
		Streams []struct {
			CodecType string `json:"codec_type"`
			CodecName string `json:"codec_name"`
			Profile   string `json:"profile"`
			PixFmt    string `json:"pix_fmt"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(out, &raw); err != nil {
		return probe{}, fmt.Errorf("ffprobe output: %w", err)
	}
	var p probe
	for _, s := range raw.Streams {
		switch {
		case s.CodecType == "video" && p.VideoCodec == "":
			p.VideoCodec, p.Profile, p.PixFmt = s.CodecName, s.Profile, s.PixFmt
		case s.CodecType == "audio" && p.AudioCodec == "":
			p.AudioCodec = s.CodecName
		}
	}
	p.Duration, _ = strconv.ParseFloat(raw.Format.Duration, 64)
	return p, nil
}

// compatible reports whether browsers can play the video as it is, so no video encoding
// is needed. One vCPU can't transcode video in real time, so anything else is hidden until
// the VM grows (plan: "Changes for this VM"). Audio is different: see codecArgs.
func compatible(p probe) (bool, string) {
	if p.VideoCodec != "h264" {
		return false, "video is " + orNone(p.VideoCodec) + ", browsers need H.264"
	}
	if strings.Contains(p.Profile, "10") || strings.Contains(p.Profile, "4:2:2") || strings.Contains(p.Profile, "4:4:4") {
		return false, "H.264 profile " + p.Profile + " isn't supported by browsers"
	}
	if p.PixFmt != "" && p.PixFmt != "yuv420p" && p.PixFmt != "yuvj420p" {
		return false, "pixel format " + p.PixFmt + " isn't supported by browsers"
	}
	return true, ""
}

// codecArgs copies the video, and copies AAC audio as it is. Any other audio (AC3, E-AC3,
// DTS, TrueHD, FLAC, Opus...) is converted to AAC stereo: that costs a few percent of a
// core (measured ~36x real time for 5.1 AC3), unlike video, and it opens up a large share
// of releases.
func codecArgs(p probe) []string {
	if p.AudioCodec == "" || p.AudioCodec == "aac" {
		return []string{"-c", "copy"}
	}
	return []string{"-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-ac", "2"}
}

func orNone(s string) string {
	if s == "" {
		return "missing"
	}
	return s
}

// remux copies the streams into fMP4 HLS segments. It writes to a temp dir and swaps it in
// only when complete, so a player never sees half a film.
func remux(ctx context.Context, src, dst string, codecs []string) error {
	tmp := dst + ".tmp"
	if err := os.RemoveAll(tmp); err != nil {
		return err
	}
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return err
	}
	args := []string{
		"-hide_banner", "-loglevel", "error", "-nostdin",
		"-i", src,
		"-map", "0:v:0", "-map", "0:a:0?",
	}
	args = append(args, codecs...)
	args = append(args,
		"-f", "hls",
		"-hls_time", "6",
		"-hls_playlist_type", "vod",
		"-hls_segment_type", "fmp4",
		"-hls_fmp4_init_filename", "init.mp4",
		"-hls_segment_filename", "seg_%05d.m4s",
		"index.m3u8",
	)
	name := "ffmpeg"
	// Low priority: a remux shares the one vCPU with everything else on the VM.
	if nice, err := exec.LookPath("nice"); err == nil {
		name, args = nice, append([]string{"-n", "10", "ffmpeg"}, args...)
	}
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = tmp
	if out, err := cmd.CombinedOutput(); err != nil {
		os.RemoveAll(tmp)
		msg := strings.TrimSpace(string(out))
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return fmt.Errorf("ffmpeg: %w: %s", err, msg)
	}
	if err := os.RemoveAll(dst); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}

// prepare probes one film and remuxes it if the browser can play its streams.
func (s *Service) prepare(ctx context.Context, m store.Media) {
	log := s.Log.With("media", m.ID, "title", m.Title)
	if err := s.Store.SetHLSState(ctx, m.ID, store.HLSRemuxing, ""); err != nil {
		log.Error("set hls state", "err", err)
		return
	}
	fail := func(state string, err error) {
		log.Warn("hls not prepared", "state", state, "reason", err)
		if err := s.Store.SetHLSState(ctx, m.ID, state, err.Error()); err != nil {
			log.Error("set hls state", "err", err)
		}
	}

	src := filepath.Join(s.Dir, filepath.FromSlash(m.Path))
	pctx, cancel := context.WithTimeout(ctx, time.Minute)
	p, err := runProbe(pctx, src)
	cancel()
	if err != nil {
		fail(store.HLSFailed, err)
		return
	}
	if err := s.Store.SetProbe(ctx, m.ID, p.VideoCodec, p.AudioCodec, p.Duration); err != nil {
		log.Error("save probe", "err", err)
	}
	if ok, why := compatible(p); !ok {
		fail(store.HLSIncompatible, errors.New(why))
		return
	}

	start := time.Now()
	rctx, cancel := context.WithTimeout(ctx, 20*time.Minute)
	err = remux(rctx, src, s.hlsDir(m.ID), codecArgs(p))
	cancel()
	if err != nil {
		fail(store.HLSFailed, err)
		return
	}
	if err := s.Store.SetHLSState(ctx, m.ID, store.HLSReady, ""); err != nil {
		log.Error("set hls state", "err", err)
		return
	}
	log.Info("hls ready", "took", time.Since(start).Round(time.Millisecond), "duration", p.Duration)
}

func (s *Service) hlsDir(id int64) string {
	return filepath.Join(s.HLSDir, strconv.FormatInt(id, 10))
}
