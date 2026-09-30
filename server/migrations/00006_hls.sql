-- +goose Up
-- HLS preparation per film. A film is on the ready shelf only when hls_state = 'ready'.
ALTER TABLE media ADD COLUMN hls_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (hls_state IN ('pending', 'remuxing', 'ready', 'incompatible', 'failed'));
ALTER TABLE media ADD COLUMN hls_error TEXT;
ALTER TABLE media ADD COLUMN video_codec TEXT;
ALTER TABLE media ADD COLUMN audio_codec TEXT;
ALTER TABLE media ADD COLUMN duration_seconds REAL;

-- +goose Down
ALTER TABLE media DROP COLUMN duration_seconds;
ALTER TABLE media DROP COLUMN audio_codec;
ALTER TABLE media DROP COLUMN video_codec;
ALTER TABLE media DROP COLUMN hls_error;
ALTER TABLE media DROP COLUMN hls_state;
