import type {
  QueueCardMemory,
  QueueRow,
  QueueScheduling,
} from '#/components/types';
import fc from 'fast-check';
import type { TFile } from 'obsidian';
import type { VNode } from 'preact';
import { describe, expect, it } from 'vitest';
import {
  buildQueueColumns,
  cardMemoryParts,
  formatCardMemory,
  formatQueueDate,
  formatQueueDateRange,
  originLabel,
  QUEUE_COLUMN_HEADERS,
  QUEUE_COLUMN_ORDER,
  queueCellTitles,
  renderQueueCells,
  splitReferencePath,
} from './columns';

// #region HELPERS

function makeQueueRow(overrides: Partial<QueueRow> = {}): QueueRow {
  return {
    id: 'a1',
    type: 'article',
    file: { path: 'articles/a1.md' } as TFile,
    due: new Date(2026, 6, 10),
    reference: 'articles/a1.md',
    parent: null,
    scheduling: { kind: 'priority', value: '30' },
    ...overrides,
  };
}

const cardMemoryArb: fc.Arbitrary<QueueCardMemory> = fc.record({
  difficulty: fc.double({ min: 1, max: 10, noNaN: true }),
  stability: fc.double({ min: 0.01, max: 36_500, noNaN: true }),
  retrievability: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), {
    nil: null,
  }),
});

const schedulingArb: fc.Arbitrary<QueueScheduling> = fc.oneof(
  fc.double({ min: 0, max: 100, noNaN: true }).map(
    (value): QueueScheduling => ({
      kind: 'priority',
      value: value.toString(),
    })
  ),
  fc.integer({ min: 1, max: 36_500 }).map(
    (value): QueueScheduling => ({
      kind: 'fixed-interval',
      value: value.toString(),
    })
  ),
  cardMemoryArb.map((value): QueueScheduling => ({ kind: 'srs', value }))
);

/** The folder-prefix span, or `false` where the reference has no separator. */
type ReferencePrefix =
  | VNode<{ className: string; children: VNode<{ children: string }> }>
  | false;

/** The reference cell's vnode: the folder prefix, then the file name. */
type ReferenceCell = VNode<{
  className: string;
  children: [ReferencePrefix, VNode<{ className: string; children: string }>];
}>;

/**
 * Every string rendered under a vnode, in order — so a test can assert what a
 * cell reads as without restating how its parts happen to be nested.
 */
function renderedText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(renderedText).join('');
  if (typeof node === 'object' && node !== null && 'props' in node) {
    return renderedText((node as VNode<{ children?: unknown }>).props.children);
  }
  return '';
}

const queueRowArb: fc.Arbitrary<QueueRow> = fc.record({
  id: fc.string({ minLength: 1 }),
  type: fc.constantFrom<QueueRow['type']>('article', 'snippet', 'card'),
  file: fc.constant({ path: 'articles/a1.md' } as TFile),
  due: fc.option(
    fc.date({
      min: new Date('2000-01-01T00:00:00Z'),
      max: new Date('2099-12-31T23:59:59Z'),
    }),
    { nil: null }
  ),
  reference: fc.string(),
  parent: fc.option(fc.string({ minLength: 1 }), { nil: null }),
  scheduling: schedulingArb,
});

// #endregion

describe('formatQueueDate', () => {
  it('formats a date as YYYY/M/D in local time without zero padding', () => {
    // Constructed with local-time components so the expectation is
    // timezone-independent.
    expect(formatQueueDate(new Date(2026, 6, 10))).toBe('2026/7/10');
  });

  it('renders a null due (no due time) as "--", not the epoch', () => {
    expect(formatQueueDate(null)).toBe('--');
  });

  it('always renders the local year, month, and day separated by slashes', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('2000-01-01T00:00:00Z'),
          max: new Date('2099-12-31T23:59:59Z'),
        }),
        (date) => {
          expect(formatQueueDate(date)).toBe(
            `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
          );
        }
      )
    );
  });
});

describe('formatQueueDateRange', () => {
  it('renders a single-day span as that one day', () => {
    const day = new Date(2026, 6, 31);
    expect(formatQueueDateRange(day, new Date(2026, 6, 31))).toBe('2026/7/31');
  });

  it('omits the shared year when the span crosses a month', () => {
    expect(
      formatQueueDateRange(new Date(2026, 6, 31), new Date(2026, 7, 1))
    ).toBe('2026/7/31 - 8/1');
  });

  it('omits the shared year and month when the span is within one month', () => {
    expect(
      formatQueueDateRange(new Date(2026, 7, 2), new Date(2026, 7, 3))
    ).toBe('2026/8/2 - 3');
  });

  it('keeps the full end date when the span crosses a year', () => {
    expect(
      formatQueueDateRange(new Date(2026, 11, 31), new Date(2027, 0, 1))
    ).toBe('2026/12/31 - 2027/1/1');
  });

  it('shows the month again when the day repeats in a later month', () => {
    // Eliding is left-anchored: the month differs, so the day must be shown
    // alongside it even though it matches the start's day.
    expect(
      formatQueueDateRange(new Date(2026, 6, 2), new Date(2026, 7, 2))
    ).toBe('2026/7/2 - 8/2');
  });

  it('always opens with the start day formatted as the due column formats it', () => {
    const dayArb = fc
      .date({
        min: new Date('2000-01-01T00:00:00Z'),
        max: new Date('2099-12-31T23:59:59Z'),
      })
      .map(
        (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate())
      );

    fc.assert(
      fc.property(dayArb, dayArb, (a, b) => {
        // Ordering is the caller's job (rows are due-ascending); normalise so
        // the property covers spans rather than restating that contract.
        const [start, end] = a <= b ? [a, b] : [b, a];
        const formatted = formatQueueDateRange(start, end);

        expect(formatted.startsWith(formatQueueDate(start))).toBe(true);
        // A span shows exactly one separator; a single day shows none.
        const isSingleDay = start.getTime() === end.getTime();
        expect(formatted.includes(' - ')).toBe(!isSingleDay);
      })
    );
  });

  it('elides only segments the end shares with the start', () => {
    const dayArb = fc
      .date({
        min: new Date('2000-01-01T00:00:00Z'),
        max: new Date('2099-12-31T23:59:59Z'),
      })
      .map(
        (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate())
      );

    fc.assert(
      fc.property(dayArb, dayArb, (a, b) => {
        const [start, end] = a <= b ? [a, b] : [b, a];
        if (start.getTime() === end.getTime()) return;

        const tail = formatQueueDateRange(start, end).split(' - ')[1];
        // The tail keeps every segment from the first differing one onward,
        // so its shape is fixed by which segments match.
        const expected =
          start.getFullYear() !== end.getFullYear()
            ? `${end.getFullYear()}/${end.getMonth() + 1}/${end.getDate()}`
            : start.getMonth() !== end.getMonth()
              ? `${end.getMonth() + 1}/${end.getDate()}`
              : `${end.getDate()}`;
        expect(tail).toBe(expected);
      })
    );
  });
});

describe('renderQueueCells', () => {
  it('produces content for every configured column key', () => {
    fc.assert(
      fc.property(queueRowArb, (row) => {
        const cells = renderQueueCells(row);
        for (const column of buildQueueColumns()) {
          expect(cells[column.key]).toBeDefined();
        }
      })
    );
  });

  it('splits the reference into a folder prefix and the file name', () => {
    const cell = renderQueueCells(
      makeQueueRow({ reference: 'incremental-reading/snippets/s1.md' })
    ).reference as ReferenceCell;
    expect(cell.props.className).toBe('ir-queue-path');
    const [dir, name] = cell.props.children;
    // Each half is its own box because CSS can only ellipsize one end of one
    // box, and this column elides both: the prefix's head and the name's tail.
    expect(dir).toMatchObject({ props: { className: 'ir-queue-path-dir' } });
    expect(name).toMatchObject({ props: { className: 'ir-queue-path-name' } });
    expect(renderedText(name)).toBe('s1.md');
  });

  // The separator never shrinks, so on its own it holds its width while the
  // prefix spends its floor on the ellipsis and whatever still fits beside it —
  // a stray folder character (`…s/`). Carried by the prefix it wins that space,
  // and a prefix squeezed to nothing reads `…/`.
  it('ends the folder prefix with the separator rather than standing it apart', () => {
    const cell = renderQueueCells(
      makeQueueRow({ reference: 'incremental-reading/snippets/s1.md' })
    ).reference as ReferenceCell;
    const [dir] = cell.props.children;
    expect(renderedText(dir)).toBe('incremental-reading/snippets/');
  });

  // A separator is bidi-neutral, and a neutral trailing the right-to-left
  // prefix box is reordered to its front: `snippets/` would read `/snippets`.
  it('isolates the folder prefix, which now ends in a neutral character', () => {
    const cell = renderQueueCells(makeQueueRow({ reference: 'snippets/s1.md' }))
      .reference as ReferenceCell;
    const [dir] = cell.props.children;
    expect(dir).toMatchObject({ props: { children: { type: 'bdi' } } });
  });

  it('renders a folderless reference as the file name alone, with no stray separator', () => {
    const cell = renderQueueCells(makeQueueRow({ reference: 's1.md' }))
      .reference as ReferenceCell;
    const [dir, name] = cell.props.children;
    expect(dir).toBe(false);
    expect(name).toMatchObject({
      props: { className: 'ir-queue-path-name', children: 's1.md' },
    });
  });

  it('shows the whole reference across its parts, dropping no character of it', () => {
    fc.assert(
      fc.property(queueRowArb, (row) => {
        const cell = renderQueueCells(row).reference as ReferenceCell;
        expect(renderedText(cell)).toBe(row.reference);
      })
    );
  });

  it('formats the due cell with formatQueueDate', () => {
    fc.assert(
      fc.property(queueRowArb, (row) => {
        expect(renderQueueCells(row).due).toBe(formatQueueDate(row.due));
      })
    );
  });

  it('renders "--" in the due cell for a row with no due time', () => {
    expect(renderQueueCells(makeQueueRow({ due: null })).due).toBe('--');
  });

  it('labels the scheduling value in-line by kind for non-SRS items', () => {
    fc.assert(
      fc.property(queueRowArb, (row) => {
        fc.pre(row.scheduling.kind !== 'srs');
        const cell = renderQueueCells(row).scheduling;
        const wrapper = cell as VNode<{
          children: [VNode<{ children: string[]; className: string }>, string];
        }>;
        expect(wrapper.type).toBe('span');
        const [label, value] = wrapper.props.children;
        expect(label.props.className).toBe('ir-queue-inline-label');
        const expectedLabel =
          row.scheduling.kind === 'fixed-interval' ? 'Interval' : 'Priority';
        expect(label.props.children.join('')).toBe(`${expectedLabel} `);
        expect(value).toBe(row.scheduling.value);
      })
    );
  });

  it('renders a card D/S/R triple with each label demoted like the Priority label', () => {
    fc.assert(
      fc.property(cardMemoryArb, (memory) => {
        const row = makeQueueRow({
          type: 'card',
          scheduling: { kind: 'srs', value: memory },
        });
        const cell = renderQueueCells(row).scheduling as VNode<{
          className: string;
          children: VNode<{
            className: string;
            children: [
              VNode<{ className: string; children: string[] }>,
              string,
            ];
          }>[];
        }>;
        expect(cell.props.className).toBe('ir-queue-card-memory');
        const parts = cell.props.children;
        expect(parts).toHaveLength(3);
        parts.forEach((part, index) => {
          const expected = cardMemoryParts(memory)[index];
          const [label, value] = part.props.children;
          // The label uses the same muted class as "Priority" / "Interval", so
          // the number stands out against it.
          expect(label.props.className).toBe('ir-queue-inline-label');
          expect(label.props.children.join('')).toBe(`${expected.label} `);
          expect(value).toBe(expected.value);
        });
      })
    );
  });

  it('renders the origin path labelled by type, or an em dash when there is none', () => {
    fc.assert(
      fc.property(queueRowArb, (row) => {
        const cell = renderQueueCells(row).parent as VNode<{
          children: [VNode<{ className: string; children: string[] }>, string];
        }>;
        const [label, value] = cell.props.children;
        expect(label.props.children.join('')).toBe(`${originLabel(row.type)} `);
        expect(value).toBe(row.parent ?? '—');
      })
    );
  });

  // The label is hidden by CSS on the wide layout, where the column header
  // names the column instead; it only shows once rows wrap onto two lines.
  it('carries the label in a class the narrow layout can reveal', () => {
    fc.assert(
      fc.property(queueRowArb, (row) => {
        const cell = renderQueueCells(row).parent as VNode<{
          children: [VNode<{ className: string }>, string];
        }>;
        expect(cell.props.children[0].props.className).toContain(
          'ir-queue-origin-label'
        );
      })
    );
  });
});

describe('formatCardMemory', () => {
  it('labels difficulty, stability, and retrievability as D, S, and R', () => {
    expect(
      formatCardMemory({
        difficulty: 5.23,
        stability: 12.4,
        retrievability: 0.9,
      })
    ).toBe('D 5.2 · S 12.4 · R 0.90');
  });

  it('renders a missing retrievability as "--" and keeps D and S', () => {
    expect(
      formatCardMemory({ difficulty: 5, stability: 2, retrievability: null })
    ).toBe('D 5.0 · S 2.0 · R --');
  });

  it('always shows all three labels in D, S, R order', () => {
    fc.assert(
      fc.property(cardMemoryArb, (memory) => {
        const text = formatCardMemory(memory);
        expect(text.indexOf('D ')).toBeLessThan(text.indexOf('S '));
        expect(text.indexOf('S ')).toBeLessThan(text.indexOf('R '));
      })
    );
  });

  // The cell renders label/value spans while the tooltip is a plain string, so
  // the two are built from the same parts and must not drift apart.
  it('shows the same labels and values the cell renders', () => {
    fc.assert(
      fc.property(cardMemoryArb, (memory) => {
        const text = formatCardMemory(memory);
        for (const part of cardMemoryParts(memory)) {
          expect(text).toContain(`${part.label} ${part.value}`);
        }
      })
    );
  });
});

describe('originLabel', () => {
  it("calls an article's origin its Source and an extracted item's its Parent", () => {
    expect(originLabel('article')).toBe('Source');
    expect(originLabel('snippet')).toBe('Parent');
    expect(originLabel('card')).toBe('Parent');
  });
});

describe('splitReferencePath', () => {
  it('splits at the last separator, keeping every folder in the prefix', () => {
    expect(splitReferencePath('incremental-reading/snippets/s1.md')).toEqual({
      dir: 'incremental-reading/snippets',
      name: 's1.md',
    });
  });

  it('gives a path with no folder an empty prefix', () => {
    expect(splitReferencePath('s1.md')).toEqual({ dir: '', name: 's1.md' });
  });

  // The point of the split: the name half is what stays anchored on screen, so
  // it must never carry a folder along with it.
  it('leaves the name half free of separators, whatever the path', () => {
    fc.assert(
      fc.property(fc.string(), (path) => {
        expect(splitReferencePath(path).name).not.toContain('/');
      })
    );
  });

  it('rejoins to the original path, so no character is dropped or duplicated', () => {
    fc.assert(
      fc.property(fc.string(), (path) => {
        const { dir, name } = splitReferencePath(path);
        expect(path.includes('/') ? `${dir}/${name}` : name).toBe(path);
      })
    );
  });
});

describe('queueCellTitles', () => {
  it('produces a plain-text title for every configured column', () => {
    fc.assert(
      fc.property(queueRowArb, (row) => {
        const titles = queueCellTitles(row);
        for (const column of buildQueueColumns()) {
          expect(typeof titles[column.key]).toBe('string');
        }
      })
    );
  });

  it('titles the reference and parent cells with their full untruncated text', () => {
    fc.assert(
      fc.property(queueRowArb, (row) => {
        const titles = queueCellTitles(row);
        expect(titles.reference).toBe(row.reference);
        expect(titles.parent).toBe(
          `${originLabel(row.type)} ${row.parent ?? '—'}`
        );
      })
    );
  });

  it('titles the scheduling cell with the same text the cell shows', () => {
    fc.assert(
      fc.property(queueRowArb, (row) => {
        const title = queueCellTitles(row).scheduling;
        if (row.scheduling.kind === 'srs') {
          expect(title).toBe(formatCardMemory(row.scheduling.value));
        } else {
          expect(title).toContain(row.scheduling.value);
        }
      })
    );
  });

  // The icon vnodes are inspected rather than mounted: lucide-react icons use
  // hooks, and rendering them under Vitest trips the dual preact instance
  // problem noted in vitest.config.ts ("alias react to preact" TODO).
  it('wraps a distinct icon per item type in an HTML element', () => {
    const types: QueueRow['type'][] = ['article', 'snippet', 'card'];
    const iconComponents = types.map((type) => {
      const cell = renderQueueCells(makeQueueRow({ type })).type as VNode<{
        className: string;
        children: VNode;
      }>;
      // An HTML wrapper, never a bare SVG: Obsidian's tooltip handler calls
      // isShown() on the labelled element, which SVG elements lack. The label
      // itself lives on the enclosing cell, so the wrapper must not carry one.
      expect(cell.type, `wrapper for ${type}`).toBe('span');
      expect(cell.props.className, `wrapper class for ${type}`).toBe(
        'ir-queue-type-icon'
      );
      const icon = cell.props.children;
      expect(icon.type, `icon for ${type}`).not.toBeTypeOf('string');
      return icon.type;
    });
    expect(new Set(iconComponents).size).toBe(types.length);
  });

  // Two nested labels would render two stacked tooltips on the type column.
  it('gives the type icon no label of its own, leaving the cell to carry it', () => {
    const types: QueueRow['type'][] = ['article', 'snippet', 'card'];
    for (const type of types) {
      const cell = renderQueueCells(makeQueueRow({ type })).type as VNode<
        Record<string, unknown>
      >;
      expect(cell.props['aria-label'], `label for ${type}`).toBeUndefined();
      expect(cell.props.title, `title for ${type}`).toBeUndefined();
      // The type is still named on hover, via the cell's own label.
      expect(queueCellTitles(makeQueueRow({ type })).type).toBe(type);
    }
  });
});

describe('queue column configuration', () => {
  it('orders columns as type, due, reference, parent, then scheduling', () => {
    expect(QUEUE_COLUMN_ORDER).toEqual([
      'type',
      'due',
      'reference',
      'parent',
      'scheduling',
    ]);
  });

  it('provides a header label for every configured column', () => {
    for (const column of buildQueueColumns()) {
      expect(QUEUE_COLUMN_HEADERS[column.key]).toBeTruthy();
    }
  });

  it('orders exactly the configured columns, with no key missing or unknown', () => {
    const configured = buildQueueColumns().map((column) => column.key);
    expect([...QUEUE_COLUMN_ORDER].sort()).toEqual([...configured].sort());
  });

  // A phone row is two lines: the metadata line, then the reference. Each path
  // column costs a line of its own in the narrow layout, so the origin column
  // is the one dropped rather than the third line it would cost.
  it('keeps every column but the origin one on mobile', () => {
    const mobileVisible = new Map(
      buildQueueColumns().map((column) => [column.key, column.mobileVisible])
    );
    expect(mobileVisible.get('type')).toBe(true);
    expect(mobileVisible.get('due')).toBe(true);
    expect(mobileVisible.get('scheduling')).toBe(true);
    expect(mobileVisible.get('reference')).toBe(true);
    expect(mobileVisible.get('parent')).toBe(false);
  });

  it('sizes the short columns to their content and the path columns flexibly', () => {
    const widths = new Map(
      buildQueueColumns().map((column) => [column.key, column.width])
    );
    expect(widths.get('type')).toBe('content');
    expect(widths.get('due')).toBe('content');
    expect(widths.get('scheduling')).toBe('content');
    expect(widths.get('reference')).toBe('flexible');
    expect(widths.get('parent')).toBe('flexible');
  });
});
