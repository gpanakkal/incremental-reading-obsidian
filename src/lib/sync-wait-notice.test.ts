// @vitest-environment jsdom

// The mock the vitest config aliases `obsidian` to, imported by path so its
// recorded notices are visible to the type checker
import { Notice } from '#/test/__mocks__/obsidian';
import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeSyncWait, SyncWaitNotice } from './sync-wait-notice';

// #region HELPERS

/** A notice wired to a review tab that is open as `open` says. */
function makeNotice(reviewOpen = true) {
  const state = { reviewOpen };
  const importNow = vi.fn();
  const notice = new SyncWaitNotice({
    reviewOpen: () => state.reviewOpen,
    importNow,
  });
  return { notice, importNow, state };
}

/** The notices raised and not hidden since. */
const shown = () => Notice.instances.filter(({ hides }) => hides === 0);

/** Press the button on `notice`. */
const press = (notice: Notice) => {
  const button = notice.containerEl.querySelector<HTMLElement>('.notice-cta');
  button?.click();
  return button;
};

// #endregion

beforeEach(() => {
  Notice.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SyncWaitNotice', () => {
  it('property: shows one lasting notice with the count while notes wait and a review tab is open, and none otherwise', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ waiting: fc.nat({ max: 5 }), open: fc.boolean() }),
          {
            maxLength: 8,
          }
        ),
        (steps) => {
          Notice.reset();
          const { notice, state } = makeNotice(false);
          let waiting = 0;
          let up = false;
          for (const step of steps) {
            state.reviewOpen = step.open;
            const changed = step.waiting !== waiting;
            waiting = step.waiting;
            notice.setWaiting(waiting);
            if (changed) up = waiting > 0 && step.open;
            const visible = shown();
            expect(visible).toHaveLength(up ? 1 : 0);
            if (up) {
              expect(visible[0].duration).toBe(0);
              expect(visible[0].message).toMatch(
                new RegExp(`\\b${waiting}\\b`)
              );
            }
          }
        }
      )
    );
  });

  it('property: over any review tabs opening and closing and counts changing, shows at most one notice, only while a review tab is open and notes wait', () => {
    const stepArb = fc.oneof(
      fc
        .nat({ max: 3 })
        .map((waiting) => ({ kind: 'count' as const, waiting })),
      fc.constant({ kind: 'open' as const }),
      fc.constant({ kind: 'close' as const })
    );
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 12 }), (steps) => {
        Notice.reset();
        const { notice, state } = makeNotice(false);
        let tabs = 0;
        let waiting = 0;
        let up = false;
        for (const step of steps) {
          if (step.kind === 'count') {
            if (step.waiting !== waiting) up = step.waiting > 0 && tabs > 0;
            waiting = step.waiting;
            notice.setWaiting(waiting);
          } else if (step.kind === 'open') {
            tabs++;
            state.reviewOpen = true;
            notice.reviewOpened();
            up = waiting > 0;
          } else if (tabs > 0) {
            tabs--;
            state.reviewOpen = tabs > 0;
            notice.reviewClosed();
            if (tabs === 0) up = false;
          }
          const visible = shown();
          expect(visible).toHaveLength(up ? 1 : 0);
          if (visible.length > 0) expect(tabs).toBeGreaterThan(0);
        }
      })
    );
  });

  it('shows the notice again as a review tab opens while notes wait, and not when none do', () => {
    const { notice, state } = makeNotice(false);
    notice.reviewOpened();
    expect(Notice.instances).toHaveLength(0);

    notice.setWaiting(3);
    expect(shown()).toHaveLength(0);
    state.reviewOpen = true;
    notice.reviewOpened();
    expect(shown()).toHaveLength(1);
    notice.reviewOpened();
    expect(shown()).toHaveLength(1);
    expect(Notice.instances).toHaveLength(2);
  });

  it('imports once when its button is pressed, and takes the notice down', () => {
    const { notice, importNow } = makeNotice();
    notice.setWaiting(2);
    const [raised] = shown();

    expect(press(raised)).not.toBeNull();
    expect(importNow).toHaveBeenCalledOnce();
    const hides = raised.hides;
    expect(hides).toBeGreaterThan(0);

    // A later count raises a notice of its own, leaving the pressed one be
    notice.setWaiting(1);
    expect(raised.hides).toBe(hides);
    expect(shown()).toHaveLength(1);
  });

  it('keeps track of the notice up when the button of one it replaced is pressed', () => {
    const { notice, importNow } = makeNotice();
    notice.setWaiting(2);
    const [replaced] = shown();
    notice.setWaiting(3);
    const [current] = shown();

    press(replaced);
    notice.setWaiting(0);

    expect(importNow).toHaveBeenCalledOnce();
    expect(current.hides).toBe(1);
  });

  it('takes the notice down when disposed, counting none waiting', () => {
    const { notice } = makeNotice();
    notice.setWaiting(2);
    const [raised] = shown();

    notice.dispose();
    notice.setWaiting(2);

    expect(raised.hides).toBe(1);
    expect(shown()).toHaveLength(1);
  });
});

describe('describeSyncWait', () => {
  it('property: names the count, a single import as one', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000 }), (waiting) => {
        const message = describeSyncWait(waiting);
        expect(message).toMatch(new RegExp(`^${waiting}\\b`));
        expect(/\bimports\b/.test(message)).toBe(waiting !== 1);
        expect(/\bimport\b/.test(message)).toBe(waiting === 1);
      })
    );
  });
});
