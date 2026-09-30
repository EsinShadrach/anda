package library

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"net/url"
	"strings"
)

// Direct links make the server fetch whatever URL an addon returns, so they're checked:
// http(s) only, a public hostname, and (at prepare time) every address it resolves to must
// be public. That keeps an addon from pointing the server at itself, the torrent engine,
// the VM's other services or a cloud metadata endpoint. ffmpeg is also limited to network
// protocols (media.netInput).

func urlPath(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Path
}

// plausibleURL is the cheap check done while listing streams: no DNS.
func plausibleURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
		return false
	}
	host := u.Hostname()
	if ip, err := netip.ParseAddr(host); err == nil {
		return publicAddr(ip)
	}
	// Single-label names ("torrent", "anda-api", "localhost") are internal by definition.
	return strings.Contains(host, ".") && !strings.HasSuffix(host, ".local") && !strings.HasSuffix(host, ".internal") &&
		!strings.HasSuffix(host, ".localhost")
}

var errPrivateURL = errors.New("library: that link points at a private address")

// checkURL resolves the link's host and refuses it unless every address is public.
func checkURL(ctx context.Context, raw string, lookup func(ctx context.Context, host string) ([]netip.Addr, error)) error {
	if !plausibleURL(raw) {
		return errPrivateURL
	}
	u, _ := url.Parse(raw)
	host := u.Hostname()
	if ip, err := netip.ParseAddr(host); err == nil {
		if publicAddr(ip) {
			return nil
		}
		return errPrivateURL
	}
	if lookup == nil {
		lookup = func(ctx context.Context, host string) ([]netip.Addr, error) {
			return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		}
	}
	addrs, err := lookup(ctx, host)
	if err != nil {
		return err
	}
	if len(addrs) == 0 {
		return errPrivateURL
	}
	for _, a := range addrs {
		if !publicAddr(a) {
			return errPrivateURL
		}
	}
	return nil
}

func publicAddr(ip netip.Addr) bool {
	ip = ip.Unmap()
	return ip.IsValid() && ip.IsGlobalUnicast() && !ip.IsPrivate() && !ip.IsLoopback() &&
		!ip.IsLinkLocalUnicast() && !cgnat.Contains(ip)
}

// 100.64.0.0/10 (carrier-grade NAT, also Tailscale) isn't covered by IsPrivate.
var cgnat = netip.MustParsePrefix("100.64.0.0/10")
