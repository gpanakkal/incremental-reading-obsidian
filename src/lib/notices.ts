import { Notice } from 'obsidian';
import {
  NOTICE_MIN_DURATION_MS,
  NOTICE_SCALED_DURATION_PER_WORD_MS,
} from './constants';
import type { IRPluginSettings } from './settings';

/**
 * What a notice reports. Only `error` changes how it behaves today: an error
 * stays up for its full time however many notices follow it. `success` marks
 * a completed action, so callers can tell confirmations apart later.
 */
export type NoticeKind = 'info' | 'success' | 'error';

export interface NotifyOptions {
  /** Defaults to `info`. */
  kind?: NoticeKind;
  /**
   * Keeps the notice up until its caller or the user hides it. Never hidden
   * here, whatever its kind: the caller owns it.
   */
  persist?: boolean;
  /** Which success this is, for the success notice levels. */
  category?: SuccessCategory;
}

/**
 * The successes the `minimal` level keeps. A success with no category is an
 * ordinary confirmation, which only the `all` level shows.
 */
export type SuccessCategory = 'undo' | 'import';

/**
 * What decides whether a success notice shows: the plugin, read afresh for
 * each notice, so a changed setting or a switch of tab applies to the next one.
 */
export interface SuccessNoticeSource {
  settings: Pick<
    IRPluginSettings,
    'successNoticesInReview' | 'successNoticesOutsideReview'
  >;
  /**
   * The review tab while it is the active view. A notice raised then comes
   * from an action taken in review (its buttons, its action bar, or a command
   * run from it), so the level for inside review applies to it.
   */
  getActiveReviewView(): object | null;
}

/** Until set, every success shows, as before the levels existed. */
let successSource: SuccessNoticeSource | null = null;

/** Lets `source`'s levels decide which success notices show; `null` shows all. */
export function configureSuccessNotices(
  source: SuccessNoticeSource | null
): void {
  successSource = source;
}

/** Whether the level where a success was raised lets it show. */
function showsSuccess(category: SuccessCategory | undefined): boolean {
  if (!successSource) return true;
  const { settings } = successSource;
  const level =
    successSource.getActiveReviewView() === null
      ? settings.successNoticesOutsideReview
      : settings.successNoticesInReview;
  return level === 'all' || (level === 'minimal' && category !== undefined);
}

/**
 * The notice the next one replaces: the latest one that is neither an error
 * nor persistent. Obsidian stacks notices, so a stream of confirmations would
 * otherwise pile up over the text being read, worst on a phone, where the
 * stack spans the screen's width. Only one is held, and only until the next
 * notice, so a hidden one is never kept.
 */
let evictable: Notice | null = null;

/**
 * Every notice the plugin shows goes through here, so that at most one notice
 * that is neither an error nor persistent is on screen: a new notice of any
 * kind hides it. Error and persistent notices are never hidden here.
 *
 * A success that is not persistent shows only if the success notice level
 * where it was raised allows it (see {@link configureSuccessNotices}). One that
 * doesn't show does nothing at all, so the notice before it stays up.
 *
 * @returns the notice, so a caller can rewrite or hide one it keeps up, or
 * `null` for a success the levels hide
 */
export function notify(
  message: string,
  options: NotifyOptions & { persist: true }
): Notice;
export function notify(message: string, options?: NotifyOptions): Notice | null;
export function notify(
  message: string,
  { kind = 'info', persist = false, category }: NotifyOptions = {}
): Notice | null {
  if (kind === 'success' && !persist && !showsSuccess(category)) return null;
  // Hiding one the user or its own timer already hid does nothing: Obsidian's
  // `hide` only animates an element still in the document, and otherwise just
  // detaches it again. Undocumented: read from obsidian.asar 1.13.7.
  evictable?.hide();
  const notice = new Notice(message, persist ? 0 : readingTime(message));
  evictable = kind === 'error' || persist ? null : notice;
  return notice;
}

/** How long a notice stays up: longer the more words it has to read. */
function readingTime(message: string) {
  const wordCount = message.split(' ').length;
  return Math.max(
    NOTICE_MIN_DURATION_MS,
    wordCount * NOTICE_SCALED_DURATION_PER_WORD_MS
  );
}
