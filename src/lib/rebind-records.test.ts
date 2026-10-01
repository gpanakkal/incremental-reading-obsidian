import { SQLJSRepository } from '#/lib/repository/SQLJSRepository';
import fc from 'fast-check';
import { readFileSync } from 'fs';
import type { App } from 'obsidian';
import { resolve } from 'path';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  RECLAIM_WINDOW_MS,
  type RebindState,
  describeAmbiguous,
  describeRebind,
  describeReclaim,
  forgetRebind,
  isReclaimable,
  readRebinds,
  reclaimAtPath,
  recordRebind,
} from './rebind-records';

// #region HELPERS

const SCHEMA = readFileSync(resolve(__dirname, '../db/schema.sql'), 'utf-8');
const NOW = 1_800_000_000_000;

let SQL: SqlJsStatic;

class TestRepository extends SQLJSRepository {
  static create(): TestRepository {
    const repo = new TestRepository({
      app: { vault: { adapter: {} } } as unknown as App,
      dbFilePath: 'ir-test.sqlite',
      schema: SCHEMA,
    });
    repo.db = new SQL.Database();
    repo.db.exec(SCHEMA);
    repo.db.exec('PRAGMA foreign_keys = ON');
    repo.registerUpdateHook();
    return repo;
  }

  protected override async save() {}

  insertArticle(id: string, reference: string, deleted = false) {
    return this.mutate(
      `INSERT INTO article (id, reference, deleted, due, interval, priority)
       VALUES ($1, $2, $3, 0, 86400000, 30)`,
      [id, reference, deleted]
    );
  }

  articles() {
    const [result] = this.db?.exec(
      'SELECT id, reference, deleted FROM article ORDER BY id'
    ) ?? [undefined];
    return (result?.values ?? []).map(([id, reference, deleted]) => ({
      id: String(id),
      reference: String(reference),
      deleted: deleted === 1,
    }));
  }

  rebinds() {
    const [result] = this.db?.exec(
      'SELECT article_id, old_reference, new_reference, rebound_at FROM rebind ORDER BY article_id'
    ) ?? [undefined];
    return result?.values ?? [];
  }
}

/** A world with one article rebound from `old.pdf` to `new.pdf` at `at`. */
async function reboundWorld(at = NOW) {
  const repo = TestRepository.create();
  repo.insertArticle('a', 'new.pdf');
  await recordRebind(repo, { id: 'a', from: 'old.pdf', to: 'new.pdf' }, at);
  return repo;
}

const stateArb: fc.Arbitrary<RebindState> = fc.record({
  articleId: fc.string(),
  oldReference: fc.string(),
  newReference: fc.constantFrom('new.pdf', 'other.pdf'),
  reboundAt: fc.integer({
    min: NOW - 2 * RECLAIM_WINDOW_MS,
    max: NOW + RECLAIM_WINDOW_MS,
  }),
  reference: fc.constantFrom('new.pdf', 'other.pdf', null),
  deleted: fc.boolean(),
});

// #endregion

beforeAll(async () => {
  const wasmBinary = readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'));
  SQL = await initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isReclaimable', () => {
  it('holds exactly while the rebind is in its window and the article is where it was put, deleted or not', () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        expect(isReclaimable(state, NOW)).toBe(
          NOW - state.reboundAt <= RECLAIM_WINDOW_MS &&
            state.reference === state.newReference
        );
      })
    );
  });
});

describe('recordRebind, readRebinds and forgetRebind', () => {
  it('keeps one record per article, next to where the article is now', async () => {
    const repo = await reboundWorld(0);
    repo.insertArticle('b', 'b.pdf', true);
    await recordRebind(repo, { id: 'b', from: 'x.pdf', to: 'b.pdf' }, 5);
    // The first rebind has lapsed by now, so this one starts afresh
    await recordRebind(
      repo,
      { id: 'a', from: 'older.pdf', to: 'new.pdf' },
      RECLAIM_WINDOW_MS + 1
    );

    expect(await readRebinds(repo)).toEqual([
      {
        articleId: 'a',
        oldReference: 'older.pdf',
        newReference: 'new.pdf',
        reboundAt: RECLAIM_WINDOW_MS + 1,
        reference: 'new.pdf',
        deleted: false,
      },
      {
        articleId: 'b',
        oldReference: 'x.pdf',
        newReference: 'b.pdf',
        reboundAt: 5,
        reference: 'b.pdf',
        deleted: true,
      },
    ]);
  });

  it('keeps the first old path and time when a stand-in is rebound again within the window', async () => {
    const repo = await reboundWorld(0);
    repo.mutate(`UPDATE article SET reference = 'newer.pdf'`);

    await recordRebind(
      repo,
      { id: 'a', from: 'new.pdf', to: 'newer.pdf' },
      RECLAIM_WINDOW_MS
    );

    expect(repo.rebinds()).toEqual([['a', 'old.pdf', 'newer.pdf', 0]]);
  });

  it('forgets a record only when it is the one asked about', async () => {
    const repo = await reboundWorld(10);

    await forgetRebind(repo, 'a', 11);
    expect(repo.rebinds()).toHaveLength(1);
    await forgetRebind(repo, 'b');
    expect(repo.rebinds()).toHaveLength(1);
    await forgetRebind(repo, 'a', 10);
    expect(repo.rebinds()).toHaveLength(0);

    await recordRebind(repo, { id: 'a', from: 'old.pdf', to: 'new.pdf' }, 12);
    await forgetRebind(repo, 'a');
    expect(repo.rebinds()).toHaveLength(0);
  });
});

describe('reclaimAtPath', () => {
  it('puts the article back at the old path its own file turned up at, and forgets the rebind', async () => {
    const repo = await reboundWorld();

    const moved = await reclaimAtPath(repo, 'old.pdf', NOW + 1);

    expect(moved).toEqual({ id: 'a', from: 'new.pdf', to: 'old.pdf' });
    expect(repo.articles()).toEqual([
      { id: 'a', reference: 'old.pdf', deleted: false },
    ]);
    expect(repo.rebinds()).toEqual([]);
  });

  it('brings back an article deleted along with its stand-in', async () => {
    const repo = await reboundWorld();
    repo.mutate(`UPDATE article SET deleted = 1`);

    const moved = await reclaimAtPath(repo, 'old.pdf', NOW + 1);

    expect(moved).toEqual({ id: 'a', from: 'new.pdf', to: 'old.pdf' });
    expect(repo.articles()).toEqual([
      { id: 'a', reference: 'old.pdf', deleted: false },
    ]);
    expect(repo.rebinds()).toEqual([]);
  });

  it('reclaims up to the end of the window and not a moment after', async () => {
    const onTime = await reboundWorld();
    const late = await reboundWorld();

    expect(
      await reclaimAtPath(onTime, 'old.pdf', NOW + RECLAIM_WINDOW_MS)
    ).not.toBeNull();
    expect(
      await reclaimAtPath(late, 'old.pdf', NOW + RECLAIM_WINDOW_MS + 1)
    ).toBeNull();
    expect(late.articles()[0].reference).toBe('new.pdf');
  });

  it.each([
    ['no rebind left from it', 'elsewhere.pdf', async () => {}],
    [
      'the article was moved on since',
      'old.pdf',
      (repo: TestRepository) =>
        repo.mutate(`UPDATE article SET reference = 'moved.pdf'`),
    ],
    [
      'a live row names the path now',
      'old.pdf',
      (repo: TestRepository) => repo.insertArticle('b', 'old.pdf'),
    ],
    [
      'a tombstone names the path now',
      'old.pdf',
      (repo: TestRepository) => repo.insertArticle('b', 'old.pdf', true),
    ],
    [
      'a card names the path now',
      'old.pdf',
      (repo: TestRepository) =>
        repo.mutate(
          `INSERT INTO srs_card (id, reference, created_at, due, stability,
             difficulty, elapsed_days, scheduled_days, state)
           VALUES ('c', 'old.pdf', 0, 0, 0, 0, 0, 0, 0)`
        ),
    ],
    [
      'two articles were rebound away from it',
      'old.pdf',
      async (repo: TestRepository) => {
        repo.insertArticle('b', 'b-new.pdf');
        await recordRebind(
          repo,
          { id: 'b', from: 'old.pdf', to: 'b-new.pdf' },
          NOW
        );
      },
    ],
  ])('leaves everything alone when %s', async (_, path, setUp) => {
    const repo = await reboundWorld();
    await setUp(repo);
    const articles = repo.articles();
    const rebinds = repo.rebinds();

    expect(await reclaimAtPath(repo, path, NOW)).toBeNull();
    expect(repo.articles()).toEqual(articles);
    expect(repo.rebinds()).toEqual(rebinds);
  });

  it('opens no transaction for a path no rebind left', async () => {
    const repo = await reboundWorld();
    const transaction = vi.spyOn(repo, 'transaction');

    await reclaimAtPath(repo, 'elsewhere.pdf', NOW);

    expect(transaction).not.toHaveBeenCalled();
  });

  it('writes nothing when the article moves on between the read and the write', async () => {
    const repo = await reboundWorld();
    vi.spyOn(repo, 'transaction').mockImplementationOnce(
      <T>(work: () => T | Promise<T>): Promise<T> => {
        repo.mutate(`UPDATE article SET reference = 'moved.pdf'`);
        return SQLJSRepository.prototype.transaction.call(
          repo,
          work
        ) as Promise<T>;
      }
    );

    expect(await reclaimAtPath(repo, 'old.pdf', NOW)).toBeNull();
    expect(repo.articles()[0].reference).toBe('moved.pdf');
    expect(repo.rebinds()).toHaveLength(1);
  });
});

describe('log entries', () => {
  it('name the article and quote both paths', () => {
    const move = { id: 'a', from: 'x "1".pdf', to: 'y.pdf' };

    expect(describeRebind(move)).toBe(
      'rebound article a by filename: "x \\"1\\".pdf" -> "y.pdf"'
    );
    expect(describeReclaim(move)).toBe(
      'reclaimed article a, whose own file turned up at its old path: "x \\"1\\".pdf" -> "y.pdf"'
    );
    expect(describeAmbiguous({ id: 'a', reference: 'x.pdf' })).toBe(
      'left article a missing at "x.pdf": another missing article or more than one untracked file shares its filename'
    );
  });
});
