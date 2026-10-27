import { Menu } from '#/test/__mocks__/obsidian';
import fc from 'fast-check';
import type { App, Menu as ObsidianMenu, TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addRevealInNavigationItem } from './reveal-in-navigation';

// #region HELPERS

function makeFile(path = 'notes/x.md'): TFile {
  return { path } as TFile;
}

/** An app whose file explorer is `explorer`: null when the core plugin is off. */
function makeApp(
  explorer: { revealInFolder: (file: TFile) => void } | null = {
    revealInFolder: vi.fn(),
  }
) {
  const getEnabledPluginById = vi.fn(() => explorer);
  return {
    app: { internalPlugins: { getEnabledPluginById } } as unknown as App,
    getEnabledPluginById,
    explorer,
  };
}

function addTo(menu: Menu, app: App, file: TFile, section: string) {
  addRevealInNavigationItem(
    menu as unknown as ObsidianMenu,
    app,
    file,
    section
  );
  return menu.items[menu.items.length - 1];
}

// #endregion

afterEach(() => {
  vi.restoreAllMocks();
});

describe('addRevealInNavigationItem', () => {
  it('adds one folder-open entry in the asked section, reaching for nothing until picked', () => {
    fc.assert(
      fc.property(fc.string(), (section) => {
        const menu = new Menu();
        const { app, getEnabledPluginById } = makeApp();

        const item = addTo(menu, app, makeFile(), section);

        expect(menu.items).toHaveLength(1);
        expect(item.icon).toBe('lucide-folder-open');
        expect(item.section).toBe(section);
        expect(item.disabled).toBe(false);
        expect(item.warning).toBe(false);
        expect(getEnabledPluginById).not.toHaveBeenCalled();
      })
    );
  });

  it('reveals the file in the core file explorer once picked', () => {
    const menu = new Menu();
    const { app, getEnabledPluginById, explorer } = makeApp();
    const file = makeFile('deep/folder/note.md');

    addTo(menu, app, file, 'open').callback?.(undefined);

    expect(getEnabledPluginById).toHaveBeenCalledExactlyOnceWith(
      'file-explorer'
    );
    expect(explorer?.revealInFolder).toHaveBeenCalledExactlyOnceWith(file);
  });

  it('does nothing when the file explorer is turned off', () => {
    const menu = new Menu();
    const { app } = makeApp(null);

    const item = addTo(menu, app, makeFile(), 'open');

    expect(() => item.callback?.(undefined)).not.toThrow();
  });
});
