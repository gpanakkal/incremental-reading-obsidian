import { Notice } from 'obsidian';
import {
  NOTICE_MIN_DURATION_MS,
  NOTICE_SCALED_DURATION_PER_WORD_MS,
} from './constants';

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
 * @returns the notice, so a caller can rewrite or hide one it keeps up
 */
export function notify(
  message: string,
  { kind = 'info', persist = false }: NotifyOptions = {}
): Notice {
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
