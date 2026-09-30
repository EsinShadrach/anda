package rooms

import (
	"errors"
	"log/slog"
	"net/http"

	"anda/internal/httpx"
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
