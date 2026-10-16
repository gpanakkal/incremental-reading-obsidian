// @vitest-environment jsdom
import { Notice } from '#/test/__mocks__/obsidian';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IMPORT_NOTICE_EXTRA_MS,
  NOTICE_MIN_DURATION_MS,
  NOTICE_SCALED_DURATION_PER_WORD_MS,
} from './constants';
import {
  configureSuccessNotices,
  notify,
  type NoticeAction,
  type NoticeKind,
  type SuccessCategory,
  type SuccessNoticeSource,
} from './notices';
import type { SuccessNoticeLevel } from './settings';

// #region HELPERS

/** The notices raised since the last reset that nothing has hidden. */
function visible() {
  return Notice.instances.filter((notice) => notice.hides === 0);
}

const kinds: NoticeKind[] = ['info', 'success', 'error'];

/** Any text, with runs of many words as likely as short ones. */
const messageArb = fc.oneof(
  fc.string(),
  fc.array(fc.string(), { maxLength: 30 }).map((words) => words.join(' '))
);

/** Any kind, or none to take the default. */
const kindArb = fc.option(fc.constantFrom(...kinds), { nil: undefined });

/** What one call asks for: any options a caller could pass, or none. */
const optionsArb = fc.option(
  fc.record(
    { kind: kindArb, persist: fc.option(fc.boolean(), { nil: undefined }) },
    { requiredKeys: [] }
  ),
  { nil: undefined }
);

/** Whether the wrapper may hide a notice raised with `options` on its own. */
function isEvictable(options: { kind?: NoticeKind; persist?: boolean } = {}) {
  return options.kind !== 'error' && !options.persist;
}

const levels: SuccessNoticeLevel[] = ['all', 'minimal', 'none'];
const categories: SuccessCategory[] = ['undo', 'import'];

/** Any category, or none for an ordinary confirmation. */
const categoryArb = fc.option(fc.constantFrom(...categories), {
  nil: undefined,
});

/**
 * The plugin as the notices read it: its two levels, and whether the review
 * tab is the active view. `view` stands for whatever the review tab returns.
 */
function makeSource({
  inside = 'all' as SuccessNoticeLevel,
  outside = 'all' as SuccessNoticeLevel,
  inReview = false,
} = {}): SuccessNoticeSource {
  const view = {};
  return {
    settings: {
      successNoticesInReview: inside,
      successNoticesOutsideReview: outside,
    },
    getActiveReviewView: () => (inReview ? view : null),
  };
}

/** An action that records the clicks it is handed. */
function makeAction(label = 'Open') {
  const onClick = vi.fn<NoticeAction['onClick']>();
  return { label, onClick };
}

/** The buttons a notice shows, as Obsidian's own notice buttons are classed. */
function buttonsOf(notice: Notice): HTMLElement[] {
  return [...notice.containerEl.querySelectorAll<HTMLElement>('.notice-cta')];
}

/** Press mouse button `button` on `el`, as the browser reports each kind. */
function press(el: HTMLElement, button: number) {
  const evt = new MouseEvent(button === 0 ? 'click' : 'auxclick', {
    bubbles: true,
    button,
  });
  el.dispatchEvent(evt);
  return evt;
}

// #endregion

describe('notify', () => {
  beforeEach(() => {
    Notice.reset();
    configureSuccessNotices(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hides the previous info notice when another one appears', () => {
    notify('first');
    notify('second');

    expect(visible().map((notice) => notice.message)).toEqual(['second']);
  });

  it('leaves an error notice up when later notices appear', () => {
    notify('broke', { kind: 'error' });
    notify('later');

    expect(visible().map((notice) => notice.message)).toEqual([
      'broke',
      'later',
    ]);
  });

  it('keeps a persistent notice up until something hides it', () => {
    notify('stays', { persist: true });
    notify('later');

    expect(visible().map((notice) => notice.message)).toEqual([
      'stays',
      'later',
    ]);
    expect(Notice.instances[0].duration).toBe(0);
  });

  it('shows a notice that is not persistent for longer the more words it has', () => {
    fc.assert(
      fc.property(messageArb, kindArb, (message, kind) => {
        Notice.reset();

        notify(message, { kind });

        const words = message.split(' ').length;
        expect(Notice.instances[0].duration).toBe(
          Math.max(
            NOTICE_MIN_DURATION_MS,
            words * NOTICE_SCALED_DURATION_PER_WORD_MS
          )
        );
      })
    );
  });

  it('keeps an import notice up 2 s past the usual floor, unless its words take longer to read', () => {
    fc.assert(
      fc.property(
        messageArb,
        kindArb,
        categoryArb,
        (message, kind, category) => {
          Notice.reset();

          notify(message, { kind, category });

          const words = message.split(' ').length;
          const floor =
            category === 'import'
              ? NOTICE_MIN_DURATION_MS + IMPORT_NOTICE_EXTRA_MS
              : NOTICE_MIN_DURATION_MS;
          expect(Notice.instances[0].duration).toBe(
            Math.max(floor, words * NOTICE_SCALED_DURATION_PER_WORD_MS)
          );
        }
      )
    );
  });

  it('keeps a short import notice up exactly 2 s longer than any other short notice', () => {
    notify('Imported "A"', { kind: 'success', category: 'import' });
    notify('Imported "A"', { kind: 'success' });

    expect(IMPORT_NOTICE_EXTRA_MS).toBe(2000);
    expect(Notice.instances.map((notice) => notice.duration)).toEqual([
      NOTICE_MIN_DURATION_MS + 2000,
      NOTICE_MIN_DURATION_MS,
    ]);
  });

  it('keeps a persistent import notice up until something hides it', () => {
    notify('Imported "A"', { category: 'import', persist: true });

    expect(Notice.instances[0].duration).toBe(0);
  });

  it('keeps at most one evictable notice up, hiding each one once and never touching the rest', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.string(), optionsArb), { maxLength: 20 }),
        (calls) => {
          Notice.reset();

          calls.forEach(([message, options], i) => {
            notify(message, options);

            const raised = Notice.instances.slice(0, i + 1);
            expect(
              raised.filter(
                (notice, j) => isEvictable(calls[j][1]) && notice.hides === 0
              ).length
            ).toBeLessThanOrEqual(1);
          });

          const last = calls.length - 1;
          calls.forEach(([, options], i) => {
            const evicted = isEvictable(options) && i < last;
            expect(Notice.instances[i].hides).toBe(evicted ? 1 : 0);
          });
        }
      )
    );
  });

  it('hands back the notice it raised, so its caller can update or hide it', () => {
    fc.assert(
      fc.property(fc.string(), optionsArb, (message, options) => {
        Notice.reset();

        const notice = notify(message, options);

        expect(notice).toBe(Notice.instances[0]);
        expect(Notice.messages).toEqual([message]);
      })
    );
  });
});

describe('notify with success notice levels', () => {
  beforeEach(() => {
    Notice.reset();
  });

  afterEach(() => {
    configureSuccessNotices(null);
    vi.restoreAllMocks();
  });

  it('shows a success only as the level where it was raised allows, and every other notice always', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...levels),
        fc.constantFrom(...levels),
        fc.boolean(),
        kindArb,
        categoryArb,
        fc.option(fc.boolean(), { nil: undefined }),
        (inside, outside, inReview, kind, category, persist) => {
          Notice.reset();
          configureSuccessNotices(makeSource({ inside, outside, inReview }));
          notify('earlier');

          const notice = notify('now', { kind, category, persist });

          const level = inReview ? inside : outside;
          const shown =
            kind !== 'success' ||
            persist === true ||
            level === 'all' ||
            (level === 'minimal' && category !== undefined);
          expect(Notice.messages).toEqual(
            shown ? ['earlier', 'now'] : ['earlier']
          );
          expect(notice).toBe(shown ? Notice.instances[1] : null);
          // One that is not shown leaves the notice before it up
          expect(Notice.instances[0].hides).toBe(shown ? 1 : 0);
        }
      )
    );
  });

  it('reads the levels and the review tab afresh for each notice', () => {
    const source = makeSource({ inside: 'none', outside: 'all' });
    configureSuccessNotices(source);

    notify('outside', { kind: 'success' });
    source.getActiveReviewView = () => ({});
    notify('inside', { kind: 'success' });
    source.settings.successNoticesInReview = 'all';
    notify('inside again', { kind: 'success' });

    expect(Notice.messages).toEqual(['outside', 'inside again']);
  });

  it('shows every success while nothing has set the levels', () => {
    fc.assert(
      fc.property(categoryArb, (category) => {
        Notice.reset();

        notify('done', { kind: 'success', category });

        expect(Notice.messages).toEqual(['done']);
      })
    );
  });
});

describe('notify with an action', () => {
  beforeEach(() => {
    Notice.reset();
    configureSuccessNotices(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows one button labelled as the action says, and none without an action', () => {
    fc.assert(
      fc.property(
        messageArb,
        optionsArb,
        fc.option(fc.string(), { nil: undefined }),
        (message, options, label) => {
          Notice.reset();
          const action = label === undefined ? undefined : makeAction(label);

          const notice = notify(message, { ...options, action });

          const buttons = buttonsOf(Notice.instances[0]);
          expect(notice).toBe(Notice.instances[0]);
          expect(buttons.map((button) => button.textContent)).toEqual(
            label === undefined ? [] : [label]
          );
          for (const button of buttons) {
            expect(button.getAttribute('role')).toBe('button');
            // Styled as a button by the plugin's own class, laid out by Obsidian's
            expect([...button.classList].sort()).toEqual([
              'ir-notice-action',
              'notice-cta',
            ]);
            // In the row Obsidian lays its own notice buttons out in
            const row = button.parentElement!;
            expect(row.className).toBe('notice-button-container');
            expect(row.parentElement).toBe(Notice.instances[0].containerEl);
          }
          expect(Notice.instances[0].messageEl.textContent).toBe(message);
        }
      )
    );
  });

  it('hides the notice and hands the click to the action once, for a plain or a middle click', () => {
    for (const button of [0, 1]) {
      Notice.reset();
      const action = makeAction();
      notify('Imported', { action });
      const [notice] = Notice.instances;

      const evt = press(buttonsOf(notice)[0], button);

      expect(action.onClick).toHaveBeenCalledOnce();
      expect(action.onClick).toHaveBeenCalledWith(evt);
      expect(notice.hides).toBeGreaterThan(0);
    }
  });

  it('hides the notice on a middle click, which never reaches its own click-to-hide', () => {
    notify('Imported', { action: makeAction() });
    const [notice] = Notice.instances;

    press(buttonsOf(notice)[0], 1);

    expect(notice.hides).toBe(1);
  });

  it('ignores any other mouse button on the button', () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 2, max: 4 })
          .chain((button) => fc.constantFrom(button, 0)),
        (button) => {
          Notice.reset();
          const action = makeAction();
          notify('Imported', { action });
          const [notice] = Notice.instances;

          // Any button but the middle one, reported as an auxclick
          buttonsOf(notice)[0].dispatchEvent(
            new MouseEvent('auxclick', { bubbles: true, button })
          );

          expect(action.onClick).not.toHaveBeenCalled();
          expect(notice.hides).toBe(0);
        }
      )
    );
  });

  it('still hides the notice on a click on its message, running no action', () => {
    const action = makeAction();
    notify('Imported', { action });
    const [notice] = Notice.instances;

    press(notice.messageEl, 0);

    expect(action.onClick).not.toHaveBeenCalled();
    expect(notice.hides).toBe(1);
  });

  it('hides the same notices whether or not they carry actions', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(optionsArb, fc.boolean()), { maxLength: 20 }),
        (calls) => {
          const hidesWith = (withActions: boolean) => {
            Notice.reset();
            for (const [options, hasAction] of calls) {
              notify('notice', {
                ...options,
                action: withActions && hasAction ? makeAction() : undefined,
              });
            }
            return Notice.instances.map((notice) => notice.hides);
          };

          expect(hidesWith(true)).toEqual(hidesWith(false));
        }
      )
    );
  });
});
