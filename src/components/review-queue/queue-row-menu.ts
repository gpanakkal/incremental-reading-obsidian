import type { QueueRow } from '#/components/types';
import { CONTENT_TITLE_SLICE_LENGTH } from '#/lib/constants';
import { deleteMissingItem } from '#/lib/delete-missing-item';
import { findArticleSource, findContextFile } from '#/lib/item-context';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { tableOf } from '#/lib/relink';
import { addRevealInNavigationItem } from '#/lib/reveal-in-navigation';
import { isReviewArticle, isReviewText, type ReviewItem } from '#/lib/types';
import { unimportArticle } from '#/lib/unimport-article';
import { getContentSlice } from '#/lib/utils';
import type IncrementalReadingPlugin from '#/main';
import { openRelinkPicker } from '#/views/RelinkModal';
import { SchedulingModal } from '#/views/SchedulingModal';
import { Keymap, Menu, type TFile } from 'obsidian';

/**
 * The row menu's groups, top to bottom. Obsidian sorts entries into their
 * sections in this order, whatever order they were added in, and draws a
 * separator between sections. (`Menu.addSections` is undocumented: typed by
 * obsidian-typings, behaviour read from `Menu.prototype` in obsidian.asar
 * 1.13. `setSection` alone is public.)
 */
export const QUEUE_ROW_MENU_SECTIONS = ['open', 'schedule', 'file', 'danger'];

/**
 * The menu for one queue row: what the review tab offers for an item on its
 * action bar and ⋮ menu, so items can be managed without opening them. Each
 * entry calls what its twin there calls, notices and undo included, and
 * entries that don't apply to a row are left out. The table refreshes itself
 * after each: they all write through the repository, whose data change events
 * `applyQueueChange` patches the cached pages from.
 *
 * Left out: review's own steps (mark reviewed, skip, extract, grade), which
 * act on the item on screen and move review on; and undismissing, as the
 * queue holds no dismissed rows.
 *
 * "Relink file…" is offered on every row so the menu reads the same
 * throughout, but only a row missing its file can take it. "Permanently
 * delete" is offered only there: a row with its note is deleted by deleting
 * the note, which "Delete" does. "Un-import article…" is offered on an article
 * row with its file, and does what the file menu's entry does.
 */
export function queueRowMenu(
  plugin: IncrementalReadingPlugin,
  row: QueueRow
): Menu {
  const menu = new Menu().addSections(QUEUE_ROW_MENU_SECTIONS);
  const { file } = row;

  if (file !== null) {
    // The review tab ⋮ menu's entry
    menu.addItem((item) =>
      item
        .setTitle('Open in new tab')
        .setIcon('lucide-file-plus')
        .setSection('open')
        .onClick(() => {
          void openInNewTab(plugin, file);
        })
    );
    if (row.parent !== null) {
      // TODO(0195): its parent/source resolver replaces this one once landed
      menu.addItem((item) =>
        item
          .setTitle('Open parent/source in new tab')
          .setIcon('lucide-corner-left-up')
          .setSection('open')
          .onClick(() => {
            void openOrigin(plugin, row);
          })
      );
    }
    if (row.type !== 'article') {
      // The review tab ⋮ menu's entry, for the items with a parent; an
      // article's source is 0188's "Go to source", below
      menu.addItem((item) =>
        item
          .setTitle('Go to context')
          .setIcon('lucide-locate')
          .setSection('open')
          .onClick((evt) => {
            void plugin.actions.goToContext(file, Keymap.isModEvent(evt));
          })
      );
    }
    // TODO(0188): "Go to source" slots in here, for any row with a source,
    // titled and guarded as 0188 offers it elsewhere
    // The file explorer's `file-menu` entry, which this menu doesn't trigger
    addRevealInNavigationItem(menu, plugin.app, file, 'open');
  }

  if (file !== null && row.type !== 'card') {
    // The action bar's scheduling button; its modal sets the priority too
    menu.addItem((item) =>
      item
        .setTitle('Change scheduling…')
        .setIcon('lucide-calendar-sync')
        .setSection('schedule')
        .onClick(() => {
          void openScheduling(plugin, row);
        })
    );
  }
  // The action bar's dismiss button, which a missing item keeps too
  menu.addItem((item) =>
    item
      .setTitle('Dismiss')
      .setIcon('lucide-ban')
      .setSection('schedule')
      .onClick(() => {
        void dismiss(plugin, row);
      })
  );

  menu.addItem((item) =>
    item
      .setTitle('Relink file…')
      .setIcon('link')
      .setSection('file')
      .setDisabled(file !== null)
      .onClick(() => {
        void openRelinkPicker(plugin, {
          table: tableOf(row.type),
          id: row.id,
          reference: row.reference,
        });
      })
  );

  if (file === null) {
    menu.addItem((item) =>
      item
        .setTitle('Permanently delete')
        .setIcon('trash-2')
        .setSection('danger')
        .setWarning(true)
        .onClick(() => {
          void deleteMissingItem(plugin, row);
        })
    );
  } else {
    // The review tab ⋮ menu's entry
    menu.addItem((item) =>
      item
        .setTitle('Delete')
        .setIcon('lucide-trash-2')
        .setSection('danger')
        .setWarning(true)
        .onClick(() => {
          void plugin.app.fileManager.promptForDeletion(file);
        })
    );
    if (row.type === 'article') {
      menu.addItem((item) =>
        item
          .setTitle('Un-import article')
          .setIcon('file-x')
          .setSection('danger')
          .setWarning(true)
          .onClick(() => {
            void unimportArticle(plugin, file);
          })
      );
    }
  }
  return menu;
}

/** As the review tab ⋮ menu's "Open in new tab" opens its item. */
async function openInNewTab(plugin: IncrementalReadingPlugin, file: TFile) {
  await plugin.app.workspace.getLeaf('tab').openFile(file, { active: true });
}

/**
 * The row's note name, cut short for a notice; a missing row's reference, as
 * its "Permanently delete" names it.
 */
function rowTitle(row: QueueRow): string {
  const name = row.file?.basename ?? row.reference;
  return getContentSlice(name, CONTENT_TITLE_SLICE_LENGTH, true);
}

/**
 * An entry was picked on a row whose item is gone since the page was read:
 * deleted, here or on another device, or (for an entry needing its note)
 * left without one. The table catches up on its own.
 */
function notifyGone(row: QueueRow) {
  Obsidian.notify(`Couldn't find "${rowTitle(row)}"; it may have been deleted`);
}

/**
 * The note `item` came from: an article's source, or a snippet's or card's
 * parent, failing that its source. Null when it has none in the vault.
 */
async function findItemOrigin(
  plugin: IncrementalReadingPlugin,
  item: ReviewItem
): Promise<TFile | null> {
  const { app, reviewManager } = plugin;
  if (isReviewArticle(item)) return findArticleSource(app, item).file;
  return findContextFile(app, reviewManager, item);
}

/**
 * The items below are read when the entry is picked, not when the menu was
 * built: the page can be a minute old, and each acts on the item as it is now.
 */
async function openOrigin(plugin: IncrementalReadingPlugin, row: QueueRow) {
  const item = await plugin.reviewManager.getReviewItemFromId(row.id);
  if (!item) {
    notifyGone(row);
    return;
  }
  const origin = await findItemOrigin(plugin, item);
  if (origin === null) {
    Obsidian.notify(`"${rowTitle(row)}" has no parent or local source to open`);
    return;
  }
  await openInNewTab(plugin, origin);
}

async function openScheduling(plugin: IncrementalReadingPlugin, row: QueueRow) {
  const item = await plugin.reviewManager.getReviewItemFromId(row.id);
  if (!item) notifyGone(row);
  else if (isReviewText(item)) new SchedulingModal(plugin, item).open();
}

async function dismiss(plugin: IncrementalReadingPlugin, row: QueueRow) {
  const item = await plugin.reviewManager.getItemOrMissingFromId(row.id);
  if (!item) notifyGone(row);
  else await plugin.actions.dismissItem(item);
}
