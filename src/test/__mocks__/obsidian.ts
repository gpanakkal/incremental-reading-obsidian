/**
 * Minimal stub for the `obsidian` package used in unit tests.
 * Only runtime-imported symbols need to be present here — `import type` usage
 * is erased by TypeScript and requires no stub entry.
 */

import { parse } from 'yaml';

export const normalizePath = (path: string) => path;

/** A frontmatter block opens with `---` on the very first line. */
const FRONTMATTER_OPEN = /^---(\r?\n)/g;
/** It closes at a `---` that is followed by a line break or the end of input. */
const FRONTMATTER_CLOSE = /---(\r?\n|$)/g;

const noFrontMatter = () => ({
  exists: false,
  contentStart: 0,
  from: 0,
  to: 0,
  frontmatter: '',
});

/**
 * Port of Obsidian's own `getFrontMatterInfo`, deminified from obsidian.asar so
 * the offsets tests assert on are the ones production computes. The block must
 * open on the first line; the closing fence is the first `---` that both starts a
 * line and is followed by a line break or the end of the string. `to` is the
 * offset of that fence, so `frontmatter` ends with the line break before it, and
 * `contentStart` is the offset just past the fence's own line break.
 */
export function getFrontMatterInfo(content: string) {
  FRONTMATTER_OPEN.lastIndex = 0;
  if (!FRONTMATTER_OPEN.exec(content)) return noFrontMatter();
  const from = FRONTMATTER_OPEN.lastIndex;

  FRONTMATTER_CLOSE.lastIndex = from;
  let close = FRONTMATTER_CLOSE.exec(content);
  while (close && content.charAt(close.index - 1) !== '\n') {
    close = FRONTMATTER_CLOSE.exec(content);
  }
  if (!close) return noFrontMatter();

  return {
    exists: true,
    frontmatter: content.slice(from, close.index),
    from,
    to: close.index,
    contentStart: FRONTMATTER_CLOSE.lastIndex,
  };
}

/**
 * Obsidian's `parseYaml`, on the parser it bundles. Read from obsidian.asar
 * (1.13.7): it is the `yaml` package's `parse(text, null, {})`, which is
 * `parse(text)`: the package defaults (YAML 1.2 core schema, unique keys,
 * strict), so blank text parses to null and malformed YAML throws a
 * `YAMLParseError`. The bundled copy is 2.6 or later (it knows the `stringKeys`
 * option); this one is pinned in devDependencies and may differ from it in
 * patch-level fixes.
 */
export function parseYaml(text: string): unknown {
  return parse(text);
}

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

// The vault's files and folders, for code that tells them apart by `instanceof`.
// Build one with `Object.assign(new TFile(), { path, ... })`.
export class TAbstractFile {
  path = '';
  name = '';
  parent: TFolder | null = null;
}
export class TFile extends TAbstractFile {
  basename = '';
  extension = '';
}
export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

// Commonly imported Obsidian classes — stubbed as no-ops so transitive imports resolve
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class Modal {
  app: unknown;
  /** Built in the constructor, so only jsdom tests can instantiate a modal. */
  contentEl: HTMLElement;
  /** Stands in for the `.modal-title` element above `contentEl`. */
  readonly titleEl: { textContent: string | null } = { textContent: null };

  constructor(app: unknown) {
    this.app = app;
    this.contentEl = document.createElement('div');
  }

  setTitle(title: string) {
    this.titleEl.textContent = title;
    return this;
  }

  open() {}
  close() {}
}
/** Only what `RelinkModal` reaches: a modal that lists items to pick from. */
export class FuzzySuggestModal<T> extends Modal {
  placeholder = '';

  setPlaceholder(placeholder: string) {
    this.placeholder = placeholder;
  }

  getItems(): T[] {
    return [];
  }
}
export class FileView {
  /**
   * Stands in for the tab's `.workspace-leaf-content`. A real element under
   * jsdom; absent in the `node` environment, which has no DOM to build one.
   */
  containerEl: HTMLElement | undefined =
    typeof document === 'undefined' ? undefined : document.createElement('div');

  /**
   * Cleanups handed to `Component.register`. Exposed so tests can run them and
   * assert that a view releases its subscriptions on unload.
   */
  readonly registered: (() => unknown)[] = [];

  register(cb: () => unknown) {
    this.registered.push(cb);
  }

  /** Event refs handed to `Component.registerEvent`, in registration order. */
  readonly registeredEvents: unknown[] = [];

  registerEvent(ref: unknown) {
    this.registeredEvents.push(ref);
  }

  registerDomEvent(
    el: HTMLElement,
    type: string,
    callback: (evt: Event) => unknown
  ) {
    el.addEventListener(type, callback);
  }

  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}

  /**
   * No-ops, as `View`'s are in Obsidian. `FileView.setState` also loads the
   * file the state names; tests spy here to see what reaches it.
   */
  async setState(_state: unknown, _result: unknown): Promise<void> {}
  getEphemeralState(): Record<string, unknown> {
    return {};
  }
  setEphemeralState(_state: unknown): void {}

  /**
   * A no-op, as it is in Obsidian: `FileView` inherits `ItemView`'s
   * implementation, which contributes only tab-level entries and nothing about
   * the file. Present so `ReviewView.onPaneMenu` can call `super` and so tests
   * can spy here to check it does.
   */
  onPaneMenu(_menu: Menu, _source: string): void {}

  /** A no-op here; Obsidian's retitles the header when `file` is renamed. */
  async onRename(_file: unknown): Promise<void> {}
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
  checked: boolean | null = null;
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
  /**
   * Obsidian renders a checkmark for `true` and reserves the slot for `false`,
   * so the two are not the same entry; `null` opts out of the slot entirely.
   */
  setChecked(checked: boolean | null) {
    this.checked = checked;
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
export const Platform = {
  isMobile: false,
  isMobileApp: false,
  isDesktop: true,
};

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

interface ScopeHandler {
  /** Modifiers joined with `,`, or `null` for any. */
  modifiers: string | null;
  key: string | null;
  func: (
    evt: KeyboardEvent,
    ctx: { modifiers: string; key: string }
  ) => unknown;
}

/**
 * Obsidian's keymap scope, far enough to route a key the way its `Keymap`
 * does. `handleKey` is undocumented; this mirrors the one in the app bundle:
 * the first handler matching key and modifiers answers, a handler bound to a
 * key ends the lookup even when it returns nothing, and a scope with no match
 * passes the key up to its parent.
 */
export class Scope {
  readonly keys: ScopeHandler[] = [];

  constructor(readonly parent?: Scope) {}

  register(
    modifiers: string[] | null,
    key: string | null,
    func: ScopeHandler['func']
  ): ScopeHandler {
    const handler = { modifiers: modifiers?.join(',') ?? null, key, func };
    this.keys.push(handler);
    return handler;
  }

  unregister(handler: ScopeHandler): void {
    this.keys.splice(this.keys.indexOf(handler), 1);
  }

  handleKey(
    evt: KeyboardEvent,
    ctx: { modifiers: string; key: string }
  ): unknown {
    for (const handler of this.keys) {
      const modifiersMatch =
        handler.modifiers === null || handler.modifiers === ctx.modifiers;
      const keyMatches =
        handler.key === null ||
        handler.key.toLowerCase() === ctx.key.toLowerCase();
      if (!modifiersMatch || !keyMatches) continue;
      const result = handler.func(evt, ctx);
      if (result !== undefined) return result;
      if (handler.key !== null || handler.modifiers !== null) return result;
    }
    return this.parent?.handleKey(evt, ctx);
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
