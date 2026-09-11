// @vitest-environment jsdom
import type { ComponentChild } from 'preact';
import { render } from 'preact';
import { describe, expect, it } from 'vitest';
import { CardCog } from './CardCog';

// #region HELPERS

/** Render a component into a detached jsdom container and return its SVG. */
function mountIcon(node: ComponentChild): SVGSVGElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  render(node as never, container);
  const svg = container.querySelector('svg');
  if (!svg) throw new Error('CardCog rendered no <svg>');
  return svg;
}

// #endregion

describe('CardCog', () => {
  it('carries the class that styles.css sizes icons through', () => {
    // `.ir-queue-type-icon svg.lucide` and `.ir-action-bar .clickable-icon
    // svg.lucide` are what apply --icon-size/--icon-stroke. Without `lucide`
    // this icon silently renders at its intrinsic 24px next to 18px siblings.
    // Asserted as a class token, not a substring: `lucide-card-cog` alone
    // contains "lucide" but matches none of those selectors.
    expect(mountIcon(<CardCog />).classList.contains('lucide')).toBe(true);
  });

  it('lets callers override its defaults', () => {
    // The action bar tints icons per action (`<Ban stroke="#b4a200" />`), which
    // only works if incoming props are spread after the defaults.
    const svg = mountIcon(<CardCog stroke="#b4a200" width={32} />);

    expect(svg.getAttribute('stroke')).toBe('#b4a200');
    expect(svg.getAttribute('width')).toBe('32');
  });

  it('hides itself from the accessibility tree by default', () => {
    // Its containers own the label: an aria-label on the SVG itself both
    // duplicates that and crashes Obsidian's tooltip handler, which assumes
    // every labelled element is an HTMLElement.
    expect(mountIcon(<CardCog />).getAttribute('aria-hidden')).toBe('true');
  });
});
