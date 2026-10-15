import type { ArticleManager } from '#/lib/items/ArticleManager';
import type { CardManager } from '#/lib/items/CardManager';
import type { SnippetManager } from '#/lib/items/SnippetManager';
import type { App, TFile } from 'obsidian';
import { refusedWrite } from './compensation';
import {
  ARTICLE_TAG,
  CARD_TAG,
  DATA_DIRECTORY,
  MAX_SQL_QUERY_PARAMS,
  SNIPPET_TAG,
} from './constants';
import { tagEntries } from './item-tags';
import { ObsidianHelpers as Obsidian } from './ObsidianHelpers';
import type { NoteType, SQLiteRepository } from './types';

/**
 * Crash leftovers: notes holding an `ir-id`, and the tag of an item type, that
 * no row holds. Making an item writes its note before its row, the row being
 * the commit point (see `withCompensation`), and a failure between the two is
 * undone; but a crash or a kill between them skips the undo, and leaves the
 * note. Nothing else reads such a note as an item — the moved-note scan looks
 * only for the ids of rows, and the `ir-id` repair passes them over — so they
 * are found here, and the user is asked what to do with each. Nothing is done
 * to one without asking: a note the plugin made may have been written in
 * since, and one imported in place is the user's own.
 */

/**
 * Who made a leftover's note: the plugin (`made`), which put it in its data
 * folder, as it does every snippet, card and copied article; or the user
 * (`in-place`), whose note outside that folder was being imported where it
 * is. Told apart by where the note is, as nothing else is written to tell
 * them apart. An empty article made in the current folder reads as
 * `in-place` too, which only offers to strip it rather than trash it.
 */
export type LeftoverKind = 'made' | 'in-place';

export interface Leftover {
  file: TFile;
  id: string;
  type: NoteType;
  kind: LeftoverKind;
}

/** What can be done with a leftover: see {@link actionsFor}. */
export type LeftoverAction = 'adopt' | 'trash' | 'strip';

/** What is needed to find leftovers and resolve them. */
export interface LeftoverDeps {
  app: Pick<App, 'vault' | 'metadataCache' | 'fileManager'>;
  repo: SQLiteRepository;
  articles: Pick<ArticleManager, 'adoptLeftover'>;
  snippets: Pick<SnippetManager, 'adoptLeftover'>;
  cards: Pick<CardManager, 'adoptLeftover'>;
}

const ITEM_TABLES = ['article', 'snippet', 'srs_card'] as const;
const TAG_OF: Readonly<Record<NoteType, string>> = {
  article: ARTICLE_TAG,
  snippet: SNIPPET_TAG,
  card: CARD_TAG,
};

/** The `ir-id` and item type the cache has for `file`, if it has both. */
function claimOf(
  app: Pick<App, 'metadataCache'>,
  file: TFile
): { id: string; type: NoteType } | null {
  const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
  const id: unknown = frontmatter?.['ir-id'];
  const type = Obsidian.typeOfTags(frontmatter?.tags);
  return typeof id === 'string' && type ? { id, type } : null;
}

/** What each action does to the note `name`, as the user is told of it. */
const DOING: Readonly<Record<LeftoverAction, (name: string) => string>> = {
  adopt: (name) => `keep ${name} as an item`,
  trash: (name) => `move ${name} to the trash`,
  strip: (name) => `remove the item properties from ${name}`,
};

/** Whether the database holds any item at all. */
export async function holdsItems(repo: SQLiteRepository): Promise<boolean> {
  for (const table of ITEM_TABLES) {
    const rows = await repo.query(`SELECT 1 FROM ${table} LIMIT 1`, [], {
      throwOnError: true,
    });
    if (rows.length > 0) return true;
  }
  return false;
}

/** Of `ids`, those some row holds, deleted or not. */
async function heldIds(
  repo: SQLiteRepository,
  ids: readonly string[]
): Promise<Set<string>> {
  const held = new Set<string>();
  for (let i = 0; i < ids.length; i += MAX_SQL_QUERY_PARAMS) {
    const batch = ids.slice(i, i + MAX_SQL_QUERY_PARAMS);
    const marks = batch.map((_, j) => `$${j + 1}`).join(', ');
    for (const table of ITEM_TABLES) {
      const rows = (await repo.query(
        `SELECT id FROM ${table} WHERE id IN (${marks})`,
        [...batch],
        { throwOnError: true }
      )) as unknown as { id: string }[];
      for (const { id } of rows) held.add(id);
    }
  }
  return held;
}

/**
 * Every leftover in the vault, by the metadata cache: to be read once it has
 * settled, and once the moved-note scan has pointed every row it could at its
 * note.
 * @throws if the item tables cannot be read
 */
export async function findLeftovers(
  deps: Pick<LeftoverDeps, 'app' | 'repo'>
): Promise<Leftover[]> {
  const { app, repo } = deps;
  const claims = app.vault.getMarkdownFiles().flatMap((file) => {
    const claim = claimOf(app, file);
    return claim ? [{ file, ...claim }] : [];
  });
  const held = await heldIds(
    repo,
    claims.map(({ id }) => id)
  );
  return claims
    .filter(({ id }) => !held.has(id))
    .map(
      (claim): Leftover => ({
        ...claim,
        kind:
          claim.type === 'article' &&
          !claim.file.path.startsWith(`${DATA_DIRECTORY}/`)
            ? 'in-place'
            : 'made',
      })
    );
}

/**
 * What the user may do with `leftover`: give it a row (`adopt`), and, for a
 * note the plugin made, move it to the trash, or, for the user's own note,
 * take the plugin's `ir-id` and type tag off it (`strip`).
 */
export function actionsFor(leftover: Leftover): LeftoverAction[] {
  return leftover.kind === 'made' ? ['adopt', 'trash'] : ['adopt', 'strip'];
}

/** What the user is told of `leftovers`, in one notice. */
export function leftoversMessage(leftovers: readonly Leftover[]): string {
  const one = leftovers.length === 1;
  const names = leftovers.map(({ file }) => `"${file.basename}"`).join(', ');
  return (
    `Incremental reading: ${leftovers.length} ${one ? 'note has' : 'notes have'} ` +
    `an item id but no review data, likely left by an action that was cut ` +
    `short: ${names}. Click to choose what to do with ${one ? 'it' : 'them'}.`
  );
}

/**
 * Do `action` to `leftover`, unless it is no leftover any more: its note gone,
 * changed to hold another id, or given a row meanwhile, by Sync bringing the
 * database, say. Says so when it fails, or when writes are refused.
 * @returns whether it was done
 */
export async function resolveLeftover(
  deps: LeftoverDeps,
  leftover: Leftover,
  action: LeftoverAction
): Promise<boolean> {
  const { app, repo } = deps;
  const { file, id, type } = leftover;
  const what = DOING[action](`"${file.basename}"`);
  if (refusedWrite(repo, what)) return false;
  try {
    const claim =
      app.vault.getFileByPath(file.path) === file ? claimOf(app, file) : null;
    if (claim?.id !== id || (await heldIds(repo, [id])).size > 0) return false;
    if (action === 'trash') {
      await app.fileManager.trashFile(file);
    } else if (action === 'strip') {
      await Obsidian.updateFrontMatter(
        file,
        (frontmatter) => {
          delete frontmatter['ir-id'];
          const kept = tagEntries(frontmatter.tags).filter(
            (tag) => tag !== TAG_OF[type]
          );
          if (kept.length > 0) frontmatter.tags = kept;
          else delete frontmatter.tags;
        },
        app as App
      );
    } else if (type === 'article') {
      await deps.articles.adoptLeftover(file, id);
    } else if (type === 'snippet') {
      await deps.snippets.adoptLeftover(file, id);
    } else {
      await deps.cards.adoptLeftover(file, id);
    }
    return true;
  } catch (error) {
    console.error(error);
    Obsidian.notify(`Couldn't ${what}`);
    return false;
  }
}
