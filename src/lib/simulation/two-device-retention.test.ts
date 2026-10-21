import { tombstoneRowStatements } from '#/lib/items/row-delete';
import { STALE_AFTER_MS } from '#/lib/repository/write-stamp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DB_PATH } from './FakeVault';
import { FakeSync, makeDevice, type FakeDevice } from './SimulationHarness';

// #region HELPERS

const T = 1_790_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function ids(device: FakeDevice, table: string, where = 'TRUE'): string[] {
  return (
    device.repo.query(
      `SELECT id FROM ${table} WHERE ${where} ORDER BY id`
    ) as unknown as { id: string }[]
  ).map(({ id }) => id);
}

function backups(device: FakeDevice): string[] {
  return device.vault.adapter
    .paths()
    .filter((path) => path !== DEFAULT_DB_PATH);
}

function setClocks(now: number, ...devices: FakeDevice[]) {
  for (const device of devices) device.clock.now = now;
}

// #endregion

describe('retention across two devices', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never brings back a tombstone pruned on one device from a device more than 180 days behind that still has the row live', async () => {
    const sync = new FakeSync();
    const a = await makeDevice('a', { now: T });
    const b = await makeDevice('b', { now: T });
    a.repo.mutate(
      `INSERT INTO article (id, reference, due, interval, priority)
       VALUES ('x', 'notes/x.md', $1, $2, 30)`,
      [T, DAY]
    );
    a.repo.mutate(
      `INSERT INTO article_review (id, article_id, review_time)
       VALUES ('x-review', 'x', $1)`,
      [T]
    );
    await a.repo.settle();
    await sync.quiesce(a, b);
    expect(ids(b, 'article', 'deleted = FALSE')).toEqual(['x']);

    // B, offline from here on, saves its reading position in x; A
    // un-imports x, and neither hears of the other
    setClocks(T + DAY, a, b);
    b.repo.mutate(`UPDATE article SET scroll_top = 5 WHERE id = 'x'`);
    await b.repo.settle();
    await a.repo.transaction(() => {
      for (const { query, params } of tombstoneRowStatements('article', 'x')) {
        a.repo.mutate(query, params);
      }
    });
    await a.repo.settle();

    // A stays in use (a save the day before), and 181 days on its startup
    // prunes the tombstone and its review
    setClocks(T + DAY + STALE_AFTER_MS, a, b);
    a.repo.mutate(
      `INSERT INTO article (id, reference, due, interval, priority)
       VALUES ('y', 'notes/y.md', $1, $2, 30)`,
      [T + DAY + STALE_AFTER_MS, DAY]
    );
    await a.repo.settle();
    setClocks(T + DAY + STALE_AFTER_MS + DAY, a, b);
    await a.repo.applyRetention();
    await a.repo.settle();
    expect(ids(a, 'article')).toEqual(['y']);
    expect(ids(a, 'article_review')).toEqual([]);

    // B wakes; its own startup retention finds every save it holds past 180
    // days, so it prunes and saves nothing: a save would stamp B's copy as
    // current, and A would merge x back from it
    const bWrites = b.vault.adapter.lastWrittenBytes;
    await b.repo.applyRetention();
    await b.repo.settle();
    expect(b.vault.adapter.lastWrittenBytes).toBe(bWrites);

    // Before writing anything (0171 holds writes until Sync settles), B's
    // file reaches A: stale, so left alone and saved over
    const aWrites = a.vault.adapter.lastWrittenBytes;
    await sync.deliver(b, a);
    expect(ids(a, 'article')).toEqual(['y']);
    expect(a.vault.adapter.lastWrittenBytes).not.toBe(aWrites);
    expect(backups(a)).toEqual([]);

    // A's file reaches B: B is the stale one, backs itself up, takes it on
    await sync.deliver(a, b);
    expect(ids(b, 'article')).toEqual(['y']);
    expect(ids(b, 'article_review')).toEqual([]);
    expect(backups(b)).toEqual([expect.stringMatching(/_stale_/)]);

    await sync.quiesce(a, b);
    for (const device of [a, b]) {
      expect(ids(device, 'article')).toEqual(['y']);
      expect(ids(device, 'article_review')).toEqual([]);
    }
  });
});
