import IRScheduler from '#/lib/IRScheduler';
import type {
  ArticleRow,
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
    table: TableName;
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
   * @returns false when the note claims another item's id. The row is marked
   * deleted then, and has no note to review.
   */
  protected reconcileNote(
    row: { id: string; deleted: boolean },
    file: TFile,
    type: NoteType,
    tag: string
  ): boolean {
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
