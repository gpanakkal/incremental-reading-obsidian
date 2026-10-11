import type { QueueRow } from '#/components/types';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { queryClient } from '#/lib/query-client';
import { tableOf } from '#/lib/relink';
import { setCurrentItemId, setShowAnswer, store } from '#/lib/store';
import * as ConfirmModalModule from '#/views/ConfirmModal';
import fc from 'fast-check';
import type { TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteMissingItem } from './delete-missing-item';

// #region HELPERS

const rowArb = fc.record({
  id: fc.string(),
  type: fc.constantFrom<QueueRow['type']>('article', 'snippet', 'card'),
  reference: fc.string(),
});

const FAILURE = new Error('disk full');

/**
 * Stub what deleting reaches: the confirmation, answering `confirmed`; the
 * note's lookup, finding one when `noteBack`; the row's delete, failing when
 * `fails`; and the queue's cache, notices and the console, which are only
 * watched. Review is on `currentItemId`, with its answer shown. Reset per
 * call, since a property runs many cases in one `it`.
 */
function wireDeletion({
  confirmed,
  fails = false,
  noteBack = false,
  currentItemId = null,
}: {
  confirmed: boolean;
  fails?: boolean;
  noteBack?: boolean;
  currentItemId?: string | null;
}) {
  vi.restoreAllMocks();
  store.dispatch(setCurrentItemId(currentItemId));
  store.dispatch(setShowAnswer(true));
  const prompt = vi
    .spyOn(ConfirmModalModule, 'promptForConfirmation')
    .mockResolvedValue(confirmed);
  const getNote = vi
    .spyOn(Obsidian, 'getNote')
    .mockReturnValue(noteBack ? ({ path: 'back.md' } as TFile) : null);
  const deleteRow = fails
    ? vi.fn().mockRejectedValue(FAILURE)
    : vi.fn().mockResolvedValue(undefined);
  const invalidate = vi
    .spyOn(queryClient, 'invalidateQueries')
    .mockResolvedValue(undefined);
  const notify = vi.spyOn(Obsidian, 'notify').mockImplementation(() => {});
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const plugin = { app: { name: 'app' }, reviewManager: { deleteRow } };
  return { plugin, prompt, getNote, deleteRow, invalidate, notify, logged };
}

// #endregion

describe('deleteMissingItem', () => {
  afterEach(() => {
    store.dispatch(setCurrentItemId(null));
    vi.restoreAllMocks();
  });

  it('asks first, naming the item, and offers a destructive Delete', async () => {
    await fc.assert(
      fc.asyncProperty(rowArb, fc.boolean(), async (row, confirmed) => {
        const wired = wireDeletion({ confirmed });

        await deleteMissingItem(wired.plugin as never, row);

        expect(wired.prompt).toHaveBeenCalledOnce();
        const [app, options] = wired.prompt.mock.calls[0];
        expect(app).toBe(wired.plugin.app);
        expect(options).toMatchObject({
          title: 'Permanently delete item',
          confirmText: 'Delete',
          destructive: true,
        });
        expect(options.paragraphs[0]).toBe(
          `Delete "${row.reference}" and its review history? This can't be undone.`
        );
        // A card has nothing taken from it to keep
        expect(options.paragraphs.slice(1)).toStrictEqual(
          row.type === 'card'
            ? []
            : ['Snippets and cards made from it will be kept.']
        );
      })
    );
  });

  it('deletes the row, refreshes the queue, and moves review off the item, only once confirmed', async () => {
    await fc.assert(
      fc.asyncProperty(
        rowArb,
        fc.boolean(),
        fc.boolean(),
        fc.option(fc.oneof(fc.constant('row'), fc.string()), { nil: null }),
        async (row, confirmed, fails, current) => {
          const currentItemId = current === 'row' ? row.id : current;
          const wired = wireDeletion({ confirmed, fails, currentItemId });

          const deleted = await deleteMissingItem(wired.plugin as never, row);

          const succeeded = confirmed && !fails;
          const leftItem = succeeded && currentItemId === row.id;
          expect(deleted).toBe(succeeded);
          expect(wired.getNote.mock.calls).toStrictEqual(
            confirmed ? [[row.reference, wired.plugin.app]] : []
          );
          expect(wired.deleteRow.mock.calls).toStrictEqual(
            confirmed ? [[tableOf(row.type), row.id]] : []
          );
          expect(wired.invalidate.mock.calls).toStrictEqual(
            succeeded ? [[{ queryKey: ['queue'], refetchType: 'all' }]] : []
          );
          // Reset as review resets on leaving an item, answer and all
          expect(store.getState().currentItemId).toBe(
            leftItem ? null : currentItemId
          );
          expect(store.getState().showAnswer).toBe(!leftItem);
          expect(wired.notify.mock.calls).toStrictEqual(
            confirmed && fails ? [[`Failed to delete "${row.reference}"`]] : []
          );
          expect(wired.logged.mock.calls).toStrictEqual(
            confirmed && fails ? [[FAILURE]] : []
          );
        }
      )
    );
  });

  it('deletes nothing when the note came back while the user was asked, and shows the row as it is', async () => {
    await fc.assert(
      fc.asyncProperty(rowArb, fc.boolean(), async (row, current) => {
        const currentItemId = current ? row.id : null;
        const wired = wireDeletion({
          confirmed: true,
          noteBack: true,
          currentItemId,
        });

        const deleted = await deleteMissingItem(wired.plugin as never, row);

        expect(deleted).toBe(false);
        expect(wired.deleteRow).not.toHaveBeenCalled();
        expect(wired.notify.mock.calls).toStrictEqual([
          [`"${row.reference}" is back, so it was not deleted`],
        ]);
        expect(wired.invalidate.mock.calls).toStrictEqual([
          [{ queryKey: ['queue'], refetchType: 'all' }],
        ]);
        expect(store.getState().currentItemId).toBe(currentItemId);
      })
    );
  });
});
