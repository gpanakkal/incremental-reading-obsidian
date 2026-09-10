import type IncrementalReadingPlugin from '#/main';
import ReviewView from '#/views/ReviewView';
import { Keymap } from 'obsidian';

/**
 * The file explorer row for the workspace's active file. The explorer's
 * `file-open` handler toggles `is-active` on the row element, and the same
 * element carries `data-path` from when its title was rendered.
 */
const ACTIVE_NAV_FILE_SELECTOR = '.nav-file-title.is-active';

/**
 * Open the note under review in a new tab when it is left-clicked in the file
 * explorer.
 *
 * Obsidian swallows a plain left click on the explorer row it has marked
 * `is-active`: its selection handler refocuses the explorer and returns without
 * opening anything, on the assumption that the active file is already on screen
 * in the active tab. {@link ReviewView} is a `FileView` holding the item under
 * review in `file`, which makes that item the workspace's active file — so the
 * row is marked active while the review tab shows the item as review material,
 * not as a note, and the click looks dead.
 *
 * The path is read from `data-path` rather than from the active file, so the
 * check is against the row that was actually clicked. `getActiveFileView` is
 * what decides whether this plugin is the reason the row is active: it falls
 * back to the most recently active navigable leaf, so it still names the review
 * view once the click has moved focus to the explorer, and it returns a
 * `MarkdownView` instead when an ordinary tab is the one holding the file open.
 *
 * Registered in the capture phase because the swallow can only be prevented
 * before the event reaches the row's own handler.
 */
export function registerFileExplorerActiveFileClick(
  plugin: IncrementalReadingPlugin
): void {
  plugin.registerDomEvent(
    document,
    'click',
    (evt: MouseEvent) => {
      // Mod-click already opens a tab; Alt and Shift are the explorer's
      // multi-select gestures. None of those reach the swallow.
      if (evt.button !== 0) return;
      if (evt.altKey || evt.shiftKey || Keymap.isModEvent(evt)) return;

      const path = activeNavFilePath(evt.target);
      if (!path) return;

      const activeFileView = plugin.app.workspace.getActiveFileView();
      if (!(activeFileView instanceof ReviewView)) return;
      if (activeFileView.file?.path !== path) return;

      const file = plugin.app.vault.getFileByPath(path);
      if (!file) return;

      evt.preventDefault();
      evt.stopPropagation();
      // Focused, because this stands in for a plain click — Obsidian's own
      // plain-click path focuses what it opens, and `focusNewTab` governs
      // mod-click background tabs rather than this.
      void plugin.app.workspace.getLeaf('tab').openFile(file, { active: true });
    },
    { capture: true }
  );
}

/** The vault path of the active explorer row containing `target`, if any. */
function activeNavFilePath(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const rowEl = target.closest(ACTIVE_NAV_FILE_SELECTOR);
  return rowEl?.getAttribute('data-path') || null;
}
