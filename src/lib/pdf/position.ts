/**
 * Where a reader is in a PDF article, packed into the `scroll_top` column that
 * holds a markdown item's top-visible character offset.
 *
 * A position is a page and the PDF y coordinate at the top edge of the view,
 * as pdf.js reports it (`location.top`): unscaled PDF points measured up from
 * the page's bottom edge, so it means the same place at every zoom. Packed, it
 * is `page * 100000 + top`, and `0`, the column's default, means unset.
 */

/** What one page takes up in a packed position; tops stay below it. */
export const PDF_PAGE_STRIDE = 100_000;

export interface PdfPosition {
  /** 1-based page number. */
  page: number;
  /** PDF y at the top edge of the view, in points from the page's bottom. */
  top: number;
}

/**
 * Pack `page` and `top` into one `scroll_top` value. Never `0`.
 *
 * `top` is rounded, and clamped into what a page's slot holds: pdf.js reports
 * a little past the page's edges when the view's top edge is in the gap
 * between pages.
 *
 * @throws RangeError when `page` isn't a whole number from 1, or is too large
 * to pack exactly, or when `top` is NaN.
 */
export function packPdfPosition(page: number, top: number): number {
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new RangeError(`Not a PDF page number: ${page}`);
  }
  if (Number.isNaN(top)) throw new RangeError('Not a PDF y: NaN');
  const fitted = Math.min(Math.max(Math.round(top), 0), PDF_PAGE_STRIDE - 1);
  const packed = page * PDF_PAGE_STRIDE + fitted;
  if (!Number.isSafeInteger(packed)) {
    throw new RangeError(`PDF page number too large to pack: ${page}`);
  }
  return packed;
}

/**
 * The position `value` packs, or `null` when it holds none: `0` (unset),
 * anything else below page 1, or a value no {@link packPdfPosition} returns.
 */
export function unpackPdfPosition(value: number): PdfPosition | null {
  if (!Number.isSafeInteger(value) || value < PDF_PAGE_STRIDE) return null;
  return {
    page: Math.floor(value / PDF_PAGE_STRIDE),
    top: value % PDF_PAGE_STRIDE,
  };
}

/**
 * The subpath that opens a PDF at `position`, in Obsidian's PDF link grammar.
 *
 * With no zoom in `offset`, Obsidian makes it a `FitBH` destination: the page
 * fits the view's width and `top` goes to the view's top edge. The `0` it
 * takes for x is ignored.
 */
export function pdfPositionSubpath(position: PdfPosition): string {
  return `#page=${position.page}&offset=0,${position.top}`;
}
