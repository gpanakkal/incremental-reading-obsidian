// @vitest-environment jsdom
import { ReviewContextProvider, useReviewContext } from '#/components/ReviewContext';
import { ObsidianHelpers } from '#/lib/ObsidianHelpers';
import { queryClient } from '#/lib/query-client';
import type { ReviewItem } from '#/lib/types';
import fc from 'fast-check';
import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #region HELPERS

type SaveNote = (item: ReviewItem, newContent: string) => Promise<void>;

interface Highlight {
  id: string;
  start_offset: number;
  end_offset: number;
}

/** The key `useCurrentItemFileText` reads the review editor's `value` from. */
function fileTextKey(itemId: string) {
  return ['item', itemId, 'file-text'];
}

function makeItem(id: string, path = 'IR/Articles/source.md'): ReviewItem {
  return { data: { id }, file: { path } } as unknown as ReviewItem;
}

/**
 * Stand-in for `ReviewManager` covering what `saveNote` touches: the highlight
 * offsets it reads before writing, and the persistence call it makes after.
 */
function makeReviewManager(highlights: Highlight[] = []) {
  return {
    snippets: {
      offsetTracker: { getHighlights: vi.fn(() => highlights) },
    },
    updateSnippetOffsets: vi.fn(async () => undefined),
  };
}

/**
 * Render the provider and hand back the `saveNote` it publishes. Preact's
 * initial render is synchronous, so the ref is populated by the time this
 * returns.
 */
function captureSaveNote(reviewManager: ReturnType<typeof makeReviewManager>) {
  const ref: { current: SaveNote | null } = { current: null };

  function Capture() {
    ref.current = useReviewContext().saveNote;
    return null;
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  render(
    (
      <ReviewContextProvider
        plugin={{} as never}
        reviewView={{ app: {} } as never}
        reviewManager={reviewManager as never}
      >
        <Capture />
      </ReviewContextProvider>
    ) as never,
    container
  );

  if (!ref.current) throw new Error('saveNote was not provided by the context');
  return ref.current;
}

// #endregion

// react-redux is mocked rather than spied on because its exports are
// non-configurable: `vi.spyOn(ReactRedux, 'useDispatch')` throws
// "Cannot redefine property". This is the documented cannot-be-spied case.
const dispatch = vi.fn();
vi.mock('react-redux', () => ({
  useDispatch: () => dispatch,
}));

describe('saveNote publishes its write to the file-text cache', () => {
  beforeEach(() => {
    queryClient.clear();
    vi.spyOn(ObsidianHelpers, 'editNote').mockResolvedValue('');
  });

  afterEach(() => {
    document.body.innerHTML = '';
    dispatch.mockClear();
    queryClient.clear();
    vi.restoreAllMocks();
  });

  it('caches the text it just wrote, so restoring the file to the pre-save text is still seen as a change', async () => {
    // The regression, in the shape it actually occurred: an article is open in
    // review, a card is extracted (replacing a line with a transclusion), then
    // the extraction is undone. The undo restores the file to `original` — the
    // exact text the cache held at mount. Unless the save published
    // `withEmbed`, the refetch after the undo returns a string identical to the
    // cached one, `value` never changes, and IREditor's `[value]` effect never
    // runs: the editor keeps showing the embed for a card that no longer exists.
    const original = '- a line of prose\n';
    const withEmbed = '- ![[Card abc123|ir-hide-title]]\n';
    queryClient.setQueryData(fileTextKey('article-1'), original);

    const saveNote = captureSaveNote(makeReviewManager());
    await saveNote(makeItem('article-1'), withEmbed);

    expect(queryClient.getQueryData(fileTextKey('article-1'))).toBe(withEmbed);
    // The property that makes the undo observable: a later read of `original`
    // is no longer equal to what the cache holds.
    expect(queryClient.getQueryData(fileTextKey('article-1'))).not.toBe(
      original
    );
  });

  it('caches whatever text was written, for any item id and any preceding cached text (property-based)', async () => {
    const saveNote = captureSaveNote(makeReviewManager());

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 60 }),
        fc.string({ maxLength: 400 }),
        fc.string({ maxLength: 400 }),
        async (itemId, cachedBefore, written) => {
          queryClient.clear();
          queryClient.setQueryData(fileTextKey(itemId), cachedBefore);

          await saveNote(makeItem(itemId), written);

          expect(queryClient.getQueryData(fileTextKey(itemId))).toBe(written);
        }
      )
    );
  });

  it('seeds the cache entry when the item has never been fetched', async () => {
    // A save can land before anything read the file — the write-through has to
    // create the entry rather than assume one exists.
    const saveNote = captureSaveNote(makeReviewManager());

    await saveNote(makeItem('never-fetched'), 'body text');

    expect(queryClient.getQueryData(fileTextKey('never-fetched'))).toBe(
      'body text'
    );
  });

  it('writes only the saved item entry, leaving other items untouched (property-based)', async () => {
    const saveNote = captureSaveNote(makeReviewManager());

    await fc.assert(
      fc.asyncProperty(
        fc
          .tuple(
            fc.string({ minLength: 1, maxLength: 40 }),
            fc.string({ minLength: 1, maxLength: 40 })
          )
          .filter(([saved, other]) => saved !== other),
        fc.string({ maxLength: 200 }),
        fc.string({ maxLength: 200 }),
        async ([savedId, otherId], otherText, written) => {
          queryClient.clear();
          queryClient.setQueryData(fileTextKey(otherId), otherText);

          await saveNote(makeItem(savedId), written);

          // Cross-item bleed would put one note's text in front of another
          // note's file, and the review editor writes back what it displays.
          expect(queryClient.getQueryData(fileTextKey(otherId))).toBe(otherText);
        }
      )
    );
  });

  it('leaves the cache untouched when the write to disk fails', async () => {
    // The cache stands in for what is on disk. Publishing text that never
    // landed would make a later refetch of the real content look like an
    // external edit, and the editor would be resynced to it.
    const original = 'on disk';
    queryClient.setQueryData(fileTextKey('article-1'), original);
    vi.spyOn(ObsidianHelpers, 'editNote').mockRejectedValue(
      new Error('write failed')
    );

    const saveNote = captureSaveNote(makeReviewManager());

    await expect(saveNote(makeItem('article-1'), 'never reached')).rejects.toThrow(
      'write failed'
    );
    expect(queryClient.getQueryData(fileTextKey('article-1'))).toBe(original);
  });

  it('writes the note before publishing to the cache', async () => {
    // Ordering matters for the same reason as the failure case: the cache must
    // never describe a state disk has not reached.
    const order: string[] = [];
    vi.spyOn(ObsidianHelpers, 'editNote').mockImplementation(async () => {
      order.push('editNote');
      return '';
    });
    const saveNote = captureSaveNote(makeReviewManager());

    await saveNote(makeItem('article-1'), 'new body');
    order.push(
      queryClient.getQueryData(fileTextKey('article-1')) === 'new body'
        ? 'cached'
        : 'not cached'
    );

    expect(order).toEqual(['editNote', 'cached']);
  });

  it('passes the saved text to editNote as the new file content', async () => {
    const editNote = vi
      .spyOn(ObsidianHelpers, 'editNote')
      .mockResolvedValue('');
    const saveNote = captureSaveNote(makeReviewManager());
    const item = makeItem('article-1', 'IR/Articles/target.md');

    await saveNote(item, 'replacement body');

    expect(editNote).toHaveBeenCalledTimes(1);
    const [, file, transform] = editNote.mock.calls[0];
    expect(file).toBe(item.file);
    // The transform ignores current content: saveNote replaces the whole note.
    expect((transform as (data: string) => string)('anything at all')).toBe(
      'replacement body'
    );
  });

  it('persists every highlight offset read before the write (property-based)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 20 }),
            start_offset: fc.integer({ min: 0, max: 10_000 }),
            end_offset: fc.integer({ min: 0, max: 10_000 }),
          }),
          { maxLength: 8 }
        ),
        async (highlights) => {
          queryClient.clear();
          const reviewManager = makeReviewManager(highlights);
          const saveNote = captureSaveNote(reviewManager);

          await saveNote(makeItem('article-1'), 'body');

          expect(reviewManager.updateSnippetOffsets).toHaveBeenCalledTimes(
            highlights.length
          );
          highlights.forEach((h, i) => {
            expect(reviewManager.updateSnippetOffsets).toHaveBeenNthCalledWith(
              i + 1,
              h.id,
              h.start_offset,
              h.end_offset
            );
          });
        }
      )
    );
  });
});

describe('useReviewContext', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('throws when read outside the provider', () => {
    // Returning null instead would hand every consumer an undefined saveNote,
    // and the failure would surface later as a note that silently stops saving.
    function Orphan() {
      useReviewContext();
      return null;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);

    expect(() => render((<Orphan />) as never, container)).toThrow(
      'Review context can only be accessed within its provider'
    );
  });
});

describe('saveNote suppresses external-modification handling around its own write', () => {
  beforeEach(() => {
    queryClient.clear();
    vi.spyOn(ObsidianHelpers, 'editNote').mockResolvedValue('');
  });

  afterEach(() => {
    document.body.innerHTML = '';
    dispatch.mockClear();
    queryClient.clear();
    vi.restoreAllMocks();
  });

  it('raises the saving flag before writing and lowers it after', async () => {
    // While raised, the vault modify handler skips invalidation — that is what
    // keeps the editor's own write from bouncing back through a refetch.
    const saveNote = captureSaveNote(makeReviewManager());

    await saveNote(makeItem('article-1'), 'body');

    const payloads = dispatch.mock.calls.map(
      ([action]) => (action as { payload: boolean }).payload
    );
    expect(payloads).toEqual([true, false]);
  });

  it('lowers the saving flag even when the write throws', async () => {
    // A flag left raised would disable external-edit syncing for the rest of
    // the session, silently.
    vi.spyOn(ObsidianHelpers, 'editNote').mockRejectedValue(
      new Error('write failed')
    );
    const saveNote = captureSaveNote(makeReviewManager());

    await expect(saveNote(makeItem('article-1'), 'body')).rejects.toThrow();

    const payloads = dispatch.mock.calls.map(
      ([action]) => (action as { payload: boolean }).payload
    );
    expect(payloads).toEqual([true, false]);
  });
});
