-- 0002_media — mark which rows are photos so they can be downloaded on demand later.
--
-- Photos are recorded in their correct chronological position with media_file NULL;
-- a separate fetch step fills it in. This keeps extraction fast (marking is free, the
-- tap->Save->back cycle costs ~8s per photo and drives the real Messenger UI).
--
-- Table is REBUILT rather than ALTERed because the UNIQUE constraint has to change:
-- two distinct photos from the same sender both carry text '[photo]', which the old
-- UNIQUE(app, chat, sender, text) would collapse into one row. media_ref (Messenger's
-- own "Forward photo sent by <Sender> on <date>" string) distinguishes them.
--
-- KNOWN LIMIT, recorded honestly: media_ref is only minute-resolution, so a burst of
-- photos from one sender inside the same minute can still collide. The accessibility
-- tree exposes nothing finer.

DROP TRIGGER IF EXISTS messages_ai;
DROP TRIGGER IF EXISTS messages_ad;

ALTER TABLE messages RENAME TO messages_old;

CREATE TABLE messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  app          TEXT NOT NULL,
  chat         TEXT NOT NULL,
  sender       TEXT NOT NULL,
  text         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'text',   -- 'text' | 'photo'
  media_ref    TEXT NOT NULL DEFAULT '',       -- Messenger's per-photo identity string
  media_when   TEXT NOT NULL DEFAULT '',       -- e.g. "16 Sept at 18:27"
  media_file   TEXT,                           -- local path once downloaded; NULL = pending
  extracted_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(app, chat, sender, text, media_ref)
);

INSERT INTO messages (id, app, chat, sender, text, extracted_at)
  SELECT id, app, chat, sender, text, extracted_at FROM messages_old;

DROP TABLE messages_old;

CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text, sender, chat) VALUES (new.id, new.text, new.sender, new.chat);
END;

CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, sender, chat) VALUES ('delete', old.id, old.text, old.sender, old.chat);
END;

-- External-content FTS must be repopulated after the content table is swapped.
INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
