// @vitest-environment jsdom
import { CardManager } from '#/lib/items/CardManager';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import fc from 'fast-check';
import { MarkdownRenderer } from 'obsidian';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardViewer } from './CardViewer';
import * as ReviewContext from './ReviewContext';

// #region HELPERS

const CARD_PATH = 'cards/Card.md';

/**
 * Mount the viewer over a card whose rendered question holds a link to
 * `href` and some plain text, recording what the workspace is asked to open.
 */
function mountCard(href = 'Target note#Heading') {
  const openLinkText = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(ReviewContext, 'useReviewContext').mockReturnValue({
    reviewView: { app: { workspace: { openLinkText } } },
  } as never);
  vi.spyOn(Obsidian, 'splitFrontMatter').mockReturnValue({
    frontMatter: '',
    body: 'question',
  });
  vi.spyOn(CardManager, 'hideAnswer').mockImplementation((body) => body);
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(
    async (_app, _md, el) => {
      const link = el.appendChild(document.createElement('a'));
      link.className = 'internal-link';
      link.dataset.href = href;
      link.textContent = 'a link';
      const inner = link.appendChild(document.createElement('span'));
      inner.className = 'inner';
      const plain = el.appendChild(document.createElement('span'));
      plain.className = 'plain';
    }
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  void act(() => {
    render(
      <CardViewer cardText="card text" cardFilePath={CARD_PATH} />,
      container
    );
  });
  const link = container.querySelector<HTMLElement>('a.internal-link')!;
  const plain = container.querySelector<HTMLElement>('.plain')!;
  return { container, openLinkText, link, plain };
}

/** Modifier keys a click can carry, any combination. */
const modifiersArb = fc.record({
  ctrlKey: fc.boolean(),
  metaKey: fc.boolean(),
  altKey: fc.boolean(),
  shiftKey: fc.boolean(),
});

/** Where Obsidian opens a left click with these keys: see `Keymap.isModEvent`. */
function paneForKeys(keys: {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string | false {
  if (!keys.ctrlKey && !keys.metaKey) return false;
  if (!keys.altKey) return 'tab';
  return keys.shiftKey ? 'window' : 'split';
}

function fire(
  el: Element,
  type: 'click' | 'auxclick' | 'mousedown',
  init: MouseEventInit
): MouseEvent {
  const evt = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  el.dispatchEvent(evt);
  return evt;
}

// #endregion

beforeEach(() => {
  // Obsidian's DOM extension, which jsdom lacks
  if (!('empty' in HTMLElement.prototype)) {
    Object.defineProperty(HTMLElement.prototype, 'empty', {
      configurable: true,
      value(this: HTMLElement) {
        this.replaceChildren();
      },
    });
  }
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('CardViewer links', () => {
  it('opens a clicked link where its modifier keys say, as a note does', () => {
    fc.assert(
      fc.property(
        modifiersArb,
        fc.boolean(),
        fc.string({ minLength: 1 }),
        (keys, onInner, href) => {
          document.body.innerHTML = '';
          vi.restoreAllMocks();
          const { openLinkText, link } = mountCard(href);
          const target = onInner ? link.querySelector('.inner')! : link;

          const evt = fire(target, 'click', { button: 0, ...keys });

          expect(openLinkText).toHaveBeenCalledExactlyOnceWith(
            href,
            CARD_PATH,
            paneForKeys(keys)
          );
          expect(evt.defaultPrevented).toBe(true);
        }
      )
    );
  });

  it('opens a middle-clicked link in a new tab, whatever keys are held', () => {
    fc.assert(
      fc.property(modifiersArb, (keys) => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
        const { openLinkText, link } = mountCard();

        const evt = fire(link, 'auxclick', { button: 1, ...keys });

        expect(openLinkText).toHaveBeenCalledExactlyOnceWith(
          'Target note#Heading',
          CARD_PATH,
          'tab'
        );
        expect(evt.defaultPrevented).toBe(true);
      })
    );
  });

  it("leaves a right click's menu, and clicks off a link, alone", () => {
    const { openLinkText, link, plain } = mountCard();

    const right = fire(link, 'auxclick', { button: 2 });
    const off = fire(plain, 'click', { button: 0 });
    const offMiddle = fire(plain, 'auxclick', { button: 1 });

    expect(openLinkText).not.toHaveBeenCalled();
    expect(right.defaultPrevented).toBe(false);
    expect(off.defaultPrevented).toBe(false);
    expect(offMiddle.defaultPrevented).toBe(false);
  });

  it('claims a middle press on a link, so it neither autoscrolls nor pastes', () => {
    const { link, plain } = mountCard();

    expect(fire(link, 'mousedown', { button: 1 }).defaultPrevented).toBe(true);
    expect(fire(link, 'mousedown', { button: 0 }).defaultPrevented).toBe(false);
    expect(fire(plain, 'mousedown', { button: 1 }).defaultPrevented).toBe(
      false
    );
  });

  it('stops listening once unmounted', () => {
    const { container, openLinkText, link } = mountCard();
    void act(() => render(null, container));

    fire(link, 'click', { button: 0 });
    fire(link, 'auxclick', { button: 1 });
    const press = fire(link, 'mousedown', { button: 1 });

    expect(openLinkText).not.toHaveBeenCalled();
    expect(press.defaultPrevented).toBe(false);
  });
});

describe('CardViewer layout', () => {
  it('marks its preview as a card, the hook the centered layout keys on', () => {
    // styles.css centers the card's text (or drops it below a top bar) only
    // inside `.ir-card-preview`; articles and snippets never render here, so
    // they keep the plain preview layout.
    const { container, plain } = mountCard();

    const preview = container.firstElementChild!;
    expect(preview.classList).toContain('ir-card-preview');
    expect(plain.closest('.ir-card-preview')).toBe(preview);
  });
});
