package rooms

import (
	"slices"
	"time"

	"anda/internal/protocol"
)

// Presence beyond connected/disconnected: idle viewers, the end of the film, everyone
// being away, and handing the host role over. All of this runs on the room goroutine.

// active records that a member did something themselves, and brings them back from idle.
func (r *Room) active(mem *member) {
	mem.lastAction, mem.askedAt = time.Now(), time.Time{}
	if mem.status == protocol.StatusAway && mem.sender != nil { // idle-away, still connected
		mem.status = protocol.StatusOnline
		r.broadcast(protocol.TypeMemberUpdate, protocol.MemberUpdate{UserID: mem.user.ID, Username: mem.user.Username, Status: mem.status})
	}
}

// stillHere is the answer to "Still watching?".
func (r *Room) stillHere(userID int64) {
	if mem, ok := r.members[userID]; ok {
		r.active(mem)
	}
}

// tick runs every TickEvery: the film reaching its end, "Still watching?" for people idle
// for hours, and marking the ones who don't answer as away.
func (r *Room) tick(now time.Time) {
	p := &r.pb
	if p.running() {
		r.savePlayback(now, false)
	}
	if p.running() && p.media.Duration > 0 && p.position(now) >= p.media.Duration-0.25 {
		p.reanchor(now)
		p.pos = p.media.Duration
		p.want = protocol.WantPaused
		for uid, reason := range p.blockers {
			if reason == protocol.BlockGettingReady {
				delete(p.blockers, uid)
			}
		}
		r.mark(now, 0, "ended")
		r.publish(now, 0, "ended", false)
		for _, m := range r.members {
			r.ask(m, now)
		}
	}

	changed := false
	for _, m := range r.members {
		if m.sender == nil || m.status != protocol.StatusOnline {
			continue
		}
		switch {
		case m.askedAt.IsZero() && p.media != nil && now.Sub(m.lastAction) >= r.m.IdleAfter:
			r.ask(m, now)
		case !m.askedAt.IsZero() && now.Sub(m.askedAt) >= r.m.AnswerWithin:
			// No answer: away, and not waited for. Their player stops on its own.
			m.status = protocol.StatusAway
			r.broadcast(protocol.TypeMemberUpdate, protocol.MemberUpdate{UserID: m.user.ID, Username: m.user.Username, Status: m.status})
			r.dropBlocker(m.user.ID)
			changed = true
		}
	}
	if changed {
		r.pauseIfAllAway()
	}
	r.updateParty(now)
}

// ask sends "Still watching?" to a connected member who isn't already being asked.
func (r *Room) ask(m *member, now time.Time) {
	if m.sender == nil || m.status != protocol.StatusOnline || !m.askedAt.IsZero() {
		return
	}
	m.askedAt = now
	m.sender.Send(protocol.Encode(protocol.TypeStillThere, nil))
}

// pauseIfAllAway pauses a playing film once nobody in the room is online (plan: "Everyone
// away: pause the room automatically").
func (r *Room) pauseIfAllAway() {
	p := &r.pb
	if p.media == nil || p.want != protocol.WantPlaying || len(r.members) == 0 {
		return
	}
	for _, m := range r.members {
		if m.status == protocol.StatusOnline {
			return
		}
	}
	now := time.Now()
	p.reanchor(now)
	p.want = protocol.WantPaused
	for uid, reason := range p.blockers {
		if reason == protocol.BlockGettingReady {
			delete(p.blockers, uid)
		}
	}
	r.mark(now, 0, "all_away")
	r.publish(now, 0, "all_away", false)
}

// hostTransfer lets the host hand over to someone else in the room.
func (r *Room) hostTransfer(userID int64, s Sender, in protocol.HostTransfer) {
	if userID != r.host {
		r.reject(s, "not_host", protocol.TypeHostTransfer, r.host)
		return
	}
	target, ok := r.members[in.UserID]
	if !ok || in.UserID == userID {
		s.Send(protocol.EncodeError(protocol.ErrBadMessage, "They're not in the room."))
		return
	}
	r.active(r.members[userID])
	r.host = target.user.ID
	r.broadcast(protocol.TypeHostChanged, protocol.HostChanged{Host: r.host})
}

// react floats a reaction over everyone else's screen (the sender shows their own at once).
// Over the rate limit they're dropped quietly: a reaction isn't worth an error.
func (r *Room) react(userID int64, s Sender, in protocol.ReactionSend) {
	mem, ok := r.members[userID]
	if !ok || !slices.Contains(protocol.Reactions, in.Kind) {
		return
	}
	now := time.Now()
	mem.reactTokens = min(reactBurst, mem.reactTokens+now.Sub(mem.reactAt).Seconds()/reactRefill.Seconds())
	mem.reactAt = now
	if mem.reactTokens < 1 {
		return
	}
	mem.reactTokens--
	r.active(mem)
	r.broadcastExcept(s, protocol.TypeReaction, protocol.Reaction{By: mem.user, Kind: in.Kind})
}

// typing tells everyone else that userID's composer has text in it, or doesn't any more.
// Repeats closer than typingEvery are dropped, so a chatty client can't flood the room.
func (r *Room) typing(userID int64, s Sender, in protocol.TypingSend) {
	mem, ok := r.members[userID]
	if !ok || (!in.Active && !mem.typing) {
		return
	}
	now := time.Now()
	if in.Active && mem.typing && now.Sub(mem.typingAt) < typingEvery {
		return
	}
	mem.typing, mem.typingAt = in.Active, now
	if in.Active {
		r.active(mem)
	}
	r.broadcastExcept(s, protocol.TypeTyping, protocol.Typing{By: mem.user, Active: in.Active})
}
