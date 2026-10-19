import { BATCHED_MUTATION_SLICE_MS } from '#/lib/constants';
import { yieldToHost } from '#/lib/pacing';
import type { App, TFile } from 'obsidian';

/**
 * Obsidian's own query engine, the one behind "Search in all files": the same
 * operators (`path:`, `tag:`, `[prop]`, `"quoted"`, `/regex/`, `-neg`, `OR`,
 * ...) and the same files listed for a query.
 */
export interface VaultSearch {
  /**
   * The files `query` matches now, in vault order. Rejects with Obsidian's
   * own message for a query it can't parse (`Operator "x" not recognized`),
   * and with `signal`'s reason once it aborts. `onProgress` hears how many
   * files have matched so far, each time that grows.
   */
  run(
    query: string,
    signal: AbortSignal,
    onProgress?: (matched: number) => void
  ): Promise<TFile[]>;
}

/**
 * Core's search query, as far as this reads it. Undocumented: Obsidian exports
 * no search API. Read from Obsidian 1.13.7, where the class parses `query` as
 * it is made (throwing on a query it can't parse) and `match` answers `null`
 * for a file that doesn't match, and an object, empty or not, for one that
 * does.
 */
interface SearchQuery {
  /** What the query parsed to; none for a query of nothing but spaces. */
  matcher: unknown;
  /** What `match` needs handed to it besides the file: its content or not. */
  requiredInputs?: { content?: unknown } | null;
  match(file: TFile, content: string): unknown;
}

type SearchQueryConstructor = new (
  app: App,
  query: string,
  caseSensitive: boolean
) => SearchQuery;

/**
 * The metadata cache's own checks that core's search runs on each file.
 * Undocumented (Obsidian 1.13.7).
 */
interface SearchFilters {
  /** Whether the "Excluded files" setting hides `path`. */
  isUserIgnored(path: string): boolean;
  /** Whether a view opens `file`'s type, or every type is shown. */
  isSupportedFile(file: TFile): boolean;
}

/**
 * A CLI command's handler, as `app.cli.handlers` holds it. Undocumented
 * (Obsidian 1.13.7). Core's `search` answers a JSON array of the paths of the
 * Markdown files matching, or `No matches found.`, and throws
 * `Invalid search query.` for a query that parses to nothing.
 */
interface CliHandler {
  handler(params: Record<string, string>): Promise<unknown>;
}

/** What core's `search` command answers when nothing matches. */
const CLI_NO_MATCHES = 'No matches found.';

/**
 * A query any build of the engine parses to something, which the probes make
 * an instance from: one word, matching names and content.
 */
const PROBE_QUERY = 'a';

/** How the search loop is paced; replaced by tests. */
export interface SearchPacing {
  /** Hands the thread back between slices. */
  pause?: () => Promise<void>;
  /** The clock a slice is measured on. */
  now?: () => number;
  /** How long the loop runs before handing the thread back. */
  sliceMs?: number;
}

/** The query class each app was found to have, once found. */
const found = new WeakMap<App, SearchQueryConstructor>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Whether `value` reads as a {@link SearchQuery}. */
const isSearchQuery = (value: unknown): value is SearchQuery =>
  isRecord(value) && 'matcher' in value && typeof value.match === 'function';

/**
 * The class that made `instance`, if `instance` is a search query and the
 * class makes another for `app` that is one too.
 */
function queryClassOf(
  app: App,
  instance: unknown
): SearchQueryConstructor | null {
  if (!isSearchQuery(instance)) return null;
  const ctor = instance.constructor as SearchQueryConstructor;
  try {
    // Throws too for a `constructor` that is no class
    return isSearchQuery(new ctor(app, PROBE_QUERY, false)) ? ctor : null;
  } catch {
    return null;
  }
}

/**
 * Strategy 1: the file explorer's filter makes a search query as it filters
 * (1.13+), and leaves it in `this.searchQuery`; run on a stand-in `this`, it
 * leaves it there instead. Undocumented (read from Obsidian 1.13.7:
 * `onSearchChanged(query)` makes `new SearchQuery(this.app, query, false)` and
 * keeps it when it has a `matcher`, then calls `this.filterSearchResults()`,
 * all inside a try that logs what it catches). A deferred explorer has no such
 * method until {@link loadSearchEngine} loads it.
 */
function fromExplorer(app: App): SearchQueryConstructor | null {
  for (const leaf of app.workspace.getLeavesOfType('file-explorer')) {
    const view = leaf.view as unknown as {
      onSearchChanged(this: unknown, query: string): void;
    };
    // What the method reads of `this`; it filters nothing
    const stub: Record<string, unknown> = {
      app,
      searchQuery: null,
      filterSearchResults() {},
    };
    try {
      // Throws too where the view has no such method
      view.onSearchChanged.call(stub, PROBE_QUERY);
    } catch {
      // Whatever it left is still checked
    }
    const ctor = queryClassOf(app, stub.searchQuery);
    if (ctor) return ctor;
  }
  return null;
}

/**
 * Strategy 2: the core Search view keeps the query it last ran as
 * `searchQuery`. Undocumented (Obsidian 1.13.7); only there once it has run
 * one.
 */
function fromSearchView(app: App): SearchQueryConstructor | null {
  for (const leaf of app.workspace.getLeavesOfType('search')) {
    const view: unknown = leaf.view;
    const ctor = isRecord(view) ? queryClassOf(app, view.searchQuery) : null;
    if (ctor) return ctor;
  }
  return null;
}

/**
 * Strategy 3: core's `search` CLI command, which searches Markdown files
 * alone. Undocumented (Obsidian 1.13.7: `app.cli.handlers` is a `Map` of
 * command name to `{ handler, description, flags }`).
 */
function cliHandler(app: App): CliHandler | null {
  const cli: unknown = (app as unknown as Record<string, unknown>).cli;
  const handlers = isRecord(cli) ? cli.handlers : undefined;
  if (!(handlers instanceof Map)) return null;
  const entry: unknown = handlers.get('search');
  return isRecord(entry) && typeof entry.handler === 'function'
    ? (entry as unknown as CliHandler)
    : null;
}

/** The metadata cache's search checks, if it has both. */
function searchFilters(app: App): SearchFilters | null {
  const cache: unknown = app.metadataCache;
  return isRecord(cache) &&
    typeof cache.isUserIgnored === 'function' &&
    typeof cache.isSupportedFile === 'function'
    ? (cache as unknown as SearchFilters)
    : null;
}

/** `error` as an `Error`, its message what the engine said. */
const asError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error));

/**
 * The search core's Search view runs, over `vault.getFiles()` in vault order:
 * a file the "Excluded files" setting hides, or of a type Obsidian doesn't
 * open, is skipped; a note's or canvas's content is read only when the query
 * needs it; a file matches when the query's `match` answers anything at all.
 * Hands the thread back each `sliceMs`, and stops between files once `signal`
 * aborts.
 */
function queryEngine(
  app: App,
  Query: SearchQueryConstructor,
  filters: SearchFilters,
  {
    pause = yieldToHost,
    now = () => performance.now(),
    sliceMs = BATCHED_MUTATION_SLICE_MS,
  }: SearchPacing
): VaultSearch {
  return {
    async run(query, signal, onProgress) {
      // Throws, with the engine's own words, on a query it can't parse
      const search = new Query(app, query, false);
      if (!search.matcher) return [];
      const needsContent = Boolean(search.requiredInputs?.content);
      const matched: TFile[] = [];
      let until = now() + sliceMs;
      for (const file of app.vault.getFiles()) {
        if (now() >= until) {
          await pause();
          until = now() + sliceMs;
        }
        if (signal.aborted) throw signal.reason;
        if (filters.isUserIgnored(file.path)) continue;
        if (!filters.isSupportedFile(file)) continue;
        let content = '';
        // As core: only these hold text the query reads
        if (
          needsContent &&
          (file.extension === 'md' || file.extension === 'canvas')
        ) {
          try {
            content = await app.vault.cachedRead(file);
          } catch (error) {
            // As core: a file that can't be read is searched as empty
            console.error(error);
          }
          if (signal.aborted) throw signal.reason;
        }
        if (search.match(file, content)) {
          matched.push(file);
          onProgress?.(matched.length);
        }
      }
      return matched;
    },
  };
}

/** The search core's `search` command runs, for Markdown files alone. */
function cliEngine(app: App, cli: CliHandler): VaultSearch {
  return {
    async run(query, signal, onProgress) {
      let answer: unknown;
      try {
        answer = await cli.handler({ query, format: 'json' });
      } catch (error) {
        // It throws a bare string for a query that parses to nothing
        throw asError(error);
      }
      if (signal.aborted) throw signal.reason;
      if (answer === CLI_NO_MATCHES) return [];
      const paths: unknown =
        typeof answer === 'string' ? JSON.parse(answer) : answer;
      if (!Array.isArray(paths)) {
        throw new Error(`Unexpected search answer: ${String(answer)}`);
      }
      const matched = paths.flatMap((path: unknown) => {
        const file =
          typeof path === 'string' ? app.vault.getFileByPath(path) : null;
        return file ? [file] : [];
      });
      onProgress?.(matched.length);
      return matched;
    },
  };
}

/**
 * Obsidian's own search engine, reached however this build of Obsidian lets
 * it be, or `null` when no way works. Obsidian exports no search API, so each
 * way is tried in turn, each checked for the shape it was read with:
 * 1. the query class, from the file explorer's filter;
 * 2. the query class, from the core Search view's last query;
 * 3. core's `search` CLI command, which lists Markdown files alone.
 *
 * The query class, once found, is kept for the app's life.
 */
export function getVaultSearch(
  app: App,
  pacing: SearchPacing = {}
): VaultSearch | null {
  const filters = searchFilters(app);
  if (filters) {
    const Query = found.get(app) ?? fromExplorer(app) ?? fromSearchView(app);
    if (Query) {
      found.set(app, Query);
      return queryEngine(app, Query, filters, pacing);
    }
  }
  const cli = cliHandler(app);
  return cli ? cliEngine(app, cli) : null;
}

/**
 * Loads each file explorer that is still deferred, as one in a sidebar tab
 * not yet shown is, so {@link getVaultSearch} can find the query class
 * through it. Whether it loaded any.
 */
export async function loadSearchEngine(app: App): Promise<boolean> {
  if (found.has(app)) return false;
  let loaded = false;
  for (const leaf of app.workspace.getLeavesOfType('file-explorer')) {
    // `isDeferred` and `loadIfDeferred` are public API (1.7.2)
    if (!leaf.isDeferred) continue;
    await leaf.loadIfDeferred();
    loaded = true;
  }
  return loaded;
}
