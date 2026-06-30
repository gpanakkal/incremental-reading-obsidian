import { ImportModalContent } from '#/components/ImportModalContent';
import type { SchedulingStrategy } from '#/lib/types';
import type IncrementalReadingPlugin from '#/main';
import type { TFile } from 'obsidian';
import { Modal } from 'obsidian';
import { render } from 'preact';

export class ImportModal extends Modal {
  plugin: IncrementalReadingPlugin;
  file: TFile;
  defaultCopyOnImport: boolean | undefined;

  constructor(
    plugin: IncrementalReadingPlugin,
    file: TFile,
    defaultCopyOnImport?: boolean
  ) {
    super(plugin.app);
    this.plugin = plugin;
    this.file = file;
    this.defaultCopyOnImport = defaultCopyOnImport;
  }

  async handleClose(
    strategy: SchedulingStrategy,
    value: number,
    makeCopy: boolean
  ) {
    const { plugin, file } = this;
    const props: [priority: number, intervalDays: number | null] =
      strategy === 'priority'
        ? [value, null]
        : [plugin.settings.defaultPriority, value];
    const importedArticle = await plugin.reviewManager.importArticle(
      file,
      ...props,
      makeCopy
    );
    if (importedArticle && plugin.settings.reviewOnImport) {
      await plugin.learn(importedArticle);
    }
  }

  onOpen() {
    const { plugin, contentEl } = this;
    const schedule = {
      intervalDays: null as number | null,
      priority: plugin.settings.defaultPriority,
    };
    render(
      <ImportModalContent
        plugin={plugin}
        schedule={schedule}
        defaultCopyOnImport={
          this.defaultCopyOnImport ?? plugin.settings.copyOnImport
        }
        onClose={(args) => {
          if (args !== 'cancel') {
            void this.handleClose(
              args.strategy,
              args.value,
              args.makeCopy
            ).finally(() => this.close());
          } else {
            this.close();
          }
        }}
      />,
      contentEl
    );
  }

  onClose() {
    render(null, this.contentEl);
  }
}
