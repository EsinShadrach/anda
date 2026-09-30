// Package httpx holds the small JSON helpers shared by the HTTP handlers.
package httpx

import (
	"encoding/json"
	"net/http"
	"strings"
)

// Decode reads a small JSON body. Requiring application/json also means a cross-site
// HTML form can't post here, on top of the SameSite=Lax cookie.
func Decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		Error(w, http.StatusUnsupportedMediaType, "bad_content_type", "Expected application/json.")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		Error(w, http.StatusBadRequest, "bad_request", "Invalid JSON body.")
		return false
	}
	return true
}

func Error(w http.ResponseWriter, status int, code, msg string) {
	JSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
