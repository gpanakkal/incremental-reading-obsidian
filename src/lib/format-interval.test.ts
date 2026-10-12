import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatInterval } from './format-interval';

// #region HELPERS

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;
const MONTH = YEAR / 12;

/** What each unit a label can end in stands for, in ms. */
const UNIT_MS: Record<string, number> = {
  m: MINUTE,
  h: HOUR,
  d: DAY,
  mo: MONTH,
  y: YEAR,
};

/**
 * The duration a label reads as, in ms: `<1m` as nothing at all, `10m` as ten
 * minutes. Throws on anything not in the compact format, so the properties
 * below also pin the format — except that a count past 1e21, which no card
 * schedules, is in exponent notation.
 */
function labelMs(label: string): number {
  if (label === '<1m') return 0;
  const match = /^(\d+(?:\.\d)?|\d(?:\.\d+)?e\+\d+)(m|h|d|mo|y)$/.exec(label);
  if (!match) throw new Error(`not a compact interval: "${label}"`);
  const [, count, unit] = match;
  return Number(count) * UNIT_MS[unit];
}

/**
 * Any duration a preview can produce: sub-second through ts-fsrs's 100-year
 * default maximum interval and far past it — out to the span of every date a
 * Date can hold, and any double beyond — plus the negative ones a card
 * overdue at render time could give, and the NaN an invalid date does.
 */
const anyDuration = fc.oneof(
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.double({ min: -DAY, max: 200 * YEAR, noNaN: true }),
  fc.integer({ min: 0, max: (200 * YEAR) / MINUTE }).map((m) => m * MINUTE),
  fc.integer({ min: 0, max: 1.728e16 }),
  fc.constantFrom(NaN, -0)
);

// #endregion

describe('formatInterval', () => {
  it('property: never comes out empty, whatever the duration', () => {
    fc.assert(
      fc.property(anyDuration, (ms) => {
        expect(formatInterval(ms).length).toBeGreaterThan(0);
      })
    );
  });

  it('property: is always one compact count and unit, or <1m', () => {
    fc.assert(
      fc.property(
        anyDuration.filter((ms) => !Number.isNaN(ms)),
        (ms) => {
          expect(() => labelMs(formatInterval(ms))).not.toThrow();
        }
      )
    );
  });

  it('property: never reads shorter for a longer duration', () => {
    fc.assert(
      fc.property(
        anyDuration.filter((ms) => !Number.isNaN(ms)),
        anyDuration.filter((ms) => !Number.isNaN(ms)),
        (a, b) => {
          const [short, long] = a <= b ? [a, b] : [b, a];
          expect(labelMs(formatInterval(short))).toBeLessThanOrEqual(
            labelMs(formatInterval(long))
          );
        }
      )
    );
  });

  it('property: reads within half a unit of the duration, in the largest unit that keeps it at 1 or more', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 30_000, max: 200 * YEAR, noNaN: true }),
        (ms) => {
          const label = formatInterval(ms);
          const unit = /[a-z]+$/.exec(label)![0];
          const step = unit === 'y' ? YEAR / 10 : UNIT_MS[unit];
          expect(Math.abs(labelMs(label) - ms)).toBeLessThanOrEqual(
            step / 2 + 1e-6 * ms
          );
          // No smaller count would do in the next unit up
          expect(labelMs(label)).toBeGreaterThanOrEqual(UNIT_MS[unit] * 0.95);
        }
      )
    );
  });

  it.each([
    [0, '<1m'],
    [29_999, '<1m'],
    [30_000, '1m'],
    [10 * MINUTE, '10m'],
    [59 * MINUTE, '59m'],
    [59.5 * MINUTE, '1h'],
    [3 * HOUR, '3h'],
    [23 * HOUR, '23h'],
    [23.5 * HOUR, '1d'],
    [4 * DAY, '4d'],
    [29 * DAY, '29d'],
    [29.5 * DAY, '1mo'],
    [61 * DAY, '2mo'],
    [11 * MONTH, '11mo'],
    [11.5 * MONTH, '1y'],
    [YEAR, '1y'],
    [1.2 * YEAR, '1.2y'],
    [1.25 * YEAR, '1.3y'],
    [100 * YEAR, '100y'],
  ])('shows %f ms as %s', (ms, label) => {
    expect(formatInterval(ms)).toBe(label);
  });

  it.each([NaN, -1, -DAY])(
    'shows a duration that is no duration (%f) as <1m',
    (ms) => {
      expect(formatInterval(ms)).toBe('<1m');
    }
  );
});
