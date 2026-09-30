package media

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"anda/internal/protocol"
)

// A film's audio languages and subtitles. Every audio track (up to maxAudio) becomes its own
// HLS audio rendition beside one video playlist, so each viewer picks their language; text
// subtitles (up to maxSubs) are extracted to WebVTT by the same ffmpeg run. Image-based
// subtitles (PGS, DVD) would need OCR or burning in, which one vCPU can't afford: skipped.
//
// Layout, all flat in the film's HLS dir: index.m3u8 (master), stream_v.m3u8 + init_v.mp4
// + seg_v_NNNNN.m4s (video), stream_aN.m3u8 + init_aN.mp4 + seg_aN_NNNNN.m4s (audio),
// sub_N.vtt, and tracks.json describing them. Films prepared before this have the old
// single-playlist layout (index.m3u8, init.mp4, seg_NNNNN.m4s) and no tracks.json.

const (
	maxAudio = 4
	maxSubs  = 12
)

// streamInfo is one audio or subtitle stream from ffprobe.
type streamInfo struct {
	Index   int // among streams of its type, for "0:a:N" / "0:s:N"
	Codec   string
	Lang    string // ISO 639-1 where known ("en"), else as tagged
	Title   string
	Default bool
	Forced  bool
}

var textSubs = map[string]bool{"subrip": true, "srt": true, "ass": true, "ssa": true, "mov_text": true, "webvtt": true, "text": true}

// outputArgs maps and encodes the streams into the HLS layout above, plus a WebVTT output
// per text subtitle. playlistType is "vod" (a finished file) or "event" (still arriving).
func outputArgs(p probe, playlistType string) []string {
	audio := p.Audio
	if len(audio) > maxAudio {
		audio = audio[:maxAudio]
	}
	args := []string{"-map", "0:v:0"}
	for _, a := range audio {
		args = append(args, "-map", fmt.Sprintf("0:a:%d", a.Index))
	}
	// Video is always copied (one vCPU can't transcode it). AAC audio is copied too; any
	// other audio (AC3, DTS, TrueHD...) becomes AAC stereo, which costs little per track.
	args = append(args, "-c:v", "copy")
	for i, a := range audio {
		if a.Codec == "aac" {
			args = append(args, fmt.Sprintf("-c:a:%d", i), "copy")
		} else {
			args = append(args, fmt.Sprintf("-c:a:%d", i), "aac", fmt.Sprintf("-b:a:%d", i), "160k", fmt.Sprintf("-ac:a:%d", i), "2")
		}
	}
	streamMap := "v:0,agroup:aud,name:v"
	if len(audio) == 0 {
		streamMap = "v:0,name:v"
	}
	def := defaultAudio(audio)
	for i, a := range audio {
		streamMap += fmt.Sprintf(" a:%d,agroup:aud,name:a%d", i, i)
		if a.Lang != "" {
			streamMap += ",language:" + a.Lang
		}
		if i == def {
			streamMap += ",default:yes"
		}
	}
	args = append(args,
		"-f", "hls",
		"-hls_time", "6",
		"-hls_playlist_type", playlistType,
		"-hls_segment_type", "fmp4",
		"-hls_fmp4_init_filename", "init_%v.mp4",
		"-hls_segment_filename", "seg_%v_%05d.m4s",
		"-master_pl_name", "index.m3u8",
		"-var_stream_map", streamMap,
		"stream_%v.m3u8",
	)
	for i, s := range subtitles(p) {
		args = append(args, "-map", fmt.Sprintf("0:s:%d", s.Index), "-c:s", "webvtt", "-f", "webvtt", fmt.Sprintf("sub_%d.vtt", i))
	}
	return args
}

func defaultAudio(audio []streamInfo) int {
	for i, a := range audio {
		if a.Default {
			return i
		}
	}
	return 0
}

func subtitles(p probe) []streamInfo {
	var out []streamInfo
	for _, s := range p.Subs {
		if textSubs[s.Codec] && len(out) < maxSubs {
			out = append(out, s)
		}
	}
	return out
}

type trackFile struct {
	Audio     []protocol.Track `json:"audio"`
	Subtitles []protocol.Track `json:"subtitles"`
}

// writeTracks records what outputArgs produces, for Info to hand to players.
func writeTracks(dir string, p probe) error {
	var tf trackFile
	audio := p.Audio
	if len(audio) > maxAudio {
		audio = audio[:maxAudio]
	}
	def := defaultAudio(audio)
	for i, a := range audio {
		tf.Audio = append(tf.Audio, protocol.Track{Lang: a.Lang, Label: a.Title, Default: i == def})
	}
	for i, s := range subtitles(p) {
		tf.Subtitles = append(tf.Subtitles, protocol.Track{
			Lang: s.Lang, Label: s.Title, Forced: s.Forced, Default: s.Default, URL: fmt.Sprintf("sub_%d.vtt", i),
		})
	}
	b, err := json.Marshal(tf)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "tracks.json"), b, 0o644)
}

// readTracks returns a film's audio and subtitle tracks, with subtitle URLs made absolute.
// Films prepared before tracks existed have none.
func (s *Service) readTracks(id int64) (audio, subs []protocol.Track) {
	b, err := os.ReadFile(filepath.Join(s.hlsDir(id), "tracks.json"))
	if err != nil {
		return nil, nil
	}
	var tf trackFile
	if json.Unmarshal(b, &tf) != nil {
		return nil, nil
	}
	for i := range tf.Subtitles {
		tf.Subtitles[i].URL = "/media/" + strconv.FormatInt(id, 10) + "/" + tf.Subtitles[i].URL
		tf.Subtitles[i].Label = trackTitle(tf.Subtitles[i].Label) // films probed before trackTitle
	}
	for i := range tf.Audio {
		tf.Audio[i].Label = trackTitle(tf.Audio[i].Label)
	}
	return tf.Audio, tf.Subtitles
}

var langRE = regexp.MustCompile(`^[a-z]{2,3}$`)

// iso639 maps the three-letter codes films are tagged with to the two-letter codes
// browsers name languages by. Unknown codes pass through; "und" means untagged.
var iso639 = map[string]string{
	"eng": "en", "fre": "fr", "fra": "fr", "ger": "de", "deu": "de", "spa": "es", "ita": "it", "por": "pt",
	"rus": "ru", "jpn": "ja", "kor": "ko", "chi": "zh", "zho": "zh", "ara": "ar", "hin": "hi", "dut": "nl",
	"nld": "nl", "swe": "sv", "nor": "no", "nob": "no", "dan": "da", "fin": "fi", "pol": "pl", "tur": "tr",
	"gre": "el", "ell": "el", "heb": "he", "hun": "hu", "cze": "cs", "ces": "cs", "rum": "ro", "ron": "ro",
	"tha": "th", "vie": "vi", "ind": "id", "may": "ms", "msa": "ms", "ukr": "uk", "per": "fa", "fas": "fa",
	"yor": "yo", "ibo": "ig", "hau": "ha", "swa": "sw", "amh": "am", "zul": "zu", "afr": "af", "bul": "bg",
	"hrv": "hr", "srp": "sr", "slv": "sl", "slo": "sk", "slk": "sk", "cat": "ca", "baq": "eu", "eus": "eu",
	"glg": "gl", "ice": "is", "isl": "is", "lit": "lt", "lav": "lv", "est": "et", "tam": "ta", "tel": "te",
	"ben": "bn", "urd": "ur", "fil": "fil", "tgl": "tl",
}

func NormLang(tag string) string {
	tag = strings.ToLower(strings.TrimSpace(tag))
	if two, ok := iso639[tag]; ok {
		return two
	}
	if tag == "und" || !langRE.MatchString(tag) {
		return ""
	}
	return tag
}

// Release groups often stamp the whole release name into every stream's title ("GalaxyRG -
// Film.2023.1080p.WEBRip.x264"); shown as a track name that's noise. Keep real labels
// ("Commentary", "English 5.1", "Director's cut"); drop release names.
var releaseRE = regexp.MustCompile(`(?i)(\bx\.?26[45]\b|\bh\.?26[45]\b|\b\d{3,4}p\b|web-?dl|webrip|blu-?ray|brrip|hdrip|dvdrip|\.(mkv|mp4|avi)\b|\byts\b|rarbg|galaxyrg|\bpsa\b)`)

func trackTitle(t string) string {
	t = strings.TrimSpace(t)
	if len(t) > 40 || releaseRE.MatchString(t) || strings.Count(t, ".") >= 3 {
		return ""
	}
	return t
}
