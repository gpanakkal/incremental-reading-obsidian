// @vitest-environment jsdom
import * as ReviewContext from '#/components/ReviewContext';
import type { ReviewItem } from '#/lib/types';
import type * as ReactQueryModule from '@tanstack/react-query';
import type { UseQueryOptions } from '@tanstack/react-query';
import fc from 'fast-check';
import type { TFile } from 'obsidian';
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCurrentItemFileText } from './useReactQuery';

// #region HELPERS

type QueryResult = { data: unknown; isLoading: boolean };

/**
 * What the mocked `useQuery` answers with, keyed by the first segment of the
 * query key. Set per case by `wireQueries`.
 */
let answers: Record<string, QueryResult> = {};
/** Every options object the hook handed to `useQuery`, in call order. */
let optionsSeen: UseQueryOptions[] = [];

// react-query is mocked rather than spied on so the two queries this hook
// chains can be driven independently: the point of the hook is how it combines
// them, and a real client would make their timing the test's subject instead.
//
// Partial, because `QueryClient` is constructed at import time further down the
// hook's dependency chain (query-client.ts), so a bare factory breaks the
// module graph before any test runs.
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactQueryModule>()),
  useQuery: (options: UseQueryOptions) => {
    optionsSeen.push(options);
    const key = (options.queryKey as string[])[0];
    return answers[key] ?? { data: undefined, isLoading: false };
  },
}));

// react-redux's exports are non-configurable, so `vi.spyOn` on them throws
// "Cannot redefine property". `useCurrentItem` only reads `currentItemId` to
// resubscribe, and which id that is does not reach the result.
vi.mock('react-redux', () => ({
  useSelector: () => null,
  useStore: () => ({ getState: () => ({}) }),
  useDispatch: () => vi.fn(),
}));

function makeItem(id: string): ReviewItem {
  return {
    data: { type: 'article', id },
    file: { path: `sources/${id}.md` } as TFile,
  } as ReviewItem;
}

function wireQueries({
  item,
  itemLoading,
  text,
  textLoading,
}: {
  item: ReviewItem | null;
  itemLoading: boolean;
  text: string | undefined;
  textLoading: boolean;
}) {
  answers = {
    // react-query reports no data while a query is pending, so an absent item
    // is `undefined` here rather than null.
    'current-review-item': { data: item ?? undefined, isLoading: itemLoading },
    item: { data: text, isLoading: textLoading },
  };
  optionsSeen = [];
  vi.spyOn(ReviewContext, 'useReviewContext').mockReturnValue({
    plugin: { app: { vault: { read: vi.fn() } } },
    reviewManager: {},
    // The hook pushes the current file into the view from an effect. Preact
    // defers effects past `render`, so these are never reached here, but the
    // context has to carry them for the hook to typecheck against it.
    reviewView: {
      file: null,
      setFile: vi.fn(),
      onLoadFile: vi.fn(),
      onUnloadFile: vi.fn(),
    },
  } as never);
}

/** Render the hook in a throwaway component and hand back what it returned. */
function callHook(): ReturnType<typeof useCurrentItemFileText> {
  let captured: ReturnType<typeof useCurrentItemFileText> | undefined;
  function Probe() {
    /* eslint-disable-next-line react-hooks/globals --
       A probe, not a component: the assignment is how the hook's return value
       leaves the render it has to happen inside. Nothing here re-renders, so
       the impurity the rule guards against cannot arise. */
    captured = useCurrentItemFileText();
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  render(<Probe />, container);
  if (!captured) throw new Error('hook did not run');
  return captured;
}

/** The options the file-text query was created with. */
function textQueryOptions(): UseQueryOptions {
  const options = optionsSeen.find(
    (o) => (o.queryKey as string[])[0] === 'item'
  );
  if (!options) throw new Error('file-text query was never created');
  return options;
}

// #endregion

describe('useCurrentItemFileText', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('reports loading while either the item or its file text is in flight', () => {
    // The two queries run on separate legs — the item resolves, then its file
    // is read — so the caller is still loading while *either* is pending. The
    // combinations where a query reports loading with data already present are
    // included on purpose: react-query does not produce them, and the hook
    // must not quietly come to depend on that.
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.option(fc.string(), { nil: null }),
        fc.option(fc.string(), { nil: undefined }),
        (itemLoading, textLoading, id, text) => {
          wireQueries({
            item: id === null ? null : makeItem(id),
            itemLoading,
            text,
            textLoading,
          });

          const result = callHook();

          expect(result.isLoading).toBe(itemLoading || textLoading);
        }
      )
    );
  });

  it('settles rather than hanging when there is no item to read a file for', () => {
    // The guard that keeps the disjunction above honest. With no item the text
    // query is disabled, and a disabled query never reports loading, so the
    // pair resolves to "not loading" and the caller is free to say the queue is
    // empty. Were the query left enabled it would run and stay pending, and the
    // empty queue would sit behind a spinner forever.
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: null }), (id) => {
        const item = id === null ? null : makeItem(id);
        wireQueries({
          item,
          itemLoading: false,
          text: undefined,
          textLoading: false,
        });

        const result = callHook();

        expect(textQueryOptions().enabled).toBe(item !== null);
        expect(result.isLoading).toBe(false);
      })
    );
  });

  it('pairs the fetched text with the item it was keyed on', () => {
    // Normalising the absent item to null is the hook's whole contract beyond
    // the flag: callers branch on `!item`, and react-query hands back
    // `undefined`, not null, for a query that has not produced data.
    fc.assert(
      fc.property(
        fc.option(fc.string(), { nil: null }),
        fc.option(fc.string(), { nil: undefined }),
        (id, text) => {
          const item = id === null ? null : makeItem(id);
          wireQueries({ item, itemLoading: false, text, textLoading: false });

          const result = callHook();

          expect(result.item).toBe(item);
          expect(result.text).toBe(text);
          // The text is cached per item id, so the id in the key has to be the
          // id of the item being returned alongside it — a mismatch would put
          // one note's contents in front of another note's file, and the review
          // editor writes back what it displays.
          expect(textQueryOptions().queryKey).toEqual([
            'item',
            item?.data.id,
            'file-text',
          ]);
        }
      )
    );
  });
});
