import { tombstoneRowStatements } from '#/lib/items/row-delete';
import * as notices from '#/lib/notices';
import { MERGE_TABLES } from '#/lib/repository/row-merge';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DB_PATH } from './FakeVault';
import { FakeSync, makeDevice, type FakeDevice } from './SimulationHarness';

// #region HELPERS

const T = 1_790_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const REFERENCES = ['notes/n0.md', 'notes/n1.md', 'notes/n2.md', 'pdf/p.pdf'];

type Row = Record<string, unknown>;

/** Two devices sharing one vault, each started without a file. */
async function twoDevices(skew = 0): Promise<[FakeDevice, FakeDevice]> {
  return [
    await makeDevice('a', { now: T }),
    await makeDevice('b', { now: T + skew }),
  ];
}

/** Import a note or PDF at `reference` as article `id`, unless one holds it. */
async function importArticle(
  device: FakeDevice,
  id: string,
  reference: string
) {
  device.repo.mutate(
    `INSERT INTO article (id, reference, due, interval, priority)
     SELECT $1, $2, $3, $4, 30
     WHERE NOT EXISTS (SELECT 1 FROM article WHERE reference = $2)`,
    [id, reference, T, DAY]
  );
  await device.repo.settle();
}

async function savePosition(device: FakeDevice, id: string, position: number) {
  device.repo.mutate(
    'UPDATE article SET scroll_top = $1 WHERE id = $2 AND deleted = FALSE',
    [position, id]
  );
  await device.repo.settle();
}

async function review(device: FakeDevice, id: string, articleId: string) {
  device.repo.mutate(
    `INSERT INTO article_review (id, article_id, review_time)
     VALUES ($1, $2, $3)`,
    [id, articleId, device.clock.now]
  );
  await device.repo.settle();
}

/** Un-import (or delete) an article as `ReviewManager.deleteRow` does. */
async function purge(device: FakeDevice, id: string) {
  await device.repo.transaction(() => {
    for (const { query, params } of tombstoneRowStatements('article', id)) {
      device.repo.mutate(query, params);
    }
  });
  await device.repo.settle();
}

function rows(
  device: FakeDevice,
  query: string,
  params: unknown[] = []
): Row[] {
  return device.repo.query(query, params as never) as unknown as Row[];
}

function liveArticles(device: FakeDevice): Row[] {
  return rows(
    device,
    'SELECT * FROM article WHERE deleted = FALSE ORDER BY id'
  );
}

/** Every synced table and the write stamp, whole, as `device` holds them. */
function everything(device: FakeDevice): Record<string, Row[]> {
  const tables: Record<string, Row[]> = {};
  for (const { name, key } of MERGE_TABLES) {
    tables[name] = rows(device, `SELECT * FROM ${name} ORDER BY ${key}`);
  }
  tables.write_stamp = rows(
    device,
    'SELECT * FROM write_stamp ORDER BY device'
  );
  return tables;
}

function backups(device: FakeDevice): string[] {
  return device.vault.adapter
    .paths()
    .filter((path) => path !== DEFAULT_DB_PATH);
}

/**
 * One thing that can happen on devices sharing a vault; `on`, `from` and
 * `to` index the devices.
 */
type Step =
  | { kind: 'import'; on: number; reference: number }
  | { kind: 'move'; on: number; pick: number; reference: number }
  | { kind: 'position'; on: number; pick: number; position: number }
  | { kind: 'purge'; on: number; pick: number }
  | { kind: 'review'; on: number; pick: number }
  | { kind: 'undo'; on: number; pick: number }
  | { kind: 'deliver'; from: number; to: number }
  | { kind: 'echo'; on: number }
  | { kind: 'wait'; on: number | 'all'; ms: number };

const pick = fc.nat(7);
const reference = fc.nat(REFERENCES.length - 1);

/**
 * Writes of every kind on `count` devices, deliveries in any order (a copy
 * can be delivered twice, or never), echoes, and clocks that move apart;
 * never so far apart that a device counts as stale, which drops a copy on
 * purpose.
 */
const stepsOn = (count: number): fc.Arbitrary<Step> => {
  const on = fc.nat(count - 1);
  return fc.oneof(
    {
      weight: 3,
      arbitrary: fc.record({
        kind: fc.constant('import' as const),
        on,
        reference,
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant('move' as const),
        on,
        pick,
        reference,
      }),
    },
    {
      weight: 3,
      arbitrary: fc.record({
        kind: fc.constant('position' as const),
        on,
        pick,
        position: fc.integer({ min: 1, max: 9 }),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({ kind: fc.constant('purge' as const), on, pick }),
    },
    {
      weight: 3,
      arbitrary: fc.record({ kind: fc.constant('review' as const), on, pick }),
    },
    {
      weight: 1,
      arbitrary: fc.record({ kind: fc.constant('undo' as const), on, pick }),
    },
    {
      weight: 4,
      arbitrary: fc
        .record({ from: on, offset: fc.integer({ min: 1, max: count - 1 }) })
        .map(({ from, offset }) => ({
          kind: 'deliver' as const,
          from,
          to: (from + offset) % count,
        })),
    },
    {
      weight: 1,
      arbitrary: fc.record({ kind: fc.constant('echo' as const), on }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant('wait' as const),
        on: fc.oneof(on, fc.constant('all' as const)),
        // Clocks stand still between steps unless moved, and can go back:
        // the row-stamp floor keeps every write past the saves already sent
        ms: fc.oneof(fc.constant(0), fc.integer({ min: -DAY, max: 30 * DAY })),
      }),
    }
  );
};

/** What a history wrote, to check the merged result against. */
interface Ledger {
  reviews: Set<string>;
  /** Each purge: the article and the stamp its tombstone got. */
  purges: { id: string; at: number; by: string }[];
  /**
   * Each write to a live article, by the stamp it got: the write stamp of
   * the device that made it, at the time, which says what it had seen.
   */
  writes: Map<string, Record<string, number>>;
}

const stampKey = (id: unknown, at: unknown, by: unknown) =>
  `${String(id)}|${String(at)}|${String(by)}`;

/**
 * Note in `ledger` the stamp `id` got from a write on `device`, unless the
 * write changed nothing (the stamp is another device's, or already noted).
 */
function noteWrite(device: FakeDevice, id: string, ledger: Ledger) {
  const [row] = rows(
    device,
    'SELECT updated_at, updated_by FROM article WHERE id = $1',
    [id]
  );
  const key = stampKey(id, row?.updated_at, row?.updated_by);
  if (row?.updated_by !== device.name || ledger.writes.has(key)) return;
  const seen: Record<string, number> = {};
  for (const { device: d, generation } of rows(
    device,
    'SELECT device, generation FROM write_stamp'
  )) {
    seen[d as string] = generation as number;
  }
  ledger.writes.set(key, seen);
}

/** Run `step` (the `i`th) on `devices`, noting what it wrote in `ledger`. */
async function run(
  step: Step,
  i: number,
  devices: FakeDevice[],
  sync: FakeSync,
  ledger: Ledger
) {
  if (step.kind === 'deliver') {
    await sync.deliver(devices[step.from], devices[step.to]);
    return;
  }
  if (step.kind === 'echo') {
    await sync.echo(devices[step.on]);
    return;
  }
  if (step.kind === 'wait') {
    for (const [j, device] of devices.entries()) {
      if (step.on === 'all' || step.on === j) device.clock.now += step.ms;
    }
    return;
  }
  const device = devices[step.on];
  if (step.kind === 'import') {
    await importArticle(device, `art-${i}`, REFERENCES[step.reference]);
    noteWrite(device, `art-${i}`, ledger);
    return;
  }
  if (step.kind === 'undo') {
    const live = rows(
      device,
      'SELECT id FROM article_review WHERE deleted = FALSE ORDER BY id'
    );
    if (live.length === 0) return;
    device.repo.mutate(
      'UPDATE article_review SET deleted = TRUE WHERE id = $1',
      [live[step.pick % live.length].id as string]
    );
    await device.repo.settle();
    return;
  }
  const articles = liveArticles(device);
  if (articles.length === 0) return;
  const target = articles[step.pick % articles.length].id as string;
  switch (step.kind) {
    case 'move':
      device.repo.mutate(
        `UPDATE article SET reference = $1 WHERE id = $2
         AND NOT EXISTS (SELECT 1 FROM article WHERE reference = $1)`,
        [REFERENCES[step.reference], target]
      );
      await device.repo.settle();
      noteWrite(device, target, ledger);
      break;
    case 'position':
      await savePosition(device, target, step.position);
      noteWrite(device, target, ledger);
      break;
    case 'purge': {
      await purge(device, target);
      const [row] = rows(
        device,
        'SELECT updated_at, updated_by FROM article WHERE id = $1',
        [target]
      );
      ledger.purges.push({
        id: target,
        at: row.updated_at as number,
        by: row.updated_by as string,
      });
      break;
    }
    case 'review':
      await review(device, `rev-${i}`, target);
      ledger.reviews.add(`rev-${i}`);
      break;
  }
}

/**
 * Run `steps` on `devices`, let Sync settle, and check what any history must
 * leave: (1) every device holds the same rows, (2) no review is lost, (3) no
 * tombstone comes back unless a later write replaced it, (4) references stay
 * unique.
 */
async function checkSettled(
  devices: FakeDevice[],
  steps: Step[],
  sync: FakeSync
) {
  const ledger: Ledger = { reviews: new Set(), purges: [], writes: new Map() };
  for (const [i, step] of steps.entries()) {
    await run(step, i, devices, sync, ledger);
  }

  await sync.quiesce(...devices);

  // (1) convergence: every table, stamps included
  const merged = everything(devices[0]);
  for (const other of devices.slice(1)) {
    expect(everything(other)).toEqual(merged);
  }
  // (2) no review-log row lost, undone ones kept as tombstones
  const reviews = new Set(merged.article_review.map((r) => r.id));
  for (const id of ledger.reviews) expect(reviews).toContain(id);
  // (3) a tombstone stays one, unless a write made by a device that had
  // seen it replaced it: never an older copy of the row, nor a write made
  // without knowledge of the delete
  for (const { id, at, by } of ledger.purges) {
    const row = merged.article.find((r) => r.id === id)!;
    if (row.deleted === 1) continue;
    const seen = ledger.writes.get(
      stampKey(id, row.updated_at, row.updated_by)
    );
    expect(seen?.[by] ?? -1).toBeGreaterThanOrEqual(at);
  }
  // One note, one row: references stay unique
  const held = merged.article.map((r) => r.reference);
  expect(new Set(held).size).toBe(held.length);
}

// #endregion

describe('two devices merging one database file', () => {
  let sync: FakeSync;

  beforeEach(() => {
    sync = new FakeSync();
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('property: once Sync settles both hold the same rows, no review is lost, and no tombstone comes back unless written over later', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(stepsOn(2), { minLength: 6, maxLength: 24, size: 'max' }),
        fc.integer({ min: -DAY, max: DAY }),
        async (steps, skew) => {
          await checkSettled(await twoDevices(skew), steps, sync);
        }
      ),
      { numRuns: 500 }
    );
  }, 300_000);

  // Copies reach a device by more than one way round, already merged
  it('property: holds for three devices too', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(stepsOn(3), { minLength: 6, maxLength: 24, size: 'max' }),
        fc.integer({ min: -DAY, max: DAY }),
        fc.integer({ min: -DAY, max: DAY }),
        async (steps, skewB, skewC) => {
          const devices = [
            ...(await twoDevices(skewB)),
            await makeDevice('c', { now: T + skewC }),
          ];
          await checkSettled(devices, steps, sync);
        }
      ),
      { numRuns: 150 }
    );
  }, 300_000);

  // Found by the property before the row-stamp floor: with B's clock
  // standing still, its un-import was stamped at a generation it had already
  // sent A, so A's copy read as having seen it and A's older write won
  it('keeps an un-import stamped in the same millisecond as a save the other device already holds', async () => {
    const steps: Step[] = [
      { kind: 'import', on: 1, reference: 0 },
      { kind: 'deliver', from: 1, to: 0 },
      { kind: 'position', on: 0, pick: 0, position: 1 },
      { kind: 'review', on: 1, pick: 0 },
      { kind: 'deliver', from: 1, to: 0 },
      { kind: 'purge', on: 1, pick: 0 },
      { kind: 'deliver', from: 0, to: 1 },
    ];
    const devices = await twoDevices(-2);
    await checkSettled(devices, steps, sync);
    expect(liveArticles(devices[0])).toEqual([]);
  });

  // 2026-10-20: the note imported on A went missing ("Not in database") once
  // B's copy, saved between A's two saves, was taken on whole
  it('keeps the note imported on one device when the other saved a reading position between its two saves', async () => {
    const [a, b] = await twoDevices();
    await importArticle(b, 'pdf', 'pdf/p.pdf');
    await sync.deliver(b, a);

    await importArticle(a, 'note', 'notes/n0.md');
    await savePosition(b, 'pdf', 7);
    await savePosition(a, 'note', 3);
    await sync.deliver(b, a);
    await sync.deliver(a, b);

    for (const device of [a, b]) {
      expect(
        liveArticles(device).map(({ id, scroll_top }) => [id, scroll_top])
      ).toEqual([
        ['note', 3],
        ['pdf', 7],
      ]);
    }
    expect(everything(a)).toEqual(everything(b));
    expect([...backups(a), ...backups(b)]).toEqual([]);
  });

  // 0166: an article un-imported on one device while the other kept working
  it('keeps an un-import from one device and the other device’s work done meanwhile', async () => {
    const [a, b] = await twoDevices();
    await importArticle(a, 'gone', 'notes/n0.md');
    await importArticle(a, 'kept', 'notes/n1.md');
    await review(a, 'r1', 'gone');
    await sync.deliver(a, b);

    await savePosition(b, 'gone', 5);
    a.clock.now += 1000;
    b.clock.now += 1000;
    await purge(a, 'gone');
    await review(b, 'r2', 'kept');
    await sync.deliver(a, b);
    await sync.deliver(b, a);

    for (const device of [a, b]) {
      expect(liveArticles(device).map((row) => row.id)).toEqual(['kept']);
      expect(
        rows(device, 'SELECT id, deleted FROM article_review ORDER BY id')
      ).toEqual([
        { id: 'r1', deleted: 1 },
        { id: 'r2', deleted: 0 },
      ]);
    }
    expect(everything(a)).toEqual(everything(b));
    // The position B saved is older than the un-import, which A had not seen
    // it: both devices end with the tombstone, and B backed its row up
    expect(backups(a)).toEqual([]);
    expect(backups(b)).toHaveLength(1);
  });

  it('keeps an un-import over a newer write made on a device that had not seen it, backing that write up', async () => {
    const said = vi.spyOn(notices, 'notify').mockReturnValue(null);
    const [a, b] = await twoDevices();
    await importArticle(a, 'note', 'notes/n0.md');
    await sync.deliver(a, b);

    await purge(a, 'note');
    b.clock.now += 1000;
    await savePosition(b, 'note', 5);
    await review(b, 'r1', 'note');
    await sync.deliver(a, b);
    await sync.deliver(b, a);

    for (const device of [a, b]) {
      expect(liveArticles(device)).toEqual([]);
      expect(rows(device, 'SELECT id, deleted FROM article_review')).toEqual([
        { id: 'r1', deleted: 0 },
      ]);
    }
    expect(everything(a)).toEqual(everything(b));
    // B's position save is the change it loses
    expect(backups(a)).toEqual([]);
    expect(backups(b)).toHaveLength(1);
    expect(said).toHaveBeenCalledOnce();
    expect(said.mock.calls[0][0]).toMatch(/\b1 local change\b/);
  });
});
