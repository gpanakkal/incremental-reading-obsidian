// @vitest-environment jsdom
import { Notice } from '#/test/__mocks__/obsidian';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIrIdWarning,
  IR_ID_WARNING_MAX_LIFETIME_MS,
  IR_ID_WARNING_MESSAGE,
  IR_ID_WARNING_WINDOW_MS,
  irIdWarningMessage,
  persistentNotice,
  type IrIdWarningDeps,
  type NoticeFactory,
  type NoticeTarget,
} from './ir-id-warning-notice';

// #region HELPERS

/** How long Obsidian's hide animation runs before it detaches the element. */
const HIDE_ANIMATION_MS = 120;

interface FakeNotice extends NoticeTarget {
  /** Every message shown, the one it was created with first. */
  messages: string[];
  hides: number;
}

/**
 * Notices that behave as Obsidian's do: a click hides them, and the element
 * stays in the document until the hide animation has run.
 */
function makeNotices() {
  const raised: FakeNotice[] = [];
  const createNotice = vi.fn<NoticeFactory>((message: string) => {
    const containerEl = document.createElement('div');
    document.body.appendChild(containerEl);
    const notice: FakeNotice = {
      containerEl,
      messages: [message],
      hides: 0,
      setMessage(next: string) {
        notice.messages.push(next);
        return notice;
      },
      hide() {
        notice.hides += 1;
        setTimeout(() => containerEl.remove(), HIDE_ANIMATION_MS);
      },
    };
    // Obsidian's own listener, registered in the Notice constructor and so
    // before the one the warning adds
    containerEl.addEventListener('click', () => notice.hide());
    raised.push(notice);
    return notice;
  });
  return { raised, createNotice };
}

/**
 * A warning over fake notices, showing the repair path's message unless the
 * case names one of its own.
 */
function makeWarning(
  deps: Partial<Omit<IrIdWarningDeps, 'createNotice'>> = {}
) {
  // Per case, not per `it`: a property runs this many times over, and timers or
  // elements left by the last case would otherwise be read as this case's
  vi.clearAllTimers();
  document.body.replaceChildren();
  const { raised, createNotice } = makeNotices();
  const warning = createIrIdWarning({
    createNotice,
    message: IR_ID_WARNING_MESSAGE,
    ...deps,
  });
  return { warning, raised, createNotice };
}

/**
 * Any message a caller could hand the warning, including an empty one and one
 * that already ends in something shaped like a count.
 */
const messageArb = fc.oneof(
  fc.string(),
  fc.string().map((message) => `${message} (×2)`)
);

/** The click Obsidian itself listens for, which hides the notice. */
const clickAway = (notice: FakeNotice) =>
  notice.containerEl.dispatchEvent(new MouseEvent('click'));

/** A phone swipe-to-dismiss: the element goes, with no click to hear. */
const swipeAway = (notice: FakeNotice) => notice.containerEl.remove();

/** The pointer coming to rest on the notice, and leaving it again. */
const pointerOnto = (notice: FakeNotice) =>
  notice.containerEl.dispatchEvent(new MouseEvent('mouseenter'));
const pointerOff = (notice: FakeNotice) =>
  notice.containerEl.dispatchEvent(new MouseEvent('mouseleave'));

/** Window and cap, with the cap never shorter than the window. */
const timingArb = fc
  .record({
    windowMs: fc.integer({ min: 2, max: 60_000 }),
    extra: fc.integer({ min: 0, max: 120_000 }),
  })
  .map(({ windowMs, extra }) => ({
    windowMs,
    maxLifetimeMs: windowMs + extra,
  }));

/** A burst: the gaps between consecutive events, each inside the window. */
const burstArb = (windowMs: number) =>
  fc.array(fc.integer({ min: 0, max: windowMs - 1 }), {
    minLength: 1,
    maxLength: 12,
  });

/**
 * A window, a cap a few windows long, and a gap that keeps the notice alive
 * while it lasts. The gap is at least half a window, which is what holds the
 * burst to a dozen or so events: a gap of 1ms against a cap of minutes would
 * have a property spend a million calls per case.
 */
const cappedBurstArb = fc
  .record({
    windowMs: fc.integer({ min: 4, max: 60_000 }),
    windows: fc.integer({ min: 1, max: 8 }),
    gapShare: fc.double({ min: 0.5, max: 0.99, noNaN: true }),
  })
  .map(({ windowMs, windows, gapShare }) => ({
    windowMs,
    maxLifetimeMs: windowMs * windows,
    gap: Math.min(windowMs - 1, Math.round(windowMs * gapShare)),
  }));

/**
 * A window, how much of it has run when the pointer arrives, and how long the
 * pointer stays. `used` leaves at least 2ms of window on either side, so that a
 * window resumed with what was left of it is telling apart from a fresh one.
 */
const hoverArb = fc
  .record({
    windowMs: fc.integer({ min: 8, max: 60_000 }),
    usedShare: fc.double({ min: 0, max: 1, noNaN: true }),
    hoverMs: fc.integer({ min: 0, max: 600_000 }),
  })
  .map(({ windowMs, usedShare, hoverMs }) => ({
    windowMs,
    used: Math.min(windowMs - 2, Math.max(2, Math.floor(windowMs * usedShare))),
    hoverMs,
  }));

/**
 * A cap no burst of these gaps can reach, so that what ends the notice is the
 * window and nothing else.
 */
const capFor = (gaps: readonly number[], windowMs: number, slack = 0) =>
  gaps.reduce((sum, gap) => sum + gap, 0) + windowMs + slack + 1;

// #endregion

describe('irIdWarningMessage', () => {
  it('warns about ir-id in a message short enough to read on a phone', () => {
    expect(IR_ID_WARNING_MESSAGE).toContain('ir-id');
    expect(IR_ID_WARNING_MESSAGE.length).toBeLessThanOrEqual(140);
  });

  it('shows no count for a window that caught a single event', () => {
    fc.assert(
      fc.property(
        messageArb,
        fc.integer({ min: -1000, max: 1 }),
        (message, count) => {
          expect(irIdWarningMessage(message, count)).toBe(message);
        }
      )
    );
  });

  it('appends the count once a window has caught more than one event', () => {
    fc.assert(
      fc.property(
        messageArb,
        fc.integer({ min: 2, max: 1_000_000 }),
        (message, count) => {
          expect(irIdWarningMessage(message, count)).toBe(
            `${message} (×${count})`
          );
        }
      )
    );
  });
});

describe('persistentNotice', () => {
  it('raises a notice that stays until it is hidden', () => {
    fc.assert(
      fc.property(fc.string(), (message) => {
        Notice.reset();

        const notice = persistentNotice(message);

        expect(notice).toBeInstanceOf(Notice);
        expect(Notice.messages).toEqual([message]);
      })
    );
  });
});

describe('createIrIdWarning', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('raises one uncounted notice for a lone event and hides it when the window closes', () => {
    fc.assert(
      fc.property(timingArb, ({ windowMs, maxLifetimeMs }) => {
        const { warning, raised, createNotice } = makeWarning({
          windowMs,
          maxLifetimeMs,
        });

        warning.warn();

        expect(createNotice).toHaveBeenCalledTimes(1);
        expect(raised[0].messages).toEqual([IR_ID_WARNING_MESSAGE]);

        vi.advanceTimersByTime(windowMs - 1);
        expect(raised[0].hides).toBe(0);
        vi.advanceTimersByTime(1);
        expect(raised[0].hides).toBe(1);
      })
    );
  });

  it('folds a burst into the notice on screen, counting the events as they land', () => {
    fc.assert(
      fc.property(
        timingArb.chain((timing) =>
          fc.record({
            timing: fc.constant(timing),
            gaps: burstArb(timing.windowMs),
          })
        ),
        ({ timing: { windowMs, maxLifetimeMs }, gaps }) => {
          const { warning, raised, createNotice } = makeWarning({
            windowMs,
            // Enough headroom that the cap cannot be what ends this burst
            maxLifetimeMs: Math.max(maxLifetimeMs, capFor(gaps, windowMs)),
          });

          warning.warn();
          for (const gap of gaps) {
            vi.advanceTimersByTime(gap);
            warning.warn();
          }

          expect(createNotice).toHaveBeenCalledTimes(1);
          expect(raised[0].messages).toEqual([
            IR_ID_WARNING_MESSAGE,
            ...gaps.map((_, n) =>
              irIdWarningMessage(IR_ID_WARNING_MESSAGE, n + 2)
            ),
          ]);

          // The window slides: it closes a window after the last event, not
          // after the first
          vi.advanceTimersByTime(windowMs - 1);
          expect(raised[0].hides).toBe(0);
          vi.advanceTimersByTime(1);
          expect(raised[0].hides).toBe(1);
        }
      )
    );
  });

  it('shows the message it was given, counting a burst onto it', () => {
    fc.assert(
      fc.property(
        messageArb,
        fc.integer({ min: 0, max: 12 }),
        (message, repeats) => {
          const { warning, raised } = makeWarning({ message });

          warning.warn();
          for (let n = 0; n < repeats; n++) warning.warn();

          expect(raised).toHaveLength(1);
          expect(raised[0].messages).toEqual([
            message,
            ...Array.from({ length: repeats }, (_, n) =>
              irIdWarningMessage(message, n + 2)
            ),
          ]);
        }
      )
    );
  });

  describe('with the count turned off', () => {
    it('folds a burst into one notice that never shows a count, and slides its window as ever', () => {
      fc.assert(
        fc.property(
          messageArb,
          timingArb.chain((timing) =>
            fc.record({
              timing: fc.constant(timing),
              gaps: burstArb(timing.windowMs),
            })
          ),
          (message, { timing: { windowMs, maxLifetimeMs }, gaps }) => {
            const { warning, raised, createNotice } = makeWarning({
              message,
              showCount: false,
              windowMs,
              maxLifetimeMs: Math.max(maxLifetimeMs, capFor(gaps, windowMs)),
            });

            warning.warn();
            for (const gap of gaps) {
              vi.advanceTimersByTime(gap);
              warning.warn();
            }

            expect(createNotice).toHaveBeenCalledTimes(1);
            // Not rewritten at all: the text it would be rewritten to is the
            // text already on screen
            expect(raised[0].messages).toEqual([message]);

            vi.advanceTimersByTime(windowMs - 1);
            expect(raised[0].hides).toBe(0);
            vi.advanceTimersByTime(1);
            expect(raised[0].hides).toBe(1);
          }
        )
      );
    });

    it('still raises a fresh notice once the one on screen has ended', () => {
      fc.assert(
        fc.property(messageArb, timingArb, (message, timing) => {
          const { warning, raised, createNotice } = makeWarning({
            message,
            showCount: false,
            ...timing,
          });

          warning.warn();
          vi.advanceTimersByTime(timing.windowMs);
          warning.warn();

          expect(createNotice).toHaveBeenCalledTimes(2);
          expect(raised[1].messages).toEqual([message]);
        })
      );
    });
  });

  it('hides the notice at its cap however long the burst runs on', () => {
    fc.assert(
      fc.property(cappedBurstArb, ({ windowMs, maxLifetimeMs, gap }) => {
        const { warning, raised, createNotice } = makeWarning({
          windowMs,
          maxLifetimeMs,
        });

        warning.warn();
        let elapsed = 0;
        // Right up to the cap, so the notice is only ever extended by events
        // that found it still on screen
        while (elapsed + gap < maxLifetimeMs) {
          vi.advanceTimersByTime(gap);
          elapsed += gap;
          warning.warn();
        }

        expect(createNotice).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(maxLifetimeMs - elapsed - 1);
        expect(raised[0].hides).toBe(0);
        vi.advanceTimersByTime(1);
        expect(raised[0].hides).toBe(1);

        // The count belongs to the notice that is gone
        warning.warn();
        expect(createNotice).toHaveBeenCalledTimes(2);
        expect(raised[1].messages).toEqual([IR_ID_WARNING_MESSAGE]);
      })
    );
  });

  it('raises a fresh uncounted notice for an event arriving after the window closed', () => {
    fc.assert(
      fc.property(
        timingArb,
        fc.integer({ min: 0, max: 60_000 }),
        ({ windowMs, maxLifetimeMs }, idle) => {
          const { warning, raised, createNotice } = makeWarning({
            windowMs,
            maxLifetimeMs,
          });

          warning.warn();
          vi.advanceTimersByTime(windowMs + idle);
          warning.warn();

          expect(createNotice).toHaveBeenCalledTimes(2);
          expect(raised[0].messages).toEqual([IR_ID_WARNING_MESSAGE]);
          expect(raised[1].messages).toEqual([IR_ID_WARNING_MESSAGE]);
        }
      )
    );
  });

  it('raises a fresh notice once the user has clicked the one on screen away', () => {
    fc.assert(
      fc.property(
        timingArb.chain((timing) =>
          fc.record({
            timing: fc.constant(timing),
            gaps: burstArb(timing.windowMs),
            // Whether the hide animation has finished detaching the element by
            // the time the next event lands
            detached: fc.boolean(),
          })
        ),
        ({ timing: { windowMs, maxLifetimeMs }, gaps, detached }) => {
          const { warning, raised, createNotice } = makeWarning({
            windowMs,
            maxLifetimeMs: Math.max(
              maxLifetimeMs,
              capFor(gaps, windowMs, HIDE_ANIMATION_MS)
            ),
          });

          warning.warn();
          clickAway(raised[0]);
          if (detached) vi.advanceTimersByTime(HIDE_ANIMATION_MS);
          for (const gap of gaps) {
            vi.advanceTimersByTime(gap);
            warning.warn();
          }

          expect(createNotice).toHaveBeenCalledTimes(2);
          // Never written to again, which would have shown the user nothing
          expect(raised[0].messages).toEqual([IR_ID_WARNING_MESSAGE]);
          // Hidden once, by Obsidian's own click handler, and not again by us
          expect(raised[0].hides).toBe(1);
          expect(raised[1].messages).toEqual([
            IR_ID_WARNING_MESSAGE,
            ...gaps
              .slice(1)
              .map((_, n) => irIdWarningMessage(IR_ID_WARNING_MESSAGE, n + 2)),
          ]);
        }
      )
    );
  });

  it('raises a fresh notice once the one on screen has gone without a click', () => {
    fc.assert(
      fc.property(timingArb, ({ windowMs, maxLifetimeMs }) => {
        const { warning, raised, createNotice } = makeWarning({
          windowMs,
          maxLifetimeMs,
        });

        warning.warn();
        swipeAway(raised[0]);
        warning.warn();

        expect(createNotice).toHaveBeenCalledTimes(2);
        expect(raised[0].messages).toEqual([IR_ID_WARNING_MESSAGE]);
        expect(raised[0].hides).toBe(0);
        expect(raised[1].messages).toEqual([IR_ID_WARNING_MESSAGE]);
      })
    );
  });

  it('hides the notice and stops its timer when disposed', () => {
    fc.assert(
      fc.property(
        timingArb.chain((timing) =>
          fc.record({
            timing: fc.constant(timing),
            gaps: burstArb(timing.windowMs),
          })
        ),
        ({ timing: { windowMs, maxLifetimeMs }, gaps }) => {
          const { warning, raised } = makeWarning({
            windowMs,
            maxLifetimeMs: Math.max(maxLifetimeMs, capFor(gaps, windowMs)),
          });

          warning.warn();
          for (const gap of gaps) {
            vi.advanceTimersByTime(gap);
            warning.warn();
          }
          warning.dispose();

          expect(raised).toHaveLength(1);
          expect(raised[0].hides).toBe(1);
          vi.advanceTimersByTime(windowMs + maxLifetimeMs);
          expect(raised[0].hides).toBe(1);
        }
      )
    );
  });

  it('leaves a notice the user dismissed alone when disposed', () => {
    const { warning, raised } = makeWarning();

    warning.warn();
    clickAway(raised[0]);
    warning.dispose();

    expect(raised[0].hides).toBe(1);
  });

  it('takes its listeners back off a notice that has ended', () => {
    const { warning, raised } = makeWarning();

    warning.warn();
    const removeEventListener = vi.spyOn(
      raised[0].containerEl,
      'removeEventListener'
    );
    warning.dispose();

    for (const event of ['click', 'mouseenter', 'mouseleave']) {
      expect(removeEventListener).toHaveBeenCalledWith(
        event,
        expect.any(Function)
      );
    }
  });

  it('does nothing when disposed with no notice on screen', () => {
    const { warning, createNotice } = makeWarning();

    warning.dispose();
    vi.advanceTimersByTime(IR_ID_WARNING_MAX_LIFETIME_MS);

    expect(createNotice).not.toHaveBeenCalled();
  });

  it('runs on the host clock and timer, over a window of its own', () => {
    const { warning, raised } = makeWarning();

    warning.warn();
    vi.advanceTimersByTime(IR_ID_WARNING_WINDOW_MS - 1);
    expect(raised[0].hides).toBe(0);
    vi.advanceTimersByTime(1);
    expect(raised[0].hides).toBe(1);
  });

  describe('while the pointer rests on the notice', () => {
    it('holds the window, and resumes with what was left of it', () => {
      fc.assert(
        fc.property(hoverArb, ({ windowMs, used, hoverMs }) => {
          const { warning, raised } = makeWarning({
            windowMs,
            // Beyond anything this case can reach, so the cap is not what ends it
            maxLifetimeMs: used + hoverMs + windowMs + 1,
          });

          warning.warn();
          vi.advanceTimersByTime(used);
          pointerOnto(raised[0]);
          vi.advanceTimersByTime(hoverMs);

          expect(raised[0].hides).toBe(0);

          pointerOff(raised[0]);
          // What was left when the pointer arrived, not a fresh window
          vi.advanceTimersByTime(windowMs - used - 1);
          expect(raised[0].hides).toBe(0);
          vi.advanceTimersByTime(1);
          expect(raised[0].hides).toBe(1);
        })
      );
    });

    it('still hides at the cap, which a resting pointer cannot defeat', () => {
      fc.assert(
        fc.property(timingArb, ({ windowMs, maxLifetimeMs }) => {
          const { warning, raised } = makeWarning({ windowMs, maxLifetimeMs });

          warning.warn();
          pointerOnto(raised[0]);

          vi.advanceTimersByTime(maxLifetimeMs - 1);
          expect(raised[0].hides).toBe(0);
          vi.advanceTimersByTime(1);
          expect(raised[0].hides).toBe(1);
        })
      );
    });

    it('counts events as they arrive and banks a window for the pointer to leave with', () => {
      fc.assert(
        fc.property(
          hoverArb.chain((hover) =>
            fc.record({
              hover: fc.constant(hover),
              // Gaps of any size: the window is held, so none of them can close it
              gaps: fc.array(fc.integer({ min: 0, max: 120_000 }), {
                minLength: 1,
                maxLength: 12,
              }),
            })
          ),
          ({ hover: { windowMs, used }, gaps }) => {
            const held = gaps.reduce((sum, gap) => sum + gap, 0);
            const { warning, raised, createNotice } = makeWarning({
              windowMs,
              maxLifetimeMs: used + held + windowMs + 1,
            });

            warning.warn();
            vi.advanceTimersByTime(used);
            pointerOnto(raised[0]);
            for (const gap of gaps) {
              vi.advanceTimersByTime(gap);
              warning.warn();
            }

            expect(createNotice).toHaveBeenCalledTimes(1);
            expect(raised[0].messages).toEqual([
              IR_ID_WARNING_MESSAGE,
              ...gaps.map((_, n) =>
                irIdWarningMessage(IR_ID_WARNING_MESSAGE, n + 2)
              ),
            ]);
            // Counted on screen, and no timer armed under the pointer
            expect(raised[0].hides).toBe(0);

            pointerOff(raised[0]);
            vi.advanceTimersByTime(windowMs - 1);
            expect(raised[0].hides).toBe(0);
            vi.advanceTimersByTime(1);
            expect(raised[0].hides).toBe(1);
          }
        )
      );
    });

    it('raises a fresh notice when the user clicks the held notice away', () => {
      fc.assert(
        fc.property(hoverArb, ({ windowMs, used, hoverMs }) => {
          const { warning, raised, createNotice } = makeWarning({
            windowMs,
            maxLifetimeMs: used + hoverMs + windowMs + 1,
          });

          warning.warn();
          vi.advanceTimersByTime(used);
          pointerOnto(raised[0]);
          vi.advanceTimersByTime(hoverMs);
          clickAway(raised[0]);
          warning.warn();

          expect(createNotice).toHaveBeenCalledTimes(2);
          expect(raised[0].messages).toEqual([IR_ID_WARNING_MESSAGE]);
          expect(raised[0].hides).toBe(1);
          expect(raised[1].messages).toEqual([IR_ID_WARNING_MESSAGE]);
        })
      );
    });

    it('hides the held notice and stops its cap when disposed', () => {
      fc.assert(
        fc.property(hoverArb, ({ windowMs, used, hoverMs }) => {
          const maxLifetimeMs = used + hoverMs + windowMs + 1;
          const { warning, raised } = makeWarning({ windowMs, maxLifetimeMs });

          warning.warn();
          vi.advanceTimersByTime(used);
          pointerOnto(raised[0]);
          vi.advanceTimersByTime(hoverMs);
          warning.dispose();

          expect(raised[0].hides).toBe(1);
          vi.advanceTimersByTime(maxLifetimeMs + windowMs);
          expect(raised[0].hides).toBe(1);
        })
      );
    });

    it('picks the window up where the pointer left it, across pauses and events', () => {
      fc.assert(
        fc.property(
          fc.record({
            windowMs: fc.integer({ min: 16, max: 60_000 }),
            held: fc.integer({ min: 0, max: 600_000 }),
            heldAgain: fc.integer({ min: 0, max: 600_000 }),
          }),
          ({ windowMs, held, heldAgain }) => {
            // Four runs of the window, none of them all of it, so a step that
            // lost or doubled what was left of it shows up in the total
            const step = Math.floor(windowMs / 8);
            const { warning, raised, createNotice } = makeWarning({
              windowMs,
              maxLifetimeMs: 4 * step + held + heldAgain + 2 * windowMs + 1,
            });

            warning.warn();
            vi.advanceTimersByTime(step);
            warning.warn();
            vi.advanceTimersByTime(step);
            pointerOnto(raised[0]);
            vi.advanceTimersByTime(held);
            pointerOff(raised[0]);
            vi.advanceTimersByTime(step);
            pointerOnto(raised[0]);
            vi.advanceTimersByTime(heldAgain);

            // Two steps of the window have run, and neither pause spent any
            expect(raised[0].hides).toBe(0);

            pointerOff(raised[0]);
            vi.advanceTimersByTime(step);
            // An event once the pointer is gone slides the window as ever
            warning.warn();
            vi.advanceTimersByTime(windowMs - 1);
            expect(raised[0].hides).toBe(0);
            vi.advanceTimersByTime(1);
            expect(raised[0].hides).toBe(1);

            expect(createNotice).toHaveBeenCalledTimes(1);
            expect(raised[0].messages).toEqual([
              IR_ID_WARNING_MESSAGE,
              irIdWarningMessage(IR_ID_WARNING_MESSAGE, 2),
              irIdWarningMessage(IR_ID_WARNING_MESSAGE, 3),
            ]);
          }
        )
      );
    });

    it('holds the window from where the pointer first arrived, however often it is announced', () => {
      const { warning, raised } = makeWarning({
        windowMs: 1000,
        maxLifetimeMs: 100_000,
      });

      warning.warn();
      vi.advanceTimersByTime(400);
      pointerOnto(raised[0]);
      vi.advanceTimersByTime(5000);
      // A second mouseenter, as moving between the notice's own children raises
      pointerOnto(raised[0]);
      vi.advanceTimersByTime(5000);
      pointerOff(raised[0]);

      vi.advanceTimersByTime(599);
      expect(raised[0].hides).toBe(0);
      vi.advanceTimersByTime(1);
      expect(raised[0].hides).toBe(1);
    });

    it('leaves the window alone when the pointer leaves without having arrived', () => {
      const { warning, raised } = makeWarning({
        windowMs: 1000,
        maxLifetimeMs: 100_000,
      });

      warning.warn();
      vi.advanceTimersByTime(400);
      pointerOff(raised[0]);

      vi.advanceTimersByTime(599);
      expect(raised[0].hides).toBe(0);
      vi.advanceTimersByTime(1);
      expect(raised[0].hides).toBe(1);
    });
  });

  it('caps a burst on the host clock and timer at its own lifetime', () => {
    const gap = IR_ID_WARNING_WINDOW_MS - 1;
    const { warning, raised, createNotice } = makeWarning();

    warning.warn();
    let elapsed = 0;
    while (elapsed + gap < IR_ID_WARNING_MAX_LIFETIME_MS) {
      vi.advanceTimersByTime(gap);
      elapsed += gap;
      warning.warn();
    }

    expect(createNotice).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(IR_ID_WARNING_MAX_LIFETIME_MS - elapsed - 1);
    expect(raised[0].hides).toBe(0);
    vi.advanceTimersByTime(1);
    expect(raised[0].hides).toBe(1);
  });
});
