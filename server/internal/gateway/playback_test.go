package gateway

import (
	"context"
	"strconv"
	"testing"
	"time"

	"anda/internal/protocol"
	"anda/internal/rooms"
)

type fakeMedia struct{}

// Film 9 is one second long, for reaching the end.
func (fakeMedia) Info(_ context.Context, id int64) (protocol.Media, error) {
	m := protocol.Media{ID: id, Title: "Big Buck Bunny", URL: "/media/" + strconv.FormatInt(id, 10) + "/video"}
	if id == 9 {
		m.Duration = 1
	}
	return m, nil
}
func (fakeMedia) Touch(context.Context, int64)   {}
func (fakeMedia) Release(context.Context, int64) {}

// twoInRoom puts rafe (host) and chimamanda in a room with a film picked.
func twoInRoom(t *testing.T) (host, guest *client, seq int64) {
	host, guest, seq, _ = twoInRoomWith(t, 7, nil)
	return host, guest, seq
}

// twoInRoomWith is twoInRoom with film id, and a chance to tune the manager's timers
// before the room exists. It also returns chimamanda's user id.
func twoInRoomWith(t *testing.T, film int64, tune func(*rooms.Manager)) (host, guest *client, seq, guestID int64) {
	e := newEnv(t)
	if tune != nil {
		tune(e.rm)
	}
	rafe, chimamanda := e.signup("rafe"), e.signup("chimamanda")
	code := e.createRoom(rafe)
	host, guest = e.dial(rafe), e.dial(chimamanda)
	host.hello("")
	guestID = guest.hello("").UserID
	for _, c := range []*client{host, guest} {
		c.send(protocol.TypeJoinRoom, protocol.JoinRoom{Code: code})
		c.expect(protocol.TypeRoomState, nil)
	}
	host.send(protocol.TypeSetMedia, protocol.SetMedia{StreamID: film})
	var u protocol.PlaybackUpdate
	guest.expect(protocol.TypePlaybackUpdate, &u)
	if u.Media == nil || u.Media.ID != film || u.Want != protocol.WantPaused || u.Position != 0 {
		t.Fatalf("set_media: %+v", u)
	}
	host.expect(protocol.TypePlaybackUpdate, nil)
	return host, guest, u.Seq, guestID
}

// playing starts the film and has both report ready; returns the running update.
func playing(t *testing.T, host, guest *client, seq int64) protocol.PlaybackUpdate {
	t.Helper()
	host.send(protocol.TypePlay, protocol.Play{LastSeq: seq})
	host.update()
	guest.update()
	host.send(protocol.TypeBufferReport, protocol.BufferReport{Ahead: 5})
	host.update()
	guest.update()
	guest.send(protocol.TypeBufferReport, protocol.BufferReport{Ahead: 5})
	guest.update()
	u := host.update()
	if u.Want != protocol.WantPlaying || len(u.Blockers) != 0 {
		t.Fatalf("not running: %+v", u)
	}
	return u
}

// update waits for the next playback_update on c.
func (c *client) update() protocol.PlaybackUpdate {
	c.t.Helper()
	var u protocol.PlaybackUpdate
	c.expect(protocol.TypePlaybackUpdate, &u)
	return u
}

func TestPlayWaitsForEveryoneToGetReady(t *testing.T) {
	host, guest, seq := twoInRoom(t)

	host.send(protocol.TypePlay, protocol.Play{LastSeq: seq})
	u := guest.update()
	if u.Want != protocol.WantPlaying || len(u.Blockers) != 2 || u.By == nil || u.By.Username != "rafe" {
		t.Fatalf("play: %+v", u)
	}
	host.update()

	host.send(protocol.TypeBufferReport, protocol.BufferReport{Ahead: 5})
	if u = guest.update(); len(u.Blockers) != 1 || u.Blockers[0].Username != "chimamanda" {
		t.Fatalf("after host ready: %+v", u.Blockers)
	}
	host.update()
	guest.send(protocol.TypeBufferReport, protocol.BufferReport{Ahead: 5})
	if u = host.update(); len(u.Blockers) != 0 {
		t.Fatalf("after both ready: %+v", u.Blockers)
	}
	guest.update()
	// Running now: the anchored position advances with the clock.
	time.Sleep(300 * time.Millisecond)
	host.send(protocol.TypePause, protocol.Pause{LastSeq: u.Seq})
	if u = guest.update(); u.Want != protocol.WantPaused || u.Position < 0.25 || u.Position > 0.6 {
		t.Fatalf("paused at %.3f, want ~0.3: %+v", u.Position, u)
	}
}

func TestSimultaneousClicksSettleOnOne(t *testing.T) {
	host, guest, seq := twoInRoom(t)

	// Both last saw seq. Rafe's play lands first; Chimamanda's pause, sent before she saw it,
	// contradicts it within the race window and loses.
	host.send(protocol.TypePlay, protocol.Play{LastSeq: seq})
	played := host.update()
	guest.send(protocol.TypePause, protocol.Pause{LastSeq: seq})
	var rej protocol.ActionRejected
	guest.expect(protocol.TypeActionRejected, &rej)
	if rej.Reason != "race" || rej.Action != protocol.TypePlay || rej.By == nil || rej.By.Username != "rafe" {
		t.Fatalf("rejection: %+v", rej)
	}

	// After the window, a considered pause (from the latest seq) goes through.
	time.Sleep(550 * time.Millisecond)
	guest.send(protocol.TypePause, protocol.Pause{LastSeq: played.Seq})
	if u := host.update(); u.Want != protocol.WantPaused || u.By.Username != "chimamanda" {
		t.Fatalf("later pause: %+v", u)
	}
}

func TestManualPauseSurvivesBuffering(t *testing.T) {
	host, guest, seq := twoInRoom(t)
	host.send(protocol.TypePlay, protocol.Play{LastSeq: seq})
	host.update()
	guest.update()
	host.send(protocol.TypeBufferReport, protocol.BufferReport{Ahead: 5})
	guest.send(protocol.TypeBufferReport, protocol.BufferReport{Ahead: 5})
	host.update()
	u := host.update()
	if len(u.Blockers) != 0 {
		t.Fatalf("not running: %+v", u)
	}

	// Chimamanda stalls past the grace period: the room waits for her.
	guest.send(protocol.TypeBufferReport, protocol.BufferReport{Stalling: true})
	time.Sleep(3100 * time.Millisecond)
	guest.send(protocol.TypeBufferReport, protocol.BufferReport{Stalling: true})
	if u = host.update(); len(u.Blockers) != 1 || u.Blockers[0].Reason != protocol.BlockBuffering || u.Want != protocol.WantPlaying {
		t.Fatalf("buffering: %+v", u)
	}

	// Rafe pauses during the wait, then Chimamanda's buffer fills.
	host.send(protocol.TypePause, protocol.Pause{LastSeq: u.Seq})
	host.update()
	guest.send(protocol.TypeBufferReport, protocol.BufferReport{Ahead: 6})
	u = host.update()
	for u.Action != "blockers" {
		u = host.update()
	}
	if len(u.Blockers) != 0 || u.Want != protocol.WantPaused {
		t.Fatalf("pause should survive the buffering wait: %+v", u)
	}
}

func TestOnlyHostPicksAndLocks(t *testing.T) {
	host, guest, seq := twoInRoom(t)
	var rej protocol.ActionRejected
	guest.send(protocol.TypeSetMedia, protocol.SetMedia{StreamID: 8})
	guest.expect(protocol.TypeActionRejected, &rej)
	if rej.Reason != "not_host" {
		t.Fatalf("guest set_media: %+v", rej)
	}
	host.send(protocol.TypeLockControls, protocol.LockControls{Locked: true})
	guest.update()
	guest.send(protocol.TypePlay, protocol.Play{LastSeq: seq + 1})
	guest.expect(protocol.TypeActionRejected, &rej)
	if rej.Reason != "locked" {
		t.Fatalf("locked play: %+v", rej)
	}
}

func TestTimePing(t *testing.T) {
	e := newEnv(t)
	c := e.dial(e.signup("tobi"))
	c.hello("")
	before := time.Now().UnixMilli()
	c.send(protocol.TypeTimePing, protocol.TimePing{ClientTime: 42})
	var p protocol.TimePong
	c.expect(protocol.TypeTimePong, &p)
	if p.ClientTime != 42 || p.ServerTime < before {
		t.Fatalf("pong: %+v", p)
	}
}
