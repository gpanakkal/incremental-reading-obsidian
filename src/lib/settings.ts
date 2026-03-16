import type IncrementalReadingPlugin from '#/main';
import { PluginSettingTab, type App, Setting } from 'obsidian';

export interface IRPluginSettings {
  allowEscBind: boolean;
}
export const DEFAULT_SETTINGS: IRPluginSettings = {
  allowEscBind: true,
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
      .setName('Esc exits edit mode in review')
      .setDesc(
        "Action bar hotkeys don't work when editing. Disable this for Vim compatibility."
      )
      .addToggle((component) =>
        component
          .setValue(this.plugin.settings.allowEscBind)
          .onChange(async (value) => {
            this.plugin.settings.allowEscBind = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
