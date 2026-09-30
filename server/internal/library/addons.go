// Package library finds films: search and details through a Stremio catalog addon
// (Cinemeta), and streams through Stremio stream addons, filtered to what this VM can play.
// It implements the client side of the Stremio addon protocol:
// https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md
package library

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Meta is a film as a catalog addon describes it.
type Meta struct {
	ID          string   `json:"id"`
	Type        string   `json:"type"`
	Name        string   `json:"name"`
	Poster      string   `json:"poster,omitempty"`
	Background  string   `json:"background,omitempty"`
	ReleaseInfo string   `json:"releaseInfo,omitempty"`
	Year        any      `json:"year,omitempty"` // string or number, depending on the addon
	Description string   `json:"description,omitempty"`
	Runtime     string   `json:"runtime,omitempty"`
	Genres      []string `json:"genre,omitempty"`
}

func (m Meta) year() string {
	if m.ReleaseInfo != "" {
		return m.ReleaseInfo
	}
	switch y := m.Year.(type) {
	case string:
		return y
	case float64:
		return fmt.Sprintf("%.0f", y)
	}
	return ""
}

// AddonStream is a stream object from an addon's /stream resource.
type AddonStream struct {
	Name          string   `json:"name"`
	Title         string   `json:"title"`
	Description   string   `json:"description"`
	InfoHash      string   `json:"infoHash"`
	FileIdx       *int     `json:"fileIdx"`
	URL           string   `json:"url"`
	Sources       []string `json:"sources"`
	BehaviorHints struct {
		Filename  string `json:"filename"`
		VideoSize int64  `json:"videoSize"`
		// Streams that only work with extra request headers (some debrid/proxy links).
		ProxyHeaders json.RawMessage `json:"proxyHeaders"`
	} `json:"behaviorHints"`
}

type addonClient struct {
	http *http.Client
}

func newAddonClient() *addonClient {
	return &addonClient{http: &http.Client{Timeout: 10 * time.Second}}
}

// userAgent identifies Anda honestly. Some addons sit behind bot filtering that rejects
// Go's default "Go-http-client/1.1" with a 403.
const userAgent = "Anda/1.0 (Stremio addon client)"

// get fetches JSON from an addon, retrying once on a network error or 5xx (addons are
// often small free hosts that hiccup).
func (c *addonClient) get(ctx context.Context, base, path string, v any) error {
	err := c.getOnce(ctx, base, path, v)
	var se statusError
	if err != nil && ctx.Err() == nil && (!errors.As(err, &se) || se.code >= 500) {
		select {
		case <-ctx.Done():
		case <-time.After(400 * time.Millisecond):
			err = c.getOnce(ctx, base, path, v)
		}
	}
	return err
}

type statusError struct {
	code int
	msg  string
}

func (e statusError) Error() string { return e.msg }

func (c *addonClient) getOnce(ctx context.Context, base, path string, v any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(base, "/")+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return statusError{res.StatusCode, fmt.Sprintf("%s%s: %s", base, path, res.Status)}
	}
	return json.NewDecoder(http.MaxBytesReader(nil, res.Body, 8<<20)).Decode(v)
}

// search asks a catalog addon's movie catalog for a title.
func (c *addonClient) search(ctx context.Context, base, q string) ([]Meta, error) {
	var out struct {
		Metas []Meta `json:"metas"`
	}
	err := c.get(ctx, base, "/catalog/movie/top/search="+url.PathEscape(q)+".json", &out)
	return out.Metas, err
}

func (c *addonClient) meta(ctx context.Context, base, id string) (Meta, error) {
	var out struct {
		Meta Meta `json:"meta"`
	}
	err := c.get(ctx, base, "/meta/movie/"+url.PathEscape(id)+".json", &out)
	return out.Meta, err
}

func (c *addonClient) streams(ctx context.Context, base, id string) ([]AddonStream, error) {
	var out struct {
		Streams []AddonStream `json:"streams"`
	}
	err := c.get(ctx, base, "/stream/movie/"+url.PathEscape(id)+".json", &out)
	var se statusError
	if errors.As(err, &se) && se.code == http.StatusNotFound {
		return nil, nil // the addon doesn't have this film: no streams, not a failure
	}
	return out.Streams, err
}

// addonName fetches a stream addon's display name from its manifest.
func (c *addonClient) addonName(ctx context.Context, base string) string {
	var m struct {
		Name string `json:"name"`
	}
	if err := c.get(ctx, base, "/manifest.json", &m); err != nil || m.Name == "" {
		u, _ := url.Parse(base)
		if u != nil {
			return u.Host
		}
		return base
	}
	return m.Name
}
