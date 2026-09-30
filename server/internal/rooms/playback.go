package rooms

import (
	"context"
	"time"

	"anda/internal/protocol"
)

const (
	// raceWindow: a stale action this soon after a contradicting change loses the race.
	raceWindow = 500 * time.Millisecond
	// readyAhead is how much a client must buffer before "getting ready" clears.
	readyAhead = 2.0
	// readyTimeout caps "getting ready" so one slow client can't hold the room forever;
	// after it they catch up (or block again as buffering if they keep stalling).
	readyTimeout = 8 * time.Second
	// switchReadyTimeout is much longer: a newly picked torrent release is prepared from
	// its start, so it has to download up to the room's position before anyone can play
	// on. Everyone waits on the same download, so there's no one slow client to cut loose.
	switchReadyTimeout = 10 * time.Minute
	// stallGrace: short stalls don't pause the room; the client catches up at up to 1.1x.
	stallGrace = 3 * time.Second
	// recoverAhead is how much a buffering client must hold again to stop blocking.
	recoverAhead = 3.0
	// skipWaitFor is how long "don't wait" keeps someone from blocking again.
	skipWaitFor = 30 * time.Second

	seekBurst  = 4
	seekRefill = 700 * time.Millisecond

	reportBurst  = 5
	reportRefill = 300 * time.Millisecond
)

// playback is the room's single source of truth. Want is what people asked for; blockers
// are what's in the way. The film runs only when people want it playing and nothing blocks,
// so buffering never overwrites a manual pause.
type playback struct {
	media    *protocol.Media
	want     string
	pos      float64   // film position at anchor
	anchor   time.Time // server time when pos was true
	rate     float64
	seq      int64
	blockers map[int64]string // userID → reason
	locked   bool
	readyGen int // bumped each time "getting ready" starts, so stale timeouts do nothing

	// The last change, for race detection and action_rejected.
	lastAt     time.Time
	lastBy     int64
	lastAction string
}

func newPlayback() playback {
	return playback{want: protocol.WantPaused, rate: 1, blockers: map[int64]string{}}
}

func (p *playback) running() bool {
	return p.media != nil && p.want == protocol.WantPlaying && len(p.blockers) == 0
}

func (p *playback) position(now time.Time) float64 {
	if !p.running() {
		return p.pos
	}
	return p.pos + now.Sub(p.anchor).Seconds()*p.rate
}

// reanchor freezes the current position; call it before anything that changes running().
func (p *playback) reanchor(now time.Time) {
	p.pos = p.position(now)
	p.anchor = now
}

func (p *playback) state(now time.Time) *protocol.PlaybackState {
	if p.media == nil {
		return nil
	}
	return &protocol.PlaybackState{Want: p.want, Position: p.position(now), Rate: p.rate, ServerTime: protocol.UnixMs(now)}
}

// contradicts reports whether action undoes the last change: play vs pause, or a second
// seek on top of a first.
func contradicts(action, last string) bool {
	if action == protocol.TypeSeek {
		return last == protocol.TypeSeek
	}
	return (action == protocol.TypePlay && last == protocol.TypePause) ||
		(action == protocol.TypePause && last == protocol.TypePlay)
}

// --- Room handlers (all run on the room goroutine) ---

func (r *Room) blockerList() []protocol.Blocker {
	out := make([]protocol.Blocker, 0, len(r.pb.blockers))
	for uid, reason := range r.pb.blockers {
		name := ""
		if m, ok := r.members[uid]; ok {
			name = m.user.Username
		}
		out = append(out, protocol.Blocker{UserID: uid, Username: name, Reason: reason})
	}
	return out
}

// publish bumps the sequence number and tells everyone.
func (r *Room) publish(now time.Time, by int64, action string, withMedia bool) {
	r.pb.seq++
	u := protocol.PlaybackUpdate{
		Seq:           r.pb.seq,
		PlaybackState: *r.pb.state(now),
		Blockers:      r.blockerList(),
		Locked:        r.pb.locked,
		Action:        action,
	}
	if m, ok := r.members[by]; ok {
		u.By = &protocol.User{ID: by, Username: m.user.Username}
	}
	if withMedia {
		u.Media = r.pb.media
	}
	r.broadcast(protocol.TypePlaybackUpdate, u)
}

func (r *Room) reject(s Sender, reason, action string, by int64) {
	rej := protocol.ActionRejected{Reason: reason, Action: action}
	if m, ok := r.members[by]; ok {
		rej.By = &protocol.User{ID: by, Username: m.user.Username}
	}
	s.Send(protocol.Encode(protocol.TypeActionRejected, rej))
}

// control checks the shared rules for play/pause/seek and reports whether to proceed.
func (r *Room) control(userID int64, s Sender, action string, lastSeq int64, now time.Time) bool {
	if _, ok := r.members[userID]; !ok {
		s.Send(protocol.EncodeError(protocol.ErrNotInRoom, "Join the room first."))
		return false
	}
	if r.pb.media == nil {
		r.reject(s, "no_media", action, 0)
		return false
	}
	if r.pb.locked && userID != r.host {
		r.reject(s, "locked", action, r.host)
		return false
	}
	if lastSeq < r.pb.seq && now.Sub(r.pb.lastAt) < raceWindow && r.pb.lastBy != userID && contradicts(action, r.pb.lastAction) {
		r.reject(s, "race", r.pb.lastAction, r.pb.lastBy)
		return false
	}
	return true
}

func (r *Room) mark(now time.Time, by int64, action string) {
	r.pb.lastAt, r.pb.lastBy, r.pb.lastAction = now, by, action
	if mem, ok := r.members[by]; ok {
		r.active(mem)
	}
}

// startGettingReady blocks on every connected member until they've buffered, capped by
// readyTimeout. Used when the room starts playing or jumps somewhere new.
func (r *Room) startGettingReady(now time.Time, timeout time.Duration) {
	r.pb.readyGen++
	gen := r.pb.readyGen
	for uid, m := range r.members {
		if m.status != protocol.StatusOnline || now.Before(m.skipUntil) {
			continue
		}
		if _, blocked := r.pb.blockers[uid]; !blocked {
			r.pb.blockers[uid] = protocol.BlockGettingReady
		}
	}
	time.AfterFunc(timeout, func() {
		r.do(func() {
			if r.pb.readyGen != gen {
				return
			}
			now := time.Now()
			changed := false
			for uid, reason := range r.pb.blockers {
				if reason == protocol.BlockGettingReady {
					if !changed {
						r.pb.reanchor(now)
						changed = true
					}
					delete(r.pb.blockers, uid)
				}
			}
			if changed {
				r.publish(now, 0, "blockers", false)
			}
		})
	})
}

func (r *Room) play(userID int64, s Sender, in protocol.Play) {
	now := time.Now()
	if !r.control(userID, s, protocol.TypePlay, in.LastSeq, now) {
		return
	}
	if r.pb.want == protocol.WantPlaying {
		return // already wanted; nothing to change
	}
	r.pb.reanchor(now)
	r.pb.want = protocol.WantPlaying
	r.startGettingReady(now, readyTimeout)
	r.mark(now, userID, protocol.TypePlay)
	r.publish(now, userID, protocol.TypePlay, false)
}

func (r *Room) pause(userID int64, s Sender, in protocol.Pause) {
	now := time.Now()
	if !r.control(userID, s, protocol.TypePause, in.LastSeq, now) {
		return
	}
	if r.pb.want == protocol.WantPaused {
		return
	}
	r.pb.reanchor(now)
	r.pb.want = protocol.WantPaused
	// Nobody needs to get ready for a paused film; real buffering blockers stay visible.
	for uid, reason := range r.pb.blockers {
		if reason == protocol.BlockGettingReady {
			delete(r.pb.blockers, uid)
		}
	}
	r.mark(now, userID, protocol.TypePause)
	r.publish(now, userID, protocol.TypePause, false)
}

func (r *Room) seek(userID int64, s Sender, in protocol.Seek) {
	now := time.Now()
	mem, ok := r.members[userID]
	if ok {
		mem.seekTokens = min(seekBurst, mem.seekTokens+now.Sub(mem.seekAt).Seconds()/seekRefill.Seconds())
		mem.seekAt = now
		if mem.seekTokens < 1 {
			r.reject(s, "rate_limited", protocol.TypeSeek, userID)
			return
		}
	}
	if !r.control(userID, s, protocol.TypeSeek, in.LastSeq, now) {
		return
	}
	mem.seekTokens--
	r.pb.reanchor(now)
	r.pb.pos = max(0, in.Position)
	r.pb.anchor = now
	if r.pb.want == protocol.WantPlaying {
		r.startGettingReady(now, readyTimeout)
	}
	r.mark(now, userID, protocol.TypeSeek)
	r.publish(now, userID, protocol.TypeSeek, false)
}

func (r *Room) setMedia(userID int64, s Sender, in protocol.SetMedia) {
	if userID != r.host {
		r.reject(s, "not_host", protocol.TypeSetMedia, r.host)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	m, err := r.m.media.Info(ctx, in.StreamID)
	if err != nil {
		s.Send(protocol.EncodeError(protocol.ErrBadMessage, "That film isn't available."))
		return
	}
	r.m.media.Touch(ctx, m.ID)
	now := time.Now()
	prev := r.pb
	r.pb = newPlayback()
	r.pb.seq, r.pb.locked = prev.seq, prev.locked
	r.pb.media = &m
	r.pb.anchor = now
	action := protocol.TypeSetMedia
	if in.Position > 0 && prev.media != nil {
		// Switching release mid-film (e.g. the torrent can't keep up): carry on from here,
		// and keep playing if the room was, once everyone has the new source buffered.
		action = "switch"
		r.pb.pos = in.Position
		if prev.want == protocol.WantPlaying {
			r.pb.want = protocol.WantPlaying
			r.startGettingReady(now, switchReadyTimeout)
		}
	}
	r.mark(now, userID, action)
	r.publish(now, userID, action, true)
	if prev.media != nil && prev.media.ID != m.ID {
		old := prev.media.ID
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			r.m.media.Release(ctx, old)
		}()
	}
}

func (r *Room) bufferReport(userID int64, in protocol.BufferReport) {
	mem, ok := r.members[userID]
	if !ok || r.pb.media == nil {
		return
	}
	now := time.Now()
	// Token bucket, not a minimum gap: a burst of real changes (stalled, then recovered)
	// must all land, while a flood gets dropped.
	mem.reportTokens = min(reportBurst, mem.reportTokens+now.Sub(mem.reportAt).Seconds()/reportRefill.Seconds())
	mem.reportAt = now
	if mem.reportTokens < 1 {
		return
	}
	mem.reportTokens--

	reason, blocked := r.pb.blockers[userID]
	changed := false
	switch {
	case blocked && reason == protocol.BlockGettingReady && in.Ahead >= readyAhead && !in.Stalling:
		r.pb.reanchor(now)
		delete(r.pb.blockers, userID)
		changed = true
	case blocked && reason == protocol.BlockBuffering && in.Ahead >= recoverAhead && !in.Stalling:
		r.pb.reanchor(now)
		delete(r.pb.blockers, userID)
		changed = true
	}

	if in.Stalling && r.pb.want == protocol.WantPlaying {
		if mem.stallSince.IsZero() {
			mem.stallSince = now
		}
		if !blocked && now.Sub(mem.stallSince) >= stallGrace && now.After(mem.skipUntil) {
			r.pb.reanchor(now)
			r.pb.blockers[userID] = protocol.BlockBuffering
			changed = true
		}
	} else if !in.Stalling {
		mem.stallSince = time.Time{}
	}
	if changed {
		r.publish(now, 0, "blockers", false)
	}
}

func (r *Room) skipWait(userID int64, s Sender, in protocol.SkipWait) {
	if userID != r.host {
		r.reject(s, "not_host", protocol.TypeSkipWait, r.host)
		return
	}
	r.active(r.members[userID])
	now := time.Now()
	if m, ok := r.members[in.UserID]; ok {
		m.skipUntil = now.Add(skipWaitFor)
		m.stallSince = time.Time{}
	}
	if _, ok := r.pb.blockers[in.UserID]; !ok {
		return
	}
	r.pb.reanchor(now)
	delete(r.pb.blockers, in.UserID)
	r.publish(now, userID, protocol.TypeSkipWait, false)
}

func (r *Room) lockControls(userID int64, s Sender, in protocol.LockControls) {
	if userID != r.host {
		r.reject(s, "not_host", protocol.TypeLockControls, r.host)
		return
	}
	r.active(r.members[userID])
	if r.pb.locked == in.Locked || r.pb.media == nil {
		r.pb.locked = in.Locked
		return
	}
	r.pb.locked = in.Locked
	r.publish(time.Now(), userID, "lock", false)
}

// dropBlocker stops waiting for someone who went away or left.
func (r *Room) dropBlocker(userID int64) {
	if _, ok := r.pb.blockers[userID]; !ok {
		return
	}
	now := time.Now()
	r.pb.reanchor(now)
	delete(r.pb.blockers, userID)
	r.publish(now, 0, "blockers", false)
}
