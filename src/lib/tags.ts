import type { CachedMetadata } from 'obsidian';
import { ARTICLE_TAG, CARD_TAG, SNIPPET_TAG } from './constants';
import { frontmatterTags } from './item-tags';

/**
 * Tags as the user types a list of them and as a note's frontmatter holds
 * them, compared the way Obsidian compares tags: in any case, `#` optional.
 *
 * Pure, with no runtime `obsidian` import: `getAllTags` and
 * `parseFrontMatterTags` are missing from the test mock, and `getAllTags`
 * would bring in the note body's tags too.
 */

/**
 * What separates tags in a list: commas, whitespace, and the `#` that starts
 * each tag, so `#a#b` reads as two tags. None can be part of a tag.
 */
const TAG_SEPARATORS = /[\s,#]+/;

/**
 * The frontmatter keys tags are taken off: `tags`, which Obsidian reads, and
 * the older `tag`, which only its format converter still knows.
 */
const TAG_KEY = /^tags?$/i;

/** A tag as compared: no leading `#`, in lower case. */
const normalizeTag = (tag: string) => tag.replace(/^#+/, '').toLowerCase();

/**
 * The tags in `raw`, a list typed by the user or a frontmatter string: split
 * on commas, whitespace and `#`s, in lower case, each once, in the order first
 * written.
 */
export function parseTagList(raw: string): string[] {
  const tags = raw
    .split(TAG_SEPARATORS)
    .filter((tag) => tag !== '')
    .map((tag) => tag.toLowerCase());
  return [...new Set(tags)];
}

/**
 * `tags`, as {@link parseTagList} reads them, written out for the user: each
 * after a `#`, separated by single spaces.
 */
export function formatTagList(tags: readonly string[]): string {
  return tags.map((tag) => `#${tag}`).join(' ');
}

/**
 * Those of `tags` that the note `cache` describes carries, in the order
 * given, as Obsidian's tag search finds them: in its frontmatter (read as
 * `frontmatterTags` reads it) or in its body (`cache.tags`), in
 * any case, `#` optional, and a nested tag counting as each tag it is nested
 * in, so `tag` matches `#tag/sub` but not `#tags` nor `#other/tag`. A tag
 * that is nothing but `#`s matches nothing.
 *
 * Never writes to `cache`, which is the metadata cache's own object.
 */
export function matchAnyTags(
  cache:
    | Readonly<Pick<CachedMetadata, 'frontmatter' | 'tags'>>
    | null
    | undefined,
  tags: Iterable<string>
): string[] {
  const carried = new Set(frontmatterTags(cache?.frontmatter));
  for (const { tag } of cache?.tags ?? []) carried.add(normalizeTag(tag));
  return [...tags].filter((asked) => {
    const tag = normalizeTag(asked);
    if (tag === '') return false;
    for (const held of carried) {
      if (held === tag || held.startsWith(`${tag}/`)) return true;
    }
    return false;
  });
}

/** An entry YAML leaves behind for an empty `tags:` or `- ` line. */
const isBlank = (entry: unknown) =>
  entry === null ||
  entry === undefined ||
  (typeof entry === 'string' && entry.trim() === '');

/**
 * Take `tags` off `frontmatter`, in any case, `#`s optional, from every key
 * tags are written under (see {@link TAG_KEY}), leaving every other tag where
 * it was. A string is split as {@link parseTagList} splits one, so this takes
 * off more than `hasTag` finds, never less.
 *
 * A key holding none of them is left exactly as it is. One that held any
 * becomes the list of what is left of it, each tag as it was spelled, less
 * its `#`, and the blank entries YAML reads as null, since a write would
 * otherwise spell them out; a key with nothing left is dropped.
 *
 * Writes to `frontmatter`, so it must be one `processFrontMatter` hands out,
 * never the metadata cache's own.
 * @returns what each key it changed held before, to put back
 */
export function stripFrontmatterTags(
  frontmatter: Record<string, unknown>,
  tags: Iterable<string>
): Record<string, unknown> {
  const unwanted = new Set([...tags].map(normalizeTag));
  const before: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!TAG_KEY.test(key)) continue;
    let changed = false;
    const kept: unknown[] = [];
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (typeof entry !== 'string') {
        kept.push(entry);
        continue;
      }
      const written = entry.split(TAG_SEPARATORS).filter((tag) => tag !== '');
      const left = written.filter((tag) => !unwanted.has(tag.toLowerCase()));
      if (left.length === written.length) kept.push(entry);
      else {
        changed = true;
        kept.push(...left);
      }
    }
    if (!changed) continue;
    before[key] = value;
    const rest = kept.filter((entry) => !isBlank(entry));
    if (rest.length === 0) delete frontmatter[key];
    else frontmatter[key] = rest;
  }
  return before;
}

/** The tags the plugin writes to mark what kind of item a note is. */
const ITEM_TYPE_TAGS: readonly string[] = [ARTICLE_TAG, SNIPPET_TAG, CARD_TAG];

/**
 * Whether `tag` is one the plugin marks an item's type with, or one nested
 * in such a tag (`#ir-article/x`), compared as Obsidian compares tags: in any
 * case, `#` optional. Those are the plugin's to write, never the user's to
 * pick, so no tag suggestion offers them.
 */
export function isItemTypeTag(tag: string): boolean {
  const name = normalizeTag(tag);
  return ITEM_TYPE_TAGS.some(
    (typeTag) => name === typeTag || name.startsWith(`${typeTag}/`)
  );
}
