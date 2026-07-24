import type { QueueRow, QueueScheduling } from '#/components/types';
import fc from 'fast-check';
import type { TFile } from 'obsidian';
import type { VNode } from 'preact';
import { describe, expect, it } from 'vitest';
import {
  buildQueueColumns,
  formatQueueDate,
  QUEUE_COLUMN_HEADERS,
  QUEUE_COLUMN_ORDER,
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
    scheduling: { kind: 'priority', value: '30' },
    ...overrides,
  };
}

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
  fc.constant<QueueScheduling>({ kind: 'none', value: null })
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

  it('labels the scheduling value in-line by kind, or shows an em dash for unscheduled cards', () => {
    fc.assert(
      fc.property(queueRowArb, (row) => {
        const cell = renderQueueCells(row).scheduling;
        if (row.scheduling.value === null) {
          expect(cell).toBe('—');
          return;
        }
        const wrapper = cell as VNode<{
          children: [VNode<{ children: string[]; className: string }>, number];
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

  // The icon vnodes are inspected rather than mounted: lucide-react icons use
  // hooks, and rendering them under Vitest trips the dual preact instance
  // problem noted in vitest.config.ts ("alias react to preact" TODO).
  it('wraps a distinct icon per item type in an HTML element labelled with the type', () => {
    const types: QueueRow['type'][] = ['article', 'snippet', 'card'];
    const iconComponents = types.map((type) => {
      const cell = renderQueueCells(makeQueueRow({ type })).type as VNode<{
        'aria-label': string;
        className: string;
        children: VNode;
      }>;
      // The aria-label must NOT be on the SVG: Obsidian's tooltip handler
      // calls isShown() on the labelled element, which SVG elements lack.
      expect(cell.type, `wrapper for ${type}`).toBe('span');
      expect(cell.props['aria-label'], `label for ${type}`).toBe(type);
      expect(cell.props.className, `wrapper class for ${type}`).toBe(
        'ir-queue-type-icon'
      );
      const icon = cell.props.children;
      expect(icon.type, `icon for ${type}`).not.toBeTypeOf('string');
      return icon.type;
    });
    expect(new Set(iconComponents).size).toBe(types.length);
  });
});

describe('queue column configuration', () => {
  it('orders columns as type, due, reference, then scheduling', () => {
    expect(QUEUE_COLUMN_ORDER).toEqual([
      'type',
      'due',
      'reference',
      'scheduling',
    ]);
  });

  it('provides a header label for every configured column', () => {
    for (const column of buildQueueColumns()) {
      expect(QUEUE_COLUMN_HEADERS[column.key]).toBeTruthy();
    }
  });
});
