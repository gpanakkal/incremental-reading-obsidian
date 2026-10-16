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

/** The frontmatter keys Obsidian reads tags from: `tags`, or the older `tag`. */
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
 * Those of `tags` that `frontmatter` carries, in the order given.
 *
 * Reads every key Obsidian reads tags from, whatever its case. A key's value
 * can be one string or a list, and any string can hold several tags, read as
 * {@link parseTagList} reads them; anything else in it is ignored. Returns
 * which tags matched rather than whether any did, so a caller can act on
 * exactly those.
 *
 * Never writes to `frontmatter`, which is the metadata cache's own object.
 */
export function matchFrontmatterTags(
  frontmatter: Readonly<Record<string, unknown>> | null | undefined,
  tags: Iterable<string>
): string[] {
  if (!frontmatter) return [];
  const carried = new Set<string>();
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!TAG_KEY.test(key)) continue;
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (typeof entry !== 'string') continue;
      for (const tag of parseTagList(entry)) carried.add(tag);
    }
  }
  return [...tags].filter((tag) => carried.has(normalizeTag(tag)));
}
