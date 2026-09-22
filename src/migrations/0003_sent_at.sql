-- 0003_sent_at — real send times, from Messenger's own cluster dividers.
--
-- sent_at_raw keeps the literal label ("FRI AT 14:29", "02:34"). sent_at holds it
-- resolved to a local timestamp. BOTH are stored because relative labels only mean
-- something relative to when they were READ: "FRI" read today and the same "FRI" read
-- next week denote different days, so a resolution cannot be recomputed from the label
-- alone after the fact.
--
-- KNOWN GRANULARITY: dividers mark CLUSTERS, not individual messages, so several
-- consecutive messages legitimately share one timestamp. Messenger exposes nothing
-- finer without double-tapping each message.
--
-- Plain ALTERs: these columns are nullable and the UNIQUE constraint is untouched, so
-- no table rebuild is needed (unlike 0002).

ALTER TABLE messages ADD COLUMN sent_at     TEXT;
ALTER TABLE messages ADD COLUMN sent_at_raw TEXT;

CREATE INDEX IF NOT EXISTS messages_sent_at ON messages (chat, sent_at);
