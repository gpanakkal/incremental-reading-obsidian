import { appendItemLabel } from '#/lib/item-label';
import type { ItemChild } from '#/lib/items/item-children';
import type { UiOrigin } from '#/lib/ui-window';
import type { App } from 'obsidian';
import { promptForChoice } from './ConfirmModal';

/** What an undo removes that has children: see {@link promptForChildren}. */
export interface RemovedItems {
  readonly kind: 'article' | 'snippet' | 'card';
  /** The title of each, one or more. */
  readonly titles: readonly string[];
}

/**
 * What to do with the children of what an undo removes: leave them in the
 * queue, moved up a level (`keep`), remove them with it (`remove`), or undo
 * nothing (`cancel`).
 */
export type ChildrenChoice = 'keep' | 'remove' | 'cancel';

/**
 * Ask what an undo of `description`, about to remove `removing`, should do
 * with the snippets and cards under it, `children`, as `childrenOf` lists
 * them: keep them, the default, remove them too, or cancel. Each child is
 * named on a row of its own, shallowest first, with its type's icon.
 * @param origin what it was asked for from (see `uiWindow`)
 * @returns what was chosen; closing the modal any other way, Escape say,
 *   answers `cancel`
 */
export async function promptForChildren(
  app: App,
  {
    description,
    removing,
    children,
  }: {
    description: string;
    removing: RemovedItems;
    children: readonly ItemChild[];
  },
  origin?: UiOrigin
): Promise<ChildrenChoice> {
  const { kind, titles } = removing;
  const lead =
    titles.length === 1
      ? `This ${kind} has the following child items:`
      : `These ${kind}s have the following child items:`;
  const choice = await promptForChoice(
    app,
    {
      title: `Undo ${description}?`,
      paragraphs: [lead, (el) => listChildren(el, children)],
      confirmText: 'Undo but keep child items',
      alternative: { text: 'Undo and remove child items', destructive: true },
    },
    origin
  );
  return choice === 'confirm'
    ? 'keep'
    : choice === 'alternative'
      ? 'remove'
      : 'cancel';
}

/**
 * List `children` under `parent`, a row each, as the queue names them.
 * `childrenOf` lists them deepest first, the order they are removed in;
 * read top down, the tree reads better from the top, so they are shown the
 * other way round, leaving the list itself as it was given.
 */
function listChildren(parent: HTMLElement, children: readonly ItemChild[]) {
  const list = parent.createEl('ul', { cls: 'ir-children-list' });
  for (const child of [...children].reverse()) {
    const row = list.createEl('li', {
      cls: child.trashed
        ? ['ir-children-row', 'is-trashed']
        : 'ir-children-row',
    });
    appendItemLabel(row, child.reference, child.table);
    if (child.trashed) {
      row.createSpan({ cls: 'ir-children-trashed', text: 'in the trash' });
    }
  }
}
