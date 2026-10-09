import { Notice } from 'obsidian';
import { NOTICE_MIN_DURATION_MS } from './constants';

/**
 * The part of Obsidian's `Notice` this module drives. Declared structurally
 * rather than as `Pick<Notice, …>` so a test double need not hand a whole
 * `Notice` back from `setMessage`; a real `Notice` satisfies it either way.
 */
export interface NoticeTarget {
  /** The notice's own element. Obsidian detaches it once it is hidden. */
  containerEl: HTMLElement;
  setMessage(message: string): unknown;
  hide(): void;
}

/**
 * Opens a notice showing `message` that stays up until something hides it.
 *
 * Obsidian starts its own auto-hide timer from the duration handed to the
 * constructor and offers no way to extend it, so a notice that keeps being
 * rewritten would still vanish mid-burst. Hence `duration: 0` and a timer of
 * our own — see {@link persistentNotice}.
 */
export type NoticeFactory = (message: string) => NoticeTarget;

/** Opens the kind of notice {@link createIrIdWarning} needs. */
export const persistentNotice: NoticeFactory = (message) =>
  new Notice(message, 0);

/** Runs `run` after `ms`, and hands back the function that cancels it. */
export type Timer = (run: () => void, ms: number) => () => void;

/**
 * On the main window rather than `activeWindow`, which is where Obsidian puts a
 * notice: a popout window can be closed while the notice window is open, and
 * timers set on one that has closed never fire, which would leave the notice up
 * for good.
 */
export const hostTimer: Timer = (run, ms) => {
  const id = window.setTimeout(run, ms);
  return () => window.clearTimeout(id);
};

/**
 * The repair path's message: what the user is told, once, however many notes
 * the burst damaged.
 */
export const IR_ID_WARNING_MESSAGE =
  "Incremental Reading: don't edit the ir-id property. It's how a note finds its review data.";

/** How long the notice stays up after the most recent damage event. */
export const IR_ID_WARNING_WINDOW_MS = NOTICE_MIN_DURATION_MS;

/**
 * The longest one notice may stay up, counted from the first event it reported.
 * A sliding window alone could be held open for as long as a sync runs.
 */
export const IR_ID_WARNING_MAX_LIFETIME_MS = 30_000;

/**
 * `message` for a window that has caught `count` events. A count is shown only
 * from the second one: `(×1)` on a lone event is noise, and the message has to
 * read on a phone.
 */
export function irIdWarningMessage(message: string, count: number): string {
  return count > 1 ? `${message} (×${count})` : message;
}

export interface IrIdWarningDeps {
  createNotice: NoticeFactory;
  /** What the notice says. */
  message: string;
  /**
   * Whether the notice counts the events folded into it. Defaults to true.
   *
   * Off where the events are not separate things the user did: a key held down
   * against a refused edit is one refusal per key repeat, and `(×37)` would
   * report the keyboard's repeat rate, not anything the user can act on.
   */
  showCount?: boolean;
  /** Defaults to {@link IR_ID_WARNING_WINDOW_MS}. */
  windowMs?: number;
  /** Defaults to {@link IR_ID_WARNING_MAX_LIFETIME_MS}. */
  maxLifetimeMs?: number;
  timer?: Timer;
  /** The clock the lifetime cap is measured on. */
  now?: () => number;
}

export interface IrIdWarning {
  /**
   * Report one event: raise the warning, or fold this event into the one
   * already on screen and bump its count.
   *
   * Says nothing about *which* note, or what happened to it — the caller decides
   * what counts as an event worth warning about. For the repair path, in
   * particular, it is the caller's job not to call this for the plugin's own
   * repair write, which re-fires `changed`, nor while Obsidian is still indexing
   * the vault, when every note that legitimately has no `ir-id` would warn at
   * once.
   */
  warn(): void;
  /** Hide anything on screen and cancel the timer. For plugin unload. */
  dispose(): void;
}

/**
 * The notice on screen. Everything it counts and every timer it owns is held in
 * the closure that raised it, so a stale notice can never be mistaken for the
 * one that replaced it.
 */
interface OpenWarning {
  notice: NoticeTarget;
  /**
   * Whether the notice is still on screen, which is not ours to assume: clicking
   * a notice dismisses it and Obsidian tells nobody. Rewriting one that is
   * already gone shows the user nothing at all, so both of its endings are
   * watched — the click, which Obsidian handles by hiding it (an undocumented
   * detail of `Notice`: its constructor registers a `click` listener on
   * `containerEl` that calls `hide`), and the element leaving the document,
   * which is the only sign of a phone swipe-to-dismiss, or of a hide nothing
   * told us about. The click matters on its own because Obsidian detaches the
   * element only once the hide animation has run, so for ~120ms after a click
   * the notice is still in the document and already on its way out.
   */
  onScreen: () => boolean;
  /** Fold one more event into this notice: count it, and slide its window. */
  bump: () => void;
  /** Give up the timer and the listeners. Called once, as the notice ends. */
  end: () => void;
}

/**
 * A single warning about `ir-id`, shown at most once at a time. Events come in
 * bursts — Obsidian Sync can deliver a run of damaged notes in quick
 * succession, and a key held against a refused edit refuses one transaction per
 * repeat — and a stack of identical notices would bury everything else on
 * screen, so every event within the window folds into the notice already up and
 * bumps the count it displays (if {@link IrIdWarningDeps.showCount} allows).
 *
 * The plugin keeps one of these per kind of event, each with its own message:
 * one for damage already written and repaired, one for an edit refused before
 * it was made. The two never fire for the same action, and one notice each
 * keeps what happened unambiguous.
 *
 * The window slides: each event carries the notice {@link IrIdWarningDeps.windowMs}
 * further, so it is still there when the burst ends rather than expiring in the
 * middle of it. A long sync could otherwise pin it open indefinitely, so the
 * notice is also hidden {@link IrIdWarningDeps.maxLifetimeMs} after the event
 * that raised it, whatever else has arrived since. The count belongs to the
 * notice: once one ends — its window closed, its cap reached, or the user
 * dismissed it — the next event raises a fresh notice counting from one.
 *
 * A pointer resting on the notice pauses the window, as Obsidian's own notices
 * do with theirs, since a warning that slides shut while it is being read is a
 * warning that failed. The cap is not paused: it is there so that nothing can
 * keep the notice up for good, and a pointer left on it is one more thing that
 * must not. Events arriving while the pointer is there are still counted on
 * screen, and bank a fresh window for it to leave with rather than arming a
 * timer that would fire under the pointer.
 */
export function createIrIdWarning({
  createNotice,
  message,
  showCount = true,
  windowMs = IR_ID_WARNING_WINDOW_MS,
  maxLifetimeMs = IR_ID_WARNING_MAX_LIFETIME_MS,
  timer = hostTimer,
  now = Date.now,
}: IrIdWarningDeps): IrIdWarning {
  let open: OpenWarning | null = null;

  /** Hide whatever is up, and stop counting. */
  const close = () => {
    const state = open;
    if (state === null) return;
    open = null;
    state.end();
    // Nothing to hide if the user got there first, and nothing to gain from
    // reaching into a notice that is already gone
    if (state.onScreen()) state.notice.hide();
  };

  const raise = () => {
    close();
    const notice = createNotice(message);
    const el = notice.containerEl;
    const openedAt = now();
    let count = 1;
    // Held per notice rather than per warning, so a stale notice's click can
    // never mark the one that replaced it as dismissed
    let dismissed = false;
    let hovering = false;
    /** How much window is left to run, while the pointer holds it. */
    let windowLeft = windowMs;
    /** When the window would close, while it is running. */
    let windowEndsAt = openedAt + windowMs;
    let cancelTimer: () => void;

    /**
     * Hide once `budget` more milliseconds of window have run, or at the cap,
     * whichever comes first. `Infinity` waits on the cap alone.
     */
    const arm = (budget: number) => {
      const capLeft = openedAt + maxLifetimeMs - now();
      cancelTimer = timer(close, Math.max(0, Math.min(budget, capLeft)));
    };

    const onDismiss = () => {
      dismissed = true;
    };
    // Obsidian pauses a notice of its own on hover, but only where it set an
    // auto-hide timer: at `duration: 0` it registers no hover listeners at all
    // (an undocumented detail of `Notice.setAutoHide`), so these are the only
    // ones on the element and nothing else is watching for the pointer.
    const onHover = () => {
      if (hovering) return;
      hovering = true;
      windowLeft = Math.max(0, windowEndsAt - now());
      cancelTimer();
      arm(Number.POSITIVE_INFINITY);
    };
    const onLeave = () => {
      if (!hovering) return;
      hovering = false;
      windowEndsAt = now() + windowLeft;
      cancelTimer();
      arm(windowLeft);
    };

    el.addEventListener('click', onDismiss);
    el.addEventListener('mouseenter', onHover);
    el.addEventListener('mouseleave', onLeave);
    arm(windowMs);

    open = {
      notice,
      onScreen: () => !dismissed && el.isConnected,
      bump: () => {
        count += 1;
        // Nothing to rewrite with the count off: the text is what is up already
        if (showCount) notice.setMessage(irIdWarningMessage(message, count));
        // The window slides under the pointer too, but as a budget to leave
        // with: arming a timer here is what would fire it mid-read
        windowLeft = windowMs;
        if (hovering) return;
        windowEndsAt = now() + windowMs;
        cancelTimer();
        arm(windowMs);
      },
      end: () => {
        cancelTimer();
        el.removeEventListener('click', onDismiss);
        el.removeEventListener('mouseenter', onHover);
        el.removeEventListener('mouseleave', onLeave);
      },
    };
  };

  return {
    warn() {
      const state = open;
      if (state === null || !state.onScreen()) {
        raise();
        return;
      }
      state.bump();
    },
    dispose: close,
  };
}
