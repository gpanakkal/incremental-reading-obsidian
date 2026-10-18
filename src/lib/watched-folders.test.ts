import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DATA_DIRECTORY } from './constants';
import {
  cleanFolderList,
  folderToWatchProblem,
  isUnderAnyFolder,
  isUnderFolder,
  normalizeFolderPath,
  watchListProblem,
} from './watched-folders';

// #region HELPERS

/**
 * A file or folder name. Drawn often from names that are prefixes of each
 * other (`In`, `Inbox`, `Inbox2`), so near misses come up, and otherwise any
 * name a vault path can hold: no slash, nothing trimmed away, commas and line
 * breaks inside it included.
 */
const nameArb = fc.oneof(
  fc.constantFrom(
    'In',
    'Inbox',
    'Inbox2',
    'Inbox.md',
    'a b',
    'a, b',
    'a\nb',
    DATA_DIRECTORY
  ),
  fc
    .string({ minLength: 1, maxLength: 6 })
    .filter((name) => !name.includes('/') && name.trim() === name)
);

/** The names along a vault path, outermost first. */
const segmentsArb = fc.array(nameArb, { minLength: 1, maxLength: 4 });

/** A vault path: names joined by slashes, never one at either end. */
const pathArb = segmentsArb.map((segments) => segments.join('/'));

/** Whether the path made of `inner` lies inside the one made of `outer`. */
const nests = (inner: readonly string[], outer: readonly string[]) =>
  outer.length < inner.length &&
  outer.every((segment, index) => inner[index] === segment);

/** Spaces and slashes a typed path may carry around it. */
const paddingArb = fc
  .array(fc.constantFrom(' ', '/', '\t', '\n', '\u00a0'), { maxLength: 3 })
  .map((chars) => chars.join(''));

/** Any typing of `path`: padded by spaces and slashes either side. */
const typedPathArb = (path: string) =>
  fc
    .tuple(paddingArb, paddingArb)
    .map(([before, after]) => `${before}${path}${after}`);

/** Typing that names the vault root: slashes, perhaps among spaces, or blank. */
const rootTypedArb = fc
  .tuple(paddingArb, fc.constantFrom('', '/', '//'), paddingArb)
  .map((parts) => parts.join(''));

/** Something typed, and the vault path it names (`''` for the root). */
const typedFolderArb = fc.oneof(
  pathArb.chain((path) =>
    typedPathArb(path).map((typed) => ({ typed, folder: path }))
  ),
  rootTypedArb.map((typed) => ({ typed, folder: '' }))
);

/** Whether `folder` is the data folder or inside it. */
const inDataFolder = (folder: string) =>
  folder === DATA_DIRECTORY || folder.startsWith(`${DATA_DIRECTORY}/`);

// #endregion

describe('isUnderFolder', () => {
  it('holds exactly for paths inside the folder, at any depth', () => {
    fc.assert(
      fc.property(segmentsArb, segmentsArb, (path, folder) => {
        expect(isUnderFolder(path.join('/'), folder.join('/'))).toBe(
          nests(path, folder)
        );
      })
    );
  });

  it('holds for every path inside the folder, its subfolders included', () => {
    fc.assert(
      fc.property(segmentsArb, segmentsArb, (folder, rest) => {
        const path = [...folder, ...rest].join('/');
        expect(isUnderFolder(path, folder.join('/'))).toBe(true);
      })
    );
  });

  it('never holds for a folder whose name only begins the same', () => {
    expect(isUnderFolder('Inbox2/note.md', 'Inbox')).toBe(false);
    expect(isUnderFolder('Inbox.md', 'Inbox')).toBe(false);
    expect(isUnderFolder('Inbox', 'Inbox')).toBe(false);
  });

  it('never holds for the vault root', () => {
    fc.assert(
      fc.property(pathArb, (path) => {
        expect(isUnderFolder(path, '')).toBe(false);
      })
    );
  });
});

describe('isUnderAnyFolder', () => {
  it('holds when the path is inside at least one of the folders', () => {
    fc.assert(
      fc.property(
        segmentsArb,
        fc.array(segmentsArb, { maxLength: 4 }),
        (path, folders) => {
          expect(
            isUnderAnyFolder(
              path.join('/'),
              folders.map((folder) => folder.join('/'))
            )
          ).toBe(folders.some((folder) => nests(path, folder)));
        }
      )
    );
  });
});

describe('isUnderAnyFolder, among other folders', () => {
  it('holds for a path inside one of the folders, wherever it is listed', () => {
    fc.assert(
      fc.property(
        segmentsArb,
        segmentsArb,
        fc.array(pathArb, { maxLength: 3 }),
        fc.nat(),
        (folder, rest, others, at) => {
          const folders = [...others];
          folders.splice(at % (others.length + 1), 0, folder.join('/'));

          expect(
            isUnderAnyFolder([...folder, ...rest].join('/'), folders)
          ).toBe(true);
        }
      )
    );
  });
});

describe('normalizeFolderPath', () => {
  it('reads typed text as the path it names, without the padding around it', () => {
    fc.assert(
      fc.property(typedFolderArb, ({ typed, folder }) => {
        expect(normalizeFolderPath(typed)).toBe(folder);
      })
    );
  });

  it('keeps commas and line breaks inside a path as part of it', () => {
    expect(normalizeFolderPath(' /a, b/ ')).toBe('a, b');
    expect(normalizeFolderPath('/c\nd/e/')).toBe('c\nd/e');
    expect(normalizeFolderPath('// ')).toBe('');
  });
});

describe('cleanFolderList', () => {
  it('keeps each folder named once, in order, without padding or the root', () => {
    fc.assert(
      fc.property(fc.array(typedFolderArb, { maxLength: 6 }), (entries) => {
        const named = entries
          .map(({ folder }) => folder)
          .filter((folder) => folder !== '');

        expect(cleanFolderList(entries.map(({ typed }) => typed))).toEqual([
          ...new Set(named),
        ]);
      })
    );
  });

  it('leaves the list it is given as it was', () => {
    const given = [' Inbox/', 'Inbox', '/'];

    cleanFolderList(given);

    expect(given).toEqual([' Inbox/', 'Inbox', '/']);
  });
});

describe('folderToWatchProblem', () => {
  /** Why `folder` can't be watched, by which check refuses it. */
  const reason = (folder: string, exists: boolean) =>
    folder === ''
      ? 'root'
      : inDataFolder(folder)
        ? 'data'
        : exists
          ? undefined
          : 'missing';

  /** Any folder: in the vault, the root, or the data folder or one in it. */
  const anyFolderArb = fc.oneof(
    pathArb,
    fc.constant(''),
    fc.constantFrom(DATA_DIRECTORY, `${DATA_DIRECTORY}/x`),
    segmentsArb.map((rest) => [DATA_DIRECTORY, ...rest].join('/'))
  );

  it('accepts exactly a folder that exists, other than the root and the data folder, and names any other it refuses', () => {
    fc.assert(
      fc.property(anyFolderArb, fc.boolean(), (folder, exists) => {
        const asked: string[] = [];
        const message = folderToWatchProblem(folder, (path) => {
          asked.push(path);
          return exists;
        });

        const why = reason(folder, exists);
        if (why === undefined) {
          expect(message).toBeUndefined();
        } else {
          expect(message).toEqual(expect.stringMatching(/\S/));
          if (why !== 'root') expect(message).toContain(folder);
        }
        // The vault is asked only about a folder that could be watched
        expect(asked).toEqual(
          folder === '' || inDataFolder(folder) ? [] : [folder]
        );
      })
    );
  });

  it('gives each reason for refusing a folder its own message', () => {
    fc.assert(
      fc.property(anyFolderArb, anyFolderArb, fc.boolean(), (a, b, exists) => {
        const reasonA = reason(a, exists);
        const reasonB = reason(b, exists);
        fc.pre(reasonA !== reasonB);

        expect(folderToWatchProblem(a, () => exists)).not.toBe(
          folderToWatchProblem(b, () => exists)
        );
      })
    );
  });

  it('accepts a folder whose name only begins like the data folder', () => {
    expect(
      folderToWatchProblem(`${DATA_DIRECTORY}2`, () => true)
    ).toBeUndefined();
    expect(
      folderToWatchProblem(`${DATA_DIRECTORY}2/x`, () => true)
    ).toBeUndefined();
  });
});

describe('watchListProblem', () => {
  it('refuses an empty list only while watching is on', () => {
    fc.assert(
      fc.property(
        fc.array(pathArb, { maxLength: 3 }),
        fc.boolean(),
        (folders, watching) => {
          const message = watchListProblem(folders, watching);

          if (watching && folders.length === 0) {
            expect(message).toEqual(expect.stringMatching(/\S/));
          } else {
            expect(message).toBeUndefined();
          }
        }
      )
    );
  });
});
