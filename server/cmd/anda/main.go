// Command anda runs the Anda API: accounts and sessions for now, rooms and sync to come.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"anda/internal/auth"
	"anda/internal/gateway"
	"anda/internal/library"
	"anda/internal/media"
	"anda/internal/notify"
	"anda/internal/rooms"
	"anda/internal/site"
	"anda/internal/store"
	"anda/internal/torrent"
	"anda/internal/voice"
)

func main() {
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(log); err != nil {
		log.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	addr := env("ANDA_ADDR", ":8080")
	dbPath := env("ANDA_DB", "anda.db")
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return err
	}

	db, err := store.OpenSQLite(ctx, dbPath)
	if err != nil {
		return err
	}
	defer db.Close()

	authSvc := auth.New(db, db, auth.Config{
		SecureCookie: os.Getenv("ANDA_SECURE_COOKIE") == "true",
		TrustProxy:   os.Getenv("ANDA_TRUST_PROXY") == "true",
	}, log)
	go authSvc.RunJanitor(ctx)

	dataDir := filepath.Dir(dbPath)
	films := &media.Service{
		Dir:          env("ANDA_MEDIA", filepath.Join(dataDir, "media")),
		HLSDir:       env("ANDA_HLS", filepath.Join(dataDir, "hls")),
		Store:        db,
		Authenticate: authSvc.UserFromRequest,
		Log:          log,
		CacheBytes:   int64(envInt("ANDA_CACHE_GB", 10)) << 30,
		// Background 480p copies of heavy films; ANDA_LOW_RUNG=off during Pulse benchmarks.
		LowRung: os.Getenv("ANDA_LOW_RUNG") != "off",
	}
	if u := os.Getenv("ANDA_TORRENT_URL"); u != "" { // Stremio's streaming server
		films.Torrent = torrent.New(u)
	}
	roomMgr := rooms.NewManager(db, db, films, log)
	// How long before an idle viewer is asked "Still watching?" (default 3h; shorter for testing).
	if d, err := time.ParseDuration(os.Getenv("ANDA_IDLE_AFTER")); err == nil && d > 0 {
		roomMgr.IdleAfter = d
	}
	films.InUse = roomMgr.MediaInUse
	go films.Run(ctx)

	// Watch parties go to the log, and by email to ANDA_NOTIFY_EMAIL when SMTP is set up
	// (Gmail by default: the login is that address, the password an app password).
	var mailer *notify.Mailer
	if to, pass := os.Getenv("ANDA_NOTIFY_EMAIL"), os.Getenv("ANDA_SMTP_PASSWORD"); to != "" && pass != "" {
		mailer = notify.New(env("ANDA_SMTP_ADDR", "smtp.gmail.com:587"), env("ANDA_SMTP_USER", to), pass, to, log)
		go mailer.Run(ctx)
		go func() {
			cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
			defer cancel()
			if err := mailer.Check(cctx); err != nil {
				log.Error("party emails: SMTP login failed", "addr", mailer.Addr, "user", mailer.User, "err", err)
				return
			}
			log.Info("party emails on", "to", to, "smtp", mailer.Addr)
		}()
	} else if os.Getenv("ANDA_NOTIFY_EMAIL") != "" {
		log.Info("party emails off: ANDA_SMTP_PASSWORD isn't set", "to", os.Getenv("ANDA_NOTIFY_EMAIL"))
	}
	roomMgr.OnParty = func(ev rooms.PartyEvent) {
		log.Info("watch party", "room", ev.Room, "started", ev.Started, "people", ev.People, "films", ev.Films)
		if mailer != nil {
			mailer.Party(ev)
		}
	}

	lib := &library.Service{
		Catalog:      env("ANDA_CATALOG_ADDON", "https://v3-cinemeta.strem.io"),
		StreamAddons: splitList(os.Getenv("ANDA_STREAM_ADDONS")),
		// Stremio subtitle addons (comma-separated base URLs). None by default.
		SubtitleAddons: splitList(os.Getenv("ANDA_SUBTITLE_ADDONS")),
		Media:          films,
		Authenticate:   authSvc.UserFromRequest,
		Log:            log,
	}
	// Extra WebSocket origins, e.g. "localhost:3000" for the Next dev server.
	var origins []string
	if v := os.Getenv("ANDA_WS_ORIGINS"); v != "" {
		origins = strings.Split(v, ",")
	}
	gw := gateway.New(authSvc.UserFromRequest, roomMgr, origins, log)

	mux := http.NewServeMux()
	authSvc.Register(mux)
	(&rooms.Handlers{Manager: roomMgr, Users: db, Authenticate: authSvc.UserFromRequest, AllowPreview: authSvc.AllowPreview, Log: log}).Register(mux)
	gw.Register(mux)
	films.Register(mux)
	lib.Register(mux)
	(&voice.Service{
		URL:          os.Getenv("ANDA_LIVEKIT_URL"),
		Key:          os.Getenv("ANDA_LIVEKIT_KEY"),
		Secret:       os.Getenv("ANDA_LIVEKIT_SECRET"),
		InRoom:       roomMgr.InRoom,
		Authenticate: authSvc.UserFromRequest,
		Log:          log,
	}).Register(mux)
	// Everything else is the web app (the Next.js static export copied into the image).
	mux.Handle("/", site.Handler{Dir: env("ANDA_WEB", "/srv/web")})
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		if err := db.Ping(r.Context()); err != nil {
			http.Error(w, "db unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte("ok\n"))
	})

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	errc := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", addr, "db", dbPath)
		errc <- srv.ListenAndServe()
	}()

	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case <-ctx.Done():
	}
	log.Info("shutting down")
	gw.Shutdown()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if n, err := strconv.Atoi(os.Getenv(key)); err == nil && n > 0 {
		return n
	}
	return fallback
}

// splitList parses a comma-separated env value, dropping blanks.
func splitList(v string) []string {
	var out []string
	for s := range strings.SplitSeq(v, ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}
