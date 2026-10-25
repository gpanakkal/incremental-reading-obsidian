import type { BulkOutcome } from '#/lib/bulk-import/types';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { queryClient } from '#/lib/query-client';
import { setCurrentItemId, setShowAnswer, store } from '#/lib/store';
import * as ConfirmModalModule from '#/views/ConfirmModal';
import fc from 'fast-check';
import type { TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  refreshAfterImportUndo,
  refreshAfterUnimport,
  unimportArticle,
} from './unimport-article';

// #region HELPERS

/** A file's name without its extension: any text, long ones included. */
const basenameArb = fc.oneof(
  fc.string({ maxLength: 20 }),
  fc.string({ minLength: 45, maxLength: 70 })
);

const statusArb = fc.constantFrom<BulkOutcome['status']>(
  'unimported',
  'skipped',
  'failed'
);

/** The item review is on: none, the un-imported article, or another. */
const currentArb = fc.option(fc.constantFrom('a', 'other'), { nil: null });

/** The note's name as a notice names it: trimmed, and cut short past 50. */
const shownName = (basename: string) => {
  const trimmed = basename.trim();
  return trimmed.length > 50 ? `${trimmed.slice(0, 47)}...` : trimmed;
};

/**
 * Stub what an un-import reaches: the confirmation, answering `confirmed`;
 * the un-import, answering `status` (with `reason`); whether the item review
 * is on, `currentItemId`, still has a row (`rowLeft`); and the queue's cache,
 * notices and the console, which are only watched. Reset per call, since a
 * property runs many cases in one `it`.
 */
function wireUnimport({
  confirmed = true,
  status = 'unimported',
  reason,
  currentItemId = null,
  rowLeft = false,
  basename = 'Note',
}: {
  confirmed?: boolean;
  status?: BulkOutcome['status'];
  reason?: string;
  currentItemId?: string | null;
  rowLeft?: boolean;
  basename?: string;
}) {
  vi.restoreAllMocks();
  store.dispatch(setCurrentItemId(currentItemId));
  store.dispatch(setShowAnswer(true));
  const file = { path: `notes/${basename}.md`, basename } as TFile;
  const prompt = vi
    .spyOn(ConfirmModalModule, 'promptForConfirmation')
    .mockResolvedValue(confirmed);
  const unimportArticles = vi.fn(
    async (files: readonly TFile[]): Promise<BulkOutcome[]> =>
      files.map((given) => ({
        file: given,
        status,
        ...(reason === undefined ? {} : { reason }),
      }))
  );
  const hasItemRow = vi.fn(async (_id: string) => rowLeft);
  const invalidate = vi
    .spyOn(queryClient, 'invalidateQueries')
    .mockResolvedValue(undefined);
  const notify = vi.spyOn(Obsidian, 'notify').mockImplementation(() => {});
  const plugin = {
    app: { name: 'app' },
    reviewManager: { unimportArticles, hasItemRow },
  };
  return {
    plugin,
    file,
    prompt,
    unimportArticles,
    hasItemRow,
    invalidate,
    notify,
  };
}

// #endregion

describe('unimportArticle', () => {
  afterEach(() => {
    store.dispatch(setCurrentItemId(null));
    vi.restoreAllMocks();
  });

  it('asks first, naming the note and what is lost, and offers a destructive Un-import', async () => {
    await fc.assert(
      fc.asyncProperty(
        basenameArb,
        fc.boolean(),
        async (basename, confirmed) => {
          const wired = wireUnimport({ confirmed, basename });

          await unimportArticle(wired.plugin as never, wired.file);

          expect(wired.prompt.mock.calls).toStrictEqual([
            [
              wired.plugin.app,
              {
                title: 'Un-import article',
                paragraphs: [expect.stringContaining(`"${basename}"`)],
                confirmText: 'Un-import',
                destructive: true,
              },
            ],
          ]);
        }
      )
    );
  });

  it('does nothing at all when the user turns it down', async () => {
    await fc.assert(
      fc.asyncProperty(currentArb, async (currentItemId) => {
        const wired = wireUnimport({ confirmed: false, currentItemId });

        const unimported = await unimportArticle(
          wired.plugin as never,
          wired.file
        );

        expect(unimported).toBe(false);
        expect(wired.unimportArticles).not.toHaveBeenCalled();
        expect(wired.invalidate).not.toHaveBeenCalled();
        expect(wired.notify).not.toHaveBeenCalled();
        expect(store.getState().currentItemId).toBe(currentItemId);
      })
    );
  });

  it('un-imports the file once confirmed and says how that went', async () => {
    await fc.assert(
      fc.asyncProperty(
        basenameArb,
        statusArb,
        fc.string(),
        async (basename, status, reason) => {
          const wired = wireUnimport({
            basename,
            status,
            reason: status === 'unimported' ? undefined : reason,
          });

          const unimported = await unimportArticle(
            wired.plugin as never,
            wired.file
          );

          expect(unimported).toBe(status === 'unimported');
          expect(wired.unimportArticles).toHaveBeenCalledExactlyOnceWith([
            wired.file,
          ]);
          const name = shownName(basename);
          expect(wired.notify.mock.calls).toStrictEqual([
            status === 'unimported'
              ? // A category, so the `minimal` level keeps it
                [
                  `Un-imported "${name}"`,
                  { kind: 'success', category: 'import' },
                ]
              : [`Couldn't un-import "${name}": ${reason}`, { kind: 'error' }],
          ]);
        }
      )
    );
  });

  it('refreshes the queue and moves review off the article once its row is gone', async () => {
    await fc.assert(
      fc.asyncProperty(
        statusArb,
        currentArb,
        fc.boolean(),
        async (status, currentItemId, rowLeft) => {
          const wired = wireUnimport({ status, currentItemId, rowLeft });

          await unimportArticle(wired.plugin as never, wired.file);

          const deletedAny = status !== 'skipped';
          const leftItem = deletedAny && currentItemId !== null && !rowLeft;
          expect(wired.invalidate.mock.calls).toStrictEqual(
            deletedAny ? [[{ queryKey: ['queue'], refetchType: 'all' }]] : []
          );
          expect(wired.hasItemRow.mock.calls).toStrictEqual(
            deletedAny && currentItemId !== null ? [[currentItemId]] : []
          );
          // Reset as review resets on leaving an item, answer and all
          expect(store.getState().currentItemId).toBe(
            leftItem ? null : currentItemId
          );
          expect(store.getState().showAnswer).toBe(!leftItem);
        }
      )
    );
  });
});

describe('refreshAfterUnimport', () => {
  afterEach(() => {
    store.dispatch(setCurrentItemId(null));
    vi.restoreAllMocks();
  });

  it('refreshes once for a whole batch, and only when any row may have gone', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(statusArb, { maxLength: 5 }),
        currentArb,
        fc.boolean(),
        async (statuses, currentItemId, rowLeft) => {
          const wired = wireUnimport({ currentItemId, rowLeft });
          const outcomes = statuses.map((status) => ({
            file: wired.file,
            status,
          }));

          await refreshAfterUnimport(wired.plugin as never, outcomes);

          const deletedAny = statuses.some((status) => status !== 'skipped');
          expect(wired.invalidate.mock.calls).toStrictEqual(
            deletedAny ? [[{ queryKey: ['queue'], refetchType: 'all' }]] : []
          );
          expect(store.getState().currentItemId).toBe(
            deletedAny && currentItemId !== null && !rowLeft
              ? null
              : currentItemId
          );
        }
      )
    );
  });
});

describe('refreshAfterImportUndo', () => {
  afterEach(() => {
    store.dispatch(setCurrentItemId(null));
    vi.restoreAllMocks();
  });

  it('refreshes once when any article was taken back, moving review off one that was', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.constantFrom<string>('a', 'b', 'c'), {
          maxLength: 3,
        }),
        fc.option(fc.constantFrom('a', 'b', 'other'), { nil: null }),
        async (undone, currentItemId) => {
          vi.restoreAllMocks();
          const invalidate = vi
            .spyOn(queryClient, 'invalidateQueries')
            .mockResolvedValue(undefined);
          store.dispatch(setCurrentItemId(currentItemId));
          store.dispatch(setShowAnswer(true));

          await refreshAfterImportUndo(undone);

          expect(invalidate.mock.calls).toStrictEqual(
            undone.length > 0
              ? [[{ queryKey: ['queue'], refetchType: 'all' }]]
              : []
          );
          const left = currentItemId !== null && undone.includes(currentItemId);
          expect(store.getState().currentItemId).toBe(
            left ? null : currentItemId
          );
          // Reset as review resets on leaving an item, answer and all
          expect(store.getState().showAnswer).toBe(!left);
        }
      )
    );
  });
});
