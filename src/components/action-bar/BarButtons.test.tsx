// @vitest-environment jsdom
import fc from 'fast-check';
import { type ComponentChild, render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ButtonWithIcon } from './BarButtons';

// #region HELPERS

/** Render `node` into a fresh container in the document and return it. */
function mount(node: ComponentChild): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  render(node as never, container);
  return container;
}

/** The one button rendered in `container`. */
function buttonIn(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector('button');
  if (!button) throw new Error('button not rendered');
  return button;
}

/** The ids of the Obsidian icons drawn in `button`, by their svg classes. */
function iconsIn(button: HTMLElement): string[] {
  return Array.from(button.querySelectorAll('svg')).map(
    (svg) => Array.from(svg.classList).find((c) => c !== 'svg-icon') ?? '(none)'
  );
}

/** A Lucide icon id, as Obsidian names them. */
const iconIdArb = fc
  .stringMatching(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
  .map((name) => `lucide-${name}`);

// #endregion

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('ButtonWithIcon', () => {
  it('property: draws the Obsidian icon it is given, alone, in place of its children', () => {
    fc.assert(
      fc.property(iconIdArb, (icon) => {
        const container = mount(
          <ButtonWithIcon icon={icon} handleClick={() => {}}>
            <span className="child" />
          </ButtonWithIcon>
        );
        const button = buttonIn(container);

        expect(iconsIn(button)).toEqual([icon]);
        expect(button.querySelector('.child')).toBeNull();
        expect(button.childNodes).toHaveLength(1);
        document.body.innerHTML = '';
      })
    );
  });

  it('property: draws the new icon in place of the old when it is given another', () => {
    fc.assert(
      fc.property(iconIdArb, iconIdArb, (first, second) => {
        const container = mount(
          <ButtonWithIcon icon={first} handleClick={() => {}} />
        );
        render(
          (<ButtonWithIcon icon={second} handleClick={() => {}} />) as never,
          container
        );

        expect(iconsIn(buttonIn(container))).toEqual([second]);
        document.body.innerHTML = '';
      })
    );
  });

  it('shows its children, and draws nothing of its own, given no icon', () => {
    const container = mount(
      <ButtonWithIcon handleClick={() => {}}>
        <span className="child" />
      </ButtonWithIcon>
    );
    const button = buttonIn(container);

    expect(button.querySelector('.child')).not.toBeNull();
    expect(iconsIn(button)).toEqual([]);
  });

  it('hands a pointer coming over it to its handler', () => {
    const onPointerOver = vi.fn();
    const container = mount(
      <ButtonWithIcon handleClick={() => {}} onPointerOver={onPointerOver} />
    );
    const event = new Event('pointerover', { bubbles: true });

    buttonIn(container).dispatchEvent(event);

    expect(onPointerOver).toHaveBeenCalledExactlyOnceWith(event);
  });
});
