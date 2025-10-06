CREATE TABLE IF NOT EXISTS article (
  id TEXT NOT NULL, -- UUID
  reference TEXT NOT NULL UNIQUE, -- pointer to the file's location in the vault
  due INTEGER, -- unix timestamp
  priority INTEGER NOT NULL,
  dismissed INTEGER DEFAULT 0,
  CHECK(priority >= 10 AND priority <= 50),
  CHECK(dismissed = FALSE OR dismissed = TRUE),
  CHECK(due IS NOT NULL OR dismissed = TRUE)
);

CREATE INDEX IF NOT EXISTS article_uuid ON article(id);
CREATE INDEX IF NOT EXISTS article_reference ON article(reference);
CREATE INDEX IF NOT EXISTS article_due ON article(due);

CREATE TABLE IF NOT EXISTS snippet (
  id TEXT NOT NULL, -- UUID
  reference TEXT NOT NULL UNIQUE, -- pointer to the file's location in the vault
  due INTEGER, -- unix timestamp
  priority INTEGER NOT NULL,
  parent TEXT REFERENCES snippet(id) DEFAULT NULL,
  dismissed INTEGER DEFAULT 0,
  CHECK(priority >= 10 AND priority <= 50),
  CHECK(dismissed = FALSE OR dismissed = TRUE),
  CHECK(due IS NOT NULL OR dismissed = TRUE)
);

CREATE INDEX IF NOT EXISTS snippet_uuid ON snippet(id);
CREATE INDEX IF NOT EXISTS snippet_reference ON snippet(reference);
CREATE INDEX IF NOT EXISTS snippet_due ON snippet(due);

-- Log of all snippet reviews
CREATE TABLE IF NOT EXISTS snippet_review (
  id TEXT NOT NULL, -- UUID
  snippet_id TEXT REFERENCES snippet(id),
  review_time INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS srs_card (
  id TEXT NOT NULL, -- UUID
  -- source TEXT NOT NULL, -- use source property in the card instead so Obsidian updates it properly
  reference TEXT NOT NULL UNIQUE, -- pointer to the file's location in the vault
  created_at INTEGER NOT NULL, -- unix timestamp
  due INTEGER NOT NULL,
  dismissed INTEGER DEFAULT 0,
  last_review INTEGER,
  stability REAL NOT NULL,
  difficulty REAL NOT NULL,
  elapsed_days REAL NOT NULL,
  scheduled_days REAL NOT NULL,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  state INTEGER NOT NULL,
  CHECK(state >= 0 AND state <= 3),
  CHECK(dismissed = FALSE OR dismissed = TRUE)
);

CREATE INDEX IF NOT EXISTS srs_card_uuid ON srs_card(id);
CREATE INDEX IF NOT EXISTS srs_card_reference ON srs_card(reference);
CREATE INDEX IF NOT EXISTS srs_card_due ON srs_card(due);

CREATE TABLE IF NOT EXISTS srs_card_review (
  id TEXT NOT NULL, -- UUID
  card_id TEXT REFERENCES srs_card(id),
  due INTEGER NOT NULL,
  review INTEGER NOT NULL,
  stability REAL NOT NULL,
  difficulty REAL NOT NULL,
  elapsed_days REAL NOT NULL,
  last_elapsed_days REAL NOT NULL,
  scheduled_days REAL NOT NULL,
  rating INTEGER NOT NULL,
  state INTEGER NOT NULL,
  CHECK(state >= 0 AND state <= 3),
  CHECK(rating >= 0 AND rating <= 4)
);