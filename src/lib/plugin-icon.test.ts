// @vitest-environment jsdom
import { getIconIds, removeIcon, setIcon } from 'obsidian';
import { afterEach, describe, expect, it } from 'vitest';
import { PLUGIN_ICON } from './constants';
import { registerPluginIcon } from './plugin-icon';

// #region HELPERS

/** The icon as Obsidian draws it into a button once registered. */
function drawnIcon(): SVGSVGElement {
  const button = document.createElement('div');
  setIcon(button, PLUGIN_ICON);
  const svg = button.firstChild;
  if (!(svg instanceof SVGSVGElement)) throw new Error('no icon drawn');
  return svg;
}

/** The 24-unit drawing nested inside Obsidian's 100-unit icon shell. */
function drawing(): SVGSVGElement {
  const inner = drawnIcon().querySelector(':scope > svg');
  if (!(inner instanceof SVGSVGElement)) throw new Error('no nested drawing');
  return inner;
}

// #endregion

afterEach(() => {
  removeIcon(PLUGIN_ICON);
});

describe('registerPluginIcon', () => {
  it('registers the icon under the plugin icon id', () => {
    expect(getIconIds()).not.toContain(PLUGIN_ICON);

    registerPluginIcon();

    expect(getIconIds()).toContain(PLUGIN_ICON);
    expect(drawnIcon().classList.contains(PLUGIN_ICON)).toBe(true);
  });

  it('draws on a Lucide 24-unit grid filling the whole icon', () => {
    registerPluginIcon();

    const inner = drawing();
    expect(inner.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(inner.getAttribute('width')).toBe('100%');
    expect(inner.getAttribute('height')).toBe('100%');
  });

  it('strokes in the text colour with round ends, unfilled, like Lucide', () => {
    registerPluginIcon();

    const inner = drawing();
    expect(inner.getAttribute('stroke')).toBe('currentColor');
    expect(inner.getAttribute('fill')).toBe('none');
    expect(inner.getAttribute('stroke-linecap')).toBe('round');
    expect(inner.getAttribute('stroke-linejoin')).toBe('round');
  });

  it("leaves stroke width to Obsidian's icon stroke token", () => {
    // `svg.svg-icon { stroke-width: var(--icon-stroke) }` reaches the paths
    // only by inheritance; a width set anywhere inside would pin it.
    registerPluginIcon();

    const icon = drawnIcon();
    expect(icon.querySelectorAll('[stroke-width]')).toHaveLength(0);
    expect(icon.querySelectorAll('[style]')).toHaveLength(0);
  });

  it('draws the book and the gear', () => {
    registerPluginIcon();

    const inner = drawing();
    // The gear's hub, in the bottom-right corner
    const hub = inner.querySelector('circle');
    expect(Number(hub?.getAttribute('cx'))).toBeGreaterThan(12);
    expect(Number(hub?.getAttribute('cy'))).toBeGreaterThan(12);
    // Book outline, spine, three text lines and eight gear teeth
    expect(inner.querySelectorAll('path')).toHaveLength(13);
  });
});
