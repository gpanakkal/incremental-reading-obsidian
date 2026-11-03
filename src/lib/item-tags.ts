import { ARTICLE_TAG, CARD_TAG, SNIPPET_TAG } from './constants';
import type { ItemTable } from './moved-note-scan';
import type { NoteType } from './types';

/** The type tag every note of an item table carries. */
export const TAG_BY_TABLE: Readonly<Record<ItemTable, string>> = {
  article: ARTICLE_TAG,
  snippet: SNIPPET_TAG,
  srs_card: CARD_TAG,
};

/**
 * The tags a note's frontmatter carries, read the way Obsidian reads them
 * (`parseFrontMatterTags`, which `getAllTags`, the tag pane, `tag:` search and
 * Bases' `file.hasTag` all go through; read from obsidian.asar, not
 * documented beyond the API's names):
 *
 * - Only the first key named `tags` in any case (`tags`, `Tags`, `TAGS`)
 *   counts. The older `tag` key is not read; only Obsidian's format converter
 *   ever renames it to `tags`.
 * - A string there is one tag, never split: `tags: a, b` is the single entry
 *   `a, b`. A list's string entries are its tags; other entries, and any
 *   value that is neither a string nor a list (or is empty), carry none.
 * - Each entry is trimmed; an empty one, or one with a space left inside it,
 *   is no tag at all, so `tags: a, b` carries nothing.
 * - One leading `#` is optional (`#a` and `a` are the same tag; `##a` is not).
 * - Tags compare in any case.
 *
 * A tag nested in another (`a/b`) is a tag of its own here, never the one it
 * is nested in: `ir-article/x` is no article tag, and a note tagged
 * `book/fiction` is not imported for the trigger tag `book`. Obsidian's search
 * finds `a/b` for `a`, but everything this plugin asks is whether a note
 * carries one exact tag, and only whole tags are ever written or taken off.
 *
 * Takes the frontmatter as the metadata cache has it or as
 * `ObsidianHelpers.readFrontMatter` parses it from the note's text, which are
 * the same shape. Never writes to it.
 * @returns each tag carried, without its `#`, in lower case
 */
export function frontmatterTags(frontmatter: unknown): ReadonlySet<string> {
  const carried = new Set<string>();
  const value = tagsValue(frontmatter);
  // A value that is neither a list nor a string holds no string to read
  for (const entry of Array.isArray(value) ? value : [value]) {
    if (typeof entry !== 'string') continue;
    const tag = entry.trim();
    if (tag === '' || tag.includes(' ')) continue;
    carried.add(normalizeTag(tag));
  }
  return carried;
}

/** The value of the first key Obsidian reads tags from, if any. */
function tagsValue(frontmatter: unknown): unknown {
  if (frontmatter === null || typeof frontmatter !== 'object') return;
  const key = readKeyOf(frontmatter);
  return key === undefined
    ? undefined
    : (frontmatter as Record<string, unknown>)[key];
}

/** The key Obsidian reads tags from, in any case. */
const TAGS_KEY = /^tags$/i;

/** Whether `key` is named `tags` in any case, as the key tags are read from. */
export const isTagsKey = (key: string) => TAGS_KEY.test(key);

/** The first key of `frontmatter` named `tags` in any case, if any. */
const readKeyOf = (frontmatter: object) =>
  Object.keys(frontmatter).find(isTagsKey);

/**
 * The key a tag goes under, or comes off, for Obsidian to see the change: the
 * one {@link frontmatterTags} reads (`Tags`, say, in a note that spells it so),
 * or `tags` when the note has none. A tag written anywhere else is one
 * Obsidian never reads, and the note still reads as lacking it.
 */
export function tagsKeyOf(frontmatter: Record<string, unknown>): string {
  return readKeyOf(frontmatter) ?? 'tags';
}

/** A tag as compared: without one leading `#`, in lower case. */
const normalizeTag = (tag: string) =>
  (tag.startsWith('#') ? tag.slice(1) : tag).toLowerCase();

/**
 * Whether `frontmatter` carries `tag`, `#` optional, in any case, as
 * {@link frontmatterTags} reads it.
 */
export function hasTag(frontmatter: unknown, tag: string): boolean {
  return frontmatterTags(frontmatter).has(normalizeTag(tag));
}

/**
 * Those of `tags` that `frontmatter` carries, in the order given, as
 * {@link hasTag} finds each. Returns which matched rather than whether any did,
 * so a caller can act on exactly those.
 */
export function matchFrontmatterTags(
  frontmatter: unknown,
  tags: Iterable<string>
): string[] {
  const carried = frontmatterTags(frontmatter);
  return [...tags].filter((tag) => carried.has(normalizeTag(tag)));
}

/**
 * The item type `frontmatter`'s tags name, as {@link hasTag} finds them: the
 * article tag ranking over the snippet tag over the card tag; null when it
 * carries none of them.
 */
export function typeOfTags(frontmatter: unknown): NoteType | null {
  if (hasTag(frontmatter, ARTICLE_TAG)) return 'article';
  if (hasTag(frontmatter, SNIPPET_TAG)) return 'snippet';
  if (hasTag(frontmatter, CARD_TAG)) return 'card';
  return null;
}

/**
 * The entries of a frontmatter `tags` value, to rewrite it, whether written as
 * a list or as a single string. A list is taken as it comes, whatever its
 * entries are; a lone string is split on commas and whitespace, as a
 * hand-written `tags: a, b` means it (and as Obsidian's format converter
 * splits it). Anything else names no tags.
 */
export function tagEntries(tags: unknown): readonly unknown[] {
  if (Array.isArray(tags)) return tags as unknown[];
  return typeof tags === 'string' ? tags.split(/[\s,]/).filter(Boolean) : [];
}

/**
 * Whether the frontmatter `tags` value `entry` is `tag`, `#` optional, in any
 * case, as {@link hasTag} compares a tag.
 */
export function isTag(entry: unknown, tag: string): boolean {
  return (
    typeof entry === 'string' &&
    normalizeTag(entry.trim()) === normalizeTag(tag)
  );
}

/** An entry YAML leaves behind for an empty `tags:` or `- ` line. */
const isBlank = (entry: unknown) =>
  entry === null ||
  entry === undefined ||
  (typeof entry === 'string' && entry.trim() === '');

/**
 * A frontmatter `tags` value carrying `tag`: `tags` itself when it already
 * does (see {@link hasTag}), so a caller can tell there is nothing to write,
 * and otherwise a new list of every tag it had, in its order, with `tag` last.
 *
 * A lone string becomes the list of the tags it names (see
 * {@link tagEntries}), which is the form Obsidian's properties editor writes
 * and the only one it reads several tags from; when that list names `tag`
 * already, as `tags: a, ir-article` does, it is not added again. Blank entries
 * are dropped, as `ObsidianHelpers._mergeTags` drops them, since a write would
 * otherwise turn them into literal `null`s. Anything else that is there is
 * kept as it is.
 */
export function withTag(tags: unknown, tag: string): unknown {
  if (hasTag({ tags }, tag)) return tags;
  const kept =
    Array.isArray(tags) || typeof tags === 'string'
      ? tagEntries(tags).filter((entry) => !isBlank(entry))
      : isBlank(tags)
        ? []
        : [tags];
  return hasTag({ tags: kept }, tag) ? kept : [...kept, tag];
}
