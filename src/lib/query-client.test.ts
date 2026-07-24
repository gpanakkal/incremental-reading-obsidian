import type { QueuePage, QueueRow } from '#/components/types';
import type { TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type ReviewManager from './items/ReviewManager';
import { applyQueueChange, queryClient } from './query-client';

// #region HELPERS

function makeQueueRow(overrides: Partial<QueueRow> = {}): QueueRow {
  return {
    id: 'a1',
    type: 'article',
    file: { path: 'articles/a1.md' } as TFile,
    due: new Date('2000-01-01T00:00:00Z'),
    reference: 'articles/a1.md',
    scheduling: { kind: 'priority', value: '3' },
    ...overrides,
  };
}

/** A ReviewManager stub whose getQueueRow returns the queued map. */
function makeManager(
  resolved: Record<string, QueueRow | null>
): ReviewManager {
  return {
    getQueueRow: vi.fn((id: string) =>
      Promise.resolve(id in resolved ? resolved[id] : null)
    ),
  } as unknown as ReviewManager;
}

function seedQueue(key: unknown[], page: QueuePage) {
  queryClient.setQueryData<QueuePage>(key, page);
}

const QUEUE_KEY = ['queue', { slice: { pageNumber: 0, entriesPerPage: 10 } }];
// #endregion

describe('applyQueueChange', () => {
  afterEach(() => {
    queryClient.clear();
    vi.restoreAllMocks();
  });

  it('replaces an updated row in place and keeps totalRows', async () => {
    seedQueue(QUEUE_KEY, {
      rows: [makeQueueRow({ id: 'a1', scheduling: { kind: 'priority', value: '3' } })],
      totalRows: 1,
    });
    const updated = makeQueueRow({
      id: 'a1',
      scheduling: { kind: 'priority', value: '5' },
    });
    const manager = makeManager({ a1: updated });

    await applyQueueChange(
      { table: 'article', op: 'update', ids: ['a1'] },
      manager
    );

    const page = queryClient.getQueryData<QueuePage>(QUEUE_KEY);
    expect(page?.rows).toHaveLength(1);
    expect(page?.rows[0].scheduling.value).toBe('5');
    expect(page?.totalRows).toBe(1);
  });

  it('removes a row that has left the queue and decrements totalRows', async () => {
    seedQueue(QUEUE_KEY, {
      rows: [
        makeQueueRow({ id: 'a1' }),
        makeQueueRow({ id: 'a2', reference: 'articles/a2.md' }),
      ],
      totalRows: 2,
    });
    const manager = makeManager({ a1: null }); // a1 dismissed/deleted

    await applyQueueChange(
      { table: 'article', op: 'update', ids: ['a1'] },
      manager
    );

    const page = queryClient.getQueryData<QueuePage>(QUEUE_KEY);
    expect(page?.rows.map((r) => r.id)).toEqual(['a2']);
    expect(page?.totalRows).toBe(1);
  });

  it('leaves pages untouched when no displayed row matches the change', async () => {
    seedQueue(QUEUE_KEY, {
      rows: [makeQueueRow({ id: 'a1' })],
      totalRows: 1,
    });
    const getQueueRow = vi.fn();
    const manager = { getQueueRow } as unknown as ReviewManager;

    await applyQueueChange(
      { table: 'article', op: 'update', ids: ['a99'] },
      manager
    );

    const page = queryClient.getQueryData<QueuePage>(QUEUE_KEY);
    expect(page?.rows.map((r) => r.id)).toEqual(['a1']);
    expect(page?.totalRows).toBe(1);
    // a99 is resolved (to reconcile) but no page is rewritten.
    expect(getQueueRow).toHaveBeenCalledWith('a99');
  });

  it('patches every cached page, not just the active one', async () => {
    const KEY_A = ['queue', { slice: { pageNumber: 0, entriesPerPage: 10 } }];
    const KEY_B = ['queue', { slice: { pageNumber: 1, entriesPerPage: 10 } }];
    seedQueue(KEY_A, { rows: [makeQueueRow({ id: 'a1' })], totalRows: 20 });
    seedQueue(KEY_B, { rows: [makeQueueRow({ id: 'a1' })], totalRows: 20 });
    const manager = makeManager({ a1: null });

    await applyQueueChange(
      { table: 'article', op: 'update', ids: ['a1'] },
      manager
    );

    expect(queryClient.getQueryData<QueuePage>(KEY_A)?.rows).toEqual([]);
    expect(queryClient.getQueryData<QueuePage>(KEY_B)?.rows).toEqual([]);
  });

  it('invalidates the queue so order and totals reconcile', async () => {
    seedQueue(QUEUE_KEY, { rows: [makeQueueRow({ id: 'a1' })], totalRows: 1 });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const manager = makeManager({ a1: makeQueueRow({ id: 'a1' }) });

    await applyQueueChange(
      { table: 'article', op: 'update', ids: ['a1'] },
      manager
    );

    expect(spy).toHaveBeenCalledWith({ queryKey: ['queue'], refetchType: 'all' });
  });

  it('invalidates without patching on insert (position unknown)', async () => {
    seedQueue(QUEUE_KEY, { rows: [makeQueueRow({ id: 'a1' })], totalRows: 1 });
    const getQueueRow = vi.fn();
    const manager = { getQueueRow } as unknown as ReviewManager;
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    await applyQueueChange(
      { table: 'article', op: 'insert', ids: ['a2'] },
      manager
    );

    expect(getQueueRow).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith({ queryKey: ['queue'], refetchType: 'all' });
  });
});
