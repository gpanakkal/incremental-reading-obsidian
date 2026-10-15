import { Notice } from '#/test/__mocks__/obsidian';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NOTICE_MIN_DURATION_MS,
  NOTICE_SCALED_DURATION_PER_WORD_MS,
} from './constants';
import {
  configureSuccessNotices,
  notify,
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
