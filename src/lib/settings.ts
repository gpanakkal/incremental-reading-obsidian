import type IncrementalReadingPlugin from '#/main';
import { PluginSettingTab, type App, Setting } from 'obsidian';
import {
  DEFAULT_PRIORITY,
  MAXIMUM_PRIORITY,
  MINIMUM_PRIORITY,
} from './constants';
import { transformPriority } from './utils';

export interface IRPluginSettings {
  defaultPriority: number;
  showImportDialog: boolean;
}
export const DEFAULT_SETTINGS: IRPluginSettings = {
  defaultPriority: DEFAULT_PRIORITY,
  showImportDialog: true,
};

export class IRSettingTab extends PluginSettingTab {
  plugin: IncrementalReadingPlugin;

  constructor(app: App, plugin: IncrementalReadingPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl)
      .setName('Default article priority')
      .setDesc('Priority for new imports. Does not affect existing articles.')
      .addSlider((slider) => {
        slider
          .setLimits(MINIMUM_PRIORITY / 10, MAXIMUM_PRIORITY / 10, 0.1)
          .setValue(this.plugin.settings.defaultPriority / 10)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.defaultPriority = transformPriority(value);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Show article import dialog')
      .setDesc(
        'If enabled, shows a confirmation dialog when importing that allows article settings to be customized.'
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showImportDialog)
          .onChange(async (value) => {
            this.plugin.settings.showImportDialog = value;
            await this.plugin.saveSettings();
          });
      });
  }
}
