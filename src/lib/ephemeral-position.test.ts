import {
  POSITIONAL_ESTATE_KEYS,
  clearPositioned,
  isPositionalEState,
  markEState,
  recordEphemeralState,
  wasPositioned,
} from '#/lib/ephemeral-position';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

// #region HELPERS

const OTHER_KEYS = ['focus', 'focusMetadata', 'rename', 'mode'] as const;

/** Anything a caller could hand `setEphemeralState`. */
const eStateArb = fc.oneof(
  fc.dictionary(
    fc.constantFrom(...POSITIONAL_ESTATE_KEYS, ...OTHER_KEYS),
    fc.anything()
  ),
  fc.anything()
);

/** Whether `state` is an object with one of the positional keys of its own. */
function hasPositionalKey(state: unknown): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    POSITIONAL_ESTATE_KEYS.some((key) =>
      Object.prototype.hasOwnProperty.call(state, key)
    )
  );
}

/** A stand-in for `MarkdownView.prototype`, recording what reaches it. */
function makeProto() {
  const received: { view: object; state: unknown }[] = [];
  const original = vi.fn(function (this: object, state: unknown) {
    received.push({ view: this, state });
  });
  const proto = { setEphemeralState: original as (state: unknown) => void };
  return { proto, original, received };
}

// #endregion

describe('isPositionalEState', () => {
  it('is true exactly for an object holding a positional key of its own', () => {
    fc.assert(
      fc.property(eStateArb, (state) => {
        expect(isPositionalEState(state)).toBe(hasPositionalKey(state));
      })
    );
  });

  it('ignores a positional key that is only inherited', () => {
    const state = Object.create({ match: {} }) as object;

    expect(isPositionalEState(state)).toBe(false);
  });
});

describe('markEState / clearPositioned / wasPositioned', () => {
  it('marks a view handed positional state, until it is cleared, and no other view', () => {
    fc.assert(
      fc.property(fc.array(eStateArb, { maxLength: 4 }), (states) => {
        const view = {};
        const other = {};

        states.forEach((state) => markEState(view, state));

        expect(wasPositioned(view)).toBe(states.some(hasPositionalKey));
        expect(wasPositioned(other)).toBe(false);
        clearPositioned(view);
        expect(wasPositioned(view)).toBe(false);
      })
    );
  });

  it('keeps the mark when non-positional state follows', () => {
    const view = {};

    markEState(view, { subpath: '#Heading' });
    markEState(view, { focus: true });

    expect(wasPositioned(view)).toBe(true);
  });
});

describe('recordEphemeralState', () => {
  it('marks the view each call was made on, then hands the call on unchanged', () => {
    fc.assert(
      fc.property(eStateArb, (state) => {
        const { proto, received } = makeProto();
        const view = Object.create(proto) as typeof proto;
        recordEphemeralState(proto);

        view.setEphemeralState(state);

        expect(received).toEqual([{ view, state }]);
        expect(received[0].view).toBe(view);
        expect(wasPositioned(view)).toBe(hasPositionalKey(state));
      })
    );
  });

  it('puts the original back on uninstall, and stops marking', () => {
    const { proto, original } = makeProto();
    const uninstall = recordEphemeralState(proto);

    uninstall();

    expect(proto.setEphemeralState).toBe(original);
    const view = Object.create(proto) as typeof proto;
    view.setEphemeralState({ match: {} });
    expect(wasPositioned(view)).toBe(false);
  });

  it('leaves a later wrapper in place on uninstall, but stops marking', () => {
    const { proto, received } = makeProto();
    const uninstall = recordEphemeralState(proto);
    const ours = proto.setEphemeralState;
    const theirs = vi.fn(function (this: object, state: unknown) {
      ours.call(this, state);
    });
    proto.setEphemeralState = theirs;

    uninstall();

    expect(proto.setEphemeralState).toBe(theirs);
    const view = Object.create(proto) as typeof proto;
    view.setEphemeralState({ match: {} });
    expect(theirs).toHaveBeenCalledOnce();
    expect(received).toHaveLength(1);
    expect(wasPositioned(view)).toBe(false);
  });
});
