// Package site serves the web app: the Next.js static export (web/out), copied into the
// API's image. It replaces a separate nginx container, one fewer process on a VM shared with
// Pulse. Same rules as that nginx: clean URLs (/room -> room.html), hashed build assets
// cached forever, everything else revalidated, and 404.html for anything missing.
package site

import (
	"io/fs"
	"net/http"
	"os"
	"path"
	"strings"
)

type Handler struct {
	Dir string // the export's root, e.g. /srv/web
}

func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// Unknown API and media paths are not pages.
	if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/media/") {
		http.NotFound(w, r)
		return
	}
	// os.Root keeps every lookup inside the export, whatever the path says.
	root, err := os.OpenRoot(h.Dir)
	if err != nil {
		http.Error(w, "site unavailable", http.StatusServiceUnavailable)
		return
	}
	defer root.Close()

	p := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if strings.HasPrefix(p, "_next/static/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	candidates := []string{p, p + ".html", path.Join(p, "index.html")}
	if p == "" {
		candidates = []string{"index.html"}
	}
	for _, name := range candidates {
		if serveFile(w, r, root, name, http.StatusOK) {
			return
		}
	}
	w.Header().Set("Cache-Control", "no-cache")
	if !serveFile(w, r, root, "404.html", http.StatusNotFound) {
		http.NotFound(w, r)
	}
}

// serveFile serves name if it's a regular file, and reports whether it did.
func serveFile(w http.ResponseWriter, r *http.Request, root *os.Root, name string, status int) bool {
	f, err := root.Open(name)
	if err != nil {
		return false
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	if status != http.StatusOK {
		// ServeContent would answer 200; write the error page ourselves.
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(status)
		if r.Method == http.MethodGet {
			if b, err := fs.ReadFile(root.FS(), name); err == nil {
				w.Write(b)
			}
		}
		return true
	}
	http.ServeContent(w, r, name, info.ModTime(), f)
	return true
}
