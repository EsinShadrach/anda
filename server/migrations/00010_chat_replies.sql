-- +goose Up
-- A message can answer an earlier one in the same room (a reply). Messages only go with
-- their room today; if one ever goes on its own, its replies stay and lose the quote.
ALTER TABLE chat_messages ADD COLUMN reply_to INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL;

-- +goose Down
ALTER TABLE chat_messages DROP COLUMN reply_to;
