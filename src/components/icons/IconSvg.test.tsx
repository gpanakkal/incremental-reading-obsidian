// @vitest-environment jsdom
import { render, type ComponentChild, type ComponentType } from 'preact';
import { describe, expect, it } from 'vitest';
import { CardCog, CardCogPlus } from './CardCog';
import type { IconProps } from './IconSvg';
import { ScissorsPlus } from './ScissorsPlus';

// #region HELPERS

/** Render a component into a detached jsdom container and return its SVG. */
function mountIcon(node: ComponentChild): SVGSVGElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  render(node as never, container);
  const svg = container.querySelector('svg');
  if (!svg) throw new Error('icon rendered no <svg>');
  return svg;
}

/** Path data of every `<path>` in an icon. */
function pathData(svg: SVGSVGElement): string[] {
  return [...svg.querySelectorAll('path')].map(
    (p) => p.getAttribute('d') ?? ''
  );
}

const ICONS: [string, ComponentType<IconProps>][] = [
  ['CardCog', CardCog],
  ['CardCogPlus', CardCogPlus],
  ['ScissorsPlus', ScissorsPlus],
];

const CORNER_PLUS = ['M16 5h6', 'M19 2v6'];

// #endregion

describe.each(ICONS)('%s', (_, Icon) => {
  it('carries the class that styles.css sizes icons through', () => {
    // `.ir-queue-type-icon svg.lucide` and `.ir-action-bar .clickable-icon
    // svg.lucide` are what apply --icon-size/--icon-stroke. Without `lucide`
    // this icon silently renders at its intrinsic 24px next to 18px siblings.
    // Asserted as a class token, not a substring: `lucide-card-cog` alone
    // contains "lucide" but matches none of those selectors.
    expect(mountIcon(<Icon />).classList.contains('lucide')).toBe(true);
  });

  it('lets callers override its defaults', () => {
    // The action bar tints icons per action (`<Ban stroke="#b4a200" />`), which
    // only works if incoming props are spread after the defaults.
    const svg = mountIcon(<Icon stroke="#b4a200" width={32} />);

    expect(svg.getAttribute('stroke')).toBe('#b4a200');
    expect(svg.getAttribute('width')).toBe('32');
  });

  it('hides itself from the accessibility tree by default', () => {
    // Its containers own the label: an aria-label on the SVG itself both
    // duplicates that and crashes Obsidian's tooltip handler, which assumes
    // every labelled element is an HTMLElement.
    expect(mountIcon(<Icon />).getAttribute('aria-hidden')).toBe('true');
  });
});

describe('create-action icons', () => {
  it('draw the corner plus that sets them apart from the type icons', () => {
    // The action bar's create buttons sit beside the type filter, which draws
    // the plain type glyphs; the plus is the only thing telling them apart.
    expect(pathData(mountIcon(<CardCogPlus />))).toEqual(
      expect.arrayContaining(CORNER_PLUS)
    );
    expect(pathData(mountIcon(<ScissorsPlus />))).toEqual(
      expect.arrayContaining(CORNER_PLUS)
    );
    expect(pathData(mountIcon(<CardCog />))).not.toEqual(
      expect.arrayContaining(CORNER_PLUS)
    );
  });
});
