import { refusedWrite, withCompensation } from '#/lib/compensation';
import {
  MAX_SQL_QUERY_PARAMS,
  SOURCE_INDEX_TIMEOUT_MS,
  SOURCE_PROPERTY_NAME,
} from '#/lib/constants';
import { claimsIdentity } from '#/lib/ir-id-watch';
import IRScheduler from '#/lib/IRScheduler';
import { supportsFrontmatter } from '#/lib/mime';
import type { ItemTable } from '#/lib/moved-note-scan';
import {
  noteFingerprint,
  reconcileAction,
  type IrIdRelation,
} from '#/lib/note-fingerprint';
import { STAMP_COLUMNS } from '#/lib/repository/row-stamps';
import {
  liveInOrder,
  REPLAYED_LOGS,
  type TextRules,
} from '#/lib/repository/scheduling-replay';
import {
  formatSourceLink,
  linkNamesPath,
  parseSourceLink,
  retargetAlias,
} from '#/lib/source-link';
import type {
  ArticleRow,
  IArticleBase,
  ISnippetBase,
  MissingItem,
  MutationStatement,
  NoteType,
  RowTypes,
  SnippetRow,
  SQLiteRepository,
  SRSCardRow,
  TableName,
} from '#/lib/types';
import type { Primitive } from '#/lib/utility-types';
import type IncrementalReadingPlugin from '#/main';
import {
  normalizePath,
  type App,
  type CachedMetadata,
  type TAbstractFile,
  type TFile,
} from 'obsidian';
import { ObsidianHelpers as Obsidian } from '../ObsidianHelpers';
import {
  notedLog,
  planUndo,
  textAfterUndo,
  type AuthoredReview,
  type UndoPlan,
} from './review-undo';
import {
  NOT_PURGED,
  purgedReference,
  REVIEW_LOG_OF,
  tombstoneRowStatements,
} from './row-delete';

/** How deleting an item with its note went: see `deleteWithNote`. */
export type DeleteOutcome = 'deleted' | 'declined' | 'refused' | 'failed';

export class ItemManager {
  plugin: IncrementalReadingPlugin;
  app: App;
  repo: SQLiteRepository;
  /**
   * The ids of the live reviews the item had just before each review made
   * here this session, by the review's id: what the item as it was before the
   * review, which its undo is handed, reflects (see `planUndo`). In memory,
   * as the undo stack is; ids alone, read back from the log at undo time (see
   * `notedLog`), as an item's log can run to hundreds of reviews.
   */
  protected readonly logsBefore = new Map<string, string[]>();

  constructor(plugin: IncrementalReadingPlugin, repo: SQLiteRepository) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.repo = repo;
  }

  async findSnippet(
    snippetFile: Pick<TAbstractFile, 'path'>
  ): Promise<SnippetRow | null> {
    const results = await this.repo.query(
      'SELECT * FROM snippet WHERE reference = $1',
      [normalizePath(snippetFile.path)]
    );

    return (results[0] as SnippetRow) ?? null;
  }

  async findCard(
    cardFile: Pick<TAbstractFile, 'path'>
  ): Promise<SRSCardRow | null> {
    const results = await this.repo.query(
      'SELECT * FROM srs_card WHERE reference = $1',
      [normalizePath(cardFile.path)]
    );

    return (results[0] as SRSCardRow) ?? null;
  }

  async findArticle(
    articleFile: Pick<TAbstractFile, 'path'>
  ): Promise<ArticleRow | null> {
    const results = await this.repo.query(
      'SELECT * FROM article WHERE reference = $1',
      [normalizePath(articleFile.path)]
    );

    return (results[0] as ArticleRow) ?? null;
  }

  async findItem(file: Pick<TAbstractFile, 'path'>): Promise<{
    row: SnippetRow | SRSCardRow | ArticleRow;
    table: Extract<TableName, 'srs_card' | 'snippet' | 'article'>;
  } | null> {
    let row: RowTypes | null = await this.findCard(file);
    if (row) {
      return { row, table: 'srs_card' };
    }

    row = await this.findSnippet(file);
    if (row) {
      return { row, table: 'snippet' };
    }

    row = await this.findArticle(file);
    if (row) {
      return { row, table: 'article' };
    }

    return null;
  }

  /**
   * The type of item `file` is, if any. The note at a row's reference is that
   * row's note iff it carries its id, tag or no tag. So a note carrying no type
   * tag is typed by the live row its `ir-id` names while that row's
   * `reference` is the note's own path. A tagged note is typed by its tag, as
   * `getNoteType` reads it, unless it is a copy: its `ir-id` names a live row
   * whose `reference` is another path, where the row's own note is, claiming
   * the same id. A copy of the note elsewhere, tagged or not, or a tombstone's
   * untagged note, has none. The id comes from the metadata cache, which has
   * long parsed a note that lost its tag.
   *
   * A tagged note claiming no live row, or one whose row's reference holds no
   * note claiming its id, keeps its tag's type: a note just made is written
   * before its row is stored, and a note moved while no rename handler was
   * listening is the row's until `followMovedNotes` points the row at it.
   *
   * A file with no frontmatter, a PDF say, has neither. It is known by its
   * path alone, so it is whatever the row at its path is: none, when that row
   * is deleted.
   */
  async getItemType(file: TFile): Promise<NoteType | null> {
    if (supportsFrontmatter(file)) {
      const tagged = await Obsidian.getNoteType(file, this.app);
      return this.#heldType(
        file,
        this.app.metadataCache.getFileCache(file),
        tagged
      );
    }

    const match = await this.findItem(file);
    if (!match || match.row.deleted) return null;
    return match.table === 'srs_card' ? 'card' : match.table;
  }

  /**
   * {@link getItemType} for note `file`, answered from `cache`, the metadata
   * cache's parse of it, as its `changed` event hands it over (see
   * `ObsidianHelpers.noteTypeFromCache`, which answers for the tags).
   *
   * Answers at once, not with a promise, when the note claims no id, and when
   * the repository answers at once, as sql.js does: a tag added or an id taken
   * off then shows with no wait. Only a repository that answers later is
   * waited on.
   */
  itemTypeFromCache(
    file: TFile,
    cache: CachedMetadata | null
  ): NoteType | null | Promise<NoteType | null> {
    return this.#heldType(
      file,
      cache,
      Obsidian.noteTypeFromCache(file, cache, this.app)
    );
  }

  /**
   * The type of note `file`, whose parse is `cache`, given `tagged`, the type
   * its tags name (see {@link getItemType}): the live row's whose id is the
   * `ir-id` in `cache` and whose `reference` is `file`'s path, `tagged` before
   * it; else `tagged`, unless the note is a copy of that id's live note
   * elsewhere; else `null`. `null` too for a note the vault no longer holds.
   * At once when the note claims no id or the repository answers at once (see
   * {@link itemTypeFromCache}).
   */
  #heldType(
    file: TFile,
    cache: CachedMetadata | null,
    tagged: NoteType | null
  ): NoteType | null | Promise<NoteType | null> {
    const id: unknown = cache?.frontmatter?.['ir-id'];
    if (typeof id !== 'string') return tagged;
    if (this.app.vault.getFileByPath(file.path) !== file) return null;
    // One lookup by primary key per table
    const rows = this.repo.query(
      `SELECT 'article' AS type, reference FROM article WHERE id = $1 AND deleted = FALSE
       UNION ALL SELECT 'snippet', reference FROM snippet WHERE id = $1 AND deleted = FALSE
       UNION ALL SELECT 'card', reference FROM srs_card WHERE id = $1 AND deleted = FALSE`,
      [id]
    );
    const typeOf = (found: RowTypes[]): NoteType | null => {
      const live = found as unknown as { type: NoteType; reference: string }[];
      const held = live.find(({ reference }) => reference === file.path);
      if (held) return tagged ?? held.type;
      const copy = live.some(({ reference }) => this.#claimsAt(reference, id));
      return copy ? null : tagged;
    };
    return Array.isArray(rows) ? typeOf(rows) : rows.then(typeOf);
  }

  /** Whether the vault holds a note at `path` whose `ir-id` is `id`. */
  #claimsAt(path: string, id: string): boolean {
    const note = this.app.vault.getFileByPath(path);
    if (!note) return false;
    const claimed: unknown =
      this.app.metadataCache.getFileCache(note)?.frontmatter?.['ir-id'];
    return claimed === id;
  }

  async findById(id: string): Promise<{
    row: SnippetRow | SRSCardRow | ArticleRow;
    table: TableName;
  } | null> {
    let row: SRSCardRow | SnippetRow | ArticleRow | null = (
      await this.repo.query(
        `SELECT * FROM srs_card WHERE id = $1 AND ${NOT_PURGED}`,
        [id]
      )
    )[0] as SRSCardRow | null;
    if (row) {
      return { row, table: 'srs_card' };
    }

    row = (
      await this.repo.query(
        `SELECT * FROM snippet WHERE id = $1 AND ${NOT_PURGED}`,
        [id]
      )
    )[0] as SnippetRow | null;
    if (row) {
      return { row, table: 'snippet' };
    }

    row = (
      await this.repo.query(
        `SELECT * FROM article WHERE id = $1 AND ${NOT_PURGED}`,
        [id]
      )
    )[0] as ArticleRow | null;
    if (row) {
      return { row, table: 'article' };
    }

    return null;
  }

  /**
   * Rows of `table` taken from `file` that belong to no item, leaving out any
   * whose `start_offset` is below `minStartOffset` when one is given.
   *
   * An item taken from a file that is not itself an item has nothing but its
   * `source` property tying it to that file. That property is the plugin's own
   * record, written when the item was made, so it is read from each
   * parentless row's note rather than from `metadataCache.resolvedLinks`: the
   * link index resolves asynchronously and does not reliably carry links that
   * live in frontmatter, which is where every item keeps its source.
   *
   * Rows that already have a parent are skipped: they belong to that item even
   * while their note still points here, which is what keeps a copy import from
   * leaving highlights behind on the file it copied.
   */
  protected async findParentlessFrom<R extends SnippetRow | SRSCardRow>(
    table: 'snippet' | 'srs_card',
    file: TFile,
    minStartOffset?: number
  ): Promise<R[]> {
    const rows = ((minStartOffset === undefined
      ? await this.repo.query(
          `SELECT * FROM ${table} WHERE parent IS NULL AND deleted = FALSE`
        )
      : await this.repo.query(
          `SELECT * FROM ${table} WHERE parent IS NULL AND deleted = FALSE AND start_offset >= $1`,
          [minStartOffset]
        )) ?? []) as R[];

    return rows.filter((row) => {
      const note = Obsidian.getNote(row.reference, this.app);
      if (!note) return false;
      return Obsidian.sourceIs(note, file, this.app);
    });
  }

  /**
   * Settles once the metadata cache has `note`'s `source` link resolving to
   * `source`, or after {@link SOURCE_INDEX_TIMEOUT_MS} whatever it has.
   */
  protected sourceIndexed(note: TFile, source: TFile): Promise<void> {
    const indexed = () => Obsidian.sourceIs(note, source, this.app);
    if (indexed()) return Promise.resolve();
    const { metadataCache } = this.app;
    return new Promise((resolve) => {
      const done = () => {
        metadataCache.offref(ref);
        window.clearTimeout(timer);
        resolve();
      };
      const ref = metadataCache.on('changed', (file) => {
        if (file.path === note.path && indexed()) done();
      });
      const timer = window.setTimeout(done, SOURCE_INDEX_TIMEOUT_MS);
    });
  }

  /**
   * Hand every parentless row of `table` taken from `file` to the item
   * `parentId` now backing that file (see {@link findParentlessFrom}).
   * @returns the adopted rows, carrying their new parent
   */
  protected async adoptParentless<R extends SnippetRow | SRSCardRow>(
    table: 'snippet' | 'srs_card',
    file: TFile,
    parentId: string
  ): Promise<R[]> {
    return this.adoptRows(
      table,
      await this.findParentlessFrom<R>(table, file),
      parentId
    );
  }

  /**
   * Give the rows `orphans` of `table` the parent `parentId`.
   * @returns the rows, carrying their new parent
   */
  protected async adoptRows<R extends SnippetRow | SRSCardRow>(
    table: 'snippet' | 'srs_card',
    orphans: readonly R[],
    parentId: string
  ): Promise<R[]> {
    for (const { query, params } of this.adoptStatements(
      table,
      orphans,
      parentId
    )) {
      await this.repo.mutate(query, params);
    }

    return orphans.map((row) => ({ ...row, parent: parentId }));
  }

  /**
   * The writes that give the rows `orphans` of `table` the parent `parentId`
   * (see {@link adoptRows}), for a caller that runs them along with others.
   */
  protected adoptStatements(
    table: 'snippet' | 'srs_card',
    orphans: readonly { id: string }[],
    parentId: string
  ): MutationStatement[] {
    // Chunked so a file with a very large number of them cannot blow the
    // statement's parameter limit; the parent id takes one slot per chunk.
    const chunkSize = MAX_SQL_QUERY_PARAMS - 1;
    const statements: MutationStatement[] = [];
    for (let i = 0; i < orphans.length; i += chunkSize) {
      const chunk = orphans.slice(i, i + chunkSize);
      const placeholders = chunk.map((_, j) => `$${j + 2}`).join(', ');
      statements.push({
        query: `UPDATE ${table} SET parent = $1 WHERE id IN (${placeholders})`,
        params: [parentId, ...chunk.map((row) => row.id)],
      });
    }
    return statements;
  }

  /**
   * Point the `source` link of each item's note that names the file at
   * `fromPath` at `to` instead, as though the item had been taken from `to`:
   * written as it was (a wikilink or markdown link, as Obsidian's own link
   * updater keeps it), with its subpath (a PDF selection), and an alias that
   * was the old file's name, or its page label, taking the new one's. A link is
   * read from where its note was when it was written: `writtenAt`, for a note
   * that has moved since, else where it is. A note that is gone, is another item's by its
   * `ir-id`, has no link, or links elsewhere is left alone, as is one whose
   * link is already what it would become; none of them costs a write.
   *
   * A link is matched by what it names rather than by what it resolves to: the
   * file it was written for may have moved on, so it resolves nowhere, or
   * somewhere else entirely. A note that can't be written to is logged and
   * skipped.
   * @returns how many links were rewritten
   */
  async retargetSources(
    items: readonly { id: string; reference: string; writtenAt?: string }[],
    fromPath: string,
    to: TFile
  ): Promise<number> {
    const fileName = fromPath.slice(fromPath.lastIndexOf('/') + 1);
    const dot = fileName.lastIndexOf('.');
    const fromBasename = dot > 0 ? fileName.slice(0, dot) : fileName;

    const retargeted = (
      note: TFile,
      { id, writtenAt = note.path }: (typeof items)[number],
      frontmatter: Record<string, unknown> | undefined
    ): string | null => {
      // A note at the path that is not the row's own: see `reconcileNote`
      if (frontmatter?.['ir-id'] !== id) return null;
      const source = frontmatter[SOURCE_PROPERTY_NAME];
      if (typeof source !== 'string') return null;
      const link = parseSourceLink(source);
      if (!link || !linkNamesPath(link.path, writtenAt, fromPath)) return null;
      const next = formatSourceLink({
        ...link,
        // As Obsidian links to it from the note: a note without its `.md` in
        // a wikilink only, as its link updater does
        path: this.app.metadataCache.fileToLinktext(
          to,
          note.path,
          link.form === 'wiki'
        ),
        alias: retargetAlias(link.alias, fromBasename, to.basename),
      });
      return next === source.trim() ? null : next;
    };

    let rewritten = 0;
    for (const item of items) {
      const note = Obsidian.getNote(item.reference, this.app);
      if (!note) continue;
      // Read from the cache first, so the many that need nothing cost no write
      if (
        retargeted(note, item, Obsidian.getFrontMatter(note, this.app)) === null
      )
        continue;
      let changed = false;
      try {
        // Decided again on the note as written, which the cache may lag
        await Obsidian.updateFrontMatter(
          note,
          (frontmatter) => {
            const next = retargeted(note, item, frontmatter);
            if (next === null) return;
            frontmatter[SOURCE_PROPERTY_NAME] = next;
            changed = true;
          },
          this.app
        );
      } catch (error) {
        console.error(error);
        continue;
      }
      if (changed) rewritten += 1;
    }
    return rewritten;
  }

  /**
   * {@link retargetSources} for the live snippets and cards whose parent is
   * the row `parentId`, whose file has moved from `fromPath` to `to`: their
   * links are the record of where they were taken from, and follow it.
   */
  async retargetChildSources(
    parentId: string,
    fromPath: string,
    to: TFile
  ): Promise<number> {
    const children = (await this.repo.query(
      `SELECT id, reference FROM snippet WHERE parent = $1 AND deleted = FALSE
       UNION ALL
       SELECT id, reference FROM srs_card WHERE parent = $1 AND deleted = FALSE`,
      [parentId]
    )) as unknown as { id: string; reference: string }[];
    return this.retargetSources(children, fromPath, to);
  }

  /**
   * The item `data` belongs to as a missing one, when no file is at its
   * `reference`, or `null` when one is. A row that fails to become a review
   * item with its file right there was refused for some other reason (a note
   * claiming another item's id), and is not missing.
   */
  asMissing<D extends MissingItem['data']>(data: D): MissingItem<D> | null {
    if (Obsidian.getNote(data.reference, this.app)) return null;
    return { data, file: null };
  }

  /**
   * Square a row with the note at its reference, as a review fetch finds them:
   * tombstone a live row whose note now carries another item's `ir-id`, only
   * when the note is provably the one the plugin last wrote the row's identity
   * into, its mtime equal to the row's `note_mtime` (see `reconcileAction`). A
   * note that came over Sync ahead of the database that goes with it, or behind
   * it, has some other mtime, and the row is left for the next fetch, once one
   * of the two has caught up.
   *
   * A tombstoned row is never brought back here, even with a note carrying its
   * `ir-id` at its reference: a restore revives it through
   * `ReviewManager.handleCreation`, and the note of a row tombstoned on another
   * device can still be here only because Sync has yet to delete it (see
   * `reconcileAction`).
   *
   * A note lacking the row's `ir-id` or tag is left as it is, matching
   * fingerprint or not: no identity frontmatter is written from a fetch. A note
   * stripped by an un-import on another device reaches this one over Sync
   * before the database without the row does, and writing the id back here
   * re-imported it on both.
   *
   * A note the metadata cache is part way through re-reading is left alone.
   * Obsidian points a note's cache entry at the hash of its new content before
   * the parse of that content has finished, and `getFileCache` answers `null`
   * until it has (read from `MetadataCache.computeFileMetadataAsync` in
   * obsidian.asar, 1.13 — not documented). Every edit opens that window, so a
   * fetch of the item being typed into in review lands in it often. Read as a
   * note with no frontmatter, it rewrote frontmatter that was already right
   * while the user typed, and it would stamp this row's id over another item's
   * note just as readily. The item is still the row's to show: the note is at
   * its reference, and the next fetch after the parse judges it properly.
   *
   * A file with no frontmatter, a PDF say, has no id or tag to square: the
   * file at a row's reference is that row's file by its path alone. Its
   * tombstone is left to the vault events that track such files.
   * @returns false when the note claims another item's id: the row has no
   * note to review, whether or not it could be tombstoned for it.
   */
  protected reconcileNote(
    row: {
      id: string;
      deleted: boolean | number;
      reference: string;
      note_mtime?: number | null;
    },
    file: TFile,
    type: NoteType
  ): boolean {
    if (!supportsFrontmatter(file)) return true;
    if (!this.app.metadataCache.getFileCache(file)) return true;

    const frontmatter = Obsidian.getFrontMatter(file, this.app);
    const fileId: unknown = frontmatter?.['ir-id'];
    const relation: IrIdRelation = !claimsIdentity(fileId)
      ? 'none'
      : fileId === row.id
        ? 'same'
        : 'other';
    const action = reconcileAction({
      noteMtime: noteFingerprint(file),
      rowMtime: row.note_mtime ?? null,
      relation,
      rowState: !row.deleted
        ? 'live'
        : row.reference === purgedReference(row.id)
          ? 'purged'
          : 'tombstoned',
    });
    // The refetch after a reload reads a database Sync just delivered, and
    // the notes it delivers as separate files may not have landed yet: what
    // they say is no grounds to change the row then. A later read decides.
    const repair = !this.repo.refetchingAfterReload;
    if (repair && action === 'tombstone') void this.markDeleted(row.id, type);
    return relation !== 'other';
  }

  /**
   * Drop the `table` row `id` and delete its note, as one: a note left with
   * no row, or a row whose note is gone, is half a deletion. The row and its
   * review history are tombstoned (see `tombstoneRowStatements`), not deleted.
   *
   * The row goes first, and is put back as it was when the note is not
   * deleted after all — the user turns down Obsidian's prompt, or the trash
   * fails. A note can't be fetched back from the trash, so its deletion is
   * the last step, after which nothing is undone.
   *
   * @param options.prompt whether to delete the note as Obsidian does from
   *   its own menus (the default): asking first, if the user has it ask, and
   *   then offering to delete whatever only the note linked to. That includes
   *   the PDF a note made from one links to as its source, so an undo, which
   *   only takes back what it made, says `false` and trashes just the note.
   * @param action what is refused, as in "Couldn't {action}", while writes
   *   are (see `refusedWrite`)
   * @returns `deleted` once both are gone; `declined` when the user turned
   *   down deleting the note, `refused` when writes were, and `failed` when
   *   anything else kept them, each leaving both as they were
   */
  protected async deleteWithNote(
    table: 'snippet' | 'srs_card',
    id: string,
    { prompt = true }: { prompt?: boolean },
    action: string
  ): Promise<DeleteOutcome> {
    if (await refusedWrite(this.repo, action)) return 'refused';
    let declined = false;
    try {
      const row = (
        await this.repo.query(
          `SELECT * FROM ${table} WHERE id = $1 AND ${NOT_PURGED}`,
          [id]
        )
      )[0] as SnippetRow | SRSCardRow | undefined;
      if (!row) throw new Error(`No ${table} row was found with ID "${id}"`);

      // The live ones, which the delete tombstones with the row, and a
      // turned-down delete must bring back without those undone before
      const [log, column] = REVIEW_LOG_OF[table];
      const reviews = (await this.repo.query(
        `SELECT id FROM ${log} WHERE ${column} = $1 AND deleted = FALSE`,
        [id],
        { throwOnError: true }
      )) as unknown as { id: string }[];

      const file = Obsidian.getNote(row.reference, this.app);
      await withCompensation(async (step) => {
        await step(
          () =>
            this.repo.transaction(async () => {
              for (const { query, params } of tombstoneRowStatements(
                table,
                id
              )) {
                await this.repo.mutate(query, params);
              }
            }),
          () =>
            this.repo.transaction(async () => {
              await this.restoreRow(table, row);
              for (const review of reviews) {
                await this.repo.mutate(
                  `UPDATE ${log} SET deleted = FALSE WHERE id = $1`,
                  [review.id]
                );
              }
            })
        );
        if (!file) return;
        if (!prompt) {
          await this.app.fileManager.trashFile(file);
          return;
        }
        // `promptForFileDeletion` is undocumented Obsidian API (`trashFile`
        // is the public one). Its offer to delete unlinked attachments, and
        // its answering false when turned down, were read from the app
        // bundle; its declared type answers nothing.
        let deleted: unknown;
        try {
          deleted = await this.app.fileManager.promptForFileDeletion(file);
        } catch (error) {
          // Thrown by what it does past trashing the note, such as offering
          // to delete the attachments only the note linked to: the note is
          // gone, so the row must go with it
          if (this.app.vault.getFileByPath(file.path) === file) throw error;
          console.error(error);
          return;
        }
        if (deleted === false) {
          declined = true;
          throw new Error(`Kept ${row.reference}`);
        }
      });
      return 'deleted';
    } catch (error) {
      console.error(error);
      if (declined) return 'declined';
      return this.repo.writeRefusal() ? 'refused' : 'failed';
    }
  }

  /**
   * Put `row`, read whole from `table`, back as it was, all but its stamp: a
   * write that undoes another is a newer one, and is stamped as such.
   */
  private async restoreRow(table: string, row: { id: string }) {
    // Its id among them, written as it is
    const columns = Object.keys(row).filter(
      (column) => !(STAMP_COLUMNS as readonly string[]).includes(column)
    );

    // Numbered in the order they appear: sql.js binds an array by position
    await this.repo.mutate(
      `UPDATE ${table} SET ${columns
        .map((column, i) => `${column} = $${i + 1}`)
        .join(', ')} WHERE id = $${columns.length + 1}`,
      [...columns.map((c) => (row as Record<string, Primitive>)[c]), row.id]
    );
  }

  async markDeleted(id: string, type: NoteType): Promise<void> {
    const table = type === 'card' ? 'srs_card' : type;
    await this.repo.mutate(`UPDATE ${table} SET deleted = 1 WHERE id = $1`, [
      id,
    ]);
  }

  async markUndeleted(id: string, type: NoteType): Promise<void> {
    const table = type === 'card' ? 'srs_card' : type;
    await this.repo.mutate(`UPDATE ${table} SET deleted = 0 WHERE id = $1`, [
      id,
    ]);
  }

  /**
   * Write `text`'s new priority with the interval and due it leaves (see
   * `IRScheduler.reprioritize`).
   * @param lastReview `text`'s latest review, if it has one
   */
  protected async reprioritizeText(
    table: 'article' | 'snippet',
    text: IArticleBase | ISnippetBase,
    newPriority: number,
    lastReview: { review_time: number } | undefined
  ): Promise<void> {
    const { interval, due } = IRScheduler.reprioritize(
      text,
      newPriority,
      lastReview?.review_time
    );
    await this.repo.mutate(
      `UPDATE ${table} SET priority = $1, due = $2, interval = $3 WHERE id = $4`,
      [newPriority, due, interval, text.id]
    );
  }

  /** Every review of `itemId` in `table`'s log, undone ones included. */
  private async readLog(
    table: ItemTable,
    itemId: string
  ): Promise<AuthoredReview[]> {
    const { log, parent, at } = REPLAYED_LOGS.find(
      ({ item }) => item === table
    )!;
    const rating = table === 'srs_card' ? 'rating' : 'NULL';
    return (await this.repo.query(
      `SELECT id, ${at} AS at, ${rating} AS rating, updated_by, deleted
       FROM ${log} WHERE ${parent} = $1`,
      [itemId]
    )) as unknown as AuthoredReview[];
  }

  /**
   * Note the live reviews of `itemId` before review `reviewId` of it is
   * written, for its undo (see {@link logsBefore}). Called in the review's
   * transaction, so no merge comes between the two.
   */
  protected async noteLogBefore(
    table: ItemTable,
    itemId: string,
    reviewId: string
  ): Promise<void> {
    this.logsBefore.set(
      reviewId,
      liveInOrder(await this.readLog(table, itemId)).map(({ id }) => id)
    );
  }

  /**
   * Tombstone review `reviewId` of `itemId` and the reviews undoing it takes
   * with it (see `planUndo`), rather than delete them, so the undo reaches
   * the other devices. Called in the undo's transaction.
   * @throws when it is no live review of the item, undone already
   */
  protected async takeBackReview(
    table: ItemTable,
    itemId: string,
    reviewId: string
  ): Promise<UndoPlan> {
    const reviews = await this.readLog(table, itemId);
    const noted = this.logsBefore.get(reviewId);
    const plan = planUndo(reviews, reviewId, noted && notedLog(reviews, noted));
    if (!plan) {
      throw new Error(`No review "${reviewId}" of ${table} ${itemId} to undo`);
    }
    const [log, parent] = REVIEW_LOG_OF[table];
    const taken = [...plan.taken];
    await this.repo.mutate(
      `UPDATE ${log} SET deleted = TRUE WHERE ${parent} = $1 AND id IN ` +
        `(${taken.map((_, i) => `$${i + 2}`).join(', ')})`,
      [itemId, ...taken]
    );
    return plan;
  }

  /**
   * Undo review `reviewId` of `original`, the text as it was before it: take
   * it back with the later reviews this device made of it, and give it the
   * schedule the reviews left imply under its rules now (see
   * `textAfterUndo`), dismissed or not as it was, all in one transaction.
   */
  protected async undoTextReview(
    table: 'article' | 'snippet',
    original: IArticleBase | ISnippetBase,
    reviewId: string
  ): Promise<void> {
    const taken = await this.repo.transaction(async () => {
      const plan = await this.takeBackReview(table, original.id, reviewId);
      const [now] = (await this.repo.query(
        `SELECT * FROM ${table} WHERE id = $1`,
        [original.id]
      )) as unknown as TextRules[];
      const { interval, due, due_fuzz } = textAfterUndo(
        plan,
        original,
        now,
        this.plugin.settings
      );
      await this.repo.mutate(
        `UPDATE ${table} SET dismissed = $1, due = $2, interval = $3, due_fuzz = $4 WHERE id = $5`,
        [original.dismissed, due, interval, due_fuzz, original.id]
      );
      return plan.taken;
    });
    this.forgetNotes(taken);
  }

  /**
   * Drop the notes of reviews an undo took back, which no undo can take
   * again: each later one of this device's goes with the undone one, though
   * its own undo is still on the stack.
   */
  protected forgetNotes(taken: Iterable<string>): void {
    for (const id of taken) this.logsBefore.delete(id);
  }

  /**
   * Give every `table` row that has no due_fuzz one, for when fuzzing is
   * turned on. Rows get theirs as they are made and reviewed while it is on,
   * so this is a one-time backfill, not a repair made whenever a row is read.
   *
   * Live rows alone: a deleted or purged row is left as it is, unstamped, so
   * it never reads as this device's latest edit and outranks a later restore
   * made on another device when databases merge.
   */
  async backfillReviewTimeFuzz(table: 'article' | 'snippet'): Promise<void> {
    const rows = (await this.repo.query(
      `SELECT id FROM ${table} WHERE due_fuzz IS NULL AND deleted = FALSE`
    )) as { id: string }[];
    if (rows.length === 0) return;
    await this.repo.bulkMutate(
      rows.map(({ id }) => ({
        query: `UPDATE ${table} SET due_fuzz = $1
          WHERE id = $2 AND due_fuzz IS NULL AND deleted = FALSE`,
        params: [IRScheduler.getDueFuzz(), id],
      }))
    );
  }
}
