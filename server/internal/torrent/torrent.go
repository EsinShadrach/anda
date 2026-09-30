// Package torrent talks to Stremio's streaming server (the "torrent" container), which
// downloads a torrent on demand and serves any file in it as a seekable HTTP stream.
// Endpoints used (checked against stremio/server): POST /{hash}/create, GET /{hash}/{idx}
// (the stream, with Range), GET /{hash}/{idx}/stats.json, GET /{hash}/remove.
package torrent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var infoHashRE = regexp.MustCompile(`^[0-9a-f]{40}$`)

// ValidInfoHash reports whether h is a lowercase hex v1 info hash.
func ValidInfoHash(h string) bool { return infoHashRE.MatchString(h) }

type Client struct {
	Base string // e.g. http://torrent:11470
	HTTP *http.Client
}

func New(base string) *Client {
	return &Client{Base: strings.TrimRight(base, "/"), HTTP: &http.Client{Timeout: 30 * time.Second}}
}

// Create starts (or reuses) the engine for a torrent. Trackers are optional extra peer
// sources ("tracker:udp://..." or "dht:<hash>"), as Stremio addons provide them.
func (c *Client) Create(ctx context.Context, infoHash string, sources []string) error {
	if !ValidInfoHash(infoHash) {
		return fmt.Errorf("torrent: bad info hash %q", infoHash)
	}
	body := map[string]any{"torrent": map[string]string{"infoHash": infoHash}}
	if len(sources) > 0 {
		body["peerSearch"] = map[string]any{"sources": append(sources, "dht:"+infoHash), "min": 40, "max": 150}
	}
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Base+"/"+infoHash+"/create", bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("torrent create: %w", err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("torrent create: %s", res.Status)
	}
	return nil
}

// StreamURL is where ffmpeg/ffprobe read the file; reading drives the download.
func (c *Client) StreamURL(infoHash string, fileIdx int) string {
	return c.Base + "/" + infoHash + "/" + strconv.Itoa(fileIdx)
}

type Stats struct {
	Peers         int     `json:"peers"`
	Downloaded    int64   `json:"downloaded"`
	DownloadSpeed float64 `json:"downloadSpeed"` // bytes/s
	StreamLen     int64   `json:"streamLen"`
	// StreamProgress is the fraction of this file downloaded, 0..1.
	StreamProgress float64 `json:"streamProgress"`
}

func (c *Client) Stats(ctx context.Context, infoHash string, fileIdx int) (Stats, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.StreamURL(infoHash, fileIdx)+"/stats.json", nil)
	if err != nil {
		return Stats{}, err
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return Stats{}, err
	}
	defer res.Body.Close()
	var s Stats
	if err := json.NewDecoder(res.Body).Decode(&s); err != nil {
		return Stats{}, fmt.Errorf("torrent stats: %w", err)
	}
	return s, nil
}

// Remove stops the engine. Stremio keeps its own bounded cache of the data; Anda's HLS copy
// is the one that matters once a film is prepared.
func (c *Client) Remove(ctx context.Context, infoHash string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.Base+"/"+infoHash+"/remove", nil)
	if err != nil {
		return err
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	res.Body.Close()
	return nil
}
