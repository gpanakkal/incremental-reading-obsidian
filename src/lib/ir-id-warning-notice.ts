import { TYPE_ICONS } from '#/components/icons/typeIcons';
import type { NoteType } from '#/lib/types';
import { h, render as renderVNode } from 'preact';
import { NOTICE_MIN_DURATION_MS } from './constants';
import type {
  Candidate,
  DamagedNote,
  DamagedNoteActions,
} from './damaged-note-actions';
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
  setMessage(message: string | DocumentFragment): unknown;
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

/**
 * Where a row points, said without the note's name, which the line above it
 * already gives: its folder, or the vault's root.
 */
function noteWhere(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? 'at the vault root' : `in ${path.slice(0, cut)}/`;
}

/**
 * The kind of item each table holds, as a row of the notice names it, and as
 * the type its icon and tint are drawn for.
 */
const KIND_BY_TABLE: Readonly<Record<ItemTable, NoteType>> = {
  article: 'article',
  snippet: 'snippet',
  srs_card: 'card',
};

/**
 * What the notice says above its rows, about `count` notes whose `ir-id` was
 * taken off or changed outside the plugin, or whose row moved away. It says
 * only what happened: the rows say what can be done about it.
 */
export function damagedNotesHeading(count: number): string {
  const notes = count === 1 ? 'an item note' : `${count} item notes`;
  const where = count === 1 ? 'the note' : 'the notes';
  return `Incremental reading: the ID of ${notes} was removed or changed in ${where}`;
}

/**
 * Name the note at `path` under `parent` as the queue would: its type's icon
 * on its type's tint, then its name, the full path on hover for two notes of
 * the same name.
 */
function appendNoteLabel(parent: HTMLElement, path: string, table: ItemTable) {
  const type = KIND_BY_TABLE[table];
  const icon = parent.createSpan({
    cls: 'ir-damaged-note-icon',
    attr: { 'data-type': type },
  });
  renderVNode(h(TYPE_ICONS[type], {}), icon);
  parent.createSpan({
    cls: 'ir-damaged-note-name',
    text: noteName(path),
    attr: { 'aria-label': path },
  });
}

/**
 * The notice's message for `notes`: a lone note named in it, by its icon and
 * name; several counted, each named on its own row instead.
 */
function damagedNotesMessage(
  notes: readonly DamagedNote[]
): string | DocumentFragment {
  if (notes.length !== 1) return damagedNotesHeading(notes.length);
  const [{ path, table }] = notes;
  return createFragment((message) => {
    message.append('Incremental reading: the ID of ');
    appendNoteLabel(message.createSpan('ir-damaged-note-label'), path, table);
    message.append(' was removed or changed in the note');
  });
}

/**
 * Whether a note's candidates are shown a block each. With one row to offer,
 * what its button does goes without saying, and the heading already names
 * the note; with two or more, the blocks are what tell the buttons apart, and
 * a blocked row's block says which row its reason is about.
 */
const showsCandidateBlocks = ({ candidates }: DamagedNote) =>
  candidates.length >= 2 || candidates.some(({ blocked }) => blocked !== null);

/**
 * What heads the block of the row `candidate` offers: its kind, and how it
 * matches the note, at the note's path or by holding the id the note claims.
 */
export function candidateHeading({ by, table }: Candidate): string {
  const kind = KIND_BY_TABLE[table];
  const named = kind[0].toUpperCase() + kind.slice(1);
  return by === 'path'
    ? `${named} pointing to this path`
    : `${named} matching this note's ID`;
}

/**
 * The attributes that tell, on its block and on what it offers, which row a
 * candidate is, and what blocks it, if anything.
 */
const candidateAttr = ({
  by,
  table,
  id,
  blocked,
}: Candidate): Record<string, string> => ({
  'data-by': by,
  'data-table': table,
  'data-id': id,
  ...(blocked ? { 'data-blocked': blocked } : {}),
});

/**
 * Why a row of `table` can't be re-associated with the note, said in the row
 * of buttons where its Re-associate would be: its own note is still where it
 * points, or another item is recorded at this note's path.
 */
export function blockedText(
  blocked: NonNullable<Candidate['blocked']>,
  table: ItemTable
) {
  return blocked === 'occupied'
    ? `Can't re-associate; this ${KIND_BY_TABLE[table]} already has a note.`
    : "Can't re-associate; another item is recorded at this note's path.";
}

/**
 * What a listed note is told as, to tell whether it was told of already as
 * it is now: one per note per load (see {@link DamagedNotesNotice.opened}).
 */
const toldAs = (note: DamagedNote) => JSON.stringify(note);

export interface DamagedNotesNotice {
  /**
   * Report notes whose `ir-id` was taken off or changed. Looks each up first,
   * along with every note the notice already lists, so it says what became of
   * each by now; one whole again by then is left out, or taken off the list.
   * Never rejects: a failed lookup is told of in the console.
   */
  report(paths: readonly string[]): Promise<void>;
  /**
   * Told that the note at `path` is now in front of the user (opened, its tab
   * come to the front, or shown in review): list it if no live row holds it,
   * once per load as it is now. Reopened as it was told of, it is left as
   * it is, dismissed or not; changed since, its row is replaced, or a notice
   * raised for it. Found whole, it is taken off. Never rejects: a failed
   * lookup is told of in the console.
   */
  opened(path: string): Promise<void>;
  /**
   * Look up again the notes at `paths`, changed since (all the notice lists,
   * without), as a note mended by hand or a database another device changed
   * leaves them: each the notice lists is taken off once found whole, or
   * its row redrawn; each told of this load and found whole is told of
   * afresh when next opened damaged, dismissed or not; each come in front
   * before the metadata cache read it is looked up as {@link opened} would
   * have, once. Other notes are not looked up, and nothing else is raised.
   * Never rejects: a failed lookup is told of in the console.
   */
  recheck(paths?: readonly string[]): Promise<void>;
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
 * One notice listing the notes no live row holds by both path and `ir-id`
 * (see `mismatchOf`), a row each, kept up until the user dismisses it: the
 * edit isn't undone for them, so it must not slip by. Notes reported while it
 * is up are added to it rather than stacking another, since Sync can deliver
 * a damaged folder over several passes. Two things report them: a note damaged
 * by a write on screen ({@link DamagedNotesNotice.report}), and a note coming
 * in front of the user ({@link DamagedNotesNotice.opened}), which is how a
 * note damaged by Sync or while the plugin was off is told of.
 *
 * Each row offers, per row the note could be re-associated with, a block of
 * its own with Open, so the user can look at the note (for a row holding its
 * id elsewhere, at the note where that row points, if one is there), and its
 * Re-associate; a lone row to offer gets no block, only Open and its button.
 * Where one live row sits at its path, its button is Restore (see
 * {@link DamagedNoteActions.restore}), and any other row's re-associates it
 * (see {@link DamagedNoteActions.reassociate}): the plugin never puts an id
 * back by itself, only from these buttons. Restore all restores every note
 * the notice holds that Restore can, listed or counted. A note found whole
 * again (restored, opened and found mended, or looked up again with a later
 * report) leaves the notice, which goes once it lists nothing, or once
 * clicked away.
 */
export function createDamagedNotesNotice(
  createNotice: NoticeFactory,
  actions: DamagedNoteActions
): DamagedNotesNotice {
  let open: OpenDamagedNotes | null = null;
  /** Bumped by `dispose`, so a lookup it overtook raises nothing. */
  let disposals = 0;
  /** What each note listed this load was told as (see {@link toldAs}). */
  const told = new Map<string, string>();
  /**
   * Notes come in front before the metadata cache read them, which read as no
   * note: looked up again as it does (see {@link DamagedNotesNotice.recheck}).
   */
  const unreadInFront = new Set<string>();

  const onScreen = (state: OpenDamagedNotes) =>
    !state.dismissed && state.notice.containerEl.isConnected;

  /** List `note` on `state`, in its place if it is listed already. */
  const list = (state: OpenDamagedNotes, note: DamagedNote) => {
    state.notes.set(note.path, note);
    told.set(note.path, toldAs(note));
  };

  /**
   * Take the note at `path` off `state`, found whole: told of afresh should
   * it be damaged again.
   */
  const unlist = (state: OpenDamagedNotes, path: string) => {
    state.notes.delete(path);
    told.delete(path);
  };

  /** Look the note at `path` up again, and list what it is now, if anything. */
  const refresh = async (state: OpenDamagedNotes, path: string) => {
    const [note] = await actions.describe([path]);
    if (note) list(state, note);
    else unlist(state, path);
  };

  const restoreOne = async (state: OpenDamagedNotes, path: string) => {
    if (state.restoring.has(path)) return;
    state.restoring.add(path);
    render(state);
    try {
      if (await actions.restore(path)) unlist(state, path);
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

  const reassociateOne = async (
    state: OpenDamagedNotes,
    path: string,
    candidate: Candidate
  ) => {
    if (state.restoring.has(path)) return;
    state.restoring.add(path);
    render(state);
    try {
      if (await actions.reassociate(path, candidate)) unlist(state, path);
      else await refresh(state, path);
    } catch (error) {
      console.error(
        `Incremental Reading - failed to re-associate ${path}:`,
        error
      );
      notify(
        `Incremental reading: couldn't re-associate "${noteName(path)}". The console has the details.`,
        { kind: 'error' }
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
   * Open the note at `path`, where a row holding the note's id points, for
   * the user to compare the note with. Not the note the notice lists, so
   * nothing is looked up for it; only should it be gone by now is the listed
   * note at `of` looked up again, since its row is then free to come here.
   */
  const openPointedAt = async (
    state: OpenDamagedNotes,
    of: string,
    path: string
  ) => {
    try {
      if (await actions.open(path)) return;
      await refresh(state, of);
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
    run: () => void | Promise<void>,
    attr?: Record<string, string>
  ) => {
    const button = parent.createEl('button', { text, cls, attr });
    button.disabled = disabled;
    button.addEventListener('click', (evt) => {
      evt.stopPropagation();
      void run();
    });
  };

  /**
   * Add to `actions` what the row `candidate` offers the listed `note`: its
   * Re-associate, Restore for the one row at the note's path, held off while
   * `held`; or, when it can't be re-associated, why not.
   */
  const addOffer = (
    actions: HTMLElement,
    state: OpenDamagedNotes,
    note: DamagedNote,
    candidate: Candidate,
    held: boolean
  ) => {
    const attr = candidateAttr(candidate);
    if (candidate.blocked) {
      actions.createSpan({
        cls: 'ir-damaged-note-blocked',
        text: blockedText(candidate.blocked, candidate.table),
        attr,
      });
      return;
    }
    // The one row at its path is what Restore gives the note back to, and
    // what Restore all counts
    if (note.restorable && candidate.by === 'path') {
      addButton(
        actions,
        'Re-associate',
        ['ir-damaged-note-restore', 'mod-cta'],
        held,
        () => restoreOne(state, note.path),
        attr
      );
    } else {
      addButton(
        actions,
        'Re-associate',
        ['ir-damaged-note-reassociate', 'mod-cta'],
        held,
        () => reassociateOne(state, note.path, candidate),
        attr
      );
    }
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
    state.notice.setMessage(damagedNotesMessage(notes));
    const listEl = state.listEl;
    listEl.replaceChildren();
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
      const row = listEl.createDiv({
        cls: 'ir-damaged-note',
        attr: { 'data-path': note.path, 'data-change': note.change },
      });
      // A lone note is named in the message above
      if (notes.length > 1) {
        appendNoteLabel(
          row.createDiv('ir-damaged-note-title'),
          note.path,
          note.table
        );
      }
      const held = state.restoringAll || state.restoring.has(note.path);
      const openNote = () => openOne(state, note.path);
      if (!showsCandidateBlocks(note)) {
        // A lone row to offer, or none: Open and its button right under the
        // note, which the heading or the row's title names already
        const actions = row.createDiv('ir-damaged-note-actions');
        addButton(
          actions,
          'Open note',
          ['ir-damaged-note-open'],
          false,
          openNote
        );
        for (const candidate of note.candidates) {
          addOffer(actions, state, note, candidate, held);
        }
        continue;
      }
      // A block per row, each with its own buttons, so that no button or
      // reason can be read as another row's
      const blocks = row.createDiv('ir-damaged-note-candidates');
      for (const candidate of note.candidates) {
        const { by, blocked, reference } = candidate;
        const block = blocks.createDiv({
          cls: 'ir-damaged-note-candidate',
          attr: candidateAttr(candidate),
        });
        block.createDiv({
          cls: 'ir-damaged-note-candidate-heading',
          text: candidateHeading(candidate),
        });
        block.createDiv({
          cls: 'ir-damaged-note-candidate-name',
          text: noteName(reference),
          attr: { 'aria-label': reference },
        });
        if (by === 'id') {
          block.createDiv({
            cls: 'ir-damaged-note-candidate-path',
            text: noteWhere(reference),
          });
        }
        const actions = block.createDiv('ir-damaged-note-actions');
        // A path row's note is the listed one; an id row's is the note where
        // it points, the one this may be a copy of, when a file is there
        if (by === 'path') {
          addButton(
            actions,
            'Open note',
            ['ir-damaged-note-open'],
            false,
            openNote
          );
        } else if (blocked === 'occupied') {
          addButton(actions, 'Open note', ['ir-damaged-note-open'], false, () =>
            openPointedAt(state, note.path, reference)
          );
        }
        addOffer(actions, state, note, candidate, held);
      }
    }
    const rest = notes.length - DAMAGED_NOTES_LISTED;
    if (rest > 0) {
      listEl.createDiv({ cls: 'ir-damaged-notes-more', text: `+${rest} more` });
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

  const api: DamagedNotesNotice = {
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
          // A note the cache is re-reading reads as none, not as whole
          if (!found.has(path) && !actions.unread(path)) unlist(shown, path);
        }
      }
      if (!shown && listed.length === 0) return;
      const state = shown ?? raise(listed.length);
      for (const note of listed) list(state, note);
      render(state);
    },
    async opened(path) {
      const disposalsBefore = disposals;
      let note: DamagedNote | undefined;
      try {
        [note] = await actions.describe([path]);
      } catch (error) {
        console.error(
          `Incremental Reading - failed to look up whether ${path} is its item's note:`,
          error
        );
        return;
      }
      if (disposals !== disposalsBefore) return;
      const shown = open && onScreen(open) ? open : null;
      if (!note && actions.unread(path)) {
        // Read as no note until the cache has read it, as it soon will
        unreadInFront.add(path);
        return;
      }
      if (!note) {
        told.delete(path);
        if (shown?.notes.has(path)) {
          unlist(shown, path);
          render(shown);
        }
        return;
      }
      // Once per note per load, as it is now: dismissed, it stays so until
      // the note changes
      if (told.get(path) === toldAs(note)) return;
      const state = shown ?? raise(1);
      list(state, note);
      render(state);
    },
    async recheck(paths) {
      // Read now, and looked up as it would have been had it been read then
      const cameRead = (paths ?? []).filter((path) =>
        unreadInFront.delete(path)
      );
      await Promise.all(cameRead.map((path) => api.opened(path)));
      const disposalsBefore = disposals;
      const shownBefore = open && onScreen(open) ? open : null;
      const listed = shownBefore
        ? [...shownBefore.notes.keys()].filter(
            (path) => !paths || paths.includes(path)
          )
        : [];
      // A note told of and dismissed, as Sync may mend it and damage it again
      // without its being opened between
      const quiet = (paths ?? []).filter(
        (path) => told.has(path) && !listed.includes(path)
      );
      const asked = [...new Set([...listed, ...quiet])];
      if (asked.length === 0) return;
      let notes: DamagedNote[];
      try {
        notes = await actions.describe(asked);
      } catch (error) {
        console.error(
          'Incremental Reading - failed to look up notes listed as no item note:',
          error
        );
        return;
      }
      if (disposals !== disposalsBefore) return;
      const found = new Map(notes.map((note) => [note.path, note]));
      // A note the cache is re-reading reads as none, not as whole: left as
      // it was until the change that ends the read rechecks it
      const whole = asked.filter(
        (path) => !found.has(path) && !actions.unread(path)
      );
      for (const path of whole) told.delete(path);
      const shown = open && onScreen(open) ? open : null;
      // Dismissed meanwhile, or replaced: nothing to redraw, and nothing to
      // raise, as the user saw these already
      if (!shown || shown !== shownBefore) return;
      for (const path of listed) {
        // Dropped meanwhile (re-associated, or found mended by Open)
        if (!shown.notes.has(path)) continue;
        const note = found.get(path);
        if (note) list(shown, note);
        else if (whole.includes(path)) unlist(shown, path);
      }
      render(shown);
    },
    dispose() {
      disposals += 1;
      open?.notice.hide();
      open = null;
    },
  };
  return api;
}
