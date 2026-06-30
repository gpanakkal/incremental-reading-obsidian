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
          (row: SafeOmit<TableNameToRowType['article'], 'interval' | 'deleted'>) => {
            const lastReviewTime = latestReviewByArticle[row.id];
            const computed =
              lastReviewTime && row.due ? row.due - lastReviewTime : 0;

            // ensure the interval is positive
            const interval =
              computed > 0 ? computed : TEXT_BASE_REVIEW_INTERVAL;
            return { ...row, interval };
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
          (row: SafeOmit<TableNameToRowType['snippet'], 'interval' | 'deleted'>) => {
            const lastReviewTime = latestReviewBySnippet[row.id];
            const computed =
              lastReviewTime && row.due ? row.due - lastReviewTime : 0;
            const interval =
              computed > 0 ? computed : TEXT_BASE_REVIEW_INTERVAL;
            return { ...row, interval };
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
        }
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
        }
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
        }
      );
    },
  },
  {
    version: 6,
    description: 'Migrate references from DATA_DIRECTORY-relative to vault-relative paths',
    up: (db) => {
      db.exec(`UPDATE article SET reference = '${DATA_DIRECTORY}/' || reference WHERE reference NOT LIKE '${DATA_DIRECTORY}/%'`);
      db.exec(`UPDATE snippet SET reference = '${DATA_DIRECTORY}/' || reference WHERE reference NOT LIKE '${DATA_DIRECTORY}/%'`);
      db.exec(`UPDATE snippet SET parent = '${DATA_DIRECTORY}/' || parent WHERE parent IS NOT NULL AND parent NOT LIKE '${DATA_DIRECTORY}/%'`);
      db.exec(`UPDATE srs_card SET reference = '${DATA_DIRECTORY}/' || reference WHERE reference NOT LIKE '${DATA_DIRECTORY}/%'`);
      db.exec(`UPDATE srs_card SET parent = '${DATA_DIRECTORY}/' || parent WHERE parent IS NOT NULL AND parent NOT LIKE '${DATA_DIRECTORY}/%'`);
    },
  },
];
