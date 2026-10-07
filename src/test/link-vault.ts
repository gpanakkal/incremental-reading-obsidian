import type { SectionCache, TFile } from 'obsidian';
import { vi } from 'vitest';
import { noteText } from './note-text';

/** The "New link format" setting: how Obsidian writes a new link's path. */
export type LinkFormat = 'shortest' | 'relative' | 'absolute';

/**
 * A vault of files, the notes among them with frontmatter, that resolves links
 * as Obsidian's `MetadataCache.getLinkpathDest` does (read from its bundle):
 * candidates are the files with the link's name, a note's without its `.md`;
 * a lone name with one candidate is that file; a link starting `./` or `../`
 * is first tried relative to the note; then the whole path, from the root;
 * a link starting with `/` resolves no further; otherwise any file whose path
 * ends with the link's, those under the note's folder first, shorter paths
 * first. Case is ignored, spaces around a link not. New links are written in
 * `linkFormat`, as `MetadataCache.fileToLinktext` writes them (full paths by
 * default). `processFrontMatter` edits a note's frontmatter in place, and the
 * metadata cache and `cachedRead` read it as it is.
 */
export function makeLinkVault(
  notes: Record<string, Record<string, unknown> | null> = {},
  { linkFormat = 'absolute' }: { linkFormat?: LinkFormat } = {}
) {
  const files = new Map<string, TFile>();
  const frontmatter = new Map<string, Record<string, unknown>>();

  const add = (path: string, fm: Record<string, unknown> | null = null) => {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    const file = {
      path,
      name,
      basename: dot > 0 ? name.slice(0, dot) : name,
      extension: dot > 0 ? name.slice(dot + 1) : '',
    } as TFile;
    files.set(path, file);
    if (fm) frontmatter.set(path, fm);
    return file;
  };
  for (const [path, fm] of Object.entries(notes)) add(path, fm);

  const folderOf = (path: string) => path.substring(0, path.lastIndexOf('/'));
  const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
  const named = (name: string) =>
    [...files.values()].filter((file) => file.name.toLowerCase() === name);
  const byLength = (a: TFile, b: TFile) => a.path.length - b.path.length;

  /** Every file `link` may mean from `sourcePath`, the one it means first. */
  const resolveAll = (link: string, sourcePath: string): TFile[] => {
    if (link === '') {
      const source = files.get(sourcePath);
      return source ? [source] : [];
    }
    // As written: Obsidian's resolver trims nothing either
    let wanted = link.toLowerCase();
    let name = nameOf(wanted);
    let candidates = name.includes('.') ? named(name) : [];
    if (candidates.length === 0) {
      wanted = `${link}.md`.toLowerCase();
      name = nameOf(wanted);
      candidates = named(name);
    }
    if (candidates.length === 0) return [];
    if (name === wanted && candidates.length === 1) return candidates;

    // A relative link moves the folder its tail is preferred under, with a
    // trailing `/`, as Obsidian's does
    let folder = folderOf(sourcePath).toLowerCase();
    const exactly = (path: string) =>
      candidates.find((file) => file.path.toLowerCase() === path);
    if (wanted.startsWith('./') || wanted.startsWith('../')) {
      if (wanted.startsWith('./../')) wanted = wanted.slice(2);
      if (wanted.startsWith('./')) {
        wanted = wanted.slice(2);
      } else {
        while (wanted.startsWith('../')) {
          wanted = wanted.slice(3);
          folder = folderOf(folder);
        }
      }
      if (folder !== '') folder += '/';
      wanted = folder + wanted;
      const found = exactly(wanted);
      if (found) return [found];
    }
    if (wanted.startsWith('/')) wanted = wanted.slice(1);
    const found = exactly(wanted);
    if (found) return [found];
    if (link.startsWith('/')) return [];

    const near: TFile[] = [];
    const far: TFile[] = [];
    for (const file of candidates) {
      const path = file.path.toLowerCase();
      if (!path.endsWith(wanted)) continue;
      (path.startsWith(folder) ? near : far).push(file);
    }
    return [...near.sort(byLength), ...far.sort(byLength)];
  };
  const resolve = (link: string, sourcePath: string): TFile | null =>
    resolveAll(link, sourcePath)[0] ?? null;

  /** As `MetadataCache.fileToLinktext` writes a link, in `linkFormat`. */
  const fileToLinktext = (file: TFile, sourcePath: string, omitMd = true) => {
    const dropMd = omitMd && file.extension === 'md';
    const full = dropMd ? file.path.slice(0, -'.md'.length) : file.path;
    if (linkFormat === 'absolute') return full;
    if (linkFormat === 'relative') {
      let up = '';
      let folder = folderOf(sourcePath);
      while (folder !== '' && !full.startsWith(`${folder}/`)) {
        up = `../${up}`;
        folder = folderOf(folder);
      }
      return full.startsWith(`${folder}/`)
        ? up + full.slice(folder.length + 1)
        : up + full;
    }
    const name = dropMd ? file.basename : file.name;
    const dests = resolveAll(name, sourcePath);
    return dests.length === 1 && dests[0] === file ? name : full;
  };

  const processFrontMatter = vi.fn(
    async (file: TFile, edit: (fm: Record<string, unknown>) => void) => {
      const fm = frontmatter.get(file.path) ?? {};
      edit(fm);
      frontmatter.set(file.path, fm);
    }
  );
  const app = {
    vault: {
      getFileByPath: (path: string) => files.get(path) ?? null,
      cachedRead: vi.fn(async (file: TFile) =>
        noteText(frontmatter.get(file.path) ?? null)
      ),
    },
    metadataCache: {
      getFileCache: vi.fn((file: TFile) => {
        const fm = frontmatter.get(file.path);
        return fm ? { frontmatter: structuredClone(fm) } : null;
      }),
      getFirstLinkpathDest: vi.fn(resolve),
      fileToLinktext: vi.fn(fileToLinktext),
    },
    fileManager: { processFrontMatter },
  };

  /** Move the file at `from` to `to`, as Obsidian does before it fires `rename`. */
  const move = (from: string, to: string) => {
    const file = files.get(from)!;
    files.delete(from);
    const fm = frontmatter.get(from);
    frontmatter.delete(from);
    const moved = add(to, fm ?? null);
    // The same file object, as Obsidian keeps it
    Object.assign(file, moved);
    files.set(to, file);
    return file;
  };

  return {
    app,
    files,
    add,
    move,
    resolve,
    processFrontMatter,
    sourceOf: (path: string) => frontmatter.get(path)?.source,
  };
}

/** A position in a note as its metadata cache gives one, by offset alone. */
export function cachePosition(start: number, end: number) {
  return {
    start: { line: 0, col: 0, offset: start },
    end: { line: 0, col: 0, offset: end },
  };
}

/**
 * The sections a metadata cache read from `text` gives it, as far as where
 * its text ends goes: one, from the start to its last text.
 */
export function sectionsOf(text: string): SectionCache[] {
  return [
    { type: 'paragraph', position: cachePosition(0, text.trimEnd().length) },
  ];
}
