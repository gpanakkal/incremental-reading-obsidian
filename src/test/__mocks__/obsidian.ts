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

/**
 * Outside jsdom, an element that takes children and listeners and keeps none:
 * each child it makes is itself.
 */
function inertElement(): HTMLElement {
  const el = {
    addEventListener() {},
    createDiv: () => el,
    createEl: () => el,
    createSpan: () => el,
  };
  return el as unknown as HTMLElement;
}

export class Notice {
  /**
   * Every notice raised since the last {@link Notice.reset}, so tests can
   * assert on messages that are otherwise invisible: a notice is the only
   * output of several code paths. Call `Notice.reset()` in `beforeEach` —
   * nothing clears it automatically.
   */
  static readonly messages: string[] = [];

  /** Every notice constructed since the last {@link Notice.reset}, in order. */
  static readonly instances: Notice[] = [];

  static reset() {
    Notice.messages.length = 0;
    Notice.instances.length = 0;
  }

  /**
   * The notice's own element, which hides the notice when clicked anywhere, as
   * Obsidian's does: a detached one, outside jsdom an inert stub.
   */
  readonly containerEl: HTMLElement;
  /** The message's element, inside {@link containerEl}, as in Obsidian. */
  readonly messageEl: HTMLElement;
  /** Obsidian's deprecated name for {@link messageEl}. */
  readonly noticeEl: HTMLElement;

  readonly message: string;
  /** Obsidian's auto-hide delay: `0` keeps the notice up until it's hidden. */
  readonly duration: number | undefined;
  /** How many times {@link hide} has been called on this notice. */
  hides = 0;

  constructor(message: string, duration?: number) {
    this.message = message;
    this.duration = duration;
    if (typeof document === 'undefined') {
      this.containerEl = this.messageEl = this.noticeEl = inertElement();
    } else {
      this.containerEl = document.createElement('div');
      this.containerEl.className = 'notice';
      this.messageEl = this.noticeEl = document.createElement('div');
      this.messageEl.className = 'notice-message';
      this.messageEl.textContent = message;
      this.containerEl.appendChild(this.messageEl);
      this.containerEl.addEventListener('click', () => this.hide());
    }
    Notice.messages.push(message);
    Notice.instances.push(this);
  }

  hide() {
    this.hides++;
  }
}

type Pos = { line: number; col: number; offset: number };

/**
 * A heading (`#Heading`) or block (`#^id`) a link names, as Obsidian's finds
 * it in a note's cache: from its start to the next heading's, or the note's
 * end; a block over its own span. Footnotes and nested heading paths, which
 * nothing here links to, find nothing.
 */
export function resolveSubpath(
  cache: {
    headings?: { heading: string; position: { start: Pos } }[];
    blocks?: Record<string, { position: { start: Pos; end: Pos } }>;
  },
  subpath: string
): { start: Pos; end: Pos | null } | null {
  if (subpath.startsWith('#^')) {
    const block = cache.blocks?.[subpath.slice(2)];
    return block ? { ...block.position } : null;
  }
  const headings = cache.headings ?? [];
  const at = headings.findIndex(({ heading }) => `#${heading}` === subpath);
  if (at === -1) return null;
  return {
    start: headings[at].position.start,
    end: headings[at + 1]?.position.start ?? null,
  };
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
export class PluginSettingTab {
  /**
   * Stands in for the tab's `.vertical-tab-content`. A real element under
   * jsdom; absent in the `node` environment, which has no DOM to build one.
   */
  containerEl: HTMLElement | undefined =
    typeof document === 'undefined' ? undefined : document.createElement('div');

  /** Re-applies `visible`/`disabled` predicates in Obsidian; nothing here. */
  refreshDomState() {}
}
/**
 * A row as Obsidian 1.13's `Setting` builds one (read from obsidian.asar):
 * `.setting-item` holding `.setting-item-info` (name, description) and
 * `.setting-item-control`, which each `add*` appends its component to in call
 * order. Leaves out the Enter-blurs listener `addText` adds without a physical
 * keyboard.
 */
export class Setting {
  readonly settingEl: HTMLElement;
  readonly infoEl: HTMLElement;
  readonly nameEl: HTMLElement;
  readonly descEl: HTMLElement;
  readonly controlEl: HTMLElement;
  errorEl: HTMLElement | null = null;

  constructor(containerEl: HTMLElement) {
    const div = (parent: HTMLElement, cls: string) => {
      const el = parent.appendChild(document.createElement('div'));
      el.className = cls;
      return el;
    };
    this.settingEl = div(containerEl, 'setting-item');
    this.settingEl.tabIndex = -1;
    this.infoEl = div(this.settingEl, 'setting-item-info');
    this.nameEl = div(this.infoEl, 'setting-item-name');
    this.descEl = div(this.infoEl, 'setting-item-description');
    this.controlEl = div(this.settingEl, 'setting-item-control');
  }

  setName(name: string) {
    this.nameEl.textContent = name;
    return this;
  }
  setDesc(desc: string) {
    this.descEl.textContent = desc;
    return this;
  }
  /**
   * As Obsidian's: shows the message in a `.setting-item-error` appended to
   * the control on first use and marks the row `is-invalid`; `null` hides it.
   */
  setErrorMessage(message: string | null) {
    if (message) {
      if (!this.errorEl) {
        this.errorEl = this.controlEl.appendChild(
          document.createElement('div')
        );
        this.errorEl.className = 'setting-item-error';
      }
      this.errorEl.textContent = message;
      this.errorEl.style.display = '';
      this.settingEl.classList.add('is-invalid');
    } else {
      if (this.errorEl) this.errorEl.style.display = 'none';
      this.settingEl.classList.remove('is-invalid');
    }
    return this;
  }
  addExtraButton(cb: (component: ExtraButtonComponent) => unknown) {
    cb(new ExtraButtonComponent(this.controlEl));
    return this;
  }
  addText(cb: (component: TextComponent) => unknown) {
    cb(new TextComponent(this.controlEl));
    return this;
  }
  addComponent(cb: (el: HTMLElement) => unknown) {
    cb(this.controlEl);
    return this;
  }
}
/**
 * `div.clickable-icon.extra-setting-button`, focusable, drawn with a gear until
 * `setIcon`, as Obsidian's is. A click, Enter or Space runs the `onClick`
 * callback unless `setDisabled(true)`; an `aria-disabled` attribute doesn't
 * stop it.
 */
export class ExtraButtonComponent {
  readonly extraSettingsEl: HTMLElement;
  disabled = false;
  private callback: (() => unknown) | undefined;

  constructor(containerEl: HTMLElement) {
    const el = (this.extraSettingsEl = containerEl.appendChild(
      document.createElement('div')
    ));
    el.className = 'clickable-icon extra-setting-button';
    el.tabIndex = 0;
    setIcon(el, 'lucide-settings');
    const run = () => {
      if (!this.disabled) this.callback?.();
    };
    el.addEventListener('click', (event) => {
      event.preventDefault();
      run();
    });
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        run();
      }
    });
  }

  setDisabled(disabled: boolean) {
    this.disabled = disabled;
    this.extraSettingsEl.classList.toggle('is-disabled', disabled);
    return this;
  }
  setIcon(icon: string) {
    setIcon(this.extraSettingsEl, icon);
    return this;
  }
  /** Obsidian's sets `aria-label`, which its themed tooltip reads. */
  setTooltip(tooltip: string) {
    this.extraSettingsEl.setAttribute('aria-label', tooltip);
    return this;
  }
  onClick(callback: () => unknown) {
    this.callback = callback;
    return this;
  }
}
/**
 * An `input[type=text]` appended to its container, `spellcheck="false"`,
 * calling `onChange` with its value on each `input` event, as Obsidian's does.
 * `setValue` fires nothing.
 */
export class TextComponent {
  readonly inputEl: HTMLInputElement;
  private callback: ((value: string) => unknown) | undefined;

  constructor(containerEl: HTMLElement) {
    this.inputEl = containerEl.appendChild(document.createElement('input'));
    this.inputEl.type = 'text';
    this.inputEl.setAttribute('spellcheck', 'false');
    this.inputEl.addEventListener('input', () =>
      this.callback?.(this.inputEl.value)
    );
  }

  getValue() {
    return this.inputEl.value;
  }
  setValue(value: string) {
    this.inputEl.value = value;
    return this;
  }
  setPlaceholder(placeholder: string) {
    this.inputEl.setAttribute('placeholder', placeholder);
    return this;
  }
  setDisabled(disabled: boolean) {
    this.inputEl.disabled = disabled;
    return this;
  }
  onChange(callback: (value: string) => unknown) {
    this.callback = callback;
    return this;
  }
}
export class Modal {
  app: unknown;
  /**
   * `.modal-container`, `.modal` and `.modal-content`. Built in the
   * constructor, so only jsdom tests can instantiate a modal. Not nested as
   * Obsidian nests them (`containerEl` > `modalEl` > `contentEl`): a test that
   * stubs the document with bare objects to build one has no `appendChild`.
   */
  containerEl: HTMLElement;
  modalEl: HTMLElement;
  contentEl: HTMLElement;
  /** Stands in for the `.modal-title` element above `contentEl`. */
  readonly titleEl: { textContent: string | null } = { textContent: null };

  constructor(app: unknown) {
    this.app = app;
    this.containerEl = document.createElement('div');
    this.modalEl = document.createElement('div');
    this.contentEl = document.createElement('div');
  }

  setTitle(title: string) {
    this.titleEl.textContent = title;
    return this;
  }

  open() {}
  close() {}
}
/**
 * A `<button>` appended to its container, classed as Obsidian's is:
 * `setWarning` is `setDestructive().setCta()` there (read from obsidian.asar).
 */
export class ButtonComponent {
  readonly buttonEl: HTMLButtonElement;

  constructor(containerEl: HTMLElement) {
    this.buttonEl = document.createElement('button');
    containerEl.appendChild(this.buttonEl);
  }

  setButtonText(text: string) {
    this.buttonEl.textContent = text;
    return this;
  }
  setCta() {
    this.buttonEl.classList.add('mod-cta');
    return this;
  }
  setWarning() {
    this.buttonEl.classList.add('mod-destructive', 'mod-cta');
    return this;
  }
  setDestructive() {
    this.buttonEl.classList.add('mod-destructive');
    return this;
  }
  removeCta() {
    this.buttonEl.classList.remove('mod-cta');
    return this;
  }
  setClass(cls: string) {
    this.buttonEl.classList.add(cls);
    return this;
  }
  setDisabled(disabled: boolean) {
    this.buttonEl.disabled = disabled;
    return this;
  }
  /** `setIcon` on the button, as Obsidian's does. */
  setIcon(icon: string) {
    setIcon(this.buttonEl, icon);
    return this;
  }
  /** Obsidian's sets `aria-label`, which its themed tooltip reads. */
  setTooltip(tooltip: string) {
    this.buttonEl.setAttribute('aria-label', tooltip);
    return this;
  }
  onClick(callback: (evt: MouseEvent) => unknown) {
    this.buttonEl.addEventListener('click', callback);
    return this;
  }
}
/**
 * A `select.dropdown` appended to its container, with the hidden
 * `select.dropdown.is-measuring` Obsidian appends after it to fit its width
 * (read from obsidian.asar). `setValue` fires no `change`, as there.
 */
export class DropdownComponent {
  readonly selectEl: HTMLSelectElement;
  readonly measureEl: HTMLSelectElement;

  constructor(containerEl: HTMLElement) {
    this.selectEl = document.createElement('select');
    this.selectEl.classList.add('dropdown');
    this.measureEl = document.createElement('select');
    this.measureEl.classList.add('dropdown', 'is-measuring');
    this.measureEl.setAttribute('aria-hidden', 'true');
    this.measureEl.tabIndex = -1;
    containerEl.append(this.selectEl, this.measureEl);
  }

  addOption(value: string, display: string) {
    const option = document.createElement('option');
    option.value = value;
    option.text = display;
    this.selectEl.appendChild(option);
    return this;
  }
  addOptions(options: Record<string, string>) {
    for (const [value, display] of Object.entries(options)) {
      this.addOption(value, display);
    }
    return this;
  }
  getValue() {
    return this.selectEl.value;
  }
  setValue(value: string) {
    this.selectEl.value = value;
    return this;
  }
  setDisabled(disabled: boolean) {
    this.selectEl.disabled = disabled;
    return this;
  }
  onChange(callback: (value: string) => unknown) {
    this.selectEl.addEventListener('change', () => callback(this.getValue()));
    return this;
  }
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
/** Base of Obsidian's non-file views; the web viewer's among them. */
export class ItemView {}
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
/**
 * Icons registered through `addIcon`, by id. Obsidian keeps the same map
 * (deminified from obsidian.asar: `addIcon` stores the markup, `getIcon`
 * wraps it in a fresh `<svg viewBox="0 0 100 100">`).
 */
const customIcons = new Map<string, string>();

/** Registers `svgContent` as the inner markup of icon `iconId`, replacing any earlier one. */
export function addIcon(iconId: string, svgContent: string): void {
  customIcons.set(iconId, svgContent);
}

export function removeIcon(iconId: string): void {
  customIcons.delete(iconId);
}

/**
 * The ids `addIcon` registered. The real one lists every Lucide id as well,
 * which no test needs.
 */
export function getIconIds(): string[] {
  return [...customIcons.keys()];
}

/**
 * Partial port of Obsidian's `setIcon`, deminified from obsidian.asar: it swaps
 * out the element's first child only (whatever it is) for a fresh `<svg>`
 * classed `svg-icon` plus the icon's class, unless that child is already an
 * `<svg>` carrying the id as given.
 *
 * An id registered with `addIcon` is drawn as Obsidian draws it: classed with
 * the id itself, in a `0 0 100 100` viewBox holding the registered markup, and
 * with no stroke of its own (the markup has to bring that). Any other name is
 * treated as a Lucide icon, classed `lucide-<name>` and stroked in
 * `currentColor`, where the real one appends nothing for a name it doesn't
 * know, so this can't catch a wrong Lucide id; Lucide paths are left out too,
 * since tests only read the shell.
 */
export function setIcon(parent: HTMLElement, iconId: string): void {
  const first = parent.firstChild;
  if (first instanceof SVGSVGElement && first.classList.contains(iconId)) {
    return;
  }
  if (first) parent.removeChild(first);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const custom = customIcons.get(iconId);
  if (custom !== undefined) {
    svg.classList.add('svg-icon', iconId);
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.innerHTML = custom;
  } else {
    const name = iconId.startsWith('lucide-') ? iconId : `lucide-${iconId}`;
    svg.classList.add('svg-icon', name);
    svg.setAttribute('stroke', 'currentColor');
  }
  parent.appendChild(svg);
}

/** A `FileView`, as Obsidian's is (through `TextFileView`). */
export class MarkdownView extends FileView {}
export class Component {
  load(): void {}
  unload(): void {}
}
/**
 * Renders the markdown as plain text in a `div.mock-rendered`, appended to
 * `el` as Obsidian's appends its output (read from obsidian.asar: it never
 * empties `el`). Tests spy on `render` to read its arguments, or to put markup
 * in its place.
 */
export class MarkdownRenderer {
  static async render(
    _app: unknown,
    markdown: string,
    el: HTMLElement,
    _sourcePath: string,
    _component: Component
  ): Promise<void> {
    const rendered = document.createElement('div');
    rendered.className = 'mock-rendered';
    rendered.textContent = markdown;
    el.appendChild(rendered);
  }
}
export const Platform = {
  isMobile: false,
  isMobileApp: false,
  isDesktop: true,
  /** Obsidian recomputes these two from the window size, on mobile only. */
  isPhone: false,
  isTablet: false,
};

/**
 * Mirrors Obsidian's Keymap.isModEvent: a middle click opens a tab whatever
 * keys are held (the app checks the button first), and otherwise Mod-click
 * (Ctrl on Win/Linux, Cmd on macOS) opens a tab, +Alt splits, +Alt+Shift opens
 * a window.
 */
export class Keymap {
  static isModEvent(
    evt?: MouseEvent | KeyboardEvent | TouchEvent | null
  ): 'tab' | 'split' | 'window' | boolean {
    if (!evt) return false;
    if ('button' in evt && evt.button === 1) return 'tab';
    const mod = evt.ctrlKey || evt.metaKey;
    if (mod && evt.altKey) return evt.shiftKey ? 'window' : 'split';
    return mod ? 'tab' : false;
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
