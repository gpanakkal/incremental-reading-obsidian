import {
  FilteredBulkImport,
  folderFilter,
} from '#/components/BulkImportFilterBar';
import { BulkImportModalContent } from '#/components/BulkImportModalContent';
import { searchFilter } from '#/components/SearchFilter';
import { tagFilter } from '#/components/TagFilter';
import { importChosen, unimportChosen } from '#/lib/bulk-import/run-import';
import type {
  BulkImportOptions,
  BulkMode,
  CandidateSource,
  FilterSources,
} from '#/lib/bulk-import/types';
import { refreshAfterUnimport } from '#/lib/unimport-article';
import { getVaultSearch, loadSearchEngine } from '#/lib/vault-search';
import type IncrementalReadingPlugin from '#/main';
import { Modal, type TFile } from 'obsidian';
import { render } from 'preact';
import { promptForConfirmation } from './ConfirmModal';

/**
 * What a bulk modal is opened on: where its files come from, or a filter bar
 * for the user to say (`filterBar`), and what it does with them, `mode`. A
 * source for an un-import lists only what it can un-import (see
 * `unimportChecks`), and the filter bar's sources are made for the mode.
 */
export type BulkImportRequest =
  | { source: CandidateSource; mode: BulkMode; filterBar?: false }
  | { filterBar: true; mode: BulkMode; source?: undefined };

/**
 * The one dialog for importing many files at once: shared import options over
 * a checklist of the files its source finds, filled in as they are found. The
 * scan stops when the dialog closes. Confirming closes it, then imports the
 * ticked files and says once how that went (see `importChosen`).
 *
 * Opened to un-import, it lists articles, with no options, and confirming asks
 * first, the review history going for good: once the user agrees, it closes
 * and un-imports them (see `unimportChosen`); answering no leaves it open as
 * it was.
 */
export class BulkImportModal extends Modal {
  readonly plugin: IncrementalReadingPlugin;
  readonly request: BulkImportRequest;
  /**
   * Settles once the dialog has closed, however it was closed, and the import
   * it started (if any) has finished.
   */
  readonly closed: Promise<void>;
  private settleClosed!: () => void;
  /**
   * The import or un-import started by confirming, if any, or the question an
   * un-import asks first while it is open. There is one per dialog.
   */
  private importing: Promise<unknown> | null = null;
  /** Whether the dialog has closed, after which nothing is drawn in it. */
  private shut = false;

  constructor(plugin: IncrementalReadingPlugin, request: BulkImportRequest) {
    super(plugin.app);
    this.plugin = plugin;
    this.request = request;
    this.closed = new Promise((resolve) => {
      this.settleClosed = resolve;
    });
  }

  /** Import or un-import `files`, from what `from` names, as the mode says. */
  private confirm(files: TFile[], options: BulkImportOptions, from: string) {
    // Not again on a second confirm while the import runs
    if (this.importing) return;
    if (this.request.mode === 'unimport') {
      this.importing = this.unimport(files, from);
      return;
    }
    const { plugin } = this;
    this.importing = importChosen(
      this.plugin.reviewManager,
      files,
      options,
      from,
      (outcomes) => {
        // One entry for the whole of it, which the summary's button undoes
        const entry = plugin.actions.recordImport({ from, outcomes });
        return entry ? plugin.actions.undoAction(entry) : undefined;
      }
    );
    this.close();
  }

  /**
   * Once the user agrees, close, and un-import `files`, from what `from`
   * names. Answering no leaves the dialog open, for another go.
   */
  private async unimport(files: TFile[], from: string): Promise<void> {
    const { plugin } = this;
    const count = files.length;
    const articles = `${count} article${count === 1 ? '' : 's'}`;
    const confirmed = await promptForConfirmation(plugin.app, {
      title: 'Un-import articles',
      paragraphs: [
        `Un-import ${articles} and delete their review history? This can't be undone.`,
      ],
      confirmText: 'Un-import',
      destructive: true,
    });
    if (!confirmed) {
      this.importing = null;
      return;
    }
    const running = unimportChosen(
      plugin.reviewManager,
      files,
      from,
      (outcomes) => refreshAfterUnimport(plugin, outcomes)
    );
    this.close();
    await running;
  }

  /** The dialog's title for a source titled `title`. */
  private headingFor(source: CandidateSource): string {
    if (source.heading) return source.heading;
    return this.request.mode === 'unimport'
      ? `Un-importing from ${source.title}`
      : `Importing from ${source.title}`;
  }

  onOpen() {
    const { plugin, request, contentEl } = this;
    if (request.filterBar) {
      this.openFiltered();
      return;
    }
    this.setTitle(this.headingFor(request.source));
    render(
      <BulkImportModalContent
        mode={request.mode}
        source={request.source}
        defaults={{
          priority: plugin.settings.defaultPriority,
          makeCopy: plugin.settings.copyOnImport,
          includeSubfolders: plugin.data.ui.folderImportIncludeSubfolders,
        }}
        onIncludeSubfoldersChange={(on) =>
          void plugin.saveUiState({ folderImportIncludeSubfolders: on })
        }
        onConfirm={(files, options) =>
          this.confirm(files, options, request.source.title)
        }
        onCancel={() => this.close()}
      />,
      contentEl
    );
  }

  /**
   * The dialog with the filter bar, listing nothing until a filter makes a
   * source. The file explorer's order is read once, here. The search filter
   * is there only while Obsidian's search engine can be reached, which may
   * take loading a file explorer not shown yet: drawn again once loaded.
   */
  private openFiltered() {
    const { plugin, request } = this;
    const sources = plugin.bulkImportSources(request.mode);
    this.setTitle(
      request.mode === 'unimport' ? 'Bulk un-import' : 'Bulk import'
    );
    this.drawFiltered(sources);
    loadSearchEngine(plugin.app).then(
      (loaded) => {
        if (loaded && !this.shut) this.drawFiltered(sources);
      },
      // The dialog stays as drawn, without the search filter
      (error: unknown) => console.error(error)
    );
  }

  private drawFiltered(sources: FilterSources) {
    const { plugin, request, contentEl } = this;
    const search = getVaultSearch(plugin.app);
    render(
      <FilteredBulkImport
        mode={request.mode}
        segments={[
          folderFilter(plugin.app, sources.folder),
          tagFilter(
            plugin.app,
            sources.tag,
            plugin.settings.autoImportOnTag
              ? plugin.settings.autoImportTags
              : []
          ),
          ...(search ? [searchFilter(search, sources.search)] : []),
        ]}
        defaults={{
          priority: plugin.settings.defaultPriority,
          makeCopy: plugin.settings.copyOnImport,
          includeSubfolders: plugin.data.ui.folderImportIncludeSubfolders,
        }}
        onIncludeSubfoldersChange={(on) =>
          void plugin.saveUiState({ folderImportIncludeSubfolders: on })
        }
        onConfirm={(files, options, source) =>
          this.confirm(files, options, source.title)
        }
        onCancel={() => this.close()}
      />,
      contentEl
    );
  }

  onClose() {
    this.shut = true;
    // Unmounting stops the scan
    render(null, this.contentEl);
    void (this.importing ?? Promise.resolve()).then(
      this.settleClosed,
      this.settleClosed
    );
  }
}
