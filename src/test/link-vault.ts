import type { TFile } from 'obsidian';
import { vi } from 'vitest';

/**
 * A vault of files, the notes among them with frontmatter, that resolves links
 * as Obsidian does closely enough for tests of following them: by the whole
 * path or a tail of it, relative to the note with `./` or `../`, from the root
 * with a leading `/` (whole path only), and a note's without its `.md`; case ignored, spaces around it not. New links are written by
 * full path. `processFrontMatter` edits a note's frontmatter in place, and the
 * metadata cache reads it as it is.
 */
export function makeLinkVault(
  notes: Record<string, Record<string, unknown> | null> = {}
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
  const resolve = (link: string, sourcePath: string): TFile | null => {
    // As written: Obsidian's resolver trims nothing either
    let wanted = link.toLowerCase();
    // From the vault root: the whole path only
    let relative = wanted.startsWith('/');
    if (wanted.startsWith('./') || wanted.startsWith('../')) {
      relative = true;
      const parts = folderOf(sourcePath.toLowerCase())
        .split('/')
        .filter(Boolean);
      for (const part of wanted.split('/')) {
        if (part === '..') parts.pop();
        else if (part !== '.' && part !== '') parts.push(part);
      }
      wanted = parts.join('/');
    } else {
      wanted = wanted.replace(/^\/+/, '');
    }
    if (wanted === '') return null;
    for (const file of files.values()) {
      const path = file.path.toLowerCase();
      for (const name of [path, path.replace(/\.md$/, '')]) {
        if (name === wanted || (!relative && name.endsWith(`/${wanted}`))) {
          return file;
        }
      }
    }
    return null;
  };

  const processFrontMatter = vi.fn(
    async (file: TFile, edit: (fm: Record<string, unknown>) => void) => {
      const fm = frontmatter.get(file.path) ?? {};
      edit(fm);
      frontmatter.set(file.path, fm);
    }
  );
  const app = {
    vault: { getFileByPath: (path: string) => files.get(path) ?? null },
    metadataCache: {
      getFileCache: vi.fn((file: TFile) => {
        const fm = frontmatter.get(file.path);
        return fm ? { frontmatter: structuredClone(fm) } : null;
      }),
      getFirstLinkpathDest: vi.fn(resolve),
      fileToLinktext: vi.fn((file: TFile, _from: string, omitMd = true) =>
        omitMd && file.extension === 'md' ? file.path.slice(0, -3) : file.path
      ),
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
    processFrontMatter,
    sourceOf: (path: string) => frontmatter.get(path)?.source,
  };
}
