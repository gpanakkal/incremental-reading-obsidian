import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ActionCooldown, actionCooldownFor } from './action-cooldown';

// #region HELPERS

/** A key the bar can show: an item's, or null for none. */
const keyArb = fc.option(fc.string({ maxLength: 4 }), { nil: null });

/** Two keys that differ. */
const distinctKeysArb = fc
  .tuple(keyArb, keyArb)
  .filter(([first, second]) => first !== second);

/** A moment, in milliseconds, as `performance.now()` gives it. */
const timeArb = fc.integer({ min: 0, max: 1e9 });

/** A cooldown in whole milliseconds, up past the setting's maximum. */
const cooldownMsArb = fc.integer({ min: 0, max: 10_000 });

/** How long after a change a press lands, up to well past any cooldown. */
const delayArb = fc.integer({ min: 0, max: 20_000 });

/** A cooldown that has shown `key` at `at`. */
function shownAt(key: string | null, at: number): ActionCooldown {
  const cooldown = new ActionCooldown();
  cooldown.show(key, at);
  return cooldown;
}

// #endregion

describe('ActionCooldown', () => {
  it('drops presses before the cooldown ends and lets through those at or after', () => {
    fc.assert(
      fc.property(
        keyArb,
        timeArb,
        cooldownMsArb,
        delayArb,
        (key, changedAt, cooldownMs, delay) => {
          const cooldown = shownAt(key, changedAt);

          expect(
            cooldown.isCoolingDown(changedAt + delay, cooldownMs / 1000)
          ).toBe(delay < cooldownMs);
        }
      )
    );
  });

  it('holds a press for exactly as long as a slider step says', () => {
    // Steps of 0.1 s, the setting's own; several are not whole milliseconds
    // once multiplied out (1.1 * 1000 is 1100.0000000000002).
    fc.assert(
      fc.property(
        timeArb,
        fc.integer({ min: 1, max: 50 }),
        (changedAt, tenths) => {
          const cooldown = shownAt('item', changedAt);
          const seconds = tenths / 10;
          const end = changedAt + tenths * 100;

          expect(cooldown.isCoolingDown(end, seconds)).toBe(false);
          expect(cooldown.isCoolingDown(end - 1, seconds)).toBe(true);
        }
      )
    );
  });

  it('never drops a press while the cooldown is off', () => {
    fc.assert(
      fc.property(keyArb, timeArb, delayArb, (key, changedAt, delay) => {
        const cooldown = shownAt(key, changedAt);

        expect(cooldown.isCoolingDown(changedAt + delay, 0)).toBe(false);
      })
    );
  });

  it('drops nothing before anything is shown', () => {
    fc.assert(
      fc.property(timeArb, cooldownMsArb, (now, cooldownMs) => {
        expect(new ActionCooldown().isCoolingDown(now, cooldownMs / 1000)).toBe(
          false
        );
      })
    );
  });

  it('does not restart when the same key is shown again', () => {
    fc.assert(
      fc.property(
        keyArb,
        timeArb,
        cooldownMsArb,
        delayArb,
        delayArb,
        (key, changedAt, cooldownMs, refetchDelay, pressDelay) => {
          const cooldown = shownAt(key, changedAt);

          cooldown.show(key, changedAt + refetchDelay);

          expect(
            cooldown.isCoolingDown(changedAt + pressDelay, cooldownMs / 1000)
          ).toBe(pressDelay < cooldownMs);
        }
      )
    );
  });

  it('restarts from the moment a different key is shown', () => {
    fc.assert(
      fc.property(
        distinctKeysArb,
        timeArb,
        delayArb,
        cooldownMsArb,
        delayArb,
        ([before, after], firstAt, gap, cooldownMs, delay) => {
          const cooldown = shownAt(before, firstAt);
          const changedAt = firstAt + gap;

          cooldown.show(after, changedAt);

          expect(
            cooldown.isCoolingDown(changedAt + delay, cooldownMs / 1000)
          ).toBe(delay < cooldownMs);
        }
      )
    );
  });

  it('restarts from the moment it is armed, whatever is on screen', () => {
    fc.assert(
      fc.property(
        keyArb,
        timeArb,
        delayArb,
        cooldownMsArb,
        delayArb,
        (key, shownAtTime, gap, cooldownMs, delay) => {
          const cooldown = shownAt(key, shownAtTime);
          const armedAt = shownAtTime + gap;

          cooldown.arm(armedAt);

          expect(
            cooldown.isCoolingDown(armedAt + delay, cooldownMs / 1000)
          ).toBe(delay < cooldownMs);
        }
      )
    );
  });

  it('arms with nothing shown yet', () => {
    fc.assert(
      fc.property(
        timeArb,
        cooldownMsArb,
        delayArb,
        (armedAt, cooldownMs, delay) => {
          const cooldown = new ActionCooldown();

          cooldown.arm(armedAt);

          expect(
            cooldown.isCoolingDown(armedAt + delay, cooldownMs / 1000)
          ).toBe(delay < cooldownMs);
        }
      )
    );
  });

  it('keeps what was shown when armed: a refetch of the same item does not restart it, a new item does', () => {
    fc.assert(
      fc.property(
        distinctKeysArb,
        timeArb,
        delayArb,
        delayArb,
        cooldownMsArb,
        delayArb,
        ([key, other], shownAtTime, armGap, showGap, cooldownMs, delay) => {
          const armedAt = shownAtTime + armGap;
          const showAt = armedAt + showGap;
          const refetched = shownAt(key, shownAtTime);
          const moved = shownAt(key, shownAtTime);
          refetched.arm(armedAt);
          moved.arm(armedAt);

          refetched.show(key, showAt);
          moved.show(other, showAt);

          const now = showAt + delay;
          expect(refetched.isCoolingDown(now, cooldownMs / 1000)).toBe(
            now - armedAt < cooldownMs
          );
          expect(moved.isCoolingDown(now, cooldownMs / 1000)).toBe(
            delay < cooldownMs
          );
        }
      )
    );
  });
});

describe('actionCooldownFor', () => {
  it('gives one view the same cooldown every time', () => {
    const view = {};

    expect(actionCooldownFor(view)).toBe(actionCooldownFor(view));
  });

  it('gives each view a cooldown of its own', () => {
    const first = actionCooldownFor({});
    const second = actionCooldownFor({});
    first.show('item', 0);

    expect(second).not.toBe(first);
    expect(second.isCoolingDown(0, 1)).toBe(false);
  });
});
