/**
 * Minimal stub for the `obsidian` package used in unit tests.
 * Only runtime-imported symbols need to be present here — `import type` usage
 * is erased by TypeScript and requires no stub entry.
 */

export const normalizePath = (path: string) => path;

export class Notice {
  constructor(_message: string, _duration?: number) {}
}

// CodeMirror state field stubs — imported by ObsidianHelpers but not called in tests
export const editorInfoField = {};
export const editorEditorField = {};

// Commonly imported Obsidian classes — stubbed as no-ops so transitive imports resolve
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class Modal {}
export class FileView {}
export class MarkdownView {}
export class Component {}
export class MarkdownRenderer {}
export const Platform = { isMobile: false, isDesktop: true };

/**
 * Mirrors Obsidian's Keymap.isModEvent: Mod-click (Ctrl on Win/Linux, Cmd on
 * macOS) or a middle click opens a tab, +Alt splits, +Alt+Shift opens a window.
 */
export class Keymap {
  static isModEvent(
    evt?: MouseEvent | KeyboardEvent | TouchEvent | null
  ): 'tab' | 'split' | 'window' | boolean {
    if (!evt) return false;
    const mod = evt.ctrlKey || evt.metaKey;
    if (mod && evt.altKey) return evt.shiftKey ? 'window' : 'split';
    const isMiddleClick = 'button' in evt && evt.button === 1;
    return mod || isMiddleClick ? 'tab' : false;
  }
}

export class MarkdownPreviewView {
  static async render(
    _app: unknown,
    markdown: string,
    el: HTMLElement,
    _sourcePath: string,
    _component: unknown
  ): Promise<void> {
    // Minimal stub: write textContent = markdown so tests can control rendered output
    el.textContent = markdown;
  }
}
