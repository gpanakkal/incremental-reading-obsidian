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
import type { App, TAbstractFile, TFile } from 'obsidian';
import { normalizePath } from 'obsidian';
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
