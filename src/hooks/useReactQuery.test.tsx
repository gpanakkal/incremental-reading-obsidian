// @vitest-environment jsdom
import * as ReviewContext from '#/components/ReviewContext';
import type { ReviewItem } from '#/lib/types';
import type * as ReactQueryModule from '@tanstack/react-query';
import type { UseQueryOptions } from '@tanstack/react-query';
import fc from 'fast-check';
import type { TFile } from 'obsidian';
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCurrentItemFileText, useReviewItems } from './useReactQuery';

// #region HELPERS

type QueryResult = { data: unknown; isLoading: boolean };

/**
 * What react-query has cached, keyed the way react-query keys it: by the whole
 * query key, not by its first segment. Modelling the key faithfully is the
 * point — the hook's job is to ask under a key that cannot reach another item's
 * data, and a lookup that ignored the key could not tell whether it did.
 */
let cache = new Map<string, QueryResult>();
/** Every options object the hook handed to `useQuery`, in call order. */
let optionsSeen: UseQueryOptions[] = [];

const keyOf = (queryKey: unknown) => JSON.stringify(queryKey);

/** What react-query answers for a key it has nothing for: a fetch in flight. */
const MISS: QueryResult = { data: undefined, isLoading: true };

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
    return cache.get(keyOf(options.queryKey)) ?? MISS;
  },
}));

/** The slice of the store the hook reads. Replaced per case by `wireQueries`. */
let reduxState: { currentItemId: string | null } = { currentItemId: null };

// react-redux is mocked rather than spied on because its exports are
// non-configurable: `vi.spyOn(ReactRedux, 'useSelector')` throws "Cannot
// redefine property". This is the documented cannot-be-spied case. Which id the
// store names is the hook's input, not incidental subscription bookkeeping, so
// unlike the queries it cannot be stubbed away to a constant.
vi.mock('react-redux', () => ({
  useSelector: (select: (state: typeof reduxState) => unknown) =>
    select(reduxState),
  useStore: () => ({ getState: () => reduxState }),
  useDispatch: () => vi.fn(),
}));

function makeItem(id: string): ReviewItem {
  return {
    data: { type: 'article', id },
    file: { path: `sources/${id}.md` } as TFile,
  } as ReviewItem;
}

/**
 * Seed the entry react-query holds for the current item, under both the bare
 * key and the keyed-by-id form.
 *
 * Both, so the cases below describe what the hook *shows* rather than which key
 * shape it happens to ask under: an item reachable by either route is an item
 * the hook can put on screen, and one belonging to an id the store has moved
 * off is the flicker however it was reached.
 */
function seedCurrentItem(cachedFor: string | null, result: QueryResult) {
  cache.set(keyOf(['current-review-item']), result);
  cache.set(keyOf(['current-review-item', cachedFor]), result);
}

function wireContext() {
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

function wireQueries({
  item,
  itemLoading,
  text,
  textLoading,
  currentItemId = item?.data.id ?? null,
}: {
  item: ReviewItem | null;
  itemLoading: boolean;
  text: string | undefined;
  textLoading: boolean;
  /** Defaults to the store agreeing with the cache — the settled case. */
  currentItemId?: string | null;
}) {
  cache = new Map();
  optionsSeen = [];
  reduxState = { currentItemId };
  // `data: item`, not `item ?? undefined`: react-query distinguishes a query
  // that resolved to nothing (null) from one that has not resolved yet
  // (undefined), and so does the hook — the first is an exhausted queue, the
  // second is a fetch still running.
  seedCurrentItem(item?.data.id ?? null, {
    data: item,
    isLoading: itemLoading,
  });
  cache.set(keyOf(['item', item?.data.id, 'file-text']), {
    data: text,
    isLoading: textLoading,
  });
  wireContext();
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

/** The options of the query whose key starts with `head`. */
function queryOptions(head: string): UseQueryOptions {
  const options = optionsSeen.find((o) => (o.queryKey as string[])[0] === head);
  if (!options) throw new Error(`${head} query was never created`);
  return options;
}

/** The options the file-text query was created with. */
const textQueryOptions = () => queryOptions('item');
/** The options the current-item query was created with. */
const currentQueryOptions = () => queryOptions('current-review-item');

/** Two ids that are never equal — the cases about moving between items. */
const twoIdsArb = fc
  .tuple(fc.string(), fc.string())
  .filter(([a, b]) => a !== b);

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

  it('keys the current item on the id the store names', () => {
    // The same rule the file-text key follows, for the same reason. One shared
    // key for every item means react-query serves the item that was on screen a
    // moment ago as settled data for the item just picked, because nothing in
    // the key says they are different fetches. The id in the key makes moving
    // between items a cache miss, which is the only state a new item may
    // arrive in.
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: null }), (currentItemId) => {
        wireQueries({
          item: null,
          itemLoading: false,
          text: undefined,
          textLoading: false,
          currentItemId,
        });

        callHook();

        expect(currentQueryOptions().queryKey).toEqual([
          'current-review-item',
          currentItemId,
        ]);
      })
    );
  });

  it('shows nothing but loading once the store moves to another item', () => {
    // The reported flicker: open an item, go back to the home screen, open a
    // different one, and the first is painted again before the second arrives.
    // Everything downstream believes this hook — the review pane renders the
    // item, the action bar aims dismiss and grade at it — so handing back the
    // outgoing item is wrong twice over, not merely ugly.
    fc.assert(
      fc.property(twoIdsArb, fc.string(), ([openId, pickedId], text) => {
        wireQueries({
          item: makeItem(openId),
          itemLoading: false,
          text,
          textLoading: false,
          currentItemId: pickedId,
        });

        const result = callHook();

        expect(result.item).toBeNull();
        expect(result.text).toBeUndefined();
        expect(result.isLoading).toBe(true);
      })
    );
  });

  it('stays loading across an advance rather than re-showing the item just finished', () => {
    // Finishing an item clears the id and lets the queue name the next one, so
    // for that window the id is null while the cache still holds the item that
    // was finished. The same flicker as above with no id to compare against,
    // and the one every review passes through.
    fc.assert(
      fc.property(fc.string(), fc.string(), (finishedId, text) => {
        wireQueries({
          item: makeItem(finishedId),
          itemLoading: false,
          text,
          textLoading: false,
          currentItemId: null,
        });

        const result = callHook();

        expect(result.item).toBeNull();
        expect(result.isLoading).toBe(true);
      })
    );
  });

  it('reports an exhausted queue rather than loading forever', () => {
    // The limit on the two cases above, and why neither can simply say "no id,
    // no item": an advance that comes back empty is also a null id, and it is
    // how the queue reports there is nothing left. It is told apart by the
    // cached value — a resolved null, not an absent one — so an empty queue
    // settles instead of spinning.
    wireQueries({
      item: null,
      itemLoading: false,
      text: undefined,
      textLoading: false,
      currentItemId: null,
    });

    const result = callHook();

    expect(result.item).toBeNull();
    expect(result.isLoading).toBe(false);
  });
});

describe('useReviewItems', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  /**
   * Ids to look up, against a database holding items for `storedIds`. The ids
   * asked for mix ones the database holds with ones it does not, in any order
   * and with repeats — an id held in the store can outlive its item.
   */
  const lookupArb = fc.uniqueArray(fc.string()).chain((storedIds) =>
    fc.record({
      storedIds: fc.constant(storedIds),
      ids: fc.array(
        storedIds.length
          ? fc.oneof(fc.constantFrom(...storedIds), fc.string())
          : fc.string()
      ),
    })
  );

  /** Render the hook for `ids` and hand back the query it built. */
  function buildQuery(ids: string[], storedIds: string[]) {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    optionsSeen = [];
    cache = new Map();

    const stored = new Map(storedIds.map((id) => [id, makeItem(id)]));
    const getReviewItemFromId = vi.fn(
      async (id: string) => stored.get(id) ?? null
    );
    vi.spyOn(ReviewContext, 'useReviewContext').mockReturnValue({
      reviewManager: { getReviewItemFromId },
    } as never);

    function Probe() {
      useReviewItems(ids);
      return null;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(<Probe />, container);

    const options = queryOptions('review-items');
    const run = options.queryFn as () => Promise<ReviewItem[]>;
    return { options, run, stored, getReviewItemFromId };
  }

  it('keys the lookup on the ids asked for, apart from the entries review evicts', () => {
    fc.assert(
      fc.property(lookupArb, ({ ids, storedIds }) => {
        const { options } = buildQuery(ids, storedIds);

        expect(options.queryKey).toEqual(['review-items', ids]);
      })
    );
  });

  it('resolves the ids that name an item, in the order asked, leaving out the rest', async () => {
    await fc.assert(
      fc.asyncProperty(lookupArb, async ({ ids, storedIds }) => {
        const { run, stored, getReviewItemFromId } = buildQuery(ids, storedIds);

        const items = await run();

        const expected = ids.flatMap((id) => stored.get(id) ?? []);
        expect(items).toHaveLength(expected.length);
        items.forEach((item, i) => expect(item).toBe(expected[i]));
        expect(getReviewItemFromId.mock.calls).toEqual(ids.map((id) => [id]));
      })
    );
  });
});
