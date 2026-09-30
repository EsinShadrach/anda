-- +goose Up
-- Films can come from the media directory ('local') or a torrent via the Library ('torrent').
ALTER TABLE media ADD COLUMN source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'torrent'));
ALTER TABLE media ADD COLUMN poster TEXT;
ALTER TABLE media ADD COLUMN year TEXT;
CREATE UNIQUE INDEX media_torrent_file ON media(info_hash, file_idx) WHERE info_hash IS NOT NULL;

-- +goose Down
DROP INDEX media_torrent_file;
ALTER TABLE media DROP COLUMN year;
ALTER TABLE media DROP COLUMN poster;
ALTER TABLE media DROP COLUMN source;
