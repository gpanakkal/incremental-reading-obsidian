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
  originLabel,
  QUEUE_COLUMN_HEADERS,
  QUEUE_COLUMN_ORDER,
  queueCellTitles,
  renderQueueCells,
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

  it('passes the reference through unchanged', () => {
    fc.assert(
      fc.property(queueRowArb, (row) => {
        expect(renderQueueCells(row).reference).toBe(row.reference);
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
            children: [VNode<{ className: string; children: string[] }>, string];
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
        expect(label.props.children.join('')).toBe(
          `${originLabel(row.type)} `
        );
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
      formatCardMemory({ difficulty: 5.23, stability: 12.4, retrievability: 0.9 })
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
