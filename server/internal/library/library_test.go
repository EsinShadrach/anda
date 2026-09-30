package library

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"anda/internal/protocol"
	"anda/internal/store"
)

func TestClassify(t *testing.T) {
	idx := 0
	mk := func(title, filename string, size int64) AddonStream {
		a := AddonStream{Name: "Addon", Title: title, InfoHash: "ABCDEF0123456789ABCDEF0123456789ABCDEF01", FileIdx: &idx}
		a.BehaviorHints.Filename, a.BehaviorHints.VideoSize = filename, size
		return a
	}
	cases := []struct {
		a       AddonStream
		hidden  string
		quality string
		size    int64
		seeders int
	}{
		{mk("Film.2019.1080p.WEBRip.x264.AAC-GROUP\n👤 42 💾 1.9 GB", "", 0), "", "1080p", 2040109465, 42},
		{mk("Film.2019.1080p.BluRay.x265.10bit", "", 0), "video", "1080p", 0, 0},
		{mk("Film.2019.2160p.HDR.HEVC", "", 0), "video", "2160p", 0, 0},
		{mk("Film.2019.720p.WEB-DL.DDP5.1.H264", "", 0), "", "720p", 0, 0}, // audio gets converted
		{mk("Film.2019.1080p.BluRay.DTS.x264", "", 0), "", "1080p", 0, 0},
		{mk("Film (2019) [1080p] [YTS.MX]\n💾 12 GB", "", 0), "size", "1080p", 12 << 30, 0},
		{mk("Tears of Steel", "Tears of Steel.webm", 571346576), "video", "", 571346576, 0},
		{mk("Sintel", "Sintel.mp4", 129241752), "", "", 129241752, 0},
	}
	for _, c := range cases {
		got := classify(c.a, "x")
		if got.hidden != c.hidden || got.Quality != c.quality || got.Seeders != c.seeders || (c.size != 0 && got.SizeBytes != c.size) {
			t.Errorf("%q: hidden=%q quality=%q size=%d seeders=%d", c.a.Title, got.hidden, got.Quality, got.SizeBytes, got.Seeders)
		}
		if got.infoHash != strings.ToLower(c.a.InfoHash) {
			t.Errorf("info hash not lowercased: %s", got.infoHash)
		}
	}
	noHash := mk("direct", "", 0)
	noHash.InfoHash = ""
	if classify(noHash, "x").hidden != "not a torrent" {
		t.Error("URL streams should be hidden for now")
	}
}

type fakePreparer struct{ got *store.TorrentMedia }

func (f *fakePreparer) PrepareTorrent(_ context.Context, t store.TorrentMedia, _ []string) (store.Media, error) {
	f.got = &t
	return store.Media{ID: 9, Title: t.Title, HLSState: store.HLSRemuxing}, nil
}
func (f *fakePreparer) Info(context.Context, int64) (protocol.Media, error) {
	return protocol.Media{}, nil
}

func TestHandlers(t *testing.T) {
	// One fake addon serving both the catalog and streams, like Cinemeta + a stream addon.
	addon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Header.Get("User-Agent") != userAgent:
			http.Error(w, "bots go away", http.StatusForbidden)
		case r.URL.Path == "/manifest.json":
			w.Write([]byte(`{"name":"Fake Streams"}`))
		case strings.HasPrefix(r.URL.Path, "/catalog/movie/top/search="):
			w.Write([]byte(`{"metas":[{"id":"tt0000001","type":"movie","name":"Some Film","releaseInfo":"2019","poster":"https://img/p.jpg"},{"id":"tt0000002","type":"series","name":"A Show"}]}`))
		case strings.HasPrefix(r.URL.Path, "/meta/movie/"):
			w.Write([]byte(`{"meta":{"id":"tt0000001","name":"Some Film","releaseInfo":"2019","poster":"https://img/p.jpg","runtime":"101 min"}}`))
		case r.URL.Path == "/stream/movie/tt0000001.json":
			w.Write([]byte(`{"streams":[
				{"name":"Fake\n720p","title":"Some.Film.720p.x264.AAC\n👤 10 💾 800 MB","infoHash":"1111111111111111111111111111111111111111","fileIdx":0},
				{"name":"Fake\n1080p","title":"Some.Film.1080p.x264.AAC\n👤 50 💾 1.5 GB","infoHash":"2222222222222222222222222222222222222222","fileIdx":1},
				{"name":"Fake\n1080p","title":"Some.Film.1080p.x265.HEVC\n👤 90","infoHash":"3333333333333333333333333333333333333333","fileIdx":0},
				{"name":"Fake\n2160p","title":"Some.Film.2160p.x264\n💾 22 GB","infoHash":"4444444444444444444444444444444444444444","fileIdx":0}
			]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer addon.Close()

	prep := &fakePreparer{}
	s := &Service{
		Catalog: addon.URL, StreamAddons: []string{addon.URL}, Media: prep,
		Authenticate: func(*http.Request) (store.User, error) { return store.User{ID: 1}, nil },
		Log:          slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	mux := http.NewServeMux()
	s.Register(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	call := func(method, path string, v any) int {
		req, _ := http.NewRequest(method, srv.URL+path, nil)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if v != nil {
			json.NewDecoder(res.Body).Decode(v)
		}
		return res.StatusCode
	}

	var search struct{ Films []Film }
	call("GET", "/api/library/search?q=", &search)
	if len(search.Films) != len(openFilms) || !search.Films[0].Free {
		t.Fatalf("empty search should suggest the open films: %+v", search.Films)
	}
	call("GET", "/api/library/search?q=some", &search)
	if len(search.Films) != 1 || search.Films[0].ID != "tt0000001" || search.Films[0].Year != "2019" {
		t.Fatalf("search (series dropped): %+v", search.Films)
	}

	var st struct {
		Meta    metaJSON
		Streams []Stream
		Hidden  map[string]int
	}
	call("GET", "/api/library/tt0000001/streams", &st)
	if st.Meta.Name != "Some Film" || st.Meta.Runtime != "101 min" {
		t.Fatalf("meta: %+v", st.Meta)
	}
	if len(st.Streams) != 2 || st.Streams[0].Quality != "1080p" || st.Streams[0].Source != "Fake Streams" || st.Hidden["video"] != 1 || st.Hidden["size"] != 1 {
		t.Fatalf("streams: %+v hidden: %+v", st.Streams, st.Hidden)
	}

	// Only a listed, visible stream can be prepared.
	if code := call("POST", "/api/library/tt0000001/streams/3333333333333333333333333333333333333333-0/prepare", nil); code != 404 {
		t.Fatalf("hidden stream prepare: %d", code)
	}
	if code := call("POST", "/api/library/tt0000001/streams/deadbeef-0/prepare", nil); code != 404 {
		t.Fatalf("unknown stream prepare: %d", code)
	}
	var prepared struct{ Film struct{ ID int64 } }
	if code := call("POST", "/api/library/tt0000001/streams/"+st.Streams[0].Key+"/prepare", &prepared); code != 202 || prepared.Film.ID != 9 {
		t.Fatalf("prepare: %d %+v", code, prepared)
	}
	if prep.got == nil || prep.got.InfoHash != "2222222222222222222222222222222222222222" || prep.got.FileIdx != 1 || prep.got.Title != "Some Film" {
		t.Fatalf("prepared: %+v", prep.got)
	}

	// A source that refuses is named, not silently empty; the rest still answer.
	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/manifest.json" {
			w.Write([]byte(`{"name":"Broken Source"}`))
			return
		}
		http.Error(w, "nope", http.StatusForbidden)
	}))
	defer broken.Close()
	s.StreamAddons = append(s.StreamAddons, broken.URL)
	var st2 struct {
		Streams []Stream
		Failed  []string
	}
	call("GET", "/api/library/tt1254207/streams", &st2)
	if len(st2.Failed) != 1 || st2.Failed[0] != "Broken Source" || len(st2.Streams) != 1 {
		t.Fatalf("failed source: %+v", st2)
	}

	// The built-in open films answer without any addon.
	call("GET", "/api/library/tt1727587/streams", &st)
	if len(st.Streams) != 1 || st.Streams[0].Source != openSourceName {
		t.Fatalf("open film streams: %+v", st.Streams)
	}
	call("GET", "/api/library/tt2285752/streams", &st)
	if len(st.Streams) != 0 || st.Hidden["video"] != 1 {
		t.Fatalf("Tears of Steel (WebM) should be hidden: %+v %+v", st.Streams, st.Hidden)
	}
}
