import {
  type Leftover,
  type LeftoverDeps,
  type LeftoverFailure,
  actionsFor,
  failureDetail,
  failureOf,
  findLeftovers,
  holdsItems,
  leftoversMessage,
  resolveLeftover,
} from '#/lib/crash-leftovers';
import { notify } from '#/lib/notices';
import type { NoteType, SQLiteRepository } from '#/lib/types';
import {
  type App,
  ButtonComponent,
  Component,
  DropdownComponent,
  getFrontMatterInfo,
  MarkdownRenderer,
  Modal,
  setIcon,
  ToggleComponent,
} from 'obsidian';

/** A type a leftover can be saved as from the modal. */
export type SaveType = Extract<NoteType, 'article' | 'snippet'>;

/** What can be chosen for a leftover in a {@link LeftoverModal}. */
export type LeftoverChoice =
  | { action: 'adopt'; as: SaveType }
  | { action: 'trash' }
  | { action: 'strip' };

/**
 * The types a leftover can be saved as, in the order offered. No card: a card
 * needs a question and an answer laid out as one, which a note left over by
 * anything else won't have.
 */
const SAVE_TYPES: Readonly<Record<SaveType, string>> = {
  article: 'Article',
  snippet: 'Snippet',
};

/** What a row says when what was chosen for it could not be done. */
const FAILED: Readonly<Record<SaveType | 'trash' | 'strip', string>> = {
  article: "Couldn't save this note as an article.",
  snippet: "Couldn't save this note as a snippet.",
  trash: "Couldn't move this note to the trash.",
  strip: "Couldn't remove this note's incremental reading properties.",
};

/** The folder path of the note at `path`, `''` for the vault root. */
function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/**
 * One leftover's line in a {@link LeftoverModal}, and what is chosen on it.
 * A note made as a type it can be saved as starts with that type in its
 * "Save as…" dropdown and its "Keep as" toggle on, so Confirm saves it as
 * that unless the user changes it; any other starts with no type and the
 * toggle off, Confirm leaving it be. Turning the toggle off leaves a note be,
 * whatever type the dropdown shows; picking a type turns it on. The trash or
 * stripping, while pressed, stands in for keeping it, and taking either back
 * returns the line to the type and toggle it had before.
 */
interface Row {
  leftover: Leftover;
  el: HTMLElement;
  info: HTMLElement;
  /** The note's name, which opens and closes its preview. */
  name: HTMLElement;
  /** Where the note is previewed, just under the line; empty while closed. */
  preview: HTMLElement;
  /** The type in the line's dropdown, `null` while it shows none. */
  type: SaveType | null;
  /**
   * Whether the line's "Keep as" toggle is on, which it shows only while
   * the toggle can be (see {@link keepable}): picking a type turns it on.
   */
  kept: boolean;
  /** The trash or stripping, while pressed, in place of keeping the note. */
  other: 'trash' | 'strip' | null;
  /** Show what is chosen on the line's controls. */
  show: () => void;
  /** Turn every control on the line off, or back on. */
  setDisabled: (disabled: boolean) => void;
}

/** What Confirm does with `row`'s note, `null` for leaving it be. */
function choiceOf({ type, kept, other }: Row): LeftoverChoice | null {
  if (other) return { action: other };
  return kept && type ? { action: 'adopt', as: type } : null;
}

/**
 * Whether `row`'s "Keep as" toggle can be on: while its dropdown shows a
 * type, which it doesn't while the trash or stripping is pressed.
 */
const keepable = (row: Row) => row.type !== null && row.other === null;

/** A slider toggle that answers the user's flips only (see {@link userToggle}). */
interface UserToggle {
  readonly toggle: ToggleComponent;
  /** Show `on`, turned off if `disabled`, without answering it. */
  show(on: boolean, disabled: boolean): void;
}

/** Tells apart the ids {@link userToggle} gives its toggles' inputs. */
let toggleIds = 0;

/**
 * An Obsidian slider toggle appended to `parent`, then a label holding `text`
 * that flips it too, calling `onUser` when the user flips it. Its `setValue`
 * calls the `onChange` callback too, not only a click or key (read from
 * obsidian.asar), which would take showing a state worked out elsewhere for
 * the user's flip.
 */
function userToggle(
  parent: HTMLElement,
  text: { cls: string; text: string },
  onUser: (on: boolean) => void
): UserToggle {
  const toggle = new ToggleComponent(parent);
  // Obsidian's toggle is a label around a hidden checkbox, and a label can't
  // hold another, so the text's label points at that checkbox by id instead:
  // a click on the text clicks it, and its `change` flips the toggle. The
  // input isn't public API; markup read from obsidian.asar 1.14.5
  const input = toggle.toggleEl.querySelector('input');
  const label = createEl('label', { ...text, parent });
  if (input) {
    input.id = `ir-leftover-toggle-${++toggleIds}`;
    label.htmlFor = input.id;
  }
  let showing = false;
  toggle.onChange((on) => {
    if (!showing) onUser(on);
  });
  return {
    toggle,
    show(on, disabled) {
      showing = true;
      try {
        toggle.setValue(on);
      } finally {
        showing = false;
      }
      toggle.setDisabled(disabled);
      // Obsidian keeps a disabled toggle in the tab order, though its extra
      // buttons leave it (read from obsidian.asar); leave it, as a disabled
      // control would
      if (disabled) toggle.toggleEl.removeAttribute('tabindex');
      else toggle.toggleEl.tabIndex = 0;
    },
  };
}

/** A preview open in a {@link LeftoverModal}. */
interface OpenPreview {
  row: Row;
  /** Holds what the preview rendered, unloaded once it closes. */
  component: Component;
}

/**
 * Lists crash leftovers (see `crash-leftovers`), each with what can be done
 * with it, to choose for each: a type to save it as, the trash, or taking the
 * plugin's properties off it. Nothing is done until Confirm, which does what
 * was chosen for each note, one after the other, takes away the line of each
 * one done, and closes once none are left; a line whose choice failed stays,
 * saying so. Cancel, or closing it, leaves every note as it is, to be found
 * again from the review home screen (see {@link LeftoverWatch}).
 *
 * A note's name opens a read-only preview of it under its line, one at a
 * time, read afresh each time it opens.
 */
export class LeftoverModal extends Modal {
  readonly #leftovers: readonly Leftover[];
  readonly #resolve: (
    leftover: Leftover,
    choice: LeftoverChoice
  ) => Promise<boolean | LeftoverFailure>;
  #rows: Row[] = [];
  #buttonsEl: HTMLElement | null = null;
  /** The toggle that turns every line's "Keep as" toggle on or off. */
  #all: UserToggle | null = null;
  #confirm: ButtonComponent | null = null;
  /** Whether Confirm is under way. */
  #running = false;
  #closed = false;
  /** The preview open, if one is. */
  #open: OpenPreview | null = null;

  /**
   * @param resolve does what was chosen for a leftover, answering `true` once
   *   done; else `false`, or why it failed, which the line's tooltip says
   */
  constructor(
    app: App,
    leftovers: readonly Leftover[],
    resolve: (
      leftover: Leftover,
      choice: LeftoverChoice
    ) => Promise<boolean | LeftoverFailure>
  ) {
    super(app);
    this.#leftovers = leftovers;
    this.#resolve = resolve;
  }

  onOpen() {
    this.#closed = false;
    this.setTitle('Notes not found in the database');
    this.modalEl.classList.add('ir-leftover-modal');
    // Above the lines, at the end, over their own toggles
    this.#all = userToggle(
      createDiv({ cls: 'ir-leftover-all', parent: this.contentEl }),
      { cls: 'ir-leftover-all-text', text: 'Keep all' },
      (on) => this.#keepAll(on)
    );
    this.#rows = this.#leftovers.map((leftover) => this.#addRow(leftover));
    // In `modalEl`, below the content, where Obsidian puts its own
    const buttons = createDiv({
      cls: 'modal-button-container',
      parent: this.modalEl,
    });
    this.#buttonsEl = buttons;
    new ButtonComponent(buttons)
      .setButtonText('Cancel')
      .setClass('mod-cancel')
      .onClick(() => this.close());
    this.#confirm = new ButtonComponent(buttons)
      .setButtonText('Confirm')
      .setCta()
      .onClick(() => void this.#run());
    this.#update();
  }

  onClose() {
    this.#closed = true;
    this.#closePreview();
    this.contentEl.replaceChildren();
    this.#buttonsEl?.remove();
    this.#buttonsEl = null;
    this.#confirm = null;
    this.#all = null;
    this.#rows = [];
  }

  #addRow(leftover: Leftover): Row {
    const { file } = leftover;
    const el = createDiv({ cls: 'setting-item', parent: this.contentEl });
    const info = createDiv({ cls: 'setting-item-info', parent: el });
    const folder = folderOf(file.path);
    if (folder) {
      createDiv({
        cls: 'setting-item-description',
        text: folder,
        parent: info,
      });
    }
    // Labelled on the name, never the icon: an aria-label on an SVG crashes
    // Obsidian's tooltip handler
    const name = createDiv({
      cls: 'setting-item-name',
      attr: {
        role: 'button',
        tabindex: 0,
        'aria-expanded': 'false',
        'aria-label': `Preview ${file.basename}`,
      },
      parent: info,
    });
    setIcon(
      createSpan({ cls: 'ir-leftover-chevron', parent: name }),
      'chevron-right'
    );
    name.append(file.basename);
    const preview = createDiv({
      cls: ['ir-leftover-preview', 'markdown-rendered'],
      parent: this.contentEl,
    });
    preview.hidden = true;
    const controls = createDiv({ cls: 'setting-item-control', parent: el });

    // What the line starts with (see `Row`)
    const shown: SaveType | null =
      leftover.type === 'article' || leftover.type === 'snippet'
        ? leftover.type
        : null;
    const row: Row = {
      leftover,
      el,
      info,
      name,
      preview,
      type: shown,
      kept: true,
      other: null,
      show: () => {},
      setDisabled: () => {},
    };
    const changed = () => {
      row.show();
      this.#update();
    };
    const actions = actionsFor(leftover);
    /** Whether the line's controls are turned off. */
    let disabled = false;
    /** Show what is chosen on the line's "Keep as" toggle, if it has one. */
    let showBox = () => {};
    let dropdown: DropdownComponent | null = null;
    if (actions.includes('adopt')) {
      // In front of the dropdown, its label's text a click target too,
      // which a phone hides but for screen readers (see styles.css). Never
      // flipped while no type is shown, as the toggle is off then
      const box = userToggle(
        createDiv({ cls: 'ir-leftover-keep', parent: controls }),
        { cls: 'ir-leftover-keep-text', text: 'Keep as' },
        (on) => {
          row.kept = on;
          changed();
        }
      );
      showBox = () =>
        box.show(keepable(row) && row.kept, disabled || !keepable(row));
      dropdown = new DropdownComponent(controls)
        .addOption('', 'Save as…')
        .addOptions(SAVE_TYPES)
        .onChange((value) => {
          // The placeholder is no type, should a change ever land on it
          row.type = value in SAVE_TYPES ? (value as SaveType) : null;
          row.kept = true;
          row.other = null;
          changed();
        });
      // Shown while nothing is picked, but not one to pick
      dropdown.selectEl.options[0].disabled = true;
    }
    /** A button chosen while pressed, and taken back pressed again. */
    const toggle = (action: 'trash' | 'strip') =>
      new ButtonComponent(controls)
        .setClass('ir-leftover-toggle')
        .onClick(() => {
          row.other = row.other === action ? null : action;
          changed();
        });
    // Both labelled on the button, never the icon: an aria-label on an SVG
    // crashes Obsidian's tooltip handler
    const strip = actions.includes('strip')
      ? toggle('strip')
          .setClass('ir-leftover-strip')
          .setIcon('paintbrush')
          .setTooltip('Remove incremental reading properties')
      : null;
    const trash = actions.includes('trash')
      ? toggle('trash')
          .setIcon('trash-2')
          .setTooltip('Move to trash')
          .setDestructive()
      : null;

    row.show = () => {
      const { type, other } = row;
      dropdown?.setValue(other ? '' : (type ?? ''));
      showBox();
      for (const [button, action] of [
        [strip, 'strip'],
        [trash, 'trash'],
      ] as const) {
        if (!button) continue;
        const pressed = other === action;
        button.buttonEl.setAttribute('aria-pressed', String(pressed));
        // Obsidian's own fill: the accent, or red on the trash
        if (pressed) button.setCta();
        else button.removeCta();
      }
    };
    row.setDisabled = (off) => {
      disabled = off;
      dropdown?.setDisabled(off);
      strip?.setDisabled(off);
      trash?.setDisabled(off);
      row.show();
    };
    name.addEventListener('click', () => this.#togglePreview(row));
    name.addEventListener('keydown', (evt) => {
      if (evt.key !== 'Enter' && evt.key !== ' ') return;
      // Or Space scrolls the modal too
      evt.preventDefault();
      this.#togglePreview(row);
    });
    row.show();
    return row;
  }

  /** Open `row`'s preview, closing the one open; or close it, if it's that. */
  #togglePreview(row: Row) {
    const wasOpen = this.#open?.row === row;
    this.#closePreview();
    if (!wasOpen) void this.#openPreview(row);
  }

  /** Close the open preview, if there is one, unloading what it rendered. */
  #closePreview() {
    const open = this.#open;
    if (!open) return;
    this.#open = null;
    open.component.unload();
    open.row.preview.replaceChildren();
    open.row.preview.hidden = true;
    open.row.name.setAttribute('aria-expanded', 'false');
  }

  /**
   * Read `row`'s note, and render it, less its frontmatter, as the note
   * would: links and embeds resolve from the note's own path. A read that
   * ends once the preview has closed shows nothing.
   */
  async #openPreview(row: Row) {
    // Its own Component, not the modal: `Modal` isn't one, and
    // `MarkdownRenderer.render` logs a leak warning for anything that isn't
    // `instanceof Component` (undocumented, read from obsidian.asar)
    const component = new Component();
    component.load();
    const open: OpenPreview = { row, component };
    this.#open = open;
    row.preview.hidden = false;
    row.name.setAttribute('aria-expanded', 'true');
    const { file } = row.leftover;
    let text: string;
    try {
      text = await this.app.vault.cachedRead(file);
    } catch (error) {
      console.error(
        'Incremental Reading - failed to read a leftover note to preview:',
        error
      );
      if (this.#open === open) {
        createDiv({
          cls: 'ir-leftover-preview-error',
          text: "Couldn't read this note",
          parent: row.preview,
        });
      }
      return;
    }
    if (this.#open !== open) return;
    try {
      await MarkdownRenderer.render(
        this.app,
        text.slice(getFrontMatterInfo(text).contentStart),
        row.preview,
        file.path,
        component
      );
    } catch (error) {
      // What did render stays, short of what failed, an embed say
      console.error(
        'Incremental Reading - failed to render a leftover note to preview:',
        error
      );
    }
  }

  /**
   * Turn every line's "Keep as" toggle that can be on, or off, as `keep` says:
   * the toggle over the lines, flipped. A line with no type, or with the trash
   * or stripping pressed, is left as it is.
   */
  #keepAll(keep: boolean) {
    const rows = this.#rows.filter(keepable);
    for (const row of rows) {
      row.kept = keep;
      row.show();
    }
    this.#update();
  }

  /**
   * Confirm is on while something is chosen and nothing is under way. The
   * toggle over the lines is on while every "Keep as" toggle that can be is,
   * so flipping it with only some on turns the rest on; it is turned off
   * while none can be, or something is under way.
   */
  #update() {
    const rows = this.#rows.filter(keepable);
    this.#all?.show(
      rows.length > 0 && rows.every((row) => row.kept),
      this.#running || rows.length === 0
    );
    this.#confirm?.setDisabled(
      this.#running || !this.#rows.some((row) => choiceOf(row))
    );
  }

  /**
   * Do what was chosen for each line, in order, as Confirm says to: on only
   * while something is chosen and nothing is under way (see {@link #update}).
   */
  async #run() {
    const chosen = this.#rows.filter((row) => choiceOf(row));
    this.#running = true;
    this.#update();
    for (const row of this.#rows) row.setDisabled(true);
    for (const row of chosen) {
      // Closing stops what isn't under way yet
      if (this.#closed) break;
      const choice = choiceOf(row)!;
      row.info.querySelector('.ir-leftover-error')?.remove();
      let outcome: boolean | LeftoverFailure;
      try {
        outcome = await this.#resolve(row.leftover, choice);
      } catch (error) {
        // Failed, as one answering why did, or the run would stop here with
        // every control off
        console.error(
          'Incremental Reading - failed to resolve a leftover note:',
          error
        );
        outcome = failureOf(error);
      }
      if (outcome === true) {
        if (this.#open?.row === row) this.#closePreview();
        row.el.remove();
        row.preview.remove();
        this.#rows = this.#rows.filter((r) => r !== row);
      } else {
        // Why, in the tooltip Obsidian draws from aria-label: on this HTML
        // line, as one on an SVG crashes its tooltip handler
        const why = outcome ? failureDetail(outcome) : '';
        createDiv({
          cls: 'ir-leftover-error',
          text: FAILED[choice.action === 'adopt' ? choice.as : choice.action],
          attr: why ? { 'aria-label': why } : {},
          parent: row.info,
        });
      }
    }
    this.#running = false;
    if (this.#closed) return;
    for (const row of this.#rows) row.setDisabled(false);
    this.#update();
    if (this.#rows.length === 0) this.close();
  }
}

/** What a {@link LeftoverWatch} needs. */
export interface LeftoverWatchDeps {
  app: App;
  repo: SQLiteRepository;
  /** The item managers, asked for only once something is chosen. */
  managers: () => Pick<LeftoverDeps, 'articles' | 'snippets' | 'cards'>;
  /** Told once a leftover is resolved, for what shows items to be refreshed. */
  onResolved: () => unknown;
  /** Whether a review tab is open, its view loaded. */
  isReviewOpen: () => boolean;
}

/**
 * Keeps track of the crash leftovers (see `crash-leftovers`) and asks the user
 * about them: once per load, in one notice that waits for review to be in
 * front, and on request from the review home screen. Nothing is done to any
 * note unless the user chooses it in a {@link LeftoverModal}.
 *
 * The notice waits for review because the startup scan ends while Obsidian
 * is still laying itself out, when a notice that stays up would sit over the
 * right sidebar, or over the settings on a phone.
 */
export class LeftoverWatch {
  readonly deps: LeftoverWatchDeps;
  #current: readonly Leftover[] = [];
  readonly #listeners = new Set<() => void>();
  /** Whether the startup scan is done, which the notice waits for. */
  #scanned = false;
  /** Whether the notice had its one chance this load. */
  #announced = false;
  /** The {@link manage} under way, if one is. */
  #managing: Promise<void> | null = null;

  constructor(deps: LeftoverWatchDeps) {
    this.deps = deps;
  }

  /**
   * The leftovers the last look found, less those resolved since: a new array
   * each time they change, as `useSyncExternalStore` reads a snapshot.
   */
  get current(): readonly Leftover[] {
    return this.#current;
  }

  /** Hear of each change to {@link current}; returns the unsubscribe. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /**
   * Look for leftovers once startup has pointed every row it could at its
   * note, and show the notice if a review tab is open by then.
   */
  async startupScan(): Promise<void> {
    await this.#look();
    this.#scanned = true;
    if (this.deps.isReviewOpen()) this.#announce();
  }

  /** Told by each review tab as it opens, which shows the notice if due. */
  reviewOpened(): void {
    if (this.#scanned) this.#announce();
  }

  /**
   * Look again, and open what is found to choose from; if nothing is, or
   * the look fails, say so instead. Asked again before the look ends, it
   * waits on that one, so a double tap opens one modal.
   */
  manage(): Promise<void> {
    this.#managing ??= this.#manage().finally(() => {
      this.#managing = null;
    });
    return this.#managing;
  }

  async #manage(): Promise<void> {
    if (!(await this.#look())) {
      notify(
        "Incremental reading: couldn't look for notes missing from the database.",
        { kind: 'error' }
      );
      return;
    }
    if (this.#current.length === 0) {
      notify('Incremental reading: no notes are missing from the database.');
      return;
    }
    const { app, repo, managers, onResolved } = this.deps;
    new LeftoverModal(app, this.#current, async (leftover, choice) => {
      const outcome = await resolveLeftover(
        { app, repo, ...managers() },
        leftover,
        choice.action,
        choice.action === 'adopt' ? choice.as : undefined
      );
      if (!outcome.done) return outcome.failure ?? false;
      this.#set(this.#current.filter((left) => left !== leftover));
      await onResolved();
      return true;
    }).open();
  }

  /**
   * Find the leftovers into {@link current}. A failed look is logged, and
   * leaves what was found before.
   * @returns whether it could look
   */
  async #look(): Promise<boolean> {
    const { app, repo } = this.deps;
    try {
      // A database with no items at all is one Sync may not have brought down
      // yet, while the notes it brought read as leftovers. Until 0081 holds
      // startup for it, those are not asked about.
      const found = (await holdsItems(repo))
        ? await findLeftovers({ app, repo })
        : [];
      this.#set(found);
      return true;
    } catch (error) {
      console.error(
        'Incremental Reading - failed to look for notes left without review data:',
        error
      );
      return false;
    }
  }

  #set(leftovers: readonly Leftover[]): void {
    this.#current = leftovers;
    for (const listener of this.#listeners) listener();
  }

  /**
   * Show the notice, if this load hasn't had it yet and there are leftovers:
   * one that stays up, counting them, with a button to {@link manage} them.
   * A click anywhere else on it only hides it.
   */
  #announce(): void {
    if (this.#announced) return;
    this.#announced = true;
    if (this.#current.length === 0) return;
    notify(leftoversMessage(this.#current), {
      persist: true,
      action: { label: 'Manage', onClick: () => void this.manage() },
    });
  }
}
