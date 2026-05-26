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
    const appearances: string[] = [];
    const counts: Record<string, number> = {};
    const footnoteMatches = text.matchAll(FOOTNOTE_REFERENCE_PATTERN);
    const matches = [...footnoteMatches];
    matches.forEach((match) => {
      const name = match[1];
      if (!counts.hasOwnProperty(name)) {
        counts[name] = 0;
        appearances.push(name);
      }
      counts[name] += 1;
    });
    return appearances.map((name) => ({ name, count: counts[name] }));
  }
}
