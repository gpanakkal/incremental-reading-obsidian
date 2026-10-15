import {
  type Leftover,
  type LeftoverAction,
  type LeftoverDeps,
  actionsFor,
  findLeftovers,
  holdsItems,
  leftoversMessage,
  resolveLeftover,
} from '#/lib/crash-leftovers';
import type { SQLiteRepository } from '#/lib/types';
import { type App, ButtonComponent, Modal, Notice } from 'obsidian';

/** What each action's button says. */
export const ACTION_LABELS: Readonly<Record<LeftoverAction, string>> = {
  adopt: 'Keep as item',
  trash: 'Move to trash',
  strip: 'Remove item properties',
};

/**
 * Lists crash leftovers (see `crash-leftovers`), each with what can be done
 * with it, for the user to choose one by one. A note's line goes once what was
 * chosen for it is done, and the modal closes once none are left. Closing it
 * leaves the rest as they are, to be asked about again at the next start.
 */
export class LeftoverModal extends Modal {
  readonly #leftovers: readonly Leftover[];
  readonly #resolve: (
    leftover: Leftover,
    action: LeftoverAction
  ) => Promise<boolean>;
  #left = 0;

  /**
   * @param resolve does what was chosen for a leftover, answering whether it
   *   was done
   */
  constructor(
    app: App,
    leftovers: readonly Leftover[],
    resolve: (leftover: Leftover, action: LeftoverAction) => Promise<boolean>
  ) {
    super(app);
    this.#leftovers = leftovers;
    this.#resolve = resolve;
  }

  onOpen() {
    this.setTitle('Notes left without review data');
    createEl('p', {
      text:
        'These notes have an item id but no review data, likely because an ' +
        'action was cut short. Keep each as an item, or let it go.',
      parent: this.contentEl,
    });
    this.#left = this.#leftovers.length;
    for (const leftover of this.#leftovers) {
      const row = createDiv({ cls: 'setting-item', parent: this.contentEl });
      const info = createDiv({ cls: 'setting-item-info', parent: row });
      createDiv({
        cls: 'setting-item-name',
        text: leftover.file.basename,
        parent: info,
      });
      createDiv({
        cls: 'setting-item-description',
        text: leftover.file.path,
        parent: info,
      });
      const controls = createDiv({ cls: 'setting-item-control', parent: row });
      const buttons = actionsFor(leftover).map((action) => {
        const button = new ButtonComponent(controls)
          .setButtonText(ACTION_LABELS[action])
          .onClick(async () => {
            for (const b of buttons) b.buttonEl.disabled = true;
            const done = await this.#resolve(leftover, action);
            if (!done) {
              for (const b of buttons) b.buttonEl.disabled = false;
              return;
            }
            row.remove();
            this.#left -= 1;
            if (this.#left === 0) this.close();
          });
        if (action === 'trash') button.setWarning();
        return button;
      });
    }
  }

  onClose() {
    this.contentEl.replaceChildren();
  }
}

/**
 * Look for crash leftovers (see `crash-leftovers`), and when there are any,
 * list them in one notice that stays up until it is clicked or closed; a
 * click opens a {@link LeftoverModal} on them. Nothing is done to any note
 * unless the user chooses it there. A failed look is logged and says nothing.
 * @param managers the item managers, asked for only once something is chosen
 * @param onResolved told once a leftover is resolved, for what shows items to
 *   be refreshed
 * @param createNotice opens the notice: by default, one that stays up
 */
export async function flagLeftovers({
  app,
  repo,
  managers,
  onResolved,
  createNotice = (message) => new Notice(message, 0),
}: {
  app: App;
  repo: SQLiteRepository;
  managers: () => Pick<LeftoverDeps, 'articles' | 'snippets' | 'cards'>;
  onResolved: () => unknown;
  createNotice?: (message: string) => { containerEl: HTMLElement };
}): Promise<void> {
  let leftovers: Leftover[];
  try {
    // A database with no items at all is one Sync may not have brought down
    // yet, while the notes it brought read as leftovers. Until 0081 holds
    // startup for it, those are not asked about.
    if (!(await holdsItems(repo))) return;
    leftovers = await findLeftovers({ app, repo });
  } catch (error) {
    console.error(
      'Incremental Reading - failed to look for notes left without review data:',
      error
    );
    return;
  }
  if (leftovers.length === 0) return;
  const notice = createNotice(leftoversMessage(leftovers));
  // Obsidian hides a notice once it is clicked (read from obsidian.asar)
  notice.containerEl.addEventListener('click', () => {
    new LeftoverModal(app, leftovers, async (leftover, action) => {
      const done = await resolveLeftover(
        { app, repo, ...managers() },
        leftover,
        action
      );
      if (done) await onResolved();
      return done;
    }).open();
  });
}
