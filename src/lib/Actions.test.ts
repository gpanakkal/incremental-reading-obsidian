import { Actions } from '#/lib/Actions';
import { CONTENT_TITLE_SLICE_LENGTH } from '#/lib/constants';
import { store } from '#/lib/store';
import type { ReviewItem } from '#/lib/types';
import IncrementalReadingPlugin from '#/main';
import type { TFile } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#/lib/query-client', () => ({
  invalidateItemQuery: vi.fn().mockResolvedValue(undefined),
  invalidateCurrentItemQuery: vi.fn().mockResolvedValue(undefined),
  fetchCurrentItem: vi.fn().mockResolvedValue(null),
}));

// #region HELPERS

function makeTFile(basename: string, path?: string): TFile {
  return {
    path: path ?? `incremental-reading/articles/${basename}.md`,
    basename,
    name: `${basename}.md`,
    extension: 'md',
  } as unknown as TFile;
}

function makePlugin() {
  return {
    store: { dispatch: vi.fn() },
    settings: { dayRolloverOffset: 4 },
    reviewManager: {
      dismissItem: vi.fn().mockResolvedValue(undefined),
      unDismissItem: vi.fn().mockResolvedValue(undefined),
    },
    app: {
      workspace: {
        activeEditor: null,
        getActiveViewOfType: vi.fn().mockReturnValue(null),
      },
    },
  } as unknown as IncrementalReadingPlugin;
}

function makeReviewItem(basename: string, pathOverride?: string): ReviewItem {
  return {
    data: {
      id: 'item-1',
      type: 'article',
      reference: pathOverride ?? `incremental-reading/articles/${basename}.md`,
      due: Date.now(),
      dismissed: false,
      deleted: false,
    },
    file: makeTFile(basename, pathOverride),
  } as unknown as ReviewItem;
}

// #endregion

// ---------------------------------------------------------------------------
// skipItem — Notice message
// ---------------------------------------------------------------------------

describe('Actions.skipItem — Notice message', () => {
  let NoticeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    NoticeMock = vi.fn();
    vi.stubGlobal('Notice', NoticeMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('Notice contains the file basename', () => {
    const actions = new Actions(makePlugin());
    actions.skipItem(makeReviewItem('my-article'));
    expect(NoticeMock).toHaveBeenCalledTimes(1);
    const [message] = NoticeMock.mock.calls[0] as [string];
    expect(message).toContain('my-article');
  });

  it('Notice contains "until next session"', () => {
    const actions = new Actions(makePlugin());
    actions.skipItem(makeReviewItem('my-article'));
    expect(NoticeMock).toHaveBeenCalledTimes(1);
    const [message] = NoticeMock.mock.calls[0] as [string];
    expect(message).toContain('until next session');
  });

  it('does not leak folder name from multi-segment path into Notice', () => {
    // Regression: reference.split('/')[1] → folder name ('articles'), not file
    const item = makeReviewItem('note', 'folder-a/subfolder/note.md');
    const actions = new Actions(makePlugin());
    actions.skipItem(item);
    expect(NoticeMock).toHaveBeenCalledTimes(1);
    const [message] = NoticeMock.mock.calls[0] as [string];
    expect(message).toContain('note');
    expect(message).not.toContain('folder-a');
    expect(message).not.toContain('subfolder');
  });

  it('truncates long basename with ellipsis', () => {
    const longName = 'a'.repeat(CONTENT_TITLE_SLICE_LENGTH + 20);
    const actions = new Actions(makePlugin());
    actions.skipItem(makeReviewItem(longName));
    expect(NoticeMock).toHaveBeenCalledTimes(1);
    const [message] = NoticeMock.mock.calls[0] as [string];
    expect(message).toContain('...');
  });

  it('does not truncate a name at exactly CONTENT_TITLE_SLICE_LENGTH + 5 characters', () => {
    // Kills ArithmeticOperator mutant: +5 → -5 (a 55-char name is truncated at 45 but not at 55)
    const name = 'a'.repeat(CONTENT_TITLE_SLICE_LENGTH + 5);
    const actions = new Actions(makePlugin());
    actions.skipItem(makeReviewItem(name));
    expect(NoticeMock).toHaveBeenCalledTimes(1);
    const [message] = NoticeMock.mock.calls[0] as [string];
    expect(message).not.toContain('...');
  });
});

// ---------------------------------------------------------------------------
// dismissItem — Notice message
// ---------------------------------------------------------------------------

describe('Actions.dismissItem — Notice message', () => {
  let NoticeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    NoticeMock = vi.fn();
    vi.stubGlobal('Notice', NoticeMock);
    vi.spyOn(store, 'getState').mockReturnValue({
      currentItemId: null,
    } as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('Notice contains the file basename', async () => {
    const actions = new Actions(makePlugin());
    await actions.dismissItem(makeReviewItem('my-article'));
    expect(NoticeMock).toHaveBeenCalledTimes(1);
    const [message] = NoticeMock.mock.calls[0] as [string];
    expect(message).toContain('my-article');
  });

  it('Notice matches Dismissed "..." format', async () => {
    const actions = new Actions(makePlugin());
    await actions.dismissItem(makeReviewItem('my-article'));
    expect(NoticeMock).toHaveBeenCalledTimes(1);
    const [message] = NoticeMock.mock.calls[0] as [string];
    expect(message).toMatch(/^Dismissed ".*"$/);
  });

  it('does not leak folder name from multi-segment path into Notice', async () => {
    const item = makeReviewItem('note', 'folder-a/subfolder/note.md');
    const actions = new Actions(makePlugin());
    await actions.dismissItem(item);
    expect(NoticeMock).toHaveBeenCalledTimes(1);
    const [message] = NoticeMock.mock.calls[0] as [string];
    expect(message).toContain('note');
    expect(message).not.toContain('folder-a');
  });

  it('truncates long basename with ellipsis', async () => {
    const longName = 'a'.repeat(CONTENT_TITLE_SLICE_LENGTH + 20);
    const actions = new Actions(makePlugin());
    await actions.dismissItem(makeReviewItem(longName));
    expect(NoticeMock).toHaveBeenCalledTimes(1);
    const [message] = NoticeMock.mock.calls[0] as [string];
    expect(message).toContain('...');
  });
});

// ---------------------------------------------------------------------------
// unDismissItem — Notice message
// ---------------------------------------------------------------------------

describe('Actions.unDismissItem — Notice message', () => {
  let NoticeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    NoticeMock = vi.fn();
    vi.stubGlobal('Notice', NoticeMock);
    vi.spyOn(store, 'getState').mockReturnValue({
      currentItemId: null,
    } as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('Notice contains the file basename', async () => {
    const actions = new Actions(makePlugin());
    await actions.unDismissItem(makeReviewItem('my-article'));
    expect(NoticeMock).toHaveBeenCalledTimes(1);
    const [message] = NoticeMock.mock.calls[0] as [string];
    expect(message).toContain('my-article');
  });

  it('Notice contains "to queue"', async () => {
    const actions = new Actions(makePlugin());
    await actions.unDismissItem(makeReviewItem('my-article'));
    expect(NoticeMock).toHaveBeenCalledTimes(1);
    const [message] = NoticeMock.mock.calls[0] as [string];
    expect(message).toContain('to queue');
  });

  it('Notice matches Restored "..." to queue format', async () => {
    const actions = new Actions(makePlugin());
    await actions.unDismissItem(makeReviewItem('my-article'));
    expect(NoticeMock).toHaveBeenCalledTimes(1);
    const [message] = NoticeMock.mock.calls[0] as [string];
    expect(message).toMatch(/^Restored ".*" to queue$/);
  });

  it('does not leak folder name from multi-segment path into Notice', async () => {
    const item = makeReviewItem('note', 'folder-a/subfolder/note.md');
    const actions = new Actions(makePlugin());
    await actions.unDismissItem(item);
    expect(NoticeMock).toHaveBeenCalledTimes(1);
    const [message] = NoticeMock.mock.calls[0] as [string];
    expect(message).toContain('note');
    expect(message).not.toContain('folder-a');
  });

  it('truncates long basename with ellipsis', async () => {
    const longName = 'a'.repeat(CONTENT_TITLE_SLICE_LENGTH + 20);
    const actions = new Actions(makePlugin());
    await actions.unDismissItem(makeReviewItem(longName));
    expect(NoticeMock).toHaveBeenCalledTimes(1);
    const [message] = NoticeMock.mock.calls[0] as [string];
    expect(message).toContain('...');
  });
});

// ---------------------------------------------------------------------------
// skipItem — dispatch
// ---------------------------------------------------------------------------

describe('Actions.skipItem — dispatch', () => {
  let NoticeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    NoticeMock = vi.fn();
    vi.stubGlobal('Notice', NoticeMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('dispatches addSeenId and resets current item (store.dispatch called twice)', () => {
    const plugin = makePlugin();
    const actions = new Actions(plugin);
    actions.skipItem(makeReviewItem('my-article'));
    // skipItem calls dispatch(addSeenId) directly, then getNext() calls dispatch(resetCurrentItem)
    expect(plugin.store.dispatch).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// dismissItem — dispatch
// ---------------------------------------------------------------------------

describe('Actions.dismissItem — dispatch', () => {
  let NoticeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    NoticeMock = vi.fn();
    vi.stubGlobal('Notice', NoticeMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('calls store.dispatch (getNext) when the dismissed item is the current item', async () => {
    vi.spyOn(store, 'getState').mockReturnValue({
      currentItemId: 'item-1',
    } as never);
    const plugin = makePlugin();
    const actions = new Actions(plugin);
    await actions.dismissItem(makeReviewItem('my-article')); // item id is 'item-1'
    expect(plugin.store.dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not call store.dispatch when the dismissed item is not the current item', async () => {
    vi.spyOn(store, 'getState').mockReturnValue({
      currentItemId: 'other-item',
    } as never);
    const plugin = makePlugin();
    const actions = new Actions(plugin);
    await actions.dismissItem(makeReviewItem('my-article')); // item id 'item-1' !== 'other-item'
    expect(plugin.store.dispatch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// unDismissItem — dispatch
// ---------------------------------------------------------------------------

describe('Actions.unDismissItem — dispatch', () => {
  let NoticeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    NoticeMock = vi.fn();
    vi.stubGlobal('Notice', NoticeMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('calls store.dispatch (getNext) when currentItemId is null', async () => {
    vi.spyOn(store, 'getState').mockReturnValue({
      currentItemId: null,
    } as never);
    const plugin = makePlugin();
    const actions = new Actions(plugin);
    await actions.unDismissItem(makeReviewItem('my-article'));
    expect(plugin.store.dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not call store.dispatch when currentItemId is not null', async () => {
    vi.spyOn(store, 'getState').mockReturnValue({
      currentItemId: 'some-item',
    } as never);
    const plugin = makePlugin();
    const actions = new Actions(plugin);
    await actions.unDismissItem(makeReviewItem('my-article'));
    expect(plugin.store.dispatch).not.toHaveBeenCalled();
  });
});
