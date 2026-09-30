-- +goose Up
CREATE TABLE media (
    id              INTEGER PRIMARY KEY,
    title           TEXT    NOT NULL,
    catalog_id      TEXT,             -- Stremio catalog ID, once the Library exists (step 5)
    info_hash       TEXT,
    file_idx        INTEGER,
    size_bytes      INTEGER NOT NULL,
    status          TEXT    NOT NULL CHECK (status IN ('downloading', 'ready')),
    path            TEXT    NOT NULL UNIQUE, -- relative to the media directory
    last_watched_at INTEGER                  -- unix seconds
);

-- +goose Down
DROP TABLE media;
