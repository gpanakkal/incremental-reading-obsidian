import { SQLJSRepository } from '#/lib/repository/SQLJSRepository';
import fc from 'fast-check';
import { readFileSync } from 'fs';
import type { App, CachedMetadata, TFile } from 'obsidian';
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
import {
  type ClaimContext,
  type ClaimedRow,
  DEBOUNCE_MS,
  type IrIdRepairDeps,
  type NoteClaim,
  PATH_BATCH,
  claimsIdentity,
  classifyClaim,
  createIrIdRepairer,
  readsAsTampering,
  rowsById,
  undeleteStatement,
} from './ir-id-repair';
import {
  type Holder,
  ITEM_TABLES,
  type ItemTable,
  PARAM_BATCH,
  evictedSpot,
} from './moved-note-scan';

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
  /** Absent means the note has no frontmatter at all. */
  irId?: unknown;
}

/**
 * The slice of vault and metadata cache the repairer reads, over notes whose
 * frontmatter its own writes update — which is what lets a pass's write be fed
 * straight back to it.
 */
function makeVault(initial: readonly FakeNote[]) {
  const notes = new Map(
    initial.map((note) => [
      note.path,
      'irId' in note
        ? ({ 'ir-id': note.irId } as Record<string, unknown>)
        : undefined,
    ])
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
    writeIrId: vi.fn(async (file: TFile, id: string) => {
      notes.set(file.path, { ...(notes.get(file.path) ?? {}), 'ir-id': id });
    }),
    /** The `ir-id` each note carries now, for comparing against a snapshot. */
    snapshot(): Map<string, unknown> {
      return new Map(
        [...notes].map(([path, frontmatter]) => [path, frontmatter?.['ir-id']])
      );
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

interface Harness {
  repo: TestRepository;
  vault: ReturnType<typeof makeVault>;
  scheduler: ReturnType<typeof makeScheduler>;
  repairer: ReturnType<typeof createIrIdRepairer>;
  pause: Mock<() => Promise<void>>;
  onRepaired: ReturnType<typeof vi.fn>;
}

function wire(
  rows: readonly StoredRow[],
  notes: readonly FakeNote[],
  overrides: Partial<IrIdRepairDeps> = {}
): Harness {
  const repo = TestRepository.create();
  for (const row of rows) insertItem(repo, row);

  const vault = makeVault(notes);
  const scheduler = makeScheduler();
  const pause = vi.fn(async () => {});
  const onRepaired = vi.fn();

  const repairer = createIrIdRepairer({
    repo,
    vault: vault.vault,
    metadataCache: vault.metadataCache,
    writeIrId: vault.writeIrId,
    onRepaired,
    yieldToHost: pause,
    schedule: scheduler.schedule,
    ...overrides,
  });

  return { repo, vault, scheduler, repairer, pause, onRepaired };
}

const holder = (table: ItemTable, id: string, deleted = false): Holder => ({
  table,
  id,
  deleted,
});

const claimedRow = (
  table: ItemTable,
  id: string,
  reference: string,
  deleted = true
): ClaimedRow => ({ table, id, reference, deleted });

const context = (over: Partial<ClaimContext> = {}): ClaimContext => ({
  holders: [],
  claimed: [],
  heldElsewhere: () => false,
  ...over,
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

describe('classifyClaim', () => {
  it('echoes the note path and names a row it was given, whatever the verdict', () => {
    fc.assert(
      fc.property(
        pathArb,
        fc.oneof(noClaimArb, someClaimArb),
        holdersArb,
        fc.array(
          fc.record({
            table: tableArb,
            id: idArb,
            reference: pathArb,
            deleted: fc.boolean(),
          }),
          { maxLength: 4 }
        ),
        fc.boolean(),
        (path, irId, holders, claimed, elsewhere) => {
          const verdict = classifyClaim(
            { path, irId },
            context({ holders, claimed, heldElsewhere: () => elsewhere })
          );
          if (verdict.kind === 'none') return;
          expect(verdict.path).toBe(path);

          const known = [...holders, ...claimed].map(
            ({ table, id }) => `${table}\0${id}`
          );
          const named =
            verdict.kind === 'skipped' ? verdict.rows : [verdict.row];
          for (const row of named) {
            expect(known).toContain(`${row.table}\0${row.id}`);
          }
        }
      )
    );
  });

  it('never restores an id over a claim, nor revives a row for a note making none', () => {
    fc.assert(
      fc.property(
        pathArb,
        fc.oneof(noClaimArb, someClaimArb),
        holdersArb,
        fc.array(
          fc.record({
            table: tableArb,
            id: idArb,
            reference: pathArb,
            deleted: fc.boolean(),
          }),
          { maxLength: 4 }
        ),
        (path, irId, holders, claimed) => {
          const verdict = classifyClaim(
            { path, irId },
            context({ holders, claimed })
          );
          if (verdict.kind === 'restore-id') {
            expect(claimsIdentity(irId)).toBe(false);
          }
          if (verdict.kind === 'undelete') {
            expect(claimsIdentity(irId)).toBe(true);
          }
        }
      )
    );
  });

  describe('a note making no claim', () => {
    it('takes the id of the one live row at its path, whatever tombstones are there too', () => {
      fc.assert(
        fc.property(
          pathArb,
          noClaimArb,
          fc.record({ table: tableArb, id: idArb }),
          fc.array(fc.record({ table: tableArb, id: idArb }), { maxLength: 3 }),
          (path, irId, live, tombstones) => {
            const holders = [
              ...tombstones.map(({ table, id }) => holder(table, id, true)),
              holder(live.table, live.id),
            ];
            expect(
              classifyClaim({ path, irId }, context({ holders }))
            ).toStrictEqual({
              kind: 'restore-id',
              row: { table: live.table, id: live.id },
              path,
            });
          }
        )
      );
    });

    it('is left alone when only tombstones hold its path', () => {
      fc.assert(
        fc.property(
          pathArb,
          noClaimArb,
          fc.array(fc.record({ table: tableArb, id: idArb }), { maxLength: 4 }),
          (path, irId, tombstones) => {
            const holders = tombstones.map(({ table, id }) =>
              holder(table, id, true)
            );
            expect(
              classifyClaim({ path, irId }, context({ holders }))
            ).toStrictEqual({ kind: 'none' });
          }
        )
      );
    });

    it('is left alone, and reported, when more than one live row holds its path', () => {
      fc.assert(
        fc.property(
          pathArb,
          noClaimArb,
          fc
            .uniqueArray(fc.record({ table: tableArb, id: idArb }), {
              minLength: 2,
              maxLength: 3,
              selector: ({ table }) => table,
            })
            .map((rows) => rows.map(({ table, id }) => holder(table, id))),
          (path, irId, holders) => {
            expect(
              classifyClaim({ path, irId }, context({ holders }))
            ).toStrictEqual({
              kind: 'skipped',
              reason: 'ambiguous',
              rows: holders.map(({ table, id }) => ({ table, id })),
              path,
            });
          }
        )
      );
    });
  });

  describe('a note claiming an id', () => {
    it('brings back the tombstone it names, pointed at itself', () => {
      fc.assert(
        fc.property(
          pathArb,
          tableArb,
          idArb,
          pathArb,
          (path, table, id, reference) => {
            expect(
              classifyClaim(
                { path, irId: id },
                context({ claimed: [claimedRow(table, id, reference)] })
              )
            ).toStrictEqual({ kind: 'undelete', row: { table, id }, path });
          }
        )
      );
    });

    it('brings back a tombstone the moved-note scan evicted off every real path', () => {
      const row = claimedRow(
        'snippet',
        'row-1',
        evictedSpot({
          table: 'snippet',
          id: 'row-1',
        })
      );
      expect(
        classifyClaim(
          { path: 'notes/a.md', irId: 'row-1' },
          context({ claimed: [row] })
        )
      ).toStrictEqual({
        kind: 'undelete',
        row: { table: 'snippet', id: 'row-1' },
        path: 'notes/a.md',
      });
    });

    it('is left alone when the row it names is already live', () => {
      fc.assert(
        fc.property(
          pathArb,
          tableArb,
          idArb,
          pathArb,
          fc.boolean(),
          (path, table, id, reference, elsewhere) => {
            expect(
              classifyClaim(
                { path, irId: id },
                context({
                  claimed: [claimedRow(table, id, reference, false)],
                  heldElsewhere: () => elsewhere,
                })
              )
            ).toStrictEqual({ kind: 'none' });
          }
        )
      );
    });

    it('is left alone when no row answers to the id, however this path is held', () => {
      fc.assert(
        fc.property(
          pathArb,
          someClaimArb,
          holdersArb,
          fc.array(
            fc.record({
              table: tableArb,
              id: idArb,
              reference: pathArb,
              deleted: fc.boolean(),
            }),
            { maxLength: 3 }
          ),
          (path, irId, holders, others) => {
            const claimed = others.filter((row) => row.id !== irId);
            expect(
              classifyClaim({ path, irId }, context({ holders, claimed }))
            ).toStrictEqual({ kind: 'none' });
          }
        )
      );
    });

    it('is taken for a copy when the row it names still has its own note elsewhere', () => {
      fc.assert(
        fc.property(
          pathArb,
          tableArb,
          idArb,
          pathArb,
          (path, table, id, reference) => {
            fc.pre(reference !== path);
            expect(
              classifyClaim(
                { path, irId: id },
                context({
                  claimed: [claimedRow(table, id, reference)],
                  heldElsewhere: () => true,
                })
              )
            ).toStrictEqual({
              kind: 'skipped',
              reason: 'copy',
              rows: [{ table, id }],
              path,
            });
          }
        )
      );
    });

    it('is not a copy of itself: a tombstone already pointed here still comes back', () => {
      fc.assert(
        fc.property(pathArb, tableArb, idArb, (path, table, id) => {
          expect(
            classifyClaim(
              { path, irId: id },
              context({
                claimed: [claimedRow(table, id, path)],
                // True of the note being judged, since the row points at it
                heldElsewhere: () => true,
              })
            )
          ).toStrictEqual({ kind: 'undelete', row: { table, id }, path });
        })
      );
    });

    it('holds the row back when another row in its table already holds this path', () => {
      fc.assert(
        fc.property(
          pathArb,
          tableArb,
          idArb,
          idArb,
          pathArb,
          fc.boolean(),
          (path, table, id, blockerId, reference, blockerDeleted) => {
            fc.pre(blockerId !== id);
            expect(
              classifyClaim(
                { path, irId: id },
                context({
                  holders: [holder(table, blockerId, blockerDeleted)],
                  claimed: [claimedRow(table, id, reference)],
                })
              )
            ).toStrictEqual({
              kind: 'skipped',
              reason: 'conflict',
              rows: [{ table, id: blockerId }],
              path,
            });
          }
        )
      );
    });

    it('is not held back by a row of another table holding this path', () => {
      fc.assert(
        fc.property(
          pathArb,
          idArb,
          idArb,
          pathArb,
          fc.boolean(),
          (path, id, blockerId, reference, blockerDeleted) => {
            expect(
              classifyClaim(
                { path, irId: id },
                context({
                  holders: [holder('snippet', blockerId, blockerDeleted)],
                  claimed: [claimedRow('article', id, reference)],
                })
              )
            ).toStrictEqual({
              kind: 'undelete',
              row: { table: 'article', id },
              path,
            });
          }
        )
      );
    });

    it('is left alone, and reported, when more than one row answers to the id', () => {
      fc.assert(
        fc.property(pathArb, idArb, pathArb, (path, id, reference) => {
          expect(
            classifyClaim(
              { path, irId: id },
              context({
                claimed: [
                  claimedRow('article', id, reference),
                  claimedRow('snippet', id, reference),
                ],
              })
            )
          ).toStrictEqual({
            kind: 'skipped',
            reason: 'ambiguous',
            rows: [
              { table: 'article', id },
              { table: 'snippet', id },
            ],
            path,
          });
        })
      );
    });
  });

  it('settles in one step: applying a verdict leaves nothing more to do', () => {
    fc.assert(
      fc.property(
        pathArb,
        fc.oneof(noClaimArb, someClaimArb),
        holdersArb,
        fc.array(
          fc.record({
            table: tableArb,
            id: idArb,
            reference: pathArb,
            deleted: fc.boolean(),
          }),
          { maxLength: 4 }
        ),
        (path, irId, holders, claimed) => {
          const first = classifyClaim(
            { path, irId },
            context({ holders, claimed })
          );
          if (first.kind !== 'restore-id' && first.kind !== 'undelete') return;

          // Apply the write, as the database and the note would record it
          const written: NoteClaim =
            first.kind === 'restore-id'
              ? { path, irId: first.row.id }
              : { path, irId };
          const after = claimed.map((row) =>
            first.kind === 'undelete' && row.id === first.row.id
              ? { ...row, reference: path, deleted: false }
              : row
          );
          const settled = classifyClaim(
            written,
            context({
              holders,
              claimed:
                first.kind === 'restore-id'
                  ? [
                      ...after,
                      {
                        ...first.row,
                        reference: path,
                        deleted: false,
                      },
                    ]
                  : after,
            })
          );
          expect(settled).toStrictEqual({ kind: 'none' });
        }
      )
    );
  });
});

describe('undeleteStatement', () => {
  it('clears the tombstone and repoints it at the note, guarded on it still being one', () => {
    fc.assert(
      fc.property(tableArb, idArb, pathArb, (table, id, path) => {
        const { query, params } = undeleteStatement({
          kind: 'undelete',
          row: { table, id },
          path,
        });
        expect(query.replace(/\s+/g, ' ').trim()).toBe(
          `UPDATE ${table} SET deleted = 0, reference = $1 ` +
            `WHERE id = $2 AND deleted = 1`
        );
        expect(params).toStrictEqual([path, id]);
      })
    );
  });
});

describe('rowsById', () => {
  it('finds each row asked for, wherever it points, and nothing else', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .uniqueArray(storedRowArb, { selector: ({ id }) => id, maxLength: 6 })
          .filter(
            (rows) =>
              new Set(
                rows.map(({ table, reference }) => `${table}\0${reference}`)
              ).size === rows.length
          ),
        fc.array(idArb, { maxLength: 3 }),
        async (rows, strangers) => {
          const repo = TestRepository.create();
          for (const row of rows) insertItem(repo, row);

          const asked = [...rows.map(({ id }) => id), ...strangers];
          const found = await rowsById(repo, asked);

          for (const row of rows) {
            expect(found.get(row.id)).toStrictEqual([row]);
          }
          for (const stranger of strangers) {
            if (rows.some(({ id }) => id === stranger)) continue;
            expect(found.has(stranger)).toBe(false);
          }
        }
      )
    );
  });

  it('splits more ids than SQLite takes parameters across reads', async () => {
    const query = vi.fn((_sql: string, _params?: unknown[]) => []);
    const ids = Array.from(
      { length: PARAM_BATCH * 2 + 1 },
      (_, n) => `id-${n}`
    );

    await rowsById({ query }, ids);

    // Three reads per item table: two full batches and the remainder
    expect(query).toHaveBeenCalledTimes(ITEM_TABLES.length * 3);
    // A read that passed no params at all would count as 0 and fail below,
    // which is the answer that belongs in a batching assertion
    const sizes = query.mock.calls.map(([, params]) => params?.length ?? 0);
    expect(sizes).toStrictEqual(
      ITEM_TABLES.flatMap(() => [PARAM_BATCH, PARAM_BATCH, 1])
    );
  });

  it('reads nothing when asked for nothing', async () => {
    const query = vi.fn(() => []);
    expect(await rowsById({ query }, [])).toStrictEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });
});

describe('createIrIdRepairer', () => {
  it('puts back the id of the live row whose note lost it', async () => {
    const { repairer, vault, repo, onRepaired } = wire(
      [
        {
          table: 'article',
          id: 'a1',
          reference: 'notes/one.md',
          deleted: false,
        },
      ],
      [{ path: 'notes/one.md' }]
    );

    repairer.handleChange(changed('notes/one.md'));
    const applied = await repairer.flush();

    expect(vault.writeIrId).toHaveBeenCalledTimes(1);
    expect(vault.snapshot().get('notes/one.md')).toBe('a1');
    expect(applied).toStrictEqual([
      {
        kind: 'restore-id',
        row: { table: 'article', id: 'a1' },
        path: 'notes/one.md',
      },
    ]);
    expect(onRepaired).toHaveBeenCalledTimes(1);
    // A frontmatter repair alone changes no row
    expect(readRows(repo)).toStrictEqual([
      { table: 'article', id: 'a1', reference: 'notes/one.md', deleted: false },
    ]);
  });

  it('leaves a note claiming some other id alone, and leaves its row deleted', async () => {
    const { repairer, vault, repo, onRepaired } = wire(
      [
        {
          table: 'article',
          id: 'a1',
          reference: 'notes/one.md',
          deleted: true,
        },
      ],
      [{ path: 'notes/one.md', irId: 'someone-else' }]
    );

    repairer.handleChange(changed('notes/one.md'));
    expect(await repairer.flush()).toStrictEqual([]);

    expect(vault.writeIrId).not.toHaveBeenCalled();
    expect(vault.snapshot().get('notes/one.md')).toBe('someone-else');
    expect(readRows(repo)[0].deleted).toBe(true);
    // Nothing was written, so there is nothing for anyone to refresh over
    expect(onRepaired).not.toHaveBeenCalled();
  });

  it('brings back a tombstone the scan evicted, pointed at the note that reverted', async () => {
    const row = { table: 'snippet' as const, id: 's1' };
    const { repairer, repo, onRepaired, pause } = wire(
      [{ ...row, reference: evictedSpot(row), deleted: true }],
      [{ path: 'notes/revived.md', irId: 's1' }]
    );

    repairer.handleChange(changed('notes/revived.md'));
    const applied = await repairer.flush();

    expect(applied).toStrictEqual([
      { kind: 'undelete', row, path: 'notes/revived.md' },
    ]);
    expect(readRows(repo)).toStrictEqual([
      {
        table: 'snippet',
        id: 's1',
        reference: 'notes/revived.md',
        deleted: false,
      },
    ]);
    expect(onRepaired).toHaveBeenCalledWith(applied);
    // The round left no conflict behind, so the pass stopped rather than paying
    // the host back for a further one
    expect(pause).not.toHaveBeenCalled();
  });

  it('leaves the row to its original when the changed note is a copy', async () => {
    const { repairer, repo, vault } = wire(
      [
        {
          table: 'article',
          id: 'a1',
          reference: 'notes/one.md',
          deleted: true,
        },
      ],
      [
        { path: 'notes/one.md', irId: 'a1' },
        { path: 'notes/copy.md', irId: 'a1' },
      ]
    );

    repairer.handleChange(changed('notes/copy.md'));
    expect(await repairer.flush()).toStrictEqual([]);

    expect(readRows(repo)).toStrictEqual([
      { table: 'article', id: 'a1', reference: 'notes/one.md', deleted: true },
    ]);
    expect(vault.writeIrId).not.toHaveBeenCalled();
  });

  it('does not buy another round for a pass that only wrote frontmatter', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { repairer, vault, pause } = wire(
      [
        // Held back by a live row that will never move off the path it wants
        {
          table: 'article',
          id: 'a1',
          reference: 'notes/gone.md',
          deleted: true,
        },
        {
          table: 'article',
          id: 'a2',
          reference: 'notes/taken.md',
          deleted: false,
        },
        // And a plain repair alongside it, which frees no path at all
        {
          table: 'snippet',
          id: 's1',
          reference: 'notes/lost-id.md',
          deleted: false,
        },
      ],
      [{ path: 'notes/taken.md', irId: 'a1' }, { path: 'notes/lost-id.md' }]
    );

    repairer.handleChange(changed('notes/taken.md'));
    repairer.handleChange(changed('notes/lost-id.md'));
    await repairer.flush();

    expect(vault.snapshot().get('notes/lost-id.md')).toBe('s1');
    // Only a row coming back frees a path, so there was nothing a further round
    // could have found; writing frontmatter alone earns none
    expect(pause).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('does not take a copy for a conflict when a later round comes round', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const evicted = { table: 'snippet' as const, id: 's1' };
    const { repairer } = wire(
      [
        {
          table: 'article',
          id: 'a1',
          reference: 'notes/one.md',
          deleted: true,
        },
        // Comes back, which is what earns the pass a second round at all
        { ...evicted, reference: evictedSpot(evicted), deleted: true },
      ],
      [
        { path: 'notes/one.md', irId: 'a1' },
        { path: 'notes/copy.md', irId: 'a1' },
        { path: 'notes/revived.md', irId: 's1' },
      ]
    );

    repairer.handleChange(changed('notes/copy.md'));
    repairer.handleChange(changed('notes/revived.md'));
    await repairer.flush();

    // Making a copy is an everyday thing to do. It is not a path that came up
    // short, so it is neither tried again nor complained about.
    expect(warn).not.toHaveBeenCalled();
  });

  it('holds a row back rather than break the unique reference it would land on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { repairer, repo } = wire(
      [
        {
          table: 'article',
          id: 'a1',
          reference: 'notes/gone.md',
          deleted: true,
        },
        {
          table: 'article',
          id: 'a2',
          reference: 'notes/here.md',
          deleted: false,
        },
      ],
      [{ path: 'notes/here.md', irId: 'a1' }]
    );

    repairer.handleChange(changed('notes/here.md'));
    expect(await repairer.flush()).toStrictEqual([]);

    expect(readRows(repo)).toStrictEqual([
      { table: 'article', id: 'a1', reference: 'notes/gone.md', deleted: true },
      {
        table: 'article',
        id: 'a2',
        reference: 'notes/here.md',
        deleted: false,
      },
    ]);
    expect(warn).toHaveBeenCalled();
  });

  it('lets a held-back row in once the tombstone blocking its path comes back too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { repairer, repo } = wire(
      [
        // Wants `notes/target.md`, which `a2` is holding against UNIQUE
        {
          table: 'article',
          id: 'a1',
          reference: 'notes/gone.md',
          deleted: true,
        },
        // And `a2`'s own note has turned up somewhere else, so it moves off
        {
          table: 'article',
          id: 'a2',
          reference: 'notes/target.md',
          deleted: true,
        },
      ],
      [
        { path: 'notes/target.md', irId: 'a1' },
        { path: 'notes/elsewhere.md', irId: 'a2' },
      ]
    );

    repairer.handleChange(changed('notes/target.md'));
    repairer.handleChange(changed('notes/elsewhere.md'));
    // One pass, not two: holders are read once per round, so `a1` is held back
    // while `a2` still holds the path, and only a further round sees it freed
    const applied = await repairer.flush();

    expect(applied).toStrictEqual([
      {
        kind: 'undelete',
        row: { table: 'article', id: 'a2' },
        path: 'notes/elsewhere.md',
      },
      {
        kind: 'undelete',
        row: { table: 'article', id: 'a1' },
        path: 'notes/target.md',
      },
    ]);
    expect(readRows(repo)).toStrictEqual([
      {
        table: 'article',
        id: 'a1',
        reference: 'notes/target.md',
        deleted: false,
      },
      {
        table: 'article',
        id: 'a2',
        reference: 'notes/elsewhere.md',
        deleted: false,
      },
    ]);
    // A conflict that settles is not worth reporting; only one still standing
    // when the pass gives up is
    expect(warn).not.toHaveBeenCalled();
  });

  it('writes nothing for a note that has gone since the change was seen', async () => {
    const onDamage = vi.fn();
    const { repairer, repo, vault } = wire(
      [
        {
          table: 'article',
          id: 'a1',
          reference: 'notes/one.md',
          deleted: false,
        },
      ],
      [{ path: 'notes/one.md' }],
      { onDamage }
    );
    const query = vi.spyOn(repo, 'query');

    repairer.handleChange(changed('notes/one.md'));
    vault.remove('notes/one.md');
    expect(await repairer.flush()).toStrictEqual([]);

    expect(vault.writeIrId).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    // No note left to judge means no edit to tell anyone about either
    expect(onDamage).not.toHaveBeenCalled();
  });

  it('writes nothing when the note was corrected between the read and the write', async () => {
    const vaultRows = [
      {
        table: 'article' as const,
        id: 'a1',
        reference: 'notes/one.md',
        deleted: false,
      },
    ];
    const { repairer, vault } = wire(vaultRows, [{ path: 'notes/one.md' }]);
    // Stands in for another writer getting there first, in the gap between the
    // read that classified the note and the re-read taken just before writing.
    // Only the first read sees the note as it was; every later one, the repairer's
    // own re-read included, finds the id already put back.
    vault.metadataCache.getFileCache.mockImplementationOnce((file: TFile) => {
      const asRead = {
        frontmatter: vault.notes.get(file.path),
      } as CachedMetadata;
      vault.notes.set('notes/one.md', { 'ir-id': 'a1' });
      return asRead;
    });

    repairer.handleChange(changed('notes/one.md'));
    expect(await repairer.flush()).toStrictEqual([]);
    expect(vault.writeIrId).not.toHaveBeenCalled();
  });

  describe('telling the user their edit was caught', () => {
    it('reports the note whose id was deleted, and puts it back anyway', async () => {
      const onDamage = vi.fn();
      const { repairer, vault } = wire(
        [
          {
            table: 'article',
            id: 'a1',
            reference: 'notes/one.md',
            deleted: false,
          },
        ],
        [{ path: 'notes/one.md' }],
        { onDamage }
      );

      repairer.handleChange(changed('notes/one.md'));
      await repairer.flush();

      expect(onDamage).toHaveBeenCalledTimes(1);
      expect(onDamage).toHaveBeenCalledWith(['notes/one.md']);
      expect(vault.snapshot().get('notes/one.md')).toBe('a1');
    });

    it('reports an id typed over, which is the damage it cannot undo', async () => {
      const onDamage = vi.fn();
      const { repairer, repo } = wire(
        [
          {
            table: 'article',
            id: 'a1',
            reference: 'notes/one.md',
            deleted: false,
          },
        ],
        [{ path: 'notes/one.md', irId: 'not-a1' }],
        { onDamage }
      );

      repairer.handleChange(changed('notes/one.md'));
      expect(await repairer.flush()).toStrictEqual([]);

      expect(onDamage).toHaveBeenCalledWith(['notes/one.md']);
      // The claim is authoritative, so the row is left as it is and the review
      // fetch path settles its fate; all this does is say so
      expect(readRows(repo)).toStrictEqual([
        {
          table: 'article',
          id: 'a1',
          reference: 'notes/one.md',
          deleted: false,
        },
      ]);
    });

    it('says nothing when a mangled id is put back', async () => {
      const onDamage = vi.fn();
      const { repairer } = wire(
        [
          {
            table: 'article',
            id: 'a1',
            reference: 'notes/one.md',
            deleted: true,
          },
        ],
        [{ path: 'notes/one.md', irId: 'a1' }],
        { onDamage }
      );

      repairer.handleChange(changed('notes/one.md'));
      await repairer.flush();

      expect(onDamage).not.toHaveBeenCalled();
    });

    it('says nothing about notes that were never items', async () => {
      const onDamage = vi.fn();
      const { repairer } = wire(
        [],
        [
          { path: 'notes/plain.md' },
          { path: 'notes/from-template.md', irId: 'a1' },
        ],
        { onDamage }
      );

      repairer.handleChange(changed('notes/plain.md'));
      repairer.handleChange(changed('notes/from-template.md'));
      await repairer.flush();

      expect(onDamage).not.toHaveBeenCalled();
    });

    it('says nothing about its own repair coming back to it', async () => {
      const onDamage = vi.fn();
      const { repairer } = wire(
        [
          {
            table: 'article',
            id: 'a1',
            reference: 'notes/one.md',
            deleted: false,
          },
        ],
        [{ path: 'notes/one.md' }],
        { onDamage }
      );

      repairer.handleChange(changed('notes/one.md'));
      await repairer.flush();
      onDamage.mockClear();

      // The repair raised `changed` again, and the id it wrote is the row's own
      repairer.handleChange(changed('notes/one.md'));
      await repairer.flush();

      expect(onDamage).not.toHaveBeenCalled();
    });

    it('reports a note once however many settling rounds re-read it', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const onDamage = vi.fn();
      const evicted = { table: 'snippet' as const, id: 's1' };
      const { repairer } = wire(
        [
          // Wants `notes/taken.md`, which a live row of its own table holds and
          // never gives up, so it is judged again every round
          {
            table: 'article',
            id: 'a1',
            reference: 'notes/gone.md',
            deleted: true,
          },
          {
            table: 'article',
            id: 'a2',
            reference: 'notes/taken.md',
            deleted: false,
          },
          // Comes back, which is what earns the pass a second round at all
          { ...evicted, reference: evictedSpot(evicted), deleted: true },
        ],
        [
          { path: 'notes/taken.md', irId: 'a1' },
          { path: 'notes/revived.md', irId: 's1' },
        ],
        { onDamage }
      );

      repairer.handleChange(changed('notes/taken.md'));
      repairer.handleChange(changed('notes/revived.md'));
      await repairer.flush();

      expect(onDamage).toHaveBeenCalledTimes(1);
      expect(onDamage).toHaveBeenCalledWith(['notes/taken.md']);
      expect(warn).toHaveBeenCalled();
    });
  });

  /**
   * Obsidian's metadata cache hands back `null` for a note between hashing its
   * new content and finishing the parse, so every edit — each keystroke saved
   * from review, the import's own frontmatter write — opens a moment where the
   * note reads as having no frontmatter at all. That is not the `ir-id` being
   * gone, and the `changed` event that ends the moment brings the note back.
   */
  describe('a note the cache is still re-reading', () => {
    const PATH = 'notes/one.md';

    /** Rows around the note's path, some of them holding it. */
    const rowsNearArb = fc
      .uniqueArray(
        fc
          .record({
            table: tableArb,
            id: idArb,
            reference: fc.constantFrom(PATH, 'notes/other.md'),
            deleted: fc.boolean(),
          })
          .map((row) => ({ ...row })),
        { selector: ({ id }) => id, maxLength: 5 }
      )
      .filter(
        (rows) =>
          new Set(rows.map(({ table, reference }) => `${table}\0${reference}`))
            .size === rows.length
      );

    /** Whatever the note holds on disk: no claim, a stranger's, or a row's. */
    const noteArb = (rows: readonly StoredRow[]) =>
      fc.oneof(
        noClaimArb.map((irId): FakeNote => ({ path: PATH, irId })),
        someClaimArb.map((irId): FakeNote => ({ path: PATH, irId })),
        fc.constant<FakeNote>({ path: PATH }),
        ...(rows.length > 0
          ? [
              fc
                .constantFrom(...rows.map(({ id }) => id))
                .map((irId): FakeNote => ({ path: PATH, irId })),
            ]
          : [])
      );

    it('neither writes nor warns about it, whatever it holds and whatever holds its path', async () => {
      await fc.assert(
        fc.asyncProperty(
          rowsNearArb.chain((rows) =>
            fc.tuple(fc.constant(rows), noteArb(rows))
          ),
          async ([rows, note]) => {
            const onDamage = vi.fn();
            const { repairer, repo, vault } = wire(rows, [note], { onDamage });
            vault.metadataCache.getFileCache.mockReturnValue(null);
            const bulkMutate = vi.spyOn(repo, 'bulkMutate');
            const before = readRows(repo);

            repairer.handleChange(changed(PATH));
            expect(await repairer.flush()).toStrictEqual([]);

            expect(vault.writeIrId).not.toHaveBeenCalled();
            expect(bulkMutate).not.toHaveBeenCalled();
            expect(onDamage).not.toHaveBeenCalled();
            expect(readRows(repo)).toStrictEqual(before);
          }
        )
      );
    });

    it('judges it once the parse lands and the cache says changed', async () => {
      const onDamage = vi.fn();
      const { repairer, vault } = wire(
        [{ table: 'article', id: 'a1', reference: PATH, deleted: false }],
        [{ path: PATH }],
        { onDamage }
      );
      vault.metadataCache.getFileCache.mockReturnValueOnce(null);

      repairer.handleChange(changed(PATH));
      expect(await repairer.flush()).toStrictEqual([]);
      expect(onDamage).not.toHaveBeenCalled();

      // The parse finishing is what raises `changed`, and the note it finds
      // really has lost its id
      repairer.handleChange(changed(PATH));
      await repairer.flush();

      expect(onDamage).toHaveBeenCalledWith([PATH]);
      expect(vault.snapshot().get(PATH)).toBe('a1');
    });

    it('does not write over a note that went back to being re-read after it was judged', async () => {
      const { repairer, vault } = wire(
        [{ table: 'article', id: 'a1', reference: PATH, deleted: false }],
        [{ path: PATH }]
      );
      // Judged on a settled read; by the re-read before writing, an edit has
      // landed and its parse has not
      const settled = vault.metadataCache.getFileCache.getMockImplementation();
      vault.metadataCache.getFileCache
        .mockImplementationOnce((file: TFile) => settled?.(file) ?? null)
        .mockReturnValue(null);

      repairer.handleChange(changed(PATH));
      expect(await repairer.flush()).toStrictEqual([]);
      expect(vault.writeIrId).not.toHaveBeenCalled();
    });
  });

  describe('the write it makes does not come back to it', () => {
    it('settles after one pass when an id is restored', async () => {
      const { repairer, vault, repo } = wire(
        [
          {
            table: 'article',
            id: 'a1',
            reference: 'notes/one.md',
            deleted: false,
          },
        ],
        [{ path: 'notes/one.md' }]
      );

      repairer.handleChange(changed('notes/one.md'));
      await repairer.flush();
      expect(vault.writeIrId).toHaveBeenCalledTimes(1);

      const rows = readRows(repo);
      const mutate = vi.spyOn(repo, 'mutate');
      // Every pass the first one's `modify` -> `changed` could set off, and
      // three more after it in case the fixpoint is only reached later
      for (let pass = 0; pass < 4; pass++) {
        repairer.handleChange(changed('notes/one.md'));
        expect(await repairer.flush()).toStrictEqual([]);
      }

      expect(vault.writeIrId).toHaveBeenCalledTimes(1);
      expect(mutate).not.toHaveBeenCalled();
      expect(readRows(repo)).toStrictEqual(rows);
    });

    it('settles after one pass when a row is brought back', async () => {
      const { repairer, repo, vault } = wire(
        [
          {
            table: 'srs_card',
            id: 'c1',
            reference: 'notes/card.md',
            deleted: true,
          },
        ],
        [{ path: 'notes/card.md', irId: 'c1' }]
      );

      repairer.handleChange(changed('notes/card.md'));
      expect(await repairer.flush()).toHaveLength(1);

      const rows = readRows(repo);
      const mutate = vi.spyOn(repo, 'mutate');
      for (let pass = 0; pass < 4; pass++) {
        repairer.handleChange(changed('notes/card.md'));
        expect(await repairer.flush()).toStrictEqual([]);
      }

      expect(mutate).not.toHaveBeenCalled();
      expect(vault.writeIrId).not.toHaveBeenCalled();
      expect(readRows(repo)).toStrictEqual(rows);
    });
  });

  describe('cost per change', () => {
    it('never reaches the database for a file that is not a note', async () => {
      const { repairer, repo, vault } = wire([], []);
      const query = vi.spyOn(repo, 'query');

      for (const extension of ['canvas', 'pdf', 'png', 'base', '']) {
        repairer.handleChange(changed(`vault/thing.${extension}`, extension));
      }
      expect(await repairer.flush()).toStrictEqual([]);

      expect(query).not.toHaveBeenCalled();
      expect(vault.vault.getFileByPath).not.toHaveBeenCalled();
    });

    it('answers a whole burst of changes with the same few reads', async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 60 }), async (noteCount) => {
          const notes = Array.from({ length: noteCount }, (_, n) => ({
            path: `plain/${n}.md`,
          }));
          const { repairer, repo } = wire([], notes);
          const query = vi.spyOn(repo, 'query');

          for (const { path } of notes) repairer.handleChange(changed(path));
          expect(await repairer.flush()).toStrictEqual([]);

          // One read per item table, however many notes changed; no id is
          // claimed, so nothing is looked up by id either
          expect(query).toHaveBeenCalledTimes(ITEM_TABLES.length);
        }),
        { numRuns: 15 }
      );
    });

    it('holds one window open per burst rather than pushing it back', async () => {
      const { repairer, scheduler } = wire([], [{ path: 'a.md' }]);

      for (let change = 0; change < 5; change++) {
        repairer.handleChange(changed('a.md'));
      }
      expect(scheduler.schedule).toHaveBeenCalledTimes(1);
      expect(scheduler.schedule.mock.calls[0][1]).toBeGreaterThan(0);

      scheduler.run();
      await repairer.flush();

      // The window is over, so the next burst opens its own
      repairer.handleChange(changed('a.md'));
      expect(scheduler.schedule).toHaveBeenCalledTimes(2);
    });

    it('hands the thread back between batches, and not after the last', async () => {
      const notes = ['a.md', 'b.md', 'c.md'].map((path) => ({ path }));
      const { repairer, pause } = wire([], notes, { pathBatch: 1 });

      for (const { path } of notes) repairer.handleChange(changed(path));
      await repairer.flush();

      expect(pause).toHaveBeenCalledTimes(notes.length - 1);
    });
  });

  it('repairs every note a burst names, across batches', async () => {
    const rows = ['a', 'b', 'c'].map((key) => ({
      table: 'article' as const,
      id: key,
      reference: `notes/${key}.md`,
      deleted: false,
    }));
    const { repairer, vault } = wire(
      rows,
      rows.map(({ reference }) => ({ path: reference })),
      { pathBatch: 2 }
    );

    for (const { reference } of rows) repairer.handleChange(changed(reference));
    expect(await repairer.flush()).toHaveLength(rows.length);

    for (const { id, reference } of rows) {
      expect(vault.snapshot().get(reference)).toBe(id);
    }
  });

  it('carries on with the frontmatter repairs when a row cannot be brought back', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { repairer, repo, vault } = wire(
      [
        {
          table: 'article',
          id: 'a1',
          reference: 'notes/dead.md',
          deleted: true,
        },
        {
          table: 'article',
          id: 'a2',
          reference: 'notes/live.md',
          deleted: false,
        },
      ],
      [{ path: 'notes/back.md', irId: 'a1' }, { path: 'notes/live.md' }]
    );
    vi.spyOn(repo, 'bulkMutate').mockRejectedValue(new Error('unique'));

    repairer.handleChange(changed('notes/back.md'));
    repairer.handleChange(changed('notes/live.md'));
    const applied = await repairer.flush();

    expect(applied).toStrictEqual([
      {
        kind: 'restore-id',
        row: { table: 'article', id: 'a2' },
        path: 'notes/live.md',
      },
    ]);
    expect(vault.snapshot().get('notes/live.md')).toBe('a2');
    expect(error).toHaveBeenCalled();
  });

  describe('with nothing injected', () => {
    it('opens its window on the host timer and takes it back when disposed', async () => {
      const setTimeoutSpy = vi.fn((_handler: () => void, _ms?: number) => 77);
      const clearTimeoutSpy = vi.fn();
      vi.stubGlobal('window', {
        setTimeout: setTimeoutSpy,
        clearTimeout: clearTimeoutSpy,
      });
      const { repairer } = wire([], [{ path: 'a.md' }], {
        schedule: undefined,
      });

      repairer.handleChange(changed('a.md'));
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy.mock.calls[0][1]).toBe(DEBOUNCE_MS);

      repairer.dispose();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(77);
    });

    it('paces a burst wider than one batch on the host idle callback', async () => {
      const notes = Array.from({ length: PATH_BATCH + 1 }, (_, n) => ({
        path: `plain/${n}.md`,
      }));
      const { repairer, repo } = wire([], notes, { yieldToHost: undefined });
      const query = vi.spyOn(repo, 'query');

      for (const { path } of notes) repairer.handleChange(changed(path));
      expect(await repairer.flush()).toStrictEqual([]);

      // Two batches, so one read per item table for each of them
      expect(query).toHaveBeenCalledTimes(ITEM_TABLES.length * 2);
    });
  });

  describe('dispose', () => {
    it('drops a scheduled pass and everything remembered for it', async () => {
      const { repairer, scheduler, repo, vault } = wire(
        [
          {
            table: 'article',
            id: 'a1',
            reference: 'notes/one.md',
            deleted: false,
          },
        ],
        [{ path: 'notes/one.md' }]
      );
      const query = vi.spyOn(repo, 'query');

      repairer.handleChange(changed('notes/one.md'));
      repairer.dispose();
      scheduler.run();

      expect(await repairer.flush()).toStrictEqual([]);
      expect(query).not.toHaveBeenCalled();
      expect(vault.writeIrId).not.toHaveBeenCalled();
    });

    it('stops writing frontmatter partway through a pass', async () => {
      const rows = ['a1', 'a2'].map((id) => ({
        table: 'article' as const,
        id,
        reference: `notes/${id}.md`,
        deleted: false,
      }));
      const harness = wire(
        rows,
        rows.map(({ reference }) => ({ path: reference }))
      );
      harness.vault.writeIrId.mockImplementation(async () => {
        harness.repairer.dispose();
      });

      for (const { reference } of rows) {
        harness.repairer.handleChange(changed(reference));
      }
      await harness.repairer.flush();

      expect(harness.vault.writeIrId).toHaveBeenCalledTimes(1);
    });

    it('stops between batches partway through a pass', async () => {
      const notes = ['a.md', 'b.md', 'c.md'].map((path) => ({ path }));
      const harness = wire([], notes, { pathBatch: 1 });
      const repo = harness.repo;
      const query = vi.spyOn(repo, 'query');
      harness.pause.mockImplementation(async () => {
        harness.repairer.dispose();
      });

      for (const { path } of notes)
        harness.repairer.handleChange(changed(path));
      await harness.repairer.flush();

      // Only the first batch's reads, then the yield dropped the rest
      expect(query).toHaveBeenCalledTimes(ITEM_TABLES.length);
      expect(harness.pause).toHaveBeenCalledTimes(1);
    });

    it('stops taking changes once disposed', async () => {
      const { repairer, scheduler } = wire([], [{ path: 'a.md' }]);
      repairer.dispose();

      repairer.handleChange(changed('a.md'));
      expect(scheduler.schedule).not.toHaveBeenCalled();
      expect(await repairer.flush()).toStrictEqual([]);
    });
  });

  it('runs the scheduled pass and reports a failure without throwing at the host', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { repairer, scheduler, repo, vault } = wire(
      [
        {
          table: 'article',
          id: 'a1',
          reference: 'notes/one.md',
          deleted: false,
        },
      ],
      [{ path: 'notes/one.md' }]
    );
    vi.spyOn(repo, 'query').mockRejectedValue(new Error('database gone'));

    repairer.handleChange(changed('notes/one.md'));
    expect(() => scheduler.run()).not.toThrow();
    // Let the pass the scheduler started settle
    await repairer.flush();

    expect(error).toHaveBeenCalled();
    expect(vault.writeIrId).not.toHaveBeenCalled();
  });

  it('runs passes one at a time, so a second cannot read mid-write', async () => {
    const { repairer, repo, vault } = wire(
      [
        {
          table: 'article',
          id: 'a1',
          reference: 'notes/one.md',
          deleted: false,
        },
        {
          table: 'article',
          id: 'a2',
          reference: 'notes/two.md',
          deleted: false,
        },
      ],
      [{ path: 'notes/one.md' }, { path: 'notes/two.md' }]
    );
    const order: string[] = [];
    vault.writeIrId.mockImplementation(async (file: TFile, id: string) => {
      order.push(`start ${id}`);
      await Promise.resolve();
      vault.notes.set(file.path, { 'ir-id': id });
      order.push(`end ${id}`);
    });

    repairer.handleChange(changed('notes/one.md'));
    const first = repairer.flush();
    repairer.handleChange(changed('notes/two.md'));
    const second = repairer.flush();
    const [a, b] = await Promise.all([first, second]);

    expect([...a, ...b]).toHaveLength(2);
    expect(order).toStrictEqual(['start a1', 'end a1', 'start a2', 'end a2']);
    expect(readRows(repo)).toHaveLength(2);
  });

  describe('over a whole vault', () => {
    /** What the note at a row's reference, or at a path of its own, holds. */
    type NoteState =
      | { kind: 'absent' }
      | { kind: 'no-claim'; irId: unknown }
      | { kind: 'claims'; irId: string };

    const rowsArb = fc
      .uniqueArray(storedRowArb, { selector: ({ id }) => id, maxLength: 6 })
      .filter(
        (rows) =>
          new Set(rows.map(({ table, reference }) => `${table}\0${reference}`))
            .size === rows.length
      );

    /**
     * A vault laid out around some rows: a state for each path a row names, and
     * some notes elsewhere, which is where a row whose reference was evicted
     * finds its note again.
     *
     * No two notes carry the same `ir-id`: two that do are a copy, and which of
     * them a pass reaches first would then decide the outcome. The copy rule has
     * its own tests above.
     */
    /** What a path is to hold, before any id has been handed out. */
    type NotePlan =
      | { kind: 'absent' }
      | { kind: 'no-claim'; irId: unknown }
      /** Claims the id of one of the rows. */
      | { kind: 'known' }
      /** Claims an id no row answers to. */
      | { kind: 'unknown' };

    const planArb = fc.oneof(
      fc.constant<NotePlan>({ kind: 'absent' }),
      noClaimArb.map((irId): NotePlan => ({ kind: 'no-claim', irId })),
      fc.constant<NotePlan>({ kind: 'known' }),
      fc.constant<NotePlan>({ kind: 'unknown' })
    );

    const vaultArb = rowsArb.chain((rows) => {
      const ids = rows.map(({ id }) => id);
      const rowPaths = [...new Set(rows.map(({ reference }) => reference))];

      return fc
        .tuple(
          fc.uniqueArray(
            pathArb.filter((path) => !rowPaths.includes(path)),
            { maxLength: 3 }
          ),
          fc.array(planArb, {
            minLength: rowPaths.length,
            maxLength: rowPaths.length + 3,
          }),
          // The order the rows' ids are handed out in, so which note claims
          // which row varies without two ever claiming the same one
          ids.length > 0 ? fc.shuffledSubarray(ids) : fc.constant<string[]>([])
        )
        .map(([extraPaths, plans, pool]) => {
          let nextKnown = 0;
          let strangers = 0;
          const layout = [...rowPaths, ...extraPaths].map((path, n) => {
            const plan: NotePlan = plans[n] ?? { kind: 'absent' };
            if (plan.kind === 'known' && nextKnown < pool.length) {
              return [
                path,
                { kind: 'claims', irId: pool[nextKnown++] },
              ] as const;
            }
            if (plan.kind === 'known' || plan.kind === 'unknown') {
              // Never a uuid, so never an id any row carries
              return [
                path,
                { kind: 'claims', irId: `stranger-${strangers++}` },
              ] as const;
            }
            return [path, plan] as const;
          });
          return { rows, layout: layout as (readonly [string, NoteState])[] };
        });
    });

    it('repairs exactly what the ir-id authority calls for, and settles there', async () => {
      await fc.assert(
        fc.asyncProperty(vaultArb, async ({ rows, layout }) => {
          const claimed = new Map<string, string>();
          const notes: FakeNote[] = [];
          for (const [path, state] of layout) {
            if (state.kind === 'absent') continue;
            if (state.kind === 'claims') {
              // Enforced by the arbitrary; asserted so a change to it shows up
              // here rather than as a mystery failure
              expect(claimed.has(state.irId)).toBe(false);
              claimed.set(state.irId, path);
            }
            notes.push({
              path,
              irId: state.kind === 'claims' ? state.irId : state.irId,
            });
          }

          const { repairer, repo, vault } = wire(rows, notes);
          const before = vault.snapshot();

          for (const [path] of layout) repairer.handleChange(changed(path));
          await repairer.flush();

          const after = vault.snapshot();
          const rowsAfter = new Map(
            readRows(repo).map((row) => [`${row.table}\0${row.id}`, row])
          );
          const liveAt = (path: string) =>
            rows.filter((row) => row.reference === path && !row.deleted);

          // No claim is ever overwritten, and no note is left without one it had
          for (const [path, irId] of before) {
            if (claimsIdentity(irId)) {
              expect(after.get(path)).toBe(irId);
            } else if (liveAt(path).length === 1) {
              expect(after.get(path)).toBe(liveAt(path)[0].id);
            } else {
              expect(after.get(path)).toBe(irId);
            }
          }

          for (const row of rows) {
            const now = rowsAfter.get(`${row.table}\0${row.id}`);
            expect(now).toBeDefined();
            if (!row.deleted) {
              // Nothing here ever deletes a row or moves a live one
              expect(now).toStrictEqual(row);
              continue;
            }

            const path = claimed.get(row.id);
            // No note claims it, or the note at its own reference still does and
            // this one is a copy of that note: either way it must stand as it was
            const mustStand =
              path === undefined ||
              (row.reference !== path && before.get(row.reference) === row.id);
            if (mustStand) {
              expect(now).toStrictEqual(row);
              continue;
            }

            const restored = { ...row, reference: path, deleted: false };
            // Another row of its own table starts out holding the path it wants.
            // Whether that row moves off in time to let this one in is a
            // question of the order the pass settles in, so both outcomes pass
            // here; `UNIQUE` above and the idempotence check below are what hold
            // the result to account.
            const contested = rows.some(
              (other) =>
                other.table === row.table &&
                other.id !== row.id &&
                other.reference === path
            );
            if (contested) expect([row, restored]).toContainEqual(now);
            else expect(now).toStrictEqual(restored);
          }

          // `reference` is UNIQUE per table, so no repair may collide
          const held = readRows(repo).map(
            ({ table, reference }) => `${table}\0${reference}`
          );
          expect(new Set(held).size).toBe(held.length);

          // Everything the pass wrote raises `changed` again; the next pass must
          // find nothing left to do
          const writes = vault.writeIrId.mock.calls.length;
          const mutate = vi.spyOn(repo, 'mutate');
          for (const [path] of layout) repairer.handleChange(changed(path));
          expect(await repairer.flush()).toStrictEqual([]);

          expect(vault.writeIrId.mock.calls.length).toBe(writes);
          expect(mutate).not.toHaveBeenCalled();
          expect(vault.snapshot()).toStrictEqual(after);
        }),
        { numRuns: 60 }
      );
    });
  });
});
