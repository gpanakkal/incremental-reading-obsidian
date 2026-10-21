import { createIrIdWatch } from '#/lib/ir-id-watch';
import ReviewManager from '#/lib/items/ReviewManager';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { makeItemVault, TestRepository } from '#/test/item-vault';
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

/**
 * One device: a vault holding `notes`, a real database and item managers over
 * them, and the `ir-id` watch reporting to `onDamage`.
 */
async function makeDevice(
  notes: Record<string, Record<string, unknown> | null>
) {
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
    // Sync delivers to a note no tab on the device shows
    isShown: () => false,
    // Passes are run by hand, with `flush`
    schedule: () => () => {},
    yieldToHost: async () => {},
  });
  return { vault, repo, articles: reviewManager.articles, watch, onDamage };
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
