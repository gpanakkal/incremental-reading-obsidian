// @vitest-environment jsdom

import {
  applyEmbedGeometry,
  computeEmbedGeometry,
  GEOMETRY_PROPERTIES,
  measureEmbed,
  TransclusionGeometryPlugin,
  type EmbedGeometry,
  type HostMetrics,
  type RectLike,
} from '#/lib/extensions/TransclusionGeometryExtension';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

// #region HELPERS

/** A viewport-pixel rect with a real (possibly zero) height. */
const rect = (top: number, height: number): RectLike => ({
  top,
  height,
  bottom: top + height,
});

const finite = (min: number, max: number) =>
  fc.double({ min, max, noNaN: true, noDefaultInfinity: true });

const hostArb: fc.Arbitrary<HostMetrics> = fc.record({
  originTop: finite(-5000, 5000),
  height: finite(0, 2000),
  contentLeft: finite(0, 200),
  scaleY: finite(0.25, 4),
});

/** Fragments anywhere around the host, including ones with no height. */
const fragmentArb = fc
  .tuple(finite(-6000, 8000), fc.oneof(fc.constant(0), finite(0, 100)))
  .map(([top, height]) => rect(top, height));
const fragmentsArb = fc.array(fragmentArb, { maxLength: 8 });

const linkHeightArb = fc.option(finite(0.5, 60), { nil: null });

/** The host-local y of a viewport y. */
const local = (host: HostMetrics, y: number) =>
  (y - host.originTop) / host.scaleY;

/**
 * A host with fragments that sit wholly inside it and a button that fits, so
 * nothing is clamped.
 */
const unclampedArb = fc
  .record({
    originTop: finite(-5000, 5000),
    scaleY: finite(0.25, 4),
    contentLeft: finite(0, 200),
    rows: fc.array(fc.tuple(finite(0, 1), finite(0, 1)), {
      minLength: 1,
      maxLength: 6,
    }),
    height: finite(100, 2000),
  })
  .map(({ originTop, scaleY, contentLeft, rows, height }) => {
    const host: HostMetrics = { originTop, height, contentLeft, scaleY };
    // Each row placed inside the host, in viewport pixels.
    const fragments = rows.map(([start, span]) => {
      const top = start * (height - 50);
      const size = 1 + span * (height - top - 1);
      return rect(originTop + top * scaleY, size * scaleY);
    });
    return { host, fragments };
  });

function makeView() {
  const contentDOM = document.createElement('div');
  document.body.appendChild(contentDOM);
  const requestMeasure = vi.fn();
  const view = { contentDOM, requestMeasure, scaleY: 1 };
  return { view, contentDOM, requestMeasure };
}

type Request = {
  read: (view: EditorView) => { embed: HTMLElement; geometry: unknown }[];
  write: (measured: { embed: HTMLElement; geometry: unknown }[]) => void;
};

/** An embed Obsidian would render for a title-hidden transclusion. */
function makeEmbed(alt = 'ir-hide-title') {
  const embed = document.createElement('div');
  embed.className = 'internal-embed markdown-embed';
  embed.setAttribute('alt', alt);
  return embed;
}

function makeLine(...children: HTMLElement[]) {
  const line = document.createElement('div');
  line.className = 'cm-line';
  line.append(...children);
  return line;
}

/** Give `host` and `embed` a layout jsdom cannot compute. */
function layOut(
  host: HTMLElement,
  embed: HTMLElement,
  {
    hostTop = 100,
    clientTop = 0,
    clientHeight = 96,
    fragments = [rect(124, 24), rect(148, 24)],
  }: {
    hostTop?: number;
    clientTop?: number;
    clientHeight?: number;
    fragments?: RectLike[];
  } = {}
) {
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
    top: hostTop,
  } as DOMRect);
  Object.defineProperty(host, 'clientTop', { value: clientTop });
  Object.defineProperty(host, 'clientHeight', { value: clientHeight });
  vi.spyOn(embed, 'getClientRects').mockReturnValue(
    fragments as unknown as DOMRectList
  );
}

const flushMutations = () => new Promise((resolve) => setTimeout(resolve, 0));

const updateWith = (
  view: unknown,
  flags: Partial<
    Record<'docChanged' | 'viewportChanged' | 'geometryChanged', boolean>
  >
) =>
  ({
    view,
    docChanged: false,
    viewportChanged: false,
    geometryChanged: false,
    ...flags,
  }) as unknown as ViewUpdate;

// #endregion

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('computeEmbedGeometry', () => {
  it('fits the rule to the rows the embed is on and centres the button on the first, as measured in Obsidian', () => {
    // A card starting on the second row of a paragraph laid out 24px a row,
    // its fragments overhanging each row by the embed's padding.
    const host = { originTop: 226, height: 168, contentLeft: 0, scaleY: 1 };
    const fragments = [rect(248, 27), rect(272, 27), rect(296, 27)];

    expect(computeEmbedGeometry(host, fragments, 24)).toEqual({
      ruleLeft: 0,
      ruleTop: 22,
      ruleHeight: 75,
      linkTop: 23.5,
    });
  });

  it('is null exactly when no fragment has any height', () => {
    fc.assert(
      fc.property(hostArb, fragmentsArb, linkHeightArb, (host, frags, link) => {
        const geometry = computeEmbedGeometry(host, frags, link);
        expect(geometry === null).toBe(frags.every((f) => f.height === 0));
      })
    );
  });

  it('puts the rule on the host content edge, never outside the host', () => {
    fc.assert(
      fc.property(hostArb, fragmentsArb, linkHeightArb, (host, frags, link) => {
        const geometry = computeEmbedGeometry(host, frags, link);
        fc.pre(geometry !== null);
        expect(geometry.ruleLeft).toBe(host.contentLeft);
        expect(geometry.ruleTop).toBeGreaterThanOrEqual(0);
        expect(geometry.ruleHeight).toBeGreaterThanOrEqual(0);
        expect(geometry.ruleTop + geometry.ruleHeight).toBeLessThanOrEqual(
          host.height + 1e-9
        );
      })
    );
  });

  it('keeps the button inside the host whenever it fits', () => {
    fc.assert(
      fc.property(
        hostArb,
        fragmentsArb,
        finite(0.5, 60),
        (host, frags, linkHeight) => {
          const geometry = computeEmbedGeometry(host, frags, linkHeight);
          fc.pre(geometry !== null);
          const height = linkHeight / host.scaleY;
          expect(geometry.linkTop).toBeGreaterThanOrEqual(0);
          expect(geometry.linkTop!).toBeLessThanOrEqual(
            Math.max(0, host.height - height) + 1e-9
          );
        }
      )
    );
  });

  it('spans from the top of the first row to the bottom of the last, in host pixels', () => {
    fc.assert(
      fc.property(unclampedArb, ({ host, fragments }) => {
        const geometry = computeEmbedGeometry(host, fragments, null)!;
        const top = Math.min(...fragments.map((f) => f.top));
        const bottom = Math.max(...fragments.map((f) => f.bottom));
        expect(geometry.ruleTop).toBeCloseTo(local(host, top), 6);
        expect(geometry.ruleTop + geometry.ruleHeight).toBeCloseTo(
          local(host, bottom),
          6
        );
      })
    );
  });

  it('centres the button on the topmost row, whatever order the rows come in', () => {
    fc.assert(
      fc.property(
        unclampedArb,
        finite(0.5, 20),
        ({ host, fragments }, linkHeight) => {
          const firstTop = Math.min(...fragments.map((f) => f.top));
          const firstBottom = Math.max(
            ...fragments.filter((f) => f.top === firstTop).map((f) => f.bottom)
          );
          const center = local(host, (firstTop + firstBottom) / 2);
          const height = linkHeight / host.scaleY;
          fc.pre(center - height / 2 >= 0);
          fc.pre(center + height / 2 <= host.height);

          const geometry = computeEmbedGeometry(host, fragments, linkHeight)!;
          expect(geometry.linkTop! + height / 2).toBeCloseTo(center, 6);

          const reversed = computeEmbedGeometry(
            host,
            [...fragments].reverse(),
            linkHeight
          );
          expect(reversed).toEqual(geometry);
        }
      )
    );
  });

  it('centres the button on the tallest of the fragments that open the first row', () => {
    const host = { originTop: 0, height: 100, contentLeft: 0, scaleY: 1 };
    const fragments = [rect(10, 10), rect(10, 20), rect(40, 20)];

    expect(computeEmbedGeometry(host, fragments, 10)?.linkTop).toBe(15);
    expect(
      computeEmbedGeometry(host, [...fragments].reverse(), 10)?.linkTop
    ).toBe(15);
  });

  it('clamps the button to the host top and bottom when the row would push it out', () => {
    const host = { originTop: 0, height: 30, contentLeft: 0, scaleY: 1 };

    expect(computeEmbedGeometry(host, [rect(-10, 10)], 20)?.linkTop).toBe(0);
    expect(computeEmbedGeometry(host, [rect(28, 10)], 20)?.linkTop).toBe(10);
    // Taller than the host: pinned to its top rather than hanging above it.
    expect(computeEmbedGeometry(host, [rect(0, 30)], 40)?.linkTop).toBe(0);
  });

  it('ignores fragments with no height', () => {
    fc.assert(
      fc.property(
        hostArb,
        fragmentsArb,
        fc.array(finite(-6000, 8000), { maxLength: 4 }),
        linkHeightArb,
        (host, frags, emptyTops, link) => {
          const empties = emptyTops.map((top) => rect(top, 0));
          expect(
            computeEmbedGeometry(host, [...empties, ...frags], link)
          ).toEqual(computeEmbedGeometry(host, frags, link));
        }
      )
    );
  });

  it('has no button placement when the embed has no button', () => {
    fc.assert(
      fc.property(hostArb, fragmentsArb, (host, frags) => {
        const geometry = computeEmbedGeometry(host, frags, null);
        fc.pre(geometry !== null);
        expect(geometry.linkTop).toBeNull();
      })
    );
  });
});

describe('measureEmbed', () => {
  it('measures from the host padding box, at the view scale, with the button height', () => {
    const embed = makeEmbed();
    const link = document.createElement('div');
    link.className = 'markdown-embed-link';
    embed.appendChild(link);
    const host = makeLine(embed);
    host.style.paddingLeft = '12px';
    document.body.appendChild(host);
    layOut(host, embed, {
      hostTop: 100,
      clientTop: 2,
      clientHeight: 96,
      fragments: [rect(140, 48), rect(188, 48)],
    });
    vi.spyOn(link, 'getBoundingClientRect').mockReturnValue({
      height: 24,
    } as DOMRect);

    // Scale 2: the padding box starts at 100 + 2 * 2 = 104 in the viewport.
    expect(measureEmbed(embed, host, 2)).toEqual({
      ruleLeft: 12,
      ruleTop: 18,
      ruleHeight: 48,
      linkTop: 24,
    });
  });

  it('has no button placement when the button is missing or not laid out', () => {
    const embed = makeEmbed();
    const host = makeLine(embed);
    document.body.appendChild(host);
    layOut(host, embed);

    expect(measureEmbed(embed, host, 1)?.linkTop).toBeNull();

    const link = document.createElement('div');
    link.className = 'markdown-embed-link';
    embed.appendChild(link);
    expect(measureEmbed(embed, host, 1)?.linkTop).toBeNull();
  });

  it('only takes the button that belongs to this embed', () => {
    const embed = makeEmbed();
    const nested = document.createElement('div');
    const link = document.createElement('div');
    link.className = 'markdown-embed-link';
    nested.appendChild(link);
    embed.appendChild(nested);
    const host = makeLine(embed);
    document.body.appendChild(host);
    layOut(host, embed);
    vi.spyOn(link, 'getBoundingClientRect').mockReturnValue({
      height: 24,
    } as DOMRect);

    expect(measureEmbed(embed, host, 1)?.linkTop).toBeNull();
  });

  it('puts the rule at the padding edge when the host has no padding', () => {
    const embed = makeEmbed();
    const host = makeLine(embed);
    document.body.appendChild(host);
    layOut(host, embed);

    expect(measureEmbed(embed, host, 1)?.ruleLeft).toBe(0);
  });
});

describe('applyEmbedGeometry', () => {
  const readAll = (embed: HTMLElement) =>
    Object.values(GEOMETRY_PROPERTIES).map((name) =>
      embed.style.getPropertyValue(name)
    );

  it('hands every measurement to the stylesheet in pixels', () => {
    fc.assert(
      fc.property(
        fc.record({
          ruleLeft: finite(0, 500),
          ruleTop: finite(0, 500),
          ruleHeight: finite(0, 500),
          linkTop: finite(0, 500),
        }),
        (geometry) => {
          const embed = makeEmbed();
          applyEmbedGeometry(embed, geometry);
          expect(readAll(embed)).toEqual([
            `${geometry.ruleLeft}px`,
            `${geometry.ruleTop}px`,
            `${geometry.ruleHeight}px`,
            `${geometry.linkTop}px`,
          ]);
        }
      )
    );
  });

  it('withdraws the button placement alone when there is no button', () => {
    const embed = makeEmbed();
    applyEmbedGeometry(embed, {
      ruleLeft: 1,
      ruleTop: 2,
      ruleHeight: 3,
      linkTop: 4,
    });
    applyEmbedGeometry(embed, {
      ruleLeft: 1,
      ruleTop: 2,
      ruleHeight: 3,
      linkTop: null,
    });

    expect(readAll(embed)).toEqual(['1px', '2px', '3px', '']);
  });

  it('withdraws everything when nothing is rendered', () => {
    const embed = makeEmbed();
    const geometry: EmbedGeometry = {
      ruleLeft: 1,
      ruleTop: 2,
      ruleHeight: 3,
      linkTop: 4,
    };
    applyEmbedGeometry(embed, geometry);
    applyEmbedGeometry(embed, null);

    expect(readAll(embed)).toEqual(['', '', '', '']);
  });
});

describe('TransclusionGeometryPlugin', () => {
  it('measures and styles every title-hidden embed hosted by a line, and no other', async () => {
    const { view, contentDOM, requestMeasure } = makeView();
    const hosted = makeEmbed();
    const otherAlias = makeEmbed('something-else');
    const standalone = makeEmbed();
    const hostedLine = makeLine(hosted, otherAlias);
    contentDOM.append(hostedLine, standalone);
    layOut(hostedLine, hosted);

    new TransclusionGeometryPlugin(view as unknown as EditorView);

    expect(requestMeasure).toHaveBeenCalledTimes(1);
    const request = requestMeasure.mock.calls[0][0] as Request;
    const measured = request.read(view as unknown as EditorView);
    expect(measured.map(({ embed }) => embed)).toEqual([hosted]);

    request.write(measured);
    expect(hosted.style.getPropertyValue(GEOMETRY_PROPERTIES.ruleTop)).toBe(
      '24px'
    );
    expect(hosted.style.getPropertyValue(GEOMETRY_PROPERTIES.ruleHeight)).toBe(
      '48px'
    );
    expect(otherAlias.getAttribute('style')).toBeNull();
    expect(standalone.getAttribute('style')).toBeNull();
    await flushMutations();
  });

  it('re-measures on edits, scrolls and geometry changes, and nothing else', () => {
    const { view, requestMeasure } = makeView();
    const plugin = new TransclusionGeometryPlugin(
      view as unknown as EditorView
    );
    const request: unknown = requestMeasure.mock.calls[0][0];
    requestMeasure.mockClear();

    plugin.update(updateWith(view, {}));
    expect(requestMeasure).not.toHaveBeenCalled();

    for (const flag of [
      'docChanged',
      'viewportChanged',
      'geometryChanged',
    ] as const) {
      requestMeasure.mockClear();
      plugin.update(updateWith(view, { [flag]: true }));
      expect(requestMeasure).toHaveBeenCalledExactlyOnceWith(request);
    }
  });

  it('re-measures when an embed fills in, but not for other DOM changes or after it is destroyed', async () => {
    const { view, contentDOM, requestMeasure } = makeView();
    const embed = makeEmbed();
    const content = document.createElement('div');
    embed.appendChild(content);
    const plain = document.createElement('span');
    contentDOM.append(makeLine(embed), makeLine(plain));
    const plugin = new TransclusionGeometryPlugin(
      view as unknown as EditorView
    );
    const request: unknown = requestMeasure.mock.calls[0][0];
    requestMeasure.mockClear();

    plain.appendChild(document.createElement('b'));
    await flushMutations();
    expect(requestMeasure).not.toHaveBeenCalled();

    content.appendChild(document.createElement('p'));
    await flushMutations();
    expect(requestMeasure).toHaveBeenCalledExactlyOnceWith(request);

    // One batch holding both kinds still counts.
    requestMeasure.mockClear();
    plain.appendChild(document.createElement('i'));
    content.appendChild(document.createElement('p'));
    await flushMutations();
    expect(requestMeasure).toHaveBeenCalledExactlyOnceWith(request);

    // Its own writes are style changes, which must not loop back into it.
    requestMeasure.mockClear();
    applyEmbedGeometry(embed, {
      ruleLeft: 0,
      ruleTop: 0,
      ruleHeight: 1,
      linkTop: null,
    });
    await flushMutations();
    expect(requestMeasure).not.toHaveBeenCalled();

    plugin.destroy();
    content.appendChild(document.createElement('p'));
    await flushMutations();
    expect(requestMeasure).not.toHaveBeenCalled();
  });
});
