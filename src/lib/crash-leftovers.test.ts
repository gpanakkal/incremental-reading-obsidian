import { ArticleManager } from '#/lib/items/ArticleManager';
import { CardManager } from '#/lib/items/CardManager';
import { SnippetManager } from '#/lib/items/SnippetManager';
import { makeItemVault, TestRepository } from '#/test/item-vault';
import fc from 'fast-check';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ARTICLE_TAG,
  CARD_TAG,
  DATA_DIRECTORY,
  MAX_SQL_QUERY_PARAMS,
  SNIPPET_TAG,
} from './constants';
import {
  type Leftover,
  actionsFor,
  findLeftovers,
  leftoversMessage,
  resolveLeftover,
} from './crash-leftovers';
import { ObsidianHelpers as Obsidian } from './ObsidianHelpers';
import type { NoteType } from './types';

// #region HELPERS

const TAG_OF: Record<NoteType, string> = {
  article: ARTICLE_TAG,
  snippet: SNIPPET_TAG,
  card: CARD_TAG,
};
const TABLE_OF: Record<NoteType, string> = {
  article: 'article',
  snippet: 'snippet',
  card: 'srs_card',
};

/**
 * Where a note may be: the data folder, each type's folder in it, a folder
 * nested in one of those, a folder named like either but beside it or outside
 * the data folder, and the vault's root.
 */
const FOLDERS = [
  `${DATA_DIRECTORY}/`,
  ...(['article', 'snippet', 'card'] as const).map(
    (type) => `${Obsidian.getDirectory(type)}/`
  ),
  `${Obsidian.getDirectory('article')}/nested/`,
  `${Obsidian.getDirectory('snippet')}-old/`,
  `${DATA_DIRECTORY}-old/`,
  `${DATA_DIRECTORY}-old/cards/`,
  'cards/',
  '',
];

/**
 * The type a note in each of {@link FOLDERS} was made as, by the folder it is
 * in, spelled out; any other folder names none.
 */
const FOLDER_TYPES: ReadonlyMap<string, NoteType> = new Map<string, NoteType>([
  [`${Obsidian.getDirectory('article')}/`, 'article'],
  [`${Obsidian.getDirectory('snippet')}/`, 'snippet'],
  [`${Obsidian.getDirectory('card')}/`, 'card'],
  [`${Obsidian.getDirectory('article')}/nested/`, 'article'],
]);

/** The type a note in `folder` was made as, by the folder it is in. */
const typeOfFolder = (folder: string): NoteType | null =>
  FOLDER_TYPES.get(folder) ?? null;

/** A note in the vault, an item's or not, with a row behind it or not. */
const noteArb = fc.record({
  type: fc.constantFrom<NoteType | null>('article', 'snippet', 'card', null),
  id: fc.option(
    fc.oneof(
      fc.uuid(),
      fc.string(),
      fc.integer(),
      fc.double(),
      fc.boolean(),
      fc.array(fc.string(), { maxLength: 2 })
    ),
    { nil: undefined }
  ),
  hasRow: fc.boolean(),
  /** The table holding the row: any, as an id is held wherever it is. */
  rowType: fc.constantFrom<NoteType>('article', 'snippet', 'card'),
  deletedRow: fc.boolean(),
  folder: fc.constantFrom(...FOLDERS),
  tagsAsString: fc.boolean(),
  /** Another item type's tag too, which `typeOfTags` ranks against it. */
  secondTag: fc.option(
    fc.constantFrom<NoteType>('article', 'snippet', 'card'),
    {
      nil: null,
    }
  ),
});
type NoteCase = typeof noteArb extends fc.Arbitrary<infer T> ? T : never;

const pathOf = (note: NoteCase, i: number) => `${note.folder}notes/n${i}.md`;

/** The type a note's tags name, as `typeOfTags` ranks them. */
const typeOf = (note: NoteCase): NoteType | null =>
  note.type && Obsidian.typeOfTags(tagsOf(note));

function tagsOf(note: NoteCase): string | string[] | undefined {
  if (!note.type) return undefined;
  if (note.tagsAsString) return TAG_OF[note.type];
  return [
    'other',
    TAG_OF[note.type],
    ...(note.secondTag ? [TAG_OF[note.secondTag]] : []),
  ];
}

/** Insert a row of `type`'s table with `id` at `reference`. */
function insertRow(
  repo: TestRepository,
  type: NoteType,
  id: string,
  reference: string,
  deleted = false
) {
  if (type === 'card') {
    repo.mutate(
      `INSERT INTO srs_card (id, reference, created_at, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, deleted) VALUES ($1, $2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, $3)`,
      [id, reference, Number(deleted)]
    );
  } else {
    repo.mutate(
      `INSERT INTO ${type} (id, reference, due, interval, priority, deleted) VALUES ($1, $2, 0, 1, 30, $3)`,
      [id, reference, Number(deleted)]
    );
  }
}

/**
 * One database for every case of a property, emptied by {@link wireNotes}:
 * starting sql.js afresh for each case would take most of the test's time.
 */
let sharedRepo: TestRepository;

/** Empty every item table of {@link sharedRepo}. */
function resetSharedRepo(): TestRepository {
  for (const table of Object.values(TABLE_OF)) {
    sharedRepo.mutate(`DELETE FROM ${table}`);
  }
  return sharedRepo;
}

/** A vault and database holding `notes`, and managers over them. */
async function wireNotes(notes: NoteCase[]) {
  const vault = makeItemVault(
    Object.fromEntries(
      notes.map((note, i) => [
        pathOf(note, i),
        {
          ...(note.id === undefined ? {} : { 'ir-id': note.id }),
          ...(note.type ? { tags: tagsOf(note) } : {}),
        },
      ])
    )
  );
  const repo = resetSharedRepo();
  const inserted = new Set<string>();
  for (const [i, note] of notes.entries()) {
    if (note.hasRow && typeof note.id === 'string' && !inserted.has(note.id)) {
      // Under another path, and maybe another table: the row holds the id
      // wherever its note is
      insertRow(
        repo,
        note.rowType,
        note.id,
        `elsewhere/${i}.md`,
        note.deletedRow
      );
      inserted.add(note.id);
    }
  }
  const plugin = { app: vault.app, settings: {} } as never;
  const managers = {
    articles: new ArticleManager(plugin, repo),
    snippets: new SnippetManager(plugin, repo),
    cards: new CardManager(plugin, repo),
  };
  vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
  vi.spyOn(console, 'error').mockReturnValue(undefined);
  const deps = { app: vault.app as never, repo, ...managers };
  return { vault, repo, managers, deps };
}

/**
 * One leftover note at `path`, holding `id`, and tagged as `type`, or, with
 * `null`, tagged with no item type at all; or with `tags` as given.
 */
async function wireLeftover(
  type: NoteType | null,
  path: string,
  id = 'left-1',
  { tags = type ? ['other', TAG_OF[type]] : ['other'] }: { tags?: unknown } = {}
) {
  const vault = makeItemVault({
    [path]: { 'ir-id': id, tags, title: 'kept' },
  });
  const repo = await TestRepository.create();
  const plugin = { app: vault.app, settings: {} } as never;
  const notify = vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
  vi.spyOn(console, 'error').mockReturnValue(undefined);
  const deps = {
    app: vault.app as never,
    repo,
    articles: new ArticleManager(plugin, repo),
    snippets: new SnippetManager(plugin, repo),
    cards: new CardManager(plugin, repo),
  };
  const [leftover] = await findLeftovers(deps);
  return { vault, repo, deps, leftover, notify };
}

const typeArb = fc.constantFrom<NoteType>('article', 'snippet', 'card');

// #endregion

beforeAll(async () => {
  sharedRepo = await TestRepository.create();
});

describe('findLeftovers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('finds every note whose ir-id no row holds, deleted or not, tagged as an item or not, and no other', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(noteArb, { maxLength: 8 }), async (notes) => {
        vi.restoreAllMocks();
        const { deps } = await wireNotes(notes);

        const found = await findLeftovers(deps);

        const held = new Set(
          notes.flatMap((note) =>
            note.hasRow && typeof note.id === 'string' ? [note.id] : []
          )
        );
        const expected = notes.flatMap((note, i) =>
          typeof note.id === 'string' && !held.has(note.id)
            ? [{ path: pathOf(note, i), id: note.id }]
            : []
        );
        expect(found.map(({ file, id }) => ({ path: file.path, id }))).toEqual(
          expected
        );
      }),
      { numRuns: 60 }
    );
  });

  it("types a leftover by its tag, else by the data folder's subfolder it was made in, else not at all", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(noteArb, { maxLength: 8 }), async (notes) => {
        vi.restoreAllMocks();
        const rowless = notes.map((note) => ({ ...note, hasRow: false }));
        const { deps } = await wireNotes(rowless);

        const found = await findLeftovers(deps);

        const expected = rowless.flatMap((note) =>
          typeof note.id === 'string'
            ? [typeOf(note) ?? typeOfFolder(note.folder)]
            : []
        );
        expect(found.map(({ type }) => type)).toEqual(expected);
      }),
      { numRuns: 60 }
    );
  });

  it('asks about more ids than one query can hold', async () => {
    const notes = Array.from(
      { length: MAX_SQL_QUERY_PARAMS + 3 },
      (): NoteCase => ({
        type: 'snippet',
        id: undefined,
        hasRow: false,
        deletedRow: false,
        folder: `${DATA_DIRECTORY}/`,
        tagsAsString: false,
        secondTag: null,
        rowType: 'snippet',
      })
    ).map((note, i) => ({ ...note, id: `id-${i}`, hasRow: i % 2 === 0 }));
    const { deps } = await wireNotes(notes);

    const found = await findLeftovers(deps);

    expect(found).toHaveLength(Math.floor(notes.length / 2));
  });

  // Every type, or none, in every folder: few enough to try them all
  it.each(
    (['article', 'snippet', 'card', null] as const).flatMap((type) =>
      FOLDERS.map((folder) => ({ type, folder }))
    )
  )(
    "calls a $type leftover in '$folder' the plugin's own only if it is in the data folder, or is a tagged snippet or card, and types it by its tag, else by its folder there",
    async ({ type, folder }) => {
      const { deps } = await wireNotes([
        {
          type,
          id: 'left-1',
          hasRow: false,
          rowType: 'article',
          deletedRow: false,
          folder,
          tagsAsString: false,
          secondTag: null,
        },
      ]);

      const [leftover] = await findLeftovers(deps);

      const inDataFolder = folder.startsWith(`${DATA_DIRECTORY}/`);
      expect(leftover.kind).toBe(
        inDataFolder || type === 'snippet' || type === 'card'
          ? 'made'
          : 'in-place'
      );
      expect(leftover.type).toBe(type ?? typeOfFolder(folder));
    }
  );
});

describe('actionsFor', () => {
  it.each([
    { type: 'article', kind: 'made', actions: ['adopt', 'trash'] },
    { type: 'article', kind: 'in-place', actions: ['adopt', 'strip'] },
    { type: 'snippet', kind: 'made', actions: ['adopt', 'trash'] },
    { type: 'card', kind: 'in-place', actions: ['adopt', 'strip'] },
    // No type of its own, but the user picks one to save it as; one the
    // plugin made can still be kept as a plain note too
    { type: null, kind: 'made', actions: ['adopt', 'strip', 'trash'] },
    { type: null, kind: 'in-place', actions: ['adopt', 'strip'] },
  ] as const)(
    'offers $actions for a $kind leftover of type $type',
    ({ type, kind, actions }) => {
      const leftover = { file: {}, id: 'x', type, kind } as Leftover;

      expect(actionsFor(leftover)).toEqual(actions);
    }
  );
});

describe('leftoversMessage', () => {
  it('counts the leftover notes, without naming any', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1 }), { minLength: 2, maxLength: 50 }),
        (names) => {
          const leftovers = names.map(
            (basename) => ({ file: { basename } }) as unknown as Leftover
          );

          expect(leftoversMessage(leftovers)).toBe(
            `Incremental reading: ${names.length} notes were not found in the database.`
          );
        }
      )
    );
  });

  it('speaks of a lone leftover in the singular', () => {
    const leftovers = [{ file: { basename: 'a' } }] as unknown as Leftover[];

    expect(leftoversMessage(leftovers)).toBe(
      'Incremental reading: 1 note was not found in the database.'
    );
  });
});

describe('resolveLeftover', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adopts a leftover as a new item with its id, at its path', async () => {
    await fc.assert(
      fc.asyncProperty(typeArb, async (type) => {
        vi.restoreAllMocks();
        const path = `${DATA_DIRECTORY}/x/a.md`;
        const { vault, repo, deps, leftover } = await wireLeftover(type, path);

        expect(await resolveLeftover(deps, leftover, 'adopt')).toBe(true);

        const rows = repo.rows(TABLE_OF[type]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: 'left-1', reference: path });
        expect(await findLeftovers(deps)).toEqual([]);
        expect(vault.frontmatterOf(path)).toEqual({
          'ir-id': 'left-1',
          tags: ['other', TAG_OF[type]],
          title: 'kept',
        });
      }),
      { numRuns: 6 }
    );
  });

  it('adopts a snippet or card as a child of the item its source links to', async () => {
    for (const type of ['snippet', 'card'] as const) {
      vi.restoreAllMocks();
      const path = `${DATA_DIRECTORY}/x/a.md`;
      const { vault, repo, deps, leftover } = await wireLeftover(type, path);
      vault.add('notes/parent.md', {
        'ir-id': 'parent-1',
        tags: [ARTICLE_TAG],
      });
      insertRow(repo, 'article', 'parent-1', 'notes/parent.md');
      vi.spyOn(Obsidian, 'getSourceFile').mockReturnValue(
        vault.files.get('notes/parent.md')!
      );

      await resolveLeftover(deps, leftover, 'adopt');

      expect(repo.rows(TABLE_OF[type])[0].parent).toBe('parent-1');
    }
  });

  it('trashes a leftover the plugin made, leaving no row', async () => {
    const { vault, repo, deps, leftover } = await wireLeftover(
      'snippet',
      `${DATA_DIRECTORY}/x/a.md`
    );

    expect(await resolveLeftover(deps, leftover, 'trash')).toBe(true);

    expect(vault.trashed).toEqual([`${DATA_DIRECTORY}/x/a.md`]);
    expect(repo.rows('snippet')).toEqual([]);
  });

  it("strips the plugin's ir-id and type tag from an imported note, leaving the rest", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string(), { maxLength: 3 }),
        fc.dictionary(
          fc.string().filter((k) => k !== 'ir-id' && k !== 'tags'),
          fc.string(),
          { maxKeys: 3 }
        ),
        fc.boolean(),
        async (otherTags, properties, asString) => {
          vi.restoreAllMocks();
          const path = 'notes/a.md';
          const tags = asString
            ? ARTICLE_TAG
            : [...otherTags.filter((t) => t !== ARTICLE_TAG), ARTICLE_TAG];
          const vault = makeItemVault({
            [path]: { ...properties, 'ir-id': 'left-1', tags },
          });
          const repo = await TestRepository.create();
          const plugin = { app: vault.app, settings: {} } as never;
          const deps = {
            app: vault.app as never,
            repo,
            articles: new ArticleManager(plugin, repo),
            snippets: new SnippetManager(plugin, repo),
            cards: new CardManager(plugin, repo),
          };
          const [leftover] = await findLeftovers(deps);

          expect(await resolveLeftover(deps, leftover, 'strip')).toBe(true);

          const kept = asString ? [] : tags.slice(0, -1);
          expect(vault.frontmatterOf(path)).toEqual({
            ...properties,
            ...(kept.length > 0 ? { tags: kept } : {}),
          });
          expect(await findLeftovers(deps)).toEqual([]);
        }
      ),
      { numRuns: 40 }
    );
  });

  // Without its tag the note wouldn't read as an item (`getNoteType`)
  it('adopts a leftover with no type tag as the type of the folder it was made in, tagging it so', async () => {
    for (const type of ['article', 'snippet', 'card'] as const) {
      vi.restoreAllMocks();
      const path = `${Obsidian.getDirectory(type)}/a.md`;
      const { vault, repo, deps, leftover } = await wireLeftover(null, path);

      expect(await resolveLeftover(deps, leftover, 'adopt')).toBe(true);

      expect(repo.rows(TABLE_OF[type])).toMatchObject([
        { id: 'left-1', reference: path },
      ]);
      expect(vault.frontmatterOf(path)).toEqual({
        'ir-id': 'left-1',
        tags: ['other', TAG_OF[type]],
        title: 'kept',
      });
    }
  });

  // A card needs more than a note to be one, so the modal offers only these
  it.each(
    (['article', 'snippet', 'card', 'cards folder'] as const).flatMap((from) =>
      (['article', 'snippet'] as const).map((as) => [from, as] as const)
    )
  )(
    'adopts a leftover typed as %s as the %s the user chose, its item tag replaced',
    async (from, as) => {
      const path =
        from === 'cards folder'
          ? `${Obsidian.getDirectory('card')}/a.md`
          : `${DATA_DIRECTORY}/x/a.md`;
      const { vault, repo, deps, leftover } = await wireLeftover(
        from === 'cards folder' ? null : from,
        path
      );

      expect(await resolveLeftover(deps, leftover, 'adopt', as)).toBe(true);

      for (const type of Object.keys(TABLE_OF) as NoteType[]) {
        expect(repo.rows(TABLE_OF[type])).toMatchObject(
          type === as ? [{ id: 'left-1', reference: path }] : []
        );
      }
      expect(vault.frontmatterOf(path)).toEqual({
        'ir-id': 'left-1',
        tags: ['other', TAG_OF[as]],
        title: 'kept',
      });
    }
  );

  it.each<[string, unknown, NoteType, unknown]>([
    // Only the order would tell a rewrite apart
    ['already has', [ARTICLE_TAG, 'other'], 'article', null],
    [
      'has with another type',
      ['other', ARTICLE_TAG, SNIPPET_TAG],
      'snippet',
      ['other', SNIPPET_TAG],
    ],
    ["can't read as tags", 7, 'snippet', [7, SNIPPET_TAG]],
    [
      'has with another type, in a lone string,',
      `other ${CARD_TAG}`,
      'snippet',
      ['other', SNIPPET_TAG],
    ],
    ['has no tags, so lacks,', null, 'article', [ARTICLE_TAG]],
  ])(
    'tags a note adopted as a type whose tag it %s just as needed',
    async (_, tags, as, written) => {
      const path = `${Obsidian.getDirectory('snippet')}/a.md`;
      const { vault, deps, leftover } = await wireLeftover(
        null,
        path,
        'left-1',
        { tags }
      );
      const update = vi.spyOn(Obsidian, 'updateFrontMatter');

      expect(await resolveLeftover(deps, leftover, 'adopt', as)).toBe(true);

      expect(update).toHaveBeenCalledTimes(written === null ? 0 : 1);
      expect(vault.frontmatterOf(path)?.tags).toEqual(written ?? tags);
    }
  );

  it.each(['article', 'snippet'] as const)(
    'adopts a leftover of no known type as the %s the user chose, tagging it so',
    async (as) => {
      const path = 'notes/a.md';
      const { vault, repo, deps, leftover } = await wireLeftover(null, path);

      expect(await resolveLeftover(deps, leftover, 'adopt', as)).toBe(true);

      for (const type of Object.keys(TABLE_OF) as NoteType[]) {
        expect(repo.rows(TABLE_OF[type])).toMatchObject(
          type === as ? [{ id: 'left-1', reference: path }] : []
        );
      }
      expect(vault.frontmatterOf(path)).toEqual({
        'ir-id': 'left-1',
        tags: ['other', TAG_OF[as]],
        title: 'kept',
      });
    }
  );

  it('adopts nothing, and does nothing to the note, when its type is unknown and none is chosen', async () => {
    const path = 'notes/a.md';
    const { vault, repo, deps, leftover, notify } = await wireLeftover(
      null,
      path
    );

    expect(await resolveLeftover(deps, leftover, 'adopt')).toBe(false);

    for (const table of Object.values(TABLE_OF)) {
      expect(repo.rows(table)).toEqual([]);
    }
    expect(vault.frontmatterOf(path)?.['ir-id']).toBe('left-1');
    expect(notify).not.toHaveBeenCalled();
  });

  it('strips only the ir-id from a note with no type tag, leaving its tags as they were', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(
          fc.oneof(fc.string(), fc.array(fc.string(), { maxLength: 3 })),
          { nil: undefined }
        ),
        fc.constantFrom(...FOLDERS),
        async (tags, folder) => {
          // Tags naming no item type, or the note would be typed by them
          fc.pre(Obsidian.typeOfTags(tags) === null);
          vi.restoreAllMocks();
          const path = `${folder}a.md`;
          const vault = makeItemVault({
            [path]: {
              'ir-id': 'left-1',
              ...(tags === undefined ? {} : { tags }),
            },
          });
          vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
          const deps = {
            app: vault.app as never,
            repo: resetSharedRepo(),
          } as never;
          const [leftover] = await findLeftovers(deps);

          expect(await resolveLeftover(deps, leftover, 'strip')).toBe(true);

          expect(vault.frontmatterOf(path)).toEqual(
            tags === undefined ? {} : { tags }
          );
        }
      ),
      { numRuns: 40 }
    );
  });

  it('trashes a leftover with no type tag that the plugin made', async () => {
    const path = `${DATA_DIRECTORY}/a.md`;
    const { vault, deps, leftover } = await wireLeftover(null, path);

    expect(await resolveLeftover(deps, leftover, 'trash')).toBe(true);

    expect(vault.trashed).toEqual([path]);
  });

  it('does nothing to a note that is no longer a leftover by the time it is resolved', async () => {
    for (const action of ['adopt', 'trash', 'strip'] as const) {
      vi.restoreAllMocks();
      const path = `${DATA_DIRECTORY}/x/a.md`;
      const { vault, repo, deps, leftover } = await wireLeftover(
        'snippet',
        path
      );
      // A row for it arrived meanwhile, say with the database from Sync
      insertRow(repo, 'snippet', 'left-1', 'elsewhere.md');

      expect(await resolveLeftover(deps, leftover, action)).toBe(false);

      expect(vault.paths()).toEqual([path]);
      expect(vault.frontmatterOf(path)?.['ir-id']).toBe('left-1');
      expect(repo.rows('snippet')).toHaveLength(1);
    }
  });

  it('does nothing to a note deleted, or given another id, since it was found', async () => {
    for (const action of ['adopt', 'trash', 'strip'] as const) {
      for (const change of ['deleted', 'other id'] as const) {
        vi.restoreAllMocks();
        const path = `${DATA_DIRECTORY}/x/a.md`;
        const { vault, repo, deps, leftover } = await wireLeftover(
          'snippet',
          path
        );
        if (change === 'deleted') vault.files.delete(path);
        else {
          await vault.app.fileManager.processFrontMatter(
            leftover.file,
            (fm: Record<string, unknown>) => {
              fm['ir-id'] = 'other';
            }
          );
        }
        const paths = vault.paths();

        expect(await resolveLeftover(deps, leftover, action)).toBe(false);

        expect(vault.paths()).toEqual(paths);
        expect(vault.trashed).toEqual([]);
        expect(repo.rows('snippet')).toEqual([]);
      }
    }
  });

  it('does nothing, and says why, while writes are refused', async () => {
    const { vault, repo, deps, leftover, notify } = await wireLeftover(
      'snippet',
      `${DATA_DIRECTORY}/x/a.md`
    );
    repo.refuseWrites(new Error('Saving is paused.'));

    expect(await resolveLeftover(deps, leftover, 'adopt')).toBe(false);

    expect(repo.rows('snippet')).toEqual([]);
    expect(vault.paths()).toHaveLength(1);
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      `Couldn't keep "a" as an item: saving to the database is paused. Saving is paused.`,
      { kind: 'error' }
    );
  });

  it.each([
    { action: 'trash', doing: 'move "a" to the trash' },
    { action: 'strip', doing: 'remove the IR properties from "a"' },
  ] as const)(
    'names what it could not do, $action, while writes are refused',
    async ({ action, doing }) => {
      const { vault, deps, leftover, notify } = await wireLeftover(
        'article',
        'notes/a.md'
      );
      deps.repo.refuseWrites(new Error('Saving is paused.'));

      expect(await resolveLeftover(deps, leftover, action)).toBe(false);

      expect(vault.trashed).toEqual([]);
      expect(notify).toHaveBeenCalledExactlyOnceWith(
        `Couldn't ${doing}: saving to the database is paused. Saving is paused.`,
        { kind: 'error' }
      );
    }
  );

  it('says so when it fails', async () => {
    const { vault, deps, leftover, notify } = await wireLeftover(
      'snippet',
      `${DATA_DIRECTORY}/x/a.md`
    );
    vault.fail('trash');

    expect(await resolveLeftover(deps, leftover, 'trash')).toBe(false);

    expect(notify).toHaveBeenCalledExactlyOnceWith(
      `Couldn't move "a" to the trash`,
      { kind: 'error' }
    );
  });
});
