import { asksForFocus, EditorFocusHandoff } from '#/lib/editor-focus-handoff';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// #region HELPERS

/** What holds focus in the document when the arriving editor asks. */
type Holder = 'body' | 'nothing' | 'something else';

/**
 * A document as `claim` reads it: only which element is active, and its body.
 * `nothing` is a document with no active element at all, which the DOM allows
 * while there is no body to fall back on.
 */
function makeDoc(holder: Holder): Document {
  const body = {} as HTMLElement;
  const activeElement =
    holder === 'body' ? body : holder === 'nothing' ? null : ({} as Element);
  return { body, activeElement } as unknown as Document;
}

const holderArb = fc.constantFrom<Holder>('body', 'nothing', 'something else');

/** One thing the review tab can do to the handoff. */
type Step =
  | { kind: 'release'; held: boolean; isMobile: boolean }
  | { kind: 'cancel' }
  | { kind: 'claim'; holder: Holder };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant('release' as const),
    held: fc.boolean(),
    isMobile: fc.boolean(),
  }),
  fc.record({ kind: fc.constant('cancel' as const) }),
  fc.record({ kind: fc.constant('claim' as const), holder: holderArb })
);

/** Ephemeral state a view can be handed: anything, and the focus flags. */
const eStateArb = fc.oneof(
  fc.anything(),
  fc.record(
    { focus: fc.anything(), focusOnMobile: fc.anything() },
    { requiredKeys: [] }
  ),
  fc.record({ focus: fc.boolean(), focusOnMobile: fc.boolean() })
);

// #endregion

describe('asksForFocus', () => {
  it('reads focus as Obsidian’s edit view does: asked for, and on mobile asked for there too', () => {
    fc.assert(
      fc.property(eStateArb, fc.boolean(), (eState, isMobile) => {
        const flags =
          typeof eState === 'object' && eState !== null
            ? (eState as { focus?: unknown; focusOnMobile?: unknown })
            : {};
        const expected = !!flags.focus && (!isMobile || !!flags.focusOnMobile);

        expect(asksForFocus(eState, isMobile)).toBe(expected);
      })
    );
  });

  it('asks on desktop for `focusLeaf`’s state, and not on mobile', () => {
    expect(asksForFocus({ focus: true }, false)).toBe(true);
    expect(asksForFocus({ focus: true }, true)).toBe(false);
    expect(asksForFocus({ focus: true, focusOnMobile: true }, true)).toBe(true);
  });

  it('never asks for state that is not an object', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.boolean(),
          fc.string(),
          fc.double()
        ),
        fc.boolean(),
        (eState, isMobile) => {
          expect(asksForFocus(eState, isMobile)).toBe(false);
        }
      )
    );
  });
});

describe('EditorFocusHandoff', () => {
  it('hands focus on once per desktop release of a focused editor, and only to an editor arriving while nothing holds focus', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 20 }), (steps) => {
        const handoff = new EditorFocusHandoff();
        // The model: focus is owed from a desktop release of a focused editor
        // until anything cancels or claims it.
        let owed = false;
        for (const step of steps) {
          if (step.kind === 'release') {
            handoff.release(step.held, step.isMobile);
            owed = step.held && !step.isMobile;
          } else if (step.kind === 'cancel') {
            handoff.cancel();
            owed = false;
          } else {
            const takes = handoff.claim(makeDoc(step.holder));
            expect(takes).toBe(owed && step.holder !== 'something else');
            owed = false;
          }
        }
      })
    );
  });

  it('has nothing to hand on before any editor has gone', () => {
    fc.assert(
      fc.property(holderArb, (holder) => {
        expect(new EditorFocusHandoff().claim(makeDoc(holder))).toBe(false);
      })
    );
  });

  it('hands on the focus a desktop editor held when nothing has focus since', () => {
    const handoff = new EditorFocusHandoff();

    handoff.release(true, false);

    expect(handoff.claim(makeDoc('body'))).toBe(true);
    expect(handoff.claim(makeDoc('body'))).toBe(false);
  });
});
