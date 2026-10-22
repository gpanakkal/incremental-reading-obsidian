import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { SQLJSRepository } from '#/lib/repository/SQLJSRepository';
import fc from 'fast-check';
import { readFileSync } from 'fs';
import {
  type App,
  type CachedMetadata,
  MarkdownView,
  type TFile,
  type Workspace,
} from 'obsidian';
import { resolve } from 'path';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import {
  type Mock,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ARTICLE_TAG, SNIPPET_TAG } from './constants';
import { createDamagedNotesNotice } from './ir-id-warning-notice';
import {
  DEBOUNCE_MS,
  type IrIdWatchDeps,
  LOCAL_WRITE_WINDOW_MS,
  type NoteClaim,
  PATH_BATCH,
  claimsIdentity,
  classifyTag,
  createIrIdWatch,
  readsAsTampering,
  settleAfterSync,
  shownInMarkdownView,
  writtenHere,
} from './ir-id-watch';
import { TAG_BY_TABLE, hasTag, withTag } from './item-tags';
import { purgedReference } from './items/row-delete';
import { type Holder, ITEM_TABLES, type ItemTable } from './moved-note-scan';
import { MERGE_WAIT_MS } from './readiness';
import type { Readiness } from './types';

// #region HELPERS

/** An item row as the database holds it. */
interface StoredRow {
  table: ItemTable;
  id: string;
  reference: string;
  deleted: boolean;
}

const SCHEMA = readFileSync(resolve(__dirname, '../db/schema.sql'), 'utf-8');
const FIXED_DUE = 1_700_000_000_000;

let SQL: SqlJsStatic;

/** A repository over a real in-memory database, with the vault write stubbed. */
class TestRepository extends SQLJSRepository {
  static create(): TestRepository {
    const repo = new TestRepository({
      app: { vault: { adapter: {} } } as unknown as App,
      dbFilePath: 'ir-test.sqlite',
      schema: SCHEMA,
    });
    repo.db = new SQL.Database();
    repo.db.exec(SCHEMA);
    repo.registerUpdateHook();
    return repo;
  }

  protected override async save() {}
}

function insertItem(repo: TestRepository, row: StoredRow) {
  if (row.table === 'srs_card') {
    repo.mutate(
      `INSERT INTO srs_card (id, reference, deleted, created_at, due, stability,
         difficulty, elapsed_days, scheduled_days, reps, lapses, state)
       VALUES ($1, $2, $3, $4, $4, 0, 0, 0, 0, 0, 0, 0)`,
      [row.id, row.reference, row.deleted, FIXED_DUE]
    );
    return;
  }
  repo.mutate(
    `INSERT INTO ${row.table} (id, reference, deleted, due, interval, priority)
     VALUES ($1, $2, $3, $4, 86400000, 30)`,
    [row.id, row.reference, row.deleted, FIXED_DUE]
  );
}

/** Every item row, read straight off the database so no spy counts it. */
function readRows(repo: TestRepository): StoredRow[] {
  return ITEM_TABLES.flatMap((table) => {
    const [result] = repo.db?.exec(
      `SELECT id, reference, deleted FROM ${table} ORDER BY id`
    ) ?? [undefined];
    return (result?.values ?? []).map(([id, reference, deleted]) => ({
      table,
      id: String(id),
      reference: String(reference),
      deleted: deleted === 1,
    }));
  });
}

interface FakeNote {
  path: string;
  /** Absent, along with `tags`, means the note has no frontmatter at all. */
  irId?: unknown;
  /** The frontmatter `tags` value; absent leaves the property out. */
  tags?: unknown;
}

/** The frontmatter a fake note starts out with, if any. */
function frontmatterOf(note: FakeNote): Record<string, unknown> | undefined {
  if (!('irId' in note) && !('tags' in note)) return undefined;
  const frontmatter: Record<string, unknown> = {};
  if ('irId' in note) frontmatter['ir-id'] = note.irId;
  if ('tags' in note) frontmatter.tags = note.tags;
  return frontmatter;
}

/**
 * The slice of vault and metadata cache the watch reads, over notes a test can
 * rewrite the way another device's write would.
 */
function makeVault(initial: readonly FakeNote[]) {
  const notes = new Map(
    initial.map((note) => [note.path, frontmatterOf(note)])
  );
  const files = new Map<string, TFile>();
  const fileAt = (path: string) => {
    const file =
      files.get(path) ?? ({ path, extension: 'md' } as unknown as TFile);
    files.set(path, file);
    return file;
  };

  return {
    notes,
    vault: {
      getFileByPath: vi.fn((path: string) =>
        notes.has(path) ? fileAt(path) : null
      ),
    },
    metadataCache: {
      getFileCache: vi.fn((file: TFile): CachedMetadata | null => {
        if (!notes.has(file.path)) return null;
        return { frontmatter: notes.get(file.path) } as CachedMetadata;
      }),
    },
    remove(path: string) {
      notes.delete(path);
    },
  };
}

/** A scheduler the test drives by hand, in place of `window.setTimeout`. */
function makeScheduler() {
  let queued: (() => void)[] = [];
  return {
    schedule: vi.fn((pass: () => void, _ms: number) => {
      queued.push(pass);
      return () => {
        queued = queued.filter((waiting) => waiting !== pass);
      };
    }),
    get pending() {
      return queued.length;
    },
    run() {
      const due = queued;
      queued = [];
      for (const pass of due) pass();
    },
  };
}

/** The changed-file object Obsidian hands a `changed` handler. */
const changed = (path: string, extension = 'md') => ({ path, extension });

/** {@link changed}, for a note whose last write left it at `mtime`. */
const changedAt = (path: string, mtime: number) => ({
  ...changed(path),
  stat: { ctime: mtime, mtime, size: 0 },
});

/** Let every promise that can settle without a timer settle. */
const drain = () => new Promise((resolve) => setImmediate(resolve));

/** A wait the test ends by hand, for `settle`. */
function makeGate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { settle: vi.fn(() => opened), open: () => open() };
}

/**
 * A repository's readiness, which a test moves to `merging` and back as a
 * reload would, telling its listeners each time.
 */
function makeReadiness() {
  const listeners = new Set<(state: Readiness) => void>();
  const source = {
    readiness: 'ready' as Readiness,
    onReadinessChange(listener: (state: Readiness) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(state: Readiness) {
      source.readiness = state;
      for (const listener of [...listeners]) listener(state);
    },
  };
  return source;
}

interface Harness {
  repo: TestRepository;
  vault: ReturnType<typeof makeVault>;
  scheduler: ReturnType<typeof makeScheduler>;
  watch: ReturnType<typeof createIrIdWatch>;
  pause: Mock<() => Promise<void>>;
  onDamage: Mock<(paths: readonly string[]) => void>;
}

function wire(
  rows: readonly StoredRow[],
  notes: readonly FakeNote[],
  overrides: Partial<IrIdWatchDeps> = {}
): Harness {
  const repo = TestRepository.create();
  for (const row of rows) insertItem(repo, row);

  const vault = makeVault(notes);
  const scheduler = makeScheduler();
  const pause = vi.fn(async () => {});
  const onDamage = vi.fn<(paths: readonly string[]) => void>();

  const watch = createIrIdWatch({
    repo,
    vault: vault.vault,
    metadataCache: vault.metadataCache,
    onDamage,
    // Every change is an edit made to a note on screen unless a test says
    // otherwise
    isShown: () => true,
    // Nothing arrives while a pass waits on Sync unless a test says so
    settle: async () => {},
    yieldToHost: pause,
    schedule: scheduler.schedule,
    ...overrides,
  });

  return { repo, vault, scheduler, watch, pause, onDamage };
}

const holder = (table: ItemTable, id: string, deleted = false): Holder => ({
  table,
  id,
  deleted,
});

const tableArb = fc.constantFrom(...ITEM_TABLES);
const idArb = fc.uuid();
/** Anything can end up in `reference`; nothing here relies on its shape. */
const pathArb = fc.string({ minLength: 1, maxLength: 10 });

/** Every `ir-id` value that amounts to no claim at all. */
const noClaimArb = fc.constantFrom<unknown>(undefined, null, '', 0, false, NaN);

/** Every `ir-id` value that amounts to a claim, id-shaped or not. */
const someClaimArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.string({ minLength: 1 }),
  fc.integer({ min: 1 }),
  fc.constant(true),
  fc.constant({ nested: 1 })
);

/**
 * A row as the database holds it. Spread into a plain object: `fc.record` builds
 * null-prototype ones, which `toStrictEqual` will not match against a row read
 * back out of SQLite.
 */
const storedRowArb: fc.Arbitrary<StoredRow> = fc
  .record({
    table: tableArb,
    id: idArb,
    reference: pathArb,
    deleted: fc.boolean(),
  })
  .map((row) => ({ ...row }));

const holdersArb = fc.array(
  fc.record({ table: tableArb, id: idArb, deleted: fc.boolean() }),
  { maxLength: 5 }
);

/** A tag a note might carry: an item tag, a lookalike, or anything else. */
const tagEntryArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constantFrom<unknown>(
    ...Object.values(TAG_BY_TABLE),
    ...Object.values(TAG_BY_TABLE).map((tag) => `#${tag}`),
    'other',
    null
  ),
  fc.string({ maxLength: 8 })
);

/** Every shape a frontmatter `tags` value can take. */
const tagsArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.array(tagEntryArb, { maxLength: 4 }),
  fc
    .array(tagEntryArb, { maxLength: 3 })
    .map((tags) => tags.filter((tag) => typeof tag === 'string').join(', ')),
  fc.constantFrom<unknown>(undefined, null, 0, { nested: 'ir-article' })
);

// #endregion

beforeAll(async () => {
  SQL = await initSqlJs();
});

beforeEach(() => {
  // `bulkMutate` yields through `window.setTimeout`, which node lacks
  vi.stubGlobal('window', globalThis);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('claimsIdentity', () => {
  it('reads an absent, emptied or non-id value as no claim, matching the fetch path', () => {
    fc.assert(
      fc.property(noClaimArb, (irId) => {
        expect(claimsIdentity(irId)).toBe(false);
      })
    );
  });

  it('reads anything a note could carry as a claim, whatever its type', () => {
    fc.assert(
      fc.property(someClaimArb, (irId) => {
        expect(claimsIdentity(irId)).toBe(true);
      })
    );
  });
});

describe('readsAsTampering', () => {
  const at = (irId: unknown): NoteClaim => ({ path: 'notes/one.md', irId });

  it('counts the property being gone from a note a live row points at', () => {
    for (const gone of [undefined, null, '']) {
      expect(readsAsTampering(at(gone), [holder('article', 'a1')])).toBe(true);
    }
  });

  it('counts an id typed over the one the live row at the path holds', () => {
    expect(readsAsTampering(at('not-a1'), [holder('article', 'a1')])).toBe(
      true
    );
  });

  it('counts a note with no claim that more than one live row points at', () => {
    expect(
      readsAsTampering(at(undefined), [
        holder('article', 'a1'),
        holder('snippet', 's1'),
      ])
    ).toBe(true);
  });

  it('passes over a note whose claim is the live row it sits on', () => {
    expect(readsAsTampering(at('a1'), [holder('article', 'a1')])).toBe(false);
  });

  it('passes over a note carrying an id no row holds', () => {
    // A template or a duplicated file can carry one, and a note the plugin has
    // no row for is not a note it has any business claiming
    expect(readsAsTampering(at('a1'), [])).toBe(false);
  });

  it('never reports a note on a path no live row holds, whatever it claims', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.constant(undefined),
          fc.constant(null),
          fc.integer()
        ),
        fc.array(
          fc.tuple(fc.constantFrom(...ITEM_TABLES), fc.string({ minLength: 1 }))
        ),
        (irId, tombstones) => {
          expect(
            readsAsTampering(
              at(irId),
              tombstones.map(([table, id]) => holder(table, id, true))
            )
          ).toBe(false);
        }
      )
    );
  });
});

describe('classifyTag', () => {
  /** `tags` lacking `tag`, as a list or a lone string. */
  const tagsLackingArb = (tag: string) =>
    tagsArb.filter((tags) => !hasTag(tags, tag));

  /** `tags` carrying `tag` as an entry, as a list or a lone string. */
  const tagsCarryingArb = (tag: string) =>
    fc.oneof(
      fc
        .tuple(fc.array(tagEntryArb, { maxLength: 3 }), fc.nat())
        .map(([others, at]) => {
          const tags = [...others];
          tags.splice(at % (others.length + 1), 0, tag);
          return tags as unknown;
        }),
      fc.constantFrom(`${tag}`, `other, ${tag}`, `${tag} other`)
    );

  /**
   * A note that belongs to one live row at its path: it names the row's id, with
   * any other rows about, live or not, so long as none of them answers to that
   * id; or it makes no claim, and every other row at the path is a tombstone.
   */
  const ownedArb = fc
    .record({
      path: pathArb,
      owner: fc.record({ table: tableArb, id: idArb }),
      claims: fc.boolean(),
      noClaim: noClaimArb,
      others: holdersArb,
      at: fc.nat(),
    })
    .map(({ path, owner, claims, noClaim, others, at }) => {
      const rest = others
        .filter(({ id }) => id !== owner.id)
        .map((row) => (claims ? row : { ...row, deleted: true }));
      const holders = [...rest];
      holders.splice(at % (rest.length + 1), 0, holder(owner.table, owner.id));
      return { path, owner, irId: claims ? owner.id : noClaim, holders };
    });

  /**
   * A note that belongs to no live row at its path, or could belong to more
   * than one: it makes no claim and the path has no live row or several; it
   * names an id no live row there holds; or two live rows there share its id.
   */
  const unownedArb = fc.oneof(
    fc
      .record({
        path: pathArb,
        irId: noClaimArb,
        holders: holdersArb,
      })
      .filter(
        ({ holders }) => holders.filter(({ deleted }) => !deleted).length !== 1
      ),
    fc
      .record({
        path: pathArb,
        irId: someClaimArb,
        holders: holdersArb,
      })
      .map(({ path, irId, holders }) => ({
        path,
        irId,
        holders: holders.map((row) =>
          row.id === irId ? { ...row, deleted: true } : row
        ),
      })),
    fc
      .record({
        path: pathArb,
        id: idArb,
        tables: fc.uniqueArray(tableArb, { minLength: 2, maxLength: 3 }),
        others: holdersArb,
      })
      .map(({ path, id, tables, others }) => ({
        path,
        irId: id,
        holders: [...others, ...tables.map((table) => holder(table, id))],
      }))
  );

  it('names the tag of the live row a note belongs to, when the note lacks it', () => {
    fc.assert(
      fc.property(
        ownedArb.chain((owned) =>
          tagsLackingArb(TAG_BY_TABLE[owned.owner.table]).map((tags) => ({
            ...owned,
            tags,
          }))
        ),
        ({ path, owner, irId, holders, tags }) => {
          expect(classifyTag({ path, irId }, tags, holders)).toStrictEqual({
            row: { table: owner.table, id: owner.id },
            path,
            tag: TAG_BY_TABLE[owner.table],
          });
        }
      )
    );
  });

  it("leaves alone a note that already carries its row's tag", () => {
    fc.assert(
      fc.property(
        ownedArb.chain((owned) =>
          tagsCarryingArb(TAG_BY_TABLE[owned.owner.table]).map((tags) => ({
            ...owned,
            tags,
          }))
        ),
        ({ path, irId, holders, tags }) => {
          expect(classifyTag({ path, irId }, tags, holders)).toBeNull();
        }
      )
    );
  });

  it('finds no tag lost from a note no single live row at its path answers to, whatever its tags', () => {
    fc.assert(
      fc.property(unownedArb, tagsArb, ({ path, irId, holders }, tags) => {
        expect(classifyTag({ path, irId }, tags, holders)).toBeNull();
      })
    );
  });

  it('names the tag of the one live row at a path when the note makes no claim', () => {
    fc.assert(
      fc.property(
        pathArb,
        noClaimArb,
        tableArb,
        idArb,
        fc.array(fc.record({ table: tableArb, id: idArb }), { maxLength: 3 }),
        (path, irId, table, id, tombstones) => {
          const holders = [
            ...tombstones.map((row) => holder(row.table, row.id, true)),
            holder(table, id),
          ];
          expect(classifyTag({ path, irId }, ['other'], holders)).toStrictEqual(
            {
              row: { table, id },
              path,
              tag: TAG_BY_TABLE[table],
            }
          );
        }
      )
    );
  });

  it('leaves a note alone that claims an id no live row at its path holds', () => {
    expect(
      classifyTag(
        { path: 'a.md', irId: 'typed-over' },
        [],
        [holder('article', 'a1')]
      )
    ).toBeNull();
    expect(
      classifyTag(
        { path: 'a.md', irId: 'a1' },
        [],
        [holder('article', 'a1', true)]
      )
    ).toBeNull();
    expect(classifyTag({ path: 'a.md', irId: undefined }, [], [])).toBeNull();
  });

  it('leaves a note alone that more than one live row could own', () => {
    const holders = [holder('article', 'a1'), holder('snippet', 's1')];
    expect(
      classifyTag({ path: 'a.md', irId: undefined }, [], holders)
    ).toBeNull();
    expect(
      classifyTag(
        { path: 'a.md', irId: 'a1' },
        [],
        [holder('article', 'a1'), holder('snippet', 'a1')]
      )
    ).toBeNull();
  });

  it('reads a lone string of tags as a list of them', () => {
    const holders = [holder('snippet', 's1')];
    expect(
      classifyTag(
        { path: 'a.md', irId: 's1' },
        'other ir-text-snippet',
        holders
      )
    ).toBeNull();
    expect(
      classifyTag({ path: 'a.md', irId: 's1' }, 'ir-text-snippet-x', holders)
    ).toStrictEqual({
      row: { table: 'snippet', id: 's1' },
      path: 'a.md',
      tag: SNIPPET_TAG,
    });
  });

  it('finds nothing lost once the tag it names is back', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          ownedArb.chain((owned) =>
            tagsArb.map((tags) => ({ ...owned, tags }))
          ),
          unownedArb.chain((unowned) =>
            tagsArb.map((tags) => ({ ...unowned, tags }))
          )
        ),
        ({ path, irId, holders, tags }) => {
          const first = classifyTag({ path, irId }, tags, holders);
          fc.pre(first !== null);
          expect(
            classifyTag({ path, irId }, withTag(tags, first.tag), holders)
          ).toBeNull();
        }
      )
    );
  });
});

describe('writtenHere', () => {
  const mtimeArb = fc.integer({ min: 0, max: 2 ** 45 });
  const windowArb = fc.nat({ max: 10_000_000 });

  it('takes a change for a write made here exactly when its mtime is within the window of the clock, either side', () => {
    fc.assert(
      fc.property(
        mtimeArb,
        windowArb,
        fc.integer({ min: -20_000_000, max: 20_000_000 }),
        (mtime, windowMs, offset) => {
          expect(writtenHere(mtime, mtime + offset, windowMs)).toBe(
            Math.abs(offset) <= windowMs
          );
        }
      )
    );
  });

  it('counts the edges of the window in, and the next millisecond out', () => {
    fc.assert(
      fc.property(
        mtimeArb,
        windowArb,
        fc.constantFrom(-1, 1),
        (mtime, windowMs, side) => {
          expect(writtenHere(mtime, mtime + side * windowMs, windowMs)).toBe(
            true
          );
          expect(
            writtenHere(mtime, mtime + side * (windowMs + 1), windowMs)
          ).toBe(false);
        }
      )
    );
  });

  it(`defaults to a window of ${LOCAL_WRITE_WINDOW_MS}ms`, () => {
    fc.assert(
      fc.property(mtimeArb, fc.constantFrom(-1, 1), (mtime, side) => {
        const edge = side * LOCAL_WRITE_WINDOW_MS;
        expect(writtenHere(mtime, mtime + edge)).toBe(true);
        expect(writtenHere(mtime, mtime + edge + side)).toBe(false);
      })
    );
  });

  it('takes a change with no mtime to read for a write made here', () => {
    fc.assert(
      fc.property(fc.integer(), windowArb, (now, windowMs) => {
        expect(writtenHere(undefined, now, windowMs)).toBe(true);
      })
    );
  });
});

describe('settleAfterSync', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits its wait out, then any merge under way by then, for at most as long again', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Not 0: the fake clock runs a 0ms timer set inside another one a
        // millisecond late (`duringTick` in @sinonjs/fake-timers)
        fc.option(fc.integer({ min: 1, max: 5000 }), { nil: undefined }),
        // When a merge starts and ends, from the call
        fc
          .tuple(fc.nat({ max: 15_000 }), fc.nat({ max: 15_000 }))
          .map(([x, y]) => ({ start: Math.min(x, y), end: Math.max(x, y) })),
        async (waitMs, merge) => {
          vi.useFakeTimers();
          const wait = waitMs ?? MERGE_WAIT_MS;
          const repo = makeReadiness();
          // Set before the wait's own timer, so these win a tie with it
          setTimeout(() => repo.set('merging'), merge.start);
          setTimeout(() => repo.set('ready'), merge.end);
          const started = Date.now();
          let settledAfter: number | null = null;
          void settleAfterSync(repo, waitMs).then(() => {
            settledAfter = Date.now() - started;
          });

          await vi.advanceTimersByTimeAsync(4 * wait + 20_000);

          const mergingAtWait = merge.start <= wait && wait < merge.end;
          expect(settledAfter).toBe(
            mergingAtWait ? Math.min(merge.end, 2 * wait) : wait
          );
        }
      ).afterEach(() => vi.useRealTimers())
    );
  });
});

describe('shownInMarkdownView', () => {
  /** A leaf holding a markdown view of the note at `path`, or of none. */
  const markdownLeaf = (path: string | null) => ({
    view: Object.assign(Object.create(MarkdownView.prototype) as object, {
      file: path === null ? null : { path },
    }),
  });

  /**
   * A tab restored at startup and not shown since: Obsidian gives it a
   * placeholder view, not a `MarkdownView`, though its state names the note.
   */
  const deferredLeaf = (path: string) => ({
    isDeferred: true,
    view: { file: { path }, getState: () => ({ file: path }) },
  });

  const workspaceOf = (leaves: readonly object[]) => {
    const getLeavesOfType = vi.fn(() => leaves);
    return {
      workspace: { getLeavesOfType } as unknown as Pick<
        Workspace,
        'getLeavesOfType'
      >,
      getLeavesOfType,
    };
  };

  it('answers whether any markdown view shows the note, in whatever window', () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.option(pathArb, { nil: null }), { maxLength: 6 })
          .chain((shown) => {
            const open = shown.filter((path) => path !== null);
            // The note asked about is one of those shown about as often as not
            const path =
              open.length > 0
                ? fc.oneof(fc.constantFrom(...open), pathArb)
                : pathArb;
            return fc.tuple(fc.constant(shown), path);
          }),
        ([shown, path]) => {
          // Leaves in popout windows come back from the same call
          const { workspace, getLeavesOfType } = workspaceOf(
            shown.map(markdownLeaf)
          );

          expect(shownInMarkdownView(workspace, path)).toBe(
            shown.includes(path)
          );
          expect(getLeavesOfType).toHaveBeenCalledWith('markdown');
        }
      )
    );
  });

  it('does not count a tab whose view has not loaded yet', () => {
    const { workspace } = workspaceOf([deferredLeaf('notes/one.md')]);

    expect(shownInMarkdownView(workspace, 'notes/one.md')).toBe(false);
  });
});

describe('createIrIdWatch', () => {
  const ROW: StoredRow = {
    table: 'article',
    id: 'a1',
    reference: 'notes/one.md',
    deleted: false,
  };

  describe('a note stripped of its id and tag by a write past the editor', () => {
    /**
     * A watch over `ROW` and its note, reporting to the real notice, with the
     * note open in a tab here or not.
     */
    function wireNotice(shown: boolean) {
      const writes = vi
        .spyOn(Obsidian, 'updateFrontMatter')
        .mockResolvedValue(undefined);
      const createNotice = vi.fn((message: string) => ({
        containerEl: {
          isConnected: true,
          addEventListener: () => {},
        } as unknown as HTMLElement,
        setMessage: vi.fn(),
        hide: vi.fn(),
        message,
      }));
      const notice = createDamagedNotesNotice(createNotice);
      const harness = wire(
        [ROW],
        [{ path: ROW.reference, irId: 'a1', tags: [ARTICLE_TAG, 'keep'] }],
        {
          onDamage: (paths) => notice.report(paths),
          isShown: (path) => shown && path === ROW.reference,
        }
      );
      return { ...harness, writes, createNotice };
    }

    it('raises one notice naming a note open here, and writes nothing back to it or its row', async () => {
      // Reading mode's properties editor, say: an edit made inside Obsidian
      // that the editor guard could not stop
      const { watch, repo, vault, scheduler, writes, createNotice } =
        wireNotice(true);
      const rowsBefore = readRows(repo);

      vault.notes.set(ROW.reference, { tags: ['keep'] });
      watch.handleChange(changed(ROW.reference));
      // Touched again before the pass runs is still the one notice
      watch.handleChange(changed(ROW.reference));
      scheduler.run();
      await vi.waitFor(() => expect(createNotice).toHaveBeenCalled());
      await watch.flush();

      expect(createNotice).toHaveBeenCalledOnce();
      expect(createNotice.mock.calls[0][0]).toContain('"one"');
      expect(writes).not.toHaveBeenCalled();
      expect(vault.notes.get(ROW.reference)).toStrictEqual({ tags: ['keep'] });
      expect(readRows(repo)).toStrictEqual(rowsBefore);
    });

    it('raises no notice and writes nothing for a note not open here, nor once the database arrives', async () => {
      // The 0166 flow: un-imported on another device, the note arrives over
      // Sync before the database without its row does
      const { watch, repo, vault, scheduler, writes, createNotice } =
        wireNotice(false);
      const rowsBefore = readRows(repo);

      vault.notes.set(ROW.reference, { tags: ['keep'] });
      watch.handleChange(changed(ROW.reference));
      watch.handleChange(changed(ROW.reference));
      scheduler.run();
      await watch.flush();

      expect(createNotice).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
      expect(vault.notes.get(ROW.reference)).toStrictEqual({ tags: ['keep'] });
      expect(readRows(repo)).toStrictEqual(rowsBefore);

      // The database follows, with the row deleted for good
      repo.mutate(
        `UPDATE article SET deleted = TRUE, reference = $1 WHERE id = 'a1'`,
        [purgedReference('a1')]
      );
      watch.handleChange(changed(ROW.reference));
      await watch.flush();

      expect(createNotice).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
    });
  });

  describe('whether the note was on screen', () => {
    const NOTE: FakeNote = {
      path: ROW.reference,
      irId: 'a1',
      tags: [ARTICLE_TAG],
    };

    it('asks as each change comes in, so a tab closed before the pass still counts', async () => {
      let open = true;
      const isShown = vi.fn(() => open);
      const { watch, vault, onDamage } = wire([ROW], [NOTE], { isShown });

      vault.notes.set(ROW.reference, { tags: [] });
      watch.handleChange(changed(ROW.reference));
      expect(isShown).toHaveBeenCalledWith(ROW.reference);
      open = false;

      expect(await watch.flush()).toStrictEqual([ROW.reference]);
      expect(onDamage).toHaveBeenCalledWith([ROW.reference]);
    });

    it.each([
      { order: 'shown first', shown: [true, false] },
      { order: 'shown last', shown: [false, true] },
    ])(
      'reports a note shown at any one change of a burst ($order)',
      async ({ shown }) => {
        const answers = [...shown];
        const { watch, vault } = wire([ROW], [NOTE], {
          isShown: () => answers.shift() ?? false,
        });

        vault.notes.set(ROW.reference, { tags: [] });
        watch.handleChange(changed(ROW.reference));
        watch.handleChange(changed(ROW.reference));

        expect(await watch.flush()).toStrictEqual([ROW.reference]);
      }
    );

    it('tells of a loss first seen closed once the note changes again on screen', async () => {
      let open = false;
      const { watch, vault, onDamage } = wire([ROW], [NOTE], {
        isShown: () => open,
      });

      vault.notes.set(ROW.reference, { tags: [] });
      watch.handleChange(changed(ROW.reference));
      expect(await watch.flush()).toStrictEqual([]);

      open = true;
      watch.handleChange(changed(ROW.reference));
      expect(await watch.flush()).toStrictEqual([ROW.reference]);
      expect(onDamage).toHaveBeenCalledOnce();
    });

    it('does not tell again of a loss already told of when it changes while closed', async () => {
      let open = true;
      const { watch, vault, onDamage } = wire([ROW], [NOTE], {
        isShown: () => open,
      });

      vault.notes.set(ROW.reference, { tags: [] });
      watch.handleChange(changed(ROW.reference));
      await watch.flush();
      open = false;
      watch.handleChange(changed(ROW.reference));
      await watch.flush();
      open = true;
      watch.handleChange(changed(ROW.reference));
      await watch.flush();

      expect(onDamage).toHaveBeenCalledOnce();
    });

    it('forgets a loss once the note is found whole while closed, telling of the next', async () => {
      let open = true;
      const { watch, vault, onDamage } = wire([ROW], [NOTE], {
        isShown: () => open,
      });

      vault.notes.set(ROW.reference, { tags: [] });
      watch.handleChange(changed(ROW.reference));
      await watch.flush();
      open = false;
      vault.notes.set(ROW.reference, { 'ir-id': 'a1', tags: [ARTICLE_TAG] });
      watch.handleChange(changed(ROW.reference));
      await watch.flush();
      open = true;
      vault.notes.set(ROW.reference, { tags: [] });
      watch.handleChange(changed(ROW.reference));
      await watch.flush();

      expect(onDamage).toHaveBeenCalledTimes(2);
    });
  });

  describe('whether the change was a write made here', () => {
    const NOW = 1_800_000_000_000;

    it('reports a damaged note only for a change made here while a tab showed it, at any one change of a burst', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              shown: fc.boolean(),
              // How long before now the change left the note's mtime, or no
              // mtime to read
              age: fc.option(
                fc.integer({
                  min: -3 * LOCAL_WRITE_WINDOW_MS,
                  max: 3 * LOCAL_WRITE_WINDOW_MS,
                }),
                { nil: null }
              ),
            }),
            { minLength: 1, maxLength: 4 }
          ),
          async (changes) => {
            const answers = changes.map(({ shown }) => shown);
            const { watch } = wire(
              [ROW],
              [{ path: ROW.reference, tags: [ARTICLE_TAG] }],
              { isShown: () => answers.shift() ?? false, now: () => NOW }
            );

            for (const { age } of changes) {
              watch.handleChange(
                age === null
                  ? changed(ROW.reference)
                  : changedAt(ROW.reference, NOW - age)
              );
            }

            const local = changes.some(
              ({ shown, age }) =>
                shown &&
                (age === null || Math.abs(age) <= LOCAL_WRITE_WINDOW_MS)
            );
            expect(await watch.flush()).toStrictEqual(
              local ? [ROW.reference] : []
            );
          }
        )
      );
    });
  });

  describe('waiting on Sync before telling', () => {
    /** What can become of a damaged note while a pass waits on Sync. */
    const FATES = [
      'unchanged',
      // Its database arrives, the row deleted for good by an un-import
      'purged',
      // Undone here, as the notice asks
      'restored',
      // Its tag put back, but not its id
      'retagged',
      'removed',
    ] as const;
    type Fate = (typeof FATES)[number];
    /** Whether a note met with `fate` is still damaged after it. */
    const STILL_DAMAGED: Record<Fate, boolean> = {
      unchanged: true,
      purged: false,
      restored: false,
      retagged: true,
      removed: false,
    };

    it('tells of only the notes still damaged once the wait is over, and of none before', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.constantFrom(...FATES), { minLength: 1, maxLength: 6 }),
          async (fates) => {
            const rows = fates.map(
              (_, i): StoredRow => ({
                ...ROW,
                id: `a${i}`,
                reference: `notes/${i}.md`,
              })
            );
            const gate = makeGate();
            const { watch, repo, vault, onDamage } = wire(
              rows,
              rows.map(({ reference }) => ({
                path: reference,
                tags: [ARTICLE_TAG],
              })),
              { settle: gate.settle }
            );
            for (const { reference } of rows) {
              watch.handleChange(changed(reference));
            }

            const pass = watch.flush();
            await drain();
            expect(gate.settle).toHaveBeenCalledOnce();
            expect(onDamage).not.toHaveBeenCalled();
            for (const [i, fate] of fates.entries()) {
              const { id, reference } = rows[i];
              if (fate === 'purged') {
                repo.mutate(
                  `UPDATE article SET deleted = TRUE, reference = $1 WHERE id = $2`,
                  [purgedReference(id), id]
                );
              } else if (fate === 'restored') {
                vault.notes.set(reference, { 'ir-id': id, tags: [ARTICLE_TAG] });
              } else if (fate === 'retagged') {
                vault.notes.set(reference, { tags: [ARTICLE_TAG, 'x'] });
              } else if (fate === 'removed') {
                vault.remove(reference);
              }
            }
            gate.open();

            const expected = rows
              .filter((_, i) => STILL_DAMAGED[fates[i]])
              .map(({ reference }) => reference);
            expect(await pass).toStrictEqual(expected);
            expect(onDamage.mock.calls).toStrictEqual(
              expected.length > 0 ? [[expected]] : []
            );
          }
        )
      );
    });

    it('tells of a note found whole after the wait once it loses its id again, and of one told of only once', async () => {
      const { watch, vault, onDamage } = wire(
        [ROW, { ...ROW, id: 'a2', reference: 'notes/two.md' }],
        [
          { path: ROW.reference, tags: [ARTICLE_TAG] },
          { path: 'notes/two.md', tags: [ARTICLE_TAG] },
        ],
        {
          settle: async () => {
            // Put back while the first pass waits, as an undo would
            if (onDamage.mock.calls.length === 0) {
              vault.notes.set(ROW.reference, {
                'ir-id': ROW.id,
                tags: [ARTICLE_TAG],
              });
            }
          },
        }
      );
      watch.handleChange(changed(ROW.reference));
      watch.handleChange(changed('notes/two.md'));
      expect(await watch.flush()).toStrictEqual(['notes/two.md']);

      vault.notes.set(ROW.reference, { tags: [ARTICLE_TAG] });
      watch.handleChange(changed(ROW.reference));
      watch.handleChange(changed('notes/two.md'));

      expect(await watch.flush()).toStrictEqual([ROW.reference]);
      expect(onDamage.mock.calls).toStrictEqual([
        [['notes/two.md']],
        [[ROW.reference]],
      ]);
    });

    it('waits on nothing when a pass finds nothing to tell of', async () => {
      // Whole, closed, written elsewhere, and already told of
      const notes: FakeNote[] = [
        { path: 'notes/whole.md', irId: 'w', tags: [ARTICLE_TAG] },
        { path: 'notes/closed.md', tags: [ARTICLE_TAG] },
        { path: 'notes/synced.md', tags: [ARTICLE_TAG] },
        { path: 'notes/told.md', tags: [ARTICLE_TAG] },
      ];
      // Any wait after the first never ends
      const settle = vi
        .fn(() => new Promise<void>(() => {}))
        .mockImplementationOnce(async () => {});
      const { watch, onDamage } = wire(
        notes.map(({ path }, i) => ({
          ...ROW,
          id: i === 0 ? 'w' : `n${i}`,
          reference: path,
        })),
        notes,
        {
          isShown: (path) => path !== 'notes/closed.md',
          now: () => 0,
          settle,
        }
      );
      watch.handleChange(changed('notes/told.md'));
      expect(await watch.flush()).toStrictEqual(['notes/told.md']);

      watch.handleChange(changed('notes/whole.md'));
      watch.handleChange(changed('notes/closed.md'));
      watch.handleChange(
        changedAt('notes/synced.md', LOCAL_WRITE_WINDOW_MS + 1)
      );
      watch.handleChange(changed('notes/told.md'));

      expect(await watch.flush()).toStrictEqual([]);
      expect(settle).toHaveBeenCalledOnce();
      expect(onDamage).toHaveBeenCalledOnce();
    });

    it('neither reads the database nor tells anything once disposed during the wait', async () => {
      const gate = makeGate();
      const { watch, repo, onDamage } = wire(
        [ROW],
        [{ path: ROW.reference, tags: [ARTICLE_TAG] }],
        { settle: gate.settle }
      );
      watch.handleChange(changed(ROW.reference));

      const pass = watch.flush();
      await drain();
      watch.dispose();
      // The repository may be closed by now, as it is on unload
      const query = vi.spyOn(repo, 'query');
      gate.open();

      expect(await pass).toStrictEqual([]);
      expect(query).not.toHaveBeenCalled();
      expect(onDamage).not.toHaveBeenCalled();
    });

    it('tells nothing once disposed while the look after the wait reads the database', async () => {
      const harness: { current?: Harness } = {};
      const settle = async () => {
        const { repo, watch } = harness.current!;
        const query = vi.spyOn(repo, 'query');
        query.mockImplementationOnce((...args) => {
          watch.dispose();
          query.mockRestore();
          return repo.query(...args);
        });
      };
      harness.current = wire(
        [ROW],
        [{ path: ROW.reference, tags: [ARTICLE_TAG] }],
        { settle }
      );
      const { watch, onDamage } = harness.current;
      watch.handleChange(changed(ROW.reference));

      expect(await watch.flush()).toStrictEqual([]);
      expect(onDamage).not.toHaveBeenCalled();
    });
  });

  it('reports exactly the notes on screen that lost their id or tag, and never writes a row', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(storedRowArb, {
          maxLength: 6,
          selector: ({ table, reference }) => `${table}\0${reference}`,
        }),
        fc.array(
          fc.record({
            path: pathArb,
            irId: fc.oneof(noClaimArb, someClaimArb, idArb),
            tags: tagsArb,
          }),
          { maxLength: 6 }
        ),
        fc.array(pathArb, { maxLength: 6 }),
        async (rows, generated, extraShown) => {
          // Notes sit where rows point as well as anywhere else
          const notes = [
            ...rows.map(({ reference, id }, i) => ({
              ...generated[i % Math.max(generated.length, 1)],
              path: reference,
              irId: generated[i]?.irId ?? id,
            })),
            ...generated,
          ].filter(
            (note, i, all) =>
              note !== undefined &&
              all.findIndex((other) => other?.path === note.path) === i
          ) as FakeNote[];
          // Every other note open in a tab, along with paths no note is at
          const shown = new Set([
            ...notes.filter((_, i) => i % 2 === 0).map(({ path }) => path),
            ...extraShown,
          ]);
          const { watch, repo, onDamage } = wire(rows, notes, {
            isShown: (path) => shown.has(path),
          });
          const rowsBefore = readRows(repo);

          for (const note of notes) watch.handleChange(changed(note.path));
          const reported = await watch.flush();

          const expected = notes
            .filter(({ path, irId, tags }) => {
              const holders = rows
                .filter(({ reference }) => reference === path)
                .map(({ table, id, deleted }) => holder(table, id, deleted));
              return (
                shown.has(path) &&
                (readsAsTampering({ path, irId }, holders) ||
                  classifyTag({ path, irId }, tags, holders) !== null)
              );
            })
            .map(({ path }) => path);
          expect([...reported].sort()).toStrictEqual([...expected].sort());
          expect(onDamage.mock.calls).toStrictEqual(
            expected.length > 0 ? [[reported]] : []
          );
          expect(readRows(repo)).toStrictEqual(rowsBefore);
        }
      ),
      { numRuns: 60 }
    );
  });

  it("passes over a note that still carries its row's id and tag", async () => {
    const { watch, onDamage } = wire(
      [ROW],
      [{ path: ROW.reference, irId: 'a1', tags: ['keep', ARTICLE_TAG] }]
    );

    watch.handleChange(changed(ROW.reference));

    expect(await watch.flush()).toStrictEqual([]);
    expect(onDamage).not.toHaveBeenCalled();
  });

  it('reports a note that kept its id but lost its type tag', async () => {
    const { watch } = wire(
      [ROW],
      [{ path: ROW.reference, irId: 'a1', tags: [] }]
    );

    watch.handleChange(changed(ROW.reference));

    expect(await watch.flush()).toStrictEqual([ROW.reference]);
  });

  it('reports a note still damaged on later passes only once', async () => {
    const { watch, vault, onDamage } = wire(
      [ROW],
      [{ path: ROW.reference, tags: [ARTICLE_TAG] }]
    );

    watch.handleChange(changed(ROW.reference));
    expect(await watch.flush()).toStrictEqual([ROW.reference]);
    // Each later edit of the note re-raises `changed` with the id still gone
    vault.notes.set(ROW.reference, { tags: [ARTICLE_TAG, 'edited'] });
    watch.handleChange(changed(ROW.reference));
    expect(await watch.flush()).toStrictEqual([]);

    expect(onDamage).toHaveBeenCalledOnce();
  });

  it('reports a note again once it has been found whole and then loses its id again', async () => {
    const { watch, vault, onDamage } = wire(
      [ROW],
      [{ path: ROW.reference, tags: [ARTICLE_TAG] }]
    );

    watch.handleChange(changed(ROW.reference));
    await watch.flush();
    vault.notes.set(ROW.reference, { 'ir-id': ROW.id, tags: [ARTICLE_TAG] });
    watch.handleChange(changed(ROW.reference));
    expect(await watch.flush()).toStrictEqual([]);
    vault.notes.set(ROW.reference, { tags: [ARTICLE_TAG] });
    watch.handleChange(changed(ROW.reference));

    expect(await watch.flush()).toStrictEqual([ROW.reference]);
    expect(onDamage).toHaveBeenCalledTimes(2);
  });

  it('does not report a damaged note again for one pass having caught it mid-parse', async () => {
    const { watch, vault, onDamage } = wire(
      [ROW],
      [{ path: ROW.reference, tags: [ARTICLE_TAG] }]
    );

    watch.handleChange(changed(ROW.reference));
    await watch.flush();
    vault.metadataCache.getFileCache.mockImplementationOnce(() => null);
    watch.handleChange(changed(ROW.reference));
    await watch.flush();
    watch.handleChange(changed(ROW.reference));

    expect(await watch.flush()).toStrictEqual([]);
    expect(onDamage).toHaveBeenCalledOnce();
  });

  it('passes over a note the cache is still re-reading, and a note gone since', async () => {
    const { watch, vault, onDamage, repo } = wire(
      [ROW, { ...ROW, id: 'a2', reference: 'notes/two.md' }],
      [{ path: ROW.reference }, { path: 'notes/two.md' }]
    );
    vault.metadataCache.getFileCache.mockImplementation(() => null);
    vault.remove('notes/two.md');
    const query = vi.spyOn(repo, 'query');

    watch.handleChange(changed(ROW.reference));
    watch.handleChange(changed('notes/two.md'));

    expect(await watch.flush()).toStrictEqual([]);
    expect(onDamage).not.toHaveBeenCalled();
    // Nothing left to judge, so nothing is asked of the database
    expect(query).not.toHaveBeenCalled();
  });

  it('ignores a file that has no frontmatter, never so much as scheduling a pass', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('pdf', 'png', 'canvas', 'mp3'),
        (extension) => {
          const { watch, scheduler } = wire([ROW], []);
          watch.handleChange(changed(ROW.reference, extension));
          expect(scheduler.schedule).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('answers a burst of changes with one pass, scheduled from the first of them', async () => {
    const { watch, scheduler, onDamage } = wire(
      [ROW, { ...ROW, id: 'a2', reference: 'notes/two.md' }],
      [{ path: ROW.reference }, { path: 'notes/two.md' }]
    );

    watch.handleChange(changed(ROW.reference));
    watch.handleChange(changed('notes/two.md'));
    watch.handleChange(changed(ROW.reference));

    expect(scheduler.schedule).toHaveBeenCalledOnce();
    expect(scheduler.schedule.mock.calls[0][1]).toBe(DEBOUNCE_MS);
    scheduler.run();
    await vi.waitFor(() => expect(onDamage).toHaveBeenCalled());
    expect(onDamage.mock.calls).toStrictEqual([
      [[ROW.reference, 'notes/two.md']],
    ]);

    // The window closed with the pass: the next change opens another
    watch.handleChange(changed(ROW.reference));
    expect(scheduler.schedule).toHaveBeenCalledTimes(2);
  });

  it('takes the debounce window it is given', () => {
    const { watch, scheduler } = wire([ROW], [], { debounceMs: 7 });
    watch.handleChange(changed(ROW.reference));
    expect(scheduler.schedule.mock.calls[0][1]).toBe(7);
  });

  it('works through a large burst in slices, handing the thread back between them', async () => {
    for (const count of [4, 5]) {
      const paths = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'].slice(0, count);
      const { watch, pause, repo } = wire(
        paths.map((path, i) => ({ ...ROW, id: `id${i}`, reference: path })),
        paths.map((path) => ({ path })),
        { pathBatch: 2 }
      );
      const query = vi.spyOn(repo, 'query');
      // How many reads each pause came after
      const pausedAfter: number[] = [];
      pause.mockImplementation(async () => {
        pausedAfter.push(query.mock.calls.length);
      });

      for (const path of paths) watch.handleChange(changed(path));
      expect(await watch.flush()).toStrictEqual(paths);

      // One read per item table per slice, and one more for every note found
      // damaged, read again together after the wait; a pause in each gap
      // between slices, and none after the last
      const slices = Math.ceil(count / 2);
      expect(query).toHaveBeenCalledTimes((slices + 1) * ITEM_TABLES.length);
      expect(pausedAfter).toStrictEqual(
        Array.from(
          { length: slices - 1 },
          (_, i) => (i + 1) * ITEM_TABLES.length
        )
      );
    }
  });

  it('runs a pass asked for mid-pass only once the running one is done', async () => {
    const { watch, vault, onDamage } = wire(
      [ROW, { ...ROW, id: 'a2', reference: 'notes/two.md' }],
      [{ path: ROW.reference }, { path: 'notes/two.md' }]
    );
    const read = vault.metadataCache.getFileCache.getMockImplementation();
    const later: { pass?: Promise<string[]> } = {};
    vault.metadataCache.getFileCache.mockImplementation((file) => {
      // Another change, and another pass, while the first reads its notes
      if (!later.pass) {
        watch.handleChange(changed('notes/two.md'));
        later.pass = watch.flush();
      }
      return read?.(file) ?? null;
    });

    watch.handleChange(changed(ROW.reference));
    expect(await watch.flush()).toStrictEqual([ROW.reference]);
    expect(await later.pass).toStrictEqual(['notes/two.md']);
    expect(onDamage.mock.calls).toStrictEqual([
      [[ROW.reference]],
      [['notes/two.md']],
    ]);
  });

  it('keeps taking passes after one fails, and hands the failure to its caller', async () => {
    const { watch, repo, onDamage } = wire([ROW], [{ path: ROW.reference }]);
    const failure = new Error('db gone');
    vi.spyOn(repo, 'query').mockRejectedValueOnce(failure);

    watch.handleChange(changed(ROW.reference));
    await expect(watch.flush()).rejects.toBe(failure);
    watch.handleChange(changed(ROW.reference));

    expect(await watch.flush()).toStrictEqual([ROW.reference]);
    expect(onDamage).toHaveBeenCalledOnce();
  });

  it('logs a failed scheduled pass rather than leaving it unhandled', async () => {
    const { watch, repo, scheduler } = wire([ROW], [{ path: ROW.reference }]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(repo, 'query').mockRejectedValue(new Error('db gone'));

    watch.handleChange(changed(ROW.reference));
    scheduler.run();

    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
  });

  describe('dispose', () => {
    it('cancels the pass it had scheduled, and takes no more changes', () => {
      const { watch, scheduler } = wire([ROW], [{ path: ROW.reference }]);
      watch.handleChange(changed(ROW.reference));

      watch.dispose();
      watch.handleChange(changed(ROW.reference));

      expect(scheduler.pending).toBe(0);
      expect(scheduler.schedule).toHaveBeenCalledOnce();
    });

    it('forgets what it had remembered', async () => {
      const { watch, onDamage } = wire([ROW], [{ path: ROW.reference }]);
      watch.handleChange(changed(ROW.reference));

      watch.dispose();

      expect(await watch.flush()).toStrictEqual([]);
      expect(onDamage).not.toHaveBeenCalled();
    });

    it('reports nothing from a pass it ends part way through', async () => {
      const { watch, onDamage, pause } = wire(
        [ROW, { ...ROW, id: 'a2', reference: 'notes/two.md' }],
        [{ path: ROW.reference }, { path: 'notes/two.md' }],
        { pathBatch: 1 }
      );
      pause.mockImplementation(async () => watch.dispose());

      watch.handleChange(changed(ROW.reference));
      watch.handleChange(changed('notes/two.md'));

      expect(await watch.flush()).toStrictEqual([]);
      expect(onDamage).not.toHaveBeenCalled();
    });
  });

  it('defaults to the real timer and clock, the wait on Sync, the host yield and the stock batch size', async () => {
    vi.useFakeTimers();
    try {
      const repo = TestRepository.create();
      const synced = { ...ROW, id: 'a2', reference: 'notes/synced.md' };
      insertItem(repo, ROW);
      insertItem(repo, synced);
      const vault = makeVault([
        { path: ROW.reference },
        { path: synced.reference },
      ]);
      const onDamage = vi.fn();
      const watch = createIrIdWatch({
        repo,
        vault: vault.vault,
        metadataCache: vault.metadataCache,
        onDamage,
        isShown: () => true,
      });

      watch.handleChange(changedAt(ROW.reference, Date.now()));
      watch.handleChange(
        changedAt(synced.reference, Date.now() - LOCAL_WRITE_WINDOW_MS - 1)
      );
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1 + MERGE_WAIT_MS);
      expect(onDamage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onDamage.mock.calls).toStrictEqual([[[ROW.reference]]]);

      // Cancelling goes through the same timer
      watch.handleChange(changed(ROW.reference));
      watch.dispose();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      expect(onDamage).toHaveBeenCalledOnce();
      expect(PATH_BATCH).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
