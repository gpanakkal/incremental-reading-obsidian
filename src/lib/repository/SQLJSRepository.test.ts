import type { DataChangeEvent } from '#/lib/types';
import { readFileSync } from 'fs';
import type { App } from 'obsidian';
import { resolve } from 'path';
import type { Database } from 'sql.js';
import initSqlJs from 'sql.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SQLJSRepository } from './SQLJSRepository';

// #region HELPERS

/**
 * A repository backed by a real in-memory sql.js database. The production
 * update-hook wiring runs unchanged; only the vault-backed `save` and the
 * WASM/vault plumbing are stubbed so no filesystem is touched.
 */
class TestRepository extends SQLJSRepository {
  static createReal(schema: string, db: Database): TestRepository {
    const repo = new TestRepository({
      app: { vault: { adapter: {} } } as unknown as App,
      dbFilePath: 'ir-test.sqlite',
      schema,
    });
    repo.db = db;
    repo.registerUpdateHook();
    return repo;
  }

  // Writes to a real vault are irrelevant to these tests.
  protected override async save() {}
}

/**
 * Like {@link TestRepository} but runs the real `save()` (so `db.export()`
 * actually executes), stubbing only the vault write. `export()` tears down the
 * sql.js update hook, so this exercise catches a regression where the hook is
 * not re-armed after a save.
 */
class SavingTestRepository extends SQLJSRepository {
  static createReal(schema: string, db: Database): SavingTestRepository {
    const repo = new SavingTestRepository({
      app: {
        vault: {
          adapter: { writeBinary: vi.fn().mockResolvedValue(undefined) },
          getFolderByPath: vi.fn().mockReturnValue({}),
        },
      } as unknown as App,
      dbFilePath: 'ir-test.sqlite',
      schema,
    });
    repo.db = db;
    repo.registerUpdateHook();
    return repo;
  }
}

function loadSchema(): string {
  return readFileSync(resolve(__dirname, '../../db/schema.sql'), 'utf-8');
}

async function makeSql(): Promise<initSqlJs.SqlJsStatic> {
  const wasmBinary = readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'));
  return initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });
}

async function makeRepo(): Promise<{ repo: TestRepository; db: Database }> {
  const SQL = await makeSql();
  const schema = loadSchema();
  const db = new SQL.Database();
  db.exec(schema);
  const repo = TestRepository.createReal(schema, db);
  return { repo, db };
}

async function makeSavingRepo(): Promise<{
  repo: SavingTestRepository;
  db: Database;
}> {
  const SQL = await makeSql();
  const schema = loadSchema();
  const db = new SQL.Database();
  db.exec(schema);
  const repo = SavingTestRepository.createReal(schema, db);
  return { repo, db };
}

function insertArticle(repo: TestRepository, id: string, priority = 30) {
  repo.mutate(
    `INSERT INTO article (id, reference, due, interval, priority)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, `articles/${id}.md`, Date.now(), 86_400_000, priority]
  );
}

function insertSnippet(repo: TestRepository, id: string, priority = 30) {
  repo.mutate(
    `INSERT INTO snippet (id, reference, due, interval, priority)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, `snippets/${id}.md`, Date.now(), 86_400_000, priority]
  );
}

function insertCard(repo: TestRepository, id: string) {
  repo.mutate(
    `INSERT INTO srs_card (id, reference, created_at, due, stability,
       difficulty, elapsed_days, scheduled_days, reps, lapses, state)
     VALUES ($1, $2, $3, $4, 0, 0, 0, 0, 0, 0, 0)`,
    [id, `cards/${id}.md`, Date.now(), Date.now()]
  );
}
// #endregion

describe('onDataChange', () => {
  let repo: TestRepository;

  beforeEach(async () => {
    ({ repo } = await makeRepo());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits an insert event with the affected UUID id', () => {
    const events: DataChangeEvent[] = [];
    repo.onDataChange((e) => events.push(e));

    insertArticle(repo, 'a1');

    expect(events).toEqual([
      { table: 'article', op: 'insert', ids: ['a1'] },
    ]);
  });

  it('emits an update event with the affected id', () => {
    insertArticle(repo, 'a1', 30);
    const events: DataChangeEvent[] = [];
    repo.onDataChange((e) => events.push(e));

    repo.mutate(`UPDATE article SET priority = $1 WHERE id = $2`, [40, 'a1']);

    expect(events).toEqual([
      { table: 'article', op: 'update', ids: ['a1'] },
    ]);
  });

  it('emits an update event when a row is soft-deleted', () => {
    // The app removes items from the queue by flipping `deleted`/`dismissed`,
    // not with a SQL DELETE. That surfaces as an update the queue can act on.
    insertArticle(repo, 'a1');
    const events: DataChangeEvent[] = [];
    repo.onDataChange((e) => events.push(e));

    repo.mutate(`UPDATE article SET deleted = TRUE WHERE id = $1`, ['a1']);

    expect(events).toEqual([
      { table: 'article', op: 'update', ids: ['a1'] },
    ]);
  });

  it('resolves ids for writes that match on a non-id column', () => {
    insertArticle(repo, 'a1');
    const events: DataChangeEvent[] = [];
    repo.onDataChange((e) => events.push(e));

    // dismiss-by-reference style predicate: the param is not the id
    repo.mutate(`UPDATE article SET dismissed = 1 WHERE reference = $1`, [
      'articles/a1.md',
    ]);

    expect(events).toEqual([
      { table: 'article', op: 'update', ids: ['a1'] },
    ]);
  });

  it('maps the srs_card table to the card note type', () => {
    insertCard(repo, 'c1');
    const events: DataChangeEvent[] = [];
    repo.onDataChange((e) => events.push(e));

    repo.mutate(`UPDATE srs_card SET reps = 1 WHERE id = $1`, ['c1']);

    expect(events).toEqual([{ table: 'card', op: 'update', ids: ['c1'] }]);
  });

  it('batches a multi-row write into one event with every affected id', () => {
    insertArticle(repo, 'a1', 30);
    insertArticle(repo, 'a2', 30);
    insertArticle(repo, 'a3', 40);
    const events: DataChangeEvent[] = [];
    repo.onDataChange((e) => events.push(e));

    repo.mutate(`UPDATE article SET priority = 20 WHERE priority = $1`, [30]);

    expect(events).toHaveLength(1);
    expect(events[0].table).toBe('article');
    expect(events[0].op).toBe('update');
    expect(events[0].ids.sort()).toEqual(['a1', 'a2']);
  });

  it('emits a separate event per table touched in one write', () => {
    insertArticle(repo, 'a1');
    insertSnippet(repo, 's1');
    const events: DataChangeEvent[] = [];
    repo.onDataChange((e) => events.push(e));

    repo.mutate(
      `UPDATE article SET priority = 25 WHERE id = 'a1';
       UPDATE snippet SET priority = 25 WHERE id = 's1';`
    );

    const tables = events.map((e) => e.table).sort();
    expect(tables).toEqual(['article', 'snippet']);
  });

  it('does not emit for writes to review tables (not queue items)', () => {
    insertArticle(repo, 'a1');
    const events: DataChangeEvent[] = [];
    repo.onDataChange((e) => events.push(e));

    repo.mutate(
      `INSERT INTO article_review (id, article_id, review_time)
       VALUES ($1, $2, $3)`,
      ['r1', 'a1', Date.now()]
    );

    expect(events).toEqual([]);
  });

  it('stops delivering after unsubscribe', () => {
    const events: DataChangeEvent[] = [];
    const unsubscribe = repo.onDataChange((e) => events.push(e));

    insertArticle(repo, 'a1');
    unsubscribe();
    insertArticle(repo, 'a2');

    expect(events).toHaveLength(1);
    expect(events[0].ids).toEqual(['a1']);
  });

  it('delivers to multiple listeners', () => {
    const a: DataChangeEvent[] = [];
    const b: DataChangeEvent[] = [];
    repo.onDataChange((e) => a.push(e));
    repo.onDataChange((e) => b.push(e));

    insertArticle(repo, 'a1');

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  // Regression: sql.js `db.export()` (run by the real `save()` after every
  // mutate) tears down the update hook. Without re-arming it, only the first
  // write per save would emit — the queue would stop updating after one change.
  it('keeps emitting across successive writes despite save/export', async () => {
    const { repo: savingRepo } = await makeSavingRepo();
    const events: DataChangeEvent[] = [];
    savingRepo.onDataChange((e) => events.push(e));

    savingRepo.mutate(
      `INSERT INTO article (id, reference, due, interval, priority)
       VALUES ($1, $2, $3, $4, $5)`,
      ['a1', 'articles/a1.md', Date.now(), 86_400_000, 30]
    );
    savingRepo.mutate(`UPDATE article SET priority = $1 WHERE id = $2`, [
      40,
      'a1',
    ]);
    savingRepo.mutate(
      `INSERT INTO article (id, reference, due, interval, priority)
       VALUES ($1, $2, $3, $4, $5)`,
      ['a2', 'articles/a2.md', Date.now(), 86_400_000, 30]
    );

    expect(events).toEqual([
      { table: 'article', op: 'insert', ids: ['a1'] },
      { table: 'article', op: 'update', ids: ['a1'] },
      { table: 'article', op: 'insert', ids: ['a2'] },
    ]);
  });
});
