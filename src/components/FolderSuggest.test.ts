// @vitest-environment jsdom
import { DATA_DIRECTORY } from '#/lib/constants';
import fc from 'fast-check';
import { TFolder, type App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FolderSuggest, type FolderSuggestOptions } from './FolderSuggest';

// #region HELPERS
function makeFolder(path: string): TFolder {
  return Object.assign(new TFolder(), {
    path,
    name: path === '/' ? '' : path.slice(path.lastIndexOf('/') + 1),
  });
}

/**
 * A suggest over a vault holding `paths`, the root among them only when
 * `getAllFolders` is asked to include it, as Obsidian's does.
 */
function makeSuggest(paths: readonly string[], options?: FolderSuggestOptions) {
  const getAllFolders = vi.fn((includeRoot?: boolean) =>
    paths.filter((path) => includeRoot === true || path !== '/').map(makeFolder)
  );
  const app = { vault: { getAllFolders } } as unknown as App;
  const suggest = new FolderSuggest(
    app,
    document.createElement('input'),
    options
  );
  return { suggest, getAllFolders };
}

/** A folder name: mixed case, sometimes the data directory's or like it. */
const nameArb = fc.oneof(
  fc.mixedCase(fc.constantFrom('a', 'b', 'Notes', 'notes', 'x y')),
  fc.constantFrom(DATA_DIRECTORY, `${DATA_DIRECTORY}-old`, '!', 'é')
);

/**
 * Folder paths in vault order, the vault root among them or not, anywhere:
 * the vault's order is not the list's.
 */
const pathsArb = fc
  .tuple(
    fc.option(fc.nat(), { nil: undefined }),
    fc.uniqueArray(
      fc
        .array(nameArb, { minLength: 1, maxLength: 3 })
        .map((names) => names.join('/')),
      { maxLength: 12 }
    )
  )
  .map(([root, paths]) => {
    if (root === undefined) return paths;
    const at = root % (paths.length + 1);
    return [...paths.slice(0, at), '/', ...paths.slice(at)];
  });

const inDataDirectory = (path: string) =>
  path === DATA_DIRECTORY || path.startsWith(`${DATA_DIRECTORY}/`);
// #endregion

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FolderSuggest', () => {
  it("suggests every folder whose path holds the query, in any case, but the data directory's", () => {
    fc.assert(
      fc.property(
        pathsArb,
        fc.oneof(
          fc.string({ maxLength: 3 }),
          fc.mixedCase(fc.constantFrom('a', 'notes', '/', 'x y', 'é'))
        ),
        fc.constantFrom('', ' ', '  \t'),
        (paths, query, padding) => {
          const { suggest } = makeSuggest(paths);

          const suggested = suggest
            .getSuggestions(padding + query + padding)
            .map((folder) => folder.path);

          const wanted = paths.filter(
            (path) =>
              !inDataDirectory(path) &&
              path.toLowerCase().includes(query.trim().toLowerCase())
          );
          expect([...suggested].sort()).toEqual([...wanted].sort());
        }
      )
    );
  });

  it('suggests the vault root first and the rest in path order', () => {
    fc.assert(
      fc.property(pathsArb, (paths) => {
        const { suggest, getAllFolders } = makeSuggest(paths);

        const suggested = suggest.getSuggestions('').map((f) => f.path);

        expect(getAllFolders).toHaveBeenCalledExactlyOnceWith(true);
        const rest = suggested.filter((path) => path !== '/');
        expect(suggested).toEqual(paths.includes('/') ? ['/', ...rest] : rest);
        for (let i = 1; i < rest.length; i++) {
          expect(rest[i - 1].localeCompare(rest[i])).toBeLessThan(0);
        }
      })
    );
  });

  it('puts the vault root ahead of a folder whose name sorts before `/`', () => {
    const { suggest } = makeSuggest(['!', '/']);

    expect(suggest.getSuggestions('').map((f) => f.path)).toEqual(['/', '!']);
  });

  it('offers the vault root for `/`, ahead of folders below the top level', () => {
    const { suggest } = makeSuggest(['b/c', 'a', '/', 'a/b']);

    expect(suggest.getSuggestions('/').map((f) => f.path)).toEqual([
      '/',
      'a/b',
      'b/c',
    ]);
  });

  it('shows a folder by its path', () => {
    fc.assert(
      fc.property(pathsArb, (paths) => {
        const { suggest } = makeSuggest(paths);
        for (const folder of suggest.getSuggestions('')) {
          const el = document.createElement('div');
          suggest.renderSuggestion(folder, el);
          expect(el.textContent).toBe(folder.path);
        }
      })
    );
  });

  it('leaves out the vault root when told to, and every folder `exclude` names, asking it afresh each time', () => {
    fc.assert(
      fc.property(
        pathsArb,
        fc.option(fc.boolean(), { nil: undefined }),
        fc.func(fc.boolean()),
        (paths, includeRoot, excluded) => {
          let excluding = true;
          const exclude = vi.fn((path: string) => excluding && excluded(path));
          const { suggest, getAllFolders } = makeSuggest(paths, {
            includeRoot,
            exclude,
          });

          const suggested = suggest.getSuggestions('').map((f) => f.path);

          expect(getAllFolders).toHaveBeenCalledExactlyOnceWith(
            includeRoot ?? true
          );
          const wanted = paths.filter(
            (path) =>
              (includeRoot !== false || path !== '/') &&
              !inDataDirectory(path) &&
              !excluded(path)
          );
          expect([...suggested].sort()).toEqual([...wanted].sort());
          excluding = false;
          expect(suggest.getSuggestions('')).toHaveLength(
            paths.filter(
              (path) =>
                (includeRoot !== false || path !== '/') &&
                !inDataDirectory(path)
            ).length
          );
        }
      )
    );
  });
});
