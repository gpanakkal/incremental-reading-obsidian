import { MS_PER_DAY } from '#/lib/constants';
import IRScheduler from '#/lib/IRScheduler';
import { ArticleManager } from '#/lib/items/ArticleManager';
import { CardManager } from '#/lib/items/CardManager';
import {
  PURGED_REFERENCE_PREFIX,
  tombstoneRowStatements,
} from '#/lib/items/row-delete';
import SRSCard from '#/lib/items/SRSCard';
import * as notices from '#/lib/notices';
import { MERGE_TABLES } from '#/lib/repository/row-merge';
import {
  initialCard,
  initialText,
  liveInOrder,
  replayCard,
  replayText,
  type LoggedGrade,
} from '#/lib/repository/scheduling-replay';
import { makeLinkVault } from '#/test/link-vault';
import fc from 'fast-check';
import type { TFile } from 'obsidian';
import { generatorParameters, Rating, type Grade } from 'ts-fsrs';
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

/** A review log row `id` alone, leaving the article's schedule as it was. */
async function review(device: FakeDevice, id: string, articleId: string) {
  device.repo.mutate(
    `INSERT INTO article_review (id, article_id, review_time)
     VALUES ($1, $2, $3)`,
    [id, articleId, device.clock.now]
  );
  await device.repo.settle();
}

/** The settings reviews read, as every simulated device has them. */
const PLUGIN = {
  app: {},
  settings: {
    fuzzTextReviews: false,
    fsrsParams: generatorParameters(),
    dayRolloverOffset: 4,
  },
} as never;

/** The article `id` as `device` holds it, as the review code takes it. */
function articleOn(device: FakeDevice, id: string) {
  const [row] = rows(device, 'SELECT * FROM article WHERE id = $1', [id]);
  return { ...row, type: 'article', dismissed: !!row.dismissed } as never;
}

/**
 * Review article `id` on `device` as the review tab does
 * (`ArticleManager.review`), at the device's time.
 * @returns the id of the review
 */
async function reviewArticle(device: FakeDevice, id: string) {
  const reviewId = await new ArticleManager(PLUGIN, device.repo).review(
    articleOn(device, id),
    device.clock.now
  );
  await device.repo.settle();
  return reviewId;
}

/** Make card `id` on `device` as `CardManager` does, never graded. */
async function makeCard(device: FakeDevice, id: string) {
  const reference = `cards/${id}.md`;
  const card = new SRSCard(reference, new Date(device.clock.now));
  card.id = id;
  // The row records its note's fingerprint, so the note needs a `stat`
  const file = makeLinkVault({ [reference]: {} }).files.get(reference)!;
  await (
    new CardManager(PLUGIN, device.repo) as unknown as {
      insertRow(card: SRSCard, parent: null, file: TFile): Promise<void>;
    }
  ).insertRow(card, null, file);
  await device.repo.settle();
}

/** Grade card `id` on `device` as the review tab does, at its time. */
async function gradeCard(device: FakeDevice, id: string, grade: Grade) {
  const [row] = rows(device, 'SELECT * FROM srs_card WHERE id = $1', [id]);
  await new CardManager(PLUGIN, device.repo).review(
    CardManager.rowToDisplay(row as never),
    grade,
    new Date(device.clock.now)
  );
  await device.repo.settle();
}

const CARD_COLUMNS = [
  'due',
  'last_review',
  'stability',
  'difficulty',
  'elapsed_days',
  'scheduled_days',
  'learning_steps',
  'reps',
  'lapses',
  'state',
] as const;

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

/** A review a device can still undo, and the article as it was before. */
interface Undoable {
  id: string;
  article: string;
  before: Row;
  /** The schedule the review left, which a merge may since have changed. */
  after: Row;
}

/** What a history wrote, to check the merged result against. */
interface Ledger {
  reviews: Set<string>;
  /** Every review, in the order they were made. */
  made: string[];
  /** Each device's reviews it can undo, latest last. */
  undo: Map<string, Undoable[]>;
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
    // The latest review made here, as the undo history has it
    const last = ledger.undo.get(device.name)?.pop();
    if (!last) return;
    const [now] = rows(
      device,
      `SELECT r.deleted, a.interval, a.due, (
         SELECT count(*) FROM article_review later
         WHERE later.article_id = a.id AND later.deleted = FALSE
           AND later.review_time > r.review_time
       ) AS later FROM article a
       JOIN article_review r ON r.article_id = a.id WHERE r.id = $1`,
      [last.id]
    );
    // An undo puts back the schedule from before the review, which a merge
    // since then has made stale, and undoes every review dated after it,
    // which a clock that went back can make reviews made before it: both
    // out of this task's scope (see 0170's notes)
    if (
      now?.deleted !== 0 ||
      now.later !== 0 ||
      now.interval !== last.after.interval ||
      now.due !== last.after.due
    ) {
      return;
    }
    await new ArticleManager(PLUGIN, device.repo).undoReview(
      { ...last.before, dismissed: !!last.before.dismissed } as never,
      last.id
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
    case 'review': {
      const [before] = rows(device, 'SELECT * FROM article WHERE id = $1', [
        target,
      ]);
      const id = await reviewArticle(device, target);
      const [after] = rows(
        device,
        'SELECT interval, due FROM article WHERE id = $1',
        [target]
      );
      ledger.reviews.add(id);
      ledger.made.push(id);
      const undo = ledger.undo.get(device.name) ?? [];
      undo.push({ id, article: target, before, after });
      ledger.undo.set(device.name, undo);
      break;
    }
  }
}

/**
 * Run `steps` on `devices`, let Sync settle, and check what any history must
 * leave: (1) every device holds the same rows, (2) no review is lost, (3) no
 * tombstone comes back unless a later write replaced it, (4) every article's
 * schedule is what its merged log implies, (5) references stay unique.
 */
async function checkSettled(
  devices: FakeDevice[],
  steps: Step[],
  sync: FakeSync
) {
  const ledger: Ledger = {
    reviews: new Set(),
    made: [],
    undo: new Map(),
    purges: [],
    writes: new Map(),
  };
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
  // (4) the schedule its merged log implies: replayed from the import, the
  // base interval due at T. The interval goes by the number of reviews; the
  // due date by the latest by time, which is the one made last unless a
  // clock went back between them. Purged rows are no item's any more
  for (const article of merged.article) {
    if (
      article.reference === `${PURGED_REFERENCE_PREFIX}${String(article.id)}`
    ) {
      continue;
    }
    const log = merged.article_review
      .filter((r) => r.article_id === article.id)
      .map((r) => ({
        id: r.id as string,
        at: r.review_time as number,
        deleted: r.deleted as number,
      }));
    const expected = replayText(
      log,
      { priority: article.priority as number },
      { fuzzTextReviews: false },
      initialText({ due: T, due_fuzz: null })
    );
    expect(article.interval).toBe(expected.interval);
    const live = liveInOrder(log).map((r) => ledger.made.indexOf(r.id));
    if (live.every((made, i) => i === 0 || live[i - 1] < made)) {
      expect(article.due).toBe(expected.due);
    }
  }
  // (5) one note, one row: references stay unique
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

  it('property: once Sync settles both hold the same rows, no review is lost, no tombstone comes back unless written over later, and every schedule is what its merged log implies', async () => {
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

  // 0170: scheduling columns come from the merged log, never the row that won
  it('ends an article dismissed on one device after a review on the other dismissed, with the schedule of the review, on both', async () => {
    const [a, b] = await twoDevices();
    await importArticle(a, 'note', 'notes/n0.md');
    await sync.deliver(a, b);

    a.clock.now += 3 * MS_PER_DAY;
    await reviewArticle(a, 'note');
    const [reviewed] = rows(a, 'SELECT interval, due FROM article');
    b.clock.now += 4 * MS_PER_DAY;
    b.repo.mutate('UPDATE article SET dismissed = 1 WHERE id = $1', ['note']);
    await b.repo.settle();
    await sync.quiesce(a, b);

    for (const device of [a, b]) {
      expect(
        rows(device, 'SELECT dismissed, interval, due FROM article')
      ).toEqual([{ dismissed: 1, ...reviewed }]);
    }
    expect(everything(a)).toEqual(everything(b));
  });

  it('gives a card graded on both devices the state both grades imply, the same on both, keeping both grades', async () => {
    const [a, b] = await twoDevices();
    await makeCard(a, 'card');
    await sync.deliver(a, b);

    a.clock.now += 2 * MS_PER_DAY;
    await gradeCard(a, 'card', Rating.Good);
    b.clock.now += 2 * MS_PER_DAY + 60_000;
    await gradeCard(b, 'card', Rating.Again);
    await sync.quiesce(a, b);

    const [card] = rows(a, 'SELECT * FROM srs_card');
    const log = rows(
      a,
      'SELECT id, review AS at, rating, deleted FROM srs_card_review'
    ) as unknown as LoggedGrade[];
    expect(log.map((r) => [r.rating, r.deleted])).toEqual(
      expect.arrayContaining([
        [Rating.Good, 0],
        [Rating.Again, 0],
      ])
    );
    expect(log).toHaveLength(2);
    const both = replayCard(
      log,
      generatorParameters(),
      initialCard(card.created_at as number)
    );
    for (const device of [a, b]) {
      const [held] = rows(device, 'SELECT * FROM srs_card');
      expect(Object.fromEntries(CARD_COLUMNS.map((c) => [c, held[c]]))).toEqual(
        both
      );
    }
    expect(both.reps).toBe(2);
    expect(everything(a)).toEqual(everything(b));
  });

  it('puts an article back as it was before a review undone on one device after the other merged the review, though the other wrote it since', async () => {
    const [a, b] = await twoDevices();
    await importArticle(a, 'note', 'notes/n0.md');
    await sync.deliver(a, b);
    const [imported] = rows(a, 'SELECT interval, due FROM article');

    a.clock.now += MS_PER_DAY;
    b.clock.now += MS_PER_DAY;
    const [before] = rows(a, 'SELECT * FROM article');
    const id = await reviewArticle(a, 'note');
    await sync.deliver(a, b);
    await new ArticleManager(PLUGIN, a.repo).undoReview(
      { ...before, dismissed: !!before.dismissed } as never,
      id
    );
    await a.repo.settle();
    // B, still holding the review, writes the article after A's undo
    b.clock.now += 1000;
    await savePosition(b, 'note', 4);
    await sync.quiesce(a, b);

    for (const device of [a, b]) {
      expect(
        rows(device, 'SELECT interval, due, scroll_top FROM article')
      ).toEqual([{ ...imported, scroll_top: 4 }]);
      expect(rows(device, 'SELECT deleted FROM article_review')).toEqual([
        { deleted: 1 },
      ]);
    }
    expect(everything(a)).toEqual(everything(b));
  });

  it('replays with the settings of the device that merges, fuzzing a due date a replay moves when text reviews are fuzzed', async () => {
    vi.spyOn(IRScheduler, 'getDueFuzz').mockReturnValue(-7);
    const replaySettings = { fsrsParams: {}, fuzzTextReviews: true };
    const [a, b] = [
      await makeDevice('a', { now: T, replaySettings }),
      await makeDevice('b', { now: T, replaySettings }),
    ];
    await importArticle(a, 'note', 'notes/n0.md');
    await sync.deliver(a, b);

    a.clock.now += MS_PER_DAY;
    await reviewArticle(a, 'note');
    b.clock.now += 2 * MS_PER_DAY;
    await reviewArticle(b, 'note');
    await sync.quiesce(a, b);

    // Reviewed with fuzz off (see PLUGIN), so only a replay drew it
    for (const device of [a, b]) {
      expect(rows(device, 'SELECT due_fuzz FROM article')).toEqual([
        { due_fuzz: -7 },
      ]);
    }
  });
});
