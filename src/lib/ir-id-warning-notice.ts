import { NOTICE_MIN_DURATION_MS } from './constants';
import type { DamagedNote, DamagedNoteActions } from './damaged-note-actions';
import type { ItemTable } from './moved-note-scan';
import { notify } from './notices';

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

/** Opens the kind of notice {@link createIrIdWarning} and {@link createDamagedNotesNotice} need. */
export const persistentNotice: NoticeFactory = (message) =>
  notify(message, { persist: true });

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
   * what counts as an event worth warning about.
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
 * The plugin keeps one of these for an edit refused before it was made. Damage
 * already written elsewhere names its notes instead (see
 * {@link createDamagedNotesNotice}).
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

/**
 * How many notes {@link createDamagedNotesNotice} lists, a row each, before
 * counting the rest: a folder arriving over Sync can name a great many, and
 * the notice has to stay readable on a phone.
 */
export const DAMAGED_NOTES_LISTED = 10;

/** A note's name as the user sees it: its file name, less a `.md`. */
function noteName(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1);
  return file.endsWith('.md') ? file.slice(0, -'.md'.length) : file;
}

/** The kind of item each table holds, as a row of the notice names it. */
const KIND_BY_TABLE: Readonly<Record<ItemTable, string>> = {
  article: 'article',
  snippet: 'snippet',
  srs_card: 'card',
};

/**
 * What the notice says above its rows, about `count` notes whose `ir-id` was
 * taken off or changed outside the plugin. What that costs differs by row (see
 * {@link damageText}), so the heading says only what happened.
 */
export function damagedNotesHeading(count: number): string {
  const notes = count === 1 ? 'an item note' : `${count} item notes`;
  return `Incremental reading: the ir-id of ${notes} was removed or changed.`;
}

/**
 * What a row says about its note: what it is, what became of its id, and what
 * that costs. A note with no id is still its row's by its path, so its review
 * data is still served; one claiming another id loses it on the next review.
 */
function damageText({ table, change }: DamagedNote): string {
  const kind = KIND_BY_TABLE[table];
  return change === 'removed'
    ? `${kind} · ir-id removed. It is still connected with its review data until it is moved or renamed.`
    : `${kind} · ir-id changed. Restore it so it can be found in the database.`;
}

export interface DamagedNotesNotice {
  /**
   * Report notes whose `ir-id` was taken off or changed. Looks each up first,
   * along with every note the notice already lists, so it says what became of
   * each by now; one whole again by then is left out, or taken off the list.
   * Never rejects: a failed lookup is told of in the console.
   */
  report(paths: readonly string[]): Promise<void>;
  /** Hide the notice if it is up. For plugin unload. */
  dispose(): void;
}

/** The notice on screen, and the notes it lists, in the order reported. */
interface OpenDamagedNotes {
  notice: NoticeTarget;
  notes: Map<string, DamagedNote>;
  dismissed: boolean;
  /** Notes being restored, whose Restore is held off until that ends. */
  restoring: Set<string>;
  restoringAll: boolean;
  /** Where Restore all goes, between the notice's message and its rows. */
  allEl: HTMLElement;
  /** Where the rows go, scrolled on their own when they outgrow the screen. */
  listEl: HTMLElement;
}

/**
 * One notice listing the notes whose `ir-id` was taken off or changed, a row
 * each, kept up until the user dismisses it: the edit isn't undone for them,
 * so it must not slip by. Notes reported while it is up are added to it rather
 * than stacking another, since Sync can deliver a damaged folder over several
 * passes.
 *
 * Each row offers Open, so the user can look at the note, and Restore where
 * one live row sits at its path (see {@link DamagedNoteActions.restore}): the
 * plugin never puts an id back by itself, only from this button. Restore all
 * restores every note the notice holds that Restore can, listed or counted.
 * A note found whole again (restored, opened and found mended, or looked up
 * again with a later report) leaves the notice, which goes once it lists
 * nothing.
 */
export function createDamagedNotesNotice(
  createNotice: NoticeFactory,
  actions: DamagedNoteActions
): DamagedNotesNotice {
  let open: OpenDamagedNotes | null = null;
  /** Bumped by `dispose`, so a lookup it overtook raises nothing. */
  let disposals = 0;

  const onScreen = (state: OpenDamagedNotes) =>
    !state.dismissed && state.notice.containerEl.isConnected;

  /** Look the note at `path` up again, and list what it is now, if anything. */
  const refresh = async (state: OpenDamagedNotes, path: string) => {
    const [note] = await actions.describe([path]);
    if (note) state.notes.set(path, note);
    else state.notes.delete(path);
  };

  const restoreOne = async (state: OpenDamagedNotes, path: string) => {
    if (state.restoring.has(path)) return;
    state.restoring.add(path);
    render(state);
    try {
      if (await actions.restore(path)) state.notes.delete(path);
      else await refresh(state, path);
    } catch (error) {
      console.error(
        `Incremental Reading - failed to restore the ir-id of ${path}:`,
        error
      );
    } finally {
      state.restoring.delete(path);
      render(state);
    }
  };

  const restoreAll = async (state: OpenDamagedNotes) => {
    if (state.restoringAll) return;
    state.restoringAll = true;
    try {
      // One at a time: each is a write to a note, and a burst of them all at
      // once is what a phone handles worst
      for (const { path } of [...state.notes.values()]) {
        if (state.notes.get(path)?.restorable) await restoreOne(state, path);
      }
    } finally {
      state.restoringAll = false;
      render(state);
    }
  };

  const openOne = async (state: OpenDamagedNotes, path: string) => {
    try {
      await actions.open(path);
      // Opened, or gone from its path: either way, list what is there now
      await refresh(state, path);
    } catch (error) {
      console.error(`Incremental Reading - failed to open ${path}:`, error);
    }
    render(state);
  };

  /**
   * A button that runs `run` and leaves the notice up. Obsidian's notice
   * hides on any click on it (undocumented: its constructor listens for
   * `click` on `containerEl`), so the click stops at the button.
   */
  const addButton = (
    parent: HTMLElement,
    text: string,
    cls: string[],
    disabled: boolean,
    run: () => Promise<void>
  ) => {
    const button = parent.createEl('button', { text, cls });
    button.disabled = disabled;
    button.addEventListener('click', (evt) => {
      evt.stopPropagation();
      void run();
    });
  };

  /** Redraw the notice's rows from what it holds, or take it down if nothing. */
  function render(state: OpenDamagedNotes) {
    if (open !== state) return;
    if (state.notes.size === 0) {
      open = null;
      if (onScreen(state)) state.notice.hide();
      return;
    }
    const notes = [...state.notes.values()];
    state.notice.setMessage(damagedNotesHeading(notes.length));
    const list = state.listEl;
    list.replaceChildren();
    state.allEl.replaceChildren();
    const busy = state.restoringAll || state.restoring.size > 0;
    if (notes.filter((note) => note.restorable).length >= 2) {
      addButton(
        state.allEl,
        'Restore all',
        ['ir-damaged-notes-restore-all', 'mod-cta'],
        busy,
        () => restoreAll(state)
      );
    }
    for (const note of notes.slice(0, DAMAGED_NOTES_LISTED)) {
      const row = list.createDiv({
        cls: 'ir-damaged-note',
        attr: { 'data-path': note.path },
      });
      const info = row.createDiv('ir-damaged-note-info');
      // The full path, for two notes of the same name
      info.createDiv({
        cls: 'ir-damaged-note-name',
        text: noteName(note.path),
        attr: { 'aria-label': note.path },
      });
      info.createDiv({ cls: 'ir-damaged-note-kind', text: damageText(note) });
      const buttons = row.createDiv('ir-damaged-note-buttons');
      addButton(buttons, 'Open', ['ir-damaged-note-open'], false, () =>
        openOne(state, note.path)
      );
      if (note.restorable) {
        addButton(
          buttons,
          'Restore',
          ['ir-damaged-note-restore', 'mod-cta'],
          state.restoringAll || state.restoring.has(note.path),
          () => restoreOne(state, note.path)
        );
      }
    }
    const rest = notes.length - DAMAGED_NOTES_LISTED;
    if (rest > 0) {
      list.createDiv({ cls: 'ir-damaged-notes-more', text: `+${rest} more` });
    }
  }

  const raise = (count: number): OpenDamagedNotes => {
    const notice = createNotice(damagedNotesHeading(count));
    const el = notice.containerEl;
    el.classList.add('ir-damaged-notes-notice');
    const state: OpenDamagedNotes = {
      notice,
      notes: new Map(),
      dismissed: false,
      restoring: new Set(),
      restoringAll: false,
      allEl: el.createDiv('ir-damaged-notes-all'),
      // Obsidian drags a notice on a phone toward dismissal with any vertical
      // swipe, unless the touch starts inside an element carrying
      // `data-ignore-swipe` (undocumented: read from obsidian.asar, 1.13), so
      // the list can be scrolled when its rows outgrow the screen
      listEl: el.createDiv({
        cls: 'ir-damaged-notes',
        attr: { 'data-ignore-swipe': 'true' },
      }),
    };
    // Rewriting a notice the user dismissed would show them nothing. A click
    // hides it (Obsidian's `Notice` listens for one: undocumented), but the
    // element stays in the document while the hide animates, so the click is
    // watched as well as the element leaving (a swipe on a phone)
    el.addEventListener('click', () => {
      state.dismissed = true;
    });
    open = state;
    return state;
  };

  return {
    async report(paths) {
      if (paths.length === 0) return;
      const disposalsBefore = disposals;
      const shownBefore = open && onScreen(open) ? open : null;
      // The notes already listed are looked up in the same read, so one
      // mended since is taken off as the next damage comes in
      const held = shownBefore ? [...shownBefore.notes.keys()] : [];
      const asked = [...new Set([...held, ...paths])];
      let notes: DamagedNote[];
      try {
        notes = await actions.describe(asked);
      } catch (error) {
        console.error(
          'Incremental Reading - failed to look up notes whose ir-id was removed or changed:',
          error
        );
        return;
      }
      if (disposals !== disposalsBefore) return;
      const shown = open && onScreen(open) ? open : null;
      // The notice it looked rows up for, still up. A row it held when the
      // lookup began and dropped since (restored, or found mended by Open)
      // stays dropped: the lookup may have read the note before that. Any
      // other notice lists only the notes this report names.
      const same = shown !== null && shown === shownBefore;
      const listed = notes.filter((note) =>
        same
          ? !held.includes(note.path) || shown.notes.has(note.path)
          : paths.includes(note.path)
      );
      if (same) {
        const found = new Set(notes.map((note) => note.path));
        // Only what was held when the lookup began: a row added since was
        // looked up on its own
        for (const path of held) {
          if (!found.has(path)) shown.notes.delete(path);
        }
      }
      if (!shown && listed.length === 0) return;
      const state = shown ?? raise(listed.length);
      for (const note of listed) state.notes.set(note.path, note);
      render(state);
    },
    dispose() {
      disposals += 1;
      open?.notice.hide();
      open = null;
    },
  };
}
