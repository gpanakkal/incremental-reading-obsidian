// @vitest-environment jsdom

import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewSession } from './plugin-data';
import { SESSION_CLEAR_DELAY, SessionTracker } from './SessionTracker';
import {
  resetCurrentItem,
  resetSession,
  setCurrentItemId,
  setPage,
  store,
} from './store';

// #region HELPERS

const DEVICE = 'device-a';

/**
 * Drives the tracker against the real review store, so the discard rules are
 * exercised through the transitions that actually produce them
 * (`resetSession` on tab close, `resetCurrentItem` between items).
 */
function makeTracker(initialItemId: string | null = null) {
  const saved: (ReviewSession | null)[] = [];
  const save = vi.fn((session: ReviewSession | null) => {
    saved.push(session);
    return Promise.resolve();
  });
  const tracker = new SessionTracker({
    store,
    deviceId: DEVICE,
    save,
    initialItemId,
  });
  const stop = tracker.start();
  return { tracker, save, saved, stop };
}

/** Let the write chain's microtasks run without advancing the clear timer. */
const flush = () => vi.advanceTimersByTimeAsync(0);

/** Run past the delayed clear. */
const settle = () => vi.advanceTimersByTimeAsync(SESSION_CLEAR_DELAY);

const openItem = (itemId: string) => {
  store.dispatch(setPage('review'));
  store.dispatch(setCurrentItemId(itemId));
};

// #endregion

beforeEach(() => {
  vi.useFakeTimers();
  store.dispatch(resetSession());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SessionTracker', () => {
  it('saves the item review is showing', async () => {
    const { saved, stop } = makeTracker();

    openItem('item-1');
    await flush();

    expect(saved).toEqual([{ deviceId: DEVICE, itemId: 'item-1' }]);
    stop();
  });

  it('saves nothing while review is not showing an item', async () => {
    const { save, stop } = makeTracker();

    store.dispatch(setPage('review'));
    store.dispatch(setCurrentItemId(null));
    await settle();

    expect(save).not.toHaveBeenCalled();
    stop();
  });

  it('does not rewrite the item restored from disk', async () => {
    const { save, stop } = makeTracker('item-1');

    openItem('item-1');
    await settle();

    expect(save).not.toHaveBeenCalled();
    stop();
  });

  it('follows the item across an advance without clearing in between', async () => {
    const { saved, stop } = makeTracker();

    openItem('item-1');
    await flush();
    // How every advance looks: the id empties, then the next one arrives.
    store.dispatch(resetCurrentItem());
    store.dispatch(setCurrentItemId('item-2'));
    await settle();

    expect(saved).toEqual([
      { deviceId: DEVICE, itemId: 'item-1' },
      { deviceId: DEVICE, itemId: 'item-2' },
    ]);
    stop();
  });

  it('drops the item when the queue runs out', async () => {
    const { saved, stop } = makeTracker();

    openItem('item-1');
    await flush();
    // The "nothing due" screen: no next item to replace the one just finished.
    store.dispatch(resetCurrentItem());
    await settle();

    expect(saved.at(-1)).toBeNull();
    stop();
  });

  it('writes an empty queue out once, not on every refetch', async () => {
    const { saved, stop } = makeTracker();

    openItem('item-1');
    await flush();
    store.dispatch(resetCurrentItem());
    await settle();
    // The "nothing due" screen refetches on a timer, re-dispatching the same
    // empty result each time.
    store.dispatch(setCurrentItemId(null));
    await settle();

    expect(saved).toEqual([{ deviceId: DEVICE, itemId: 'item-1' }, null]);
    stop();
  });

  it('drops the item when the user goes back to the home screen', async () => {
    const { saved, stop } = makeTracker();

    openItem('item-1');
    await flush();
    store.dispatch(setPage('home'));
    await settle();

    expect(saved.at(-1)).toBeNull();
    stop();
  });

  it('keeps an item carried over from the last launch off screen', async () => {
    // Launched with a remembered item but no review tab: the home screen is
    // where the user starts, not somewhere they navigated to.
    const { save, stop } = makeTracker('item-1');

    store.dispatch(setPage('home'));
    await settle();

    expect(save).not.toHaveBeenCalled();
    stop();
  });

  it('drops a carried-over item once the tab it was restored into leaves review', async () => {
    // The tab came back on the item, so the next trip to the home screen is a
    // real departure.
    openItem('item-1');
    const { saved, stop } = makeTracker('item-1');

    store.dispatch(setPage('home'));
    await settle();

    expect(saved).toEqual([null]);
    stop();
  });

  it('keeps the item when the review tab is closed', async () => {
    const { tracker, saved, stop } = makeTracker();

    openItem('item-1');
    await flush();
    tracker.commit();
    // What closing the tab dispatches — the same reset leaving review would.
    store.dispatch(resetSession());
    await settle();

    expect(saved).toEqual([{ deviceId: DEVICE, itemId: 'item-1' }]);
    stop();
  });

  it('keeps holding while a reopened tab sits on the home screen', async () => {
    const { tracker, saved, stop } = makeTracker();

    openItem('item-1');
    await flush();
    tracker.commit();
    store.dispatch(resetSession());
    await settle();
    // Reopening review lands on the home screen before the user goes back in.
    store.dispatch(setPage('home'));
    await settle();

    expect(saved).toEqual([{ deviceId: DEVICE, itemId: 'item-1' }]);
    stop();
  });

  it('clears again once review has shown an item since the close', async () => {
    const { tracker, saved, stop } = makeTracker();

    openItem('item-1');
    await flush();
    tracker.commit();
    store.dispatch(resetSession());
    await settle();
    openItem('item-2');
    await flush();
    store.dispatch(setPage('home'));
    await settle();

    expect(saved).toEqual([
      { deviceId: DEVICE, itemId: 'item-1' },
      { deviceId: DEVICE, itemId: 'item-2' },
      null,
    ]);
    stop();
  });

  it('drops the item when the tab is closed with the queue run out', async () => {
    const { tracker, saved, stop } = makeTracker();

    openItem('item-1');
    await flush();
    // The last item was reviewed, so the "nothing due" screen is what the tab
    // is closed on — nothing there to come back to.
    store.dispatch(resetCurrentItem());
    tracker.commit();
    store.dispatch(resetSession());
    await flush();

    // Written on the close itself, not left on the clear timer.
    expect(saved).toEqual([{ deviceId: DEVICE, itemId: 'item-1' }, null]);
    await settle();
    expect(saved).toHaveLength(2);
    stop();
  });

  it('drops the item when the tab is closed from the home screen', async () => {
    const { tracker, saved, stop } = makeTracker();

    openItem('item-1');
    await flush();
    // Leaving review earns the clear; closing within the delay must not undo
    // it, or the next resume reopens an item the user walked away from.
    store.dispatch(setPage('home'));
    tracker.commit();
    store.dispatch(resetSession());
    await flush();

    expect(saved).toEqual([{ deviceId: DEVICE, itemId: 'item-1' }, null]);
    await settle();
    expect(saved).toHaveLength(2);
    stop();
  });

  it('leaves the pointer alone when a tab that never reached the item closes', async () => {
    const { tracker, saved, stop } = makeTracker();

    openItem('item-1');
    await flush();
    tracker.commit();
    store.dispatch(resetSession());
    // Reopened onto the home screen and closed again without going back in:
    // this tab has no state of its own, so the earlier tab's item stands.
    tracker.commit();
    store.dispatch(resetSession());
    await settle();

    expect(saved).toEqual([{ deviceId: DEVICE, itemId: 'item-1' }]);
    stop();
  });

  it('erases the item when the last tab leaves review and then closes', async () => {
    const { tracker, saved, stop } = makeTracker();

    openItem('item-1');
    await flush();
    store.dispatch(setPage('home'));
    tracker.commit();
    store.dispatch(resetSession());
    // Quitting right after the close cancels anything still on the timer, so
    // the departure has to have been written by the close itself.
    void tracker.suspend();
    await settle();

    expect(saved).toEqual([{ deviceId: DEVICE, itemId: 'item-1' }, null]);
    stop();
  });

  it('writes nothing for a tab that closes as part of teardown', async () => {
    const { tracker, saved, stop } = makeTracker();

    openItem('item-1');
    await flush();
    void tracker.suspend();
    // Quitting closes the tabs too, and reaches them in its own order: by the
    // time one of them commits, the session may already have been emptied.
    store.dispatch(resetSession());
    tracker.commit();
    await settle();

    expect(saved).toEqual([{ deviceId: DEVICE, itemId: 'item-1' }]);
    stop();
  });

  it('records the item of whichever tab closes last', async () => {
    const { tracker, saved, stop } = makeTracker();

    // One tab closes on its item, another opens, moves on, and closes too.
    openItem('item-1');
    await flush();
    tracker.commit();
    store.dispatch(resetSession());
    openItem('item-2');
    await flush();
    tracker.commit();
    store.dispatch(resetSession());
    await settle();

    expect(saved).toEqual([
      { deviceId: DEVICE, itemId: 'item-1' },
      { deviceId: DEVICE, itemId: 'item-2' },
    ]);
    stop();
  });

  it('drops the item when the tab is closed just before the finish lands', async () => {
    const { tracker, saved, stop } = makeTracker();

    openItem('item-1');
    await flush();
    // Acting on an item writes to the database first, so a close in the moments
    // after the click reaches the tracker while the item is still on screen.
    tracker.commit();
    store.dispatch(resetSession());
    tracker.finish();
    store.dispatch(resetCurrentItem());
    await settle();

    expect(saved).toEqual([{ deviceId: DEVICE, itemId: 'item-1' }, null]);
    stop();
  });

  it('still writes one pointer per advance when the finish is announced', async () => {
    const { tracker, saved, stop } = makeTracker();

    openItem('item-1');
    await flush();
    tracker.finish();
    store.dispatch(resetCurrentItem());
    store.dispatch(setCurrentItemId('item-2'));
    await settle();

    expect(saved).toEqual([
      { deviceId: DEVICE, itemId: 'item-1' },
      { deviceId: DEVICE, itemId: 'item-2' },
    ]);
    stop();
  });

  it('reports the item it is holding', async () => {
    const { tracker, stop } = makeTracker();

    openItem('item-1');
    await flush();

    expect(tracker.itemId).toBe('item-1');
    stop();
  });

  it('reports the item restored from disk', () => {
    const { tracker, stop } = makeTracker('item-1');

    expect(tracker.itemId).toBe('item-1');
    stop();
  });

  it('reports no item while a clear is still on the timer', async () => {
    const { tracker, stop } = makeTracker();

    openItem('item-1');
    await flush();
    store.dispatch(resetCurrentItem());

    // `data.json` still names item-1 for another SESSION_CLEAR_DELAY ms.
    expect(tracker.itemId).toBeNull();
    stop();
  });

  it('reports a failed save and keeps mirroring', async () => {
    const error = new Error('disk full');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { saved, stop } = makeTracker();
    const failing = vi
      .fn<(session: ReviewSession | null) => Promise<void>>()
      .mockRejectedValueOnce(error);
    stop();
    const tracker = new SessionTracker({
      store,
      deviceId: DEVICE,
      save: async (session) => {
        await failing(session);
        saved.push(session);
      },
    });
    const stopFailing = tracker.start();

    openItem('item-1');
    await flush();
    openItem('item-2');
    await flush();

    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('failed to save session'),
      error
    );
    expect(saved).toEqual([{ deviceId: DEVICE, itemId: 'item-2' }]);
    stopFailing();
  });

  it('keeps the item when the session is torn down instead of closed', async () => {
    const { tracker, saved, stop } = makeTracker();

    openItem('item-1');
    await flush();
    void tracker.suspend();
    // What quitting pushes through the store on its way out.
    store.dispatch(resetSession());
    await settle();

    expect(saved).toEqual([{ deviceId: DEVICE, itemId: 'item-1' }]);
    stop();
  });

  it('writes out a clear that was already pending when suspended', async () => {
    // Going back to the home screen is a departure, and quitting inside the
    // delay must not undo it: everything teardown sends arrives after the
    // suspend, so a timer still running was the user leaving the item.
    const { tracker, saved, stop } = makeTracker();

    openItem('item-1');
    await flush();
    store.dispatch(setPage('home'));
    void tracker.suspend();
    await settle();

    expect(saved).toEqual([{ deviceId: DEVICE, itemId: 'item-1' }, null]);
    stop();
  });

  it('writes out the last item finished when suspended before the next arrives', async () => {
    // Reviewing the last item due and quitting on the "nothing due" screen
    // inside the delay — the pointer has to go, or review resumes on an item
    // the user is done with.
    const { tracker, saved, stop } = makeTracker();

    openItem('item-1');
    await flush();
    tracker.finish();
    store.dispatch(resetCurrentItem());
    void tracker.suspend();
    await settle();

    expect(saved).toEqual([{ deviceId: DEVICE, itemId: 'item-1' }, null]);
    stop();
  });

  it('resolves suspending only once the write it settles has landed', async () => {
    // The quit hands this to `Tasks.addPromise`, so the app waits for
    // `data.json` rather than closing over a half-finished save.
    let release = () => {};
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const tracker = new SessionTracker({
      store,
      deviceId: DEVICE,
      save,
      initialItemId: 'item-1',
    });
    const stop = tracker.start();
    openItem('item-1');
    store.dispatch(setPage('home'));

    const settled = vi.fn();
    void tracker.suspend().then(settled);
    await flush();
    expect(settled).not.toHaveBeenCalled();

    release();
    await flush();

    expect(settled).toHaveBeenCalled();
    stop();
  });

  it('has nothing to settle when nothing was pending', async () => {
    const { tracker, saved, stop } = makeTracker();

    openItem('item-1');
    await flush();
    await expect(tracker.suspend()).resolves.toBeUndefined();

    expect(saved).toEqual([{ deviceId: DEVICE, itemId: 'item-1' }]);
    stop();
  });

  it('erases a pointer it is told to forget', async () => {
    // The resume found the item gone from the database.
    const { tracker, saved, stop } = makeTracker('item-1');

    tracker.forget();
    await flush();

    expect(saved).toEqual([null]);
    stop();
  });

  it('stops offering a forgotten pointer back', async () => {
    // The whole reason this goes through the tracker: writing straight to the
    // file would leave it holding the dead id for the next resume to read.
    const { tracker, stop } = makeTracker('item-1');

    tracker.forget();

    expect(tracker.itemId).toBeNull();
    stop();
  });

  it('erases a pointer whose item is dismissed with no tab open', async () => {
    // Dismissing a note from its own action bar: no review tab, so the store
    // has no current item to match it against and nothing else notices.
    const { tracker, saved, stop } = makeTracker('item-1');

    tracker.forgetIf('item-1');
    await settle();

    expect(saved).toEqual([null]);
    stop();
  });

  it('leaves a pointer to a different item alone', async () => {
    const { tracker, save, stop } = makeTracker('item-1');

    tracker.forgetIf('item-2');
    await settle();

    expect(save).not.toHaveBeenCalled();
    stop();
  });

  it('coalesces with the advance when the item dismissed is on screen', async () => {
    // Dismissing from inside review ends on `getNext`, so the next item names
    // the pointer before the clear lands: one write, as on every other advance.
    const { tracker, saved, stop } = makeTracker();

    openItem('item-1');
    await flush();
    tracker.forgetIf('item-1');
    tracker.finish();
    store.dispatch(resetCurrentItem());
    store.dispatch(setCurrentItemId('item-2'));
    await settle();

    expect(saved).toEqual([
      { deviceId: DEVICE, itemId: 'item-1' },
      { deviceId: DEVICE, itemId: 'item-2' },
    ]);
    stop();
  });

  it('writes nothing to forget an item once suspended', async () => {
    const { tracker, save, stop } = makeTracker('item-1');

    void tracker.suspend();
    tracker.forgetIf('item-1');
    await settle();

    expect(save).not.toHaveBeenCalled();
    stop();
  });

  it('writes nothing to forget a pointer it never had', async () => {
    const { tracker, save, stop } = makeTracker();

    tracker.forget();
    await flush();

    expect(save).not.toHaveBeenCalled();
    stop();
  });

  it('writes nothing to forget once suspended', async () => {
    const { tracker, save, stop } = makeTracker('item-1');

    void tracker.suspend();
    tracker.forget();
    await flush();

    expect(save).not.toHaveBeenCalled();
    stop();
  });

  it('stops saving once its cleanup has run', async () => {
    const { save, stop } = makeTracker();

    stop();
    openItem('item-1');
    await settle();

    expect(save).not.toHaveBeenCalled();
  });

  it('leaves no timer behind for a clear it never wrote', async () => {
    const { save, stop } = makeTracker();

    openItem('item-1');
    await flush();
    store.dispatch(setPage('home'));
    stop();
    await settle();

    expect(save).toHaveBeenCalledTimes(1);
  });

  it('ends up holding whatever review is showing, however it got there', async () => {
    type Step =
      | { op: 'open'; itemId: string }
      | { op: 'advance'; itemId: string | null }
      | { op: 'home' }
      | { op: 'review' };

    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc
              .string({ minLength: 1, maxLength: 3 })
              .map((itemId) => ({ op: 'open' as const, itemId })),
            fc
              .option(fc.string({ minLength: 1, maxLength: 3 }), { nil: null })
              .map((itemId) => ({ op: 'advance' as const, itemId })),
            fc.constant({ op: 'home' as const }),
            fc.constant({ op: 'review' as const })
          ),
          { maxLength: 12 }
        ),
        async (steps: Step[]) => {
          store.dispatch(resetSession());
          const { saved, stop } = makeTracker();

          for (const step of steps) {
            if (step.op === 'open') openItem(step.itemId);
            if (step.op === 'advance') {
              store.dispatch(resetCurrentItem());
              if (step.itemId) store.dispatch(setCurrentItemId(step.itemId));
            }
            if (step.op === 'home') store.dispatch(setPage('home'));
            if (step.op === 'review') store.dispatch(setPage('review'));
            await flush();
          }
          await settle();
          stop();

          const { page, currentItemId } = store.getState();
          const shown = page === 'review' ? currentItemId : null;
          const written = saved.length ? saved.at(-1) : null;

          expect(written?.itemId ?? null).toBe(shown);
        }
      )
    );
  });
});
