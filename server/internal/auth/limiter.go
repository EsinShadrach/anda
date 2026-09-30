package auth

import (
	"sync"
	"time"
)

// limiter counts events per key in a fixed window. In memory only: limits reset on restart,
// which is fine for a single instance (it moves to Redis with everything else at step 8).
type limiter struct {
	max    int
	window time.Duration

	mu      sync.Mutex
	entries map[string]*limitEntry
}

type limitEntry struct {
	count int
	start time.Time
}

func newLimiter(max int, window time.Duration) *limiter {
	return &limiter{max: max, window: window, entries: make(map[string]*limitEntry)}
}

// blocked reports whether key has used up its window, and how long until it resets.
func (l *limiter) blocked(key string, now time.Time) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.entries[key]
	if !ok || now.Sub(e.start) >= l.window {
		return false, 0
	}
	if e.count >= l.max {
		return true, e.start.Add(l.window).Sub(now)
	}
	return false, 0
}

func (l *limiter) add(key string, now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.entries[key]
	if !ok || now.Sub(e.start) >= l.window {
		l.entries[key] = &limitEntry{count: 1, start: now}
		return
	}
	e.count++
}

func (l *limiter) reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.entries, key)
}

func (l *limiter) sweep(now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for k, e := range l.entries {
		if now.Sub(e.start) >= l.window {
			delete(l.entries, k)
		}
	}
}
