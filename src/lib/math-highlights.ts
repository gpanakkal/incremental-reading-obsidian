import type { ReadingSection } from './reading-highlights';
import type { SnippetHighlight } from './SnippetOffsetTracker';
import {
  texHighlightClass,
  wrapTexRanges,
  type TexHighlightStatus,
} from './tex-highlight';

/**
 * Snippet highlights on rendered `$$ … $$` math, which MathJax draws in place
 * of the TeX the highlights' offsets are in.
 *
 * A highlight shows on the part of the formula it was cut from: the formula
 * is rendered again from its TeX with that part wrapped in a class (see
 * `tex-highlight.ts`), its old rendering swapped for the new. Where no part
 * can be told apart, it shows on the whole formula, whose rendering is then
 * left as it is.
 */

/** Render TeX as display math: Obsidian's `renderMath(tex, true)`. */
export type RenderMath = (tex: string) => HTMLElement;

/** Where a `$$ … $$` math's TeX, between its delimiters, lies in markdown. */
export interface MathSpan {
  texStart: number;
  texEnd: number;
}

/**
 * The `$$`-delimited math in `source`, in order: each two `$$`s in turn, a
 * backslash escaping the character after it.
 */
export function displayMath(source: string): MathSpan[] {
  const delimiters: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\\') i += 1;
    else if (source.startsWith('$$', i)) delimiters.push(i++);
  }
  const spans: MathSpan[] = [];
  for (let k = 0; k + 1 < delimiters.length; k += 2) {
    spans.push({ texStart: delimiters[k] + 2, texEnd: delimiters[k + 1] });
  }
  return spans;
}

/** A highlight's part of a formula, by offsets into its TeX. */
export interface MathHighlight {
  highlight: SnippetHighlight;
  start: number;
  end: number;
}

export interface PaintMathOptions {
  /** Marks that open nothing, as live preview's: a click there edits the math */
  inert?: boolean;
}

/**
 * Renderings this module made, each with the TeX its highlights came out of,
 * put back by rendering that TeX again once they are gone, and the wrapped
 * TeX it was drawn from, kept when the same is wanted again.
 */
const rerendered = new WeakMap<Element, { tex: string; wrapped: string }>();

/** Undocumented: MathJax's CHTML output, a child of Obsidian's `.math` */
const CONTAINER = 'mjx-container';
const HIGHLIGHT = 'ir-snippet-highlight';
const INERT = 'ir-inert-highlight';
const ATTRIBUTES = ['data-snippet-id', 'data-snippet-ref'];

/** The rendered formula in `mathEl`, if MathJax has drawn it yet. */
const containerOf = (mathEl: HTMLElement) =>
  Array.from(mathEl.children).find(
    (child): child is HTMLElement => child.localName === CONTAINER
  ) ?? null;

/** Make `el` show `highlight`. */
function mark(el: Element, highlight: SnippetHighlight, inert: boolean) {
  el.classList.add(HIGHLIGHT);
  el.classList.toggle(INERT, inert);
  el.setAttribute('data-snippet-id', highlight.id);
  // Without a reference, a click on an inert mark finds no snippet to open
  if (!inert) el.setAttribute('data-snippet-ref', highlight.reference);
}

/** Take a highlight off `el`. */
function unmark(el: Element) {
  el.classList.remove(HIGHLIGHT, INERT);
  for (const name of ATTRIBUTES) el.removeAttribute(name);
}

/**
 * The formula in `mathEl` as it was before any highlight: drawn again from
 * its TeX if this module drew it, else unmarked.
 */
function restore(
  container: HTMLElement,
  render: RenderMath
): HTMLElement | null {
  const own = rerendered.get(container);
  if (own === undefined) {
    unmark(container);
    return container;
  }
  const fresh = renderOrNull(render, own.tex);
  if (fresh) container.replaceWith(fresh);
  return fresh;
}

function renderOrNull(render: RenderMath, tex: string): HTMLElement | null {
  try {
    return render(tex);
  } catch {
    return null;
  }
}

/** Whether MathJax rendered `el` as an error: the TeX didn't parse. */
const failed = (el: HTMLElement) =>
  el.matches('[data-mjx-error]') ||
  el.querySelector('[data-mjx-error]') !== null;

/**
 * Show `highlights` on the formula `mathEl` holds, drawn from `tex`, taking
 * off any it showed before. False when MathJax hasn't drawn it yet.
 *
 * Of highlights on the whole formula, the one starting last shows, as of
 * overlapping marks the innermost does.
 */
export function paintMath(
  mathEl: HTMLElement,
  tex: string,
  highlights: readonly MathHighlight[],
  render: RenderMath,
  { inert = false }: PaintMathOptions = {}
): boolean {
  const found = containerOf(mathEl);
  if (!found) return false;

  const sorted = [...highlights].sort((a, b) => a.start - b.start);
  const wrapped = wrapTexRanges(tex, sorted);
  const status: TexHighlightStatus[] = [...wrapped.status];
  let drawn: HTMLElement | null = null;
  if (status.includes('wrapped')) {
    const own = rerendered.get(found);
    if (own?.tex === tex && own.wrapped === wrapped.tex) {
      // Drawn from this very TeX already, as a recycled block is: no render
      drawn = found;
      unmark(found);
      found.querySelectorAll(`.${HIGHLIGHT}`).forEach(unmark);
    } else {
      const fresh = renderOrNull(render, wrapped.tex);
      // A rendering that failed shows the formula as drawn, its parts on none
      if (fresh && !failed(fresh)) {
        found.replaceWith(fresh);
        rerendered.set(fresh, { tex, wrapped: wrapped.tex });
        drawn = fresh;
      }
    }
  }
  const target = drawn ?? restore(found, render);
  if (!target) return false;
  sorted.forEach(({ highlight }, i) => {
    if (status[i] !== 'wrapped') return;
    const parts = target.querySelectorAll(`.${texHighlightClass(i)}`);
    // On the whole formula if not drawn wrapped, or dropped by MathJax, as
    // an empty group is
    if (parts.length === 0) status[i] = 'whole';
    for (const part of Array.from(parts)) mark(part, highlight, inert);
  });
  const whole = sorted.filter((_, i) => status[i] === 'whole').at(-1);
  if (whole) mark(target, whole.highlight, inert);
  return true;
}

/**
 * Take every highlight off the formulas in `root`, drawing again from its
 * TeX each this module drew.
 */
export function clearMath(root: HTMLElement, render: RenderMath): void {
  for (const container of Array.from(
    root.querySelectorAll<HTMLElement>(CONTAINER)
  )) {
    restore(container, render);
  }
}

/** How many highlighted elements the formulas in `root` hold. */
export const mathMarkCount = (root: HTMLElement) =>
  root.querySelectorAll(`${CONTAINER}.${HIGHLIGHT}, ${CONTAINER} .${HIGHLIGHT}`)
    .length;

/** A formula's TeX, and where each of its characters is in the markdown. */
export interface MathTex {
  tex: string;
  /** For each character of `tex`, its offset in the markdown; then the end */
  offsets: number[];
}

/** A line's quote markers, as a blockquote or callout prefixes it with */
const QUOTE_MARKERS = /(?:[ \t]*>[ \t]?)+/y;

/**
 * The TeX of the math at `span` in `source` as Obsidian draws it: what lies
 * between its delimiters, less the quote markers starting its lines when it
 * opens in a quote or callout.
 */
export function mathTex(
  source: string,
  { texStart, texEnd }: MathSpan
): MathTex {
  const lineStart = source.lastIndexOf('\n', texStart - 3) + 1;
  QUOTE_MARKERS.lastIndex = lineStart;
  // Only markers, spaces and tabs match, so they end before the `$$`
  const quoted = QUOTE_MARKERS.test(source);
  let tex = '';
  const offsets: number[] = [];
  for (let i = texStart; i < texEnd; i += 1) {
    tex += source[i];
    offsets.push(i);
    if (source[i] === '\n' && quoted) {
      QUOTE_MARKERS.lastIndex = i + 1;
      // Never past the closing `$$`, which no marker takes in
      if (QUOTE_MARKERS.test(source)) i = QUOTE_MARKERS.lastIndex - 1;
    }
  }
  offsets.push(texEnd);
  return { tex, offsets };
}

/** The first index of `offsets` at or past `offset`. */
function indexAt(offsets: readonly number[], offset: number): number {
  const found = offsets.findIndex((at) => at >= offset);
  return found < 0 ? offsets.length - 1 : found;
}

/**
 * Show `highlights` on the `$$ … $$` math of `el`, a rendered section of
 * markdown `section`: each on the part of a formula it covers, as
 * {@link paintMath} shows it.
 *
 * Formulas that can't be paired with the section's `$$`s, one for one, show
 * none.
 */
export function paintSectionMath(
  el: HTMLElement,
  section: ReadingSection,
  highlights: readonly SnippetHighlight[],
  render: RenderMath,
  options: Pick<PaintMathOptions, 'inert'> = {}
): void {
  // Undocumented: Obsidian renders `$$ … $$` as `.math.math-block`
  const blocks = Array.from(
    el.querySelectorAll<HTMLElement>('.math-block')
  ).filter((block) => !block.closest('.internal-embed'));
  const spans = displayMath(section.source);
  if (blocks.length !== spans.length) {
    for (const block of blocks) paintMath(block, '', [], render);
    return;
  }
  blocks.forEach((block, k) => {
    const { tex, offsets } = mathTex(section.source, spans[k]);
    const own = highlights.flatMap((highlight) => {
      const start = indexAt(
        offsets,
        highlight.start_offset - section.bodyOffset
      );
      const end = indexAt(offsets, highlight.end_offset - section.bodyOffset);
      return start < end ? [{ highlight, start, end }] : [];
    });
    paintMath(block, tex, own, render, options);
  });
}
