import {
  backlinkRange,
  findArticleSource,
  findContextFile,
  highlightRange,
  resolveItemContext,
} from '#/lib/item-context';
import type ReviewManager from '#/lib/items/ReviewManager';
import { ObsidianHelpers } from '#/lib/ObsidianHelpers';
import type {
  ReviewArticle,
  ReviewCard,
  ReviewItem,
  ReviewSnippet,
} from '#/lib/types';
import fc from 'fast-check';
import type { App, CachedMetadata, ReferenceCache, TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

// #region HELPERS

function makeTFile(path: string): TFile {
  const name = path.split('/').pop()!;
  return {
    path,
    name,
    basename: name.replace(/\.md$/, ''),
    extension: 'md',
  } as unknown as TFile;
}

const CONTEXT_PATH = 'notes/Context.md';
const CARD_PATH = 'ir/cards/Card.md';
const OTHER_PATH = 'notes/Other.md';

function makeSnippet({
  parent = null,
  start_offset = null,
  end_offset = null,
}: {
  parent?: string | null;
  start_offset?: number | null;
  end_offset?: number | null;
} = {}): ReviewSnippet {
  return {
    data: {
      id: 'snippet-1',
      type: 'snippet',
      parent,
      start_offset,
      end_offset,
    },
    file: makeTFile('ir/snippets/Snippet.md'),
  } as unknown as ReviewSnippet;
}

function makeCard(parent: string | null = null): ReviewCard {
  return {
    data: { id: 'card-1', type: 'card', parent },
    file: makeTFile(CARD_PATH),
  } as unknown as ReviewCard;
}

function makeReviewManager(parentItem: ReviewItem | null) {
  return {
    getReviewItemFromId: vi.fn().mockResolvedValue(parentItem),
  } as unknown as ReviewManager & {
    getReviewItemFromId: ReturnType<typeof vi.fn>;
  };
}

/**
 * An app whose metadata cache holds `fileCache` for every note, and resolves
 * each link text in `resolutions` to its path — but only when asked from the
 * context note, so a lookup made relative to the wrong note resolves nowhere.
 */
function makeApp({
  fileCache = null,
  resolutions = {},
  content = '',
}: {
  fileCache?: CachedMetadata | null;
  resolutions?: Record<string, string>;
  content?: string;
} = {}) {
  return {
    vault: { cachedRead: vi.fn().mockResolvedValue(content) },
    metadataCache: {
      getFileCache: vi.fn().mockReturnValue(fileCache),
      getFirstLinkpathDest: vi.fn((link: string, sourcePath: string) => {
        if (sourcePath !== CONTEXT_PATH) return null;
        const path = resolutions[link];
        return path ? makeTFile(path) : null;
      }),
    },
  } as unknown as App & {
    vault: { cachedRead: ReturnType<typeof vi.fn> };
    metadataCache: { getFileCache: ReturnType<typeof vi.fn> };
  };
}

function makeRef(link: string, start: number, length: number): ReferenceCache {
  return {
    link,
    original: `[[${link}]]`,
    position: {
      start: { line: 0, col: start, offset: start },
      end: { line: 0, col: start + length, offset: start + length },
    },
  };
}

/** Link texts: one that reaches the card, one another note, one nothing. */
const LINK_TEXTS = { card: 'Card', other: 'Other', dangling: 'Missing' };
const RESOLUTIONS = {
  [LINK_TEXTS.card]: CARD_PATH,
  [LINK_TEXTS.other]: OTHER_PATH,
};

/**
 * References as a note could hold them: each at its own start offset, split
 * between links and embeds, either list possibly absent.
 */
const referencesArb = fc
  .uniqueArray(
    fc.record({
      start: fc.nat({ max: 10_000 }),
      length: fc.integer({ min: 1, max: 200 }),
      link: fc.constantFrom(...Object.values(LINK_TEXTS)),
      embed: fc.boolean(),
    }),
    { selector: (r) => r.start, maxLength: 12 }
  )
  .chain((refs) =>
    fc.record({
      refs: fc.constant(refs),
      omitEmbeds: fc.boolean(),
      omitLinks: fc.boolean(),
    })
  )
  .map(({ refs, omitEmbeds, omitLinks }) => {
    const embeds = refs
      .filter((r) => r.embed)
      .map((r) => makeRef(r.link, r.start, r.length));
    const links = refs
      .filter((r) => !r.embed)
      .map((r) => makeRef(r.link, r.start, r.length));
    const fileCache: CachedMetadata = {};
    if (!(omitEmbeds && embeds.length === 0)) fileCache.embeds = embeds;
    if (!(omitLinks && links.length === 0)) fileCache.links = links;
    return { fileCache, refs: [...embeds, ...links] };
  });

/** A note split into frontmatter and body the way the plugin parses it. */
const noteArb = fc
  .record({
    frontmatter: fc.option(
      fc.string({ unit: fc.constantFrom('a', ':', ' ', '-', '\n') }),
      { nil: null }
    ),
    body: fc.string({ unit: fc.constantFrom('a', 'b', ' ', '-', '\n', '[') }),
  })
  .map(({ frontmatter, body }) => {
    const prefix = frontmatter === null ? '' : `---\n${frontmatter}\n---\n`;
    return { prefix, body, content: prefix + body };
  })
  .filter(
    ({ prefix, content }) =>
      ObsidianHelpers.getBodyStartOffset(content) === prefix.length
  );

/** An offset as the database may hold it: unset, in the body, or off it. */
const offsetArb = (bodyLength: number) =>
  fc.option(
    fc.oneof(
      fc.integer({ min: -3, max: bodyLength + 3 }),
      fc.integer({ min: -2_000_000, max: 2_000_000 })
    ),
    { nil: null }
  );

/**
 * A note and a snippet's offsets into its body. Half the cases are a range
 * inside the body, which independent offsets would rarely land on.
 */
const highlightCaseArb = noteArb.chain((note) =>
  fc.record({
    note: fc.constant(note),
    offsets: fc.oneof(
      fc
        .tuple(
          fc.nat({ max: note.body.length }),
          fc.nat({ max: note.body.length })
        )
        .map(([a, b]) => ({ start: Math.min(a, b), end: Math.max(a, b) })),
      fc.record({
        start: offsetArb(note.body.length),
        end: offsetArb(note.body.length),
      })
    ),
  })
);

// #endregion

afterEach(() => {
  vi.restoreAllMocks();
});

describe('findContextFile', () => {
  it("is the parent's note when the parent exists, else the source note", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('snippet', 'card'),
        fc.option(fc.string(), { nil: null }),
        fc.boolean(),
        fc.boolean(),
        async (type, parent, parentExists, sourceExists) => {
          vi.restoreAllMocks();
          const parentFile = makeTFile('notes/Parent.md');
          const sourceFile = makeTFile('notes/Source.md');
          const reviewManager = makeReviewManager(
            parentExists
              ? ({ data: { id: parent }, file: parentFile } as ReviewItem)
              : null
          );
          const getSourceFile = vi
            .spyOn(ObsidianHelpers, 'getSourceFile')
            .mockReturnValue(sourceExists ? sourceFile : null);
          const item =
            type === 'snippet' ? makeSnippet({ parent }) : makeCard(parent);
          const app = makeApp();

          const result = await findContextFile(app, reviewManager, item);

          const hasParent = Boolean(parent) && parentExists;
          const expected = hasParent
            ? parentFile
            : sourceExists
              ? sourceFile
              : null;
          expect(result).toBe(expected);
          if (parent) {
            expect(reviewManager.getReviewItemFromId).toHaveBeenCalledWith(
              parent
            );
          } else {
            expect(reviewManager.getReviewItemFromId).not.toHaveBeenCalled();
          }
          if (!hasParent) {
            expect(getSourceFile).toHaveBeenCalledWith(item.file, app);
          }
        }
      )
    );
  });
});

describe('highlightRange', () => {
  it('maps valid body offsets to the same text in the full note, and rejects the rest', () => {
    fc.assert(
      fc.property(highlightCaseArb, ({ note, offsets: { start, end } }) => {
        const snippet = makeSnippet({
          start_offset: start,
          end_offset: end,
        });

        const range = highlightRange(snippet, note.content);

        const valid =
          start !== null &&
          end !== null &&
          start >= 0 &&
          start < end &&
          end <= note.body.length;
        if (!valid) {
          expect(range).toBeNull();
          return;
        }
        expect(range).toEqual([
          note.prefix.length + start,
          note.prefix.length + end,
        ]);
        expect(note.content.slice(...range!)).toBe(note.body.slice(start, end));
      })
    );
  });

  it('accepts a highlight that ends exactly at the end of the note', () => {
    const snippet = makeSnippet({ start_offset: 0, end_offset: 3 });

    expect(highlightRange(snippet, '---\nk: v\n---\nabc')).toEqual([13, 16]);
  });
});

describe('backlinkRange', () => {
  it('is the earliest link or embed in the note that resolves to the card', () => {
    fc.assert(
      fc.property(referencesArb, ({ fileCache, refs }) => {
        const app = makeApp({ fileCache, resolutions: RESOLUTIONS });

        const range = backlinkRange(app, makeTFile(CONTEXT_PATH), makeCard());

        const toCard = refs
          .filter((r) => r.link === LINK_TEXTS.card)
          .sort((a, b) => a.position.start.offset - b.position.start.offset);
        if (toCard.length === 0) {
          expect(range).toBeNull();
          return;
        }
        expect(range).toEqual([
          toCard[0].position.start.offset,
          toCard[0].position.end.offset,
        ]);
      })
    );
  });

  it('is null when the note has no metadata cached', () => {
    const app = makeApp({ fileCache: null, resolutions: RESOLUTIONS });

    expect(backlinkRange(app, makeTFile(CONTEXT_PATH), makeCard())).toBeNull();
  });
});

describe('resolveItemContext', () => {
  it('is null, reading nothing, when the item has no context note', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('snippet', 'card'), async (type) => {
        vi.restoreAllMocks();
        vi.spyOn(ObsidianHelpers, 'getSourceFile').mockReturnValue(null);
        const app = makeApp();
        const item = type === 'snippet' ? makeSnippet() : makeCard();

        const context = await resolveItemContext(
          app,
          makeReviewManager(null),
          item
        );

        expect(context).toBeNull();
        expect(app.vault.cachedRead).not.toHaveBeenCalled();
      })
    );
  });

  it("points a snippet at its highlight in the context note's text, when it has one", async () => {
    await fc.assert(
      fc.asyncProperty(
        highlightCaseArb,
        async ({ note, offsets: { start, end } }) => {
          vi.restoreAllMocks();
          const contextFile = makeTFile(CONTEXT_PATH);
          vi.spyOn(ObsidianHelpers, 'getSourceFile').mockReturnValue(
            contextFile
          );
          const app = makeApp({ content: note.content });
          const snippet = makeSnippet({
            start_offset: start,
            end_offset: end,
          });

          const context = await resolveItemContext(
            app,
            makeReviewManager(null),
            snippet
          );

          const range = highlightRange(snippet, note.content);
          expect(context).toEqual({
            file: contextFile,
            eState: range
              ? { match: { content: note.content, matches: [range] } }
              : null,
          });
          expect(app.vault.cachedRead).toHaveBeenCalledWith(contextFile);
        }
      )
    );
  });

  it('points a card at the link to it in the context note, when there is one', async () => {
    await fc.assert(
      fc.asyncProperty(
        referencesArb,
        fc.string(),
        async ({ fileCache }, content) => {
          vi.restoreAllMocks();
          const contextFile = makeTFile(CONTEXT_PATH);
          const parent = {
            data: { id: 'article-1' },
            file: contextFile,
          } as ReviewItem;
          const app = makeApp({
            fileCache,
            resolutions: RESOLUTIONS,
            content,
          });
          const card = makeCard('article-1');

          const context = await resolveItemContext(
            app,
            makeReviewManager(parent),
            card
          );

          const range = backlinkRange(app, contextFile, card);
          expect(context).toEqual({
            file: contextFile,
            eState: range ? { match: { content, matches: [range] } } : null,
          });
          expect(app.metadataCache.getFileCache).toHaveBeenCalledWith(
            contextFile
          );
        }
      )
    );
  });
});

describe('findArticleSource', () => {
  it('is the vault file the source names, else why there is none', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(undefined),
          fc.string({ unit: fc.constantFrom(' ', '\t', '\n') }),
          fc.string(),
          fc.integer(),
          fc.array(fc.string(), { maxLength: 2 })
        ),
        fc.boolean(),
        (source, resolves) => {
          vi.restoreAllMocks();
          const article = {
            data: { id: 'article-1', type: 'article' },
            file: makeTFile('ir/articles/Article.md'),
          } as unknown as ReviewArticle;
          const sourceFile = makeTFile('sources/Book.pdf');
          const getSourceFile = vi
            .spyOn(ObsidianHelpers, 'getSourceFile')
            .mockReturnValue(resolves ? sourceFile : null);
          const app = makeApp();
          app.metadataCache.getFileCache.mockImplementation((file: TFile) =>
            file === article.file
              ? { frontmatter: source === undefined ? {} : { source } }
              : null
          );

          const result = findArticleSource(app, article);

          if (typeof source !== 'string' || source.trim() === '') {
            expect(result).toEqual({ file: null, reason: 'none' });
            return;
          }
          expect(getSourceFile).toHaveBeenCalledWith(article.file, app);
          expect(result).toEqual(
            resolves
              ? { file: sourceFile }
              : { file: null, reason: 'outside-vault' }
          );
        }
      )
    );
  });

  it('is none when the article has no metadata cached', () => {
    const article = {
      data: { id: 'article-1', type: 'article' },
      file: makeTFile('ir/articles/Article.md'),
    } as unknown as ReviewArticle;

    expect(findArticleSource(makeApp(), article)).toEqual({
      file: null,
      reason: 'none',
    });
  });
});
