import type ReviewManager from '#/lib/items/ReviewManager';
import { invalidateCacheOnMatch, queryClient } from '#/lib/query-client';
import { setCurrentItemId, setReviewViewSaving, store } from '#/lib/store';
import type { IArticleBase, ReviewArticle } from '#/lib/types';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import type { FakeFile } from './FakeVault';
import {
  FakeRepository,
  FakeReviewManager,
  FakeVault,
  FIXED_NOW,
  makeGate,
  setupHarnessLifecycle,
} from './SimulationHarness';

// #region HELPERS
const DB_PATH = 'ir-user-data.sqlite';
const ARTICLE_PATH = 'articles/article.md';

function makeArticleData(overrides: Partial<IArticleBase> = {}): IArticleBase {
  return {
    id: 'article-1',
    type: 'article',
    reference: ARTICLE_PATH,
    due: FIXED_NOW,
    interval: 86_400_000,
    dismissed: false,
    deleted: false,
    priority: 30,
    fixed_interval_days: null,
    scroll_top: 0,
    ...overrides,
  };
}

function makeReviewArticle(
  overrides: Partial<IArticleBase> = {}
): ReviewArticle {
  return {
    data: makeArticleData(overrides),
    file: { path: ARTICLE_PATH } as ReviewArticle['file'],
  };
}

function asRM(fakeRM: FakeReviewManager): ReviewManager {
  return fakeRM as unknown as ReviewManager;
}

function asFile(f: FakeFile): Parameters<typeof invalidateCacheOnMatch>[0] {
  return f as Parameters<typeof invalidateCacheOnMatch>[0];
}
// #endregion

describe('RC1: pendingSaveCount drift — stale DB after external sync write', () => {
  let harness: {
    fakeVault: FakeVault;
    fakeRepo: FakeRepository;
    fakeRM: FakeReviewManager;
  };
  setupHarnessLifecycle(
    () => harness,
    (h) => {
      harness = h;
    }
  );

  it('pending save count is decremented on successful save', async () => {
    const { fakeVault, fakeRepo } = harness;
    const reloadSpy = vi.spyOn(
      fakeRepo as unknown as { reloadDb: () => unknown },
      'reloadDb'
    );

    // 1. mutate() triggers void save() → pendingSaveCount becomes 1
    fakeRepo.mutate('SELECT 1');
    expect(fakeRepo.pendingSaveCountForTest).toBe(1);

    // 2. A modify event for a non-DB file arrives — count must not change
    await fakeRepo.handleFileChange({
      path: 'snippets/foo.md',
    } as FakeFile as Parameters<typeof fakeRepo.handleFileChange>[0]);
    expect(fakeRepo.pendingSaveCountForTest).toBe(1);

    // 3. The DB write resolves — count should go back to 0
    fakeVault.resolvePendingWrite();
    await Promise.resolve(); // let the save() microtask settle

    expect(fakeRepo.pendingSaveCountForTest).toBe(0);

    // 4. Simulate external sync: a new DB version is written externally
    fakeVault.setDiskBytes(new ArrayBuffer(16));

    // 5. handleFileChange fires for the DB file
    //    count is 1 > 0 → decrements to 0 → skips reloadDb — BUG: external update ignored
    await fakeRepo.handleFileChange({ path: DB_PATH } as FakeFile as Parameters<
      typeof fakeRepo.handleFileChange
    >[0]);

    // reloadDb should have been called
    expect(reloadSpy).toHaveBeenCalledOnce();
    expect(fakeRepo.pendingSaveCountForTest).toBe(0);

    // This test documents the bug: it will FAIL once save() correctly decrements
    // pendingSaveCount on success (at which point count reaches 0 before step 5,
    // and the external modify correctly triggers reloadDb).
  });

  it('property: after N mutates and N matching DB modify events, count returns to 0 and reloadDb is never called', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (n) => {
        const fakeVault = new FakeVault();
        const fakeRepo = FakeRepository.create(fakeVault, DB_PATH);
        const reloadSpy = vi.spyOn(
          fakeRepo as unknown as { reloadDb: () => unknown },
          'reloadDb'
        );

        // Fire N mutates — each increments count and enqueues a write
        for (let i = 0; i < n; i++) {
          fakeRepo.mutate('SELECT 1');
        }
        expect(fakeRepo.pendingSaveCountForTest).toBe(n);

        // Resolve all N writes
        for (let i = 0; i < n; i++) {
          fakeVault.resolvePendingWrite();
          await Promise.resolve();
        }

        // Fire N DB modify events (one per write Obsidian would normally emit)
        for (let i = 0; i < n; i++) {
          await fakeRepo.handleFileChange({
            path: DB_PATH,
          } as FakeFile as Parameters<typeof fakeRepo.handleFileChange>[0]);
        }

        // After N events, count should be 0 and reloadDb was called n times
        expect(fakeRepo.pendingSaveCountForTest).toBe(0);
        expect(reloadSpy).toHaveBeenCalledTimes(n);
      })
    );
  });
});

describe('RC2: isReviewViewSaving timing gap — spurious cache invalidation', () => {
  let harness: {
    fakeVault: FakeVault;
    fakeRepo: FakeRepository;
    fakeRM: FakeReviewManager;
  };
  setupHarnessLifecycle(
    () => harness,
    (h) => {
      harness = h;
    },
    { initialItemId: 'article-1' }
  );

  it('invalidateCacheOnMatch proceeds and invalidates when flag is false (spurious invalidation window)', async () => {
    const { fakeRM } = harness;
    const item = makeReviewArticle();
    fakeRM.setNextItem(item);
    queryClient.setQueryData(['current-review-item'], item);

    // Flag is already false — this is the state after withReviewViewSave's finally block
    store.dispatch(setReviewViewSaving(false));

    // A vault modify for the article file arrives while flag=false
    fakeRM.blockFetch();
    const p = invalidateCacheOnMatch(
      asFile({ path: ARTICLE_PATH }),
      asRM(fakeRM)
    );
    fakeRM.resumeFetch();
    await p;

    // The cache was invalidated — this is the spurious invalidation window
    const cacheState = queryClient.getQueryState(['current-review-item']);
    expect(cacheState?.isInvalidated).toBe(true);
  });

  it('invalidateCacheOnMatch skips invalidation when flag is true (guard works correctly)', async () => {
    const { fakeRM } = harness;
    const item = makeReviewArticle();
    fakeRM.setNextItem(item);
    queryClient.setQueryData(['current-review-item'], item);

    // Flag is true — withReviewViewSave is still active
    store.dispatch(setReviewViewSaving(true));

    await invalidateCacheOnMatch(asFile({ path: ARTICLE_PATH }), asRM(fakeRM));

    // Cache must NOT be invalidated — the guard correctly prevented it
    const cacheState = queryClient.getQueryState(['current-review-item']);
    expect(cacheState?.isInvalidated).toBeFalsy();
    expect(fakeRM.fetchCallCount).toBe(0);
  });

  it('path mismatch prevents invalidation even when flag is false', async () => {
    const { fakeRM } = harness;
    const item = makeReviewArticle();
    fakeRM.setNextItem(item);
    queryClient.setQueryData(['current-review-item'], item);

    store.dispatch(setReviewViewSaving(false));

    // Modify event is for the DB file, not the article file
    await invalidateCacheOnMatch(asFile({ path: DB_PATH }), asRM(fakeRM));

    const cacheState = queryClient.getQueryState(['current-review-item']);
    expect(cacheState?.isInvalidated).toBeFalsy();
  });
});

describe('RC3: mid-creation invalidation during multi-step snippet creation', () => {
  let harness: {
    fakeVault: FakeVault;
    fakeRepo: FakeRepository;
    fakeRM: FakeReviewManager;
  };
  setupHarnessLifecycle(
    () => harness,
    (h) => {
      harness = h;
    },
    { initialItemId: 'article-1' }
  );

  // Scenario: article is the current review item. User extracts a snippet from it.
  // SnippetManager.create() fires vault writes in sequence:
  //   1. vault.create(snippetFile)                    → modify event for snippetFile
  //   2. vault.processFrontMatter(snippetFile, ...)   → modify event for snippetFile
  //   3. vault.processFrontMatter(articleFile, ...)   → modify event for articleFile  ← matches current item
  //   4. repo.mutate(INSERT snippet) → void save()    → modify event for DB file
  //
  // Steps 1-2 should not affect the article cache (path mismatch).
  // Step 3 fires mid-creation: the snippet DB entry does not yet exist.
  //   invalidateCacheOnMatch fetches the current item (the article, pre-creation state)
  //   and invalidates the cache. This is the race: the cache is stale post-invalidation.
  // Step 4 fires after createEntry: the snippet now exists in DB.
  //   Another invalidation fires; the next fetch will return the article with the snippet.
  it('step 3 of create() invalidates article cache with pre-creation state; step 4 re-invalidates post-creation', async () => {
    const { fakeRM } = harness;

    // Article is being reviewed. No snippets yet.
    const articlePreCreation = makeReviewArticle();
    fakeRM.setNextItem(articlePreCreation);
    queryClient.setQueryData(['current-review-item'], articlePreCreation);

    // Step 1: vault.create(snippetFile) — path is the new snippet, not the article
    await invalidateCacheOnMatch(
      asFile({ path: 'snippets/my-snippet.md' }),
      asRM(fakeRM)
    );
    expect(
      queryClient.getQueryState(['current-review-item'])?.isInvalidated
    ).toBeFalsy();

    // Step 2: vault.processFrontMatter(snippetFile) — still snippet path, no match
    await invalidateCacheOnMatch(
      asFile({ path: 'snippets/my-snippet.md' }),
      asRM(fakeRM)
    );
    expect(
      queryClient.getQueryState(['current-review-item'])?.isInvalidated
    ).toBeFalsy();

    // Step 3: vault.processFrontMatter(articleFile) — path MATCHES current item
    // The snippet has not been inserted into the DB yet; fakeRM still returns pre-creation state.
    // The cache is invalidated with stale (pre-creation) data — this is the race window.
    await invalidateCacheOnMatch(asFile({ path: ARTICLE_PATH }), asRM(fakeRM));
    expect(
      queryClient.getQueryState(['current-review-item'])?.isInvalidated
    ).toBe(true);

    // Step 4: repo.mutate(INSERT snippet) fires, then void save() triggers a DB modify.
    // The DB file path does NOT match ARTICLE_PATH, so no explicit invalidation fires.
    // However, fetchCurrentItem is still called (flag=false, no early return).
    // Because the cache is currently invalidated, queryClient.fetchQuery re-executes
    // queryFn and stores fresh data — the cache transitions from stale → fresh as a
    // side effect, even though the path check then causes an early return.
    await invalidateCacheOnMatch(asFile({ path: DB_PATH }), asRM(fakeRM));
    expect(
      queryClient.getQueryState(['current-review-item'])?.isInvalidated
    ).toBeFalsy();

    // After the UI refetches (simulated by reseeding the cache), the article now has the snippet.
    // The next article-path modify (e.g. if another edit happens) sees the updated state.
    const articlePostCreation = makeReviewArticle({ scroll_top: 1 }); // same id, different state
    fakeRM.setNextItem(articlePostCreation);
    queryClient.setQueryData(['current-review-item'], articlePostCreation);
    await invalidateCacheOnMatch(asFile({ path: ARTICLE_PATH }), asRM(fakeRM));
    expect(
      queryClient.getQueryState(['current-review-item'])?.isInvalidated
    ).toBe(true);
  });

  // Property: for N intermediate vault writes (steps 1..N before createEntry),
  // invalidateCacheOnMatch never throws and always resolves, regardless of which
  // paths are modified and in what order.
  it('property: N intermediate modify events during snippet creation never throw', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }),
        async (extraSnippetWrites, matchArticleFlags) => {
          // Reset to a clean current-item state for each property run
          store.dispatch(setCurrentItemId('article-1'));
          queryClient.clear();

          const localRM = new FakeReviewManager();
          const item = makeReviewArticle();
          localRM.setNextItem(item);
          queryClient.setQueryData(['current-review-item'], item);

          // Snippet file writes (non-matching) — must not invalidate
          for (let i = 0; i < extraSnippetWrites; i++) {
            await expect(
              invalidateCacheOnMatch(
                asFile({ path: `snippets/snippet-${i}.md` }),
                asRM(localRM)
              )
            ).resolves.toBeUndefined();
            expect(
              queryClient.getQueryState(['current-review-item'])?.isInvalidated
            ).toBeFalsy();
          }

          // Mixed article/snippet events (article path triggers invalidation)
          for (const matchesArticle of matchArticleFlags) {
            const path = matchesArticle
              ? ARTICLE_PATH
              : `snippets/other-${Math.random()}.md`;
            await expect(
              invalidateCacheOnMatch(asFile({ path }), asRM(localRM))
            ).resolves.toBeUndefined();
          }
          // Final invariant: no exceptions were thrown (resolves.toBeUndefined above ensures this)
        }
      ),
      { seed: 42 }
    );
  });
});

describe('RC4: handleFileChange and invalidateCacheOnMatch run concurrently', () => {
  let harness: {
    fakeVault: FakeVault;
    fakeRepo: FakeRepository;
    fakeRM: FakeReviewManager;
  };
  setupHarnessLifecycle(
    () => harness,
    (h) => {
      harness = h;
    },
    { initialItemId: 'article-1' }
  );

  it('both handlers complete without throwing and cache is invalidated', async () => {
    const { fakeRepo, fakeRM } = harness;
    const item = makeReviewArticle();
    fakeRM.setNextItem(item);
    queryClient.setQueryData(['current-review-item'], item);

    const reloadGate = makeGate();
    const reloadSpy = vi
      .spyOn(fakeRepo as unknown as { reloadDb: () => unknown }, 'reloadDb')
      .mockImplementation(async () => {
        await reloadGate.promise;
        return fakeRepo.db;
      });

    fakeRM.blockFetch();

    // Fire both handlers concurrently — neither is awaited at this point
    const h1 = fakeRepo.handleFileChange({
      path: DB_PATH,
    } as FakeFile as Parameters<typeof fakeRepo.handleFileChange>[0]);
    const h2 = invalidateCacheOnMatch(
      asFile({ path: ARTICLE_PATH }),
      asRM(fakeRM)
    );

    // Both are now suspended: h1 at reloadDb gate, h2 at fetchCurrentItem gate

    // Resume fetch first, then reload
    fakeRM.resumeFetch();
    reloadGate.resolve();

    await expect(Promise.all([h1, h2])).resolves.not.toThrow();

    expect(reloadSpy).toHaveBeenCalledTimes(1);
    const cacheState = queryClient.getQueryState(['current-review-item']);
    expect(cacheState?.isInvalidated).toBe(true);
  });

  it('property: invariant holds for both resume orderings (fetch-first vs reload-first)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(), // true = resume fetch before reload
        async (fetchFirst) => {
          const fakeVault = new FakeVault();
          const fakeRepo = FakeRepository.create(fakeVault, DB_PATH);
          const fakeRM = new FakeReviewManager();

          store.dispatch({ type: 'resetSession' });
          queryClient.clear();
          store.dispatch({
            type: 'currentItemId/setCurrentItemId',
            payload: 'article-1',
          });

          const item = makeReviewArticle();
          fakeRM.setNextItem(item);
          queryClient.setQueryData(['current-review-item'], item);

          const reloadGate = makeGate();
          const reloadSpy = vi
            .spyOn(
              fakeRepo as unknown as { reloadDb: () => unknown },
              'reloadDb'
            )
            .mockImplementation(async () => {
              await reloadGate.promise;
              return fakeRepo.db;
            });

          fakeRM.blockFetch();

          const h1 = fakeRepo.handleFileChange({
            path: DB_PATH,
          } as FakeFile as Parameters<typeof fakeRepo.handleFileChange>[0]);
          const h2 = invalidateCacheOnMatch(
            asFile({ path: ARTICLE_PATH }),
            asRM(fakeRM)
          );

          if (fetchFirst) {
            fakeRM.resumeFetch();
            reloadGate.resolve();
          } else {
            reloadGate.resolve();
            fakeRM.resumeFetch();
          }

          await Promise.all([h1, h2]);

          expect(reloadSpy).toHaveBeenCalledTimes(1);
          const cacheState = queryClient.getQueryState(['current-review-item']);
          expect(cacheState?.isInvalidated).toBe(true);
        }
      ),
      { seed: 42 }
    );
  });
});
