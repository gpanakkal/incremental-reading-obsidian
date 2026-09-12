// @vitest-environment jsdom
import fc from 'fast-check';
import { type ComponentChild, render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { LoadingSpinner } from './LoadingSpinner';

// #region HELPERS

/** Render a component into a detached jsdom container and return it. */
function mount(node: ComponentChild): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  render(node as never, container);
  return container;
}

/**
 * Render one spinner into a container of its own and hand back the wrapper.
 * Each property case gets a fresh container so a leaked node from a previous
 * case cannot satisfy the next one's query.
 */
function mountSpinner(label: string): HTMLElement {
  const container = mount(<LoadingSpinner label={label} />);
  const wrapper = container.firstElementChild;
  if (!(wrapper instanceof HTMLElement)) {
    throw new Error('spinner rendered no element');
  }
  return wrapper;
}

// #endregion

describe('LoadingSpinner', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('announces the passed label to assistive tech as a live region', () => {
    // Any string is a legal label: callers name the thing being loaded, and
    // item titles reach the UI verbatim, so nothing about the content is
    // constrained. The empty string is included deliberately — it is what a
    // caller passing a missing title would produce.
    fc.assert(
      fc.property(fc.string(), (label) => {
        const wrapper = mountSpinner(label);

        expect(wrapper.getAttribute('role')).toBe('status');
        expect(wrapper.getAttribute('aria-label')).toBe(label);
      })
    );
  });

  it('renders the spinning element inside a single centring wrapper', () => {
    // Both class names are load-bearing: the wrapper carries the layout that
    // makes the indicator take the loading slot's place in its flex column,
    // and the inner element carries the animation. Neither does the other's
    // job, so the structure is asserted rather than just their presence.
    fc.assert(
      fc.property(fc.string(), (label) => {
        const wrapper = mountSpinner(label);

        expect(wrapper.className).toBe('ir-loading');
        expect(wrapper.children.length).toBe(1);
        const spinner = wrapper.firstElementChild;
        expect(spinner?.className).toBe('ir-spinner');
        // Purely visual: the label is the accessible name, so duplicating it
        // as text would have screen readers announce the status twice.
        expect(spinner?.textContent).toBe('');
      })
    );
  });
});
