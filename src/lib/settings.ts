import type IncrementalReadingPlugin from '#/main';
import { PluginSettingTab, type App, Setting } from 'obsidian';

export interface IRPluginSettings {}
export const DEFAULT_SETTINGS: IRPluginSettings = {};

export class IRSettingTab extends PluginSettingTab {
  plugin: IncrementalReadingPlugin;

  constructor(app: App, plugin: IncrementalReadingPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();
  }
}
