-- 0004_anchors — every timestamp divider seen, indexed on its own.
--
-- Dividers are the ANCHORS: a message's time is "the nearest divider above it". Indexing
-- them first, as their own rows, means the timeline of a conversation can be inspected
-- and reasoned about directly ("which anchors exist for today?") independently of
-- whether message assignment got it right.
--
-- raw is the label exactly as rendered ("10:14", "FRI AT 14:29"); sent_at is it resolved
-- at first sight. Both kept, for the same reason as messages.sent_at_raw.

CREATE TABLE anchors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  app        TEXT NOT NULL,
  chat       TEXT NOT NULL,
  raw        TEXT NOT NULL,
  sent_at    TEXT,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(app, chat, raw)
);

CREATE INDEX anchors_chat_time ON anchors (chat, sent_at);
