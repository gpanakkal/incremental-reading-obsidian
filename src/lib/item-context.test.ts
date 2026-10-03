import {
  backlinkRange,
  findArticleSource,
  findContextFile,
  highlightRange,
  resolveItemContext,
  revealPdfContext,
} from '#/lib/item-context';
import type ReviewManager from '#/lib/items/ReviewManager';
import { ObsidianHelpers } from '#/lib/ObsidianHelpers';
import * as obsidianPdf from '#/lib/pdf/obsidian-pdf';
import {
  decodeAnchor,
  encodeAnchor,
  MAX_ANCHOR_PAGE,
} from '#/lib/pdf/pdf-anchor';
import type { PdfPageText } from '#/lib/pdf/pdf-text';
import * as pdfText from '#/lib/pdf/pdf-text';
import type {
  ReviewArticle,
  ReviewCard,
  ReviewItem,
  ReviewSnippet,
} from '#/lib/types';
import fc from 'fast-check';
import type {
  App,
  CachedMetadata,
  ReferenceCache,
  TFile,
  View,
} from 'obsidian';
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

/**
 * Any extension of a file that isn't text: `pdf` in every casing, or any
 * other string that isn't some casing of `md`, the empty one included.
 */
const binaryExtensionArb = fc.oneof(
  fc.mixedCase(fc.constant('pdf')),
  fc.string().filter((ext) => ext.toLowerCase() !== 'md')
);

/** A PDF in the vault, its extension in any case. */
const pdfFileArb = fc.mixedCase(fc.constant('pdf')).map(
  (extension) =>
    ({
      ...makeTFile(`papers/Paper.${extension}`),
      extension,
    }) as TFile
);

const anchorPartsArb = fc.record({
  page: fc.integer({ min: 1, max: MAX_ANCHOR_PAGE }),
  idx: fc.nat(99_999),
  char: fc.nat(99_999),
});

/** A passage of a PDF, as tight anchors a snippet's offsets hold: start < end. */
const pdfRangeArb = fc
  .tuple(anchorPartsArb, anchorPartsArb)
  .map(([a, b]) => [encodeAnchor(a), encodeAnchor(b)].sort((x, y) => x - y))
  .filter(([start, end]) => start < end)
  .map(([start, end]) => ({ start, end }));

/** A passage of a PDF that stays on one page. */
const samePageRangeArb = fc
  .tuple(anchorPartsArb, fc.nat(99_999), fc.nat(99_999))
  .map(([from, idx, char]) => {
    const anchors = [
      encodeAnchor(from),
      encodeAnchor({ page: from.page, idx, char }),
    ].sort((x, y) => x - y);
    return { start: anchors[0], end: anchors[1] };
  })
  .filter(({ start, end }) => start < end);

/** A passage that runs onto a later page. */
const crossPageRangeArb = pdfRangeArb.filter(
  ({ start, end }) => decodeAnchor(start).page < decodeAnchor(end).page
);

/** Snippet offsets that name no passage of a PDF. */
const notPdfRangeArb = fc.oneof(
  fc.record({
    start: fc.option(fc.integer(), { nil: null }),
    end: fc.constant(null),
  }),
  fc.record({
    start: fc.constant(null),
    end: fc.option(fc.integer(), { nil: null }),
  }),
  // Not anchors at all: below the first, or past the last
  fc.record({
    start: fc.integer({ max: encodeAnchor({ page: 1, idx: 0, char: 0 }) - 1 }),
    end: pdfRangeArb.map(({ end }) => end),
  }),
  fc.record({
    start: pdfRangeArb.map(({ start }) => start),
    end: fc.oneof(
      fc.double({ noNaN: false }).filter((n) => !Number.isSafeInteger(n)),
      fc.constant(Number.MAX_SAFE_INTEGER)
    ),
  }),
  // Backwards or empty
  pdfRangeArb.chain(({ start, end }) =>
    fc.constantFrom({ start: end, end: start }, { start, end: start })
  )
);

/** The text content of a page whose items hold `strs`. */
function pageText(strs: string[]): PdfPageText {
  return {
    items: strs.map((str) => ({
      str,
      hasEOL: false,
      transform: [10, 0, 0, 10, 72, 700],
      width: 0,
      height: 10,
    })),
    view: [0, 0, 612, 792],
  };
}

/** A PDF tab showing `file`, which a test may move on to another. */
const makeTab = (file: unknown = { path: 'papers/Paper.pdf' }) =>
  ({ getViewType: () => 'pdf', file }) as unknown as View & {
    file: unknown;
  };

/**
 * A passage that runs onto a later page, and the text of its first page,
 * which holds its start: as when the PDF hasn't changed since.
 */
const crossPageCaseArb = fc
  .record({
    before: fc.array(fc.string(), { maxLength: 6 }),
    last: fc.string({ minLength: 1 }),
    trailing: fc.array(fc.constant(''), { maxLength: 3 }),
    page: fc.integer({ min: 1, max: MAX_ANCHOR_PAGE - 1 }),
    pagesOn: fc.integer({ min: 1, max: 100 }),
    end: fc.record({ idx: fc.nat(99_999), char: fc.nat(99_999) }),
  })
  .chain(({ before, last, trailing, page, pagesOn, end }) => {
    const strs = [...before, last, ...trailing];
    return fc
      .nat(strs.length - 1)
      .chain((idx) => fc.nat(strs[idx].length).map((char) => ({ idx, char })))
      .map((from) => ({
        strs,
        lastIdx: before.length,
        from: { page, ...from },
        range: {
          start: encodeAnchor({ page, ...from }),
          end: encodeAnchor({
            page: Math.min(page + pagesOn, MAX_ANCHOR_PAGE),
            ...end,
          }),
        },
      }));
  });

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

  it('opens a context that is not text without reading it, since it has no text to point into', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('snippet', 'card'),
        binaryExtensionArb,
        fc.boolean(),
        async (type, extension, fromParent) => {
          vi.restoreAllMocks();
          const contextFile = {
            ...makeTFile(`papers/Paper.${extension}`),
            extension,
          } as TFile;
          const parent = {
            data: { id: 'article-1' },
            file: contextFile,
          } as ReviewItem;
          vi.spyOn(ObsidianHelpers, 'getSourceFile').mockReturnValue(
            fromParent ? null : contextFile
          );
          const app = makeApp({ content: 'text' });
          const item =
            type === 'snippet'
              ? makeSnippet({
                  parent: 'article-1',
                  start_offset: 0,
                  end_offset: 1,
                })
              : makeCard('article-1');

          const context = await resolveItemContext(
            app,
            makeReviewManager(fromParent ? parent : null),
            item
          );

          expect(context).toEqual({ file: contextFile, eState: null });
          expect(app.vault.cachedRead).not.toHaveBeenCalled();
          expect(app.metadataCache.getFileCache).not.toHaveBeenCalled();
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

describe('resolveItemContext for a snippet of a PDF', () => {
  it("points it at its passage with the link Obsidian's own selections use, reading nothing", async () => {
    await fc.assert(
      fc.asyncProperty(
        pdfFileArb,
        fc.oneof(samePageRangeArb, crossPageRangeArb),
        fc.boolean(),
        async (contextFile, { start, end }, fromParent) => {
          vi.restoreAllMocks();
          const parent = {
            data: { id: 'article-1' },
            file: contextFile,
          } as ReviewItem;
          vi.spyOn(ObsidianHelpers, 'getSourceFile').mockReturnValue(
            fromParent ? null : contextFile
          );
          const app = makeApp({ content: 'text' });
          const snippet = makeSnippet({
            parent: 'article-1',
            start_offset: start,
            end_offset: end,
          });

          const context = await resolveItemContext(
            app,
            makeReviewManager(fromParent ? parent : null),
            snippet
          );

          const from = decodeAnchor(start);
          const to = decodeAnchor(end);
          // Where text that runs onto a later page ends on its first depends
          // on that page's text, which is read once the PDF is open, for the
          // passage to be highlighted then
          const subpath =
            from.page === to.page
              ? `#page=${from.page}&selection=${from.idx},${from.char},${to.idx},${to.char}`
              : `#page=${from.page}`;
          expect(context).toStrictEqual(
            from.page === to.page
              ? { file: contextFile, eState: { subpath } }
              : {
                  file: contextFile,
                  eState: { subpath },
                  pdfRange: { start, end },
                }
          );
          expect(app.vault.cachedRead).not.toHaveBeenCalled();
          expect(app.metadataCache.getFileCache).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('opens the PDF at no passage when the offsets name none', async () => {
    await fc.assert(
      fc.asyncProperty(
        pdfFileArb,
        notPdfRangeArb,
        async (contextFile, { start, end }) => {
          vi.restoreAllMocks();
          vi.spyOn(ObsidianHelpers, 'getSourceFile').mockReturnValue(
            contextFile
          );
          const app = makeApp({ content: 'text' });
          const snippet = makeSnippet({ start_offset: start, end_offset: end });

          const context = await resolveItemContext(
            app,
            makeReviewManager(null),
            snippet
          );

          expect(context).toStrictEqual({ file: contextFile, eState: null });
          expect(app.vault.cachedRead).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('reads offsets as text offsets when the context is a note, whatever they hold', async () => {
    await fc.assert(
      fc.asyncProperty(pdfRangeArb, async ({ start, end }) => {
        vi.restoreAllMocks();
        const contextFile = makeTFile(CONTEXT_PATH);
        vi.spyOn(ObsidianHelpers, 'getSourceFile').mockReturnValue(contextFile);
        const content = 'a'.repeat(10);
        const app = makeApp({ content });

        const context = await resolveItemContext(
          app,
          makeReviewManager(null),
          makeSnippet({ start_offset: start, end_offset: end })
        );

        expect(context).toStrictEqual({ file: contextFile, eState: null });
        expect(app.vault.cachedRead).toHaveBeenCalledWith(contextFile);
      })
    );
  });

  it('opens a PDF at no passage for a card', async () => {
    await fc.assert(
      fc.asyncProperty(pdfFileArb, async (contextFile) => {
        vi.restoreAllMocks();
        vi.spyOn(ObsidianHelpers, 'getSourceFile').mockReturnValue(contextFile);
        const app = makeApp();

        const context = await resolveItemContext(
          app,
          makeReviewManager(null),
          makeCard()
        );

        expect(context).toStrictEqual({ file: contextFile, eState: null });
        expect(app.vault.cachedRead).not.toHaveBeenCalled();
      })
    );
  });
});

describe('revealPdfContext', () => {
  it('highlights a passage on one page in the PDF tab at once, reading nothing', async () => {
    await fc.assert(
      fc.asyncProperty(samePageRangeArb, async (range) => {
        vi.restoreAllMocks();
        const tab = makeTab();
        const highlight = vi
          .spyOn(obsidianPdf, 'highlightPdfSelection')
          .mockReturnValue(undefined);
        const tabDocument = vi.spyOn(obsidianPdf, 'pdfTabDocument');

        await revealPdfContext(tab, range);

        const from = decodeAnchor(range.start);
        const to = decodeAnchor(range.end);
        expect(highlight).toHaveBeenCalledExactlyOnceWith(tab, {
          page: from.page,
          range: [
            [from.idx, from.char],
            [to.idx, to.char],
          ],
        });
        expect(tabDocument).not.toHaveBeenCalled();
      })
    );
  });

  it('highlights a passage that runs onto a later page up to the end of the text on its first, once the PDF is open', async () => {
    await fc.assert(
      fc.asyncProperty(
        crossPageCaseArb,
        async ({ strs, lastIdx, from, range }) => {
          vi.restoreAllMocks();
          const tab = makeTab();
          const doc = { numPages: 1, getPage: vi.fn() };
          const highlight = vi
            .spyOn(obsidianPdf, 'highlightPdfSelection')
            .mockReturnValue(undefined);
          vi.spyOn(obsidianPdf, 'pdfTabDocument').mockResolvedValue(doc);
          const read = vi
            .spyOn(pdfText, 'readPageText')
            .mockResolvedValue(pageText(strs));

          await revealPdfContext(tab, range);

          expect(obsidianPdf.pdfTabDocument).toHaveBeenCalledWith(tab);
          expect(read).toHaveBeenCalledExactlyOnceWith(doc, from.page);
          expect(highlight).toHaveBeenCalledExactlyOnceWith(tab, {
            page: from.page,
            range: [
              [from.idx, from.char],
              [lastIdx, strs[lastIdx].length],
            ],
          });
        }
      )
    );
  });

  it("highlights nothing when the tab has no PDF open, or the passage's first page has no text or no longer holds its start", async () => {
    await fc.assert(
      fc.asyncProperty(
        crossPageCaseArb,
        fc.constantFrom('no document', 'no text', 'start gone'),
        async ({ strs, range }, why) => {
          vi.restoreAllMocks();
          const tab = makeTab();
          const highlight = vi
            .spyOn(obsidianPdf, 'highlightPdfSelection')
            .mockReturnValue(undefined);
          vi.spyOn(obsidianPdf, 'pdfTabDocument').mockResolvedValue(
            why === 'no document' ? null : { numPages: 1, getPage: vi.fn() }
          );
          const read = vi.spyOn(pdfText, 'readPageText').mockResolvedValue(
            pageText(
              why === 'no text'
                ? strs.map(() => '')
                : // The start's item and all after it gone
                  strs.slice(0, decodeAnchor(range.start).idx)
            )
          );

          await revealPdfContext(tab, range);

          expect(highlight).not.toHaveBeenCalled();
          if (why === 'no document') expect(read).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('highlights nothing once the tab has moved on to another file', async () => {
    await fc.assert(
      fc.asyncProperty(
        crossPageCaseArb,
        fc.constantFrom('opening', 'reading'),
        async ({ strs, range }, when) => {
          vi.restoreAllMocks();
          const tab = makeTab();
          const moveOn = () => {
            tab.file = { path: 'papers/Other.pdf' };
          };
          const highlight = vi
            .spyOn(obsidianPdf, 'highlightPdfSelection')
            .mockReturnValue(undefined);
          const doc = { numPages: 1, getPage: vi.fn() };
          vi.spyOn(obsidianPdf, 'pdfTabDocument').mockImplementation(() => {
            if (when === 'opening') moveOn();
            return Promise.resolve(doc);
          });
          const read = vi
            .spyOn(pdfText, 'readPageText')
            .mockImplementation(() => {
              if (when === 'reading') moveOn();
              return Promise.resolve(pageText(strs));
            });

          await revealPdfContext(tab, range);

          expect(highlight).not.toHaveBeenCalled();
          if (when === 'opening') expect(read).not.toHaveBeenCalled();
        }
      )
    );
  });

  it("logs a first page that can't be read, as when the PDF has since lost pages, and highlights nothing", async () => {
    await fc.assert(
      fc.asyncProperty(crossPageCaseArb, async ({ range }) => {
        vi.restoreAllMocks();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const highlight = vi
          .spyOn(obsidianPdf, 'highlightPdfSelection')
          .mockReturnValue(undefined);
        vi.spyOn(obsidianPdf, 'pdfTabDocument').mockResolvedValue({
          numPages: 1,
          getPage: vi.fn(),
        });
        const error = new Error('Invalid page request.');
        vi.spyOn(pdfText, 'readPageText').mockRejectedValue(error);

        await expect(
          revealPdfContext(makeTab(), range)
        ).resolves.toBeUndefined();

        expect(highlight).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledExactlyOnceWith(
          "Incremental Reading: can't read the PDF page to highlight",
          error
        );
      })
    );
  });
});
