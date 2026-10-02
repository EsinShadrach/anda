package rooms

import (
	"slices"
	"testing"
	"time"

	"anda/internal/protocol"
)

func TestPartyLookInDoesNotCount(t *testing.T) {
	var p party
	t0 := time.Unix(1000, 0)
	if _, ok := p.update(t0, []string{"rafe", "chimamanda"}, nil, 0); ok {
		t.Fatal("event the moment two people meet")
	}
	if _, ok := p.update(t0.Add(30*time.Second), []string{"rafe"}, nil, 0); ok {
		t.Fatal("an end without a start")
	}
	if _, ok := p.update(t0.Add(5*time.Minute), []string{"rafe"}, nil, 0); ok {
		t.Fatal("event with one person")
	}
}

func TestPartyStartsAndEnds(t *testing.T) {
	var p party
	sintel := &protocol.Media{Title: "Sintel", Duration: 888}
	t0 := time.Unix(1000, 0)

	p.update(t0, []string{"rafe", "chimamanda"}, nil, 0)
	if _, ok := p.update(t0.Add(50*time.Second), []string{"rafe", "chimamanda"}, sintel, 0); ok {
		t.Fatal("started before a minute together")
	}
	ev, ok := p.update(t0.Add(time.Minute), []string{"rafe", "chimamanda"}, sintel, 12)
	if !ok || !ev.Started {
		t.Fatalf("no start after a minute: %+v %v", ev, ok)
	}
	if !slices.Equal(ev.People, []string{"rafe", "chimamanda"}) || !slices.Equal(ev.Films, []string{"Sintel"}) || ev.Position != 12 {
		t.Fatalf("start = %+v", ev)
	}
	if _, ok := p.update(t0.Add(2*time.Minute), []string{"rafe", "chimamanda"}, sintel, 72); ok {
		t.Fatal("started twice")
	}

	// tobi drops in, the film changes, tobi leaves: still the same party.
	tears := &protocol.Media{Title: "Tears of Steel", Duration: 734}
	p.update(t0.Add(3*time.Minute), []string{"rafe", "chimamanda", "tobi"}, sintel, 130)
	p.update(t0.Add(20*time.Minute), []string{"rafe", "chimamanda", "tobi"}, tears, 4)
	if _, ok := p.update(t0.Add(30*time.Minute), []string{"rafe", "chimamanda"}, tears, 600); ok {
		t.Fatal("event when one of three left")
	}

	// The film ends and the room goes back to the start before they leave: the email should
	// still say how far they got.
	p.update(t0.Add(80*time.Minute), []string{"rafe", "chimamanda"}, tears, 700)
	ev, ok = p.update(t0.Add(90*time.Minute), []string{"chimamanda"}, tears, 0)
	if !ok || ev.Started {
		t.Fatalf("no end when down to one: %+v %v", ev, ok)
	}
	if !slices.Equal(ev.People, []string{"rafe", "chimamanda", "tobi"}) ||
		!slices.Equal(ev.Films, []string{"Sintel", "Tears of Steel"}) ||
		!slices.Equal(ev.Stayed, []string{"chimamanda"}) ||
		ev.Length != 90*time.Minute || ev.Position != 700 || ev.Duration != 734 {
		t.Fatalf("end = %+v", ev)
	}

	// The next time two people meet is a new party.
	p.update(t0.Add(2*time.Hour), []string{"chimamanda", "tobi"}, nil, 0)
	ev, ok = p.update(t0.Add(2*time.Hour+time.Minute), []string{"chimamanda", "tobi"}, nil, 0)
	if !ok || !ev.Started || len(ev.Films) != 0 || !slices.Equal(ev.People, []string{"chimamanda", "tobi"}) {
		t.Fatalf("second party = %+v %v", ev, ok)
	}
}
