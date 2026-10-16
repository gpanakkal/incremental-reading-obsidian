import { setIcon } from 'obsidian';
import { CURRENT_ITEM_REFETCH_TIME, MS_PER_MINUTE } from './constants';
import type { NoteType } from './types';

/** What the indicator says. Never a count: a number left waiting nags. */
export const REVIEW_REMINDER_TEXT = 'Ready for review';

/**
 * How often the indicator checks again with nothing changed in the database,
 * for items that fall due when the review day rolls over.
 */
export const REVIEW_REMINDER_POLL_TIME = MS_PER_MINUTE;

/** The settings the indicator follows. */
export interface ReminderSettings {
  reviewReminders: boolean;
  remindDueArticles: boolean;
  remindDueSnippets: boolean;
}

/**
 * The item types whose due items light the indicator, or null while reminders
 * are off. Due cards always count.
 */
export function reminderTypes(
  settings: ReminderSettings
): Partial<Record<NoteType, true>> | null {
  if (!settings.reviewReminders) return null;
  return {
    card: true,
    ...(settings.remindDueArticles && { article: true }),
    ...(settings.remindDueSnippets && { snippet: true }),
  };
}

export interface ReviewReminderOptions {
  /** The status bar item to fill; hidden while nothing is due. */
  el: HTMLElement;
  icon: string;
  reviewManager: {
    /** Whether anything of these types is due; read-only. */
    anyDue(typesToInclude: Partial<Record<NoteType, true>>): Promise<boolean>;
  };
  getSettings: () => ReminderSettings;
  /** Each subscribes `listener` and returns its unsubscribe. */
  onDataChange: (listener: () => void) => () => void;
  onSettingsChange: (listener: () => void) => () => void;
  /** Opens or focuses the review tab. */
  open: () => void;
}

export interface ReviewReminder {
  /** Check again, no sooner than the refetch interval allows. */
  refresh(): void;
  /** Stop checking and take the indicator out of the status bar. */
  dispose(): void;
}

/**
 * Show {@link REVIEW_REMINDER_TEXT} in `el` exactly while reminders are on and
 * an item of a type they cover is due.
 *
 * Data changes come in bursts (one per table and operation per write), so they
 * are coalesced: the database is asked at most once per
 * `CURRENT_ITEM_REFETCH_TIME`, and always once more after the last change in a
 * burst. The poll every {@link REVIEW_REMINDER_POLL_TIME} goes through the same
 * gate, so a poll query counts as the last query for a data change after it. A
 * settings change asks at once, since the user is watching for it.
 */
export function startReviewReminder(
  options: ReviewReminderOptions
): ReviewReminder {
  const { el, reviewManager, getSettings } = options;

  el.classList.add('mod-clickable');
  el.setAttribute('aria-label', 'Open review');
  el.setAttribute('data-tooltip-position', 'top');
  const segment = el.createDiv({ cls: 'status-bar-item-segment' });
  setIcon(segment.createSpan({ cls: 'status-bar-item-icon' }), options.icon);
  segment.createSpan({ text: REVIEW_REMINDER_TEXT });
  const onClick = () => options.open();
  el.addEventListener('click', onClick);

  const setShown = (shown: boolean) => {
    el.style.display = shown ? '' : 'none';
  };
  setShown(false);

  let disposed = false;
  /** Stands for the latest query; only its answer is shown. */
  let latest: object = {};
  let lastQuery = 0;
  let timer: number | null = null;

  const check = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    lastQuery = Date.now();
    const current = {};
    latest = current;
    const typesToInclude = reminderTypes(getSettings());
    if (!typesToInclude) {
      setShown(false);
      return;
    }
    reviewManager.anyDue(typesToInclude).then(
      (due) => {
        if (!disposed && current === latest) setShown(due);
      },
      // `anyDue` logs its own failure. Whatever was last known stands.
      () => {}
    );
  };

  const refresh = () => {
    if (disposed || timer !== null) return;
    const wait = Math.max(
      0,
      lastQuery + CURRENT_ITEM_REFETCH_TIME - Date.now()
    );
    timer = window.setTimeout(check, wait);
  };

  const unsubscribeData = options.onDataChange(refresh);
  const unsubscribeSettings = options.onSettingsChange(check);
  const poll = window.setInterval(refresh, REVIEW_REMINDER_POLL_TIME);
  check();

  return {
    refresh,
    dispose: () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      window.clearInterval(poll);
      unsubscribeData();
      unsubscribeSettings();
      el.removeEventListener('click', onClick);
      el.remove();
    },
  };
}
