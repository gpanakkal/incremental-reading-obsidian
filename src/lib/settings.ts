import type IncrementalReadingPlugin from '#/main';
import { PluginSettingTab, Setting, type App } from 'obsidian';
import {
  DAY_ROLLOVER_OFFSET_HOURS,
  DEFAULT_PRIORITY,
  MAXIMUM_PRIORITY,
  MINIMUM_PRIORITY,
} from './constants';
import IRScheduler from './IRScheduler';

export interface IRPluginSettings {
  defaultPriority: number;
  showImportDialog: boolean;
  reviewOnImport: boolean;
  dayRolloverOffset: number;
}
export const DEFAULT_SETTINGS: IRPluginSettings = {
  defaultPriority: DEFAULT_PRIORITY,
  showImportDialog: true,
  reviewOnImport: true,
  dayRolloverOffset: DAY_ROLLOVER_OFFSET_HOURS.DEFAULT,
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
            this.plugin.settings.defaultPriority =
              IRScheduler.transformPriority(value);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Show article import dialog')
      .setDesc(
        'If enabled, shows a confirmation dialog when importing that allows' +
          ' article settings to be customized.'
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showImportDialog)
          .onChange(async (value) => {
            this.plugin.settings.showImportDialog = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Review immediately upon import')
      .setDesc('Immediately open articles for review when imported.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.reviewOnImport)
          .onChange(async (value) => {
            this.plugin.settings.reviewOnImport = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('End-of-day shift')
      .setDesc(
        'Adjust the end time of the review day, in hours from midnight.' +
          ' Set this to the time you are most likely to be asleep.' +
          ' Default: 4 AM.'
      )
      .addSlider((slider) => {
        slider
          .setLimits(
            DAY_ROLLOVER_OFFSET_HOURS.MIN,
            DAY_ROLLOVER_OFFSET_HOURS.MAX,
            1
          )
          .setValue(this.plugin.settings.dayRolloverOffset)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.dayRolloverOffset = value;
            await this.plugin.saveSettings();
          });
      });
  }
}
