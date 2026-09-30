package library

import (
	"cmp"
	"crypto/sha256"
	"encoding/hex"
	"path"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// Stream is a Library stream as the client sees it.
type Stream struct {
	Key       string `json:"key"` // opaque; used to prepare it
	Release   string `json:"release"`
	Source    string `json:"source"` // addon name
	Quality   string `json:"quality,omitempty"`
	SizeBytes int64  `json:"size_bytes,omitempty"`
	Seeders   int    `json:"seeders,omitempty"`
	Direct    bool   `json:"direct,omitempty"` // a direct link, not a torrent
	// Kbps estimates the stream's bitrate from its size and the film's runtime, so the host
	// can see what a slow connection will struggle with. 0 when either is unknown.
	Kbps int `json:"kbps,omitempty"`

	hidden    string // why it's filtered out, "" if shown
	infoHash  string
	fileIdx   int
	sources   []string
	sourceURL string
}

// maxSize: after the OS, Docker and the database, the cache holds 3 to 5 films (plan).
const maxSize = 4 << 30

var (
	qualityRE = regexp.MustCompile(`(?i)\b(2160p|4k|uhd|1440p|1080p|720p|576p|480p|360p)\b`)
	sizeRE    = regexp.MustCompile(`(?i)(\d+(?:[.,]\d+)?)\s*(gb|gib|mb|mib)\b`)
	seedRE    = regexp.MustCompile(`👤\s*(\d+)`)
	// Release-name markers for streams browsers can't play without transcoding, which one
	// vCPU can't do in real time. ffprobe is the final word after download starts; this
	// just keeps obvious misses off the list.
	// Audio isn't filtered: non-AAC audio is converted while remuxing (cheap, unlike video).
	videoRE = regexp.MustCompile(`(?i)(\bx\.?265\b|\bh\.?265\b|\bhevc\b|\bav1\b|\bvp9\b|\b10.?bit\b|\bhdr(10)?\b|\bdolby.?vision\b|\bdv\b|\bxvid\b|\bdivx\b)`)
	extRE   = regexp.MustCompile(`(?i)\.(webm|avi|wmv|flv|ts|m2ts)$`)
)

func classify(a AddonStream, source string) Stream {
	// Release title and file name first: they're the most specific (the leftmost match wins).
	text := strings.Join([]string{a.Title, a.BehaviorHints.Filename, a.Description, a.Name}, "\n")
	release := a.BehaviorHints.Filename
	if release == "" {
		release = strings.SplitN(strings.TrimSpace(a.Title), "\n", 2)[0]
	}
	s := Stream{Release: release, Source: source, SizeBytes: a.BehaviorHints.VideoSize}
	if m := qualityRE.FindString(text); m != "" {
		s.Quality = strings.ToLower(m)
		if s.Quality == "4k" || s.Quality == "uhd" {
			s.Quality = "2160p"
		}
	}
	if s.SizeBytes == 0 {
		if m := sizeRE.FindStringSubmatch(text); m != nil {
			n, _ := strconv.ParseFloat(strings.ReplaceAll(m[1], ",", "."), 64)
			unit := strings.ToLower(m[2])
			if strings.HasPrefix(unit, "g") {
				n *= 1 << 30
			} else {
				n *= 1 << 20
			}
			s.SizeBytes = int64(n)
		}
	}
	if m := seedRE.FindStringSubmatch(text); m != nil {
		s.Seeders, _ = strconv.Atoi(m[1])
	}
	direct := a.InfoHash == "" && a.URL != ""
	switch {
	case a.InfoHash == "" && a.URL == "":
		s.hidden = "unsupported" // e.g. YouTube or external links
	case direct && len(a.BehaviorHints.ProxyHeaders) > 0 && string(a.BehaviorHints.ProxyHeaders) != "null":
		s.hidden = "unsupported" // needs request headers ffmpeg won't be given
	case direct && !plausibleURL(a.URL):
		s.hidden = "unsupported"
	case videoRE.MatchString(text) || extRE.MatchString(a.BehaviorHints.Filename) || (direct && extRE.MatchString(urlPath(a.URL))):
		s.hidden = "video"
	case s.SizeBytes > maxSize:
		s.hidden = "size"
	}
	s.infoHash = strings.ToLower(a.InfoHash)
	if a.FileIdx != nil {
		s.fileIdx = *a.FileIdx
	}
	s.sources = a.Sources
	s.Key = s.infoHash + "-" + strconv.Itoa(s.fileIdx)
	if direct {
		s.Direct, s.sourceURL = true, a.URL
		sum := sha256.Sum256([]byte(a.URL))
		s.Key = "u-" + hex.EncodeToString(sum[:12])
		if s.Release == "" {
			s.Release = path.Base(urlPath(a.URL))
		}
	}
	return s
}

var qualityRank = map[string]int{"1080p": 5, "720p": 4, "1440p": 3, "2160p": 2, "576p": 1, "480p": 1}

// sortStreams puts the best bet first: 1080p before 4K (bandwidth is the ceiling here),
// then more seeders, then smaller files.
func sortStreams(list []Stream) {
	slices.SortStableFunc(list, func(a, b Stream) int {
		if c := cmp.Compare(qualityRank[b.Quality], qualityRank[a.Quality]); c != 0 {
			return c
		}
		if c := cmp.Compare(b.Seeders, a.Seeders); c != 0 {
			return c
		}
		return cmp.Compare(a.SizeBytes, b.SizeBytes)
	})
}

var runtimeRE = regexp.MustCompile(`(?i)(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?`)

// runtimeMinutes reads Cinemeta's runtime ("101 min", "2h 20min", "1h"); 0 if unknown.
func runtimeMinutes(s string) float64 {
	for _, m := range runtimeRE.FindAllStringSubmatch(s, -1) {
		h, _ := strconv.Atoi(m[1])
		min, _ := strconv.Atoi(m[2])
		if h > 0 || min > 0 {
			return float64(h*60 + min)
		}
	}
	return 0
}
