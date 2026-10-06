/**
 * Re-basing the links in a copy of a note. A link resolves from the note that
 * holds it, so a relative one breaks in a copy made in another folder, and one
 * by name alone can quietly mean another file there: Obsidian prefers a
 * namesake nearer the note. Each link that would resolve differently from the
 * copy is pointed at the file it resolved to from the original, or at the copy
 * where that was the original itself, keeping its form, subpath and alias.
 */
import type {
  CachedMetadata,
  FrontmatterLinkCache,
  ReferenceCache,
  TFile,
} from 'obsidian';
import { encodeLinkTarget } from './source-link';

/** What a note's metadata cache says of its links, and of where its text ends. */
export type LinkCacheSnapshot = Pick<
  CachedMetadata,
  'links' | 'embeds' | 'frontmatterLinks' | 'sections'
>;

/** A link in the original note, and the file it resolves to from there. */
export interface ResolvedLink {
  reference: ReferenceCache | FrontmatterLinkCache;
  target: TFile;
}

/** A frontmatter link to write again: the value at `key`, if it is `from`. */
export interface FrontmatterLinkEdit {
  key: string;
  from: string;
  to: string;
}

/** A link's path: its `link` up to its subpath. */
function pathOf(link: string): string {
  return link.split('#')[0];
}

/**
 * Whether `cache` was read from `text`: each link and embed is where it says,
 * as it says, and nothing but whitespace follows the last section, as nothing
 * else does in a note Obsidian has read. Without its sections, a cache can be
 * checked by its links alone.
 */
function describes(cache: LinkCacheSnapshot, text: string): boolean {
  const placed = [...(cache.links ?? []), ...(cache.embeds ?? [])];
  const inPlace = placed.every(
    ({ position, original }) =>
      text.slice(position.start.offset, position.end.offset) === original
  );
  if (!inPlace || !cache.sections) return inPlace;
  const end = cache.sections.at(-1)?.position.end.offset ?? 0;
  return end <= text.length && text.slice(end).trim() === '';
}

/**
 * Each link, embed and frontmatter link in `text` that resolves, by `resolve`,
 * from the note `text` is, with the file it resolves to: read from `cache`,
 * the note's metadata cache. Null when `cache` is missing (Obsidian has not
 * read the note yet) or was read from other text (the note has changed since),
 * since its offsets then say nothing of where the links in `text` are.
 */
export function resolveLinks(
  text: string,
  cache: LinkCacheSnapshot | null,
  resolve: (linkpath: string) => TFile | null
): ResolvedLink[] | null {
  if (!cache || !describes(cache, text)) return null;
  const resolved: ResolvedLink[] = [];
  for (const reference of [
    ...(cache.links ?? []),
    ...(cache.embeds ?? []),
    ...(cache.frontmatterLinks ?? []),
  ]) {
    const target = resolve(pathOf(reference.link));
    if (target) resolved.push({ reference, target });
  }
  return resolved;
}

/**
 * Where a link's path is in the text of the link, and what it reads as there;
 * `markdown` when it is a markdown link's, which Obsidian reads unescaped and
 * URL-decoded, in angle brackets or not.
 */
interface PathSpan {
  start: number;
  end: number;
  path: string;
  markdown: boolean;
}

/** The span from `start` to `end` of `text`, less whitespace either side. */
function trimmedSpan(
  text: string,
  start: number,
  end: number,
  markdown: boolean
): PathSpan {
  const raw = text.slice(start, end);
  const from = start + raw.length - raw.trimStart().length;
  const path = raw.trim();
  return { start: from, end: from + path.length, path, markdown };
}

/** The span from `start` to `end`, up to a subpath in it. */
function beforeSubpath(
  text: string,
  start: number,
  end: number,
  markdown: boolean
): PathSpan {
  const hash = text.slice(start, end).indexOf('#');
  return trimmedSpan(text, start, hash < 0 ? end : start + hash, markdown);
}

/**
 * The path of `link` when it is a wikilink: up to its subpath and its alias,
 * which a `\|` begins in a table, as Obsidian reads one (`$E` in its bundle).
 */
function wikilinkPath(link: string): PathSpan | null {
  const open = link.startsWith('!') ? 3 : 2;
  if (!link.startsWith('[[', open - 2) || !link.endsWith(']]')) return null;
  const pipe = link.indexOf('|', open);
  const end =
    pipe < 0 ? link.length - 2 : link[pipe - 1] === '\\' ? pipe - 1 : pipe;
  return beforeSubpath(link, open, end, false);
}

/**
 * Where a markdown link's target starts: after the `](` that closes its text,
 * which may hold brackets of its own, as a linked image's does
 * (`[![alt](img.png)](note.md)`). Null when `link` is no markdown link.
 */
function markdownTargetStart(link: string): number | null {
  const bang = link.startsWith('!') ? 1 : 0;
  if (link[bang] !== '[' || !link.endsWith(')')) return null;
  let depth = 0;
  for (let at = bang; at < link.length; at += 1) {
    const char = link[at];
    if (char === '\\') at += 1;
    else if (char === '[') depth += 1;
    else if (char === ']' && --depth === 0) {
      return link[at + 1] === '(' ? at + 2 : null;
    }
  }
  return null;
}

/**
 * The path of `link` when it is a markdown link: its target up to a subpath,
 * in angle brackets or bare, then ending at a space (a title follows). Read by
 * hand: a regex that let the target run on backtracks badly on long runs of
 * spaces (see `readMarkdownLink` in `source-link.ts`).
 */
function markdownPath(link: string): PathSpan | null {
  const opened = markdownTargetStart(link);
  if (opened === null) return null;
  const close = link.length - 1;
  const inner = link.slice(opened, close);
  const start = close - inner.trimStart().length;
  if (link[start] === '<') {
    const end = link.indexOf('>', start);
    return end < 0 ? null : beforeSubpath(link, start + 1, end, true);
  }
  const space = link.slice(start, close).search(/\s/);
  return beforeSubpath(link, start, space < 0 ? close : start + space, true);
}

/**
 * `path` as Obsidian reads a link's: a markdown link's with its backslash
 * escapes undone and URL-decoded, then any normalized (`GE` in its bundle).
 */
function readPath({ path, markdown }: PathSpan): string {
  let read = path;
  if (markdown) {
    read = read.replace(/\\([!-/:-@[-`{-~])/g, '$1');
    try {
      read = decodeURI(read);
    } catch {
      // Obsidian reads no link here; nor does the cache, so none matches
    }
  }
  return read.replace(/\u00A0/g, ' ').normalize('NFC');
}

/** Whether the round brackets in `text` balance. */
function balanced(text: string): boolean {
  let depth = 0;
  for (const char of text) {
    if (char === '(') depth += 1;
    else if (char === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

/**
 * `path` as a markdown link holds it: its `%` escaped, which Obsidian decodes
 * before it reads the link, and when bare, encoded as Obsidian encodes one,
 * its round brackets too when they don't balance, as a bare target's must
 * not to end early.
 */
function markdownTarget(path: string, angled: boolean): string {
  const escaped = path.replace(/%/g, '%25');
  if (angled) return escaped;
  const encoded = encodeLinkTarget(escaped);
  return balanced(encoded)
    ? encoded
    : encoded.replace(/[()]/g, (bracket) => (bracket === '(' ? '%28' : '%29'));
}

/**
 * Where in `link` its path is, which reads as `linkpath`, and what to write
 * there instead: the path `pathFor` gives for its form (a wikilink's, or a
 * markdown link's, whose `.md` it keeps), as that form holds one. Null when
 * `link` is not a link whose path reads as `linkpath`, or `pathFor` has none:
 * one this can't read is left as it is rather than written at a guess.
 */
function relink(
  link: string,
  linkpath: string,
  pathFor: (wikilink: boolean) => string | null
): { start: number; end: number; path: string } | null {
  const span = wikilinkPath(link) ?? markdownPath(link);
  if (!span || readPath(span) !== linkpath) return null;
  const path = pathFor(!span.markdown);
  if (path === null) return null;
  return {
    start: span.start,
    end: span.end,
    path: span.markdown
      ? markdownTarget(path, link[span.start - 1] === '<')
      : path,
  };
}

/**
 * `text`, the original note `original`'s, with each of `links` (see
 * {@link resolveLinks}) that would resolve otherwise from `copy` rewritten so
 * it resolves from there, by `resolve`, to the file it did from `original`,
 * or to `copy` when that was `original` itself: in the form it had, with its
 * subpath, alias and all else as written, and its path as `linktext` writes
 * one from `copy` in the vault's link format. Only a link's path is written,
 * so a link inside another's text, as a linked image is, is re-based as well.
 * Everything else in `text` is kept as it is. A frontmatter link isn't placed
 * in `text` by its cache, so it is given as an edit to its property instead.
 * `missed` counts the links that needed re-basing and are left as written.
 */
export function rebaseLinks(
  text: string,
  links: readonly ResolvedLink[],
  {
    original,
    copy,
    resolve,
    linktext,
  }: {
    original: TFile;
    copy: TFile;
    resolve: (linkpath: string) => TFile | null;
    linktext: (file: TFile, omitMd: boolean) => string;
  }
): { text: string; frontmatter: FrontmatterLinkEdit[]; missed: number } {
  const splices: { start: number; end: number; text: string }[] = [];
  const frontmatter: FrontmatterLinkEdit[] = [];
  let missed = 0;
  for (const { reference, target } of links) {
    const want = target === original ? copy : target;
    const linkpath = pathOf(reference.link);
    if (resolve(linkpath) === want) continue;
    // A path with a `#` in it is read only up to it
    const leadsThere = (path: string) =>
      pathOf(path) === path && resolve(path) === want;
    const next = relink(reference.original, linkpath, (wikilink) => {
      // A note without its `.md` in a wikilink only, as Obsidian writes one
      const written = linktext(want, wikilink);
      if (leadsThere(written)) return written;
      // Its relative format names a file in the copy's own folder alone,
      // which a namesake at the vault root takes: the whole path is matched
      // before any file is by its name
      const whole =
        wikilink && want.extension === 'md'
          ? want.path.slice(0, -'.md'.length)
          : want.path;
      return leadsThere(whole) ? whole : null;
    });
    if (next === null) {
      missed += 1;
    } else if ('position' in reference) {
      const at = reference.position.start.offset;
      splices.push({
        start: at + next.start,
        end: at + next.end,
        text: next.path,
      });
    } else {
      const { key, original: from } = reference;
      const to = from.slice(0, next.start) + next.path + from.slice(next.end);
      frontmatter.push({ key, from, to });
    }
  }

  // In one pass from the start, each path's offsets being the original's
  splices.sort((a, b) => a.start - b.start);
  const pieces: string[] = [];
  let at = 0;
  for (const splice of splices) {
    pieces.push(text.slice(at, splice.start), splice.text);
    at = splice.end;
  }
  pieces.push(text.slice(at));
  return { text: pieces.join(''), frontmatter, missed };
}

/**
 * Write each of `edits` into `frontmatter`: the value at its key, as Obsidian
 * keys a frontmatter link (each property, list index and nested key joined by
 * `.`), becomes its `to` when it is its `from`. A key a `.` in a property's
 * name makes ambiguous is told apart by that value.
 */
export function applyFrontmatterLinkEdits(
  frontmatter: Record<string, unknown>,
  edits: readonly FrontmatterLinkEdit[]
): void {
  const visit = (holder: Record<string, unknown>, prefix: string) => {
    for (const [name, value] of Object.entries(holder)) {
      const key = prefix === '' ? name : `${prefix}.${name}`;
      if (typeof value === 'string') {
        const edit = edits.find((e) => e.key === key && e.from === value);
        if (edit) holder[name] = edit.to;
      } else if (value !== null && typeof value === 'object') {
        visit(value as Record<string, unknown>, key);
      }
    }
  };
  visit(frontmatter, '');
}
