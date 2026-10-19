import { BATCHED_MUTATION_SLICE_MS } from '#/lib/constants';
import fc from 'fast-check';
import { TFile, type App } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getVaultSearch, loadSearchEngine } from './vault-search';

// #region HELPERS
/** One file of a generated vault, and how the engine treats it. */
interface FileSpec {
  extension: string;
  /** The "Excluded files" setting hides it. */
  ignored: boolean;
  /** No view opens its type. */
  unsupported: boolean;
  /** What `match` answers for it: a hit (an object, maybe empty) or not. */
  answer: 'hit' | 'empty-hit' | 'miss';
  /** Reading it throws. */
  unreadable: boolean;
}

/** A note the query matches, searched like any other. */
const PLAIN: FileSpec = {
  extension: 'md',
  ignored: false,
  unsupported: false,
  answer: 'hit',
  unreadable: false,
};

function makeFile(index: number, extension: string): TFile {
  const name = `f${index}.${extension}`;
  return Object.assign(new TFile(), {
    path: `dir/${name}`,
    name,
    basename: `f${index}`,
    extension,
  });
}

/** What a query made by {@link makeQueryClass} recorded. */
interface QueryLog {
  /** Each query made, in order: the probes' and the searches'. */
  made: string[];
  /** What each was made with besides its text. */
  args: { app: unknown; caseSensitive: boolean }[];
  /** Each `match` call: the file and the content it was handed. */
  matched: { file: TFile; content: string }[];
}

/**
 * A stand-in for core's query class, as Obsidian 1.13.7 has it: it parses as
 * it is made, throwing for an `x:` operator; a query of spaces parses to no
 * matcher; `match` answers what `answer` says for each file.
 */
function makeQueryClass({
  answer = () => ({}) as unknown,
  needsContent = true,
}: {
  answer?: (file: TFile, content: string) => unknown;
  needsContent?: boolean;
} = {}) {
  const log: QueryLog = { made: [], args: [], matched: [] };
  const errors: Error[] = [];
  class Query {
    matcher: object | null;
    requiredInputs: { content?: boolean };
    constructor(
      readonly app: unknown,
      readonly query: string,
      readonly caseSensitive: boolean
    ) {
      log.made.push(query);
      log.args.push({ app, caseSensitive });
      if (query.includes('x:')) {
        const error = new Error('Operator "x" not recognized');
        errors.push(error);
        throw error;
      }
      this.matcher = query.trim() ? {} : null;
      this.requiredInputs = needsContent ? { content: true } : {};
    }
    match(file: TFile, content: string) {
      log.matched.push({ file, content });
      return answer(file, content);
    }
  }
  return { Query, log, errors };
}

/** The file explorer's filter, as Obsidian 1.13.7 writes it. */
function makeExplorerView(Query: new (...args: never[]) => unknown) {
  return {
    app: null,
    searchQuery: null as unknown,
    onSearchChanged(this: Record<string, unknown>, query: string) {
      try {
        const made = new (Query as new (
          app: unknown,
          query: string,
          caseSensitive: boolean
        ) => { matcher: unknown })(this.app, query, false);
        this.searchQuery = made.matcher ? made : null;
        (this.filterSearchResults as () => void)();
      } catch (error) {
        console.log(error);
      }
    },
    filterSearchResults() {},
  };
}

interface AppParts {
  explorers?: unknown[];
  searchViews?: unknown[];
  cli?: unknown;
  files?: TFile[];
  /** Paths the "Excluded files" setting hides. */
  ignored?: ReadonlySet<string>;
  unsupported?: ReadonlySet<string>;
  unreadable?: ReadonlySet<string>;
  /** Which of the search's checks the metadata cache has. */
  filters?: boolean | 'ignored-only' | 'supported-only';
}

function makeApp({
  explorers = [],
  searchViews = [],
  cli,
  files = [],
  ignored = new Set(),
  unsupported = new Set(),
  unreadable = new Set(),
  filters = true,
}: AppParts = {}) {
  const leaves: Record<string, { view: unknown }[]> = {
    'file-explorer': explorers.map((view) => ({ view })),
    search: searchViews.map((view) => ({ view })),
  };
  const cachedRead = vi.fn(async (file: TFile) => {
    if (unreadable.has(file.path)) throw new Error(`can't read ${file.path}`);
    return `content of ${file.path}`;
  });
  const isUserIgnored = vi.fn((path: string) => ignored.has(path));
  const metadataCache = {
    ...(filters === true || filters === 'ignored-only'
      ? { isUserIgnored }
      : {}),
    ...(filters === true || filters === 'supported-only'
      ? {
          isSupportedFile: vi.fn((file: TFile) => !unsupported.has(file.path)),
        }
      : {}),
  };
  const app = {
    workspace: { getLeavesOfType: (type: string) => leaves[type] ?? [] },
    vault: {
      getFiles: () => files,
      cachedRead,
      getFileByPath: (path: string) =>
        files.find((file) => file.path === path) ?? null,
    },
    metadataCache,
    cli,
  } as unknown as App;
  return { app, cachedRead, isUserIgnored, leaves };
}

/** Core's `search` command, answering `answer` for every query. */
function makeCli(answer: (params: Record<string, string>) => Promise<unknown>) {
  const handler = vi.fn(answer);
  return {
    cli: { handlers: new Map([['search', { handler, description: '' }]]) },
    handler,
  };
}

const signal = () => new AbortController().signal;

/** A way to reach the query class that is broken in some way. */
type Broken =
  | 'absent'
  | 'no-method'
  | 'throws'
  | 'leaves-nothing'
  | 'no-match'
  | 'no-matcher'
  | 'no-constructor'
  | 'bad-instances'
  | 'probe-throws';

const brokenArb = fc.constantFrom<Broken>(
  'absent',
  'no-method',
  'throws',
  'leaves-nothing',
  'no-match',
  'no-matcher',
  'no-constructor',
  'bad-instances',
  'probe-throws'
);

/** The query a broken way leaves, if it leaves one. */
function brokenQuery(broken: Broken): unknown {
  switch (broken) {
    case 'no-match':
      return { matcher: {} };
    case 'no-matcher':
      return { match: () => ({}) };
    case 'no-constructor':
      return Object.assign(Object.create(null) as object, {
        matcher: {},
        match: () => ({}),
      });
    case 'bad-instances': {
      // Itself the shape, but the class makes nothing of the kind
      const instance = { matcher: {}, match: () => ({}) };
      Object.defineProperty(instance, 'constructor', {
        value: function NotAQuery() {
          return { matcher: {} };
        },
      });
      return instance;
    }
    case 'probe-throws': {
      const instance = { matcher: {}, match: () => ({}) };
      Object.defineProperty(instance, 'constructor', {
        value: function Throws() {
          throw new Error('no');
        },
      });
      return instance;
    }
    default:
      return null;
  }
}

/** A file explorer view broken as `broken` says, or none. */
function brokenExplorer(broken: Broken): unknown[] {
  if (broken === 'absent') return [];
  if (broken === 'no-method') return [{}];
  if (broken === 'throws')
    return [
      {
        onSearchChanged() {
          throw new Error('changed');
        },
      },
    ];
  const left = brokenQuery(broken);
  return [
    {
      onSearchChanged(this: Record<string, unknown>) {
        this.searchQuery = left;
      },
    },
  ];
}

/** A search view broken as `broken` says, or none. */
function brokenSearchView(broken: Broken): unknown[] {
  if (broken === 'absent') return [];
  if (broken === 'no-method' || broken === 'throws') return [{}];
  return [{ searchQuery: brokenQuery(broken) }];
}

/** A CLI broken in some way: missing, not a map, no `search`, no handler. */
const brokenCliArb = fc.constantFrom<unknown>(
  undefined,
  null,
  { handlers: { search: { handler: () => Promise.resolve('[]') } } },
  { handlers: new Map() },
  { handlers: new Map([['search', { description: '' }]]) },
  { handlers: new Map([['search', null]]) }
);

const fileSpecArb: fc.Arbitrary<FileSpec> = fc.record({
  extension: fc.constantFrom('md', 'canvas', 'pdf', 'png'),
  ignored: fc.boolean(),
  unsupported: fc.boolean(),
  answer: fc.constantFrom<FileSpec['answer']>('hit', 'empty-hit', 'miss'),
  unreadable: fc.nat({ max: 5 }).map((n) => n === 0),
});

/** A vault of `specs`, searched by core's query class. */
function makeVault(specs: readonly FileSpec[], needsContent: boolean) {
  const files = specs.map((spec, at) => makeFile(at, spec.extension));
  const specOf = new Map(files.map((file, at) => [file, specs[at]]));
  const answers = { hit: { content: [[0, 1]] }, 'empty-hit': {}, miss: null };
  const { Query, log, errors } = makeQueryClass({
    answer: (file) => answers[specOf.get(file)!.answer],
    needsContent,
  });
  const pathsWhere = (test: (spec: FileSpec) => boolean) =>
    new Set(files.filter((file) => test(specOf.get(file)!)).map((f) => f.path));
  const made = makeApp({
    explorers: [makeExplorerView(Query)],
    files,
    ignored: pathsWhere((spec) => spec.ignored),
    unsupported: pathsWhere((spec) => spec.unsupported),
    unreadable: pathsWhere((spec) => spec.unreadable),
  });
  return { ...made, files, specOf, log, errors };
}
// #endregion

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getVaultSearch', () => {
  it("takes the explorer's query class, else the search view's, else the CLI, else none, passing over each way that doesn't read as it should", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.constant<'works'>('works'), brokenArb),
        fc.oneof(fc.constant<'works'>('works'), brokenArb),
        fc.option(brokenCliArb, { nil: 'works' as const }),
        fc.constantFrom<AppParts['filters']>(
          true,
          false,
          'ignored-only',
          'supported-only'
        ),
        async (explorer, searchView, cliWay, filters) => {
          const explorerClass = makeQueryClass();
          const searchClass = makeQueryClass();
          const searchQuery = new searchClass.Query(null, 'earlier', false);
          searchClass.log.made.length = 0;
          const { cli: workingCli, handler } = makeCli(() =>
            Promise.resolve(JSON.stringify([]))
          );
          const { app } = makeApp({
            explorers:
              explorer === 'works'
                ? [makeExplorerView(explorerClass.Query)]
                : brokenExplorer(explorer),
            searchViews:
              searchView === 'works'
                ? [{ searchQuery }]
                : brokenSearchView(searchView),
            cli: cliWay === 'works' ? workingCli : cliWay,
            filters,
          });

          const search = getVaultSearch(app);
          await search?.run('query', signal());

          const used =
            filters === true && explorer === 'works'
              ? 'explorer'
              : filters === true && searchView === 'works'
                ? 'search view'
                : cliWay === 'works'
                  ? 'cli'
                  : null;
          expect(search === null).toBe(used === null);
          expect(explorerClass.log.made.includes('query')).toBe(
            used === 'explorer'
          );
          expect(searchClass.log.made.includes('query')).toBe(
            used === 'search view'
          );
          expect(handler.mock.calls.length > 0).toBe(used === 'cli');
        }
      )
    );
  });

  it('finds the query class through the first explorer that gives one, as the explorer itself would run', async () => {
    const logged = vi.spyOn(console, 'log');
    const { Query, log } = makeQueryClass();
    const { app } = makeApp({
      explorers: [{}, ...brokenExplorer('no-match'), makeExplorerView(Query)],
    });

    await getVaultSearch(app)?.run('query', signal());

    expect(log.made).toContain('query');
    // Nothing the explorer's filter reads of itself is missing
    expect(logged).not.toHaveBeenCalled();
  });

  it('finds the query class through the first search view that gives one', async () => {
    const { Query, log } = makeQueryClass();
    const { app } = makeApp({
      searchViews: [
        ...brokenSearchView('no-match'),
        { searchQuery: new Query(null, 'earlier', false) },
      ],
    });

    await getVaultSearch(app)?.run('query', signal());

    expect(log.made).toContain('query');
  });

  it('keeps the query class once found, through the explorer gone since', async () => {
    const { Query, log } = makeQueryClass();
    const { app, leaves } = makeApp({ explorers: [makeExplorerView(Query)] });
    expect(getVaultSearch(app)).not.toBeNull();

    leaves['file-explorer'] = [];
    await getVaultSearch(app)?.run('again', signal());

    expect(log.made).toContain('again');
  });
});

describe('getVaultSearch with the query class', () => {
  it('lists the files core would, in vault order: never one excluded or of a type Obsidian does not open, any the query answers for', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await fc.assert(
      fc.asyncProperty(
        fc.array(fileSpecArb, { maxLength: 12 }),
        fc.boolean(),
        async (specs, needsContent) => {
          const { app, files, specOf, log, cachedRead } = makeVault(
            specs,
            needsContent
          );
          const search = getVaultSearch(app, { pause: async () => {} })!;
          log.matched.length = 0;

          const found = await search.run('query', signal());

          const searched = files.filter((file) => {
            const spec = specOf.get(file)!;
            return !spec.ignored && !spec.unsupported;
          });
          expect(found).toEqual(
            searched.filter((file) => specOf.get(file)!.answer !== 'miss')
          );
          expect(log.matched.map(({ file }) => file)).toEqual(searched);
          // Content read only when the query needs it, for notes and canvases
          const read = searched.filter(
            (file) =>
              needsContent &&
              (file.extension === 'md' || file.extension === 'canvas')
          );
          expect(cachedRead.mock.calls.map(([file]) => file)).toEqual(read);
          for (const { file, content } of log.matched) {
            expect(content).toBe(
              read.includes(file) && !specOf.get(file)!.unreadable
                ? `content of ${file.path}`
                : ''
            );
          }
        }
      )
    );
  });

  it('reports each file matched as it is found', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fileSpecArb, { maxLength: 10 }),
        async (specs) => {
          vi.spyOn(console, 'error').mockImplementation(() => {});
          const { app } = makeVault(specs, false);
          const progress: number[] = [];

          const found = await getVaultSearch(app)!.run('query', signal(), (n) =>
            progress.push(n)
          );

          expect(progress).toEqual(found.map((_, at) => at + 1));
        }
      )
    );
  });

  it("rethrows the engine's own error for a query it can't parse, reading nothing", async () => {
    const { app, cachedRead, log, errors } = makeVault([PLAIN], true);
    const search = getVaultSearch(app)!;

    const failure = search.run('x:y', signal());

    await expect(failure).rejects.toBe(errors[0]);
    expect(log.matched).toEqual([]);
    expect(cachedRead).not.toHaveBeenCalled();
  });

  it('lists nothing for a query that parses to nothing, reading nothing', async () => {
    const { app, cachedRead, log } = makeVault([PLAIN], true);

    await expect(getVaultSearch(app)!.run('  ', signal())).resolves.toEqual([]);
    expect(log.matched).toEqual([]);
    expect(cachedRead).not.toHaveBeenCalled();
  });

  it("stops once aborted as a file matches, rejecting with the signal's reason and matching nothing more", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 6 }),
        async (count, at) => {
          const specs: FileSpec[] = Array.from({ length: count }, () => ({
            ...PLAIN,
            extension: 'png',
          }));
          const { app, log } = makeVault(specs, false);
          const search = getVaultSearch(app)!;
          log.matched.length = 0;
          const controller = new AbortController();
          const reason = new Error('stopped');

          const run = search.run('query', controller.signal, (n) => {
            if (n === at) controller.abort(reason);
          });

          if (at < count) {
            await expect(run).rejects.toBe(reason);
            expect(log.matched).toHaveLength(at);
          } else {
            // Nothing was left to search
            await expect(run).resolves.toHaveLength(count);
          }
        }
      )
    );
  });

  it("matches nothing more once aborted while a file's content is read", async () => {
    const { app, log, cachedRead } = makeVault([PLAIN, PLAIN], true);
    const search = getVaultSearch(app)!;
    log.matched.length = 0;
    const controller = new AbortController();
    cachedRead.mockImplementation(async () => {
      controller.abort();
      return 'text';
    });

    await expect(search.run('query', controller.signal)).rejects.toBe(
      controller.signal.reason
    );
    expect(log.matched).toEqual([]);
  });

  it('rejects at once for a signal already aborted', async () => {
    const { app, log, cachedRead } = makeVault([PLAIN], true);
    const search = getVaultSearch(app)!;
    log.matched.length = 0;
    const controller = new AbortController();
    controller.abort();

    await expect(search.run('query', controller.signal)).rejects.toBe(
      controller.signal.reason
    );
    expect(log.matched).toEqual([]);
    expect(cachedRead).not.toHaveBeenCalled();
  });

  it('hands the thread back only once a slice is spent, and starts no file after that without doing so', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 20 }),
        fc.integer({ min: 1, max: 10 }),
        async (costs, sliceMs) => {
          let clock = 0;
          const { app, files, isUserIgnored } = makeVault(
            costs.map(() => ({ ...PLAIN, extension: 'png' })),
            false
          );
          const timeline: { pause: boolean; at: number }[] = [];
          const search = getVaultSearch(app, {
            pause: async () => {
              timeline.push({ pause: true, at: clock });
            },
            now: () => clock,
            sliceMs,
          })!;
          // Each file takes its cost to search
          isUserIgnored.mockImplementation((path) => {
            timeline.push({ pause: false, at: clock });
            clock += costs[files.findIndex((file) => file.path === path)];
            return false;
          });

          await search.run('query', signal());

          let sliceStart = 0;
          for (const { pause, at } of timeline) {
            if (pause) {
              expect(at - sliceStart).toBeGreaterThanOrEqual(sliceMs);
              sliceStart = at;
            } else {
              expect(at - sliceStart).toBeLessThan(sliceMs);
            }
          }
          expect(timeline.filter(({ pause }) => !pause)).toHaveLength(
            costs.length
          );
        }
      )
    );
  });

  it('paces itself on the default slice', async () => {
    let clock = 0;
    const { app, isUserIgnored } = makeVault([PLAIN, PLAIN], false);
    const pause = vi.fn(async () => {});
    isUserIgnored.mockImplementation(() => {
      clock += BATCHED_MUTATION_SLICE_MS;
      return false;
    });

    await getVaultSearch(app, { pause, now: () => clock })!.run(
      'query',
      signal()
    );

    expect(pause).toHaveBeenCalledOnce();
  });

  it('searches a file that cannot be read as empty, saying why', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app, log, files } = makeVault(
      [{ ...PLAIN, unreadable: true }],
      true
    );
    const search = getVaultSearch(app)!;
    log.matched.length = 0;

    await expect(search.run('query', signal())).resolves.toEqual(files);
    expect(log.matched).toEqual([{ file: files[0], content: '' }]);
    expect(error).toHaveBeenCalledOnce();
  });

  it('makes every query as core does: for the app, the text as typed, case aside', async () => {
    const { Query, log } = makeQueryClass();
    const { app } = makeApp({ explorers: [makeExplorerView(Query)] });

    await getVaultSearch(app)!.run('Some Text', signal());

    expect(log.made.at(-1)).toBe('Some Text');
    expect(log.args).toEqual(
      log.made.map(() => ({ app, caseSensitive: false }))
    );
  });
});

describe('getVaultSearch with the CLI', () => {
  const pathsArb = fc.uniqueArray(
    fc.constantFrom('a.md', 'b/c.md', 'gone.md', 'd.md'),
    { maxLength: 4 }
  );

  it('lists the files at the paths it answers, in its order, leaving out any not in the vault, and asks for JSON', async () => {
    await fc.assert(
      fc.asyncProperty(pathsArb, async (paths) => {
        const files = ['a.md', 'b/c.md', 'd.md'].map((path) =>
          Object.assign(new TFile(), { path, extension: 'md' })
        );
        const { cli, handler } = makeCli(() =>
          Promise.resolve(JSON.stringify(paths))
        );
        const { app } = makeApp({ cli, files, filters: false });
        const progress = vi.fn();

        const found = await getVaultSearch(app)!.run(
          'query',
          signal(),
          progress
        );

        const wanted = paths.flatMap(
          (path) => files.find((file) => file.path === path) ?? []
        );
        expect(found).toEqual(wanted);
        expect(handler).toHaveBeenCalledExactlyOnceWith({
          query: 'query',
          format: 'json',
        });
        expect(progress).toHaveBeenCalledExactlyOnceWith(wanted.length);
      })
    );
  });

  it('lists nothing when it says nothing matched', async () => {
    const { cli } = makeCli(() => Promise.resolve('No matches found.'));
    const { app } = makeApp({ cli, filters: false });

    await expect(getVaultSearch(app)!.run('query', signal())).resolves.toEqual(
      []
    );
  });

  it('rejects with what it says for a query it refuses, as an error', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constant<unknown>('Invalid search query.'),
          fc.constant<unknown>(new Error('Operator "x" not recognized'))
        ),
        async (thrown) => {
          const { cli } = makeCli(async () => {
            throw thrown;
          });
          const { app } = makeApp({ cli, filters: false });

          const failure = getVaultSearch(app)!.run('x:', signal());

          await expect(failure).rejects.toBeInstanceOf(Error);
          await expect(failure).rejects.toThrow(
            thrown instanceof Error ? thrown.message : String(thrown)
          );
          if (thrown instanceof Error)
            await expect(failure).rejects.toBe(thrown);
        }
      )
    );
  });

  it('rejects for an answer that is not a list of paths', async () => {
    const { cli } = makeCli(() => Promise.resolve('{"total":1}'));
    const { app } = makeApp({ cli, filters: false });

    await expect(getVaultSearch(app)!.run('query', signal())).rejects.toThrow(
      /total/
    );
  });

  it('takes an answer already parsed', async () => {
    const files = [Object.assign(new TFile(), { path: 'a.md' })];
    const { cli } = makeCli(() => Promise.resolve(['a.md', 3]));
    const { app } = makeApp({ cli, files, filters: false });

    await expect(getVaultSearch(app)!.run('query', signal())).resolves.toEqual(
      files
    );
  });

  it('rejects with the reason once aborted while it searched', async () => {
    const controller = new AbortController();
    const { cli } = makeCli(() => {
      controller.abort();
      return Promise.resolve('["a.md"]');
    });
    const { app } = makeApp({ cli, filters: false });
    const progress = vi.fn();

    await expect(
      getVaultSearch(app)!.run('query', controller.signal, progress)
    ).rejects.toBe(controller.signal.reason);
    expect(progress).not.toHaveBeenCalled();
  });
});

describe('loadSearchEngine', () => {
  it('loads each deferred explorer, which then gives the query class', async () => {
    const { Query, log } = makeQueryClass();
    const loaded = makeExplorerView(Query);
    const shown = { view: {}, isDeferred: false, loadIfDeferred: vi.fn() };
    const deferred = {
      view: {},
      isDeferred: true,
      loadIfDeferred: vi.fn(async () => {
        deferred.view = loaded;
        deferred.isDeferred = false;
      }),
    };
    const { app, leaves } = makeApp();
    leaves['file-explorer'] = [shown, deferred];
    expect(getVaultSearch(app)).toBeNull();

    await expect(loadSearchEngine(app)).resolves.toBe(true);
    await getVaultSearch(app)?.run('query', signal());

    expect(deferred.loadIfDeferred).toHaveBeenCalledOnce();
    expect(shown.loadIfDeferred).not.toHaveBeenCalled();
    expect(log.made).toContain('query');
  });

  it('loads nothing with no deferred explorer, or once the query class is found', async () => {
    const { Query } = makeQueryClass();
    const deferred = { view: {}, isDeferred: true, loadIfDeferred: vi.fn() };
    const { app, leaves } = makeApp({ explorers: [makeExplorerView(Query)] });
    await expect(loadSearchEngine(app)).resolves.toBe(false);

    getVaultSearch(app);
    leaves['file-explorer'] = [deferred];

    await expect(loadSearchEngine(app)).resolves.toBe(false);
    expect(deferred.loadIfDeferred).not.toHaveBeenCalled();
  });
});
