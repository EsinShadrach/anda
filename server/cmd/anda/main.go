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
	"syscall"
	"time"

	"anda/internal/auth"
	"anda/internal/store"
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

	mux := http.NewServeMux()
	authSvc.Register(mux)
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
