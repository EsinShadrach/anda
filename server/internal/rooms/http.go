package rooms

import (
	"errors"
	"log/slog"
	"net/http"

	"anda/internal/httpx"
	"anda/internal/protocol"
	"anda/internal/store"
)

// Handlers serves the room HTTP endpoints. Authenticate returns the signed-in user or
// an error; it's auth.Service.UserFromRequest in production.
type Handlers struct {
	Manager      *Manager
	Users        store.Users
	Authenticate func(*http.Request) (store.User, error)
	Log          *slog.Logger
}

func (h *Handlers) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/rooms", h.create)
	mux.HandleFunc("GET /api/rooms/{code}", h.info)
	mux.HandleFunc("DELETE /api/rooms/{code}", h.end)
	mux.HandleFunc("GET /api/me/rooms", h.visited)
	mux.HandleFunc("DELETE /api/me/rooms/{code}", h.forget)
}

type roomJSON struct {
	Code   string `json:"code"`
	Owner  string `json:"owner,omitempty"`
	Online int    `json:"online"`
}

func (h *Handlers) create(w http.ResponseWriter, r *http.Request) {
	u, err := h.Authenticate(r)
	if err != nil {
		httpx.Error(w, http.StatusUnauthorized, "not_signed_in", "Not signed in.")
		return
	}
	room, err := h.Manager.Create(r.Context(), u.ID)
	if err != nil {
		h.Log.Error("create room", "err", err)
		httpx.Error(w, http.StatusInternalServerError, "internal", "Something went wrong.")
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"room": roomJSON{Code: room.Code, Owner: u.Username}})
}

func (h *Handlers) info(w http.ResponseWriter, r *http.Request) {
	if _, err := h.Authenticate(r); err != nil {
		httpx.Error(w, http.StatusUnauthorized, "not_signed_in", "Not signed in.")
		return
	}
	room, err := h.Manager.Lookup(r.Context(), r.PathValue("code"))
	if errors.Is(err, ErrNotFound) {
		httpx.Error(w, http.StatusNotFound, "room_not_found", "No room with that code.")
		return
	}
	if err != nil {
		h.Log.Error("lookup room", "err", err)
		httpx.Error(w, http.StatusInternalServerError, "internal", "Something went wrong.")
		return
	}
	out := roomJSON{Code: room.Code, Online: h.Manager.Online(room.Code)}
	if owner, err := h.Users.UserByID(r.Context(), room.OwnerID); err == nil {
		out.Owner = owner.Username
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"room": out})
}

type visitJSON struct {
	Code         string `json:"code"`
	Owner        string `json:"owner"`
	Mine         bool   `json:"mine"` // the viewer owns it, so they can end it
	Online       int    `json:"online"`
	Film         string `json:"film,omitempty"`
	CreatedAt    int64  `json:"created_at"`     // unix ms
	LastJoinedAt int64  `json:"last_joined_at"` // unix ms
}

func (h *Handlers) visited(w http.ResponseWriter, r *http.Request) {
	u, err := h.Authenticate(r)
	if err != nil {
		httpx.Error(w, http.StatusUnauthorized, "not_signed_in", "Not signed in.")
		return
	}
	visits, err := h.Manager.Visited(r.Context(), u.ID)
	if err != nil {
		h.Log.Error("list visited rooms", "err", err)
		httpx.Error(w, http.StatusInternalServerError, "internal", "Something went wrong.")
		return
	}
	out := make([]visitJSON, len(visits))
	for i, v := range visits {
		out[i] = visitJSON{
			Code: v.Code, Owner: v.OwnerName, Mine: v.OwnerID == u.ID, Online: v.Online, Film: v.Film,
			CreatedAt: v.CreatedAt.UnixMilli(), LastJoinedAt: v.LastJoinedAt.UnixMilli(),
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"rooms": out})
}

func (h *Handlers) end(w http.ResponseWriter, r *http.Request) {
	u, err := h.Authenticate(r)
	if err != nil {
		httpx.Error(w, http.StatusUnauthorized, "not_signed_in", "Not signed in.")
		return
	}
	err = h.Manager.End(r.Context(), r.PathValue("code"), protocol.User{ID: u.ID, Username: u.Username})
	switch {
	case errors.Is(err, ErrNotFound):
		httpx.Error(w, http.StatusNotFound, "room_not_found", "No room with that code.")
	case errors.Is(err, ErrNotOwner):
		httpx.Error(w, http.StatusForbidden, "not_owner", "Only the person who started a room can end it.")
	case err != nil:
		h.Log.Error("end room", "err", err)
		httpx.Error(w, http.StatusInternalServerError, "internal", "Something went wrong.")
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

func (h *Handlers) forget(w http.ResponseWriter, r *http.Request) {
	u, err := h.Authenticate(r)
	if err != nil {
		httpx.Error(w, http.StatusUnauthorized, "not_signed_in", "Not signed in.")
		return
	}
	err = h.Manager.Forget(r.Context(), r.PathValue("code"), u.ID)
	switch {
	case errors.Is(err, ErrNotFound):
		w.WriteHeader(http.StatusNoContent) // already gone, which is what they wanted
	case err != nil:
		h.Log.Error("forget room", "err", err)
		httpx.Error(w, http.StatusInternalServerError, "internal", "Something went wrong.")
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}
