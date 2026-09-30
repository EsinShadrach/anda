// Package protocol defines the WebSocket messages exchanged with the browser. Names and
// fields follow the "WebSocket protocol" section of the plan; change both together.
package protocol

import (
	"encoding/json"
	"time"
)

// Version is bumped on any breaking change; clients on an older version get a
// "please refresh" error instead of misbehaving.
const Version = 1

// Envelope wraps every message in both directions.
type Envelope struct {
	Type    string          `json:"type"`
	V       int             `json:"v"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// Browser → server.
const (
	TypeHello     = "hello"
	TypeJoinRoom  = "join_room"
	TypeLeaveRoom = "leave_room"
	TypeChatSend  = "chat_send"

	TypePlay         = "play"
	TypePause        = "pause"
	TypeSeek         = "seek"
	TypeSetMedia     = "set_media"
	TypeBufferReport = "buffer_report"
	TypeTimePing     = "time_ping"
	TypeSkipWait     = "skip_wait"
	TypeLockControls = "lock_controls"
)

// Server → browser.
const (
	TypeWelcome        = "welcome"
	TypeRoomState      = "room_state"
	TypeChatMessage    = "chat_message"
	TypeMemberUpdate   = "member_update"
	TypeHostChanged    = "host_changed"
	TypeReplaced       = "replaced"
	TypeReconnectLater = "reconnect_later"
	TypeRoomEnded      = "room_ended"
	TypeError          = "error"

	TypePlaybackUpdate = "playback_update"
	TypeActionRejected = "action_rejected"
	TypeTimePong       = "time_pong"
)

type Hello struct {
	ResumeToken string `json:"resume_token,omitempty"`
	LastSeq     int64  `json:"last_seq,omitempty"`
}

type Welcome struct {
	UserID      int64  `json:"user_id"`
	ResumeToken string `json:"resume_token"`
	ServerTime  int64  `json:"server_time"` // unix ms
	// Resumed is true when the resume token was accepted.
	Resumed bool `json:"resumed"`
	// Room is the room a resumed session is put back into ("" if none); room_state for it
	// follows without asking. The client sends join_room whenever this isn't its room.
	Room string `json:"room,omitempty"`
}

type JoinRoom struct {
	Code string `json:"code"`
}

type ChatSend struct {
	Text        string `json:"text"`
	ClientMsgID string `json:"client_msg_id"`
}

type Member struct {
	UserID   int64  `json:"user_id"`
	Username string `json:"username"`
	Status   string `json:"status"` // online | away
}

// Member statuses; "left" only appears in member_update.
const (
	StatusOnline = "online"
	StatusAway   = "away"
	StatusLeft   = "left"
)

type ChatMessage struct {
	ID          int64  `json:"id"`
	Sender      User   `json:"sender"`
	Text        string `json:"text"`
	Time        int64  `json:"time"` // unix ms
	ClientMsgID string `json:"client_msg_id,omitempty"`
}

type User struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
}

// RoomState is the full snapshot sent on join or resume.
type RoomState struct {
	Code     string         `json:"code"`
	Host     int64          `json:"host"`
	Members  []Member       `json:"members"`
	Media    *Media         `json:"media"`    // nil until the host picks a film
	Playback *PlaybackState `json:"playback"` // nil until the host picks a film
	Blockers []Blocker      `json:"blockers"`
	Locked   bool           `json:"locked"`
	Seq      int64          `json:"seq"`
	Chat     []ChatMessage  `json:"chat"`
}

type Media struct {
	ID       int64   `json:"id"`
	Title    string  `json:"title"`
	URL      string  `json:"url"`                // HLS playlist
	Duration float64 `json:"duration,omitempty"` // seconds
	Poster   string  `json:"poster,omitempty"`
	Year     string  `json:"year,omitempty"`
	// State is "preparing" while a torrent film is still downloading (its playlist grows;
	// poll /api/media/{id}/progress), "ready" once complete.
	State string `json:"state"`
}

// PlaybackState anchors the room clock: at ServerTime the film was at Position. While the
// room is actually running (people want it playing and nothing blocks), clients compute
// now's position as Position + (serverNow - ServerTime) * Rate.
type PlaybackState struct {
	Want       string  `json:"want"` // playing | paused: what people asked for
	Position   float64 `json:"position"`
	Rate       float64 `json:"rate"`
	ServerTime int64   `json:"server_time"` // unix ms
}

// Want values.
const (
	WantPlaying = "playing"
	WantPaused  = "paused"
)

// Blocker is something the room is waiting on; it only plays when there are none.
type Blocker struct {
	UserID   int64  `json:"user_id"`
	Username string `json:"username"`
	Reason   string `json:"reason"` // buffering | getting_ready
}

const (
	BlockBuffering    = "buffering"
	BlockGettingReady = "getting_ready"
)

// Play, Pause and Seek carry the last sequence number the client saw, so the server can
// tell a stale click from a considered one.
type Play struct {
	LastSeq  int64   `json:"last_seq"`
	Position float64 `json:"position"`
}

type Pause struct {
	LastSeq  int64   `json:"last_seq"`
	Position float64 `json:"position"`
}

type Seek struct {
	LastSeq  int64   `json:"last_seq"`
	Position float64 `json:"position"` // target
}

type SetMedia struct {
	StreamID int64 `json:"stream_id"`
}

type BufferReport struct {
	Ahead    float64 `json:"ahead"` // seconds buffered past the playhead
	Stalling bool    `json:"stalling"`
	Quality  string  `json:"quality,omitempty"`
}

type TimePing struct {
	ClientTime int64 `json:"client_time"`
}

type TimePong struct {
	ClientTime int64 `json:"client_time"`
	ServerTime int64 `json:"server_time"`
}

type SkipWait struct {
	UserID int64 `json:"user_id"`
}

type LockControls struct {
	Locked bool `json:"locked"`
}

type PlaybackUpdate struct {
	Seq int64 `json:"seq"`
	PlaybackState
	Blockers []Blocker `json:"blockers"`
	Locked   bool      `json:"locked"`
	By       *User     `json:"by,omitempty"` // nil for changes nobody made (e.g. a buffer filled)
	Action   string    `json:"action"`       // play | pause | seek | set_media | blockers | skip_wait | lock
	Media    *Media    `json:"media,omitempty"`
}

type ActionRejected struct {
	Reason string `json:"reason"` // race | locked | rate_limited | no_media | not_host
	Action string `json:"action"` // the action that won (race) or was refused
	By     *User  `json:"by,omitempty"`
}

type MemberUpdate struct {
	UserID   int64  `json:"user_id"`
	Username string `json:"username"`
	Status   string `json:"status"`
}

type HostChanged struct {
	Host int64 `json:"host"`
}

// RoomEnded tells everyone in a room that its owner ended it; the room no longer exists.
type RoomEnded struct {
	By User `json:"by"`
}

type ReconnectLater struct {
	Delay int `json:"delay"` // seconds
}

type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Error codes.
const (
	ErrBadMessage   = "bad_message"
	ErrVersion      = "protocol_version"
	ErrNotInRoom    = "not_in_room"
	ErrRoomNotFound = "room_not_found"
	ErrRateLimited  = "rate_limited"
	ErrHelloFirst   = "hello_first"
	ErrInternal     = "internal"
)

// Encode builds a complete server message. It panics only on unencodable payloads,
// which would be a programming error.
func Encode(typ string, payload any) []byte {
	var raw json.RawMessage
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			panic(err)
		}
		raw = b
	}
	b, err := json.Marshal(Envelope{Type: typ, V: Version, Payload: raw})
	if err != nil {
		panic(err)
	}
	return b
}

func EncodeError(code, message string) []byte {
	return Encode(TypeError, Error{Code: code, Message: message})
}

func UnixMs(t time.Time) int64 { return t.UnixMilli() }
