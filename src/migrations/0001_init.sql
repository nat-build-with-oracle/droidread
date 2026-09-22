-- 0001_init — messages table + FTS5 index + sync triggers.
CREATE TABLE messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  app          TEXT NOT NULL,
  chat         TEXT NOT NULL,
  sender       TEXT NOT NULL,
  text         TEXT NOT NULL,
  extracted_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(app, chat, sender, text)
);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  text, sender, chat,
  content='messages', content_rowid='id'
);

CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text, sender, chat) VALUES (new.id, new.text, new.sender, new.chat);
END;

CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text, sender, chat) VALUES ('delete', old.id, old.text, old.sender, old.chat);
END;
