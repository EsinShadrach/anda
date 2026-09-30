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
	TypeError          = "error"
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

// RoomState is the full snapshot sent on join or resume. Media, playback and blockers
// arrive with synced playback (step 3); they're present now so the shape doesn't change.
type RoomState struct {
	Code     string          `json:"code"`
	Host     int64           `json:"host"`
	Members  []Member        `json:"members"`
	Media    json.RawMessage `json:"media"`
	Playback json.RawMessage `json:"playback"`
	Blockers []string        `json:"blockers"`
	Locked   bool            `json:"locked"`
	Seq      int64           `json:"seq"`
	Chat     []ChatMessage   `json:"chat"`
}

type MemberUpdate struct {
	UserID   int64  `json:"user_id"`
	Username string `json:"username"`
	Status   string `json:"status"`
}

type HostChanged struct {
	Host int64 `json:"host"`
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
