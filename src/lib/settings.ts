import type IncrementalReadingPlugin from '#/main';
import { PluginSettingTab, Setting, TextComponent, type App } from 'obsidian';
import { FSRSParameters, generatorParameters } from 'ts-fsrs';
import {
  DATA_DIRECTORY,
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
  copyOnImport: boolean;
  dayRolloverOffset: number;
  showAdvancedImportCommands: boolean;
  showAdvancedImportMenuItems: boolean;
  fuzzTextReviews: boolean; // intra-day fuzzing for items except cards
  fsrsParams: FSRSParameters;
}

const FSRS_PARAMETER_DEFAULTS = generatorParameters();

export const DEFAULT_SETTINGS: IRPluginSettings = {
  defaultPriority: DEFAULT_PRIORITY,
  showImportDialog: true,
  reviewOnImport: false,
  copyOnImport: false,
  dayRolloverOffset: DAY_ROLLOVER_OFFSET_HOURS.DEFAULT,
  showAdvancedImportCommands: false,
  showAdvancedImportMenuItems: false,
  fuzzTextReviews: true,
  fsrsParams: FSRS_PARAMETER_DEFAULTS,
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

    new Setting(containerEl).setName('Imports').setHeading();

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
      .setDesc('Show a dialog when importing that allows customization.')
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
      .setName('Copy articles when importing')
      .setDesc(
        `Copy notes into the data directory (${DATA_DIRECTORY}/) when importing` +
          ' and leave the original note untouched.' +
          ' Disable to import notes in-place.'
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.copyOnImport)
          .onChange(async (value) => {
            this.plugin.settings.copyOnImport = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl).setName('Reviews').setHeading();

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

    new Setting(containerEl)
      .setName('Fuzz review ordering')
      .setDesc(
        `Partially shuffle article and snippet reviews within the same day. Cards are not affected.`
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.fuzzTextReviews)
          .onChange(async (value) => {
            this.plugin.settings.fuzzTextReviews = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl).setName('Shortcuts').setHeading();

    new Setting(containerEl)
      .setName('Enable extra import hotkeys')
      .setDesc(
        `Shortcuts to open or bypass the import modal, import a copy, or import in-place.`
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showAdvancedImportCommands)
          .onChange(async (value) => {
            this.plugin.settings.showAdvancedImportCommands = value;
            await this.plugin.saveSettings();
            this.plugin.toggleAdvancedCommands(value);
          });
      });

    new Setting(containerEl)
      .setName('Show extra file menu entries for importing')
      .setDesc(
        `Entries to open or bypass the import modal, import a copy, or import in-place.`
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showAdvancedImportMenuItems)
          .onChange(async (value) => {
            this.plugin.settings.showAdvancedImportMenuItems = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl).setName('Spaced Repetition').setHeading();

    new Setting(containerEl)
      .setName('Fuzz review intervals')
      .setDesc(
        `Add controlled randomness to subsequent card reviews. Does not affect articles or snippets.`
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.fsrsParams.enable_fuzz)
          .onChange(async (value) => {
            this.plugin.settings.fsrsParams.enable_fuzz = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Enable short-term card scheduling')
      .setDesc(
        `Schedule cards for next review in a few minutes in some cases where the user chooses a review grade below Easy. Recommended: off.`
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.fsrsParams.enable_short_term)
          .onChange(async (value) => {
            this.plugin.settings.fsrsParams.enable_short_term = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Targeted retention')
      .setDesc(
        `The card recall score (out of 1) to aim for. Card reviews will be scheduled to target this score. 0.9 is optimal in most cases.`
      )
      .addComponent((el) => new TextComponent(el))
      .addSlider((slider) => {
        slider
          .setLimits(0.8, 0.95, 0.01)
          .setValue(this.plugin.settings.fsrsParams.request_retention)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.fsrsParams.request_retention = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Maximum review interval')
      .setDesc(
        `Soft ceiling on the time between card reviews. Fuzzing can exceed this limit slightly. Default: 36,500 days (~10 years).`
      )
      .addText((text) => {
        text
          .setValue(this.plugin.settings.fsrsParams.maximum_interval.toString())
          .onChange(async (value) => {
            const asNum = Number.parseInt(value);
            if (Number.isNaN(asNum)) {
              // reject the change and restore previous value
              return;
            }

            this.plugin.settings.fsrsParams.maximum_interval = asNum;
            await this.plugin.saveSettings();
          });
      });
  }
}
