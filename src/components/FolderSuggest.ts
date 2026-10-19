import { inDataDirectory } from '#/lib/bulk-import/candidates';
import { AbstractInputSuggest, type App, type TFolder } from 'obsidian';

/** The vault root's path, which is how it reads in the list. */
const ROOT_PATH = '/';

/** Which folders a {@link FolderSuggest} offers, beyond what is typed. */
export interface FolderSuggestOptions {
  /** Offer the vault root (`/`), first. On unless turned off. */
  includeRoot?: boolean;
  /** Folders not to offer, by path, asked each time the list is drawn. */
  exclude?: (path: string) => boolean;
}

/**
 * Suggestions of folders under a text input, by path: each folder whose path
 * holds what is typed, any case, the vault root (`/`) first and the rest in
 * path order. Nothing in the data directory is offered, since nothing in it
 * can be imported, nor anything `options` leaves out.
 *
 * Picking one only calls the `onSelect` callback, as Obsidian's popup does:
 * filling the input and closing the popup is the caller's to do.
 */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
  private readonly options: FolderSuggestOptions;

  constructor(
    app: App,
    inputEl: HTMLInputElement,
    options: FolderSuggestOptions = {}
  ) {
    super(app, inputEl);
    this.options = options;
  }

  getSuggestions(query: string): TFolder[] {
    const { includeRoot = true, exclude } = this.options;
    const needle = query.trim().toLowerCase();
    return this.app.vault
      .getAllFolders(includeRoot)
      .filter(
        (folder) =>
          !inDataDirectory(folder.path) &&
          folder.path.toLowerCase().includes(needle) &&
          exclude?.(folder.path) !== true
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
