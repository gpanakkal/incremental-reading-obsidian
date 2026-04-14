/** Assumes that the bullet's indent level has been validated */
const BULLET_ITEM_PATTERN = /^(\s*(?:-|\d+\.)\s)(\[.\]\s)?(.*)/;

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
}
