import { ArticleManager } from '#/lib/items/ArticleManager';
import { CardManager } from '#/lib/items/CardManager';
import { SnippetManager } from '#/lib/items/SnippetManager';
import { makeItemVault, TestRepository } from '#/test/item-vault';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  deletedRow: fc.boolean(),
  folder: fc.constantFrom(`${DATA_DIRECTORY}/`, `${DATA_DIRECTORY}-old/`, ''),
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
  const repo = await TestRepository.create();
  for (const [i, note] of notes.entries()) {
    const type = typeOf(note);
    if (note.hasRow && typeof note.id === 'string' && type) {
      // Under another path, and maybe another table: the row holds the id
      // wherever its note is
      insertRow(repo, type, note.id, `elsewhere/${i}.md`, note.deletedRow);
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

/** One leftover note of `type` at `path`, holding `id`. */
async function wireLeftover(type: NoteType, path: string, id = 'left-1') {
  const vault = makeItemVault({
    [path]: { 'ir-id': id, tags: ['other', TAG_OF[type]], title: 'kept' },
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

describe('findLeftovers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('finds every note typed as an item whose ir-id no row holds, deleted or not, and no other', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(noteArb, { maxLength: 8 }), async (notes) => {
        vi.restoreAllMocks();
        const { deps } = await wireNotes(notes);

        const found = await findLeftovers(deps);

        // A row's id is unique across what is inserted here only once
        const held = new Set(
          notes.flatMap((note) =>
            note.hasRow && typeof note.id === 'string' && typeOf(note)
              ? [note.id]
              : []
          )
        );
        const expected = notes.flatMap((note, i) => {
          const type = typeOf(note);
          return type && typeof note.id === 'string' && !held.has(note.id)
            ? [{ path: pathOf(note, i), id: note.id, type }]
            : [];
        });
        expect(
          found.map(({ file, id, type }) => ({ path: file.path, id, type }))
        ).toEqual(expected);
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
      })
    ).map((note, i) => ({ ...note, id: `id-${i}`, hasRow: i % 2 === 0 }));
    const { deps } = await wireNotes(notes);

    const found = await findLeftovers(deps);

    expect(found).toHaveLength(Math.floor(notes.length / 2));
  });

  it("calls a leftover article outside the plugin's data folder an import in place, and every other one the plugin's own", async () => {
    await fc.assert(
      fc.asyncProperty(
        typeArb,
        fc.constantFrom(`${DATA_DIRECTORY}/`, `${DATA_DIRECTORY}-old/`, ''),
        async (type, folder) => {
          vi.restoreAllMocks();
          const { deps } = await wireNotes([
            {
              type,
              id: 'left-1',
              hasRow: false,
              deletedRow: false,
              folder,
              tagsAsString: false,
              secondTag: null,
            },
          ]);

          const [leftover] = await findLeftovers(deps);

          expect(leftover.kind).toBe(
            type === 'article' && folder !== `${DATA_DIRECTORY}/`
              ? 'in-place'
              : 'made'
          );
          expect(actionsFor(leftover)).toEqual(
            leftover.kind === 'in-place'
              ? ['adopt', 'strip']
              : ['adopt', 'trash']
          );
        }
      ),
      { numRuns: 18 }
    );
  });
});

describe('leftoversMessage', () => {
  it('names every leftover note, and says what to do', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1 }), {
          minLength: 1,
          maxLength: 5,
        }),
        (names) => {
          const leftovers = names.map(
            (basename) => ({ file: { basename } }) as unknown as Leftover
          );

          const message = leftoversMessage(leftovers);

          const one = names.length === 1;
          expect(message).toMatch(
            new RegExp(
              `^Incremental reading: ${names.length} ${one ? 'note has' : 'notes have'} `
            )
          );
          for (const name of names) expect(message).toContain(`"${name}"`);
          expect(message).toMatch(
            new RegExp(
              `Click to choose what to do with ${one ? 'it' : 'them'}\\.$`
            )
          );
        }
      )
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
        const { repo, deps, leftover } = await wireLeftover(type, path);

        expect(await resolveLeftover(deps, leftover, 'adopt')).toBe(true);

        const rows = repo.rows(TABLE_OF[type]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: 'left-1', reference: path });
        expect(await findLeftovers(deps)).toEqual([]);
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
      `Couldn't keep "a" as an item: saving to the database is paused. Saving is paused.`
    );
  });

  it('says so when it fails', async () => {
    const { vault, deps, leftover, notify } = await wireLeftover(
      'snippet',
      `${DATA_DIRECTORY}/x/a.md`
    );
    vault.fail('trash');

    expect(await resolveLeftover(deps, leftover, 'trash')).toBe(false);

    expect(notify).toHaveBeenCalledExactlyOnceWith(
      `Couldn't move "a" to the trash`
    );
  });
});
