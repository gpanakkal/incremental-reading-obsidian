import { BulkImportModalContent } from '#/components/BulkImportModalContent';
import { importChosen } from '#/lib/bulk-import/run-import';
import type {
  BulkImportOptions,
  CandidateSource,
} from '#/lib/bulk-import/types';
import type IncrementalReadingPlugin from '#/main';
import { Modal, type TFile } from 'obsidian';
import { render } from 'preact';

/**
 * What a bulk modal is opened on: where its files come from, and what it does
 * with them. Only importing is built so far.
 */
export interface BulkImportRequest {
  source: CandidateSource;
  mode: 'import';
}

/**
 * The one dialog for importing many files at once: shared import options over
 * a checklist of the files its source finds, filled in as they are found. The
 * scan stops when the dialog closes. Confirming closes it, then imports the
 * ticked files and says once how that went (see `importChosen`).
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
  /** The import started by confirming, if any. There is one per dialog. */
  private importing: Promise<unknown> | null = null;

  constructor(plugin: IncrementalReadingPlugin, request: BulkImportRequest) {
    super(plugin.app);
    this.plugin = plugin;
    this.request = request;
    this.closed = new Promise((resolve) => {
      this.settleClosed = resolve;
    });
  }

  private confirm(files: TFile[], options: BulkImportOptions) {
    // Not again on a second confirm while the import runs
    if (this.importing) return;
    const { plugin, request } = this;
    this.importing = importChosen(
      plugin.reviewManager,
      files,
      options,
      request.source.title
    );
    this.close();
  }

  onOpen() {
    const { plugin, request, contentEl } = this;
    this.setTitle(`Importing from ${request.source.title}`);
    render(
      <BulkImportModalContent
        source={request.source}
        defaults={{
          priority: plugin.settings.defaultPriority,
          makeCopy: plugin.settings.copyOnImport,
          includeSubfolders: plugin.data.ui.folderImportIncludeSubfolders,
        }}
        onIncludeSubfoldersChange={(on) =>
          void plugin.saveUiState({ folderImportIncludeSubfolders: on })
        }
        onConfirm={(files, options) => this.confirm(files, options)}
        onCancel={() => this.close()}
      />,
      contentEl
    );
  }

  onClose() {
    // Unmounting stops the scan
    render(null, this.contentEl);
    void (this.importing ?? Promise.resolve()).then(
      this.settleClosed,
      this.settleClosed
    );
  }
}
