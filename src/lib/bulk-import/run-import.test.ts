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
import { describeFailures, importChosen } from './run-import';
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

  it('counts what was imported out of all it was given, then lists only the failures, if any', async () => {
    await fc.assert(
      fc.asyncProperty(
        resultsArb,
        optionsArb,
        fc.string(),
        async (outcomes, options, title) => {
          Notice.reset();
          const files = outcomes.map(({ file }) => file);

          await importChosen(makeImporter(outcomes), files, options, title);

          const imported = outcomes.filter((o) => o.status === 'imported');
          const failed = outcomes.filter((o) => o.status === 'failed');
          expect(Notice.messages).toEqual([
            `${imported.length} of ${outcomes.length} imported from ${title}`,
            ...(failed.length > 0 ? [describeFailures(failed)] : []),
          ]);
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
        ...(level === 'none' ? [] : ['0 of 1 imported from notes']),
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

        expect(describeFailures(failed)).toBe(
          [
            `Couldn't import ${failed.length} ${failed.length === 1 ? 'file' : 'files'}:`,
            ...failed.map(({ file, reason }) => `${file.path}: ${reason}`),
          ].join('\n')
        );
      })
    );
  });
});
