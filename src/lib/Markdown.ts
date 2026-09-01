/** Assumes that the bullet's indent level has been validated */
const BULLET_ITEM_PATTERN = /^(\s*(?:-|\d+\.)\s)(\s*\[.\]\s)?(.*)/;

/** Location of footnote text, which must be preceded by a newline and may have list and checkbox formatting. */
// const FOOTNOTE_PATTERN = /\n\s*?((?:-|\d\.)\s*?)?(\[.\]\s)?\[\^([\w\d]+)\]:/g;

/** link to a footnote defined elsewhere */
const FOOTNOTE_REFERENCE_PATTERN = /\[\^([\w\d]+)\](?!:)/g;

// const INLINE_FOOTNOTE_PATTERN = /\^\[([\w\d]+)\]/g;

/** Utilities for parsing Obsidian-flavored Markdown */
export class Markdown {
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
