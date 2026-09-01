CREATE TABLE IF NOT EXISTS article (
  id TEXT NOT NULL PRIMARY KEY, -- UUID
  reference TEXT NOT NULL UNIQUE, -- pointer to the file's location in the vault
  due INTEGER, -- unix timestamp
  due_fuzz INTEGER DEFAULT NULL, -- milliseconds to offset due time for intra-day review ordering
  interval INTEGER NOT NULL, -- the interval that was used to calculate `due`
  priority INTEGER NOT NULL, -- used when manual interval is null
  fixed_interval_days INTEGER NULL,
  dismissed INTEGER NOT NULL DEFAULT FALSE,
  deleted INTEGER NOT NULL DEFAULT FALSE,
  scroll_top INTEGER NOT NULL DEFAULT 0,
  CHECK(interval > 0),
  CHECK(priority >= 10 AND priority <= 50),
  CHECK(fixed_interval_days > 0),
  CHECK(dismissed = FALSE OR dismissed = TRUE),
  CHECK(deleted = FALSE OR deleted = TRUE),
  CHECK(due IS NOT NULL OR dismissed = TRUE)
);

CREATE INDEX IF NOT EXISTS article_uuid ON article(id);
CREATE INDEX IF NOT EXISTS article_reference ON article(reference);
CREATE INDEX IF NOT EXISTS article_due ON article(due);

CREATE TABLE IF NOT EXISTS article_review (
  id TEXT NOT NULL PRIMARY KEY, -- UUID
  article_id TEXT NOT NULL REFERENCES article(id) ON DELETE CASCADE,
  review_time INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS snippet (
  id TEXT NOT NULL PRIMARY KEY, -- UUID
  reference TEXT NOT NULL UNIQUE, -- pointer to the file's location in the vault
  parent TEXT DEFAULT NULL, -- UUID; null if it wasn't created from an article or snippet
  due INTEGER, -- unix timestamp
  due_fuzz INTEGER DEFAULT NULL, -- milliseconds to offset due time for intra-day review ordering
  interval INTEGER NOT NULL, -- the interval that was used to calculate `due`
  priority INTEGER NOT NULL,
  dismissed INTEGER NOT NULL DEFAULT FALSE,
  deleted INTEGER NOT NULL DEFAULT FALSE,
  scroll_top INTEGER NOT NULL DEFAULT 0,
  start_offset INTEGER DEFAULT NULL, -- character offset from start of parent note's body
  end_offset INTEGER DEFAULT NULL, -- character offset from start of parent note's body
  CHECK(interval > 0),
  CHECK(priority >= 10 AND priority <= 50),
  CHECK(dismissed = FALSE OR dismissed = TRUE),
  CHECK(deleted = FALSE OR deleted = TRUE),
  CHECK(due IS NOT NULL OR dismissed = TRUE)
);

CREATE INDEX IF NOT EXISTS snippet_uuid ON snippet(id);
CREATE INDEX IF NOT EXISTS snippet_reference ON snippet(reference);
CREATE INDEX IF NOT EXISTS snippet_due ON snippet(due);

CREATE TABLE IF NOT EXISTS snippet_review (
  id TEXT NOT NULL PRIMARY KEY, -- UUID
  snippet_id TEXT NOT NULL REFERENCES snippet(id) ON DELETE CASCADE,
  review_time INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS srs_card (
  id TEXT NOT NULL PRIMARY KEY, -- UUID
  -- source TEXT NOT NULL, -- use source property in the card instead so Obsidian updates it properly
  reference TEXT NOT NULL UNIQUE, -- pointer to the file's location in the vault
  parent TEXT DEFAULT NULL, -- UUID; null if it wasn't created from an article or snippet
  created_at INTEGER NOT NULL, -- unix timestamp
  due INTEGER NOT NULL,
  dismissed INTEGER NOT NULL DEFAULT FALSE,
  deleted INTEGER NOT NULL DEFAULT FALSE,
  last_review INTEGER,
  stability REAL NOT NULL,
  difficulty REAL NOT NULL,
  elapsed_days REAL NOT NULL,
  scheduled_days REAL NOT NULL,
  learning_steps INTEGER NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  state INTEGER NOT NULL,
  CHECK(state >= 0 AND state <= 3),
  CHECK(dismissed = FALSE OR dismissed = TRUE),
  CHECK(deleted = FALSE OR deleted = TRUE)
);

CREATE INDEX IF NOT EXISTS srs_card_uuid ON srs_card(id);
CREATE INDEX IF NOT EXISTS srs_card_reference ON srs_card(reference);
CREATE INDEX IF NOT EXISTS srs_card_due ON srs_card(due);

CREATE TABLE IF NOT EXISTS srs_card_review (
  id TEXT NOT NULL PRIMARY KEY, -- UUID
  card_id TEXT NOT NULL REFERENCES srs_card(id) ON DELETE CASCADE,
  due INTEGER NOT NULL, -- time it was due
  review INTEGER NOT NULL, -- actual time of review
  stability REAL NOT NULL,
  difficulty REAL NOT NULL,
  elapsed_days REAL NOT NULL,
  last_elapsed_days REAL NOT NULL,
  scheduled_days REAL NOT NULL,
  learning_steps INTEGER NOT NULL DEFAULT 0,
  rating INTEGER NOT NULL,
  state INTEGER NOT NULL,
  CHECK(state >= 0 AND state <= 3),
  CHECK(rating >= 0 AND rating <= 4)
);

PRAGMA user_version = 9;