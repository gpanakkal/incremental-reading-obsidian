import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  packPdfPosition,
  PDF_PAGE_STRIDE,
  pdfPositionSubpath,
  unpackPdfPosition,
} from './position';

// #region HELPERS

/** Any page a PDF can have, and well past it. */
const page = () => fc.integer({ min: 1, max: 2 ** 31 });
/** A top that fits in a packed value, as pdf.js rounds it. */
const fittingTop = () => fc.integer({ min: 0, max: PDF_PAGE_STRIDE - 1 });
/** Any top that is a number: off the page, fractional, huge, infinite. */
const anyTop = () =>
  fc.oneof(
    fc.double({ noNaN: true }),
    fc.integer({ min: -1e6, max: 1e6 }),
    fc.constantFrom(Infinity, -Infinity)
  );
const notAPage = () =>
  fc.oneof(
    fc.integer({ max: 0 }),
    fc.double({ noInteger: true }),
    fc.double({ min: 2 ** 53, noNaN: true, noDefaultInfinity: true }),
    fc.constantFrom(Number.NaN, Infinity, -Infinity, 2 ** 53 + 2)
  );

// #endregion

describe('packPdfPosition', () => {
  it('round-trips a page and a top that fits', () => {
    fc.assert(
      fc.property(page(), fittingTop(), (p, t) => {
        expect(unpackPdfPosition(packPdfPosition(p, t))).toEqual({
          page: p,
          top: t,
        });
      })
    );
  });

  it('is never 0, which means unset', () => {
    fc.assert(
      fc.property(page(), anyTop(), (p, t) => {
        expect(packPdfPosition(p, t)).toBeGreaterThan(0);
      })
    );
  });

  it('keeps the page, and rounds the top into the range it fits in', () => {
    fc.assert(
      fc.property(page(), anyTop(), (p, t) => {
        const expected = Math.min(
          Math.max(Math.round(t), 0),
          PDF_PAGE_STRIDE - 1
        );
        expect(unpackPdfPosition(packPdfPosition(p, t))).toEqual({
          page: p,
          top: expected,
        });
      })
    );
  });

  it('packs as page * 100000 + top', () => {
    expect(packPdfPosition(3, 700)).toBe(300700);
    expect(packPdfPosition(1, 0)).toBe(100000);
  });

  it('refuses a page that is not a whole number from 1', () => {
    fc.assert(
      fc.property(notAPage(), fittingTop(), (p, t) => {
        expect(() => packPdfPosition(p, t)).toThrow(
          new RangeError(`Not a PDF page number: ${p}`)
        );
      })
    );
  });

  it('refuses a top that is not a number', () => {
    fc.assert(
      fc.property(page(), (p) => {
        expect(() => packPdfPosition(p, Number.NaN)).toThrow(
          new RangeError('Not a PDF y: NaN')
        );
      })
    );
  });

  it('refuses a page too large to pack exactly', () => {
    const firstTooLarge = Math.ceil(Number.MAX_SAFE_INTEGER / PDF_PAGE_STRIDE);
    fc.assert(
      fc.property(
        fc.integer({ min: firstTooLarge, max: Number.MAX_SAFE_INTEGER }),
        anyTop(),
        (p, t) => {
          expect(() => packPdfPosition(p, t)).toThrow(
            new RangeError(`PDF page number too large to pack: ${p}`)
          );
        }
      )
    );
    // The last page whose slot fits only in part
    expect(() => packPdfPosition(firstTooLarge - 1, 0)).not.toThrow();
    expect(() => packPdfPosition(firstTooLarge - 1, 99999)).toThrow(RangeError);
  });
});

describe('unpackPdfPosition', () => {
  it('reads anything below page 1 as unset', () => {
    fc.assert(
      fc.property(fc.integer({ max: PDF_PAGE_STRIDE - 1 }), (value) => {
        expect(unpackPdfPosition(value)).toBeNull();
      })
    );
  });

  it('reads a value that is not a safe whole number as unset', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double({ noInteger: true }),
          fc.constantFrom(Number.NaN, Infinity, -Infinity, 2 ** 53)
        ),
        (value) => {
          expect(unpackPdfPosition(value)).toBeNull();
        }
      )
    );
  });

  it('reads the lowest packed value as the bottom edge of page 1', () => {
    expect(unpackPdfPosition(PDF_PAGE_STRIDE)).toEqual({ page: 1, top: 0 });
  });

  it('splits any packed value into its page and top', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: PDF_PAGE_STRIDE, max: Number.MAX_SAFE_INTEGER }),
        (value) => {
          const position = unpackPdfPosition(value);
          expect(position).not.toBeNull();
          const { page: p, top: t } = position!;
          expect(p).toBeGreaterThanOrEqual(1);
          expect(t).toBeGreaterThanOrEqual(0);
          expect(t).toBeLessThan(PDF_PAGE_STRIDE);
          expect(p * PDF_PAGE_STRIDE + t).toBe(value);
        }
      )
    );
  });
});

describe('pdfPositionSubpath', () => {
  it('opens at the page with the top at the top edge, at whatever zoom', () => {
    fc.assert(
      fc.property(page(), fittingTop(), (p, t) => {
        expect(pdfPositionSubpath({ page: p, top: t })).toBe(
          `#page=${p}&offset=0,${t}`
        );
      })
    );
  });
});
