-- +goose Up
-- Where a room left off, so the next evening resumes there: the film on screen and its
-- position. Cleared if the film is deleted.
ALTER TABLE rooms ADD COLUMN media_id INTEGER REFERENCES media(id) ON DELETE SET NULL;
ALTER TABLE rooms ADD COLUMN media_position REAL NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE rooms DROP COLUMN media_position;
ALTER TABLE rooms DROP COLUMN media_id;
