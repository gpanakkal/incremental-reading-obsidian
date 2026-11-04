import { makeLinkVault } from '#/test/link-vault';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  claimedId,
  claimsIdAt,
  heldRowOf,
  holdingOf,
  type IdHolder,
} from './note-holding';

// #region HELPERS

/** Where a note may be, and a row may point. */
const PATHS = ['notes/a.md', 'notes/b.md', 'gone/c.md'] as const;

/** A row holding a note's id, live or deleted, pointing at any of {@link PATHS}. */
const holderArb = fc.record<IdHolder & { tag: number }>({
  reference: fc.constantFrom(...PATHS),
  live: fc.boolean(),
  // Tells rows pointing at the same path apart
  tag: fc.nat(),
});

// #endregion

describe('claimedId', () => {
  it('claims no id for a falsy value, the string itself for a string, a scalar YAML read as a number or a boolean by its string form, and none a row can hold for a list or a map', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.anything(), fc.double(), fc.boolean(), fc.bigInt()),
        (irId) => {
          const claimed = claimedId(irId);

          if (!irId) expect(claimed).toBeUndefined();
          else if (typeof irId === 'string') expect(claimed).toBe(irId);
          else if (typeof irId === 'object') expect(claimed).toBeNull();
          else expect(claimed).toBe(`${irId as number | boolean | bigint}`);
        }
      )
    );
  });

  it('claims the id a row holds for an ir-id YAML reads as a number', () => {
    expect(claimedId(7)).toBe('7');
  });
});

describe('heldRowOf', () => {
  it('finds the first live row pointing at the path, and none when only deleted ones or none do', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PATHS),
        fc.array(holderArb, { maxLength: 5 }),
        (path, rows) => {
          const expected = rows.filter(
            (row) => row.live && row.reference === path
          )[0];

          expect(heldRowOf(path, rows)).toBe(expected);
        }
      )
    );
  });
});

describe('holdingOf', () => {
  it('holds a note a live row points at; else, on a path no live row holding another id holds, calls it a copy while a live row points where a note claims the id; else unheld', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PATHS),
        fc.array(holderArb, { maxLength: 5 }),
        fc.subarray([...PATHS]),
        fc.boolean(),
        (path, rows, claimed, taken) => {
          const holding = holdingOf(
            path,
            rows,
            (reference) => claimed.includes(reference as never),
            taken
          );

          const live = rows.filter((row) => row.live);
          const expected = live.some((row) => row.reference === path)
            ? 'held'
            : !taken &&
                live.some((row) => claimed.includes(row.reference as never))
              ? 'copy'
              : 'unheld';
          expect(holding).toBe(expected);
        }
      )
    );
  });
});

describe('claimsIdAt', () => {
  it('says whether a note at the path claims exactly the id, by its cached ir-id, a number by its string form', () => {
    fc.assert(
      fc.property(
        fc.option(fc.constantFrom<unknown>('x', 'y', 7, '', null), {
          nil: undefined,
        }),
        fc.boolean(),
        fc.constantFrom('x', 'y', '7'),
        (irId, exists, id) => {
          const vault = makeLinkVault(
            exists
              ? { 'notes/a.md': irId === undefined ? {} : { 'ir-id': irId } }
              : {}
          );

          expect(claimsIdAt(vault.app as never, 'notes/a.md', id)).toBe(
            exists && (irId === id || (irId === 7 && id === '7'))
          );
        }
      )
    );
  });
});
