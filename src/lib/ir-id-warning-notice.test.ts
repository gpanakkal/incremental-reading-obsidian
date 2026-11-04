// @vitest-environment jsdom
import { Notice } from '#/test/__mocks__/obsidian';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DamagedNote } from './damaged-note-actions';
import {
  createDamagedNotesNotice,
  createIrIdWarning,
  DAMAGED_NOTES_LISTED,
  damagedNotesHeading,
  IR_ID_WARNING_MAX_LIFETIME_MS,
  IR_ID_WARNING_WINDOW_MS,
  irIdWarningMessage,
  persistentNotice,
  type IrIdWarningDeps,
  type NoticeFactory,
  type NoticeTarget,
} from './ir-id-warning-notice';
import { ITEM_TABLES, type ItemTable } from './moved-note-scan';

// #region HELPERS

/** What the warnings under test say, unless a case names its own. */
const IR_ID_WARNING_MESSAGE = "Don't edit the ir-id property.";

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
 * A warning over fake notices, showing {@link IR_ID_WARNING_MESSAGE} unless the
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

/** What a {@link createDamagedNotesNotice} is told about each note, by path. */
function makeFakeActions(known: readonly DamagedNote[] = []) {
  const byPath = new Map(known.map((note) => [note.path, note]));
  return {
    byPath,
    describe: vi.fn(async (paths: readonly string[]) =>
      paths.flatMap((path) => {
        const note = byPath.get(path);
        return note ? [note] : [];
      })
    ),
    restore: vi.fn(async (_path: string) => true),
    open: vi.fn(async (_path: string) => true),
  };
}

/** A damaged-notes notice over fake notices and {@link makeFakeActions}. */
function makeDamagedNotice(known: readonly DamagedNote[] = []) {
  const { raised, createNotice } = makeNotices();
  const actions = makeFakeActions(known);
  const notice = createDamagedNotesNotice(createNotice, actions);
  return { raised, createNotice, actions, notice };
}

/** The rows a notice lists, in order. */
const rowsOf = (notice: NoticeTarget) => [
  ...notice.containerEl.querySelectorAll<HTMLElement>('.ir-damaged-note'),
];

/** The row a notice lists for the note at `path`, if any. */
const rowOf = (notice: NoticeTarget, path: string) =>
  rowsOf(notice).find((row) => row.dataset.path === path) ?? null;

/** The Open button of the row for `path`. */
const openOf = (notice: NoticeTarget, path: string) =>
  rowOf(notice, path)?.querySelector<HTMLButtonElement>(
    'button.ir-damaged-note-open'
  ) ?? null;

/** The Restore button of the row for `path`. */
const restoreOf = (notice: NoticeTarget, path: string) =>
  rowOf(notice, path)?.querySelector<HTMLButtonElement>(
    'button.ir-damaged-note-restore'
  ) ?? null;

const restoreAllOf = (notice: NoticeTarget) =>
  notice.containerEl.querySelector<HTMLButtonElement>(
    'button.ir-damaged-notes-restore-all'
  );

const KIND_WORD: Record<ItemTable, string> = {
  article: 'article',
  snippet: 'snippet',
  srs_card: 'card',
};

/** A damaged note at a vault path ending in a name of its own. */
const damagedNoteArb: fc.Arbitrary<DamagedNote & { name: string }> = fc
  .record({
    folders: fc.array(fc.stringMatching(/^[a-z]{1,6}$/), { maxLength: 2 }),
    name: fc.stringMatching(/^[A-Za-z0-9 ]{1,10}$/),
    ext: fc.constantFrom('.md', ''),
    table: fc.constantFrom(...ITEM_TABLES),
    change: fc.constantFrom('removed' as const, 'changed' as const),
    restorable: fc.boolean(),
  })
  .map(({ folders, name, ext, table, change, restorable }) => ({
    path: [...folders, `${name}${ext}`].join('/'),
    name,
    table,
    change,
    restorable,
  }));

const damagedNotesArb = (maxLength: number) =>
  fc.uniqueArray(damagedNoteArb, {
    minLength: 1,
    maxLength,
    selector: ({ path }) => path,
  });

/**
 * Many fake-notice notes, `notes/n<i>.md`, each with its id taken off,
 * restorable unless `restorable` says otherwise.
 */
const numberedNotes = (
  count: number,
  restorable: (i: number) => boolean = () => true
): DamagedNote[] =>
  Array.from({ length: count }, (_, i) => ({
    path: `notes/n${i}.md`,
    table: 'article',
    change: 'removed',
    restorable: restorable(i),
  }));

/** A promise a test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
// #endregion

describe('irIdWarningMessage', () => {
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
          const counted = irIdWarningMessage(message, count);
          expect(counted.startsWith(message)).toBe(true);
          expect(counted.slice(message.length)).toMatch(
            new RegExp(`(^|\\D)${count}(\\D|$)`)
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
  it('raises a notice that later notices leave up', () => {
    fc.assert(
      fc.property(fc.string(), (message) => {
        Notice.reset();

        persistentNotice(message);
        persistentNotice('later');

        expect(Notice.instances.map((notice) => notice.duration)).toEqual([
          0, 0,
        ]);
        expect(Notice.instances[0].hides).toBe(0);
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

describe('damagedNotesHeading', () => {
  it('counts the notes once there are two or more', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 10_000 }), (count) => {
        expect(damagedNotesHeading(count)).toContain(` ${count} `);
        expect(damagedNotesHeading(count)).toMatch(/\bnotes\b/);
      })
    );
    expect(damagedNotesHeading(1)).not.toMatch(/\d/);
    expect(damagedNotesHeading(1)).toMatch(/\bnote\b/);
  });
});

describe('createDamagedNotesNotice', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('lists each note by name, with its kind, what became of its id, an Open button, and a Restore button where it can be restored', async () => {
    await fc.assert(
      fc.asyncProperty(damagedNotesArb(DAMAGED_NOTES_LISTED), async (notes) => {
        document.body.replaceChildren();
        const { raised, notice } = makeDamagedNotice(notes);

        await notice.report(notes.map(({ path }) => path));

        expect(raised).toHaveLength(1);
        expect(rowsOf(raised[0]).map((row) => row.dataset.path)).toStrictEqual(
          notes.map(({ path }) => path)
        );
        for (const { path, name, table, change, restorable } of notes) {
          const row = rowOf(raised[0], path)!;
          const nameEl = row.querySelector('.ir-damaged-note-name');
          expect(nameEl?.textContent).toBe(name);
          // The full path on hover, for two notes of the same name
          expect(nameEl?.getAttribute('aria-label')).toBe(path);
          const kind = row.querySelector('.ir-damaged-note-kind')?.textContent;
          expect(kind).toContain(KIND_WORD[table]);
          expect(kind).toMatch(
            change === 'removed' ? /\bremoved\b/ : /\bchanged\b/
          );
          expect(openOf(raised[0], path)).not.toBeNull();
          expect(restoreOf(raised[0], path) !== null).toBe(restorable);
        }
      })
    );
  });

  it(`lists at most ${DAMAGED_NOTES_LISTED} notes and counts the rest`, async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: DAMAGED_NOTES_LISTED * 3 }),
        async (count) => {
          document.body.replaceChildren();
          const notes = numberedNotes(count);
          const { raised, notice } = makeDamagedNotice(notes);

          await notice.report(notes.map(({ path }) => path));

          const listed = Math.min(count, DAMAGED_NOTES_LISTED);
          expect(
            rowsOf(raised[0]).map((row) => row.dataset.path)
          ).toStrictEqual(notes.slice(0, listed).map(({ path }) => path));
          const more = raised[0].containerEl.querySelector(
            '.ir-damaged-notes-more'
          );
          if (count > listed) {
            expect(more?.textContent).toMatch(
              new RegExp(`\\b${count - listed}\\b`)
            );
          } else {
            expect(more).toBeNull();
          }
          expect(raised[0].messages.at(-1)).toBe(damagedNotesHeading(count));
        }
      )
    );
  });

  it('opens the note from its Open button and leaves the notice up', async () => {
    const notes = numberedNotes(2);
    const { raised, actions, notice } = makeDamagedNotice(notes);
    await notice.report(notes.map(({ path }) => path));

    openOf(raised[0], 'notes/n1.md')!.click();

    await vi.waitFor(() =>
      expect(actions.describe).toHaveBeenLastCalledWith(['notes/n1.md'])
    );
    expect(actions.open).toHaveBeenCalledExactlyOnceWith('notes/n1.md');
    expect(raised[0].hides).toBe(0);
    expect(rowsOf(raised[0])).toHaveLength(2);
  });

  it('asks again about a note Open finds gone, and shows what it is now', async () => {
    const notes = numberedNotes(3);
    const { raised, actions, notice } = makeDamagedNotice(notes);
    await notice.report(notes.map(({ path }) => path));
    actions.open.mockResolvedValue(false);
    // One moved and its old path now holds a note with another id; the
    // other's whole again
    actions.byPath.set('notes/n0.md', { ...notes[0], change: 'changed' });
    actions.byPath.delete('notes/n1.md');
    actions.describe.mockClear();

    openOf(raised[0], 'notes/n0.md')!.click();
    openOf(raised[0], 'notes/n1.md')!.click();

    await vi.waitFor(() => expect(rowOf(raised[0], 'notes/n1.md')).toBeNull());
    await vi.waitFor(() =>
      expect(
        rowOf(raised[0], 'notes/n0.md')?.querySelector('.ir-damaged-note-kind')
          ?.textContent
      ).toMatch(/\bchanged\b/)
    );
    expect(actions.describe.mock.calls).toStrictEqual([
      [['notes/n0.md']],
      [['notes/n1.md']],
    ]);
    expect(raised[0].messages.at(-1)).toBe(damagedNotesHeading(2));
    expect(raised[0].hides).toBe(0);
  });

  it('hides the notice once Open has found its last note gone', async () => {
    const notes = numberedNotes(1);
    const { raised, actions, notice } = makeDamagedNotice(notes);
    await notice.report(['notes/n0.md']);
    actions.open.mockResolvedValueOnce(false);
    actions.byPath.delete('notes/n0.md');

    openOf(raised[0], 'notes/n0.md')!.click();

    await vi.waitFor(() => expect(raised[0].hides).toBe(1));
    // A note damaged after that has a notice of its own
    actions.byPath.set('notes/n0.md', notes[0]);
    await notice.report(['notes/n0.md']);
    expect(raised).toHaveLength(2);
  });

  it('says why in the console when Open fails, and keeps the row', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const notes = numberedNotes(1);
    const { raised, actions, notice } = makeDamagedNotice(notes);
    const failure = new Error('no leaf');
    actions.open.mockRejectedValueOnce(failure);
    await notice.report(['notes/n0.md']);

    openOf(raised[0], 'notes/n0.md')!.click();

    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(error.mock.calls[0]).toContain(failure);
    expect(String(error.mock.calls[0][0])).toContain('notes/n0.md');
    expect(rowOf(raised[0], 'notes/n0.md')).not.toBeNull();
  });

  it('drops the row of a note found mended once opened, and keeps one still damaged', async () => {
    const notes = numberedNotes(2);
    const { raised, actions, notice } = makeDamagedNotice(notes);
    await notice.report(notes.map(({ path }) => path));
    // Undone by hand before Open was clicked
    actions.byPath.delete('notes/n0.md');

    openOf(raised[0], 'notes/n0.md')!.click();
    openOf(raised[0], 'notes/n1.md')!.click();

    await vi.waitFor(() => expect(rowOf(raised[0], 'notes/n0.md')).toBeNull());
    await vi.waitFor(() =>
      expect(actions.describe).toHaveBeenLastCalledWith(['notes/n1.md'])
    );
    expect(rowsOf(raised[0]).map((row) => row.dataset.path)).toStrictEqual([
      'notes/n1.md',
    ]);
    expect(raised[0].hides).toBe(0);
  });

  it('restores only the note whose Restore was clicked, dropping its row and keeping the notice up', async () => {
    const notes = numberedNotes(3);
    const { raised, actions, notice } = makeDamagedNotice(notes);
    await notice.report(notes.map(({ path }) => path));

    restoreOf(raised[0], 'notes/n1.md')!.click();

    await vi.waitFor(() => expect(rowOf(raised[0], 'notes/n1.md')).toBeNull());
    expect(actions.restore).toHaveBeenCalledExactlyOnceWith('notes/n1.md');
    expect(rowsOf(raised[0]).map((row) => row.dataset.path)).toStrictEqual([
      'notes/n0.md',
      'notes/n2.md',
    ]);
    expect(raised[0].hides).toBe(0);
    expect(raised[0].messages.at(-1)).toBe(damagedNotesHeading(2));
  });

  it('hides the notice once its last note is restored', async () => {
    const notes = numberedNotes(1);
    const { raised, notice } = makeDamagedNotice(notes);
    await notice.report(['notes/n0.md']);

    restoreOf(raised[0], 'notes/n0.md')!.click();

    await vi.waitFor(() => expect(raised[0].hides).toBe(1));
    // A note damaged after that has a notice of its own
    await notice.report(['notes/n0.md']);
    expect(raised).toHaveLength(2);
  });

  it('runs one restore at a time for a note, however often its button is clicked', async () => {
    const notes = numberedNotes(2);
    const { raised, actions, notice } = makeDamagedNotice(notes);
    const pending = deferred<boolean>();
    actions.restore.mockReturnValueOnce(pending.promise);
    await notice.report(notes.map(({ path }) => path));

    const button = restoreOf(raised[0], 'notes/n0.md')!;
    button.click();
    button.click();
    // A report arriving meanwhile redraws the rows, and keeps it running
    await notice.report(['notes/n1.md']);
    restoreOf(raised[0], 'notes/n0.md')!.click();

    expect(actions.restore).toHaveBeenCalledOnce();
    expect(restoreOf(raised[0], 'notes/n0.md')!.disabled).toBe(true);
    expect(restoreAllOf(raised[0])!.disabled).toBe(true);
    pending.resolve(true);
    await vi.waitFor(() => expect(rowOf(raised[0], 'notes/n0.md')).toBeNull());
    expect(restoreAllOf(raised[0])).toBeNull();
    expect(restoreOf(raised[0], 'notes/n1.md')!.disabled).toBe(false);
  });

  it('asks again about a note Restore could not mend, and shows what it is now', async () => {
    const notes = numberedNotes(3);
    const { raised, actions, notice } = makeDamagedNotice(notes);
    await notice.report(notes.map(({ path }) => path));
    actions.restore.mockResolvedValue(false);
    // A second row came to share its path; the other's whole again
    actions.byPath.set('notes/n0.md', { ...notes[0], restorable: false });
    actions.byPath.delete('notes/n1.md');
    actions.describe.mockClear();

    restoreOf(raised[0], 'notes/n0.md')!.click();
    restoreOf(raised[0], 'notes/n1.md')!.click();

    await vi.waitFor(() => expect(rowOf(raised[0], 'notes/n1.md')).toBeNull());
    await vi.waitFor(() =>
      expect(restoreOf(raised[0], 'notes/n0.md')).toBeNull()
    );
    expect(actions.describe.mock.calls).toStrictEqual([
      [['notes/n0.md']],
      [['notes/n1.md']],
    ]);
    expect(rowOf(raised[0], 'notes/n0.md')).not.toBeNull();
    expect(raised[0].hides).toBe(0);
  });

  it('keeps the row of a note whose restore failed, its button usable again, and says why in the console', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const notes = numberedNotes(1);
    const { raised, actions, notice } = makeDamagedNotice(notes);
    const failure = new Error('disk full');
    actions.restore.mockRejectedValueOnce(failure);
    await notice.report(['notes/n0.md']);

    restoreOf(raised[0], 'notes/n0.md')!.click();

    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(error.mock.calls[0]).toContain(failure);
    expect(String(error.mock.calls[0][0])).toContain('notes/n0.md');
    await vi.waitFor(() =>
      expect(restoreOf(raised[0], 'notes/n0.md')!.disabled).toBe(false)
    );
    expect(raised[0].hides).toBe(0);
  });

  it('offers Restore all exactly when two or more notes can be restored, outside the scrolled rows', async () => {
    await fc.assert(
      fc.asyncProperty(
        damagedNotesArb(DAMAGED_NOTES_LISTED * 2),
        async (notes) => {
          document.body.replaceChildren();
          const { raised, notice } = makeDamagedNotice(notes);

          await notice.report(notes.map(({ path }) => path));

          const restorable = notes.filter((note) => note.restorable).length;
          const all = restoreAllOf(raised[0]);
          expect(all !== null).toBe(restorable >= 2);
          const list = rowsOf(raised[0])[0].parentElement!;
          expect(list.contains(all)).toBe(false);
        }
      )
    );
  });

  it('restores every note it can from Restore all, listed or counted, one at a time, and none of the rest', async () => {
    const count = DAMAGED_NOTES_LISTED + 4;
    const notes = numberedNotes(count, (i) => i % 3 !== 0);
    const { raised, actions, notice } = makeDamagedNotice(notes);
    let running = 0;
    let overlapped = false;
    actions.restore.mockImplementation(async () => {
      running += 1;
      overlapped ||= running > 1;
      await Promise.resolve();
      running -= 1;
      return true;
    });
    await notice.report(notes.map(({ path }) => path));

    restoreAllOf(raised[0])!.click();

    const fixed = notes
      .filter((note) => note.restorable)
      .map(({ path }) => path);
    const kept = notes
      .filter((note) => !note.restorable)
      .map(({ path }) => path);
    await vi.waitFor(() =>
      expect(actions.restore.mock.calls).toStrictEqual(
        fixed.map((path) => [path])
      )
    );
    await vi.waitFor(() =>
      expect(rowsOf(raised[0]).map((row) => row.dataset.path)).toStrictEqual(
        kept
      )
    );
    expect(overlapped).toBe(false);
    expect(
      raised[0].containerEl.querySelector('.ir-damaged-notes-more')
    ).toBeNull();
    expect(restoreAllOf(raised[0])).toBeNull();
    expect(raised[0].hides).toBe(0);
  });

  it('runs Restore all once at a time, however often it is clicked, holding every Restore meanwhile', async () => {
    const notes = numberedNotes(3);
    const { raised, actions, notice } = makeDamagedNotice(notes);
    const pending = deferred<boolean>();
    let running = 0;
    let overlapped = false;
    actions.restore.mockImplementation(async (path: string) => {
      running += 1;
      overlapped ||= running > 1;
      if (path === 'notes/n0.md') await pending.promise;
      running -= 1;
      return true;
    });
    await notice.report(notes.map(({ path }) => path));

    const button = restoreAllOf(raised[0])!;
    button.click();
    // The one it was drawn as, before the first click redrew the rows
    button.click();
    expect(restoreOf(raised[0], 'notes/n2.md')!.disabled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    pending.resolve(true);

    // Every note restored, so the notice goes
    await vi.waitFor(() => expect(raised[0].hides).toBe(1));
    expect(actions.restore.mock.calls).toStrictEqual(
      notes.map(({ path }) => [path])
    );
    expect(overlapped).toBe(false);
  });

  it('gives back the Restore of a note Restore all could not mend, once it is done', async () => {
    const notes = numberedNotes(2);
    const { raised, actions, notice } = makeDamagedNotice(notes);
    // Its note changed meanwhile, and Restore can still mend it
    actions.restore.mockImplementation(async (path) => path !== 'notes/n0.md');
    await notice.report(notes.map(({ path }) => path));

    restoreAllOf(raised[0])!.click();

    await vi.waitFor(() => expect(rowOf(raised[0], 'notes/n1.md')).toBeNull());
    await vi.waitFor(() =>
      expect(restoreOf(raised[0], 'notes/n0.md')!.disabled).toBe(false)
    );
  });

  it('leaves alone a notice since dismissed, or the one that replaced it, when a restore ends', async () => {
    for (const after of ['dismissed', 'replaced', 'disposed'] as const) {
      document.body.replaceChildren();
      const notes = numberedNotes(3);
      const { raised, actions, notice } = makeDamagedNotice(notes);
      const pending = deferred<boolean>();
      actions.restore.mockReturnValueOnce(pending.promise);
      await notice.report(['notes/n0.md']);

      restoreOf(raised[0], 'notes/n0.md')!.click();
      if (after === 'disposed') notice.dispose();
      else clickAway(raised[0]);
      if (after === 'replaced') await notice.report(['notes/n1.md']);
      pending.resolve(true);
      await vi.waitFor(() => expect(actions.restore).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Hidden once, by whatever took it down, and never again
      expect(raised[0].hides).toBe(1);
      if (after === 'replaced') {
        // Still the notice the next report adds to
        await notice.report(['notes/n2.md']);
        expect(raised).toHaveLength(2);
        expect(rowsOf(raised[1]).map((row) => row.dataset.path)).toStrictEqual([
          'notes/n1.md',
          'notes/n2.md',
        ]);
      }
    }
  });

  it('looks the notes it lists up again with each report, in the same lookup, dropping those mended since', async () => {
    const notes = numberedNotes(4);
    const { raised, actions, notice } = makeDamagedNotice(notes);
    await notice.report(['notes/n0.md', 'notes/n1.md', 'notes/n2.md']);
    // One undone by hand, one whose id changed again
    actions.byPath.delete('notes/n1.md');
    actions.byPath.set('notes/n2.md', { ...notes[2], change: 'changed' });
    actions.describe.mockClear();

    await notice.report(['notes/n3.md']);

    expect(actions.describe.mock.calls).toStrictEqual([
      [['notes/n0.md', 'notes/n1.md', 'notes/n2.md', 'notes/n3.md']],
    ]);
    expect(rowsOf(raised[0]).map((row) => row.dataset.path)).toStrictEqual([
      'notes/n0.md',
      'notes/n2.md',
      'notes/n3.md',
    ]);
    expect(
      rowOf(raised[0], 'notes/n2.md')?.querySelector('.ir-damaged-note-kind')
        ?.textContent
    ).toMatch(/\bchanged\b/);
  });

  it('takes the notice down when a report finds every note it lists mended, and the new ones whole', async () => {
    const notes = numberedNotes(2);
    const { raised, createNotice, actions, notice } = makeDamagedNotice(notes);
    await notice.report(['notes/n0.md']);
    actions.byPath.clear();

    await notice.report(['notes/n1.md']);

    expect(raised[0].hides).toBe(1);
    expect(createNotice).toHaveBeenCalledOnce();
  });

  it('looks up only the new notes for a report once the notice was dismissed', async () => {
    const notes = numberedNotes(2);
    const { raised, actions, notice } = makeDamagedNotice(notes);
    await notice.report(['notes/n0.md']);
    clickAway(raised[0]);
    actions.describe.mockClear();

    await notice.report(['notes/n1.md']);

    expect(actions.describe.mock.calls).toStrictEqual([[['notes/n1.md']]]);
  });

  it('raises a fresh notice with only the new notes when the one it looked up its rows for is dismissed meanwhile', async () => {
    const notes = numberedNotes(2);
    const { raised, actions, notice } = makeDamagedNotice(notes);
    await notice.report(['notes/n0.md']);
    const lookup = deferred<DamagedNote[]>();
    actions.describe.mockReturnValueOnce(lookup.promise);

    const reported = notice.report(['notes/n1.md']);
    clickAway(raised[0]);
    lookup.resolve(notes);
    await reported;

    expect(raised).toHaveLength(2);
    expect(rowsOf(raised[1]).map((row) => row.dataset.path)).toStrictEqual([
      'notes/n1.md',
    ]);
  });

  it('keeps a row added while a report was being looked up', async () => {
    const notes = numberedNotes(3);
    const { raised, actions, notice } = makeDamagedNotice(notes);
    await notice.report(['notes/n0.md']);
    const lookup = deferred<DamagedNote[]>();
    actions.describe.mockReturnValueOnce(lookup.promise);

    const slow = notice.report(['notes/n1.md']);
    await notice.report(['notes/n2.md']);
    // Answered as it was before n2 was listed
    lookup.resolve([notes[0], notes[1]]);
    await slow;

    expect(rowsOf(raised[0]).map((row) => row.dataset.path)).toStrictEqual([
      'notes/n0.md',
      'notes/n2.md',
      'notes/n1.md',
    ]);
  });

  it('keeps a row restored while a report was being looked up off the list', async () => {
    const notes = numberedNotes(3);
    const { raised, actions, notice } = makeDamagedNotice(notes);
    await notice.report(['notes/n0.md', 'notes/n2.md']);
    const lookup = deferred<DamagedNote[]>();
    actions.describe.mockReturnValueOnce(lookup.promise);

    const slow = notice.report(['notes/n1.md']);
    restoreOf(raised[0], 'notes/n0.md')!.click();
    await vi.waitFor(() => expect(rowOf(raised[0], 'notes/n0.md')).toBeNull());
    // Answered from a read made before the restore's write
    lookup.resolve(notes);
    await slow;

    expect(rowsOf(raised[0]).map((row) => row.dataset.path)).toStrictEqual([
      'notes/n2.md',
      'notes/n1.md',
    ]);
  });

  it('lists a note it held again in the fresh notice when the report names it and the old notice is dismissed meanwhile', async () => {
    const notes = numberedNotes(2);
    const { raised, actions, notice } = makeDamagedNotice(notes);
    await notice.report(['notes/n0.md']);
    const lookup = deferred<DamagedNote[]>();
    actions.describe.mockReturnValueOnce(lookup.promise);

    const reported = notice.report(['notes/n0.md', 'notes/n1.md']);
    clickAway(raised[0]);
    lookup.resolve(notes);
    await reported;

    expect(raised).toHaveLength(2);
    expect(rowsOf(raised[1]).map((row) => row.dataset.path)).toStrictEqual([
      'notes/n0.md',
      'notes/n1.md',
    ]);
  });

  it('adds a note it held to the notice that replaced its own meanwhile, when the report names it', async () => {
    const notes = numberedNotes(3);
    const { raised, actions, notice } = makeDamagedNotice(notes);
    await notice.report(['notes/n0.md']);
    const lookup = deferred<DamagedNote[]>();
    actions.describe.mockReturnValueOnce(lookup.promise);

    const slow = notice.report(['notes/n0.md']);
    clickAway(raised[0]);
    await notice.report(['notes/n2.md']);
    lookup.resolve([notes[0]]);
    await slow;

    expect(raised).toHaveLength(2);
    expect(rowsOf(raised[1]).map((row) => row.dataset.path)).toStrictEqual([
      'notes/n2.md',
      'notes/n0.md',
    ]);
  });

  it('raises nothing when the notice is dismissed during a report whose new notes turn out whole', async () => {
    const notes = numberedNotes(1);
    const { raised, createNotice, actions, notice } = makeDamagedNotice(notes);
    await notice.report(['notes/n0.md']);
    const lookup = deferred<DamagedNote[]>();
    actions.describe.mockReturnValueOnce(lookup.promise);

    const reported = notice.report(['notes/n9.md']);
    clickAway(raised[0]);
    // The note it listed still damaged, the new one whole
    lookup.resolve([notes[0]]);
    await reported;

    expect(createNotice).toHaveBeenCalledOnce();
  });

  it('lists its rows in one element of their own that phone swipes leave to scroll', async () => {
    const notes = numberedNotes(DAMAGED_NOTES_LISTED + 2);
    const { raised, notice } = makeDamagedNotice(notes);

    await notice.report(notes.map(({ path }) => path));

    const rows = rowsOf(raised[0]);
    const list = rows[0].parentElement!;
    expect(rows.every((row) => row.parentElement === list)).toBe(true);
    expect(list.dataset.ignoreSwipe).toBeDefined();
    expect(
      list.contains(
        raised[0].containerEl.querySelector('.ir-damaged-notes-more')
      )
    ).toBe(true);
    // Not the notice itself, whose own swipe still dismisses it
    expect(list).not.toBe(raised[0].containerEl);
  });

  it('leaves alone a notice since dismissed, or the one that replaced it, when an Open ends', async () => {
    for (const after of ['dismissed', 'replaced', 'disposed'] as const) {
      document.body.replaceChildren();
      const notes = numberedNotes(3);
      const { raised, actions, notice } = makeDamagedNotice(notes);
      const pending = deferred<boolean>();
      actions.open.mockReturnValueOnce(pending.promise);
      await notice.report(['notes/n0.md']);

      openOf(raised[0], 'notes/n0.md')!.click();
      if (after === 'disposed') notice.dispose();
      else clickAway(raised[0]);
      if (after === 'replaced') await notice.report(['notes/n1.md']);
      // Gone by the time the tab opens, so the notice would drop it
      actions.byPath.delete('notes/n0.md');
      pending.resolve(false);
      await vi.waitFor(() =>
        expect(actions.describe).toHaveBeenLastCalledWith(['notes/n0.md'])
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Hidden once, by whatever took it down, and never again
      expect(raised[0].hides).toBe(1);
      if (after === 'replaced') {
        // Still the notice the next report adds to
        await notice.report(['notes/n2.md']);
        expect(raised).toHaveLength(2);
        expect(rowsOf(raised[1]).map((row) => row.dataset.path)).toStrictEqual([
          'notes/n1.md',
          'notes/n2.md',
        ]);
      }
    }
  });

  it('adds notes reported while it is up to the same notice, once each', async () => {
    const notes = numberedNotes(3);
    const { raised, createNotice, actions, notice } = makeDamagedNotice(notes);

    await notice.report(['notes/n0.md']);
    actions.byPath.set('notes/n0.md', { ...notes[0], change: 'changed' });
    await notice.report(['notes/n1.md', 'notes/n0.md', 'notes/n2.md']);

    expect(createNotice).toHaveBeenCalledOnce();
    expect(rowsOf(raised[0]).map((row) => row.dataset.path)).toStrictEqual([
      'notes/n0.md',
      'notes/n1.md',
      'notes/n2.md',
    ]);
    // Told afresh what became of its id
    expect(
      rowOf(raised[0], 'notes/n0.md')?.querySelector('.ir-damaged-note-kind')
        ?.textContent
    ).toMatch(/\bchanged\b/);
    expect(raised[0].messages.at(-1)).toBe(damagedNotesHeading(3));
  });

  it('raises a fresh notice, listing only the new notes, once the last was dismissed', async () => {
    for (const dismiss of ['click', 'detach'] as const) {
      document.body.replaceChildren();
      const notes = numberedNotes(2);
      const { raised, notice } = makeDamagedNotice(notes);
      await notice.report(['notes/n0.md']);

      // A click leaves the element in the document while the hide animates
      if (dismiss === 'click') clickAway(raised[0]);
      else swipeAway(raised[0]);
      await notice.report(['notes/n1.md']);

      expect(raised).toHaveLength(2);
      expect(rowsOf(raised[1]).map((row) => row.dataset.path)).toStrictEqual([
        'notes/n1.md',
      ]);
    }
  });

  it('says nothing for a report naming no notes, or none damaged by now', async () => {
    const { createNotice, actions, notice } = makeDamagedNotice();

    await notice.report([]);
    await notice.report(['notes/whole.md']);

    expect(createNotice).not.toHaveBeenCalled();
    expect(actions.describe).toHaveBeenCalledOnce();
  });

  it('hides the notice it has up when disposed, and raises a fresh one after', async () => {
    const notes = numberedNotes(2);
    const { raised, notice } = makeDamagedNotice(notes);
    notice.dispose();
    await notice.report(['notes/n0.md']);

    notice.dispose();
    await notice.report(['notes/n1.md']);

    expect(raised.map(({ hides }) => hides)).toStrictEqual([1, 0]);
    expect(rowsOf(raised[1]).map((row) => row.dataset.path)).toStrictEqual([
      'notes/n1.md',
    ]);
  });

  it('raises nothing for a report still being looked up when disposed', async () => {
    const { createNotice, actions, notice } = makeDamagedNotice(
      numberedNotes(1)
    );
    const lookup = deferred<DamagedNote[]>();
    actions.describe.mockReturnValueOnce(lookup.promise);

    const reported = notice.report(['notes/n0.md']);
    notice.dispose();
    lookup.resolve(numberedNotes(1));
    await reported;

    expect(createNotice).not.toHaveBeenCalled();
  });

  it('says why in the console, raising nothing, when the notes cannot be looked up', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createNotice, actions, notice } = makeDamagedNotice();
    const failure = new Error('database closed');
    actions.describe.mockRejectedValueOnce(failure);

    await notice.report(['notes/n0.md']);

    expect(createNotice).not.toHaveBeenCalled();
    expect(error.mock.calls[0]).toContain(failure);
  });
});
