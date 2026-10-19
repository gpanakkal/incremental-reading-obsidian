import * as notices from '#/lib/notices';
import { configureSuccessNotices, notify } from '#/lib/notices';
// The mock the vitest config aliases `obsidian` to, imported by path so its
// recorded notices are visible to the type checker
import { Notice } from '#/test/__mocks__/obsidian';
import {
  showSuccessNotices,
  SUCCESS_NOTICE_LEVELS,
} from '#/test/success-notices';
import fc from 'fast-check';
import { TFile } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeFailures, importChosen, unimportChosen } from './run-import';
import type { BulkImportOptions, BulkOutcome } from './types';

// #region HELPERS
function makeFile(path: string): TFile {
  return Object.assign(new TFile(), { path });
}

/** Files with paths of their own, each with what came of importing it. */
const resultsArb = fc
  .uniqueArray(fc.string({ minLength: 1 }), { maxLength: 8 })
  .chain((paths) =>
    fc.tuple(
      ...paths.map((path) =>
        fc.record({
          file: fc.constant(makeFile(path)),
          status: fc.constantFrom(
            'imported' as const,
            'skipped' as const,
            'failed' as const
          ),
          reason: fc.string(),
        })
      )
    )
  )
  .map((outcomes) =>
    outcomes.map(
      ({ file, status, reason }): BulkOutcome =>
        status === 'imported' ? { file, status } : { file, status, reason }
    )
  );

const optionsArb: fc.Arbitrary<BulkImportOptions> = fc.record({
  priority: fc.integer(),
  fixedIntervalDays: fc.option(fc.integer(), { nil: null }),
  makeCopy: fc.boolean(),
});

/** Files with paths of their own, each with what came of un-importing it. */
const unimportResultsArb = resultsArb.map((outcomes) =>
  outcomes.map(
    (outcome): BulkOutcome =>
      outcome.status === 'imported'
        ? { file: outcome.file, status: 'unimported' }
        : outcome
  )
);

/** An un-importer whose un-imports come out as `outcomes`. */
function makeUnimporter(outcomes: BulkOutcome[]) {
  return { unimportArticles: vi.fn().mockResolvedValue(outcomes) };
}

/** An importer whose imports come out as `outcomes`. */
function makeImporter(outcomes: BulkOutcome[]) {
  return { importArticles: vi.fn().mockResolvedValue(outcomes) };
}
// #endregion

beforeEach(() => {
  Notice.reset();
});

afterEach(() => {
  configureSuccessNotices(null);
  vi.restoreAllMocks();
});

describe('importChosen', () => {
  it('imports the files given, in order, once each, with the options given', async () => {
    await fc.assert(
      fc.asyncProperty(
        resultsArb,
        optionsArb,
        fc.string(),
        async (outcomes, options, title) => {
          const importer = makeImporter(outcomes);
          const files = outcomes.map(({ file }) => file);

          await expect(
            importChosen(importer, files, options, title)
          ).resolves.toBe(outcomes);

          expect(importer.importArticles).toHaveBeenCalledExactlyOnceWith(
            files.map((file) => ({ file })),
            options
          );
        }
      )
    );
  });

  it('hands over what came of it before saying anything, and puts the button it answers on the count alone', async () => {
    await fc.assert(
      fc.asyncProperty(
        resultsArb,
        optionsArb,
        fc.boolean(),
        async (outcomes, options, withAction) => {
          vi.restoreAllMocks();
          const said = vi.spyOn(notices, 'notify');
          const action = withAction
            ? { label: 'Undo', onClick: vi.fn() }
            : undefined;
          const onImported = vi.fn(() => {
            expect(said).not.toHaveBeenCalled();
            return action;
          });
          const files = outcomes.map(({ file }) => file);

          await importChosen(
            makeImporter(outcomes),
            files,
            options,
            'notes',
            onImported
          );

          expect(onImported).toHaveBeenCalledExactlyOnceWith(outcomes);
          const [summary, ...rest] = said.mock.calls;
          expect(summary[1]).toEqual({
            kind: 'success',
            category: 'import',
            action,
          });
          for (const [, options] of rest) {
            expect(options?.action).toBeUndefined();
          }
        }
      )
    );
  });

  it('counts what was imported out of all it was given, then lists only the failures, if any', async () => {
    await fc.assert(
      fc.asyncProperty(
        resultsArb,
        optionsArb,
        // No digits, so the only numbers in the summary are its counts
        fc.string().filter((title) => !/\d/.test(title)),
        async (outcomes, options, title) => {
          Notice.reset();
          const files = outcomes.map(({ file }) => file);

          await importChosen(makeImporter(outcomes), files, options, title);

          const imported = outcomes.filter((o) => o.status === 'imported');
          const failed = outcomes.filter((o) => o.status === 'failed');
          const [summary, ...rest] = Notice.messages;
          expect(summary).toContain(title);
          expect(summary.match(/\d+/g)?.map(Number)).toEqual([
            imported.length,
            outcomes.length,
          ]);
          expect(rest).toEqual(
            failed.length > 0 ? [describeFailures(failed)] : []
          );
        }
      )
    );
  });

  it('counts the imports only where the success notice level shows imports, but always lists the failures', async () => {
    const failure: BulkOutcome = {
      file: makeFile('notes/a.md'),
      status: 'failed',
      reason: 'broken',
    };
    for (const level of SUCCESS_NOTICE_LEVELS) {
      Notice.reset();
      showSuccessNotices(level);

      await importChosen(
        makeImporter([failure]),
        [failure.file],
        { priority: 1, fixedIntervalDays: null, makeCopy: false },
        'notes'
      );

      expect(Notice.messages, level).toEqual([
        ...(level === 'none'
          ? []
          : [expect.stringContaining('notes') as unknown]),
        describeFailures([failure]),
      ]);
    }
  });

  it('leaves the failures up as long as an error stays up', async () => {
    const failure: BulkOutcome = {
      file: makeFile('notes/a.md'),
      status: 'failed',
      reason: 'broken',
    };

    await importChosen(
      makeImporter([failure]),
      [failure.file],
      { priority: 1, fixedIntervalDays: null, makeCopy: false },
      'notes'
    );
    // The next notice hides the one before it only if that is no error
    const [summary, failures] = Notice.instances;
    notify('next');

    expect(summary.hides).toBe(1);
    expect(failures.hides).toBe(0);
  });
});

describe('describeFailures', () => {
  it('says how many failed, then each one by path with its reason, a line each', () => {
    fc.assert(
      fc.property(resultsArb, (outcomes) => {
        const failed = outcomes.filter((o) => o.status === 'failed');
        fc.pre(failed.length > 0);

        const message = describeFailures(failed);
        // The header is worded freely; only its count and plural are logic
        const [header] = message.split('\n');
        const plural = failed.length === 1 ? '' : 's';
        expect(header).toMatch(
          new RegExp(`\\b${failed.length} file${plural}\\b`)
        );
        expect(message).toBe(
          [
            header,
            ...failed.map(({ file, reason }) => `${file.path}: ${reason}`),
          ].join('\n')
        );
      })
    );
  });
});

describe('describeFailures of an un-import', () => {
  it('says the same of the files as an import, the verb aside', () => {
    fc.assert(
      fc.property(resultsArb, (outcomes) => {
        const failed = outcomes.filter((o) => o.status === 'failed');
        fc.pre(failed.length > 0);

        const [header, ...lines] = describeFailures(failed, 'un-import').split(
          '\n'
        );
        const [importHeader, ...importLines] =
          describeFailures(failed).split('\n');

        expect(lines).toEqual(importLines);
        expect(header).not.toBe(importHeader);
        expect(header).toMatch(/un-import/);
        expect(header.replace('un-import', 'import')).toBe(importHeader);
      })
    );
  });
});

describe('unimportChosen', () => {
  it('un-imports the files given, in order, once each, and returns what came of it', async () => {
    await fc.assert(
      fc.asyncProperty(unimportResultsArb, async (outcomes) => {
        const unimporter = makeUnimporter(outcomes);
        const files = outcomes.map(({ file }) => file);

        await expect(unimportChosen(unimporter, files, 'notes')).resolves.toBe(
          outcomes
        );
        expect(unimporter.unimportArticles).toHaveBeenCalledExactlyOnceWith(
          files
        );
      })
    );
  });

  it('waits for what it hands what came of it before saying anything', async () => {
    await fc.assert(
      fc.asyncProperty(unimportResultsArb, async (outcomes) => {
        vi.restoreAllMocks();
        const said = vi.spyOn(notices, 'notify');
        let settled = false;
        const onUnimported = vi.fn(async () => {
          await Promise.resolve();
          expect(said).not.toHaveBeenCalled();
          settled = true;
        });

        await unimportChosen(
          makeUnimporter(outcomes),
          outcomes.map(({ file }) => file),
          'notes',
          onUnimported
        );

        expect(onUnimported).toHaveBeenCalledExactlyOnceWith(outcomes);
        expect(settled).toBe(true);
        expect(said).toHaveBeenCalled();
        const [[, options]] = said.mock.calls;
        expect(options).toEqual({ kind: 'success', category: 'import' });
      })
    );
  });

  it('counts what was un-imported out of all it was given, then lists only the failures, if any', async () => {
    await fc.assert(
      fc.asyncProperty(
        unimportResultsArb,
        // No digits, so the only numbers in the summary are its counts
        fc.string().filter((title) => !/\d/.test(title)),
        async (outcomes, title) => {
          Notice.reset();

          await unimportChosen(
            makeUnimporter(outcomes),
            outcomes.map(({ file }) => file),
            title
          );

          const done = outcomes.filter((o) => o.status === 'unimported');
          const failed = outcomes.filter((o) => o.status === 'failed');
          const [summary, ...rest] = Notice.messages;
          expect(summary).toContain(title);
          expect(summary.match(/\d+/g)?.map(Number)).toEqual([
            done.length,
            outcomes.length,
          ]);
          expect(rest).toEqual(
            failed.length > 0 ? [describeFailures(failed, 'un-import')] : []
          );
        }
      )
    );
  });

  it('leaves the failures up as long as an error stays up', async () => {
    const failure: BulkOutcome = {
      file: makeFile('notes/a.md'),
      status: 'failed',
      reason: 'broken',
    };

    await unimportChosen(makeUnimporter([failure]), [failure.file], 'notes');
    const [summary, failures] = Notice.instances;
    notify('next');

    expect(summary.hides).toBe(1);
    expect(failures.hides).toBe(0);
  });
});
