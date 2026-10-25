// @vitest-environment jsdom
import { MINIMUM_FIXED_REVIEW_INTERVAL } from '#/lib/constants';
import IRScheduler from '#/lib/IRScheduler';
import fc from 'fast-check';
import { type ComponentChild, h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FixedIntervalField } from './FixedIntervalField';

// #region HELPERS
function mount(node: ComponentChild, container?: HTMLElement): HTMLElement {
  const target = container ?? document.createElement('div');
  if (!container) document.body.appendChild(target);
  void act(() => {
    render(node, target);
  });
  return target;
}

function field(
  props: Partial<Parameters<typeof FixedIntervalField>[0]> = {},
  container?: HTMLElement
) {
  const onBlur = vi.fn();
  const root = mount(
    <FixedIntervalField initialInterval={7} onBlur={onBlur} {...props} />,
    container
  );
  const input = root.querySelector<HTMLInputElement>('input')!;
  return { root, input, onBlur };
}

/**
 * Types `text` over the field's contents, as one edit, and returns what the
 * field reads back from it: a number input drops text that is no number.
 */
function type(input: HTMLInputElement, text: string): string {
  let read = '';
  void act(() => {
    input.value = text;
    read = input.value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return read;
}

function press(input: HTMLInputElement, key: string) {
  void act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

function blur(input: HTMLInputElement) {
  // preact/compat listens for `onBlur` as focusout
  void act(() => {
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

/**
 * The interval the field holds after reading `text` over `previous`, which it
 * keeps when `text` is no interval at all.
 */
function keptAfterTyping(previous: number, text: string): number {
  try {
    return IRScheduler.adjustFixedIntervalOnChange(text);
  } catch {
    return previous;
  }
}

/** The text a label shows ahead of its input. */
function textBeforeInput(label: HTMLLabelElement): string {
  let text = '';
  for (const node of Array.from(label.childNodes)) {
    if (node instanceof HTMLInputElement) break;
    text += node.textContent ?? '';
  }
  return text;
}

/** The text a label shows after its input. */
function textAfterInput(label: HTMLLabelElement): string {
  const nodes = Array.from(label.childNodes);
  const input = nodes.findIndex((node) => node instanceof HTMLInputElement);
  return nodes
    .slice(input + 1)
    .map((node) => node.textContent ?? '')
    .join('');
}

/** Stand-in for what leads the field, such as an icon button. */
const LEADING = h('button', { 'data-leading': '' });

/** A stored interval, or none for a text not on one yet. */
const intervalArb = fc.option(fc.integer({ min: 1, max: 10_000 }), {
  nil: null,
});

/** Anything a user might type, weighted towards numbers. */
const typedArb = fc.oneof(
  fc.string(),
  fc.stringMatching(/^-?\d{0,4}(\.\d{0,2})?$/),
  fc.integer({ min: -100, max: 100 }).map(String)
);
// #endregion

describe('FixedIntervalField', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('shows the stored interval, or the shortest one when there is none', () => {
    fc.assert(
      fc.property(intervalArb, (interval) => {
        const { input } = field({ initialInterval: interval });

        expect(input.value).toBe(
          String(interval ?? MINIMUM_FIXED_REVIEW_INTERVAL)
        );
        document.body.innerHTML = '';
      })
    );
  });

  it('cleans up each edit, keeping the interval it held when an edit is no interval at all', () => {
    fc.assert(
      fc.property(
        intervalArb,
        fc.array(typedArb, { minLength: 1, maxLength: 4 }),
        (interval, edits) => {
          const { input, onBlur } = field({ initialInterval: interval });
          let kept = interval ?? MINIMUM_FIXED_REVIEW_INTERVAL;

          for (const text of edits) {
            const next = keptAfterTyping(kept, type(input, text));
            // A cleaned-up edit is shown in place of what was typed
            if (next !== kept) expect(input.value).toBe(String(next));
            kept = next;
          }
          blur(input);

          expect(onBlur).toHaveBeenCalledExactlyOnceWith(kept);
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('saves on Enter by giving up focus', () => {
    const { input, onBlur } = field({ initialInterval: 7 });
    input.focus();
    type(input, '12');

    press(input, 'Enter');

    expect(document.activeElement).not.toBe(input);
    expect(onBlur).toHaveBeenCalledExactlyOnceWith(12);
  });

  it('selects the field on Escape without saving', () => {
    const { input, onBlur } = field({ initialInterval: 7 });
    input.focus();
    const select = vi.spyOn(input, 'select');
    type(input, '12');

    press(input, 'Escape');

    expect(select).toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    expect(onBlur).not.toHaveBeenCalled();
  });

  it('ignores other keys', () => {
    const { input, onBlur } = field({ initialInterval: 7 });
    input.focus();
    const select = vi.spyOn(input, 'select');
    type(input, '12');

    press(input, 'a');

    expect(input.value).toBe('12');
    expect(select).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    expect(onBlur).not.toHaveBeenCalled();
  });

  it('selects its contents when focused', () => {
    const { input } = field();
    const select = vi.spyOn(input, 'select');

    void act(() => {
      input.focus();
    });

    expect(select).toHaveBeenCalled();
  });

  it('follows a new stored interval, but keeps an edit while there is no new one', () => {
    fc.assert(
      fc.property(intervalArb, intervalArb, typedArb, (before, after, text) => {
        const { root, input, onBlur } = field({ initialInterval: before });
        const edited = keptAfterTyping(
          before ?? MINIMUM_FIXED_REVIEW_INTERVAL,
          type(input, text)
        );

        field({ initialInterval: before, onBlur }, root);
        field({ initialInterval: after, onBlur }, root);
        const follows = after !== null && after !== before;
        if (follows) expect(input.value).toBe(String(after));
        blur(input);

        expect(onBlur).toHaveBeenCalledExactlyOnceWith(
          follows ? after : edited
        );
        document.body.innerHTML = '';
      })
    );
  });

  it('keeps an edit begun after a save when the saved interval comes back as the stored one', () => {
    fc.assert(
      fc.property(intervalArb, typedArb, typedArb, (before, first, second) => {
        const { root, input, onBlur } = field({ initialInterval: before });
        type(input, first);
        blur(input);
        const saved = onBlur.mock.lastCall![0] as number;
        const edited = keptAfterTyping(saved, type(input, second));

        // The save lands while the second edit is still open
        field({ initialInterval: saved, onBlur }, root);
        blur(input);

        expect(onBlur).toHaveBeenLastCalledWith(edited);
        document.body.innerHTML = '';
      })
    );
  });

  it('puts what leads it ahead of the label, in place of the label text', () => {
    fc.assert(
      fc.property(intervalArb, (interval) => {
        const { root, input } = field({
          initialInterval: interval,
          leading: LEADING,
        });
        const label = root.querySelector('label')!;
        const leading = root.querySelector('[data-leading]')!;

        expect(leading).not.toBeNull();
        // Outside the label, so a click on it is never handed to the input
        expect(leading.closest('label')).toBeNull();
        expect(
          leading.compareDocumentPosition(label) &
            Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy();
        expect(textBeforeInput(label).trim()).toBe('');
        expect(textAfterInput(label).trim()).toBe('');
        expect(input.getAttribute('aria-label')).toBeTruthy();
        document.body.innerHTML = '';
      })
    );
  });

  it('is named by its label text when nothing leads it', () => {
    fc.assert(
      fc.property(intervalArb, (interval) => {
        const { root, input } = field({ initialInterval: interval });
        const label = root.querySelector('label')!;

        expect(textBeforeInput(label).trim()).not.toBe('');
        expect(textAfterInput(label).trim()).not.toBe('');
        expect(input.hasAttribute('aria-label')).toBe(false);
        expect(
          root.querySelector('.ir-fixed-interval-container')!.firstChild
        ).toBe(label);
        document.body.innerHTML = '';
      })
    );
  });
});
