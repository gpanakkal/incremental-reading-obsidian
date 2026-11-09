import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { lastCallMemo } from './last-call-memo';

describe('lastCallMemo', () => {
  it('property: reads again only when the key differs from the last one read, or after a forget', () => {
    fc.assert(
      fc.property(
        // Each step asks for a key, or forgets
        fc.array(fc.oneof(fc.constantFrom('a', 'b', 'c'), fc.constant(null)), {
          maxLength: 20,
        }),
        (steps) => {
          let version = 0;
          // A fresh answer per read, so a remembered one is told apart
          const read = vi.fn((key: string) => `${key}#${version++}`);
          const memo = lastCallMemo(read, (key: string) => key);

          // The key last read and its answer, as the memo should remember them
          let lastKey: string | null = null;
          let lastValue: string | undefined;
          let reads = 0;
          for (const step of steps) {
            if (step === null) {
              memo.forget();
              lastKey = null;
              continue;
            }
            const value = memo.get(step);
            if (lastKey !== step) {
              reads++;
              lastKey = step;
              lastValue = value;
            }
            expect(value).toBe(lastValue);
            expect(read).toHaveBeenCalledTimes(reads);
            expect(read).toHaveBeenLastCalledWith(step);
          }
        }
      )
    );
  });

  it('keys an argument by what keyOf makes of it, not by identity', () => {
    const read = vi.fn((file: { path: string }) => file.path.length);
    const memo = lastCallMemo(read, (file) => file.path);

    memo.get({ path: 'a.md' });
    memo.get({ path: 'a.md' });

    expect(read).toHaveBeenCalledOnce();
  });
});
