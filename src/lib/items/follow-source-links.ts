import { MAX_SQL_QUERY_PARAMS, SOURCE_PROPERTY_NAME } from '#/lib/constants';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { linkNamesPath, parseSourceLink } from '#/lib/source-link';
import type { TFile } from 'obsidian';
import type { ItemManager } from './ItemManager';

/**
 * The file `file` that moved from `from`, and the id of its row when it is an
 * item. Obsidian keeps a file's object across renames, so `file.path` is
 * where it is by the time its move is followed, however often it has moved.
 */
export interface FileMove {
  from: string;
  file: TFile;
  id?: string;
}

type Item = { id: string; reference: string; writtenAt?: string };
/** A moved row's snippet or card, whose link names the file it is from. */
type Child = Item & { parent: string };

/**
 * Point the `source` link of every item that `moves` broke at the file it was
 * taken from, where that file is now: Obsidian updates links on a rename only
 * when it is let, and an item's `source` is the record of where it came from.
 *
 * The items are the live parentless snippets and cards, which have nothing
 * but their link to tie them to their file, every live article (a copy links
 * back to its original), and each moved row's own note and live children.
 * A link that resolves is left alone, whether it is right already (Obsidian
 * updated it) or names another file that has the old name (see
 * `linkNamesPath`), except a moved row's child's: its parent id says which
 * file it is from, so one naming its parent's old path follows its parent,
 * though a namesake now takes the link. A broken one that names a moved file's old path follows
 * that file; one broken by its own note's move (a relative link) is pointed at
 * the file it resolved to from where the note was. Everything else costs no
 * write (see {@link ItemManager.retargetSources}).
 *
 * All of `moves` are followed in one pass: a renamed folder is one batch.
 * @returns how many links were rewritten
 */
export async function followSourceLinks(
  manager: ItemManager,
  moves: readonly FileMove[]
): Promise<number> {
  const { app, repo } = manager;
  await Obsidian.settleMetadataCache(app);

  // Each move whose file is still in the vault, at `file.path`: a file that
  // moved again since is followed to where it is now
  const live = moves.filter(
    ({ file }) => app.vault.getFileByPath(file.path) === file
  );

  const items = new Map<string, Item>();
  const take = (rows: readonly Item[]) => {
    for (const row of rows) items.set(row.id, row);
  };
  take(
    (await repo.query(
      `SELECT id, reference FROM snippet WHERE parent IS NULL AND deleted = FALSE
       UNION ALL
       SELECT id, reference FROM srs_card WHERE parent IS NULL AND deleted = FALSE
       UNION ALL
       SELECT id, reference FROM article WHERE deleted = FALSE`
    )) as unknown as Item[]
  );
  // A moved row's own note, and the file each row with children is now
  const parents = new Map<string, TFile>();
  for (const { id, file } of live) {
    if (id === undefined) continue;
    take([{ id, reference: file.path }]);
    parents.set(id, file);
  }
  const ids = [...parents.keys()];
  // Chunked so a folder of very many items cannot blow the parameter limit
  const children = new Map<string, TFile>();
  for (let i = 0; i < ids.length; i += MAX_SQL_QUERY_PARAMS) {
    const chunk = ids.slice(i, i + MAX_SQL_QUERY_PARAMS);
    const placeholders = chunk.map((_, j) => `$${j + 1}`).join(', ');
    const rows = (await repo.query(
      `SELECT id, reference, parent FROM snippet
         WHERE parent IN (${placeholders}) AND deleted = FALSE
       UNION ALL
       SELECT id, reference, parent FROM srs_card
         WHERE parent IN (${placeholders}) AND deleted = FALSE`,
      chunk
    )) as unknown as Child[];
    for (const { id, reference, parent } of rows) {
      take([{ id, reference }]);
      children.set(id, parents.get(parent)!);
    }
  }

  // Where each moved note was first, which a relative link in it is written from
  const movedFrom = new Map<string, string>();
  for (const { from, file } of live) {
    if (!movedFrom.has(file.path)) movedFrom.set(file.path, from);
  }
  const groups = new Map<string, { to: TFile; items: Item[] }>();
  for (const item of items.values()) {
    const note = Obsidian.getNote(item.reference, app);
    if (!note) continue;
    const source = Obsidian.getFrontMatter(note, app)?.[SOURCE_PROPERTY_NAME];
    if (typeof source !== 'string') continue;
    // Resolved as `getSourceFile` resolves it for everything that reads it
    const linkPath = parseSourceLink(source)?.path.trim();
    if (linkPath === undefined) continue;
    const { metadataCache } = app;
    const resolved = metadataCache.getFirstLinkpathDest(linkPath, note.path);
    // A link that resolves is right, or another file's that has the name: but
    // a moved row's child is its parent's by its id, wherever its link resolves
    const parent = children.get(item.id);
    if (resolved && (!parent || resolved === parent)) continue;
    const writtenAt = movedFrom.get(note.path) ?? note.path;
    const names = ({ from }: FileMove) =>
      linkNamesPath(linkPath, writtenAt, from);
    // A child's own parent first, of moved files that share a name. A link
    // that resolves follows only that: it is the child's for its parent's
    // sake, and no other move's; nor is it read from where its note was.
    const parentMove = live.find((move) => move.file === parent && names(move));
    if (resolved && !parentMove) continue;
    const move = parentMove ?? live.find(names);
    const to =
      move?.file ?? metadataCache.getFirstLinkpathDest(linkPath, writtenAt);
    if (!to) continue;
    const from = move?.from ?? to.path;
    const group = groups.get(from) ?? { to, items: [] };
    group.items.push({ ...item, writtenAt });
    groups.set(from, group);
  }

  let rewritten = 0;
  for (const [from, group] of groups) {
    rewritten += await manager.retargetSources(group.items, from, group.to);
  }
  return rewritten;
}
