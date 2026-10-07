/**
 * The text of a note whose frontmatter holds `frontmatter`. Written as JSON,
 * which is YAML, so any JSON value reads back exactly as it went in. Null means
 * a note with no frontmatter block at all.
 */
export function noteText(
  frontmatter: Record<string, unknown> | null,
  body = ''
): string {
  if (frontmatter === null) return body;
  return `---\n${JSON.stringify(frontmatter)}\n---\n${body}`;
}
