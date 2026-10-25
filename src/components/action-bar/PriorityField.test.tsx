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

/**
 * Types `text` over the field's contents, as one edit, and returns what the
 * field reads back from it: a text input drops line breaks.
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

/** Saves on Enter, which only gives up focus the field has. */
function enter(input: HTMLInputElement) {
  void act(() => {
    input.focus();
  });
  press(input, 'Enter');
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
/** Inserts each of `noise`'s characters into `text` at its position. */
function sprinkle(text: string, noise: [number, string][]): string {
  let out = text;
  for (const [at, char] of noise) {
    const i = at % (out.length + 1);
    out = out.slice(0, i) + char + out.slice(i);
  }
  return out;
}

/** Text that cleans up to the display priority of `priority`. */
function cleansToArb(priority: number): fc.Arbitrary<string> {
  const [whole, tenth] = (priority / 10).toFixed(1).split('.');
  // Digits past the first two are dropped, so these take any more
  const extendable = [`${whole}.${tenth}`, `${whole}${tenth}`];
  const ending = tenth === '0' ? [whole, `${whole}.`] : [];
  // Clamped up or down into range
  if (priority === 10) extendable.push('0', '.5', '0.9');
  if (priority === 50) extendable.push('9', '5.5', '99');
  const noise = fc.array(
    fc.tuple(fc.nat(), fc.constantFrom('a', 'Z', ' ', '-', '+', '%', '\t')),
    { maxLength: 3 }
  );
  return fc
    .oneof(
      fc
        .tuple(fc.constantFrom(...extendable), fc.stringMatching(/^\d{0,3}$/))
        .map(([base, more]) => base + more),
      ...(ending.length ? [fc.constantFrom(...ending)] : [])
    )
    .chain((digits) => noise.map((n) => sprinkle(digits, n)));
}

/** Text that is no priority at all, so cleans up to whatever is held. */
const notAPriorityArb = fc.stringMatching(/^[^\d.]{0,6}$/);

/** Text that changes nothing when typed over `priority`. */
function noOpArb(priority: number): fc.Arbitrary<string> {
  return fc.oneof(cleansToArb(priority), notAPriorityArb);
}

/** What a user does to the field, or a new stored priority from outside. */
type Step =
  | { kind: 'type'; text: string }
  | { kind: 'escape' | 'blur' | 'enter' }
  | { kind: 'stored'; priority: number };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 4,
    arbitrary: typedArb.map((text): Step => ({ kind: 'type', text })),
  },
  {
    weight: 3,
    arbitrary: priorityArb
      .chain(noOpArb)
      .map((text): Step => ({ kind: 'type', text })),
  },
  { weight: 1, arbitrary: fc.constant<Step>({ kind: 'escape' }) },
  { weight: 1, arbitrary: fc.constant<Step>({ kind: 'blur' }) },
  { weight: 1, arbitrary: fc.constant<Step>({ kind: 'enter' }) },
  {
    weight: 2,
    arbitrary: priorityArb.map(
      (priority): Step => ({ kind: 'stored', priority })
    ),
  }
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
      fc.property(priorityArb, typedArb, typedArb, (before, first, second) => {
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
      })
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

  it('keeps what was typed on screen while an edit that changes nothing is open', () => {
    fc.assert(
      fc.property(
        priorityArb.chain((p) => fc.tuple(fc.constant(p), noOpArb(p))),
        ([priority, text]) => {
          const { input, onBlur } = field({ initialPriority: priority });

          const read = type(input, text);

          expect(keptAfterTyping(priority / 10, read)).toBe(priority / 10);
          // A half-typed "4." must not be cut back to "4"
          expect(input.value).toBe(read);
          expect(onBlur).not.toHaveBeenCalled();
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('shows the stored priority, not what was typed, once an edit that changes nothing ends', () => {
    fc.assert(
      fc.property(
        priorityArb.chain((p) =>
          fc.tuple(
            fc.constant(p),
            fc.array(noOpArb(p), { minLength: 1, maxLength: 3 }),
            fc.constantFrom('blur', 'enter', 'escape')
          )
        ),
        ([priority, edits, end]) => {
          const { input, onBlur } = field({ initialPriority: priority });

          for (const text of edits) type(input, text);
          if (end === 'blur') blur(input);
          else if (end === 'enter') enter(input);
          else press(input, 'Escape');

          expect(input.value).toBe(String(priority / 10));
          if (end === 'escape') expect(onBlur).not.toHaveBeenCalled();
          else expect(onBlur).toHaveBeenCalledExactlyOnceWith(priority);
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('undoes any edit on Escape, showing the stored priority with all of it selected', () => {
    fc.assert(
      fc.property(
        priorityArb,
        fc.array(fc.oneof(typedArb, priorityArb.chain(noOpArb)), {
          minLength: 1,
          maxLength: 4,
        }),
        (priority, edits) => {
          const { input, onBlur } = field({ initialPriority: priority });
          input.focus();
          for (const text of edits) type(input, text);

          press(input, 'Escape');

          expect(input.value).toBe(String(priority / 10));
          expect(input.selectionStart).toBe(0);
          expect(input.selectionEnd).toBe(input.value.length);
          blur(input);
          expect(onBlur).toHaveBeenCalledExactlyOnceWith(priority);
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('undoes an edit begun after a save back to the saved priority, though the save has yet to come back', () => {
    fc.assert(
      fc.property(
        priorityArb,
        typedArb,
        typedArb,
        fc.boolean(),
        (before, first, second, rerendered) => {
          const { root, input, onBlur } = field({ initialPriority: before });
          type(input, first);
          blur(input);
          const saved = onBlur.mock.lastCall![0] as number;
          // Whatever shows the field may render it again with its old priority
          if (rerendered) field({ initialPriority: before, onBlur }, root);
          expect(input.value).toBe(String(saved / 10));
          type(input, second);

          press(input, 'Escape');

          expect(input.value).toBe(String(saved / 10));
          blur(input);
          expect(onBlur).toHaveBeenLastCalledWith(saved);
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('shows a new stored priority in place of an open edit, even one that cleans up to it', () => {
    fc.assert(
      fc.property(
        priorityArb,
        priorityArb.chain((p) => fc.tuple(fc.constant(p), noOpArb(p))),
        typedArb,
        (before, [after, text], first) => {
          fc.pre(after !== before);
          const { root, input, onBlur } = field({ initialPriority: before });
          // Get the field holding `after` so that `text` changes nothing
          type(input, first);
          type(input, String(after / 10));
          type(input, text);

          field({ initialPriority: after, onBlur }, root);

          expect(input.value).toBe(String(after / 10));
          blur(input);
          expect(onBlur).toHaveBeenCalledExactlyOnceWith(after);
          document.body.innerHTML = '';
        }
      )
    );
  });

  it('shows and saves what each step calls for, over any run of edits, saves, undos and new stored priorities', () => {
    fc.assert(
      fc.property(
        priorityArb,
        fc.array(stepArb, { minLength: 1, maxLength: 12 }),
        (initial, steps) => {
          const { root, input, onBlur } = field({ initialPriority: initial });
          // What the user expects: the priority last stored, from outside or
          // saved here, and the edit open on top of it
          let stored = initial;
          let seen = initial;
          let edit: { held: number; shown: string } | null = null;
          let saves = 0;

          for (const step of steps) {
            if (step.kind === 'type') {
              const held: number = edit ? edit.held : stored / 10;
              const read = type(input, step.text);
              const next = keptAfterTyping(held, read);
              edit = { held: next, shown: next === held ? read : String(next) };
            } else if (step.kind === 'escape') {
              press(input, 'Escape');
              edit = null;
            } else if (step.kind === 'stored') {
              field({ initialPriority: step.priority, onBlur }, root);
              if (step.priority !== seen && step.priority !== stored) {
                stored = step.priority;
                edit = null;
              }
              seen = step.priority;
            } else {
              const held: number = edit ? edit.held : stored / 10;
              if (step.kind === 'blur') blur(input);
              else enter(input);
              stored = IRScheduler.transformPriority(held);
              edit = null;
              saves++;
              expect(onBlur).toHaveBeenLastCalledWith(stored);
            }

            expect(input.value).toBe(edit ? edit.shown : String(stored / 10));
            expect(onBlur).toHaveBeenCalledTimes(saves);
          }
          document.body.innerHTML = '';
        }
      )
    );
  });
});
