import { createIrIdWatch, LOCAL_WRITE_WINDOW_MS } from '#/lib/ir-id-watch';
import ReviewManager from '#/lib/items/ReviewManager';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { MERGE_WAIT_MS } from '#/lib/readiness';
import { makeItemVault, TestRepository } from '#/test/item-vault';
import fc from 'fast-check';
import type { TFile } from 'obsidian';
import initSqlJs from 'sql.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #region HELPERS

const NOTE = 'notes/Note.md';

/** A device's repository, whose database can be replaced by another's file. */
class DeviceRepository extends TestRepository {
  static async make(): Promise<DeviceRepository> {
    const base = await TestRepository.create();
    return Object.setPrototypeOf(
      base,
      DeviceRepository.prototype
    ) as DeviceRepository;
  }

  /** The database file, as a save writes it for Sync to carry. */
  file(): Uint8Array {
    const bytes = this.db!.export();
    // `export` reopens the connection, as a real save's does
    this.registerUpdateHook();
    return bytes;
  }

  /** Take `bytes` as the database, as a reload after Sync delivers it does. */
  async load(bytes: Uint8Array) {
    const SQL = await initSqlJs();
    this.db = new SQL.Database(bytes);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.registerUpdateHook();
  }
}

/** How a device's tabs and clock stand, as its `ir-id` watch reads them. */
interface Screen {
  /** Whether a markdown tab here shows the note. */
  shown: boolean;
  /** This device's clock. */
  now: number;
}

/**
 * One device: a vault holding `notes`, a real database and item managers over
 * them, and the `ir-id` watch reporting to `onDamage`. Sync delivers to a note
 * no tab on the device shows, unless `screen` is changed.
 */
async function makeDevice(
  notes: Record<string, Record<string, unknown> | null>
) {
  const screen: Screen = { shown: false, now: 0 };
  const vault = makeItemVault(notes);
  const repo = await DeviceRepository.make();
  const plugin: Record<string, unknown> = {
    app: { ...vault.app, workspace: { trigger: vi.fn() } },
    settings: {
      autoImportTags: [],
      dayRolloverOffset: 4,
      copyOnImport: false,
      fuzzTextReviews: false,
    },
    registerEvent: vi.fn(),
    sessionTracker: { forgetIf: vi.fn() },
    autoImportWatcher: { unimporting: vi.fn() },
  };
  const reviewManager = new ReviewManager(plugin as never, repo);
  plugin.reviewManager = reviewManager;
  vi.spyOn(reviewManager.snippets, 'getHighlights').mockResolvedValue(
    undefined as never
  );
  const onDamage = vi.fn<(paths: readonly string[]) => void>();
  const watch = createIrIdWatch({
    repo,
    vault: vault.app.vault,
    metadataCache: vault.app.metadataCache,
    onDamage,
    isShown: () => screen.shown,
    now: () => screen.now,
    // Passes are run by hand, with `flush`
    schedule: () => () => {},
    yieldToHost: async () => {},
  });
  return {
    vault,
    repo,
    articles: reviewManager.articles,
    watch,
    onDamage,
    screen,
  };
}

type Device = Awaited<ReturnType<typeof makeDevice>>;

/**
 * Sync carrying the note at `path` from `from` to `to`: written there as `from`
 * holds it, then given `from`'s mtime, which Sync keeps.
 */
async function deliverNote(from: Device, to: Device, path: string) {
  const source = from.vault.files.get(path)!;
  const frontmatter = structuredClone(from.vault.frontmatterOf(path) ?? {});
  const target = to.vault.files.get(path) ?? to.vault.add(path, null);
  await to.vault.app.fileManager.processFrontMatter(target, (fm) => {
    for (const key of Object.keys(fm)) delete fm[key];
    Object.assign(fm, frontmatter);
  });
  target.stat.mtime = source.stat.mtime;
  to.watch.handleChange(target);
}

/** Sync carrying `from`'s database file to `to`, which reloads it. */
async function deliverDb(from: Device, to: Device) {
  await to.repo.load(from.repo.file());
}

/**
 * What the device holds of its items: every row, tombstones and stamps
 * included, and the note's frontmatter and mtime.
 */
function stateOf(device: Device) {
  const file: TFile | undefined = device.vault.files.get(NOTE);
  return {
    rows: device.repo.storedRows('article'),
    frontmatter: device.vault.frontmatterOf(NOTE),
    mtime: file?.stat.mtime,
  };
}

/**
 * Look at the device's copy as it would on its own: a pass of the watch, and
 * a review fetch of the item. Answers what it reported and fetched.
 */
async function look(device: Device, id: string) {
  const reported = await device.watch.flush();
  const fetched = await device.articles.fetch(id);
  // A fetch's row writes are fired off, not awaited
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { reported, fetched };
}

// #endregion

describe('a note un-imported on one device, with Sync carrying the note and the database to another', () => {
  beforeEach(() => {
    // A write of many rows yields through `window`, which this node
    // environment lacks
    vi.stubGlobal('window', globalThis);
    vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
    vi.spyOn(console, 'error').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** A and B in step, the note an article on both, and the article's id. */
  async function importedOnBoth() {
    const a = await makeDevice({ [NOTE]: { title: 'x' } });
    const b = await makeDevice({});
    const result = await a.articles.import(
      a.vault.files.get(NOTE)!,
      30,
      null,
      false
    );
    const id = result!.articleId;
    await deliverNote(a, b, NOTE);
    await deliverDb(a, b);
    await look(b, id);
    return { a, b, id };
  }

  it('starts from the note and the row in step on both, the row holding the mtime the import left', async () => {
    const { a, b, id } = await importedOnBoth();

    expect(stateOf(b)).toStrictEqual(stateOf(a));
    expect(stateOf(b).rows).toStrictEqual([
      expect.objectContaining({ id, note_mtime: stateOf(a).mtime }),
    ]);
  });

  it.each([
    ['the note first', ['note', 'db']],
    ['the database first', ['db', 'note']],
  ] as const)(
    'neither reports nor writes anything on the other device while one has arrived without the other, with %s, and ends in step',
    async (_, order) => {
      const { a, b, id } = await importedOnBoth();
      await a.articles.unimportMany([a.vault.files.get(NOTE)!]);
      const bWrites = vi.spyOn(b.repo, 'mutate');
      const bNoteWrites = vi.spyOn(Obsidian, 'updateFrontMatter');

      for (const [step, delivery] of order.entries()) {
        const before = stateOf(b);
        if (delivery === 'note') await deliverNote(a, b, NOTE);
        else await deliverDb(a, b);
        const delivered = stateOf(b);

        const { reported } = await look(b, id);

        expect(reported).toStrictEqual([]);
        expect(b.onDamage).not.toHaveBeenCalled();
        // Nothing but what was delivered changed
        expect(stateOf(b)).toStrictEqual(delivered);
        if (step === 0) {
          expect(delivered).not.toStrictEqual(before);
        }
      }

      expect(bWrites).not.toHaveBeenCalled();
      expect(bNoteWrites).not.toHaveBeenCalled();
      expect(stateOf(b)).toStrictEqual(stateOf(a));
      expect((await look(b, id)).fetched).toBeNull();
    }
  );

  describe('with the note open on the other device', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /**
     * The note, Sync-delivered `age` ms after the device it came from wrote it
     * by this device's clock (negative when that one's clock runs ahead), and
     * the database: first, being merged when the note lands until `mergeMs`
     * after; or after, landing `dbAfterMs` after the pass starts and merged in
     * `mergeMs`.
     */
    type Delivery =
      | { first: 'db'; age: number; mergeMs: number }
      | { first: 'note'; age: number; dbAfterMs: number; mergeMs: number };

    const anyAgeArb = fc.integer({ min: -1e9, max: 1e9 });
    /** An age no write made on this device could have. */
    const foreignAgeArb = fc.oneof(
      fc.integer({ min: LOCAL_WRITE_WINDOW_MS + 1, max: 1e9 }),
      fc.integer({ min: -1e9, max: -LOCAL_WRITE_WINDOW_MS - 1 })
    );
    const deliveryArb: fc.Arbitrary<Delivery> = fc.oneof(
      // A merge ending inside the pass's wait, however the note is dated
      fc.record({
        first: fc.constant('db' as const),
        age: anyAgeArb,
        mergeMs: fc.integer({ min: 0, max: 2 * MERGE_WAIT_MS - 1 }),
      }),
      // The database landing inside the pass's wait, however the note is dated
      fc.record({
        first: fc.constant('note' as const),
        age: anyAgeArb,
        dbAfterMs: fc.integer({ min: 0, max: MERGE_WAIT_MS - 1 }),
        mergeMs: fc.integer({ min: 0, max: MERGE_WAIT_MS - 1 }),
      }),
      // Either landing however late, the note dated as no write made here
      fc.record({
        first: fc.constant('db' as const),
        age: foreignAgeArb,
        mergeMs: fc.integer({ min: 0, max: 600_000 }),
      }),
      fc.record({
        first: fc.constant('note' as const),
        age: foreignAgeArb,
        dbAfterMs: fc.integer({ min: 0, max: 600_000 }),
        mergeMs: fc.integer({ min: 0, max: 600_000 }),
      })
    );

    /** Let every promise that can settle without a timer settle. */
    const drain = () => new Promise((resolve) => setImmediate(resolve));

    /**
     * Sync bringing `a`'s note and database to `b` as `delivery` orders and
     * times them, `b` showing the note, while a pass of `b`'s watch runs from
     * the moment the note lands. Answers what the pass reported.
     */
    async function deliverWhileOpen(a: Device, b: Device, delivery: Delivery) {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      b.screen.shown = true;
      b.screen.now = a.vault.files.get(NOTE)!.stat.mtime + delivery.age;
      const merge = async (afterMs: number, done: () => void) => {
        await vi.advanceTimersByTimeAsync(afterMs);
        await deliverDb(a, b);
        done();
      };

      if (delivery.first === 'db') {
        // The file has landed, and the reload is taking it in
        const done = b.repo.holdMerging();
        await deliverNote(a, b, NOTE);
        const pass = b.watch.flush();
        await drain();
        await merge(delivery.mergeMs, done);
        await vi.advanceTimersByTimeAsync(3 * MERGE_WAIT_MS);
        return pass;
      }
      await deliverNote(a, b, NOTE);
      const pass = b.watch.flush();
      await drain();
      await vi.advanceTimersByTimeAsync(delivery.dbAfterMs);
      await merge(delivery.mergeMs, b.repo.holdMerging());
      await vi.advanceTimersByTimeAsync(3 * MERGE_WAIT_MS);
      return pass;
    }

    it('neither reports nor writes anything for a note un-imported on one device, whichever file Sync brings first', async () => {
      await fc.assert(
        fc.asyncProperty(deliveryArb, async (delivery) => {
          const { a, b, id } = await importedOnBoth();
          await a.articles.unimportMany([a.vault.files.get(NOTE)!]);
          const bWrites = vi.spyOn(b.repo, 'mutate');
          const bNoteWrites = vi.spyOn(Obsidian, 'updateFrontMatter');

          const reported = await deliverWhileOpen(a, b, delivery);
          vi.useRealTimers();

          expect(reported).toStrictEqual([]);
          expect(b.onDamage).not.toHaveBeenCalled();
          expect(bWrites).not.toHaveBeenCalled();
          expect(bNoteWrites).not.toHaveBeenCalled();
          expect(stateOf(b)).toStrictEqual(stateOf(a));
          expect((await look(b, id)).fetched).toBeNull();
          bWrites.mockRestore();
          bNoteWrites.mockRestore();
        })
          // The next run sets up on the real clock, a failed one too
          .afterEach(() => vi.useRealTimers()),
        { numRuns: 40 }
      );
    });

    it('still reports a note stripped on this device while it is open, once the wait for Sync has passed', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({
            min: -LOCAL_WRITE_WINDOW_MS,
            max: LOCAL_WRITE_WINDOW_MS,
          }),
          async (offset) => {
            const { b } = await importedOnBoth();
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            b.screen.shown = true;
            const file = b.vault.files.get(NOTE)!;
            // Reading mode's properties editor, say, writing here and now
            await b.vault.app.fileManager.processFrontMatter(file, (fm) => {
              delete fm['ir-id'];
              delete fm.tags;
            });
            b.screen.now = file.stat.mtime + offset;
            b.watch.handleChange(file);

            const pass = b.watch.flush();
            await drain();
            await vi.advanceTimersByTimeAsync(MERGE_WAIT_MS - 1);
            expect(b.onDamage).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);

            expect(await pass).toStrictEqual([NOTE]);
            expect(b.onDamage.mock.calls).toStrictEqual([[[NOTE]]]);
          }
        )
          // The next run sets up on the real clock
          .afterEach(() => vi.useRealTimers()),
        { numRuns: 15 }
      );
    });
  });

  it('keeps the article on the other device, its note untouched, while only the stripped note has arrived', async () => {
    const { a, b, id } = await importedOnBoth();
    await a.articles.unimportMany([a.vault.files.get(NOTE)!]);

    await deliverNote(a, b, NOTE);
    const { fetched } = await look(b, id);

    // The row is still live there: the fetch has no proof to act on
    expect(fetched?.data.id).toBe(id);
    expect(b.vault.frontmatterOf(NOTE)).toStrictEqual(
      a.vault.frontmatterOf(NOTE)
    );
  });
});
