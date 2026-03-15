import type { ArticleRow, SRSCardRow, SnippetRow } from '#/lib/types';
import type { App, TAbstractFile } from 'obsidian';
import { ObsidianHelpers as Obsidian } from '../ObsidianHelpers';
import type { SQLiteRepository } from '../repository';

export class ItemManager {
  app: App;
  repo: SQLiteRepository;

  constructor(app: App, repo: SQLiteRepository) {
    this.app = app;
    this.repo = repo;
  }

  async findSnippet(snippetFile: TAbstractFile): Promise<SnippetRow | null> {
    const results = await this.repo.query(
      'SELECT * FROM snippet WHERE reference = $1',
      [Obsidian.getReferenceFromPath(snippetFile.path)]
    );

    return (results[0] as SnippetRow) ?? null;
  }

  async findCard(cardFile: TAbstractFile): Promise<SRSCardRow | null> {
    const results = await this.repo.query(
      'SELECT * FROM srs_card WHERE reference = $1',
      [Obsidian.getReferenceFromPath(cardFile.path)]
    );

    return (results[0] as SRSCardRow) ?? null;
  }

  async findArticle(articleFile: TAbstractFile): Promise<ArticleRow | null> {
    const results = await this.repo.query(
      'SELECT * FROM article WHERE reference = $1',
      [Obsidian.getReferenceFromPath(articleFile.path)]
    );

    return (results[0] as ArticleRow) ?? null;
  }
}
