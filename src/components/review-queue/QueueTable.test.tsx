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
  };
}

const article = makeQueueRow({ id: 'a1', type: 'article' });
const snippet = makeQueueRow({ id: 's1', type: 'snippet' });
const card = makeQueueRow({ id: 'c1', type: 'card' });

const ALL_KEYS: QueueColumnKey[] = ['due', 'type', 'scheduling', 'reference'];

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

  it('on mobile renders only the due and reference columns', () => {
    const container = mount(
      <QueueTable
        rows={[article]}
        columns={buildQueueColumns()}
        renderCells={stubRenderCells}
        isMobile={true}
        onRowClick={() => {}}
      />
    );
    expect(renderedColumnKeys(container)).toEqual(['due', 'reference']);
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
        columns={buildQueueColumns()}
        columnOrder={['type', 'reference', 'due', 'scheduling']}
        renderCells={stubRenderCells}
        isMobile={true}
        onRowClick={() => {}}
      />
    );
    expect(renderedColumnKeys(container)).toEqual(['reference', 'due']);
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
    expect(byKey.get('scheduling')).toBe('');
  });
});
