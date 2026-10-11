// @vitest-environment jsdom
import { FakeResizeObserver } from '#/test/pdf-layout';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trackNavbarFootprint } from './navbar-footprint';

// #region HELPERS

/** Where the footprint goes: the property styles.css clears the navbar by. */
const FOOTPRINT_PROP = '--ir-mobile-toolbar-height';

/**
 * A navbar whose rendered height is whatever the test last set, and whose
 * bottom margin is an inline style jsdom's `getComputedStyle` reads back.
 */
function makeNavbar() {
  const navbar = document.createElement('div');
  document.body.append(navbar);
  let height = 0;
  vi.spyOn(navbar, 'getBoundingClientRect').mockImplementation(
    () => ({ height }) as DOMRect
  );
  return {
    navbar,
    set: (next: { height: number; margin: string }) => {
      height = next.height;
      navbar.style.marginBottom = next.margin;
    },
  };
}

/** What the navbar's footprint reads as, in px, or null when unset. */
const footprint = () => {
  const value = document.body.style.getPropertyValue(FOOTPRINT_PROP);
  return value === '' ? null : value;
};

/**
 * The footprint a navbar of this height and margin should report: never below
 * nothing, however far a keyboard pulls the margin under the navbar.
 */
const expected = (height: number, margin: string) =>
  `${Math.max(0, height + (Number.parseFloat(margin) || 0))}px`;

const height = fc.double({ min: 0, max: 1000, noNaN: true });
/**
 * Any bottom margin a navbar's computed style can report: a length, or `auto`,
 * which has no number in it. Obsidian's floating navbar takes the keyboard's
 * height off its margin (`calc(var(--navbar-bottom-offset) -
 * var(--keyboard-height) - 2px)`), so with a keyboard up it can sit far below
 * zero.
 */
const margin = fc.oneof(
  fc
    .double({ min: -2000, max: 200, noNaN: true, noDefaultInfinity: true })
    .map((px) => `${px}px`),
  fc.constant('auto')
);
const layout = fc.record({ height, margin });

/**
 * What can make the navbar's footprint change: a resize, which the browser
 * reports, or the end of a transition — its bottom margin animates without
 * resizing it, so no resize is ever reported for that.
 */
const signal = fc.constantFrom('resize', 'transitionend');

function send(navbar: HTMLElement, kind: 'resize' | 'transitionend') {
  if (kind === 'resize') {
    for (const observer of FakeResizeObserver.instances) observer.fire();
  } else {
    navbar.dispatchEvent(new Event('transitionend', { bubbles: true }));
  }
}

// #endregion

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.removeAttribute('style');
  document.body.replaceChildren();
});

describe('trackNavbarFootprint', () => {
  it("puts the navbar's height plus bottom margin, never below zero, on body at once", () => {
    fc.assert(
      fc.property(layout, ({ height, margin }) => {
        const { navbar, set } = makeNavbar();
        set({ height, margin });

        const stop = trackNavbarFootprint(navbar);
        expect(footprint()).toBe(expected(height, margin));

        stop();
        navbar.remove();
      })
    );
  });

  it('follows the navbar through resizes and through transitions that only move its margin', () => {
    fc.assert(
      fc.property(
        layout,
        fc.array(fc.tuple(layout, signal), { maxLength: 8 }),
        (start, changes) => {
          FakeResizeObserver.instances = [];
          const { navbar, set } = makeNavbar();
          set(start);
          const stop = trackNavbarFootprint(navbar);

          for (const [next, kind] of changes) {
            set(next);
            send(navbar, kind);
            expect(footprint()).toBe(expected(next.height, next.margin));
          }

          stop();
          navbar.remove();
        }
      )
    );
  });

  it('takes the footprint off body and stops following the navbar once stopped', () => {
    fc.assert(
      fc.property(
        layout,
        fc.array(fc.tuple(layout, signal), { maxLength: 8 }),
        (start, changes) => {
          FakeResizeObserver.instances = [];
          const { navbar, set } = makeNavbar();
          set(start);
          const stop = trackNavbarFootprint(navbar);
          stop();
          expect(footprint()).toBeNull();

          for (const [next, kind] of changes) {
            set(next);
            send(navbar, kind);
            expect(footprint()).toBeNull();
          }
          navbar.remove();
        }
      )
    );
  });

  it('leaves other styles on body alone when it stops', () => {
    const { navbar, set } = makeNavbar();
    set({ height: 44, margin: '32px' });
    document.body.style.setProperty('--other', '1px');

    trackNavbarFootprint(navbar)();
    expect(document.body.style.getPropertyValue('--other')).toBe('1px');
  });
});
