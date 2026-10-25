// @vitest-environment jsdom
import {
  MAXIMUM_FIXED_REVIEW_INTERVAL,
  MINIMUM_FIXED_REVIEW_INTERVAL,
} from '#/lib/constants';
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
/** Saves on Enter, which only gives up focus the field has. */
function enter(input: HTMLInputElement) {
  void act(() => {
    input.focus();
  });
  press(input, 'Enter');
}

/** The interval the field shows for a stored `interval`. */
function shown(interval: number | null): string {
  return String(interval ?? MINIMUM_FIXED_REVIEW_INTERVAL);
}

/** Text that is no interval at all, so cleans up to whatever is held. */
const notAnIntervalArb = fc.stringMatching(/^[^\d]{0,4}$/);

/** Text that changes nothing when typed over a field holding `interval`. */
function noOpArb(interval: number): fc.Arbitrary<string> {
  const options = [notAnIntervalArb];
  if (interval <= MAXIMUM_FIXED_REVIEW_INTERVAL) {
    options.push(
      fc.constantFrom(`${interval}`, `0${interval}`, `-${interval}`),
      // Fractions are cut off
      fc.stringMatching(/^\d{1,2}$/).map((tail) => `${interval}.${tail}`)
    );
  }
  // Clamped down or up into range
  if (interval === MAXIMUM_FIXED_REVIEW_INTERVAL) {
    options.push(
      fc
        .integer({ min: MAXIMUM_FIXED_REVIEW_INTERVAL + 1, max: 99_999 })
        .map(String)
    );
  }
  if (interval === MINIMUM_FIXED_REVIEW_INTERVAL) {
    options.push(fc.constantFrom('0', '-0', '0.5', '-1'));
  }
  return fc.oneof(...options);
}

/** A stored interval, with text that changes nothing typed over it. */
const noOpEditArb = intervalArb.chain((interval) =>
  fc.tuple(
    fc.constant(interval),
    noOpArb(interval ?? MINIMUM_FIXED_REVIEW_INTERVAL)
  )
);

/** Intervals typing can reach, so the no-op texts include real numbers. */
const reachableArb = fc.integer({
  min: MINIMUM_FIXED_REVIEW_INTERVAL,
  max: MAXIMUM_FIXED_REVIEW_INTERVAL,
});

/** What a user does to the field, or a new stored interval from outside. */
type Step =
  | { kind: 'type'; text: string }
  | { kind: 'escape' | 'blur' | 'enter' }
  | { kind: 'stored'; interval: number | null };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 4,
    arbitrary: typedArb.map((text): Step => ({ kind: 'type', text })),
  },
  {
    weight: 3,
    arbitrary: reachableArb
      .chain(noOpArb)
      .map((text): Step => ({ kind: 'type', text })),
  },
  { weight: 1, arbitrary: fc.constant<Step>({ kind: 'escape' }) },
  { weight: 1, arbitrary: fc.constant<Step>({ kind: 'blur' }) },
  { weight: 1, arbitrary: fc.constant<Step>({ kind: 'enter' }) },
  {
    weight: 2,
    arbitrary: fc
      .option(reachableArb, { nil: null })
      .map((interval): Step => ({ kind: 'stored', interval })),
  }
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

  it('keeps what was typed on screen while an edit that changes nothing is open', () => {
    fc.assert(
      fc.property(noOpEditArb, ([interval, text]) => {
        const { input, onBlur } = field({ initialInterval: interval });
        const held = interval ?? MINIMUM_FIXED_REVIEW_INTERVAL;

        const read = type(input, text);

        expect(keptAfterTyping(held, read)).toBe(held);
        // Clearing the field to type another number must work
        expect(input.value).toBe(read);
        expect(onBlur).not.toHaveBeenCalled();
        document.body.innerHTML = '';
      })
    );
  });

  it('shows the stored interval, not what was typed, once an edit that changes nothing ends', () => {
    fc.assert(
      fc.property(
        noOpEditArb,
        fc.constantFrom('blur', 'enter', 'escape'),
        ([interval, text], end) => {
          const { input, onBlur } = field({ initialInterval: interval });

          type(input, text);
          if (end === 'blur') blur(input);
          else if (end === 'enter') enter(input);
          else press(input, 'Escape');

          expect(input.value).toBe(shown(interval));
          if (end === 'escape') expect(onBlur).not.toHaveBeenCalled();
          else
            expect(onBlur).toHaveBeenCalledExactlyOnceWith(
              interval ?? MINIMUM_FIXED_REVIEW_INTERVAL
            );
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('undoes any edit on Escape, showing the stored interval before selecting it', () => {
    fc.assert(
      fc.property(
        intervalArb,
        fc.array(fc.oneof(typedArb, reachableArb.chain(noOpArb)), {
          minLength: 1,
          maxLength: 4,
        }),
        (interval, edits) => {
          const { input, onBlur } = field({ initialInterval: interval });
          input.focus();
          for (const text of edits) type(input, text);
          // A value set after select() would drop the selection
          let selected: string | null = null;
          vi.spyOn(input, 'select').mockImplementation(() => {
            selected = input.value;
          });

          press(input, 'Escape');

          expect(selected).toBe(shown(interval));
          expect(input.value).toBe(shown(interval));
          blur(input);
          expect(onBlur).toHaveBeenCalledExactlyOnceWith(
            interval ?? MINIMUM_FIXED_REVIEW_INTERVAL
          );
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('undoes an edit begun after a save back to the saved interval, though the save has yet to come back', () => {
    fc.assert(
      fc.property(
        intervalArb,
        typedArb,
        typedArb,
        fc.boolean(),
        (before, first, second, rerendered) => {
          const { root, input, onBlur } = field({ initialInterval: before });
          type(input, first);
          blur(input);
          const saved = onBlur.mock.lastCall![0] as number;
          // Whatever shows the field may render it again with its old interval
          if (rerendered) field({ initialInterval: before, onBlur }, root);
          expect(input.value).toBe(String(saved));
          type(input, second);

          press(input, 'Escape');

          expect(input.value).toBe(String(saved));
          blur(input);
          expect(onBlur).toHaveBeenLastCalledWith(saved);
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('shows a new stored interval in place of an open edit, even one that cleans up to it', () => {
    fc.assert(
      fc.property(
        intervalArb,
        reachableArb.chain((i) => fc.tuple(fc.constant(i), noOpArb(i))),
        typedArb,
        (before, [after, text], first) => {
          fc.pre(after !== before);
          const { root, input, onBlur } = field({ initialInterval: before });
          // Get the field holding `after` so that `text` changes nothing
          type(input, first);
          type(input, String(after));
          type(input, text);

          field({ initialInterval: after, onBlur }, root);

          expect(input.value).toBe(String(after));
          blur(input);
          expect(onBlur).toHaveBeenCalledExactlyOnceWith(after);
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('shows and saves what each step calls for, over any run of edits, saves, undos and new stored intervals', () => {
    fc.assert(
      fc.property(
        intervalArb,
        fc.array(stepArb, { minLength: 1, maxLength: 12 }),
        (initial, steps) => {
          const { root, input, onBlur } = field({ initialInterval: initial });
          // What the user expects: the interval last stored, from outside or
          // saved here, and the edit open on top of it
          let stored = initial;
          let seen = initial;
          let edit: { held: number; shown: string } | null = null;
          let saves = 0;

          for (const step of steps) {
            if (step.kind === 'type') {
              const held: number = edit
                ? edit.held
                : (stored ?? MINIMUM_FIXED_REVIEW_INTERVAL);
              const read = type(input, step.text);
              const next = keptAfterTyping(held, read);
              edit = { held: next, shown: next === held ? read : String(next) };
            } else if (step.kind === 'escape') {
              press(input, 'Escape');
              edit = null;
            } else if (step.kind === 'stored') {
              field({ initialInterval: step.interval, onBlur }, root);
              if (
                step.interval !== seen &&
                step.interval !== null &&
                step.interval !== stored
              ) {
                stored = step.interval;
                edit = null;
              }
              seen = step.interval;
            } else {
              const held: number = edit
                ? edit.held
                : (stored ?? MINIMUM_FIXED_REVIEW_INTERVAL);
              if (step.kind === 'blur') blur(input);
              else enter(input);
              stored = held;
              edit = null;
              saves++;
              expect(onBlur).toHaveBeenLastCalledWith(held);
            }

            expect(input.value).toBe(edit ? edit.shown : shown(stored));
            expect(onBlur).toHaveBeenCalledTimes(saves);
          }
          document.body.innerHTML = '';
        }
      )
    );
  });
});
