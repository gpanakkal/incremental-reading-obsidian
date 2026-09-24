import type { App, TFile } from 'obsidian';
import { SOURCE_PROPERTY_NAME } from './constants';
import type ReviewManager from './items/ReviewManager';
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

export type ItemContext = {
  /** The note the item was taken from */
  file: TFile;
  /** Where in `file` the item sits, when that is still known */
  eState: MatchEphemeralState | null;
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

  const content = await app.vault.cachedRead(file);
  const range = isReviewSnippet(item)
    ? highlightRange(item, content)
    : backlinkRange(app, file, item);

  return {
    file,
    eState: range ? { match: { content, matches: [range] } } : null,
  };
}
