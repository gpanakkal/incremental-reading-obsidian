import type { App, Menu, TFile } from 'obsidian';

/**
 * Adds Obsidian's own "Reveal file in navigation" entry to `menu`, in
 * `section`: picking it reveals and highlights `file` in the file explorer, as
 * the file explorer's `file-menu` entry does. Does nothing when the core file
 * explorer is turned off.
 *
 * `app.internalPlugins` and the explorer's `revealInFolder` are undocumented
 * (typed by obsidian-typings); the explorer's own entry calls the same method.
 */
export function addRevealInNavigationItem(
  menu: Menu,
  app: App,
  file: TFile,
  section: string
): void {
  menu.addItem((item) =>
    item
      .setTitle('Reveal file in navigation')
      .setIcon('lucide-folder-open')
      .setSection(section)
      .onClick(() => {
        app.internalPlugins
          .getEnabledPluginById('file-explorer')
          ?.revealInFolder(file);
      })
  );
}
