import { ObsidianHelpers } from '#/lib/ObsidianHelpers';
import type IncrementalReadingPlugin from '#/main';
import ReviewView from '#/views/ReviewView';
import { MarkdownView, type TFile, type WorkspaceLeaf } from 'obsidian';
import { renderStandaloneActionBarDOM } from './ActionBarExtension';

class ReadingModeActionBarController {
  private barEl: HTMLElement | null = null;

  constructor(
    private readonly leaf: WorkspaceLeaf,
    private readonly plugin: IncrementalReadingPlugin
  ) {}

  sync(): void {
    const { view } = this.leaf;
    if (!(view instanceof MarkdownView) || view.getMode() !== 'preview') {
      this.unmount();
      return;
    }
    const file = view.file;
    if (!file) {
      this.unmount();
      return;
    }
    const noteType = ObsidianHelpers.getNoteType(file, this.plugin.app);
    if (!noteType) {
      this.unmount();
      return;
    }
    this.mount(view, file);
  }

  private mount(view: MarkdownView, file: TFile): void {
    const container = view.previewMode.containerEl;
    if (this.barEl && container.contains(this.barEl)) return;
    this.unmount();
    const bar = document.createElement('div');
    bar.className = 'ir-action-bar ir-action-bar-panel ir-reading-mode-bar';
    renderStandaloneActionBarDOM(file, this.plugin, bar);
    container.prepend(bar);
    this.barEl = bar;
  }

  unmount(): void {
    this.barEl?.remove();
    this.barEl = null;
  }
}

export function registerReadingModeActionBar(
  plugin: IncrementalReadingPlugin
): void {
  const controllers = new Map<WorkspaceLeaf, ReadingModeActionBarController>();

  const syncAll = () => {
    const liveLeaves = new Set<WorkspaceLeaf>();
    plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view.getViewType() === ReviewView.viewType) return;
      liveLeaves.add(leaf);
      if (!controllers.has(leaf)) {
        controllers.set(leaf, new ReadingModeActionBarController(leaf, plugin));
      }
      controllers.get(leaf)!.sync();
    });
    for (const [leaf, ctrl] of controllers) {
      if (!liveLeaves.has(leaf)) {
        ctrl.unmount();
        controllers.delete(leaf);
      }
    }
  };

  plugin.registerEvent(plugin.app.workspace.on('layout-change', syncAll));
  plugin.register(() => {
    controllers.forEach((c) => c.unmount());
    controllers.clear();
  });
  syncAll();
}
