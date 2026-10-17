import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BulkMutateError } from './BulkMutateError';

describe('BulkMutateError', () => {
  it('says how far the run got and what stopped it, keeping both', () => {
    fc.assert(
      fc.property(
        fc.nat(),
        fc.nat(),
        // Anything can be thrown, an Error or not, and some can't be made
        // into text
        fc.oneof(
          fc.anything({ withNullPrototype: true }),
          fc.string().map((message) => new Error(message))
        ),
        (committed, total, cause) => {
          const error = new BulkMutateError(committed, total, cause);

          expect(error).toBeInstanceOf(Error);
          expect(error.name).toBe('BulkMutateError');
          expect(error.committed).toBe(committed);
          expect(error.cause).toBe(cause);
          expect(error.message).toBe(
            `Stopped after committing ${committed} of ${total} statements`
          );
        }
      )
    );
  });
});
