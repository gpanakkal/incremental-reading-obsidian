/**
 * Minimal stub for the `obsidian` package used in unit tests.
 * Only runtime-imported symbols need to be present here — `import type` usage
 * is erased by TypeScript and requires no stub entry.
 */

export const normalizePath = (path: string) => path;

export class Notice {
  /**
   * Every notice raised since the last {@link Notice.reset}, so tests can
   * assert on messages that are otherwise invisible: a notice is the only
   * output of several code paths. Call `Notice.reset()` in `beforeEach` —
   * nothing clears it automatically.
   */
  static readonly messages: string[] = [];

  static reset() {
    Notice.messages.length = 0;
  }

  constructor(message: string, _duration?: number) {
    Notice.messages.push(message);
  }
}

// CodeMirror state field stubs — imported by ObsidianHelpers but not called in tests
export const editorInfoField = {};
export const editorEditorField = {};

// Commonly imported Obsidian classes — stubbed as no-ops so transitive imports resolve
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class Modal {}
export class FileView {
  /**
   * Cleanups handed to `Component.register`. Exposed so tests can run them and
   * assert that a view releases its subscriptions on unload.
   */
  readonly registered: (() => unknown)[] = [];

  register(cb: () => unknown) {
    this.registered.push(cb);
  }

  /**
   * A no-op, as it is in Obsidian: `FileView` inherits `ItemView`'s
   * implementation, which contributes only tab-level entries and nothing about
   * the file. Present so `ReviewView.onPaneMenu` can call `super` and so tests
   * can spy here to check it does.
   */
  onPaneMenu(_menu: Menu, _source: string): void {}
}

/**
 * Records what a menu was built out of.
 *
 * Obsidian renders items grouped by section, walking `sections` in order rather
 * than following the order `addItem` was called in, so tests read `section` off
 * each item to assert where it lands.
 */
export class MenuItem {
  title: string | DocumentFragment = '';
  icon: string | null = null;
  section = '';
  disabled = false;
  warning = false;
  callback: ((evt: unknown) => unknown) | null = null;
  /**
   * Stands in for the `.menu-item-title` element Obsidian exposes, which is the
   * only way to read back the title of an entry another class added. A plain
   * object rather than a real element, so the stub works in tests that run
   * without a DOM; `textContent` is all anything reads off it.
   */
  readonly titleEl: { textContent: string | null } = { textContent: null };

  setTitle(title: string | DocumentFragment) {
    this.title = title;
    this.titleEl.textContent =
      typeof title === 'string' ? title : title.textContent;
    return this;
  }
  setIcon(icon: string | null) {
    this.icon = icon;
    return this;
  }
  setSection(section: string) {
    this.section = section;
    return this;
  }
  setDisabled(disabled: boolean) {
    this.disabled = disabled;
    return this;
  }
  setWarning(warning: boolean) {
    this.warning = warning;
    return this;
  }
  onClick(cb: (evt: unknown) => unknown) {
    this.callback = cb;
    return this;
  }
}

export class Menu {
  readonly items: MenuItem[] = [];
  readonly sections: string[] = [];
  readonly submenuConfigs: Record<string, { title: string; icon: string }> = {};
  parentEl: HTMLElement | null = null;
  /** The position argument of the last `showAtPosition`, or null if never shown. */
  shownAt: unknown = null;

  addItem(cb: (item: MenuItem) => unknown) {
    const item = new MenuItem();
    this.items.push(item);
    cb(item);
    return this;
  }
  addSeparator() {
    return this;
  }
  /**
   * Mirrors Obsidian: already-registered sections are dropped, and the rest are
   * spliced in ahead of the catch-all `''` section, or appended when there is
   * none. Section order is the whole point of the call, so the stub reproduces
   * it rather than just recording the argument.
   */
  addSections(sections: string[]) {
    const fresh = sections.filter(
      (section) => !this.sections.includes(section)
    );
    const catchAll = this.sections.indexOf('');
    this.sections.splice(
      catchAll === -1 ? this.sections.length : catchAll,
      0,
      ...fresh
    );
    return this;
  }
  setSectionSubmenu(section: string, submenu: { title: string; icon: string }) {
    this.submenuConfigs[section] = submenu;
    return this;
  }
  setParentElement(el: HTMLElement) {
    this.parentEl = el;
    return this;
  }
  showAtPosition(position: unknown) {
    this.shownAt = position;
    return this;
  }
  showAtMouseEvent(_evt: unknown) {
    return this;
  }
  hide() {
    return this;
  }
}
/** Popout window container; `ReviewView.setTitle` branches on `instanceof` it. */
export class WorkspaceWindow {
  updateTitle() {}
}
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
