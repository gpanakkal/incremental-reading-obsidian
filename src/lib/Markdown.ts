/** Assumes that the bullet's indent level has been validated */
const BULLET_ITEM_PATTERN = /^(\s*(?:-|\d+\.)\s)(\s*\[.\]\s)?(.*)/;

/** Location of footnote text, which must be preceded by a newline and may have list and checkbox formatting. */
// const FOOTNOTE_PATTERN = /\n\s*?((?:-|\d\.)\s*?)?(\[.\]\s)?\[\^([\w\d]+)\]:/g;

/** link to a footnote defined elsewhere */
const FOOTNOTE_REFERENCE_PATTERN = /\[\^([\w\d]+)\](?!:)/g;

// const INLINE_FOOTNOTE_PATTERN = /\^\[([\w\d]+)\]/g;

/** Embedded note: `![[target]]`, `![[target#heading|alias]]` */
const EMBED_PATTERN = /!\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g;

/** Wikilink: `[[target]]`, `[[target|alias]]` */
const WIKILINK_PATTERN = /\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g;

/** Image, inline or by reference: `![alt](url)`, `![alt][ref]` */
const IMAGE_PATTERN = /!\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/g;

/** Link, inline or by reference: `[label](url)`, `[label][ref]` */
const LINK_PATTERN = /\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/g;

/** Keeps the label of a pattern that captures one. `replace` types its
 * replacer's groups as `any`, so they are annotated here rather than inline. */
const keepLabel = (_match: string, label: string) => label;

/** Keeps the alias of a wikilink-shaped pattern, or its target when it has
 * no alias. An empty alias — `[[Note|]]` — stays empty. */
const keepAliasOrTarget = (_match: string, target: string, alias?: string) =>
  alias ?? target;

/** Utilities for parsing Obsidian-flavored Markdown */
export class Markdown {
  /**
   * Replace every link with its label, dropping the target and the syntax.
   * `[my site](www.example.com)` becomes `my site`, `[[Note|alias]]` becomes
   * `alias`, and `[[Note]]` becomes `Note`. Footnote references carry no
   * label worth keeping, so they are removed outright.
   */
  static stripLinks(text: string) {
    // Footnote references go first: removing them also stops an adjacent pair
    // like `[^1][^2]` from being read as a reference link.
    // Images and embeds go next: an image inside a link is the one nesting
    // Markdown allows, and unwrapping it leaves an ordinary link behind.
    return text
      .replace(FOOTNOTE_REFERENCE_PATTERN, '')
      .replace(EMBED_PATTERN, keepAliasOrTarget)
      .replace(IMAGE_PATTERN, keepLabel)
      .replace(WIKILINK_PATTERN, keepAliasOrTarget)
      .replace(LINK_PATTERN, keepLabel);
  }

  /**
   * Remove leading spaces, bullet point or number, and checkbox if any
   */
  static getListItemText(line: string) {
    const bulletItemMatch = line.match(BULLET_ITEM_PATTERN);
    if (!bulletItemMatch) return line;
    const withoutBullet = bulletItemMatch[bulletItemMatch.length - 1];
    return withoutBullet;
  }

  static countFootnoteRefs(text: string) {
    const counts = new Map<string, number>();
    for (const match of text.matchAll(FOOTNOTE_REFERENCE_PATTERN)) {
      const name = match[1];
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts].map(([name, count]) => ({ name, count }));
  }
}
