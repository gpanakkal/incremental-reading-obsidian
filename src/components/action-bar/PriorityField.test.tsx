// @vitest-environment jsdom
import IRScheduler from '#/lib/IRScheduler';
import fc from 'fast-check';
import { type ComponentChild, h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PriorityField } from './PriorityField';

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
  props: Partial<Parameters<typeof PriorityField>[0]> = {},
  container?: HTMLElement
) {
  const onBlur = vi.fn();
  const root = mount(
    <PriorityField initialPriority={30} onBlur={onBlur} {...props} />,
    container
  );
  const input = root.querySelector<HTMLInputElement>('input')!;
  return { root, input, onBlur };
}

/** Types `text` over the field's contents, as one edit. */
function type(input: HTMLInputElement, text: string) {
  void act(() => {
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
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
 * The display priority the field holds after taking `text` over `previous`,
 * which it keeps when `text` is no priority at all.
 */
function keptAfterTyping(previous: number, text: string): number {
  try {
    return IRScheduler.adjustDisplayPriorityOnChange(text);
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

/** Stand-in for what leads the field, such as an icon button. */
const LEADING = h('button', { 'data-leading': '' });

/** Stored priorities: 10-50, shown as 1.0-5.0. */
const priorityArb = fc.integer({ min: 10, max: 50 });

/** Anything a user might type, weighted towards digits and points. */
const typedArb = fc.oneof(
  fc.string(),
  fc.stringMatching(/^[\d.]{0,5}$/),
  fc.stringMatching(/^[\d.a-z -]{0,6}$/)
);
// #endregion

describe('PriorityField', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('shows the stored priority on the display scale', () => {
    fc.assert(
      fc.property(priorityArb, (priority) => {
        const { input } = field({ initialPriority: priority });

        expect(input.value).toBe(String(priority / 10));
        document.body.innerHTML = '';
      })
    );
  });

  it('cleans up each edit, keeping the priority it held when an edit is no priority at all', () => {
    fc.assert(
      fc.property(
        priorityArb,
        fc.array(typedArb, { minLength: 1, maxLength: 4 }),
        (priority, edits) => {
          const { input, onBlur } = field({ initialPriority: priority });
          let kept = priority / 10;

          for (const text of edits) {
            type(input, text);
            const next = keptAfterTyping(kept, text);
            // A cleaned-up edit is shown in place of what was typed
            if (next !== kept) expect(input.value).toBe(String(next));
            kept = next;
          }
          blur(input);

          expect(onBlur).toHaveBeenCalledExactlyOnceWith(
            IRScheduler.transformPriority(kept)
          );
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('saves on Enter by giving up focus', () => {
    const { input, onBlur } = field({ initialPriority: 30 });
    input.focus();
    type(input, '42');

    press(input, 'Enter');

    expect(document.activeElement).not.toBe(input);
    expect(onBlur).toHaveBeenCalledExactlyOnceWith(42);
  });

  it('undoes an edit on Escape and selects the field for another try', () => {
    fc.assert(
      fc.property(priorityArb, typedArb, (priority, text) => {
        const { input, onBlur } = field({ initialPriority: priority });
        input.focus();
        const select = vi.spyOn(input, 'select');
        type(input, text);

        press(input, 'Escape');

        expect(select).toHaveBeenCalled();
        expect(document.activeElement).toBe(input);
        expect(onBlur).not.toHaveBeenCalled();
        blur(input);
        expect(onBlur).toHaveBeenCalledExactlyOnceWith(priority);
        document.body.innerHTML = '';
      })
    );
  });

  it('ignores other keys', () => {
    const { input, onBlur } = field({ initialPriority: 30 });
    input.focus();
    const select = vi.spyOn(input, 'select');
    type(input, '42');

    press(input, 'a');

    expect(input.value).toBe('4.2');
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

  it('follows a new stored priority, but keeps an edit while the stored one stays put', () => {
    fc.assert(
      fc.property(priorityArb, priorityArb, typedArb, (before, after, text) => {
        const { root, input, onBlur } = field({ initialPriority: before });
        type(input, text);
        const edited = IRScheduler.transformPriority(
          keptAfterTyping(before / 10, text)
        );

        field({ initialPriority: before, onBlur }, root);
        field({ initialPriority: after, onBlur }, root);
        if (after !== before) expect(input.value).toBe(String(after / 10));
        blur(input);

        expect(onBlur).toHaveBeenCalledExactlyOnceWith(
          after === before ? edited : after
        );
        document.body.innerHTML = '';
      })
    );
  });

  it('keeps an edit begun after a save when the saved priority comes back as the stored one', () => {
    fc.assert(
      fc.property(
        priorityArb,
        typedArb,
        typedArb,
        (before, first, second) => {
          const { root, input, onBlur } = field({ initialPriority: before });
          type(input, first);
          blur(input);
          const saved = onBlur.mock.lastCall![0] as number;
          type(input, second);
          const edited = IRScheduler.transformPriority(
            keptAfterTyping(saved / 10, second)
          );

          // The save lands while the second edit is still open
          field({ initialPriority: saved, onBlur }, root);
          blur(input);

          expect(onBlur).toHaveBeenLastCalledWith(edited);
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('shows the interval multiplier of the priority it holds only when asked', () => {
    fc.assert(
      fc.property(priorityArb, typedArb, (priority, text) => {
        const shown = field({
          initialPriority: priority,
          showMultiplier: true,
        });
        const hidden = field({ initialPriority: priority });
        type(shown.input, text);
        const multiplier =
          Math.round(
            IRScheduler.getIntervalMultiplier(
              IRScheduler.transformPriority(
                keptAfterTyping(priority / 10, text)
              )
            ) * 100
          ) / 100;

        expect(shown.root.querySelector('label > div')?.textContent).toContain(
          `${multiplier}x`
        );
        expect(hidden.root.querySelector('label > div')).toBeNull();
        document.body.innerHTML = '';
      })
    );
  });

  it('puts what leads it ahead of the label, in place of the label text', () => {
    fc.assert(
      fc.property(priorityArb, fc.boolean(), (priority, showMultiplier) => {
        const { root, input } = field({
          initialPriority: priority,
          showMultiplier,
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
        expect(input.getAttribute('aria-label')).toBeTruthy();
        document.body.innerHTML = '';
      })
    );
  });

  it('is named by its label text when nothing leads it', () => {
    fc.assert(
      fc.property(priorityArb, fc.boolean(), (priority, showMultiplier) => {
        const { root, input } = field({
          initialPriority: priority,
          showMultiplier,
        });
        const label = root.querySelector('label')!;

        expect(textBeforeInput(label).trim()).not.toBe('');
        expect(input.hasAttribute('aria-label')).toBe(false);
        expect(root.querySelector('.ir-priority-container')!.firstChild).toBe(
          label
        );
        document.body.innerHTML = '';
      })
    );
  });
});
