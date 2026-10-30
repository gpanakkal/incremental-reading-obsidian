// @vitest-environment jsdom
import { ActionCooldown, actionCooldownFor } from '#/lib/action-cooldown';
import { queryClient } from '#/lib/query-client';
import { DEFAULT_SETTINGS } from '#/lib/settings';
import type { ReviewText } from '#/lib/types';
import type IncrementalReadingPlugin from '#/main';
import fc from 'fast-check';
import type { TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SchedulingModal } from './SchedulingModal';

// #region HELPERS
/**
 * A plugin whose scheduling actions wait on `settle`, if given, so a test can
 * move the clock between pressing Confirm and the modal closing.
 */
function makePlugin(settle: Promise<void> = Promise.resolve()) {
  return {
    app: {},
    settings: { ...DEFAULT_SETTINGS },
    actions: {
      reprioritize: vi.fn(() => settle),
      manageFixedInterval: vi.fn(() => settle),
    },
  } as unknown as IncrementalReadingPlugin;
}

/** A promise and the function that resolves it. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Put the clock the double-click guard reads at `now`. */
function setNow(now: number) {
  vi.spyOn(performance, 'now').mockReturnValue(now);
}

/** Let pending promise callbacks run. */
function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

/**
 * The ways a user closes the modal. Escape, the × and a click outside all
 * call `close` in Obsidian, as Cancel and Confirm do.
 */
type CloseBy = 'cancel' | 'confirm' | 'dismiss';

/** Close the open `modal` the way `by` says. */
function closeModal(modal: SchedulingModal, by: CloseBy) {
  if (by === 'dismiss') {
    modal.close();
    return;
  }
  modal.contentEl
    .querySelector<HTMLButtonElement>(
      `.modal-button-container button${by === 'confirm' ? '.mod-cta' : ':not(.mod-cta)'}`
    )!
    .click();
}

function makeItem(
  type: 'article' | 'snippet',
  basename: string,
  { id = 'item-id', fixedIntervalDays = null as number | null } = {}
): ReviewText {
  return {
    data: {
      id,
      type,
      reference: `folder/${basename}.md`,
      priority: 30,
      ...(type === 'article' ? { fixed_interval_days: fixedIntervalDays } : {}),
    },
    file: { basename, path: `folder/${basename}.md` } as TFile,
  } as unknown as ReviewText;
}

/** An article, on a fixed interval or not, or a snippet, under any id. */
const textArb = fc
  .record({
    type: fc.constantFrom('article' as const, 'snippet' as const),
    fixedIntervalDays: fc.option(fc.integer({ min: 1, max: 10_000 }), {
      nil: null,
    }),
    id: fc.string({ minLength: 1 }),
    basename: fc.string({ minLength: 1 }),
  })
  .map(({ type, basename, ...rest }) => makeItem(type, basename, rest));
// #endregion

describe('SchedulingModal', () => {
  it("titles itself with the basename of the item's note", () => {
    fc.assert(
      fc.property(
        fc.constantFrom('article' as const, 'snippet' as const),
        fc.string({ minLength: 1 }),
        (type, basename) => {
          const modal = new SchedulingModal(
            makePlugin(),
            makeItem(type, basename)
          );
          modal.onOpen();
          try {
            expect(modal.titleEl.textContent).toBe(basename);
          } finally {
            modal.onClose();
          }
        }
      ),
      { numRuns: 20 }
    );
  });

  describe('on confirming', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('sets the priority it was confirmed with, through the fixed-interval action on an article that has one, and refreshes the item once that is saved', async () => {
      await fc.assert(
        fc.asyncProperty(
          textArb,
          fc.integer({ min: 10, max: 50 }),
          async (item, value) => {
            const write = deferred();
            const plugin = makePlugin(write.promise);
            const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
            const modal = new SchedulingModal(plugin, item);

            const done = modal.handleClose('priority', value);
            await flush();
            expect(invalidate).not.toHaveBeenCalled();
            write.resolve();
            await done;

            const onInterval =
              item.data.type === 'article' &&
              item.data.fixed_interval_days !== null;
            expect(plugin.actions.manageFixedInterval).toHaveBeenCalledTimes(
              onInterval ? 1 : 0
            );
            expect(plugin.actions.reprioritize).toHaveBeenCalledTimes(
              onInterval ? 0 : 1
            );
            if (onInterval) {
              expect(plugin.actions.manageFixedInterval).toHaveBeenCalledWith(
                item,
                { newPriority: value }
              );
            } else {
              expect(plugin.actions.reprioritize).toHaveBeenCalledWith(
                item,
                value
              );
            }
            expect(invalidate).toHaveBeenCalledWith({
              queryKey: ['item', item.data.id],
            });
            vi.restoreAllMocks();
          }
        ),
        { numRuns: 30 }
      );
    });

    it('puts an article on the fixed interval it was confirmed with', async () => {
      await fc.assert(
        fc.asyncProperty(
          textArb.filter((item) => item.data.type === 'article'),
          fc.integer({ min: 1, max: 10_000 }),
          async (item, value) => {
            const plugin = makePlugin();

            await new SchedulingModal(plugin, item).handleClose(
              'fixed-interval',
              value
            );

            expect(plugin.actions.manageFixedInterval).toHaveBeenCalledOnce();
            expect(plugin.actions.manageFixedInterval).toHaveBeenCalledWith(
              item,
              { newIntervalDays: value }
            );
            expect(plugin.actions.reprioritize).not.toHaveBeenCalled();
          }
        ),
        { numRuns: 20 }
      );
    });

    it('refuses a fixed interval on a snippet, naming it, and changes nothing', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1 }),
          fc.integer({ min: 1, max: 10_000 }),
          async (basename, value) => {
            const plugin = makePlugin();
            const item = makeItem('snippet', basename);

            const result = new SchedulingModal(plugin, item).handleClose(
              'fixed-interval',
              value
            );

            await expect(result).rejects.toThrow(TypeError);
            await expect(result).rejects.toThrow(item.data.reference);
            expect(plugin.actions.manageFixedInterval).not.toHaveBeenCalled();
            expect(plugin.actions.reprioritize).not.toHaveBeenCalled();
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  describe('on closing', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const closeByArb = fc.constantFrom<CloseBy>('cancel', 'confirm', 'dismiss');

    it('starts the cooldown of the review tab it was opened for, at the moment it closes, however it is closed', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('article' as const, 'snippet' as const),
          closeByArb,
          fc.integer({ min: 0, max: 1e9 }),
          fc.integer({ min: 1, max: 10_000 }),
          async (type, by, pressedAt, wait) => {
            const write = deferred();
            const reviewView = {};
            const arm = vi.spyOn(ActionCooldown.prototype, 'arm');
            const modal = new SchedulingModal(
              makePlugin(write.promise),
              makeItem(type, 'note'),
              reviewView as never
            );
            const close = vi.spyOn(modal, 'close');
            modal.onOpen();
            try {
              setNow(pressedAt);
              closeModal(modal, by);
              // Confirm closes only once the change is saved, which takes a
              // while; the cooldown runs from the close, not the press
              setNow(pressedAt + wait);
              write.resolve();
              await flush();

              expect(close).toHaveBeenCalledTimes(1);
              expect(arm.mock.contexts).toEqual([
                actionCooldownFor(reviewView),
              ]);
              expect(arm.mock.calls).toEqual([
                [by === 'confirm' ? pressedAt + wait : pressedAt],
              ]);
            } finally {
              modal.onClose();
              vi.restoreAllMocks();
            }
          }
        ),
        { numRuns: 30 }
      );
    });

    it('starts the cooldown only once when dismissed while a confirmed change is still saving', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 1e9 }),
          fc.integer({ min: 0, max: 10_000 }),
          fc.integer({ min: 1, max: 10_000 }),
          async (pressedAt, dismissAfter, savedAfter) => {
            const write = deferred();
            const reviewView = {};
            const arm = vi.spyOn(ActionCooldown.prototype, 'arm');
            const modal = new SchedulingModal(
              makePlugin(write.promise),
              makeItem('article', 'note'),
              reviewView as never
            );
            modal.onOpen();
            try {
              setNow(pressedAt);
              closeModal(modal, 'confirm');
              const dismissedAt = pressedAt + dismissAfter;
              setNow(dismissedAt);
              closeModal(modal, 'dismiss');
              // The save finishing closes it again, long after it went away
              setNow(dismissedAt + savedAfter);
              write.resolve();
              await flush();

              expect(arm.mock.calls).toEqual([[dismissedAt]]);
            } finally {
              modal.onClose();
              vi.restoreAllMocks();
            }
          }
        ),
        { numRuns: 30 }
      );
    });

    it('takes its contents down', () => {
      const modal = new SchedulingModal(
        makePlugin(),
        makeItem('article', 'note')
      );
      modal.onOpen();
      expect(modal.contentEl.childElementCount).toBeGreaterThan(0);

      modal.onClose();

      expect(modal.contentEl.childElementCount).toBe(0);
    });

    it('starts no cooldown when opened from outside a review tab', async () => {
      for (const by of ['cancel', 'confirm', 'dismiss'] as const) {
        const arm = vi.spyOn(ActionCooldown.prototype, 'arm');
        const modal = new SchedulingModal(
          makePlugin(),
          makeItem('article', 'note')
        );
        modal.onOpen();
        try {
          closeModal(modal, by);
          await flush();

          expect(arm).not.toHaveBeenCalled();
        } finally {
          modal.onClose();
          vi.restoreAllMocks();
        }
      }
    });
  });
});
