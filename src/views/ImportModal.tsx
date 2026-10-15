import { ImportModalContent } from '#/components/ImportModalContent';
import { isCopyImportable } from '#/lib/mime';
import type { SchedulingStrategy } from '#/lib/types';
import type { WebPage } from '#/lib/web-viewer';
import type IncrementalReadingPlugin from '#/main';
import { type TFile, Modal } from 'obsidian';
import { render } from 'preact';

/**
 * What the dialog imports: a file in the vault (offered as a copy when it can
 * be copied, the toggle starting at `defaultCopyOnImport` or the setting), or
 * a page read from the web viewer, which always becomes a new note.
 */
export type ImportSubject =
  | { kind: 'file'; file: TFile; defaultCopyOnImport?: boolean }
  | { kind: 'web'; page: WebPage };

export class ImportModal extends Modal {
  plugin: IncrementalReadingPlugin;
  subject: ImportSubject;
  /**
   * Settles once the dialog has closed, however it was closed, and the import
   * it started (if any) has finished.
   */
  readonly closed: Promise<void>;
  private settleClosed!: () => void;
  /** The import started by confirming, if any. There is one per dialog. */
  private importing: Promise<unknown> | null = null;

  constructor(plugin: IncrementalReadingPlugin, subject: ImportSubject) {
    super(plugin.app);
    this.plugin = plugin;
    this.subject = subject;
    this.closed = new Promise((resolve) => {
      this.settleClosed = resolve;
    });
  }

  async handleClose(
    strategy: SchedulingStrategy,
    value: number,
    makeCopy: boolean
  ) {
    const { plugin, subject } = this;
    const props: [priority: number, intervalDays: number | null] =
      strategy === 'priority'
        ? [value, null]
        : [plugin.settings.defaultPriority, value];
    if (subject.kind === 'web') {
      await plugin.reviewManager.importWebPage(subject.page, ...props);
    } else {
      await plugin.reviewManager.importArticle(
        subject.file,
        ...props,
        makeCopy
      );
    }
  }

  onOpen() {
    const { plugin, subject, contentEl } = this;
    this.setTitle(
      `Importing "${subject.kind === 'web' ? subject.page.title : subject.file.basename}"`
    );
    const schedule = {
      intervalDays: null as number | null,
      priority: plugin.settings.defaultPriority,
    };
    render(
      <ImportModalContent
        plugin={plugin}
        schedule={schedule}
        defaultCopyOnImport={
          subject.kind === 'file' &&
          (subject.defaultCopyOnImport ?? plugin.settings.copyOnImport)
        }
        canCopy={subject.kind === 'file' && isCopyImportable(subject.file)}
        onClose={(args) => {
          if (args === 'cancel') {
            this.close();
          } else if (!this.importing) {
            // Not again on a second confirm (Enter held, a double-click) while
            // the import runs: a web page would get a second note
            this.importing = this.handleClose(
              args.strategy,
              args.value,
              args.makeCopy
            );
            void this.importing.finally(() => this.close());
          }
        }}
      />,
      contentEl
    );
  }

  onClose() {
    render(null, this.contentEl);
    // Closed with Esc while the import runs: done once that has finished
    void (this.importing ?? Promise.resolve()).then(
      this.settleClosed,
      this.settleClosed
    );
  }
}
