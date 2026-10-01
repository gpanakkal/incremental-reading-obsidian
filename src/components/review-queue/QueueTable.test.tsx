// @vitest-environment jsdom
import type { QueueRow } from '#/components/types';
import fc from 'fast-check';
import type { TFile } from 'obsidian';
import type { ComponentChild } from 'preact';
import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueColumnKey } from './columns';
import { buildQueueColumns } from './columns';
import { LONG_PRESS_MS, LONG_PRESS_SLOP_PX, QueueTable } from './QueueTable';

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

/** A table whose rows have a menu, and the spies its callbacks report to. */
function mountMenuTable(rows: QueueRow[], isMobile = false) {
  const onRowMenu = vi.fn();
  const onRowClick = vi.fn();
  const container = mount(
    <QueueTable
      rows={rows}
      columns={buildQueueColumns()}
      columnOrder={['type', 'due', 'reference', 'parent', 'scheduling']}
      renderCells={stubRenderCells}
      isMobile={isMobile}
      onRowClick={onRowClick}
      onRowMenu={onRowMenu}
    />
  );
  const rowEls = Array.from(
    container.querySelectorAll<HTMLElement>('.ir-queue-row')
  );
  return { container, rowEls, onRowMenu, onRowClick };
}

function pointer(
  target: Element,
  type: string,
  init: { x?: number; y?: number; pointerType?: string } = {}
) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: init.x ?? 0,
      clientY: init.y ?? 0,
      pointerType: init.pointerType ?? 'touch',
    })
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

describe('QueueTable row menu', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('opens the menu for the row right-clicked, where it was clicked, in place of the browser’s', () => {
    fc.assert(
      fc.property(fc.nat(), fc.integer(), fc.integer(), (pick, x, y) => {
        document.body.innerHTML = '';
        const rows = [article, snippet, card];
        const { rowEls, onRowMenu, onRowClick } = mountMenuTable(rows);
        const index = pick % rows.length;
        const event = new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
        });

        rowEls[index].querySelector('.ir-queue-cell')?.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
        expect(onRowMenu).toHaveBeenCalledExactlyOnceWith(rows[index], {
          x,
          y,
        });
        expect(onRowClick).not.toHaveBeenCalled();
      })
    );
  });

  it.each([false, true])(
    'gives each row one labelled ⋯ button, in its last visible cell (mobile: %s)',
    (isMobile) => {
      const { rowEls } = mountMenuTable([article, snippet], isMobile);
      for (const row of rowEls) {
        const buttons = row.querySelectorAll('button');
        expect(buttons).toHaveLength(1);
        expect(buttons[0].getAttribute('aria-label')).toBe('Item actions');
        expect(buttons[0].closest('.ir-queue-cell-actions')).not.toBeNull();
        const cells = row.querySelectorAll('.ir-queue-cell');
        expect(buttons[0].closest('.ir-queue-cell')).toBe(
          cells[cells.length - 1]
        );
        // The label is on the button; nothing inside it is an SVG to label
        expect(buttons[0].querySelector('svg')).toBeNull();
      }
    }
  );

  it('opens the menu under the ⋯ button, without opening the row', () => {
    const { rowEls, onRowMenu, onRowClick } = mountMenuTable([
      article,
      snippet,
    ]);
    const button = rowEls[1].querySelector('button')!;
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      left: 12,
      bottom: 34,
    } as DOMRect);

    button.click();

    expect(onRowMenu).toHaveBeenCalledExactlyOnceWith(snippet, {
      x: 12,
      y: 34,
    });
    expect(onRowClick).not.toHaveBeenCalled();
  });

  describe('long press', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('opens the menu on a touch held still for half a second, and not the row', () => {
      const { rowEls, onRowMenu, onRowClick } = mountMenuTable([article]);
      const cell = rowEls[0].querySelector('.ir-queue-cell')!;

      pointer(cell, 'pointerdown', { x: 5, y: 6 });
      vi.advanceTimersByTime(499);
      expect(onRowMenu).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onRowMenu).toHaveBeenCalledExactlyOnceWith(article, {
        x: 5,
        y: 6,
      });

      // What the release and the platform send after a long press
      pointer(cell, 'pointerup', { x: 5, y: 6 });
      const nativeMenu = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
      });
      cell.dispatchEvent(nativeMenu);
      (cell as HTMLElement).click();

      expect(nativeMenu.defaultPrevented).toBe(true);
      expect(onRowMenu).toHaveBeenCalledTimes(1);
      expect(onRowClick).not.toHaveBeenCalled();

      // The next tap is an ordinary one
      (cell as HTMLElement).click();
      expect(onRowClick).toHaveBeenCalledExactlyOnceWith(article);
    });

    it.each([
      ['released early', (cell: Element) => pointer(cell, 'pointerup')],
      ['cancelled', (cell: Element) => pointer(cell, 'pointercancel')],
      [
        'dragged past the slop',
        (cell: Element) => pointer(cell, 'pointermove', { x: 11, y: 0 }),
      ],
    ])('opens no menu on a touch %s', (_case, interrupt) => {
      const { rowEls, onRowMenu } = mountMenuTable([article]);
      const cell = rowEls[0].querySelector('.ir-queue-cell')!;

      pointer(cell, 'pointerdown', { x: 0, y: 0 });
      vi.advanceTimersByTime(200);
      interrupt(cell);
      vi.advanceTimersByTime(1000);

      expect(onRowMenu).not.toHaveBeenCalled();
    });

    it('opens the menu on a held touch exactly when it stays within the slop on both axes', () => {
      const coordinate = fc.integer({ min: -2000, max: 2000 });
      const drift = fc.integer({ min: -30, max: 30 });
      fc.assert(
        fc.property(coordinate, coordinate, drift, drift, (x, y, dx, dy) => {
          document.body.innerHTML = '';
          const { rowEls, onRowMenu } = mountMenuTable([article]);
          const cell = rowEls[0].querySelector('.ir-queue-cell')!;

          pointer(cell, 'pointerdown', { x, y });
          pointer(cell, 'pointermove', { x: x + dx, y: y + dy });
          vi.advanceTimersByTime(LONG_PRESS_MS);

          const within =
            Math.abs(dx) <= LONG_PRESS_SLOP_PX &&
            Math.abs(dy) <= LONG_PRESS_SLOP_PX;
          expect(onRowMenu.mock.calls).toEqual(
            within ? [[article, { x, y }]] : []
          );
        })
      );
    });

    it.each([
      [10, 10, true],
      [-10, -10, true],
      [11, 0, false],
      [-11, 0, false],
      [0, 11, false],
      [0, -11, false],
    ])(
      'treats a drift of (%i, %i) at the slop’s edge as a long press: %s',
      (dx, dy, opens) => {
        const { rowEls, onRowMenu } = mountMenuTable([article]);
        const cell = rowEls[0].querySelector('.ir-queue-cell')!;

        pointer(cell, 'pointerdown', { x: 100, y: 100 });
        pointer(cell, 'pointermove', { x: 100 + dx, y: 100 + dy });
        vi.advanceTimersByTime(LONG_PRESS_MS);

        expect(onRowMenu).toHaveBeenCalledTimes(opens ? 1 : 0);
      }
    );

    it('leaves a held mouse button to the right-click it already has', () => {
      const { rowEls, onRowMenu } = mountMenuTable([article]);
      const cell = rowEls[0].querySelector('.ir-queue-cell')!;

      pointer(cell, 'pointerdown', { pointerType: 'mouse' });
      vi.advanceTimersByTime(1000);

      expect(onRowMenu).not.toHaveBeenCalled();
    });
  });

  it('opens the menu on the row as the queue has it when the press completes, or not once it is gone', async () => {
    // Real timers throughout: preact runs effects after a frame
    const wait = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));
    const renamed = { ...snippet, reference: 'renamed.md', file: null };
    const { container, rowEls, onRowMenu } = mountMenuTable([article, snippet]);
    const rerender = (rows: QueueRow[]) =>
      render(
        <QueueTable
          rows={rows}
          columns={buildQueueColumns()}
          renderCells={stubRenderCells}
          isMobile={false}
          onRowClick={() => {}}
          onRowMenu={onRowMenu}
        />,
        container
      );
    await wait(150);

    pointer(rowEls[1].querySelector('.ir-queue-cell')!, 'pointerdown');
    rerender([article, renamed]);
    await wait(LONG_PRESS_MS + 150);
    expect(onRowMenu.mock.calls).toEqual([[renamed, { x: 0, y: 0 }]]);

    const [, renamedEl] = Array.from(
      container.querySelectorAll<HTMLElement>('.ir-queue-row')
    );
    pointer(renamedEl.querySelector('.ir-queue-cell')!, 'pointerdown');
    rerender([article]);
    await wait(LONG_PRESS_MS + 150);
    expect(onRowMenu).toHaveBeenCalledTimes(1);
  });

  it('opens one menu for a held ⋯ button, from the button alone', () => {
    vi.useFakeTimers();
    const { rowEls, onRowMenu } = mountMenuTable([article]);
    const button = rowEls[0].querySelector('button')!;

    pointer(button, 'pointerdown');
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onRowMenu).not.toHaveBeenCalled();
    button.click();

    expect(onRowMenu).toHaveBeenCalledTimes(1);
  });

  it('opens no menu for a touch still held when the table goes away', async () => {
    const { container, rowEls, onRowMenu } = mountMenuTable([article]);
    // Past preact's deferred effects (a frame, or 100ms without one), on real
    // timers, so the table's cleanup is registered
    await new Promise((resolve) => setTimeout(resolve, 150));
    vi.useFakeTimers();
    pointer(rowEls[0].querySelector('.ir-queue-cell')!, 'pointerdown');

    render(null, container);
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);

    expect(onRowMenu).not.toHaveBeenCalled();
  });

  it('has no menu, button or right-click handling without onRowMenu', () => {
    const container = mount(
      <QueueTable
        rows={[article]}
        columns={buildQueueColumns()}
        renderCells={stubRenderCells}
        isMobile={false}
        onRowClick={() => {}}
      />
    );
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    container.querySelector('.ir-queue-cell')?.dispatchEvent(event);

    expect(container.querySelector('button')).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });

  it('marks a missing row, and only a missing row', () => {
    const missing = makeQueueRow({ id: 'gone', file: null });
    const { rowEls } = mountMenuTable([article, missing]);

    expect(rowEls.map((row) => row.getAttribute('data-missing'))).toEqual([
      null,
      '',
    ]);
  });
});
