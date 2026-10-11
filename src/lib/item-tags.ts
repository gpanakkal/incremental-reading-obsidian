import { ARTICLE_TAG, CARD_TAG, SNIPPET_TAG } from './constants';
import type { ItemTable } from './moved-note-scan';

/** The type tag every note of an item table carries. */
export const TAG_BY_TABLE: Readonly<Record<ItemTable, string>> = {
  article: ARTICLE_TAG,
  snippet: SNIPPET_TAG,
  srs_card: CARD_TAG,
};

/**
 * The entries of a frontmatter `tags` value, whether written as a list or as a
 * single string. A list is taken as it comes, whatever its entries are; a lone
 * string is split on commas and whitespace, as a hand-written `tags: a, b`
 * means it. Anything else names no tags.
 */
export function tagEntries(tags: unknown): readonly unknown[] {
  if (Array.isArray(tags)) return tags as unknown[];
  return typeof tags === 'string' ? tags.split(/[\s,]/).filter(Boolean) : [];
}

/**
 * Whether a frontmatter `tags` value carries `tag` as an entry of its own.
 *
 * Exact, so stricter than `ObsidianHelpers.typeOfTags`, which searches a lone
 * string: a note this reads as lacking its tag may still read as typed there,
 * and adding the tag to it costs nothing, while the reverse would leave a note
 * some readers do not take for an item.
 */
export function hasTag(tags: unknown, tag: string): boolean {
  return tagEntries(tags).includes(tag);
}

/** An entry YAML leaves behind for an empty `tags:` or `- ` line. */
const isBlank = (entry: unknown) =>
  entry === null ||
  entry === undefined ||
  (typeof entry === 'string' && entry.trim() === '');

/**
 * A frontmatter `tags` value carrying `tag`: `tags` itself when it already
 * does, so a caller can tell there is nothing to write, and otherwise a new list
 * of every tag it had, in its order, with `tag` last.
 *
 * A lone string becomes the list of the tags it names, which is the form
 * Obsidian's properties editor writes. Blank entries are dropped, as
 * `ObsidianHelpers._mergeTags` drops them, since a write would otherwise turn
 * them into literal `null`s. Anything else that is there is kept as it is.
 */
export function withTag(tags: unknown, tag: string): unknown {
  if (hasTag(tags, tag)) return tags;
  const kept =
    Array.isArray(tags) || typeof tags === 'string'
      ? tagEntries(tags).filter((entry) => !isBlank(entry))
      : isBlank(tags)
        ? []
        : [tags];
  return [...kept, tag];
}
