package library

import "strings"

// Anda's built-in stream source: Blender Foundation's open films (Creative Commons
// Attribution), via the public torrents WebTorrent hosts for testing. They're what the plan
// suggests for controlled benchmarks, and they work with no addon configured. Info hashes
// and file indexes were read from the .torrent files at webtorrent.io/torrents/.

type openFilm struct {
	IMDb     string
	Name     string
	Year     string
	InfoHash string
	FileIdx  int
	Size     int64
	File     string
}

var openFilms = []openFilm{
	{"tt1727587", "Sintel", "2010", "08ada5a7a6183aae1e09d831df6748d566095a10", 5, 129241752, "Sintel.mp4"},
	{"tt1254207", "Big Buck Bunny", "2008", "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c", 1, 276134947, "Big Buck Bunny.mp4"},
	{"tt4957236", "Cosmos Laundromat", "2015", "c9e15763f722f23e98a29decdfae341b98d53056", 4, 220087570, "Cosmos Laundromat.mp4"},
	// WebM (VP8/Vorbis): listed so the filter has something real to hide.
	{"tt2285752", "Tears of Steel", "2012", "209c8226b299b308beaf2b9cd3fb49212dbd13ec", 8, 571346576, "Tears of Steel.webm"},
}

var openTrackers = []string{
	"tracker:udp://tracker.opentrackr.org:1337/announce",
	"tracker:udp://tracker.openbittorrent.com:6969/announce",
	"tracker:udp://exodus.desync.com:6969/announce",
}

const openSourceName = "Open films"

func openStreams(id string) []AddonStream {
	for _, f := range openFilms {
		if f.IMDb != id {
			continue
		}
		idx := f.FileIdx
		s := AddonStream{
			Name:     openSourceName,
			Title:    f.File + "\nBlender Foundation · CC BY",
			InfoHash: f.InfoHash,
			FileIdx:  &idx,
			Sources:  openTrackers,
		}
		s.BehaviorHints.Filename = f.File
		s.BehaviorHints.VideoSize = f.Size
		return []AddonStream{s}
	}
	return nil
}

func isOpenFilm(id string) bool {
	for _, f := range openFilms {
		if f.IMDb == id {
			return true
		}
	}
	return false
}

// searchOpen matches the built-in films by name, so they're findable even though the
// catalog's search ranks short films poorly.
func searchOpen(q string) []openFilm {
	q = strings.ToLower(strings.TrimSpace(q))
	var out []openFilm
	for _, f := range openFilms {
		if q == "" || strings.Contains(strings.ToLower(f.Name), q) {
			out = append(out, f)
		}
	}
	return out
}
