import { SQLJSRepository } from '#/lib/repository/SQLJSRepository';
import { Notice } from '#/test/__mocks__/obsidian';
import fc from 'fast-check';
import { readFileSync } from 'fs';
import type { App, TFile } from 'obsidian';
import { resolve } from 'path';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ARTICLE_TAG, CARD_TAG, SNIPPET_TAG } from './constants';
import { ITEM_TABLES, type ItemTable, evictedSpot } from './moved-note-scan';
import {
  type RelinkFile,
  type RelinkVault,
  isClaimed,
  readClaims,
  relinkCandidates,
  relinkItem,
  relinkRow,
  unavailability,
  vaultReader,
} from './relink';

// #region HELPERS

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

  /**
   * The real methods, still reachable once a spy has taken over the
   * instance's own: `super` resolves past it on the prototype.
   */
  openTransaction<T>(work: () => T | Promise<T>): Promise<T> {
    return super.transaction(work);
  }

  rawMutate(query: string, params?: Parameters<SQLJSRepository['mutate']>[1]) {
    return super.mutate(query, params);
  }
}

interface StoredRow {
  table: ItemTable;
  id: string;
  reference: string;
  deleted: boolean;
  parent?: string | null;
}

function insertItem(repo: TestRepository, row: StoredRow) {
  if (row.table === 'srs_card') {
    repo.mutate(
      `INSERT INTO srs_card (id, reference, parent, deleted, created_at, due,
         stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state)
       VALUES ($1, $2, $3, $4, $5, $5, 0, 0, 0, 0, 0, 0, 0)`,
      [row.id, row.reference, row.parent ?? null, row.deleted, FIXED_DUE]
    );
    return;
  }
  if (row.table === 'snippet') {
    repo.mutate(
      `INSERT INTO snippet (id, reference, parent, deleted, due, interval, priority)
       VALUES ($1, $2, $3, $4, $5, 86400000, 30)`,
      [row.id, row.reference, row.parent ?? null, row.deleted, FIXED_DUE]
    );
    return;
  }
  repo.mutate(
    `INSERT INTO article (id, reference, deleted, due, interval, priority)
     VALUES ($1, $2, $3, $4, 86400000, 30)`,
    [row.id, row.reference, row.deleted, FIXED_DUE]
  );
}

/** Every item row, read straight off the database. */
function readRows(repo: TestRepository): StoredRow[] {
  return ITEM_TABLES.flatMap((table) => {
    const parentColumn = table === 'article' ? 'NULL' : 'parent';
    const [result] = repo.db?.exec(
      `SELECT id, reference, deleted, ${parentColumn} FROM ${table} ORDER BY id`
    ) ?? [undefined];
    return (result?.values ?? []).map(([id, reference, deleted, parent]) => ({
      table,
      id: String(id),
      reference: String(reference),
      deleted: deleted === 1,
      parent: parent === null ? null : String(parent),
    }));
  });
}

function makeFile(path: string): RelinkFile {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return { path, extension: dot === -1 ? '' : name.slice(dot + 1) };
}

/** Extensions in every case the vault could hand back, known or not. */
const extensionArb = fc.oneof(
  fc.constantFrom('md', 'MD', 'Md', 'pdf', 'PDF', 'png', 'txt', ''),
  fc.string({ maxLength: 4 })
);

/** A vault path, possibly nested, possibly without an extension. */
const pathArb = fc
  .tuple(
    fc.array(fc.stringMatching(/^[a-z]{1,3}$/), { maxLength: 2 }),
    fc.stringMatching(/^[a-z]{1,4}$/),
    extensionArb
  )
  .map(([dirs, base, ext]) =>
    [...dirs, ext === '' ? base : `${base}.${ext}`].join('/')
  );

const MIME: Record<string, string> = { md: 'text/markdown', pdf: 'pdf' };
const mimeOfPath = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot === -1) return null;
  return MIME[name.slice(dot + 1).toLowerCase()] ?? null;
};

/** Rows over a small pool of paths, so they collide on purpose. */
const rowsArb = fc
  .uniqueArray(
    fc.record({
      table: fc.constantFrom(...ITEM_TABLES),
      id: fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f'),
      reference: fc.constantFrom(
        'x.md',
        'y.md',
        'd/x.md',
        'x.pdf',
        'y.PDF',
        'z.png'
      ),
      deleted: fc.boolean(),
    }),
    {
      maxLength: 8,
      // `reference` is UNIQUE per table
      comparator: (a, b) =>
        (a.table === b.table && a.id === b.id) ||
        (a.table === b.table && a.reference === b.reference),
    }
  )
  .filter((rows) => rows.length > 0);

/** The plugin `relinkItem` reaches, recording each frontmatter write. */
function makePlugin(
  repo: TestRepository,
  frontmatter: Record<string, Record<string, unknown>> = {},
  /** Paths with a file, beyond the target handed to `relinkItem`. */
  files: string[] = []
) {
  const written: Record<string, Record<string, unknown>> = {};
  const plugin = {
    app: {
      vault: {
        getFileByPath: vi.fn((path: string) =>
          files.includes(path) ? ({ path } as TFile) : null
        ),
      },
      metadataCache: {
        getFileCache: vi.fn((file: TFile) =>
          file.path in frontmatter
            ? { frontmatter: frontmatter[file.path] }
            : null
        ),
      },
      fileManager: {
        processFrontMatter: vi.fn(
          async (file: TFile, fn: (fm: Record<string, unknown>) => void) => {
            const fm = { ...(frontmatter[file.path] ?? {}) };
            fn(fm);
            written[file.path] = fm;
          }
        ),
      },
      workspace: { trigger: vi.fn() },
    },
    reviewManager: {
      repo,
      snippets: {
        offsetTracker: { renameFile: vi.fn(), loadHighlights: vi.fn() },
        // Looked up in the database, as the real item managers do
        findById: vi.fn((id: string) => {
          for (const table of ITEM_TABLES) {
            const [row] = repo.query(`SELECT * FROM ${table} WHERE id = $1`, [
              id,
            ]);
            if (row) return { row, table };
          }
          return null;
        }),
        getHighlights: vi.fn().mockResolvedValue([{ id: 'highlight' }]),
      },
    },
  };
  return { plugin, written };
}

/** Each table with the tag its notes carry. */
const TABLE_TAGS = [
  { table: 'article', tag: ARTICLE_TAG },
  { table: 'snippet', tag: SNIPPET_TAG },
  { table: 'srs_card', tag: CARD_TAG },
] as const;

/** A vault with no note frontmatter, where only the targets are files. */
const NO_NOTES: RelinkVault = {
  irIdOf: () => undefined,
  taggedTableOf: () => null,
  hasFileAt: () => false,
};

/** Every item type tag. */
const ITEM_TAGS: string[] = TABLE_TAGS.map(({ tag }) => tag);

/** What a note can say about its type, and the frontmatter that says it. */
const TAG_STATES = [
  ['no frontmatter', () => undefined],
  ['no tags', () => ({ other: 1 })],
  ['only unknown tags', () => ({ tags: ['reading', 'ir-articles', 'ir'] })],
  ['an unknown tag string', () => ({ tags: 'ir-cards, todo' })],
  ['its own type tag', (own: string) => ({ tags: [own] })],
  ['another type’s tag', (_own: string, other: string) => ({ tags: [other] })],
] as const;

/** Every row type against every tag state, and every other type's tag. */
const TAG_CASES = TABLE_TAGS.flatMap((own) =>
  TABLE_TAGS.filter(({ table }) => table !== own.table).flatMap((other) =>
    TAG_STATES.map(([state, frontmatterFor]) => ({
      table: own.table,
      tag: own.tag,
      other: other.table,
      state,
      frontmatter: frontmatterFor(own.tag, other.tag),
      refused: state === 'another type’s tag',
    }))
  )
);

// #endregion

describe('relinkCandidates', () => {
  it('keeps exactly the unclaimed files sharing the old reference’s known type, in order', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(pathArb, { maxLength: 12 }),
        pathArb,
        fc.func(fc.boolean()),
        (paths, oldReference, claimed) => {
          const files = paths.map(makeFile);
          const expectedType = mimeOfPath(oldReference);
          const expected = files.filter(
            (file) =>
              expectedType !== null &&
              mimeOfPath(file.path) === expectedType &&
              !claimed(file)
          );
          expect(relinkCandidates(files, oldReference, claimed)).toEqual(
            expected
          );
        }
      )
    );
  });
});

describe('isClaimed', () => {
  it('is claimed when a live row holds its path or its note carries a live row’s id', () => {
    fc.assert(
      fc.property(
        pathArb,
        fc.uniqueArray(pathArb, { maxLength: 4 }),
        fc.uniqueArray(fc.string({ maxLength: 3 }), { maxLength: 4 }),
        fc.option(fc.string({ maxLength: 3 }), { nil: undefined }),
        (path, paths, ids, irId) => {
          const claims = { paths: new Set(paths), ids: new Set(ids) };
          expect(isClaimed(makeFile(path), claims, () => irId)).toBe(
            paths.includes(path) || (irId !== undefined && ids.includes(irId))
          );
        }
      )
    );
  });
});

describe('unavailability', () => {
  it('is taken when claimed, else tagged when its note is another kind of item, else available', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ITEM_TABLES),
        pathArb,
        fc.uniqueArray(pathArb, { maxLength: 4 }),
        fc.uniqueArray(fc.string({ maxLength: 3 }), { maxLength: 4 }),
        fc.option(fc.string({ maxLength: 3 }), { nil: undefined }),
        fc.option(fc.constantFrom(...ITEM_TABLES), { nil: null }),
        (table, path, paths, ids, irId, tagged) => {
          const claims = { paths: new Set(paths), ids: new Set(ids) };
          const file = makeFile(path);
          const claimed =
            paths.includes(path) || (irId !== undefined && ids.includes(irId));

          expect(
            unavailability({ table, id: 'own' }, file, claims, {
              irIdOf: () => irId,
              taggedTableOf: () => tagged,
            })
          ).toBe(
            claimed
              ? 'taken'
              : tagged !== null && tagged !== table
                ? 'tagged'
                : null
          );
        }
      )
    );
  });
});

describe('with a database', () => {
  beforeAll(async () => {
    const wasmBinary = readFileSync(
      require.resolve('sql.js/dist/sql-wasm.wasm')
    );
    SQL = await initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('readClaims', () => {
    it('collects every live row’s path and id except the item’s own', async () => {
      await fc.assert(
        fc.asyncProperty(rowsArb, fc.nat(), async (rows, pick) => {
          const repo = TestRepository.create();
          rows.forEach((row) => insertItem(repo, row));
          const own = rows[pick % rows.length];

          const claims = await readClaims(repo, own);

          const others = rows.filter(
            (row) =>
              !row.deleted && !(row.table === own.table && row.id === own.id)
          );
          expect([...claims.paths].sort()).toEqual(
            [...new Set(others.map((row) => row.reference))].sort()
          );
          expect([...claims.ids].sort()).toEqual(
            [...new Set(others.map((row) => row.id))].sort()
          );
        })
      );
    });
  });

  describe('relinkRow', () => {
    it('moves the row onto the target, or refuses and changes nothing', async () => {
      await fc.assert(
        fc.asyncProperty(
          rowsArb,
          fc.nat(),
          fc.constantFrom(
            'x.md',
            'y.md',
            'd/x.md',
            'n.md',
            'x.pdf',
            'y.PDF',
            'n.pdf',
            'z.png'
          ),
          fc.option(fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f'), {
            nil: undefined,
          }),
          fc.option(fc.constantFrom(...ITEM_TABLES), { nil: null }),
          fc.boolean(),
          async (rows, pick, targetPath, irId, tagged, fileIsBack) => {
            const repo = TestRepository.create();
            rows.forEach((row) => insertItem(repo, row));
            const own = rows[pick % rows.length];
            const before = readRows(repo);

            const result = await relinkRow(
              repo,
              { table: own.table, id: own.id },
              makeFile(targetPath),
              {
                irIdOf: () => irId,
                taggedTableOf: () => tagged,
                hasFileAt: (path) => fileIsBack && path === own.reference,
              }
            );

            const others = rows.filter(
              (row) =>
                !(row.table === own.table && row.id === own.id) && !row.deleted
            );
            const sameType =
              mimeOfPath(own.reference) !== null &&
              mimeOfPath(own.reference) === mimeOfPath(targetPath);
            const taken =
              others.some((row) => row.reference === targetPath) ||
              (irId !== undefined && others.some((row) => row.id === irId));

            if (own.deleted) {
              expect(result).toEqual({ ok: false, reason: 'no-row' });
              expect(readRows(repo)).toEqual(before);
              return;
            }
            if (fileIsBack) {
              expect(result).toEqual({ ok: false, reason: 'not-missing' });
              expect(readRows(repo)).toEqual(before);
              return;
            }
            if (!sameType) {
              expect(result).toEqual({ ok: false, reason: 'wrong-type' });
              expect(readRows(repo)).toEqual(before);
              return;
            }
            if (taken) {
              expect(result).toEqual({ ok: false, reason: 'taken' });
              expect(readRows(repo)).toEqual(before);
              return;
            }
            if (tagged !== null && tagged !== own.table) {
              expect(result).toEqual({ ok: false, reason: 'tagged' });
              expect(readRows(repo)).toEqual(before);
              return;
            }

            expect(result).toEqual({ ok: true, from: own.reference });
            const expected = before.map((row) => {
              if (row.table === own.table && row.id === own.id) {
                return { ...row, reference: targetPath };
              }
              // A tombstone on the target gives the path up, keeping its row
              if (row.table === own.table && row.reference === targetPath) {
                return { ...row, reference: evictedSpot(row) };
              }
              return row;
            });
            expect(readRows(repo)).toEqual(expected);
          }
        )
      );
    });

    it('refuses a target when the item’s own type is unknown, even one of the same unknown type', async () => {
      const repo = TestRepository.create();
      insertItem(repo, {
        table: 'article',
        id: 'a',
        reference: 'a.png',
        deleted: false,
      });
      await expect(
        relinkRow(
          repo,
          { table: 'article', id: 'a' },
          makeFile('b.png'),
          NO_NOTES
        )
      ).resolves.toEqual({ ok: false, reason: 'wrong-type' });
    });

    it('refuses a row that no longer exists', async () => {
      const repo = TestRepository.create();
      await expect(
        relinkRow(
          repo,
          { table: 'article', id: 'gone' },
          makeFile('x.md'),
          NO_NOTES
        )
      ).resolves.toEqual({ ok: false, reason: 'no-row' });
    });

    it('leaves children pointing at the relinked parent and its review history in place', async () => {
      const repo = TestRepository.create();
      insertItem(repo, {
        table: 'article',
        id: 'p',
        reference: 'gone.pdf',
        deleted: false,
      });
      insertItem(repo, {
        table: 'snippet',
        id: 's',
        reference: 's.md',
        deleted: false,
        parent: 'p',
      });
      insertItem(repo, {
        table: 'srs_card',
        id: 'c',
        reference: 'c.md',
        deleted: false,
        parent: 's',
      });
      repo.mutate(
        'INSERT INTO article_review (id, article_id, review_time) VALUES ($1, $2, $3)',
        ['r', 'p', FIXED_DUE]
      );

      await relinkRow(
        repo,
        { table: 'article', id: 'p' },
        makeFile('new/place.pdf'),
        NO_NOTES
      );

      expect(readRows(repo)).toEqual([
        {
          table: 'article',
          id: 'p',
          reference: 'new/place.pdf',
          deleted: false,
          parent: null,
        },
        {
          table: 'snippet',
          id: 's',
          reference: 's.md',
          deleted: false,
          parent: 'p',
        },
        {
          table: 'srs_card',
          id: 'c',
          reference: 'c.md',
          deleted: false,
          parent: 's',
        },
      ]);
      expect(
        repo.db?.exec('SELECT id, article_id FROM article_review')[0].values
      ).toEqual([['r', 'p']]);
    });

    it('reads the target’s claims inside the transaction', async () => {
      const repo = TestRepository.create();
      insertItem(repo, {
        table: 'article',
        id: 'a',
        reference: 'gone.md',
        deleted: false,
      });
      vi.spyOn(repo, 'transaction').mockImplementation(async (work) => {
        // Another item takes the target between the picker and the write
        insertItem(repo, {
          table: 'snippet',
          id: 'b',
          reference: 'x.md',
          deleted: false,
        });
        return repo.openTransaction(work);
      });

      await expect(
        relinkRow(
          repo,
          { table: 'article', id: 'a' },
          makeFile('x.md'),
          NO_NOTES
        )
      ).resolves.toEqual({ ok: false, reason: 'taken' });
    });

    it('writes the row and any eviction in one transaction', async () => {
      const repo = TestRepository.create();
      insertItem(repo, {
        table: 'article',
        id: 'a',
        reference: 'gone.md',
        deleted: false,
      });
      insertItem(repo, {
        table: 'article',
        id: 't',
        reference: 'x.md',
        deleted: true,
      });
      const transaction = vi.spyOn(repo, 'transaction');
      const mutate = vi.spyOn(repo, 'mutate');
      let inTransaction = false;
      transaction.mockImplementation(async (work) => {
        inTransaction = true;
        try {
          return await repo.openTransaction(work);
        } finally {
          inTransaction = false;
        }
      });
      const outside: string[] = [];
      mutate.mockImplementation((query, params) => {
        if (!inTransaction) outside.push(query);
        return repo.rawMutate(query, params);
      });

      await relinkRow(
        repo,
        { table: 'article', id: 'a' },
        makeFile('x.md'),
        NO_NOTES
      );

      expect(transaction).toHaveBeenCalledTimes(1);
      expect(mutate).toHaveBeenCalledTimes(2);
      expect(outside).toEqual([]);
    });
  });
});

describe('relinkItem', () => {
  beforeAll(async () => {
    const wasmBinary = readFileSync(
      require.resolve('sql.js/dist/sql-wasm.wasm')
    );
    SQL = await initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });
  });

  beforeEach(() => {
    Notice.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(TABLE_TAGS)(
    'gives a markdown target the $table’s ir-id and tag',
    async ({ table, tag }) => {
      const repo = TestRepository.create();
      insertItem(repo, {
        table,
        id: 'i',
        reference: 'gone.md',
        deleted: false,
      });
      const { plugin, written } = makePlugin(repo, {
        'new.md': { tags: ['mine'], other: 1 },
      });

      const result = await relinkItem(
        plugin as never,
        { table, id: 'i' },
        makeFile('new.md') as TFile
      );

      expect(result).toEqual({ ok: true, from: 'gone.md' });
      expect(written).toEqual({
        'new.md': { 'ir-id': 'i', tags: ['mine', tag], other: 1 },
      });
    }
  );

  it('writes nothing to a PDF target', async () => {
    const repo = TestRepository.create();
    insertItem(repo, {
      table: 'article',
      id: 'i',
      reference: 'gone.pdf',
      deleted: false,
    });
    const { plugin } = makePlugin(repo);

    const result = await relinkItem(
      plugin as never,
      { table: 'article', id: 'i' },
      makeFile('new.pdf') as TFile
    );

    expect(result).toEqual({ ok: true, from: 'gone.pdf' });
    expect(plugin.app.fileManager.processFrontMatter).not.toHaveBeenCalled();
    expect(plugin.app.metadataCache.getFileCache).not.toHaveBeenCalled();
  });

  it('moves the item’s highlights along and repaints them', async () => {
    const repo = TestRepository.create();
    insertItem(repo, {
      table: 'article',
      id: 'i',
      reference: 'gone.pdf',
      deleted: false,
    });
    const { plugin } = makePlugin(repo);

    await relinkItem(
      plugin as never,
      { table: 'article', id: 'i' },
      makeFile('new.pdf') as TFile
    );

    expect(
      plugin.reviewManager.snippets.offsetTracker.renameFile
    ).toHaveBeenCalledWith('gone.pdf', 'new.pdf');
    expect(plugin.app.workspace.trigger).toHaveBeenCalledWith(
      'ir-highlights-changed',
      'new.pdf'
    );
    expect(Notice.messages).toEqual(['Relinked to "new.pdf"']);
  });

  it('refuses a note that carries another item’s ir-id, writing nothing', async () => {
    const repo = TestRepository.create();
    insertItem(repo, {
      table: 'article',
      id: 'i',
      reference: 'gone.md',
      deleted: false,
    });
    insertItem(repo, {
      table: 'snippet',
      id: 'other',
      reference: 'o.md',
      deleted: false,
    });
    const { plugin, written } = makePlugin(repo, {
      'copy.md': { 'ir-id': 'other' },
    });

    const result = await relinkItem(
      plugin as never,
      { table: 'article', id: 'i' },
      makeFile('copy.md') as TFile
    );

    expect(result).toEqual({ ok: false, reason: 'taken' });
    expect(written).toEqual({});
    expect(
      plugin.reviewManager.snippets.offsetTracker.renameFile
    ).not.toHaveBeenCalled();
    expect(plugin.app.workspace.trigger).not.toHaveBeenCalled();
    expect(Notice.messages).toEqual([
      '"copy.md" already belongs to another item',
    ]);
  });

  it.each([
    [
      'wrong-type',
      'gone.md',
      'new.pdf',
      '"new.pdf" is not the same type of file as the item',
    ],
    ['no-row', null, 'new.md', 'The item no longer exists'],
  ] as const)(
    'tells the user why a %s relink was refused',
    async (_reason, reference, target, message) => {
      const repo = TestRepository.create();
      if (reference) {
        insertItem(repo, {
          table: 'article',
          id: 'i',
          reference,
          deleted: false,
        });
      }
      const { plugin, written } = makePlugin(repo);

      await relinkItem(
        plugin as never,
        { table: 'article', id: 'i' },
        makeFile(target) as TFile
      );

      expect(written).toEqual({});
      expect(Notice.messages).toEqual([message]);
    }
  );
  it.each([
    ['a list', ['mine', ARTICLE_TAG]],
    ['a string', `mine, ${ARTICLE_TAG}`],
  ])(
    'refuses a note tagged as another kind of item, its tags written as %s',
    async (_form, tags) => {
      const repo = TestRepository.create();
      insertItem(repo, {
        table: 'snippet',
        id: 'i',
        reference: 'gone.md',
        deleted: false,
      });
      const { plugin, written } = makePlugin(repo, { 'article.md': { tags } });

      const result = await relinkItem(
        plugin as never,
        { table: 'snippet', id: 'i' },
        makeFile('article.md') as TFile
      );

      expect(result).toEqual({ ok: false, reason: 'tagged' });
      expect(written).toEqual({});
      expect(Notice.messages).toEqual([
        '"article.md" is tagged as another kind of item',
      ]);
    }
  );

  it('takes a note already tagged as its own kind of item', async () => {
    const repo = TestRepository.create();
    insertItem(repo, {
      table: 'snippet',
      id: 'i',
      reference: 'gone.md',
      deleted: false,
    });
    const { plugin } = makePlugin(repo, {
      'mine.md': { tags: SNIPPET_TAG },
    });

    await expect(
      relinkItem(
        plugin as never,
        { table: 'snippet', id: 'i' },
        makeFile('mine.md') as TFile
      )
    ).resolves.toEqual({ ok: true, from: 'gone.md' });
  });

  it('refuses an item whose file has come back, leaving that file its own', async () => {
    const repo = TestRepository.create();
    insertItem(repo, {
      table: 'article',
      id: 'i',
      reference: 'back.md',
      deleted: false,
    });
    const { plugin, written } = makePlugin(repo, {}, ['back.md']);

    const result = await relinkItem(
      plugin as never,
      { table: 'article', id: 'i' },
      makeFile('other.md') as TFile
    );

    expect(result).toEqual({ ok: false, reason: 'not-missing' });
    expect(written).toEqual({});
    expect(Notice.messages).toEqual([
      'The item has its file again; nothing to relink',
    ]);
  });

  it('keeps the relink when the note’s frontmatter cannot be written, and says so', async () => {
    const repo = TestRepository.create();
    insertItem(repo, {
      table: 'article',
      id: 'i',
      reference: 'gone.md',
      deleted: false,
    });
    const { plugin } = makePlugin(repo);
    plugin.app.fileManager.processFrontMatter.mockRejectedValue(
      new Error('bad YAML')
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await relinkItem(
      plugin as never,
      { table: 'article', id: 'i' },
      makeFile('new.md') as TFile
    );

    expect(result).toEqual({ ok: true, from: 'gone.md' });
    expect(readRows(repo)[0].reference).toBe('new.md');
    expect(plugin.app.workspace.trigger).toHaveBeenCalledWith(
      'ir-highlights-changed',
      'new.md'
    );
    expect(Notice.messages).toEqual([
      'Relinked to "new.md", but its frontmatter could not be updated',
    ]);
  });
  describe('a snippet’s highlight in its parent', () => {
    /** A parent article at `parent.md` and its missing snippet `i`. */
    function wireSnippet(parentFileThere = true) {
      const repo = TestRepository.create();
      insertItem(repo, {
        table: 'article',
        id: 'p',
        reference: 'parent.md',
        deleted: false,
      });
      insertItem(repo, {
        table: 'snippet',
        id: 'i',
        reference: 'gone.md',
        deleted: false,
        parent: 'p',
      });
      const { plugin } = makePlugin(
        repo,
        {},
        parentFileThere ? ['parent.md'] : []
      );
      const relink = () =>
        relinkItem(
          plugin as never,
          { table: 'snippet', id: 'i' },
          makeFile('new.md') as TFile
        );
      return { plugin, relink };
    }

    it('reloads only the parent’s highlights, so they name the snippet’s new path', async () => {
      const { plugin, relink } = wireSnippet();
      const { snippets } = plugin.reviewManager;

      await relink();

      expect(snippets.getHighlights.mock.calls).toEqual([
        [{ path: 'parent.md' }],
      ]);
      expect(snippets.offsetTracker.loadHighlights).toHaveBeenCalledWith(
        'parent.md',
        [{ id: 'highlight' }]
      );
      expect(plugin.app.workspace.trigger).toHaveBeenCalledWith(
        'ir-highlights-changed',
        'parent.md'
      );
    });

    it('reloads nothing for a parent with no file', async () => {
      const { plugin, relink } = wireSnippet(false);

      await expect(relink()).resolves.toEqual({ ok: true, from: 'gone.md' });
      expect(
        plugin.reviewManager.snippets.getHighlights
      ).not.toHaveBeenCalled();
    });

    it('keeps the relink, and says it worked, when the reload fails', async () => {
      const { plugin, relink } = wireSnippet();
      plugin.reviewManager.snippets.getHighlights.mockRejectedValue(
        new Error('db reloading')
      );
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(relink()).resolves.toEqual({ ok: true, from: 'gone.md' });
      expect(Notice.messages).toEqual(['Relinked to "new.md"']);
    });

    it.each(['article', 'srs_card'] as const)(
      'reloads no parent for a relinked %s',
      async (table) => {
        const repo = TestRepository.create();
        insertItem(repo, {
          table,
          id: 'i',
          reference: 'gone.md',
          deleted: false,
          parent: table === 'srs_card' ? 'p' : undefined,
        });
        const { plugin } = makePlugin(repo, {}, ['parent.md']);

        await relinkItem(
          plugin as never,
          { table, id: 'i' },
          makeFile('new.md') as TFile
        );

        expect(
          plugin.reviewManager.snippets.getHighlights
        ).not.toHaveBeenCalled();
      }
    );
  });
});

describe('vaultReader', () => {
  /** An app whose one note, `n.md`, has `tags` in its frontmatter. */
  function readerFor(tags: unknown) {
    return vaultReader({
      metadataCache: {
        getFileCache: () => ({ frontmatter: { tags } }),
      },
    } as never);
  }

  /** An item tag, padded or joined to more text, or any text at all. */
  const tagLike = fc.oneof(
    fc.constantFrom(...ITEM_TAGS),
    fc
      .tuple(fc.constantFrom(...ITEM_TAGS), fc.constantFrom(' ', ',', 'x'))
      .chain(([tag, extra]) =>
        fc.constantFrom(`${extra}${tag}`, `${tag}${extra}`)
      ),
    fc.string()
  );

  it('types a note tagged by list by its exact entries, the first item table found winning', () => {
    fc.assert(
      fc.property(fc.array(tagLike), (tags) => {
        const expected =
          TABLE_TAGS.find(({ tag }) => tags.includes(tag))?.table ?? null;
        expect(readerFor(tags).taggedTableOf(makeFile('n.md') as TFile)).toBe(
          expected
        );
      })
    );
  });

  it('types a note tagged by string by its words, split on spaces and commas', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.stringMatching(/^[\s,]*$/),
            fc.oneof(fc.constantFrom(...ITEM_TAGS), fc.string())
          )
        ),
        fc.stringMatching(/^[\s,]*$/),
        (parts, tail) => {
          const tags = parts.map(([sep, word]) => sep + word).join('') + tail;
          const words = tags.split(/[\s,]+/);
          const expected =
            TABLE_TAGS.find(({ tag }) => words.includes(tag))?.table ?? null;
          expect(readerFor(tags).taggedTableOf(makeFile('n.md') as TFile)).toBe(
            expected
          );
        }
      )
    );
  });

  it.each([
    [[SNIPPET_TAG, ARTICLE_TAG], 'article'],
    [`${CARD_TAG},${SNIPPET_TAG}`, 'snippet'],
    [[1, ARTICLE_TAG, null], 'article'],
    [[1, null, { tag: ARTICLE_TAG }], null],
    [42, null],
    [undefined, null],
    [`x${ARTICLE_TAG}`, null],
  ])('types a note tagged %j as %s', (tags, expected) => {
    expect(readerFor(tags).taggedTableOf(makeFile('n.md') as TFile)).toBe(
      expected
    );
  });

  it('reads no tags or id off a file without frontmatter', () => {
    const getFileCache = vi.fn(() => ({
      frontmatter: { tags: [ARTICLE_TAG], 'ir-id': 'x' },
    }));
    const reader = vaultReader({ metadataCache: { getFileCache } } as never);
    const pdf = makeFile('p.pdf') as TFile;

    expect(reader.taggedTableOf(pdf)).toBeNull();
    expect(reader.irIdOf(pdf)).toBeUndefined();
    expect(getFileCache).not.toHaveBeenCalled();
  });
});

describe('relinking by the target note’s type tag', () => {
  beforeAll(async () => {
    const wasmBinary = readFileSync(
      require.resolve('sql.js/dist/sql-wasm.wasm')
    );
    SQL = await initSqlJs({ wasmBinary: wasmBinary as unknown as ArrayBuffer });
  });

  beforeEach(() => {
    Notice.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(TAG_CASES)(
    'a $table row and a note with $state (other type: $other): refused only for another type',
    async ({ table, tag, frontmatter, refused }) => {
      const repo = TestRepository.create();
      insertItem(repo, {
        table,
        id: 'i',
        reference: 'gone.md',
        deleted: false,
      });
      const { plugin, written } = makePlugin(
        repo,
        frontmatter ? { 'n.md': frontmatter } : {}
      );
      const target = makeFile('n.md') as TFile;

      const available = unavailability(
        { table, id: 'i' },
        target,
        { paths: new Set(), ids: new Set() },
        vaultReader(plugin.app as never)
      );
      const result = await relinkItem(
        plugin as never,
        { table, id: 'i' },
        target
      );

      if (refused) {
        expect(available).toBe('tagged');
        expect(result).toEqual({ ok: false, reason: 'tagged' });
        expect(written).toEqual({});
        expect(readRows(repo)[0].reference).toBe('gone.md');
        return;
      }
      expect(available).toBeNull();
      expect(result).toEqual({ ok: true, from: 'gone.md' });
      expect(readRows(repo)[0].reference).toBe('n.md');
      expect(written['n.md']?.['ir-id']).toBe('i');
      expect(written['n.md']?.tags).toEqual(expect.arrayContaining([tag]));
    }
  );

  it('links a note whose tags name no item type, as a list or a string, to a row of any type', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...TABLE_TAGS),
        fc.array(fc.string()),
        fc.option(fc.constantFrom(' ', ',', ', '), { nil: null }),
        async ({ table, tag }, words, separator) => {
          const tags = separator === null ? words : words.join(separator);
          const named =
            separator === null ? words : words.join(separator).split(/[\s,]+/);
          fc.pre(!named.some((word) => ITEM_TAGS.includes(word)));
          const repo = TestRepository.create();
          insertItem(repo, {
            table,
            id: 'i',
            reference: 'gone.md',
            deleted: false,
          });
          const { plugin, written } = makePlugin(repo, { 'n.md': { tags } });

          const result = await relinkItem(
            plugin as never,
            { table, id: 'i' },
            makeFile('n.md') as TFile
          );

          expect(result).toEqual({ ok: true, from: 'gone.md' });
          expect(written['n.md']?.['ir-id']).toBe('i');
          expect(written['n.md']?.tags).toEqual(expect.arrayContaining([tag]));
        }
      ),
      { numRuns: 50 }
    );
  });
});
