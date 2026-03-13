import type { App, TAbstractFile } from 'obsidian';
import type { SQLiteRepository } from '../repository';
import type { SRSCardRow, SnippetRow, ArticleRow } from '#/lib/types';
import { ObsidianHelpers as Obsidian } from '../ObsidianHelpers';

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
