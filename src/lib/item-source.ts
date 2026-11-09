import { heldClaim } from '#/lib/items/note-holding';
import type { App, TFile } from 'obsidian';
import { findNoteSource, type NoteSource } from './item-context';
import { ObsidianHelpers as Obsidian } from './ObsidianHelpers';
import type { NoteType, SQLiteRepository } from './types';
import { linkWebViewer, type WebViewerPlugin } from './web-viewer';

/**
 * Where Go to source and Go to context find what they open. Asked while a
 * menu is built, which can't wait, so everything here is synchronous: the
 * database is read as sql.js answers it, at once, as
 * `ReviewManager.articleIdAt` reads it for the same reason.
 */

/** An item's row, as much of it as finding its source takes. */
export type ItemNode = {
  id: string;
  type: NoteType;
  reference: string;
  parent: string | null;
};

const ITEM_TABLES = [
  { table: 'article', type: 'article', parent: 'NULL' },
  { table: 'snippet', type: 'snippet', parent: 'parent' },
  { table: 'srs_card', type: 'card', parent: 'parent' },
] as const;

/** The live item rows `where` picks, from every item table. */
function itemNodes(
  repo: SQLiteRepository,
  where: string,
  params: string[]
): ItemNode[] {
  const sql = ITEM_TABLES.map(
    ({ table, type, parent }) =>
      `SELECT id, '${type}' AS type, reference, ${parent} AS parent ` +
      `FROM ${table} WHERE ${where} AND deleted = FALSE`
  ).join(' UNION ALL ');
  const rows = repo.query(sql, params);
  // A repository that can't answer at once answers nothing here
  return Array.isArray(rows) ? (rows as unknown as ItemNode[]) : [];
}

/**
 * The item whose note `file` is, or null, as the menus tell which article a
 * file is (`ReviewManager.articleIdAt`), so a note offered an import is
 * offered no Go to source or Go to context of the row at its path: a note
 * holds the row at its path only by claiming its id, a file with no
 * frontmatter, a PDF say, by being there (see `heldClaim`). A note claiming
 * no id holds nothing, even at a live item's path.
 */
export function itemNodeAt(
  repo: SQLiteRepository,
  app: App,
  file: TFile
): ItemNode | null {
  const id = heldClaim(file, app);
  if (id === null) return null;
  if (id === undefined) {
    return itemNodes(repo, 'reference = $1', [file.path])[0] ?? null;
  }
  return (
    itemNodes(repo, 'reference = $1 AND id = $2', [file.path, id])[0] ?? null
  );
}

/** The live item with id `id`, or null. */
export function itemNodeById(
  repo: SQLiteRepository,
  id: string
): ItemNode | null {
  return itemNodes(repo, 'id = $1', [id])[0] ?? null;
}

/**
 * The item at the top of `start`'s line of parents: an article, or an item
 * taken from a note that is no item. Null when the line breaks before it — a
 * parent whose row is gone — or runs in a circle.
 */
export function findRoot(
  start: ItemNode,
  byId: (id: string) => ItemNode | null
): ItemNode | null {
  const seen = new Set([start.id]);
  let node = start;
  while (node.parent !== null) {
    if (seen.has(node.parent)) return null;
    const parent = byId(node.parent);
    if (!parent) return null;
    seen.add(parent.id);
    node = parent;
  }
  return node;
}

/**
 * Where the item at `file` came from at first: what the `source` property of
 * the note at the top of its line of parents names (see {@link findRoot}) —
 * an article's own, for an article. Null for a note that is no item, or an
 * item with no source to open.
 */
export function findItemSource(
  repo: SQLiteRepository,
  app: App,
  file: TFile
): NoteSource | null {
  const node = itemNodeAt(repo, app, file);
  if (!node) return null;
  const root = findRoot(node, (id) => itemNodeById(repo, id));
  if (!root) return null;
  const rootFile = app.vault.getFileByPath(root.reference);
  return rootFile ? findNoteSource(app, rootFile) : null;
}

/**
 * Whether the item at `file` has a context for Go to context to open, as
 * `findContextFile` finds it: it is a snippet or card whose parent's row and
 * note are there, or whose `source` property links to a note in the vault —
 * one taken from a note that is no item, say.
 */
export function hasContext(
  repo: SQLiteRepository,
  app: App,
  file: TFile
): boolean {
  const node = itemNodeAt(repo, app, file);
  if (!node || node.type === 'article') return false;
  const parent = node.parent === null ? null : itemNodeById(repo, node.parent);
  return (
    (parent !== null && app.vault.getFileByPath(parent.reference) !== null) ||
    Obsidian.getSourceFile(file, app) !== null
  );
}

/**
 * How Go to source opens a source: a vault file as following a link to it
 * would; a web page in the web viewer when it is the one to open links (see
 * {@link linkWebViewer}), else in the system's browser.
 */
export type SourceRoute =
  | { kind: 'file'; file: TFile }
  | { kind: 'web-viewer'; url: string; viewer: WebViewerPlugin }
  | { kind: 'browser'; url: string };

export function routeSource(app: App, source: NoteSource): SourceRoute {
  if ('file' in source) return { kind: 'file', file: source.file };
  const viewer = linkWebViewer(app);
  return viewer
    ? { kind: 'web-viewer', url: source.url, viewer }
    : { kind: 'browser', url: source.url };
}

/**
 * Go to source's entry, saying so when it takes the user out of the app.
 */
export function goToSourceTitle(route: SourceRoute): string {
  return route.kind === 'browser'
    ? 'Go to source in system browser'
    : 'Go to source';
}
