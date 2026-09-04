// @vitest-environment jsdom
import type { QueueRow } from '#/components/types';
import fc from 'fast-check';
import type { TFile } from 'obsidian';
import type { ComponentChild } from 'preact';
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueColumnKey } from './columns';
import { buildQueueColumns } from './columns';
import { QueueTable } from './QueueTable';

// #region HELPERS

/** Render a component into a detached jsdom container and return it. */
function mount(node: ComponentChild): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  render(node as never, container);
  return container;
}

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

/** Cell renderer stub with per-column, per-row identifiable output. */
function stubRenderCells(
  row: QueueRow
): Record<QueueColumnKey, ComponentChild> {
  return {
    type: `type:${row.type}`,
    due: `due:${row.id}`,
    scheduling: `scheduling:${row.id}`,
    reference: `reference:${row.reference}`,
    parent: `parent:${row.parent}`,
  };
}

/** Title stub, distinguishable from the cell content of the same column. */
function stubCellTitles(row: QueueRow): Record<QueueColumnKey, string> {
  return {
    type: `title-type:${row.type}`,
    due: `title-due:${row.id}`,
    scheduling: `title-scheduling:${row.id}`,
    reference: `title-reference:${row.reference}`,
    parent: `title-parent:${row.parent}`,
  };
}

const article = makeQueueRow({ id: 'a1', type: 'article' });
const snippet = makeQueueRow({ id: 's1', type: 'snippet' });
const card = makeQueueRow({ id: 'c1', type: 'card' });

const ALL_KEYS: QueueColumnKey[] = [
  'due',
  'type',
  'scheduling',
  'reference',
  'parent',
];

function renderedColumnKeys(container: HTMLElement): (string | null)[] {
  return Array.from(container.querySelectorAll('.ir-queue-cell')).map((el) =>
    el.getAttribute('data-column')
  );
}

// #endregion

describe('QueueTable', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders one row per queue item', () => {
    const container = mount(
      <QueueTable
        rows={[article, snippet, card]}
        columns={buildQueueColumns()}
        renderCells={stubRenderCells}
        isMobile={false}
        onRowClick={() => {}}
      />
    );
    expect(container.querySelectorAll('.ir-queue-row')).toHaveLength(3);
  });

  it('fills each cell with the renderCells output for its column', () => {
    const container = mount(
      <QueueTable
        rows={[article]}
        columns={buildQueueColumns()}
        renderCells={stubRenderCells}
        isMobile={false}
        onRowClick={() => {}}
      />
    );
    const expected = stubRenderCells(article);
    for (const key of ALL_KEYS) {
      const cell = container.querySelector(
        `.ir-queue-cell[data-column="${key}"]`
      );
      expect(cell?.textContent).toBe(expected[key]);
    }
  });

  it('invokes onRowClick with the row when a row is clicked', () => {
    const onRowClick = vi.fn();
    const container = mount(
      <QueueTable
        rows={[article]}
        columns={buildQueueColumns()}
        renderCells={stubRenderCells}
        isMobile={false}
        onRowClick={onRowClick}
      />
    );
    const row = container.querySelector('.ir-queue-row') as HTMLElement;
    row.click();
    expect(onRowClick).toHaveBeenCalledWith(article);
  });

  // Columns given here rather than taken from buildQueueColumns(), so the
  // filtering is checked against a known mix rather than against whichever
  // flags the shipped configuration happens to carry (which columns.test.tsx
  // covers on its own).
  it('on mobile renders only the columns marked mobileVisible', () => {
    const container = mount(
      <QueueTable
        rows={[article]}
        columns={[
          { key: 'type', mobileVisible: true },
          { key: 'parent', mobileVisible: false },
          { key: 'reference', mobileVisible: true },
        ]}
        renderCells={stubRenderCells}
        isMobile={true}
        onRowClick={() => {}}
      />
    );
    expect(renderedColumnKeys(container)).toEqual(['type', 'reference']);
  });

  it('on desktop renders all configured columns', () => {
    const columns = buildQueueColumns();
    const container = mount(
      <QueueTable
        rows={[article]}
        columns={columns}
        renderCells={stubRenderCells}
        isMobile={false}
        onRowClick={() => {}}
      />
    );
    expect(container.querySelectorAll('.ir-queue-cell')).toHaveLength(
      columns.length
    );
  });

  it('adds a column className to its cells and leaves other cells unclassed', () => {
    const container = mount(
      <QueueTable
        rows={[article]}
        columns={buildQueueColumns()}
        renderCells={stubRenderCells}
        isMobile={false}
        onRowClick={() => {}}
      />
    );
    const referenceCell = container.querySelector(
      '.ir-queue-cell[data-column="reference"]'
    );
    expect(referenceCell?.className).toBe('ir-queue-cell ir-queue-reference');
    const dueCell = container.querySelector(
      '.ir-queue-cell[data-column="due"]'
    );
    expect(dueCell?.className).toBe('ir-queue-cell');
  });

  it('renders listed columns in columnOrder, then unlisted ones in their original order', () => {
    fc.assert(
      fc.property(fc.shuffledSubarray(ALL_KEYS), (columnOrder) => {
        document.body.innerHTML = '';
        const columns = buildQueueColumns();
        const container = mount(
          <QueueTable
            rows={[article]}
            columns={columns}
            columnOrder={columnOrder}
            renderCells={stubRenderCells}
            isMobile={false}
            onRowClick={() => {}}
          />
        );
        const expected = [
          ...columnOrder,
          ...columns
            .map((column) => column.key)
            .filter((key) => !columnOrder.includes(key)),
        ];
        expect(renderedColumnKeys(container)).toEqual(expected);
      })
    );
  });

  it('applies columnOrder to the mobile-filtered columns', () => {
    const container = mount(
      <QueueTable
        rows={[article]}
        columns={[
          { key: 'type', mobileVisible: true },
          { key: 'due', mobileVisible: true },
          { key: 'parent', mobileVisible: false },
          { key: 'reference', mobileVisible: true },
        ]}
        columnOrder={['reference', 'parent', 'due', 'type']}
        renderCells={stubRenderCells}
        isMobile={true}
        onRowClick={() => {}}
      />
    );
    // `parent` is dropped as not mobileVisible; the rest keep the given order.
    expect(renderedColumnKeys(container)).toEqual(['reference', 'due', 'type']);
  });

  it('renders no header row when columnHeaders is omitted', () => {
    const container = mount(
      <QueueTable
        rows={[article]}
        columns={buildQueueColumns()}
        renderCells={stubRenderCells}
        isMobile={false}
        onRowClick={() => {}}
      />
    );
    expect(container.querySelector('.ir-queue-header')).toBeNull();
  });

  it('renders header labels aligned with the ordered columns', () => {
    const columnOrder: QueueColumnKey[] = [
      'type',
      'due',
      'reference',
      'parent',
      'scheduling',
    ];
    const container = mount(
      <QueueTable
        rows={[article]}
        columns={buildQueueColumns()}
        columnOrder={columnOrder}
        columnHeaders={{
          type: 'Type',
          due: 'Due',
          reference: 'File',
          parent: 'Source',
          scheduling: 'Priority / Interval',
        }}
        renderCells={stubRenderCells}
        isMobile={false}
        onRowClick={() => {}}
      />
    );
    const headerCells = Array.from(
      container.querySelectorAll('.ir-queue-header-cell')
    );
    expect(headerCells.map((el) => el.getAttribute('data-column'))).toEqual(
      columnOrder
    );
    expect(headerCells.map((el) => el.textContent)).toEqual([
      'Type',
      'Due',
      'File',
      'Source',
      'Priority / Interval',
    ]);
  });

  it('renders an empty header cell for columns without a header entry', () => {
    const container = mount(
      <QueueTable
        rows={[article]}
        columns={buildQueueColumns()}
        columnHeaders={{ reference: 'File' }}
        renderCells={stubRenderCells}
        isMobile={false}
        onRowClick={() => {}}
      />
    );
    const headerCells = Array.from(
      container.querySelectorAll('.ir-queue-header-cell')
    );
    expect(headerCells).toHaveLength(buildQueueColumns().length);
    const byKey = new Map(
      headerCells.map((el) => [el.getAttribute('data-column'), el.textContent])
    );
    expect(byKey.get('reference')).toBe('File');
    expect(byKey.get('due')).toBe('');
    expect(byKey.get('type')).toBe('');
    expect(byKey.get('parent')).toBe('');
    expect(byKey.get('scheduling')).toBe('');
  });

  // The per-type row tint is applied in CSS off this attribute.
  it('tags each row with its item type', () => {
    const container = mount(
      <QueueTable
        rows={[article, snippet, card]}
        columns={buildQueueColumns()}
        renderCells={stubRenderCells}
        isMobile={false}
        onRowClick={() => {}}
      />
    );
    expect(
      Array.from(container.querySelectorAll('.ir-queue-row')).map((el) =>
        el.getAttribute('data-type')
      )
    ).toEqual(['article', 'snippet', 'card']);
  });

  it('renders no heading of its own', () => {
    // The heading belongs to the container, which places it outside the panel
    // holding the controls and this table. A heading rendered here as well
    // would sit inside the scroll region and scroll away with the rows.
    const container = mount(
      <QueueTable
        rows={[article]}
        columns={buildQueueColumns()}
        renderCells={stubRenderCells}
        isMobile={false}
        onRowClick={() => {}}
      />
    );
    expect(container.querySelector('.ir-queue-title')).toBeNull();
  });

  // aria-label, not title: Obsidian renders its own themed tooltip for
  // labelled elements, and a title would stack a second browser tooltip on it.
  it('applies the cellTitles text as each cell aria-label so cut-off text shows on hover', () => {
    const container = mount(
      <QueueTable
        rows={[article]}
        columns={buildQueueColumns()}
        renderCells={stubRenderCells}
        cellTitles={stubCellTitles}
        isMobile={false}
        onRowClick={() => {}}
      />
    );
    const expected = stubCellTitles(article);
    for (const key of ALL_KEYS) {
      const cell = container.querySelector(
        `.ir-queue-cell[data-column="${key}"]`
      );
      expect(cell?.getAttribute('aria-label')).toBe(expected[key]);
      // A title would render the plain browser tooltip alongside Obsidian's.
      expect(cell?.hasAttribute('title')).toBe(false);
    }
  });

  it('sets no cell label when cellTitles is omitted', () => {
    const container = mount(
      <QueueTable
        rows={[article]}
        columns={buildQueueColumns()}
        renderCells={stubRenderCells}
        isMobile={false}
        onRowClick={() => {}}
      />
    );
    for (const cell of container.querySelectorAll('.ir-queue-cell')) {
      expect(cell.hasAttribute('aria-label')).toBe(false);
      expect(cell.hasAttribute('title')).toBe(false);
    }
  });

  it('tags each cell and its header with the column width so both size alike', () => {
    const columns = buildQueueColumns();
    const container = mount(
      <QueueTable
        rows={[article]}
        columns={columns}
        columnHeaders={{ reference: 'File' }}
        renderCells={stubRenderCells}
        isMobile={false}
        onRowClick={() => {}}
      />
    );
    for (const column of columns) {
      const expected = column.width ?? 'flexible';
      expect(
        container
          .querySelector(`.ir-queue-cell[data-column="${column.key}"]`)
          ?.getAttribute('data-width'),
        `cell width for ${column.key}`
      ).toBe(expected);
      expect(
        container
          .querySelector(`.ir-queue-header-cell[data-column="${column.key}"]`)
          ?.getAttribute('data-width'),
        `header width for ${column.key}`
      ).toBe(expected);
    }
  });

  it('defaults a column with no width to flexible', () => {
    const container = mount(
      <QueueTable
        rows={[article]}
        columns={[{ key: 'due', mobileVisible: true }]}
        renderCells={stubRenderCells}
        isMobile={false}
        onRowClick={() => {}}
      />
    );
    expect(
      container.querySelector('.ir-queue-cell')?.getAttribute('data-width')
    ).toBe('flexible');
  });

  describe('changed', () => {
    function mountTable(changed?: boolean) {
      return mount(
        <QueueTable
          rows={[article]}
          columns={buildQueueColumns()}
          renderCells={stubRenderCells}
          isMobile={false}
          changed={changed}
          onRowClick={() => {}}
        />
      );
    }

    it('marks the table when its rows are flagged as changed', () => {
      const container = mountTable(true);

      expect(
        container
          .querySelector('.ir-queue-table')
          ?.classList.contains('ir-queue-table-changed')
      ).toBe(true);
    });

    it('leaves the table unmarked when the rows did not change', () => {
      const container = mountTable(false);

      expect(
        container
          .querySelector('.ir-queue-table')
          ?.classList.contains('ir-queue-table-changed')
      ).toBe(false);
    });

    it('leaves the table unmarked by default', () => {
      // The animation is opt-in: a caller that says nothing gets a still table.
      const container = mountTable();

      expect(
        container
          .querySelector('.ir-queue-table')
          ?.classList.contains('ir-queue-table-changed')
      ).toBe(false);
    });

    it('keeps the base table class when marked', () => {
      // The marker is additive — the base class carries the scroll region and
      // layout, so replacing it rather than adding to it would break the table.
      const container = mountTable(true);

      const table = container.querySelector('.ir-queue-table');
      expect(table?.classList.contains('ir-queue-table')).toBe(true);
      expect(table?.getAttribute('role')).toBe('table');
    });

    it('renders the same rows whether or not it is marked', () => {
      // The flag is presentational: it must not touch what the table shows.
      const marked = mountTable(true);
      const unmarked = mountTable(false);

      expect(marked.querySelectorAll('.ir-queue-row')).toHaveLength(1);
      expect(unmarked.querySelectorAll('.ir-queue-row')).toHaveLength(1);
      expect(marked.querySelector('.ir-queue-row')?.textContent).toBe(
        unmarked.querySelector('.ir-queue-row')?.textContent
      );
    });
  });
});
