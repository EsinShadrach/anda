package gateway

import (
	"testing"
	"time"

	"anda/internal/protocol"
	"anda/internal/rooms"
)

func quickIdle(m *rooms.Manager) {
	m.IdleAfter = 300 * time.Millisecond
	m.AnswerWithin = 400 * time.Millisecond
	m.TickEvery = 50 * time.Millisecond
}

func TestStillWatchingThenAway(t *testing.T) {
	host, guest, _, guestID := twoInRoomWith(t, 7, quickIdle)

	// Both are asked; only the host answers.
	host.expect(protocol.TypeStillThere, nil)
	guest.expect(protocol.TypeStillThere, nil)
	host.send(protocol.TypeStillHere, nil)

	var mu protocol.MemberUpdate
	host.expect(protocol.TypeMemberUpdate, &mu)
	if mu.UserID != guestID || mu.Status != protocol.StatusAway {
		t.Fatalf("unanswered: %+v", mu)
	}
	// Answering later brings her back.
	guest.send(protocol.TypeStillHere, nil)
	host.expect(protocol.TypeMemberUpdate, &mu)
	if mu.UserID != guestID || mu.Status != protocol.StatusOnline {
		t.Fatalf("answered: %+v", mu)
	}
}

func TestEveryoneAwayPausesTheRoom(t *testing.T) {
	host, guest, seq, _ := twoInRoomWith(t, 7, quickIdle)
	playing(t, host, guest, seq)

	// Nobody answers "Still watching?": once both are away the room pauses itself.
	for {
		u := host.update()
		if u.Action == "all_away" {
			if u.Want != protocol.WantPaused || u.Position <= 0 {
				t.Fatalf("all away: %+v", u)
			}
			return
		}
	}
}

func TestHostTransfer(t *testing.T) {
	host, guest, _, guestID := twoInRoomWith(t, 7, nil)

	guest.send(protocol.TypeHostTransfer, protocol.HostTransfer{UserID: guestID})
	var r protocol.ActionRejected
	guest.expect(protocol.TypeActionRejected, &r)
	if r.Reason != "not_host" {
		t.Fatalf("guest transfer: %+v", r)
	}

	host.send(protocol.TypeHostTransfer, protocol.HostTransfer{UserID: guestID})
	var hc protocol.HostChanged
	for _, c := range []*client{host, guest} {
		c.expect(protocol.TypeHostChanged, &hc)
		if hc.Host != guestID {
			t.Fatalf("host changed: %+v", hc)
		}
	}
	// The old host can't pick films any more; the new one can.
	host.send(protocol.TypeSetMedia, protocol.SetMedia{StreamID: 8})
	host.expect(protocol.TypeActionRejected, &r)
	guest.send(protocol.TypeSetMedia, protocol.SetMedia{StreamID: 8})
	if u := host.update(); u.Media == nil || u.Media.ID != 8 {
		t.Fatalf("new host set_media: %+v", u)
	}
}

func TestSwitchReleaseCarriesOn(t *testing.T) {
	host, guest, seq, _ := twoInRoomWith(t, 7, nil)
	playing(t, host, guest, seq)

	host.send(protocol.TypeSetMedia, protocol.SetMedia{StreamID: 8, Position: 42})
	u := guest.update()
	if u.Action != "switch" || u.Media == nil || u.Media.ID != 8 || u.Position != 42 ||
		u.Want != protocol.WantPlaying || len(u.Blockers) != 2 {
		t.Fatalf("switch: %+v", u)
	}
}

func TestEndOfFilm(t *testing.T) {
	host, guest, seq, _ := twoInRoomWith(t, 9, func(m *rooms.Manager) { m.TickEvery = 50 * time.Millisecond })
	playing(t, host, guest, seq)

	u := guest.update()
	if u.Action != "ended" || u.Want != protocol.WantPaused || u.Position != 1 {
		t.Fatalf("end: %+v", u)
	}
	guest.expect(protocol.TypeStillThere, nil)
}
