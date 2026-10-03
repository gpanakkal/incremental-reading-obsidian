import { highlightPdfSelection, pdfTabDocument } from '#/lib/pdf/obsidian-pdf';
import { type AnchorRange, decodeAnchor } from '#/lib/pdf/pdf-anchor';
import { pageSelection, pageSelectionSubpath } from '#/lib/pdf/pdf-selection';
import { readPageText } from '#/lib/pdf/pdf-text';
import type { App, TFile, View } from 'obsidian';
import { SOURCE_PROPERTY_NAME } from './constants';
import type ReviewManager from './items/ReviewManager';
import { getMimeType, isEditableText } from './mime';
import { ObsidianHelpers as Obsidian } from './ObsidianHelpers';
import {
  type ReviewArticle,
  type ReviewCard,
  type ReviewSnippet,
  isReviewSnippet,
} from './types';

/**
 * The ephemeral state Obsidian's search and backlinks panes open a result
 * with. `MarkdownView.setEphemeralState` reads it in every mode: source and
 * live preview select the range, flash it and scroll it to the middle of the
 * viewport; reading view scrolls its line to the middle. `matches` are
 * absolute offsets into `content`, which must be the note's full text,
 * frontmatter included.
 */
export type MatchEphemeralState = {
  match: { content: string; matches: [number, number][] };
};

/**
 * The ephemeral state a link to a subpath of a file opens it with. A PDF tab
 * reads it the way a link to `x.pdf#page=N&selection=a,b,c,d` does: it opens
 * at the page and highlights the selection once the page has rendered.
 *
 * Undocumented: `PdfView.setEphemeralState` hands `subpath` to its viewer
 * child's `applySubpath` (see `plans/reference/obsidian-pdf-internals.md`).
 */
export type SubpathEphemeralState = { subpath: string };

export type ItemContext = {
  /** The note the item was taken from */
  file: TFile;
  /** Where in `file` the item sits, when that is still known */
  eState: MatchEphemeralState | SubpathEphemeralState | null;
  /**
   * For a snippet of a PDF whose passage runs onto a later page: where the
   * passage is, to highlight once the PDF is open (see
   * {@link revealPdfContext}). `eState` can't highlight it, since where it
   * ends on its first page depends on the text there.
   */
  pdfRange?: AnchorRange;
};

/**
 * Why an article has no source to open: its `source` property is missing or
 * blank, or it names something that is not a file in the vault — a web page,
 * or a note that has since been deleted.
 */
export type MissingSourceReason = 'none' | 'outside-vault';

/**
 * The vault file an article was imported from, or why there is none.
 */
export function findArticleSource(
  app: App,
  article: ReviewArticle
): { file: TFile } | { file: null; reason: MissingSourceReason } {
  const source = Obsidian.getFrontMatter(article.file, app)?.[
    SOURCE_PROPERTY_NAME
  ];
  if (typeof source !== 'string' || source.trim() === '') {
    return { file: null, reason: 'none' };
  }
  const file = Obsidian.getSourceFile(article.file, app);
  return file ? { file } : { file: null, reason: 'outside-vault' };
}

/**
 * The note an item was taken from: its parent item's note, or failing that
 * the note its `source` property links to. Null when it has neither — no
 * parent, and a source that is missing, external, or resolves nowhere.
 *
 * A parent whose row or note is gone counts as no parent.
 */
export async function findContextFile(
  app: App,
  reviewManager: ReviewManager,
  item: ReviewSnippet | ReviewCard
): Promise<TFile | null> {
  const { parent } = item.data;
  if (parent) {
    const parentItem = await reviewManager.getReviewItemFromId(parent);
    if (parentItem) return parentItem.file;
  }
  return Obsidian.getSourceFile(item.file, app);
}

/**
 * The absolute range of a snippet's highlight in `content`, or null when its
 * offsets are unset or no longer describe a range inside the note's body.
 */
export function highlightRange(
  snippet: ReviewSnippet,
  content: string
): [number, number] | null {
  const { start_offset: start, end_offset: end } = snippet.data;
  if (start === null || end === null) return null;
  const bodyStart = Obsidian.getBodyStartOffset(content);
  if (start < 0 || start >= end || bodyStart + end > content.length) {
    return null;
  }
  return [bodyStart + start, bodyStart + end];
}

/**
 * The absolute range of the first link or embed in `context` that resolves to
 * `card`'s note, or null when `context` holds none — the card was cut from it
 * and never linked back, or the link has since been removed.
 */
export function backlinkRange(
  app: App,
  context: TFile,
  card: ReviewCard
): [number, number] | null {
  const cache = app.metadataCache.getFileCache(context);
  const references = [...(cache?.embeds ?? []), ...(cache?.links ?? [])];
  const first = references
    .filter(
      (ref) =>
        app.metadataCache.getFirstLinkpathDest(ref.link, context.path)?.path ===
        card.file.path
    )
    .sort((a, b) => a.position.start.offset - b.position.start.offset)[0];
  if (!first) return null;
  return [first.position.start.offset, first.position.end.offset];
}

/**
 * Where to open an item's context: the note it came from, and where in that
 * note its highlight (for a snippet) or the link to it (for a card) sits.
 * Null when the item has no context to open.
 */
export async function resolveItemContext(
  app: App,
  reviewManager: ReviewManager,
  item: ReviewSnippet | ReviewCard
): Promise<ItemContext | null> {
  const file = await findContextFile(app, reviewManager, item);
  if (!file) return null;
  // The context's type decides what a snippet's offsets are
  if (getMimeType(file) === 'application/pdf' && isReviewSnippet(item)) {
    return pdfSnippetContext(file, item);
  }
  // Nothing else that isn't text has anything to point into
  if (!isEditableText(file)) return { file, eState: null };

  const content = await app.vault.cachedRead(file);
  const range = isReviewSnippet(item)
    ? highlightRange(item, content)
    : backlinkRange(app, file, item);

  return {
    file,
    eState: range ? { match: { content, matches: [range] } } : null,
  };
}

/**
 * The passage of a PDF `snippet`'s offsets name, or null when they name none:
 * unset, not anchors, or not in order.
 */
function pdfSnippetRange(snippet: ReviewSnippet): AnchorRange | null {
  const { start_offset: start, end_offset: end } = snippet.data;
  if (start === null || end === null || start >= end) return null;
  try {
    decodeAnchor(start);
    decodeAnchor(end);
  } catch {
    return null;
  }
  return { start, end };
}

/**
 * Where to open the PDF `file` a snippet was taken from: at its passage, by
 * the link Obsidian's own "Copy link to selection" writes, without reading
 * the PDF. A passage that runs onto a later page opens at its first page,
 * for {@link revealPdfContext} to highlight once the PDF is open.
 */
function pdfSnippetContext(file: TFile, snippet: ReviewSnippet): ItemContext {
  const range = pdfSnippetRange(snippet);
  if (!range) return { file, eState: null };
  const selection = pageSelection(range.start, range.end);
  if (selection) {
    return { file, eState: { subpath: pageSelectionSubpath(selection) } };
  }
  const page = decodeAnchor(range.start).page;
  return { file, eState: { subpath: `#page=${page}` }, pdfRange: range };
}

/**
 * Highlight `range`, a snippet's passage, in the PDF tab `view` its context
 * opened in: at once for a passage on one page, and for one that runs onto a
 * later page up to the end of the text on its first, once the PDF is open and
 * that page's text read. Gives up when the tab closes or moves on to another
 * file first, or the page no longer holds the passage's start.
 */
export async function revealPdfContext(
  view: View,
  range: AnchorRange
): Promise<void> {
  let selection = pageSelection(range.start, range.end);
  if (!selection) {
    // `FileView.file`: the PDF the tab shows
    const fileOf = () => (view as unknown as { file?: unknown }).file;
    const file = fileOf();
    const stillOpen = () => fileOf() === file;
    const doc = await pdfTabDocument(view);
    if (!doc || !stillOpen()) return;
    let text;
    try {
      text = await readPageText(doc, decodeAnchor(range.start).page);
    } catch (error) {
      console.warn(
        "Incremental Reading: can't read the PDF page to highlight",
        error
      );
      return;
    }
    if (!stillOpen()) return;
    selection = pageSelection(range.start, range.end, text);
    if (!selection) return;
  }
  highlightPdfSelection(view, selection);
}
