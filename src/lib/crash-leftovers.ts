import type { ArticleManager } from '#/lib/items/ArticleManager';
import type { CardManager } from '#/lib/items/CardManager';
import { NOT_PURGED } from '#/lib/items/row-delete';
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
import { hasTag, tagEntries, withTag } from './item-tags';
import { ObsidianHelpers as Obsidian } from './ObsidianHelpers';
import type { NoteType, SQLiteRepository } from './types';

/**
 * Crash leftovers: notes holding an `ir-id` that no row holds, tagged with an
 * item type or not. Making an item writes its note before its row, the row being
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
  /**
   * The item type the note was made as: the one its tag names; else, for a
   * note the plugin made (`kind: 'made'`), the one whose folder in the data
   * folder it is in (see `Obsidian.getDirectory`); else unknown (`null`), and
   * the note can be kept as an item only as a type the user chooses (see
   * `resolveLeftover`'s `as`).
   */
  type: NoteType | null;
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

/**
 * The `ir-id` the cache has for `file`, if any, and the item type its tags
 * name, if they name one.
 */
function claimOf(
  app: Pick<App, 'metadataCache'>,
  file: TFile
): { id: string; type: NoteType | null } | null {
  const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
  const id: unknown = frontmatter?.['ir-id'];
  const type = Obsidian.typeOfTags(frontmatter?.tags);
  return typeof id === 'string' ? { id, type } : null;
}

const NOTE_TYPES: readonly NoteType[] = ['article', 'snippet', 'card'];

/** The type of item the plugin makes in the folder `path` is in, if any. */
function typeOfFolder(path: string): NoteType | null {
  return (
    NOTE_TYPES.find((type) =>
      path.startsWith(`${Obsidian.getDirectory(type)}/`)
    ) ?? null
  );
}

/** Who made the note at `path` claiming to be of `type`, and what it is. */
function placeOf(
  path: string,
  type: NoteType | null
): Pick<Leftover, 'type' | 'kind'> {
  const made = path.startsWith(`${DATA_DIRECTORY}/`);
  if (type) {
    return { type, kind: type === 'article' && !made ? 'in-place' : 'made' };
  }
  return made
    ? { type: typeOfFolder(path), kind: 'made' }
    : { type: null, kind: 'in-place' };
}

/** What each action does to the note `name`, as the user is told of it. */
const DOING: Readonly<Record<LeftoverAction, (name: string) => string>> = {
  adopt: (name) => `keep ${name} as an item`,
  trash: (name) => `move ${name} to the trash`,
  strip: (name) => `remove the IR properties from ${name}`,
};

/** Whether the database holds any item at all. */
export async function holdsItems(repo: SQLiteRepository): Promise<boolean> {
  for (const table of ITEM_TABLES) {
    const rows = await repo.query(
      `SELECT 1 FROM ${table} WHERE ${NOT_PURGED} LIMIT 1`,
      [],
      {
        throwOnError: true,
      }
    );
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
        `SELECT id FROM ${table} WHERE id IN (${marks}) AND ${NOT_PURGED}`,
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
      ({ file, id, type }): Leftover => ({
        file,
        id,
        ...placeOf(file.path, type),
      })
    );
}

/**
 * What the user may do with `leftover`: give it a row (`adopt`), and, for a
 * note the plugin made, move it to the trash, or, for the user's own note,
 * take the plugin's `ir-id` and type tag off it (`strip`). Whatever its type,
 * known or not: one of no known type is adopted as the type the user chooses.
 * One of no known type the plugin made may also be stripped, to keep it as a
 * plain note.
 */
export function actionsFor(leftover: Leftover): LeftoverAction[] {
  if (leftover.kind !== 'made') return ['adopt', 'strip'];
  return leftover.type ? ['adopt', 'trash'] : ['adopt', 'strip', 'trash'];
}

/** What the user is told of `leftovers`, in one notice. */
export function leftoversMessage(leftovers: readonly Leftover[]): string {
  const count = leftovers.length;
  return count === 1
    ? 'Incremental reading: 1 note was not found in the database.'
    : `Incremental reading: ${count} notes were not found in the database.`;
}

/**
 * Give the note `file` a row as an item of `type` with `id`. The note gets the
 * type's tag first, in place of any other item type's: one typed by its folder
 * alone, or of no type, has none, and without it doesn't read as an item
 * (`ObsidianHelpers.getNoteType`), and one the user chose to keep as another
 * type than its tag names (a card kept as a snippet, say) would read as the old
 * type. The row comes last, as it commits the adoption, and a note left tagged
 * by a failed one is still a leftover.
 */
async function adopt(
  deps: LeftoverDeps,
  file: TFile,
  id: string,
  type: NoteType
): Promise<void> {
  const tag = TAG_OF[type];
  const others: unknown[] = Object.values(TAG_OF).filter((t) => t !== tag);
  const isOther = (entry: unknown) => others.includes(entry);
  const tags: unknown =
    deps.app.metadataCache.getFileCache(file)?.frontmatter?.tags;
  if (!hasTag(tags, tag) || tagEntries(tags).some(isOther)) {
    await Obsidian.updateFrontMatter(
      file,
      (frontmatter) => {
        const entries = tagEntries(frontmatter.tags);
        const kept = entries.filter((entry) => !isOther(entry));
        frontmatter.tags = withTag(
          kept.length < entries.length ? kept : frontmatter.tags,
          tag
        );
      },
      deps.app as App
    );
  }
  if (type === 'article') await deps.articles.adoptLeftover(file, id);
  else if (type === 'snippet') await deps.snippets.adoptLeftover(file, id);
  else await deps.cards.adoptLeftover(file, id);
}

/**
 * Do `action` to `leftover`, unless it is no leftover any more: its note gone,
 * changed to hold another id, or given a row meanwhile, by Sync bringing the
 * database, say. Says so when it fails, or when writes are refused.
 * @param as for `adopt`, the type to keep it as, the user's choice: by
 *   default the one it was made as; with neither, it isn't adopted
 * @returns whether it was done
 */
export async function resolveLeftover(
  deps: LeftoverDeps,
  leftover: Leftover,
  action: LeftoverAction,
  as: NoteType | null = leftover.type
): Promise<boolean> {
  const { app, repo } = deps;
  const { file, id, type } = leftover;
  // A note of no known type is adopted only as a type the user chose
  if (action === 'adopt' && !as) return false;
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
          // A note typed by its folder alone has no type tag to take off,
          // and its tags are left as they are
          const typeTag = type && TAG_OF[type];
          const tags = tagEntries(frontmatter.tags);
          if (!typeTag || !tags.includes(typeTag)) return;
          const kept = tags.filter((tag) => tag !== typeTag);
          if (kept.length > 0) frontmatter.tags = kept;
          else delete frontmatter.tags;
        },
        app as App
      );
    } else if (as) {
      await adopt(deps, file, id, as);
    }
    return true;
  } catch (error) {
    console.error(error);
    Obsidian.notify(`Couldn't ${what}`, { kind: 'error' });
    return false;
  }
}
