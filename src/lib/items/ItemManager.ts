import { MAX_SQL_QUERY_PARAMS, SOURCE_PROPERTY_NAME } from '#/lib/constants';
import IRScheduler from '#/lib/IRScheduler';
import { supportsFrontmatter } from '#/lib/mime';
import {
  formatSourceLink,
  linkNamesPath,
  parseSourceLink,
  retargetAlias,
} from '#/lib/source-link';
import type {
  ArticleRow,
  MissingItem,
  NoteType,
  RowTypes,
  SRSCardRow,
  SnippetRow,
  TableName,
} from '#/lib/types';
import type IncrementalReadingPlugin from '#/main';
import {
  type App,
  type TAbstractFile,
  type TFile,
  normalizePath,
} from 'obsidian';
import { ObsidianHelpers as Obsidian } from '../ObsidianHelpers';
import type { SQLiteRepository } from '../types';

export class ItemManager {
  plugin: IncrementalReadingPlugin;
  app: App;
  repo: SQLiteRepository;

  constructor(plugin: IncrementalReadingPlugin, repo: SQLiteRepository) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.repo = repo;
  }

  async findSnippet(snippetFile: TAbstractFile): Promise<SnippetRow | null> {
    const results = await this.repo.query(
      'SELECT * FROM snippet WHERE reference = $1',
      [normalizePath(snippetFile.path)]
    );

    return (results[0] as SnippetRow) ?? null;
  }

  async findCard(cardFile: TAbstractFile): Promise<SRSCardRow | null> {
    const results = await this.repo.query(
      'SELECT * FROM srs_card WHERE reference = $1',
      [normalizePath(cardFile.path)]
    );

    return (results[0] as SRSCardRow) ?? null;
  }

  async findArticle(articleFile: TAbstractFile): Promise<ArticleRow | null> {
    const results = await this.repo.query(
      'SELECT * FROM article WHERE reference = $1',
      [normalizePath(articleFile.path)]
    );

    return (results[0] as ArticleRow) ?? null;
  }

  async findItem(file: TAbstractFile): Promise<{
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
   * The type of item `file` is, if any. A note is typed by its tags, as
   * `getNoteType` reads them. A file with no frontmatter, a PDF say, has none.
   * It is known by its path alone, so it is whatever the row at its path is.
   */
  async getItemType(file: TFile): Promise<NoteType | null> {
    if (supportsFrontmatter(file)) return Obsidian.getNoteType(file, this.app);

    const match = await this.findItem(file);
    if (!match) return null;
    return match.table === 'srs_card' ? 'card' : match.table;
  }

  async findById(id: string): Promise<{
    row: SnippetRow | SRSCardRow | ArticleRow;
    table: TableName;
  } | null> {
    let row: SRSCardRow | SnippetRow | ArticleRow | null = (
      await this.repo.query('SELECT * FROM srs_card WHERE id = $1', [id])
    )[0] as SRSCardRow | null;
    if (row) {
      return { row, table: 'srs_card' };
    }

    row = (
      await this.repo.query('SELECT * FROM snippet WHERE id = $1', [id])
    )[0] as SnippetRow | null;
    if (row) {
      return { row, table: 'snippet' };
    }

    row = (
      await this.repo.query('SELECT * FROM article WHERE id = $1', [id])
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
      return Obsidian.getSourceFile(note, this.app)?.path === file.path;
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
    // Chunked so a file with a very large number of them cannot blow the
    // statement's parameter limit; the parent id takes one slot per chunk.
    const chunkSize = MAX_SQL_QUERY_PARAMS - 1;
    for (let i = 0; i < orphans.length; i += chunkSize) {
      const chunk = orphans.slice(i, i + chunkSize);
      const placeholders = chunk.map((_, j) => `$${j + 2}`).join(', ');
      await this.repo.mutate(
        `UPDATE ${table} SET parent = $1 WHERE id IN (${placeholders})`,
        [parentId, ...chunk.map((row) => row.id)]
      );
    }

    return orphans.map((row) => ({ ...row, parent: parentId }));
  }

  /**
   * Point the `source` link of each item's note that names the file at
   * `fromPath` at `to` instead, as though the item had been taken from `to`:
   * written as it was (a wikilink or markdown link, as Obsidian's own link
   * updater keeps it), with its subpath (a PDF selection), and unless
   * `renameAlias` is false, an alias that was the old file's name, or its page
   * label, takes the new one's. A note that is gone, is another item's by its
   * `ir-id`, has no link, or links elsewhere is left alone, as is one whose
   * link is already what it would become; none of them costs a write.
   *
   * A link is matched by what it names rather than by what it resolves to: the
   * file it was written for may have moved on, so it resolves nowhere, or
   * somewhere else entirely. A note that can't be written to is logged and
   * skipped.
   * @param renameAlias false to keep every alias as written, as Obsidian's own
   *   link updater does, which may be rewriting the same links meanwhile
   * @returns how many links were rewritten
   */
  async retargetSources(
    items: readonly { id: string; reference: string }[],
    fromPath: string,
    to: TFile,
    { renameAlias = true }: { renameAlias?: boolean } = {}
  ): Promise<number> {
    const fileName = fromPath.slice(fromPath.lastIndexOf('/') + 1);
    const dot = fileName.lastIndexOf('.');
    const fromBasename = dot > 0 ? fileName.slice(0, dot) : fileName;

    const retargeted = (
      note: TFile,
      id: string,
      frontmatter: Record<string, unknown> | undefined
    ): string | null => {
      // A note at the path that is not the row's own: see `reconcileNote`
      if (frontmatter?.['ir-id'] !== id) return null;
      const source = frontmatter[SOURCE_PROPERTY_NAME];
      if (typeof source !== 'string') return null;
      const link = parseSourceLink(source);
      if (!link || !linkNamesPath(link.path, note.path, fromPath)) return null;
      const next = formatSourceLink({
        ...link,
        // As Obsidian links to it from the note: a note without its `.md` in
        // a wikilink only, as its link updater does
        path: this.app.metadataCache.fileToLinktext(
          to,
          note.path,
          link.form === 'wiki'
        ),
        alias: renameAlias
          ? retargetAlias(link.alias, fromBasename, to.basename)
          : link.alias,
      });
      return next === source.trim() ? null : next;
    };

    let rewritten = 0;
    for (const { id, reference } of items) {
      const note = Obsidian.getNote(reference, this.app);
      if (!note) continue;
      // Read from the cache first, so the many that need nothing cost no write
      if (
        retargeted(note, id, Obsidian.getFrontMatter(note, this.app)) === null
      )
        continue;
      let changed = false;
      try {
        // Decided again on the note as written, which the cache may lag
        await Obsidian.updateFrontMatter(
          note,
          (frontmatter) => {
            const next = retargeted(note, id, frontmatter);
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
    to: TFile,
    options?: { renameAlias?: boolean }
  ): Promise<number> {
    const children = (await this.repo.query(
      `SELECT id, reference FROM snippet WHERE parent = $1 AND deleted = FALSE
       UNION ALL
       SELECT id, reference FROM srs_card WHERE parent = $1 AND deleted = FALSE`,
      [parentId]
    )) as unknown as { id: string; reference: string }[];
    return this.retargetSources(children, fromPath, to, options);
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
   * Use when creating items or to repair frontmatter on fetch
   */
  async setFrontmatter(file: TFile, id: string, tags: string | string[]) {
    await Obsidian.updateFrontMatter(
      file,
      {
        'ir-id': id,
        tags,
      },
      this.app
    );
  }

  /**
   * Square a row with the note at its reference, as a review fetch finds them:
   * put back the row's `ir-id` and tag where the note lacks them, and bring the
   * row back from a tombstone now that its note is there.
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
   * @returns false when the note claims another item's id. The row is marked
   * deleted then, and has no note to review.
   */
  protected reconcileNote(
    row: { id: string; deleted: boolean },
    file: TFile,
    type: NoteType,
    tag: string
  ): boolean {
    if (!supportsFrontmatter(file)) return true;
    if (!this.app.metadataCache.getFileCache(file)) return true;

    const frontmatter = Obsidian.getFrontMatter(file, this.app);
    const fileId = frontmatter?.['ir-id'];
    // id is present but doesn't match
    if (fileId && fileId !== row.id) {
      void this.markDeleted(row.id, type);
      return false;
    }

    // some frontmatter is missing; impute it
    if (!fileId || !frontmatter?.tags?.includes(tag)) {
      void this.setFrontmatter(file, row.id, tag);
    }

    if (row.deleted) {
      void this.markUndeleted(row.id, type);
    }
    return true;
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

  /** Recalculate and set due_fuzz for a single row */
  async setReviewTimeFuzz(
    id: string,
    table: 'article' | 'snippet'
  ): Promise<void> {
    await this.repo.mutate(`UPDATE ${table} SET due_fuzz = $1 WHERE id = $2`, [
      IRScheduler.getDueFuzz(),
      id,
    ]);
  }
}
