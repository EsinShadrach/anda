-- +goose Up
CREATE TABLE rooms (
    id             INTEGER PRIMARY KEY,
    code           TEXT    NOT NULL UNIQUE,
    owner_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at     INTEGER NOT NULL, -- unix seconds
    last_active_at INTEGER NOT NULL
);

CREATE TABLE chat_messages (
    id         INTEGER PRIMARY KEY,
    room_id    INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text       TEXT    NOT NULL,
    created_at INTEGER NOT NULL -- unix milliseconds, so messages in the same second keep their order
);

CREATE INDEX chat_messages_room ON chat_messages(room_id, id);

-- +goose Down
DROP TABLE chat_messages;
DROP TABLE rooms;
