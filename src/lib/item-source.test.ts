import { TestRepository } from '#/test/item-vault';
import { makeLinkVault } from '#/test/link-vault';
import fc from 'fast-check';
import type { App, TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findItemSource,
  findRoot,
  goToSourceTitle,
  hasContext,
  type ItemNode,
  itemNodeAt,
  routeSource,
  type SourceRoute,
} from './item-source';
import type { NoteType } from './types';
import * as webViewer from './web-viewer';

// #region HELPERS
const node = (
  id: string,
  parent: string | null,
  type: NoteType = 'snippet'
): ItemNode => ({ id, type, reference: `ir/${id}.md`, parent });

/** How a line of parents ends above its start. */
type LineEnd = 'root' | 'dangling' | 'deleted' | 'cycle';

/**
 * A line of items, each the parent of the one after it: an article, or an
 * item taken from a note that is no item, at the top, then snippets and
 * cards, the last the item asked about.
 */
type Line = { rootType: NoteType; below: NoteType[]; end: LineEnd };
const lineArb: fc.Arbitrary<Line> = fc.record({
  rootType: fc.constantFrom<NoteType>('article', 'snippet', 'card'),
  below: fc.array(fc.constantFrom<NoteType>('snippet', 'card'), {
    maxLength: 4,
  }),
  end: fc.constantFrom<LineEnd>('root', 'dangling', 'deleted', 'cycle'),
});

/** What the `source` property of the note at the top can hold. */
const SOURCES = {
  none: undefined,
  blank: '  ',
  vault: '[[sources/Book.pdf]]',
  gone: '[[sources/Gone.pdf]]',
  web: 'https://example.com/a page',
  webLink: '[A page](https://example.com/a%20page)',
  other: 'mailto:someone@example.com',
} as const;
type SourceKind = keyof typeof SOURCES;
const sourceKindArb = fc.constantFrom(
  ...(Object.keys(SOURCES) as SourceKind[])
);

/** Where an article's source is, if it is one: what the vault holds. */
const SOURCE_FILE = 'sources/Book.pdf';

/**
 * A database and vault holding `line`: each item's row and note, its note
 * carrying its `ir-id` and, below the top, a `source` link to its parent's
 * note, as the plugin writes them; the top note's `source` is `source`'s.
 * Above a top that is no article, `end` breaks the line: a parent id no row
 * has, a parent's row deleted, or the top's parent the last item's id,
 * closing a circle.
 */
async function makeLine({ rootType, below, end }: Line, source: SourceKind) {
  const repo = await TestRepository.create();
  const types = [rootType, ...below];
  const ids = types.map((_type, i) => `item-${i}`);
  const notes: Record<string, Record<string, unknown> | null> = {
    [SOURCE_FILE]: null,
  };
  const parentOfTop = {
    root: null,
    dangling: 'no-such-item',
    deleted: 'deleted-item',
    cycle: ids.at(-1)!,
  }[end];
  if (end === 'deleted') insert(repo, 'deleted-item', 'article', null, 1);
  types.forEach((type, i) => {
    const parent = i === 0 ? parentOfTop : ids[i - 1];
    insert(repo, ids[i], type, parent);
    const fm: Record<string, unknown> = { 'ir-id': ids[i] };
    if (i > 0) fm.source = `[[ir/${ids[i - 1]}.md]]`;
    else if (SOURCES[source] !== undefined) fm.source = SOURCES[source];
    notes[`ir/${ids[i]}.md`] = fm;
  });
  const vault = makeLinkVault(notes);
  const file = vault.files.get(`ir/${ids.at(-1)}.md`)!;
  return { repo, app: vault.app as unknown as App, vault, file };
}

/** A live (or, with `deleted`, deleted) row of `type` at `ir/<id>.md`. */
function insert(
  repo: TestRepository,
  id: string,
  type: NoteType,
  parent: string | null,
  deleted = 0
) {
  const reference = `ir/${id}.md`;
  if (type === 'article') {
    void repo.mutate(
      `INSERT INTO article (id, reference, due, interval, priority, deleted)
       VALUES ($1, $2, 0, 86400000, 30, $3)`,
      [id, reference, deleted]
    );
  } else if (type === 'snippet') {
    void repo.mutate(
      `INSERT INTO snippet (id, reference, parent, due, interval, priority, deleted)
       VALUES ($1, $2, $3, 0, 86400000, 30, $4)`,
      [id, reference, parent, deleted]
    );
  } else {
    void repo.mutate(
      `INSERT INTO srs_card (id, reference, parent, created_at, due,
         stability, difficulty, elapsed_days, scheduled_days, state, deleted)
       VALUES ($1, $2, $3, 0, 0, 0, 0, 0, 0, 0, $4)`,
      [id, reference, parent, deleted]
    );
  }
}

/** Every way Go to source can open a source. */
const routeArb: fc.Arbitrary<SourceRoute> = fc.oneof(
  fc.constant({ kind: 'file', file: { path: SOURCE_FILE } as TFile }),
  fc.webUrl().map((url) => ({
    kind: 'web-viewer' as const,
    url,
    viewer: { openUrl: vi.fn() },
  })),
  fc.webUrl().map((url) => ({ kind: 'browser' as const, url }))
);
// #endregion

afterEach(() => {
  vi.restoreAllMocks();
});

describe('findRoot', () => {
  it('property: is the top of an unbroken line of parents, asking for each parent once', () => {
    fc.assert(
      fc.property(fc.nat(6), (depth) => {
        const line = Array.from({ length: depth + 1 }, (_, i) =>
          node(`n${i}`, i === depth ? null : `n${i + 1}`)
        );
        const byId = vi.fn(
          (id: string) => line.find((n) => n.id === id) ?? null
        );

        expect(findRoot(line[0], byId)).toBe(line[depth]);
        expect(byId.mock.calls.map(([id]) => id)).toEqual(
          line.slice(1).map((n) => n.id)
        );
      })
    );
  });

  it('property: is nothing for a line that breaks or runs in a circle', () => {
    fc.assert(
      fc.property(fc.nat(6), fc.boolean(), fc.nat(), (depth, breaks, back) => {
        // The top's parent: an id no item has, or one of the line's own
        const line = Array.from({ length: depth + 1 }, (_, i) =>
          node(
            `n${i}`,
            i < depth ? `n${i + 1}` : breaks ? 'gone' : `n${back % (depth + 1)}`
          )
        );
        const byId = vi.fn(
          (id: string) => line.find((n) => n.id === id) ?? null
        );

        expect(findRoot(line[0], byId)).toBeNull();
        // Never round a circle twice
        expect(byId.mock.calls.length).toBeLessThanOrEqual(depth + 1);
      })
    );
  });
});

describe('findItemSource', () => {
  it("property: is what the top item's source names, through any line of snippets and cards, and nothing for a broken line", async () => {
    await fc.assert(
      fc.asyncProperty(lineArb, sourceKindArb, async (line, source) => {
        const { repo, app, vault, file } = await makeLine(line, source);

        const found = findItemSource(repo, app, file);

        // An article has no parent to break the line at
        if (line.end !== 'root' && line.rootType !== 'article') {
          expect(found).toBeNull();
        } else if (source === 'vault') {
          expect(found).toEqual({ file: vault.files.get(SOURCE_FILE) });
        } else if (source === 'web' || source === 'webLink') {
          expect(found).toEqual({ url: 'https://example.com/a%20page' });
        } else {
          expect(found).toBeNull();
        }
      })
    );
  });

  it('is nothing for a note that is no item', async () => {
    const { repo, app, vault } = await makeLine(
      { rootType: 'article', below: [], end: 'root' },
      'web'
    );

    expect(findItemSource(repo, app, vault.files.get(SOURCE_FILE)!)).toBeNull();
  });
});

describe('itemNodeAt', () => {
  it("property: is the item whose note it is, when the note's ir-id names the row at its path, or claims none", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<NoteType>('article', 'snippet', 'card'),
        fc.oneof(
          fc.constant({ claim: 'own' as const }),
          fc.constant({ claim: 'none' as const }),
          fc.constant({ claim: 'other' as const }),
          fc
            .oneof(fc.integer(), fc.boolean(), fc.array(fc.string()))
            .filter(Boolean)
            .map((id) => ({ claim: 'odd' as const, id }))
        ),
        async (type, claim) => {
          const repo = await TestRepository.create();
          insert(repo, 'item-0', type, type === 'article' ? null : 'p');
          const fm = {
            own: { 'ir-id': 'item-0' },
            none: {},
            other: { 'ir-id': 'item-1' },
            odd: { 'ir-id': 'id' in claim ? claim.id : null },
          }[claim.claim];
          const vault = makeLinkVault({ 'ir/item-0.md': fm });
          const file = vault.files.get('ir/item-0.md')!;

          const found = itemNodeAt(repo, vault.app as unknown as App, file);

          expect(found).toEqual(
            claim.claim === 'own' || claim.claim === 'none'
              ? {
                  id: 'item-0',
                  type,
                  reference: 'ir/item-0.md',
                  parent: type === 'article' ? null : 'p',
                }
              : null
          );
        }
      )
    );
  });

  it('is nothing for a deleted row', async () => {
    const repo = await TestRepository.create();
    insert(repo, 'item-0', 'snippet', null, 1);
    const vault = makeLinkVault({ 'ir/item-0.md': { 'ir-id': 'item-0' } });

    expect(
      itemNodeAt(
        repo,
        vault.app as unknown as App,
        vault.files.get('ir/item-0.md')!
      )
    ).toBeNull();
  });

  it('is nothing when the database cannot answer at once', () => {
    const repo = {
      query: vi.fn(() => Promise.resolve([])),
    } as unknown as TestRepository;
    const vault = makeLinkVault({ 'ir/item-0.md': { 'ir-id': 'item-0' } });

    expect(
      itemNodeAt(
        repo,
        vault.app as unknown as App,
        vault.files.get('ir/item-0.md')!
      )
    ).toBeNull();
  });
});

describe('hasContext', () => {
  it('property: is true of a snippet or card whose parent is there, or with a source note in the vault, and never of an article', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<NoteType>('article', 'snippet', 'card'),
        fc.constantFrom('none', 'there', 'dangling', 'deleted', 'noteless'),
        fc.constantFrom<SourceKind>('none', 'vault', 'gone', 'web'),
        async (type, parentKind, source) => {
          const repo = await TestRepository.create();
          const withParent = type !== 'article' && parentKind !== 'none';
          insert(repo, 'item-0', type, withParent ? 'parent' : null);
          if (withParent && parentKind !== 'dangling') {
            insert(
              repo,
              'parent',
              'article',
              null,
              +(parentKind === 'deleted')
            );
          }
          const fm: Record<string, unknown> = { 'ir-id': 'item-0' };
          if (SOURCES[source] !== undefined) fm.source = SOURCES[source];
          const notes: Record<string, Record<string, unknown> | null> = {
            'ir/item-0.md': fm,
            [SOURCE_FILE]: null,
          };
          if (parentKind !== 'noteless') notes['ir/parent.md'] = {};
          const vault = makeLinkVault(notes);
          const file = vault.files.get('ir/item-0.md')!;

          expect(hasContext(repo, vault.app as unknown as App, file)).toBe(
            type !== 'article' &&
              ((withParent && parentKind === 'there') || source === 'vault')
          );
        }
      )
    );
  });

  it('is false of a note that is no item', async () => {
    const repo = await TestRepository.create();
    const vault = makeLinkVault({ 'notes/a.md': { source: SOURCES.vault } });

    expect(
      hasContext(
        repo,
        vault.app as unknown as App,
        vault.files.get('notes/a.md')!
      )
    ).toBe(false);
  });
});

describe('routeSource', () => {
  it('property: opens a vault file as a file, and a web page in the web viewer exactly when it opens links, else the system browser', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant({ file: { path: SOURCE_FILE } as TFile }),
          fc.webUrl().map((url) => ({ url }))
        ),
        fc.boolean(),
        (source, opensLinks) => {
          vi.restoreAllMocks();
          const viewer = { openUrl: vi.fn() };
          const app = {} as App;
          const link = vi
            .spyOn(webViewer, 'linkWebViewer')
            .mockReturnValue(opensLinks ? viewer : null);

          const route = routeSource(app, source);

          if ('file' in source) {
            expect(route).toEqual({ kind: 'file', file: source.file });
            return;
          }
          expect(link).toHaveBeenCalledWith(app);
          expect(route).toEqual(
            opensLinks
              ? { kind: 'web-viewer', url: source.url, viewer }
              : { kind: 'browser', url: source.url }
          );
        }
      )
    );
  });
});

describe('goToSourceTitle', () => {
  it('property: says the system browser exactly when the route leaves the app', () => {
    fc.assert(
      fc.property(routeArb, (route) => {
        const title = goToSourceTitle(route);

        if (route.kind === 'browser') {
          expect(title).toMatch(/in system browser$/);
        } else {
          expect(title).not.toMatch(/browser/);
        }
      })
    );
  });
});
