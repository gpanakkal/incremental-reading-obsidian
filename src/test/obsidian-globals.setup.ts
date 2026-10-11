/**
 * Polyfills the DOM helpers Obsidian injects at runtime: the global
 * `createEl` / `createDiv` / `createSpan` / `createFragment` factories, the
 * appending `createEl` / `createDiv` / `createSpan` methods on `Node`, and the
 * `activeDocument` / `activeWindow` bindings.
 *
 * The `obsidianmd` lint rules require plugin code to use these in place of the
 * plain `document.*` APIs, so source files reach for them and jsdom has no idea
 * what they are. Registered through `setupFiles`, which runs before any module
 * under test is imported.
 *
 * No-op under the `node` test environment — there is no DOM there to augment.
 */

/** The subset of Obsidian's `DomElementInfo` worth supporting in tests. */
interface DomElementInfo {
  cls?: string | string[];
  text?: string | DocumentFragment;
  attr?: Record<string, string | number | boolean | null>;
  parent?: Node;
  prepend?: boolean;
  title?: string;
  value?: string;
  type?: string;
  placeholder?: string;
  href?: string;
}

/** A bare string is shorthand for `{ cls }`, matching Obsidian's behaviour. */
type ElementInfo = DomElementInfo | string;

function applyElementInfo(el: HTMLElement, info?: ElementInfo): void {
  if (info === undefined) return;
  if (typeof info === 'string') {
    el.className = info;
    return;
  }

  const { cls, text, attr, parent, prepend, ...props } = info;

  if (cls !== undefined) {
    el.className = Array.isArray(cls) ? cls.join(' ') : cls;
  }
  if (typeof text === 'string') {
    el.textContent = text;
  } else if (text !== undefined) {
    el.appendChild(text);
  }
  if (attr !== undefined) {
    for (const [name, value] of Object.entries(attr)) {
      if (value === null || value === false) {
        el.removeAttribute(name);
      } else {
        el.setAttribute(name, String(value));
      }
    }
  }
  // title / value / type / placeholder / href are set as properties, not attrs
  const element = el as unknown as Record<string, unknown>;
  for (const [name, value] of Object.entries(props)) {
    if (value !== undefined) element[name] = value;
  }
  if (parent !== undefined) {
    if (prepend === true) {
      parent.insertBefore(el, parent.firstChild);
    } else {
      parent.appendChild(el);
    }
  }
}

function createEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  info?: ElementInfo,
  callback?: (el: HTMLElementTagNameMap[K]) => void
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyElementInfo(el, info);
  callback?.(el);
  return el;
}

function installObsidianDomGlobals(): void {
  if (typeof document === 'undefined') return;

  const helpers = {
    createEl,
    createDiv: (info?: ElementInfo, callback?: (el: HTMLDivElement) => void) =>
      createEl('div', info, callback),
    createSpan: (
      info?: ElementInfo,
      callback?: (el: HTMLSpanElement) => void
    ) => createEl('span', info, callback),
    createFragment: (callback?: (frag: DocumentFragment) => void) => {
      const frag = document.createDocumentFragment();
      callback?.(frag);
      return frag;
    },
  };

  // Obsidian exposes the factories as bare globals, which make a detached
  // element, and as `Node` methods, which append the element to the node they
  // are called on (`Node.prototype.createEl` passes `parent: this`; see
  // enhance.js in obsidian.asar). On a `Document` that append throws, as it
  // does in Obsidian: a detached element comes from the global only.
  const globalScope = globalThis as unknown as Record<string, unknown>;
  const nodeProto = Node.prototype as unknown as Record<string, unknown>;
  for (const [name, helper] of Object.entries(helpers)) {
    globalScope[name] = helper;
  }
  const appendTo = (parent: Node, info?: ElementInfo): DomElementInfo => ({
    ...(typeof info === 'string' ? { cls: info } : info),
    parent,
  });
  nodeProto.createEl = function <K extends keyof HTMLElementTagNameMap>(
    this: Node,
    tag: K,
    info?: ElementInfo,
    callback?: (el: HTMLElementTagNameMap[K]) => void
  ) {
    return createEl(tag, appendTo(this, info), callback);
  };
  nodeProto.createDiv = function (
    this: Node,
    info?: ElementInfo,
    callback?: (el: HTMLDivElement) => void
  ) {
    return createEl('div', appendTo(this, info), callback);
  };
  nodeProto.createSpan = function (
    this: Node,
    info?: ElementInfo,
    callback?: (el: HTMLSpanElement) => void
  ) {
    return createEl('span', appendTo(this, info), callback);
  };

  // Getters, not values: Obsidian resolves these per popout window, and each
  // jsdom test file gets a fresh document.
  Object.defineProperty(globalThis, 'activeDocument', {
    configurable: true,
    get: () => document,
  });
  Object.defineProperty(globalThis, 'activeWindow', {
    configurable: true,
    get: () => window,
  });
}

installObsidianDomGlobals();

export {};
