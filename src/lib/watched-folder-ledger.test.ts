import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ledgerArrivals,
  loadWatchedFolderLedger,
  parseLedger,
  reconcileLedger,
  saveWatchedFolderLedger,
  WATCHED_FOLDER_LEDGER_KEY,
  type WatchedFolderLedger,
} from './watched-folder-ledger';

// #region HELPERS

/**
 * A path segment, drawn mostly from a few names so paths nest in and collide
 * with one another, `Inbox2` beside `Inbox` included.
 */
const segmentArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom('Inbox', 'Inbox2', 'Clips', 'a') },
  { weight: 2, arbitrary: fc.constantFrom('note.md', 'paper.pdf', 'a b,c') },
  { weight: 1, arbitrary: fc.string({ minLength: 1 }) }
);

/** A vault path some levels deep. */
const pathArb = fc
  .array(segmentArb, { minLength: 1, maxLength: 4 })
  .map((segments) => segments.join('/'));

/** A watched folder's vault path, as `cleanFolderList` keeps them. */
const folderArb = fc
  .array(segmentArb, { minLength: 1, maxLength: 2 })
  .map((segments) => segments.join('/'));

const foldersArb = fc.uniqueArray(folderArb, { maxLength: 4 });

/** The files in a vault, each path once. */
const pathsArb = fc.uniqueArray(pathArb, { maxLength: 12 });

const ledgerArb: fc.Arbitrary<WatchedFolderLedger> = fc.record({
  folders: foldersArb,
  paths: pathsArb,
});

/** Whether `path` is inside `folder`, said apart from the code under test. */
const inside = (path: string, folder: string) =>
  path.length > folder.length + 1 &&
  path.slice(0, folder.length + 1) === `${folder}/`;

const insideAny = (path: string, folders: readonly string[]) =>
  folders.some((folder) => inside(path, folder));

/** A device's localStorage, as Obsidian's helpers keep it: JSON. */
function makeStorage() {
  const stored = new Map<string, string>();
  return {
    stored,
    app: {
      loadLocalStorage: (key: string): unknown => {
        const text = stored.get(key);
        return text === undefined ? null : (JSON.parse(text) as unknown);
      },
      saveLocalStorage: (key: string, data: unknown) => {
        stored.set(key, JSON.stringify(data));
      },
    },
  };
}

// #endregion

describe('parseLedger', () => {
  it('reads a ledger as it is', () => {
    fc.assert(
      fc.property(
        ledgerArb,
        fc.dictionary(fc.string(), fc.anything()),
        (ledger, extra) => {
          expect(parseLedger({ ...extra, ...ledger })).toEqual(ledger);
        }
      )
    );
  });

  it('reads anything that is not wholly a ledger as none', () => {
    const notStrings = fc
      .array(fc.anything())
      .filter((items) => items.some((item) => typeof item !== 'string'));
    const partArb = fc.oneof(fc.array(fc.string()), notStrings, fc.anything());
    fc.assert(
      fc.property(
        fc.oneof(
          fc.anything(),
          fc.record({ folders: partArb, paths: partArb }),
          fc.record({ folders: partArb }),
          fc.record({ paths: partArb })
        ),
        (raw) => {
          const record = raw as Partial<Record<string, unknown>> | null;
          const valid =
            typeof raw === 'object' &&
            raw !== null &&
            [record?.folders, record?.paths].every(
              (part) =>
                Array.isArray(part) &&
                part.every((item) => typeof item === 'string')
            );
          expect(parseLedger(raw) !== null).toBe(valid);
        }
      )
    );
  });

  it.each([
    [null],
    [undefined],
    ['ledger'],
    [0],
    [[]],
    [[['Inbox'], ['Inbox/a.md']]],
  ])('reads %j as none', (raw: unknown) => {
    expect(parseLedger(raw)).toBeNull();
  });
});

describe('ledgerArrivals', () => {
  it('yields exactly the files under a watched folder the ledger records that it has not seen, in vault order', () => {
    fc.assert(
      fc.property(ledgerArb, foldersArb, pathsArb, (ledger, folders, paths) => {
        const recorded = folders.filter((folder) =>
          ledger.folders.includes(folder)
        );
        expect(ledgerArrivals(ledger, folders, paths)).toEqual(
          paths.filter(
            (path) => insideAny(path, recorded) && !ledger.paths.includes(path)
          )
        );
      })
    );
  });

  it('yields nothing from a folder the ledger does not record, however new its files', () => {
    fc.assert(
      fc.property(foldersArb, pathsArb, (folders, paths) => {
        const ledger = { folders: [], paths: [] };
        expect(ledgerArrivals(ledger, folders, paths)).toEqual([]);
      })
    );
  });

  it('yields nothing from a folder it records but no longer watched', () => {
    fc.assert(
      fc.property(ledgerArb, pathsArb, (ledger, paths) => {
        expect(ledgerArrivals(ledger, [], paths)).toEqual([]);
      })
    );
  });

  it('yields a new file next to seen ones, and not a file in a sibling folder', () => {
    const ledger = { folders: ['Inbox'], paths: ['Inbox/old.md'] };
    expect(
      ledgerArrivals(
        ledger,
        ['Inbox'],
        ['Inbox/old.md', 'Inbox/new.md', 'Inbox2/new.md', 'Inbox']
      )
    ).toEqual(['Inbox/new.md']);
  });
});

describe('reconcileLedger', () => {
  it('with no ledger, records the watched folders and every file under them now', () => {
    fc.assert(
      fc.property(foldersArb, pathsArb, (folders, paths) => {
        expect(reconcileLedger(null, folders, paths)).toEqual({
          folders,
          paths: paths.filter((path) => insideAny(path, folders)),
        });
      })
    );
  });

  it('keeps what it saw in folders still watched, seeds the rest, and drops folders no longer watched', () => {
    fc.assert(
      fc.property(ledgerArb, foldersArb, pathsArb, (ledger, folders, paths) => {
        const kept = folders.filter((folder) =>
          ledger.folders.includes(folder)
        );
        const added = folders.filter((folder) => !kept.includes(folder));
        const result = reconcileLedger(ledger, folders, paths);

        expect(result.folders).toEqual(folders);
        expect(result.paths).toEqual([
          ...ledger.paths.filter((path) => insideAny(path, kept)),
          ...paths.filter(
            (path) => insideAny(path, added) && !insideAny(path, kept)
          ),
        ]);
      })
    );
  });

  it('leaves nothing to arrive in a folder it seeds, and every unseen file in one it keeps', () => {
    fc.assert(
      fc.property(ledgerArb, foldersArb, pathsArb, (ledger, folders, paths) => {
        const before = ledgerArrivals(ledger, folders, paths);
        const after = reconcileLedger(ledger, folders, paths);
        expect(ledgerArrivals(after, folders, paths)).toEqual(before);
        // Rewritten from scratch, it is what is there now
        expect(
          ledgerArrivals(reconcileLedger(null, folders, paths), folders, paths)
        ).toEqual([]);
      })
    );
  });

  it('does not change the ledger or the lists it is given', () => {
    fc.assert(
      fc.property(ledgerArb, foldersArb, pathsArb, (ledger, folders, paths) => {
        const copies = structuredClone({ ledger, folders, paths });
        const result = reconcileLedger(ledger, folders, paths);
        expect({ ledger, folders, paths }).toEqual(copies);
        expect(result.folders).not.toBe(folders);
      })
    );
  });
});

describe('the stored ledger', () => {
  it('reads back as it was stored', () => {
    fc.assert(
      fc.property(ledgerArb, (ledger) => {
        const { app } = makeStorage();
        saveWatchedFolderLedger(app, ledger);
        expect(loadWatchedFolderLedger(app)).toEqual(ledger);
      })
    );
  });

  it('is kept under its own key', () => {
    const { app, stored } = makeStorage();
    saveWatchedFolderLedger(app, { folders: ['Inbox'], paths: ['Inbox/a.md'] });
    expect(JSON.parse(stored.get(WATCHED_FOLDER_LEDGER_KEY)!)).toEqual({
      folders: ['Inbox'],
      paths: ['Inbox/a.md'],
    });
  });

  it('reads as none when nothing is stored, or something else is', () => {
    const { app, stored } = makeStorage();
    expect(loadWatchedFolderLedger(app)).toBeNull();
    stored.set(
      WATCHED_FOLDER_LEDGER_KEY,
      JSON.stringify({ folders: ['Inbox'] })
    );
    expect(loadWatchedFolderLedger(app)).toBeNull();
  });
});
