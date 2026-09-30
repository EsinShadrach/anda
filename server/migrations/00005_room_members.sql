-- +goose Up
-- Rooms each account has been in, for the profile page. A row goes away when the room
-- ends (cascade) or when the account removes it from its list.
CREATE TABLE room_members (
    room_id         INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    first_joined_at INTEGER NOT NULL, -- unix seconds
    last_joined_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, room_id)
) WITHOUT ROWID;

CREATE INDEX room_members_room ON room_members(room_id);

-- Backfill from what we already know: owners, and anyone who chatted.
INSERT OR IGNORE INTO room_members (room_id, user_id, first_joined_at, last_joined_at)
SELECT id, owner_id, created_at, last_active_at FROM rooms;

INSERT OR IGNORE INTO room_members (room_id, user_id, first_joined_at, last_joined_at)
SELECT room_id, user_id, MIN(created_at) / 1000, MAX(created_at) / 1000
FROM chat_messages GROUP BY room_id, user_id;

-- +goose Down
DROP TABLE room_members;
