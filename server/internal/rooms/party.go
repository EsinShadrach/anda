package rooms

import (
	"slices"
	"time"

	"anda/internal/protocol"
)

// partyAfter is how long two people have to be in a room together before it counts as a
// watch party: a quick look-in doesn't, and the host has had a moment to put a film on.
// Leaving already waits out the away grace, so a dropped connection doesn't end one.
const partyAfter = time.Minute

// PartyEvent says a watch party started or ended. The Manager's OnParty hears them.
type PartyEvent struct {
	Room    string   // the room code
	Started bool     // false: it ended (fewer than two people left)
	People  []string // started: who's there; ended: everyone who came, in arrival order
	Films   []string // started: what's on screen (none yet, or one); ended: everything shown
	Stayed  []string // ended: who's still in the room (at most one)

	// Started: where the film on screen is. Ended: the furthest they got in the last film
	// (rooms can rewind after a film ends). Duration is that film's length; zero if unknown.
	Position, Duration float64
	Length             time.Duration // ended: how long they were together
}

// party follows one room's people and films, and decides when a party starts and ends.
type party struct {
	together  time.Time // when the room last reached two people; zero below two
	announced bool      // the start went out, so the end will too
	people    []string
	films     []string
	furthest  float64 // the furthest point reached in the last film in films
}

// update takes who's in the room now (in arrival order) and what's on screen, and returns
// an event when a party starts or ends.
func (p *party) update(now time.Time, present []string, film *protocol.Media, pos float64) (PartyEvent, bool) {
	title := ""
	var dur float64
	if film != nil {
		title, dur = film.Title, film.Duration
	}
	if len(present) < 2 {
		ended := p.announced
		ev := PartyEvent{People: p.people, Films: p.films, Stayed: slices.Clone(present),
			Position: p.furthest, Duration: dur, Length: now.Sub(p.together)}
		if title != "" && len(p.films) > 0 && p.films[len(p.films)-1] == title {
			ev.Position = max(p.furthest, pos)
		}
		*p = party{}
		return ev, ended
	}
	if p.together.IsZero() {
		p.together = now
	}
	for _, name := range present {
		if !slices.Contains(p.people, name) {
			p.people = append(p.people, name)
		}
	}
	if title != "" && (len(p.films) == 0 || p.films[len(p.films)-1] != title) {
		p.films = append(p.films, title)
		p.furthest = 0
	}
	if title != "" {
		p.furthest = max(p.furthest, pos)
	}
	if p.announced || now.Sub(p.together) < partyAfter {
		return PartyEvent{}, false
	}
	p.announced = true
	ev := PartyEvent{Started: true, People: slices.Clone(present), Position: pos, Duration: dur}
	if title != "" {
		ev.Films = []string{title}
	}
	return ev, true
}
