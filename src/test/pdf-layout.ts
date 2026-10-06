/**
 * A stand-in layout for a PDF page's text layer and highlight overlay in
 * jsdom, which lays nothing out. Character `char` of the item with `data-idx`
 * `idx` sits at `TEXT_LEFT + char * CHAR_WIDTH` across and
 * `TEXT_TOP + idx * LINE_HEIGHT` down, `CHAR_WIDTH` wide and `TEXT_HEIGHT`
 * tall. Every highlight overlay has the rect `frame()`, and a box in one the
 * rect its percentages give in that.
 */
import { vi } from 'vitest';

export const TEXT_LEFT = 40;
export const TEXT_TOP = 30;
export const CHAR_WIDTH = 7;
export const LINE_HEIGHT = 13;
export const TEXT_HEIGHT = 10;

export interface FakeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function rect({ left, top, width, height }: FakeRect) {
  return {
    left,
    top,
    width,
    height,
    x: left,
    y: top,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

/** Where the fake layout puts characters `start` to `end` of item `idx`. */
export function charsRect(idx: number, start: number, end: number): FakeRect {
  return {
    left: TEXT_LEFT + start * CHAR_WIDTH,
    top: TEXT_TOP + idx * LINE_HEIGHT,
    width: (end - start) * CHAR_WIDTH,
    height: TEXT_HEIGHT,
  };
}

/** How many characters of `item` come before `node`, one of its text nodes. */
function charsBefore(item: Element, node: Node) {
  const walker = item.ownerDocument.createTreeWalker(
    item,
    NodeFilter.SHOW_TEXT
  );
  let count = 0;
  for (let at = walker.nextNode(); at && at !== node; at = walker.nextNode()) {
    count += (at as Text).length;
  }
  return count;
}

const percent = (value: string) => Number.parseFloat(value) / 100;

/**
 * Lay out every text layer and highlight overlay in `win` as above until the
 * returned `restore` is called. `rangeRects` counts the measuring of text.
 */
export function fakePdfLayout(
  frame: () => FakeRect,
  win: typeof globalThis = globalThis
) {
  const { Range, Element } = win;
  const rangeRects = vi.fn(function (this: Range) {
    const node = this.startContainer;
    const item = node.parentElement?.closest('[data-idx]');
    // Only ranges inside one text node of an item are laid out
    if (!item || node !== this.endContainer || node.nodeType !== 3) return [];
    const from = charsBefore(item, node) + this.startOffset;
    const to = charsBefore(item, node) + this.endOffset;
    return [rect(charsRect(Number(item.getAttribute('data-idx')), from, to))];
  });
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: rangeRects,
  });
  const elementRect = vi
    .spyOn(Element.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: Element) {
      if (this.classList.contains('ir-pdf-highlights')) return rect(frame());
      const overlay = this.parentElement;
      if (overlay?.classList.contains('ir-pdf-highlights')) {
        const f = frame();
        const { style } = this as HTMLElement;
        return rect({
          left: f.left + percent(style.left) * f.width,
          top: f.top + percent(style.top) * f.height,
          width: percent(style.width) * f.width,
          height: percent(style.height) * f.height,
        });
      }
      return rect({ left: 0, top: 0, width: 0, height: 0 });
    });
  return {
    rangeRects,
    elementRect,
    restore() {
      delete (Range.prototype as Partial<Range>).getClientRects;
      elementRect.mockRestore();
    },
  };
}

/**
 * A fake `ResizeObserver` the test fires by hand, standing in for the browser
 * reporting a viewer resized or shown. jsdom has none.
 */
export class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  constructor(readonly callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  disconnect() {
    this.observed = [];
  }
  /** Report a resize, if it watches anything. */
  fire() {
    if (this.observed.length > 0) this.callback();
  }
}
