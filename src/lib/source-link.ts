/**
 * Reading and rewriting the link an item note keeps in its `source` property,
 * which Obsidian writes with `FileManager.generateMarkdownLink`: a wikilink or
 * a markdown link, by the vault's link settings, to the file the item was taken
 * from, maybe with a subpath (a PDF selection) and an alias.
 */

/** The parts of a `source` link. */
export interface SourceLink {
  /**
   * How it is written: a wikilink, a markdown link with its target encoded,
   * or one with its target in angle brackets.
   */
  form: 'wiki' | 'markdown' | 'angled';
  /** The link's path, as written: shortest, relative or absolute. */
  path: string;
  /** From its `#` on, or empty. */
  subpath: string;
  /** Its display text, or null when it has none. */
  alias: string | null;
}

const WIKILINK = /^!?\[\[([^\]|#]*)(#[^\]|]*)?(?:\|([^\]]*))?\]\]$/;

/**
 * Characters Obsidian encodes in a markdown link's target (spaces and the
 * control characters among them: `YE` in its bundle), so a bare target never
 * holds one as written.
 */
const ENCODED_IN_TARGET = /[ \x00-\x1F]/;

/**
 * A markdown link's text and target: `[text](target)`, maybe `!`-prefixed,
 * with the target in angle brackets or bare. Null when `text` is not exactly
 * one. A bare target holds no character Obsidian would have encoded, and its
 * round brackets balance, as a file name's do (Obsidian leaves them
 * unencoded): `[a](b.pdf) (2nd ed)` is a link followed by more text, not one
 * link.
 *
 * Read by hand rather than by a regex: one that let the target run to the
 * last `)` backtracked in polynomial time on long runs of spaces, which a
 * synced or imported note could hold (user-approved security fix, 0026).
 * Every step here is a single pass, so time stays linear in the length.
 */
function readMarkdownLink(
  text: string
): { alias: string; target: string; angled: boolean } | null {
  const open = text.startsWith('!') ? 1 : 0;
  if (text[open] !== '[') return null;
  // The first `]` closes the text; with none, `close + 1` is the `[` or `!`.
  // The `(` after it can't be the final `)`, so the two never overlap.
  const close = text.indexOf(']');
  if (text[close + 1] !== '(' || !text.endsWith(')')) return null;
  const alias = text.slice(open + 1, close);
  const inner = text.slice(close + 2, -1).trim();

  if (inner.startsWith('<')) {
    // A lone `<` ends with no `>`, so `target` is what is between two
    const target = inner.slice(1, -1);
    if (!inner.endsWith('>') || target.includes('>')) return null;
    return { alias, target, angled: true };
  }
  if (ENCODED_IN_TARGET.test(inner)) return null;
  let depth = 0;
  for (const char of inner) {
    if (char === '(') depth += 1;
    else if (char === ')' && --depth < 0) return null;
  }
  return depth === 0 ? { alias, target: inner, angled: false } : null;
}

/**
 * `text` with each run of URL escapes in it decoded, and the rest as written:
 * Obsidian encodes only spaces, backslashes and control characters, so a `%`
 * that starts no escape is the name's own.
 */
function decoded(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (escapes) => {
    try {
      return decodeURIComponent(escapes);
    } catch {
      return escapes;
    }
  });
}

/**
 * The parts of `text` when it is a single wikilink or markdown link, as a
 * `source` property holds one; null when it is anything else.
 */
export function parseSourceLink(text: string): SourceLink | null {
  const trimmed = text.trim();
  const wikilink = WIKILINK.exec(trimmed);
  if (wikilink) {
    return {
      form: 'wiki',
      path: wikilink[1],
      subpath: wikilink[2] ?? '',
      alias: wikilink[3] ?? null,
    };
  }
  const markdown = readMarkdownLink(trimmed);
  if (!markdown) return null;
  // In angle brackets the target is written as is; otherwise URL-encoded
  const { angled, target } = markdown;
  const hash = target.indexOf('#');
  const path = hash < 0 ? target : target.slice(0, hash);
  const subpath = hash < 0 ? '' : target.slice(hash);
  return {
    form: angled ? 'angled' : 'markdown',
    path: angled ? path : decoded(path),
    subpath: angled ? subpath : decoded(subpath),
    alias: markdown.alias,
  };
}

/**
 * `link` written out as {@link parseSourceLink} reads it, the way Obsidian
 * writes one: a markdown link's target encoded only where Obsidian encodes it
 * (spaces, backslashes and control characters: `YE` in its bundle, read from
 * the app; undocumented), a wikilink's and an angled one's as they are.
 */
export function formatSourceLink({
  form,
  path,
  subpath,
  alias,
}: SourceLink): string {
  const target = path + subpath;
  if (form === 'wiki') {
    return `[[${target}${alias === null ? '' : `|${alias}`}]]`;
  }
  const written =
    form === 'angled'
      ? `<${target}>`
      : target.replace(/[\\\x00\x08\x0B\x0C\x0E-\x1F ]/g, (c) =>
          encodeURIComponent(c)
        );
  return `[${alias ?? ''}](${written})`;
}

/** The folder `path` is in, '' for the vault root. */
function folderOf(path: string): string {
  // With no `/`, up to -1: `substring` takes that as 0
  return path.substring(0, path.lastIndexOf('/'));
}

/** `relative` resolved from the folder `from`, as a vault path. */
function resolveRelative(relative: string, from: string): string {
  const parts = from === '' ? [] : from.split('/');
  for (const part of relative.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.' && part !== '') parts.push(part);
  }
  return parts.join('/');
}

/**
 * Whether the link path `linkPath`, in the note at `notePath`, names the file
 * at `path`: as the whole path, as a tail of it (Obsidian's shortest form), or
 * relative to the note's folder; a note's without its `.md`. Case is ignored,
 * as Obsidian ignores it in resolving a link.
 *
 * Asked of a link that may no longer resolve, since its file has moved on: it
 * tells only whether the link was written for `path`.
 */
export function linkNamesPath(
  linkPath: string,
  notePath: string,
  path: string
): boolean {
  const wanted = path.toLowerCase();
  const names = [wanted];
  if (wanted.endsWith('.md')) names.push(wanted.slice(0, -'.md'.length));

  let link = linkPath.trim().toLowerCase();
  if (link.startsWith('./') || link.startsWith('../')) {
    link = resolveRelative(link, folderOf(notePath.toLowerCase()));
    return names.includes(link);
  }
  link = link.replace(/^\/+/, '');
  return names.some((name) => name === link || name.endsWith(`/${link}`));
}

/**
 * The alias a link renamed from the file named `fromBasename` to the one named
 * `toBasename` should have: the new name where the old one was the alias, or
 * began a PDF page label (`name, page N`); otherwise the alias as written.
 */
export function retargetAlias(
  alias: string | null,
  fromBasename: string,
  toBasename: string
): string | null {
  if (alias === null) return null;
  if (alias === fromBasename) return toBasename;
  const pageLabel = `${fromBasename}, page `;
  if (alias.startsWith(pageLabel)) {
    return toBasename + alias.slice(fromBasename.length);
  }
  return alias;
}
