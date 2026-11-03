import {
  ARTICLE_TAG,
  AUTO_IMPORT_TAG,
  CARD_TAG,
  SNIPPET_TAG,
  SOURCE_TAG,
} from '#/lib/constants';
import type { NoteType } from '#/lib/types';
import fc from 'fast-check';

/**
 * Obsidian's own `parseFrontMatterTags`, transcribed from obsidian.asar with
 * its `parseFrontMatterEntry` and `parseFrontMatterStringArray` helpers
 * inlined: the reading every tag reader in the plugin is held to. Each tag
 * comes back as Obsidian hands it out, with a leading `#`; null where Obsidian
 * answers null.
 */
export function obsidianFrontmatterTags(frontmatter: unknown): string[] | null {
  if (!frontmatter) return null;
  let value: unknown = null;
  for (const key in frontmatter as object) {
    if (
      Object.prototype.hasOwnProperty.call(frontmatter, key) &&
      /^tags$/i.test(key)
    ) {
      value = (frontmatter as Record<string, unknown>)[key];
      break;
    }
  }
  if (!value) return null;
  const list =
    typeof value === 'string'
      ? [value.trim()]
      : Array.isArray(value)
        ? value
            .filter((entry): entry is string => typeof entry === 'string')
            .map((entry) => entry.trim())
        : null;
  if (!list) return null;
  return list
    .filter((entry) => !!entry && !entry.includes(' '))
    .map((entry) => (entry.charAt(0) === '#' ? entry : `#${entry}`));
}

/**
 * Whether Obsidian finds exactly `tag` in `frontmatter`, compared as its own
 * `tag` command compares: `#` added when missing, in lower case.
 */
export function obsidianCarries(frontmatter: unknown, tag: string): boolean {
  const wanted = (tag.charAt(0) === '#' ? tag : `#${tag}`).toLowerCase();
  return (obsidianFrontmatterTags(frontmatter) ?? []).some(
    (carried) => carried.toLowerCase() === wanted
  );
}

/** The item type Obsidian's reading of `frontmatter` names, article first. */
export function obsidianTypeOf(frontmatter: unknown): NoteType | null {
  if (obsidianCarries(frontmatter, ARTICLE_TAG)) return 'article';
  if (obsidianCarries(frontmatter, SNIPPET_TAG)) return 'snippet';
  if (obsidianCarries(frontmatter, CARD_TAG)) return 'card';
  return null;
}

/** The tags the plugin reads: the item types', the source tag, the trigger. */
export const PLUGIN_TAGS: readonly string[] = [
  ARTICLE_TAG,
  SNIPPET_TAG,
  CARD_TAG,
  SOURCE_TAG,
  AUTO_IMPORT_TAG,
];

/**
 * A tag as a note might spell it: one of the plugin's, in another case, after
 * one `#` or two, padded, nested, as part of a longer word, with a space in
 * it, or any text at all.
 */
const tagSpellingArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...PLUGIN_TAGS),
  fc
    .constantFrom(...PLUGIN_TAGS)
    .chain((tag) =>
      fc.constantFrom(
        `#${tag}`,
        `##${tag}`,
        tag.toUpperCase(),
        `#${tag.charAt(0).toUpperCase()}${tag.slice(1)}`,
        ` ${tag} `,
        `\t${tag}`,
        `${tag}-x`,
        `not-${tag}`,
        `${tag}/x`,
        `${tag} x`,
        `# ${tag}`
      )
    ),
  fc.string({ maxLength: 8 })
);

/**
 * A frontmatter `tags` value of any shape: a lone tag, several joined into
 * one string by commas, spaces or line breaks, a list of tags and other
 * entries YAML can leave, or a value of the wrong type.
 */
export const tagsValueArb: fc.Arbitrary<unknown> = fc.oneof(
  tagSpellingArb,
  fc
    .array(tagSpellingArb, { minLength: 1, maxLength: 4 })
    .chain((tags) =>
      fc
        .constantFrom(', ', ',', ' ', '\n')
        .map((separator) => tags.join(separator))
    ),
  fc.array(
    fc.oneof(
      tagSpellingArb,
      fc.constantFrom<unknown>(null, undefined, '', '  ', 0, 7, true, {
        tags: ARTICLE_TAG,
      }),
      fc.constant([ARTICLE_TAG])
    ),
    { maxLength: 5 }
  ),
  fc.constantFrom<unknown>(null, undefined, '', 0, 5, true, false, {
    tags: [ARTICLE_TAG],
  }),
  fc.anything()
);

/**
 * The frontmatter keys a note might hold tags under, keys a tag key only
 * starts or ends, and other keys.
 */
const keyArb = fc.constantFrom(
  'tags',
  'Tags',
  'TAGS',
  'tag',
  'Tag',
  'mytags',
  'tagss',
  ' tags',
  'aliases',
  'ir-id',
  'other'
);

/**
 * A note's frontmatter of any shape: its keys in any order, tag keys in any
 * case, several of them at once, each holding any `tags` value; or none.
 */
export const frontmatterArb: fc.Arbitrary<Record<string, unknown> | null> =
  fc.oneof(
    fc
      .array(fc.tuple(keyArb, tagsValueArb), { maxLength: 4 })
      .map((entries) => Object.fromEntries(entries)),
    fc.constantFrom(null, {})
  );
