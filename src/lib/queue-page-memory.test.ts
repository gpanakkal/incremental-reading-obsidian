import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { QueuePageMemory } from './queue-page-memory';
import { NOTE_TYPES, type NoteType } from './types';

// #region HELPERS

type Filter = Partial<Record<NoteType, true>>;

/** A filter in the store's shape, letting `types` through. */
function makeFilter(types: readonly NoteType[]): Filter {
  return Object.fromEntries(types.map((type) => [type, true]));
}

/**
 * Distinct filter objects, as the store builds a new one on every change.
 * Several can let the same types through, which must not make them the same.
 */
const filtersArb = fc
  .array(fc.subarray([...NOTE_TYPES]), { minLength: 1, maxLength: 6 })
  .map((typeSets) => typeSets.map(makeFilter));

const pageArb = fc.nat({ max: 1000 });

type Op = { kind: 'set'; filter: number; page: number } | { kind: 'clear' };

/** A sequence of operations over a pool of `size` filters. */
function opsArb(size: number): fc.Arbitrary<Op[]> {
  return fc.array(
    fc.oneof(
      fc.record({
        kind: fc.constant('set' as const),
        filter: fc.nat({ max: size - 1 }),
        page: pageArb,
      }),
      fc.constant({ kind: 'clear' as const })
    )
  );
}

/** A filter pool, operations over it, and the pool index asked about after. */
const scenarioArb = filtersArb.chain((filters) =>
  fc.tuple(
    fc.constant(filters),
    opsArb(filters.length),
    fc.nat({ max: filters.length - 1 })
  )
);

// #endregion

describe('QueuePageMemory', () => {
  it('opens on the first page before any page is chosen', () => {
    fc.assert(
      fc.property(fc.subarray([...NOTE_TYPES]), (types) => {
        expect(new QueuePageMemory().get(makeFilter(types))).toBe(0);
      })
    );
  });

  it('gives back the last page set under the very same filter, and the first page under any other or after a clear', () => {
    fc.assert(
      fc.property(scenarioArb, ([filters, ops, asked]) => {
        const memory = new QueuePageMemory();
        for (const op of ops) {
          if (op.kind === 'set') memory.set(filters[op.filter], op.page);
          else memory.clear();
        }

        const last = ops.at(-1);
        const expected =
          last?.kind === 'set' && last.filter === asked ? last.page : 0;
        expect(memory.get(filters[asked])).toBe(expected);
      })
    );
  });

  it('treats a new filter letting the same types through as a change', () => {
    fc.assert(
      fc.property(fc.subarray([...NOTE_TYPES]), pageArb, (types, page) => {
        const memory = new QueuePageMemory();
        memory.set(makeFilter(types), page);

        expect(memory.get(makeFilter(types))).toBe(0);
      })
    );
  });
});
