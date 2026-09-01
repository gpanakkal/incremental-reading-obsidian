import { DATA_DIRECTORY, TEXT_BASE_REVIEW_INTERVAL } from '#/lib/constants';
import type { TableNameToRowType } from '#/lib/types';
import type { SafeOmit } from '#/lib/utility-types';
import {
  addColumnIfNotExists,
  recreateTable,
  type Migration,
} from './migration-helpers';

export const migrations: Migration[] = [
  {
    version: 1,
    description: 'Add start_offset and end_offset columns to snippet table',
    up: (db) => {
      addColumnIfNotExists(
        db,
        'snippet',
        'start_offset',
        'INTEGER DEFAULT NULL'
      );
      addColumnIfNotExists(db, 'snippet', 'end_offset', 'INTEGER DEFAULT NULL');
    },
  },
  {
    version: 2,
    description: 'Add scroll position column to article and snippet tables',
    up: (db) => {
      addColumnIfNotExists(
        db,
        'article',
        'scroll_top',
        'INTEGER NOT NULL DEFAULT 0'
      );
      addColumnIfNotExists(
        db,
        'snippet',
        'scroll_top',
        'INTEGER NOT NULL DEFAULT 0'
      );
    },
  },
  {
    version: 3,
    description:
      'Store last calculated review interval on articles and snippets',
    up: (db) => {
      // add `interval` to articles
      (() => {
        const reviewResult = db.exec(
          `SELECT article_id, MAX(review_time) FROM article_review GROUP BY article_id`
        );
        const latestReviewByArticle: Record<string, number> = {};
        if (reviewResult.length > 0) {
          for (const [id, latest] of reviewResult[0].values) {
            latestReviewByArticle[id as string] = latest as number;
          }
        }
        recreateTable(
          db,
          'article',
          `CREATE TABLE article (
            id TEXT NOT NULL, -- UUID
            reference TEXT NOT NULL UNIQUE, -- pointer to the file's location in the vault
            due INTEGER, -- unix timestamp
            interval INTEGER NOT NULL, -- the interval that was used to calculate due
            priority INTEGER NOT NULL, -- used when manual interval is null
            fixed_interval_days INTEGER NULL,
            dismissed INTEGER DEFAULT 0,
            scroll_top INTEGER NOT NULL DEFAULT 0,
            CHECK(interval > 0),
            CHECK(priority >= 10 AND priority <= 50),
            CHECK(fixed_interval_days >= 1 AND fixed_interval_days <= 7),
            CHECK(dismissed = FALSE OR dismissed = TRUE),
            CHECK(due IS NOT NULL OR dismissed = TRUE)
          );`,
          {
            id: 'id',
            dismissed: 'dismissed',
            due: 'due',
            reference: 'reference',
            interval: 'interval',
            priority: 'priority',
            fixed_interval_days: 'fixed_interval_days',
            scroll_top: 'scroll_top',
          },
          {
            transformRow: (
              row: SafeOmit<
                TableNameToRowType['article'],
                'interval' | 'deleted' | 'due_fuzz'
              >
            ) => {
              const lastReviewTime = latestReviewByArticle[row.id];
              const computed =
                lastReviewTime && row.due ? row.due - lastReviewTime : 0;

              // ensure the interval is positive
              const interval =
                computed > 0 ? computed : TEXT_BASE_REVIEW_INTERVAL;
              return { ...row, interval };
            },
          }
        );
      })();

      // add `interval` to snippets
      (() => {
        const reviewResult = db.exec(
          `SELECT snippet_id, MAX(review_time) FROM snippet_review GROUP BY snippet_id`
        );
        const latestReviewBySnippet: Record<string, number> = {};
        if (reviewResult.length > 0) {
          for (const [id, latest] of reviewResult[0].values) {
            latestReviewBySnippet[id as string] = latest as number;
          }
        }
        recreateTable(
          db,
          'snippet',
          `CREATE TABLE snippet (
            id TEXT NOT NULL, -- UUID
            reference TEXT NOT NULL UNIQUE, -- pointer to the file's location in the vault
            parent TEXT DEFAULT NULL, -- null if it wasn't created from an article or snippet
            due INTEGER, -- unix timestamp
            interval INTEGER NOT NULL, -- the interval that was used to calculate due
            priority INTEGER NOT NULL,
            dismissed INTEGER DEFAULT 0,
            scroll_top INTEGER NOT NULL DEFAULT 0,
            start_offset INTEGER DEFAULT NULL, -- character offset from start of parent note's body
            end_offset INTEGER DEFAULT NULL, -- character offset from start of parent note's body
            CHECK(interval > 0),
            CHECK(priority >= 10 AND priority <= 50),
            CHECK(dismissed = FALSE OR dismissed = TRUE),
            CHECK(due IS NOT NULL OR dismissed = TRUE)
          );`,
          {
            id: 'id',
            dismissed: 'dismissed',
            due: 'due',
            reference: 'reference',
            interval: 'interval',
            priority: 'priority',
            scroll_top: 'scroll_top',
            parent: 'parent',
            start_offset: 'start_offset',
            end_offset: 'end_offset',
          },
          {
            transformRow: (
              row: SafeOmit<
                TableNameToRowType['snippet'],
                'interval' | 'deleted' | 'due_fuzz'
              >
            ) => {
              const lastReviewTime = latestReviewBySnippet[row.id];
              const computed =
                lastReviewTime && row.due ? row.due - lastReviewTime : 0;
              const interval =
                computed > 0 ? computed : TEXT_BASE_REVIEW_INTERVAL;
              return { ...row, interval };
            },
          }
        );
      })();
    },
  },
  {
    version: 4,
    description: 'Remove upper bound on fixed review intervals',
    up: (db) => {
      recreateTable(
        db,
        'article',
        `CREATE TABLE article (
            id TEXT NOT NULL, -- UUID
            reference TEXT NOT NULL UNIQUE, -- pointer to the file's location in the vault
            due INTEGER, -- unix timestamp
            interval INTEGER NOT NULL, -- the interval that was used to calculate due
            priority INTEGER NOT NULL, -- used when manual interval is null
            fixed_interval_days INTEGER NULL,
            dismissed INTEGER DEFAULT 0,
            scroll_top INTEGER NOT NULL DEFAULT 0,
            CHECK(interval > 0),
            CHECK(priority >= 10 AND priority <= 50),
            CHECK(fixed_interval_days >= 1),
            CHECK(dismissed = FALSE OR dismissed = TRUE),
            CHECK(due IS NOT NULL OR dismissed = TRUE)
          );`,
        {
          id: 'id',
          dismissed: 'dismissed',
          due: 'due',
          reference: 'reference',
          interval: 'interval',
          priority: 'priority',
          fixed_interval_days: 'fixed_interval_days',
          scroll_top: 'scroll_top',
        }
      );
    },
  },
  {
    version: 5,
    description: 'Add deleted field on item rows',
    up: (db) => {
      recreateTable(
        db,
        'article',
        `CREATE TABLE article (
          id TEXT NOT NULL, -- UUID
          reference TEXT NOT NULL UNIQUE, -- pointer to the file's location in the vault
          due INTEGER, -- unix timestamp
          interval INTEGER NOT NULL, -- the interval that was used to calculate due
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
        );`,
        {
          id: 'id',
          reference: 'reference',
          due: 'due',
          interval: 'interval',
          priority: 'priority',
          fixed_interval_days: 'fixed_interval_days',
          dismissed: 'dismissed',
          scroll_top: 'scroll_top',
        },
        { defaultedColumns: ['deleted'] }
      );

      recreateTable(
        db,
        'snippet',
        `CREATE TABLE snippet (
          id TEXT NOT NULL, -- UUID
          reference TEXT NOT NULL UNIQUE, -- pointer to the file's location in the vault
          parent TEXT DEFAULT NULL, -- null if it wasn't created from an article or snippet
          due INTEGER, -- unix timestamp
          interval INTEGER NOT NULL, -- the interval that was used to calculate due
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
        );`,
        {
          id: 'id',
          reference: 'reference',
          parent: 'parent',
          due: 'due',
          interval: 'interval',
          priority: 'priority',
          dismissed: 'dismissed',
          scroll_top: 'scroll_top',
          start_offset: 'start_offset',
          end_offset: 'end_offset',
        },
        { defaultedColumns: ['deleted'] }
      );

      recreateTable(
        db,
        'srs_card',
        `CREATE TABLE srs_card (
          id TEXT NOT NULL, -- UUID
          reference TEXT NOT NULL UNIQUE, -- pointer to the file's location in the vault
          parent TEXT DEFAULT NULL,
          created_at INTEGER NOT NULL, -- unix timestamp
          due INTEGER NOT NULL,
          dismissed INTEGER NOT NULL DEFAULT FALSE,
          deleted INTEGER NOT NULL DEFAULT FALSE,
          last_review INTEGER,
          stability REAL NOT NULL,
          difficulty REAL NOT NULL,
          elapsed_days REAL NOT NULL,
          scheduled_days REAL NOT NULL,
          reps INTEGER NOT NULL DEFAULT 0,
          lapses INTEGER NOT NULL DEFAULT 0,
          state INTEGER NOT NULL,
          CHECK(state >= 0 AND state <= 3),
          CHECK(dismissed = FALSE OR dismissed = TRUE),
          CHECK(deleted = FALSE OR deleted = TRUE)
        );`,
        {
          id: 'id',
          reference: 'reference',
          created_at: 'created_at',
          parent: 'parent',
          due: 'due',
          dismissed: 'dismissed',
          last_review: 'last_review',
          stability: 'stability',
          difficulty: 'difficulty',
          elapsed_days: 'elapsed_days',
          scheduled_days: 'scheduled_days',
          reps: 'reps',
          lapses: 'lapses',
          state: 'state',
        },
        { defaultedColumns: ['deleted'] }
      );
    },
  },
  {
    version: 6,
    description:
      'Migrate references from DATA_DIRECTORY-relative to vault-relative paths',
    up: (db) => {
      db.exec(
        `UPDATE article SET reference = '${DATA_DIRECTORY}/' || reference WHERE reference NOT LIKE '${DATA_DIRECTORY}/%'`
      );
      db.exec(
        `UPDATE snippet SET reference = '${DATA_DIRECTORY}/' || reference WHERE reference NOT LIKE '${DATA_DIRECTORY}/%'`
      );
      db.exec(
        `UPDATE srs_card SET reference = '${DATA_DIRECTORY}/' || reference WHERE reference NOT LIKE '${DATA_DIRECTORY}/%'`
      );
    },
  },
  {
    version: 7,
    description: 'Add due time intra-day fuzzing column',
    up: (db) => {
      addColumnIfNotExists(db, 'article', 'due_fuzz', 'INTEGER DEFAULT NULL');
      addColumnIfNotExists(db, 'snippet', 'due_fuzz', 'INTEGER DEFAULT NULL');
    },
  },
  {
    version: 8,
    description: 'Add learning_steps field for FSRS-6 cards',
    up: (db) => {
      addColumnIfNotExists(
        db,
        'srs_card',
        'learning_steps',
        'INTEGER NOT NULL DEFAULT 0'
      );
      addColumnIfNotExists(
        db,
        'srs_card_review',
        'learning_steps',
        'INTEGER NOT NULL DEFAULT 0'
      );
    },
  },
  {
    version: 9,
    description:
      'Key item tables on id, cascade review deletes, and restore lost indexes',
    up: (db) => {
      // Foreign key enforcement needs a unique parent key, so `id` becomes a
      // PRIMARY KEY on every item table. Without it SQLite rejects any write
      // touching a review table with "foreign key mismatch".
      //
      // The parents are rebuilt first: a rebuild renames the original out of
      // the way, and a child rebuilt beforehand would be pointing at whichever
      // name existed at the time.
      recreateTable(
        db,
        'article',
        `CREATE TABLE article (
          id TEXT NOT NULL PRIMARY KEY, -- UUID
          reference TEXT NOT NULL UNIQUE, -- pointer to the file's location in the vault
          due INTEGER, -- unix timestamp
          due_fuzz INTEGER DEFAULT NULL, -- milliseconds to offset due time for intra-day review ordering
          interval INTEGER NOT NULL, -- the interval that was used to calculate \`due\`
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
        );`,
        {
          id: 'id',
          reference: 'reference',
          due: 'due',
          due_fuzz: 'due_fuzz',
          interval: 'interval',
          priority: 'priority',
          fixed_interval_days: 'fixed_interval_days',
          dismissed: 'dismissed',
          deleted: 'deleted',
          scroll_top: 'scroll_top',
        }
      );

      recreateTable(
        db,
        'snippet',
        `CREATE TABLE snippet (
          id TEXT NOT NULL PRIMARY KEY, -- UUID
          reference TEXT NOT NULL UNIQUE, -- pointer to the file's location in the vault
          parent TEXT DEFAULT NULL, -- UUID; null if it wasn't created from an article or snippet
          due INTEGER, -- unix timestamp
          due_fuzz INTEGER DEFAULT NULL, -- milliseconds to offset due time for intra-day review ordering
          interval INTEGER NOT NULL, -- the interval that was used to calculate \`due\`
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
        );`,
        {
          id: 'id',
          reference: 'reference',
          parent: 'parent',
          due: 'due',
          due_fuzz: 'due_fuzz',
          interval: 'interval',
          priority: 'priority',
          dismissed: 'dismissed',
          deleted: 'deleted',
          scroll_top: 'scroll_top',
          start_offset: 'start_offset',
          end_offset: 'end_offset',
        }
      );

      recreateTable(
        db,
        'srs_card',
        `CREATE TABLE srs_card (
          id TEXT NOT NULL PRIMARY KEY, -- UUID
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
        );`,
        {
          id: 'id',
          reference: 'reference',
          parent: 'parent',
          created_at: 'created_at',
          due: 'due',
          dismissed: 'dismissed',
          deleted: 'deleted',
          last_review: 'last_review',
          stability: 'stability',
          difficulty: 'difficulty',
          elapsed_days: 'elapsed_days',
          scheduled_days: 'scheduled_days',
          learning_steps: 'learning_steps',
          reps: 'reps',
          lapses: 'lapses',
          state: 'state',
        }
      );

      // Rebuilding the review tables restates their REFERENCES clauses, which
      // both adds the cascade and repairs databases whose clauses were left
      // pointing at a `*_old` temporary table by the rebuilds in v3-v5.
      recreateTable(
        db,
        'article_review',
        `CREATE TABLE article_review (
          id TEXT NOT NULL PRIMARY KEY, -- UUID
          article_id TEXT NOT NULL REFERENCES article(id) ON DELETE CASCADE,
          review_time INTEGER NOT NULL
        );`,
        { id: 'id', article_id: 'article_id', review_time: 'review_time' }
      );

      recreateTable(
        db,
        'snippet_review',
        `CREATE TABLE snippet_review (
          id TEXT NOT NULL PRIMARY KEY, -- UUID
          snippet_id TEXT NOT NULL REFERENCES snippet(id) ON DELETE CASCADE,
          review_time INTEGER NOT NULL
        );`,
        { id: 'id', snippet_id: 'snippet_id', review_time: 'review_time' }
      );

      recreateTable(
        db,
        'srs_card_review',
        `CREATE TABLE srs_card_review (
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
        );`,
        {
          id: 'id',
          card_id: 'card_id',
          due: 'due',
          review: 'review',
          stability: 'stability',
          difficulty: 'difficulty',
          elapsed_days: 'elapsed_days',
          last_elapsed_days: 'last_elapsed_days',
          scheduled_days: 'scheduled_days',
          learning_steps: 'learning_steps',
          rating: 'rating',
          state: 'state',
        }
      );

      // `recreateTable` carries across whatever indexes a table already has, so
      // these statements are only reached by databases that lost theirs to the
      // rebuilds in v3-v5 — those tables arrive here with nothing to carry.
      db.exec(`
        CREATE INDEX IF NOT EXISTS article_uuid ON article(id);
        CREATE INDEX IF NOT EXISTS article_reference ON article(reference);
        CREATE INDEX IF NOT EXISTS article_due ON article(due);
        CREATE INDEX IF NOT EXISTS snippet_uuid ON snippet(id);
        CREATE INDEX IF NOT EXISTS snippet_reference ON snippet(reference);
        CREATE INDEX IF NOT EXISTS snippet_due ON snippet(due);
        CREATE INDEX IF NOT EXISTS srs_card_uuid ON srs_card(id);
        CREATE INDEX IF NOT EXISTS srs_card_reference ON srs_card(reference);
        CREATE INDEX IF NOT EXISTS srs_card_due ON srs_card(due);
      `);
    },
  },
];
