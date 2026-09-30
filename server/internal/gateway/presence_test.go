package gateway

import (
	"anda/internal/store"
	"context"
	"encoding/json"
	"path/filepath"
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

func TestConnectionIndicator(t *testing.T) {
	host, guest, seq, guestID := twoInRoomWith(t, 7, nil)
	playing(t, host, guest, seq) // both reported 5s ahead while starting: fair

	// until waits for chimamanda's indicator to reach want (earlier updates may be queued).
	until := func(want string) protocol.MemberUpdate {
		t.Helper()
		for {
			var mu protocol.MemberUpdate
			host.expect(protocol.TypeMemberUpdate, &mu)
			if mu.UserID == guestID && mu.Connection == want {
				return mu
			}
		}
	}
	guest.send(protocol.TypeBufferReport, protocol.BufferReport{Ahead: 30})
	if mu := until(protocol.ConnGood); mu.Status != protocol.StatusOnline {
		t.Fatalf("healthy: %+v", mu)
	}
	guest.send(protocol.TypeBufferReport, protocol.BufferReport{Ahead: 0, Stalling: true})
	until(protocol.ConnPoor)
	// Recovered, but it stalled a moment ago: fair, not straight back to good.
	guest.send(protocol.TypeBufferReport, protocol.BufferReport{Ahead: 30})
	until(protocol.ConnFair)
}

func TestRoomResumesWhereItLeftOff(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "anda.db")
	e := newEnvAt(t, dbPath)
	rafe := e.signup("rafe")
	code := e.createRoom(rafe)
	host := e.dial(rafe)
	host.hello("")
	host.send(protocol.TypeJoinRoom, protocol.JoinRoom{Code: code})
	host.expect(protocol.TypeRoomState, nil)
	// A real media row: the room's saved film references it.
	db, err := store.OpenSQLite(context.Background(), dbPath)
	if err != nil {
		t.Fatal(err)
	}
	film, err := db.UpsertTorrentMedia(context.Background(), store.TorrentMedia{Title: "Sintel", SourceURL: "https://cdn.example.com/s.mp4"})
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	host.send(protocol.TypeSetMedia, protocol.SetMedia{StreamID: film.ID})
	u := host.update()
	host.send(protocol.TypeSeek, protocol.Seek{LastSeq: u.Seq, Position: 42})
	host.update()

	// A server restart: a fresh process on the same database.
	e2 := newEnvAt(t, dbPath)
	c := e2.dial(rafe) // sessions live in the database too
	c.hello("")
	c.send(protocol.TypeJoinRoom, protocol.JoinRoom{Code: code})
	var st protocol.RoomState
	c.expect(protocol.TypeRoomState, &st)
	if st.Media == nil || st.Media.ID != film.ID || st.Playback == nil || st.Playback.Want != protocol.WantPaused ||
		st.Playback.Position != 42 || st.LastAction != "resume" {
		t.Fatalf("resumed room: media=%+v playback=%+v action=%q", st.Media, st.Playback, st.LastAction)
	}
}

func TestReactions(t *testing.T) {
	host, guest, _, _ := twoInRoomWith(t, 7, nil)

	host.send(protocol.TypeReactionSend, protocol.ReactionSend{Kind: "nope"}) // not in the palette: dropped
	host.send(protocol.TypeReactionSend, protocol.ReactionSend{Kind: "laugh"})
	var got protocol.Reaction
	guest.expect(protocol.TypeReaction, &got)
	if got.Kind != "laugh" || got.By.Username != "rafe" {
		t.Fatalf("reaction: %+v", got)
	}

	// A flood: the burst gets through, the rest is dropped (quietly, no error).
	for range 20 {
		host.send(protocol.TypeReactionSend, protocol.ReactionSend{Kind: "fire"})
	}
	host.send(protocol.TypeChatSend, protocol.ChatSend{Text: "end"}) // marks the end of the flood
	fires := 0
	for {
		var env protocol.Envelope
		_, data, err := guest.ws.Read(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		json.Unmarshal(data, &env)
		if env.Type == protocol.TypeReaction {
			fires++
		}
		if env.Type == protocol.TypeChatMessage {
			break
		}
	}
	if fires < 6 || fires > 8 { // burst of 8, minus the one used above, plus a little refill
		t.Fatalf("flood let %d through", fires)
	}
}
