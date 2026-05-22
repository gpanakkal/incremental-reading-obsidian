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
