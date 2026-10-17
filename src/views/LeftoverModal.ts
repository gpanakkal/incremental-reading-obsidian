import {
  type Leftover,
  type LeftoverDeps,
  actionsFor,
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
  strip: "Couldn't remove this note's IR properties.",
};

/** The folder path of the note at `path`, `''` for the vault root. */
function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/**
 * One leftover's line in a {@link LeftoverModal}, and what is chosen on it.
 * A note made as a type it can be saved as starts with that type chosen, and
 * shown in its "Save as…" dropdown, so Confirm saves it as that unless the
 * user changes it; any other starts with nothing chosen, Confirm leaving it
 * be. Taking back the trash or stripping returns a line to how it started.
 */
interface Row {
  leftover: Leftover;
  el: HTMLElement;
  info: HTMLElement;
  /** The note's name, which opens and closes its preview. */
  name: HTMLElement;
  /** Where the note is previewed, just under the line; empty while closed. */
  preview: HTMLElement;
  /** What is chosen for the line, `null` for leaving it be. */
  choice: LeftoverChoice | null;
  /** Show what is chosen on the line's controls. */
  show: () => void;
  /** Turn every control on the line off, or back on. */
  setDisabled: (disabled: boolean) => void;
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
  ) => Promise<boolean>;
  #rows: Row[] = [];
  #buttonsEl: HTMLElement | null = null;
  #confirm: ButtonComponent | null = null;
  /** Whether Confirm is under way. */
  #running = false;
  #closed = false;
  /** The preview open, if one is. */
  #open: OpenPreview | null = null;

  /**
   * @param resolve does what was chosen for a leftover, answering whether it
   *   was done
   */
  constructor(
    app: App,
    leftovers: readonly Leftover[],
    resolve: (leftover: Leftover, choice: LeftoverChoice) => Promise<boolean>
  ) {
    super(app);
    this.#leftovers = leftovers;
    this.#resolve = resolve;
  }

  onOpen() {
    this.#closed = false;
    this.setTitle('Notes not found in the database');
    this.modalEl.classList.add('ir-leftover-modal');
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
    const initial: LeftoverChoice | null = shown
      ? { action: 'adopt', as: shown }
      : null;
    const row: Row = {
      leftover,
      el,
      info,
      name,
      preview,
      choice: initial,
      show: () => {},
      setDisabled: () => {},
    };
    const choose = (choice: LeftoverChoice | null) => {
      row.choice = choice;
      row.show();
      this.#update();
    };
    const actions = actionsFor(leftover);
    const dropdown = actions.includes('adopt')
      ? new DropdownComponent(controls)
          .addOption('', 'Save as…')
          .addOptions(SAVE_TYPES)
          .onChange((value) =>
            choose(
              value in SAVE_TYPES
                ? { action: 'adopt', as: value as SaveType }
                : null
            )
          )
      : null;
    // Shown while nothing is picked, but not one to pick
    if (dropdown) dropdown.selectEl.options[0].disabled = true;
    /** A button chosen while pressed, and taken back pressed again. */
    const toggle = (action: 'trash' | 'strip') =>
      new ButtonComponent(controls)
        .setClass('ir-leftover-toggle')
        .onClick(() =>
          choose(row.choice?.action === action ? initial : { action })
        );
    const strip = actions.includes('strip')
      ? toggle('strip').setButtonText('Remove IR properties')
      : null;
    // Labelled on the button, never the icon: an aria-label on an SVG crashes
    // Obsidian's tooltip handler
    const trash = actions.includes('trash')
      ? toggle('trash')
          .setIcon('trash-2')
          .setTooltip('Move to trash')
          .setDestructive()
      : null;

    row.show = () => {
      const { choice } = row;
      dropdown?.setValue(choice?.action === 'adopt' ? choice.as : '');
      for (const [button, action] of [
        [strip, 'strip'],
        [trash, 'trash'],
      ] as const) {
        if (!button) continue;
        const pressed = choice?.action === action;
        button.buttonEl.setAttribute('aria-pressed', String(pressed));
        // Obsidian's own fill: the accent, or red on the trash
        if (pressed) button.setCta();
        else button.removeCta();
      }
    };
    row.setDisabled = (disabled) => {
      dropdown?.setDisabled(disabled);
      strip?.setDisabled(disabled);
      trash?.setDisabled(disabled);
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

  /** Confirm is on while something is chosen and nothing is under way. */
  #update() {
    this.#confirm?.setDisabled(
      this.#running || !this.#rows.some((row) => row.choice)
    );
  }

  /**
   * Do what was chosen for each line, in order, as Confirm says to: on only
   * while something is chosen and nothing is under way (see {@link #update}).
   */
  async #run() {
    const chosen = this.#rows.filter((row) => row.choice);
    this.#running = true;
    this.#update();
    for (const row of this.#rows) row.setDisabled(true);
    for (const row of chosen) {
      // Closing stops what isn't under way yet
      if (this.#closed) break;
      const choice = row.choice!;
      row.info.querySelector('.ir-leftover-error')?.remove();
      let done = false;
      try {
        done = await this.#resolve(row.leftover, choice);
      } catch (error) {
        // Failed, as one answering `false` did, or the run would stop here
        // with every control off
        console.error(
          'Incremental Reading - failed to resolve a leftover note:',
          error
        );
      }
      if (done) {
        if (this.#open?.row === row) this.#closePreview();
        row.el.remove();
        row.preview.remove();
        this.#rows = this.#rows.filter((r) => r !== row);
      } else {
        createDiv({
          cls: 'ir-leftover-error',
          text: FAILED[choice.action === 'adopt' ? choice.as : choice.action],
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
      const done = await resolveLeftover(
        { app, repo, ...managers() },
        leftover,
        choice.action,
        choice.action === 'adopt' ? choice.as : undefined
      );
      if (done) {
        this.#set(this.#current.filter((left) => left !== leftover));
        await onResolved();
      }
      return done;
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
