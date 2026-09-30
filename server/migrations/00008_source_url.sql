-- +goose Up
-- Library films can also come from a direct link (an addon stream with a url instead of an
-- info hash). They're still source 'torrent' ("downloaded through the Library": cached,
-- evicted and resumed the same way); source_url is set instead of info_hash.
ALTER TABLE media ADD COLUMN source_url TEXT;

-- +goose Down
ALTER TABLE media DROP COLUMN source_url;
