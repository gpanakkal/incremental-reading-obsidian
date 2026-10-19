import { inDataDirectory } from '#/lib/bulk-import/candidates';
import { AbstractInputSuggest, type TFolder } from 'obsidian';

/** The vault root's path, which is how it reads in the list. */
const ROOT_PATH = '/';

/**
 * Suggestions of folders under a text input, by path: each folder whose path
 * holds what is typed, any case, the vault root (`/`) first and the rest in
 * path order. Nothing in the data directory is offered, since nothing in it
 * can be imported.
 *
 * Picking one only calls the `onSelect` callback, as Obsidian's popup does:
 * filling the input and closing the popup is the caller's to do.
 */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
  getSuggestions(query: string): TFolder[] {
    const needle = query.trim().toLowerCase();
    return this.app.vault
      .getAllFolders(true)
      .filter(
        (folder) =>
          !inDataDirectory(folder.path) &&
          folder.path.toLowerCase().includes(needle)
      )
      .sort(
        (a, b) =>
          Number(b.path === ROOT_PATH) - Number(a.path === ROOT_PATH) ||
          a.path.localeCompare(b.path)
      );
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.textContent = folder.path;
  }
}
