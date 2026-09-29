import { TRANSCLUSION_HIDE_TITLE_ALIAS } from '#/lib/constants';
import { type EditorView, type ViewUpdate, ViewPlugin } from '@codemirror/view';

/**
 * Fits the accent rule and the open-in-tab button of a title-hidden
 * transclusion to the rows its text actually occupies, in Live Preview.
 *
 * A card made from part of a paragraph leaves its embed mid-line: the host
 * `.cm-line` holds text before the embed, the embed, and text after it, wrapped
 * over however many visual rows the width allows. Painting the rule on the host
 * (a full-height background) marked every row of the paragraph as card text,
 * and Obsidian's button sat on the host's top corner, which is a row of
 * ordinary text whenever the embed does not open the paragraph.
 *
 * Which rows the embed's text lands on is a layout fact — it moves with the
 * width, the font, and every edit before it on the line — so CSS cannot know
 * it. This measures it instead: the embed is an inline box, and
 * `getClientRects()` returns one rect per row it wraps across. The result is
 * handed to `styles.css` as custom properties on the embed element, where the
 * rule (`::before`) and the button, both positioned against the host line,
 * read it.
 *
 * The properties go on the embed rather than the `.cm-line`: CodeMirror owns
 * the line element and wipes attributes it did not set the next time it syncs
 * the line, while the embed is widget DOM, whose mutations CodeMirror ignores
 * (Obsidian itself fills it in asynchronously).
 */

/** The title-hidden transclusions a Live Preview line can host. */
const EMBED_SELECTOR = `.internal-embed[alt*='${TRANSCLUSION_HIDE_TITLE_ALIAS}']`;
const HOSTED_EMBED_SELECTOR = `.cm-line > ${EMBED_SELECTOR}`;

/** Obsidian's open-in-tab button on an embed (`.markdown-embed-link`). */
const EMBED_LINK_SELECTOR = ':scope > .markdown-embed-link';

/** Custom properties `styles.css` reads the measured geometry from. */
export const GEOMETRY_PROPERTIES = {
  ruleLeft: '--ir-embed-rule-left',
  ruleTop: '--ir-embed-rule-top',
  ruleHeight: '--ir-embed-rule-height',
  linkTop: '--ir-embed-link-top',
} as const;

/** The parts of a `DOMRect` the geometry reads, in viewport pixels. */
export interface RectLike {
  top: number;
  bottom: number;
  height: number;
}

/** Where the host line's absolutely positioned children are measured from. */
export interface HostMetrics {
  /** Viewport y of the host's padding-box top edge. */
  originTop: number;
  /** Height of the host's padding box, in CSS pixels. */
  height: number;
  /** Offset of the host's content box from its padding box, in CSS pixels. */
  contentLeft: number;
  /** Viewport pixels per CSS pixel, vertically (a transformed editor). */
  scaleY: number;
}

/** Placement of the rule and the button, in the host's CSS pixels. */
export interface EmbedGeometry {
  ruleLeft: number;
  ruleTop: number;
  ruleHeight: number;
  /** `null` when the embed has no button laid out. */
  linkTop: number | null;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

/**
 * Place the rule and the button for one embed.
 *
 * The rule runs from the top of the first row the embed's text is on to the
 * bottom of the last, at the host's content edge — where the full-height rule
 * used to sit. The button is centred on the first of those rows. Both stay
 * inside the host: a fragment's box can overhang its row by the embed's
 * `padding-block`, and on the host's first or last row that overhang would
 * otherwise poke into the neighbouring line.
 *
 * @param fragments the embed's `getClientRects()`, one per row it wraps across
 * @param linkHeight the button's height in viewport pixels, or `null` when it
 * has none laid out
 * @returns `null` when no fragment has any height, i.e. nothing is rendered
 */
export function computeEmbedGeometry(
  host: HostMetrics,
  fragments: readonly RectLike[],
  linkHeight: number | null
): EmbedGeometry | null {
  const rendered = fragments.filter((rect) => rect.height > 0);
  if (rendered.length === 0) return null;

  const toLocal = (y: number) => (y - host.originTop) / host.scaleY;

  // The first row is wherever the topmost fragment starts. Several fragments
  // can share it (a run split by bidi text); the row is as tall as the tallest.
  const firstTop = Math.min(...rendered.map((rect) => rect.top));
  const firstBottom = Math.max(
    ...rendered
      .filter((rect) => rect.top === firstTop)
      .map((rect) => rect.bottom)
  );
  const top = clamp(toLocal(firstTop), 0, host.height);
  const bottom = clamp(
    toLocal(Math.max(...rendered.map((rect) => rect.bottom))),
    top,
    host.height
  );

  let linkTop: number | null = null;
  if (linkHeight !== null) {
    const height = linkHeight / host.scaleY;
    const rowCenter = toLocal((firstTop + firstBottom) / 2);
    linkTop = clamp(
      rowCenter - height / 2,
      0,
      Math.max(0, host.height - height)
    );
  }

  return {
    ruleLeft: host.contentLeft,
    ruleTop: top,
    ruleHeight: bottom - top,
    linkTop,
  };
}

/** Read one hosted embed's geometry from the live layout. */
export function measureEmbed(
  embed: HTMLElement,
  host: HTMLElement,
  scaleY: number
): EmbedGeometry | null {
  const hostRect = host.getBoundingClientRect();
  const link = embed.querySelector<HTMLElement>(EMBED_LINK_SELECTOR);
  const linkHeight = link?.getBoundingClientRect().height ?? 0;

  return computeEmbedGeometry(
    {
      originTop: hostRect.top + host.clientTop * scaleY,
      height: host.clientHeight,
      contentLeft: Number.parseFloat(getComputedStyle(host).paddingLeft) || 0,
      scaleY,
    },
    Array.from(embed.getClientRects()),
    linkHeight > 0 ? linkHeight : null
  );
}

/** Hand `geometry` to the stylesheet, or withdraw it when there is none. */
export function applyEmbedGeometry(
  embed: HTMLElement,
  geometry: EmbedGeometry | null
): void {
  const set = (property: string, value: number | null | undefined) => {
    if (value === null || value === undefined) {
      embed.style.removeProperty(property);
    } else {
      embed.style.setProperty(property, `${value}px`);
    }
  };
  set(GEOMETRY_PROPERTIES.ruleLeft, geometry?.ruleLeft);
  set(GEOMETRY_PROPERTIES.ruleTop, geometry?.ruleTop);
  set(GEOMETRY_PROPERTIES.ruleHeight, geometry?.ruleHeight);
  set(GEOMETRY_PROPERTIES.linkTop, geometry?.linkTop);
}

/**
 * Whether a `childList` mutation happened inside a title-hidden transclusion.
 * A `childList` record's target is the parent whose children changed, which is
 * always an element under the content DOM.
 */
function isInsideEmbed(record: MutationRecord): boolean {
  return (record.target as Element).closest(EMBED_SELECTOR) !== null;
}

type Measured = { embed: HTMLElement; geometry: EmbedGeometry | null }[];

/**
 * Re-measures on every update that can move text between rows: an edit, a
 * scroll that renders new lines, or a change in line heights or width. The
 * mutation observer covers what CodeMirror does not see: Obsidian fills an
 * embed in after the update that created it, and the loaded text is what
 * decides which rows the embed spans.
 */
export class TransclusionGeometryPlugin {
  private readonly observer: MutationObserver;
  private readonly measureRequest: {
    key: TransclusionGeometryPlugin;
    read: (view: EditorView) => Measured;
    write: (measured: Measured) => void;
  };

  constructor(view: EditorView) {
    this.measureRequest = {
      key: this,
      read: (view) =>
        Array.from(
          view.contentDOM.querySelectorAll<HTMLElement>(HOSTED_EMBED_SELECTOR),
          (embed) => ({
            embed,
            geometry: measureEmbed(
              embed,
              embed.parentElement as HTMLElement,
              view.scaleY
            ),
          })
        ),
      write: (measured) => {
        for (const { embed, geometry } of measured) {
          applyEmbedGeometry(embed, geometry);
        }
      },
    };

    // `childList` alone: the writes above are attribute changes, so they can
    // never feed back into another measurement.
    this.observer = new MutationObserver((records) => {
      if (records.some(isInsideEmbed)) view.requestMeasure(this.measureRequest);
    });
    this.observer.observe(view.contentDOM, { childList: true, subtree: true });

    view.requestMeasure(this.measureRequest);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || update.geometryChanged) {
      update.view.requestMeasure(this.measureRequest);
    }
  }

  destroy() {
    this.observer.disconnect();
  }
}

export const transclusionGeometryExtension = ViewPlugin.fromClass(
  TransclusionGeometryPlugin
);
