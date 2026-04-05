import {
  ARTICLE_DIRECTORY,
  ARTICLE_TAG,
  CARD_TAG,
  CONTENT_TITLE_SLICE_LENGTH,
  DATA_DIRECTORY,
  ERROR_NOTICE_DURATION_MS,
  INVALID_TITLE_MESSAGE,
  MAX_SQL_QUERY_PARAMS,
  SNIPPET_TAG,
  SOURCE_PROPERTY_NAME,
  SUCCESS_NOTICE_DURATION_MS,
  TEXT_BASE_REVIEW_INTERVAL,
} from '#/lib/constants';
import IRScheduler from '#/lib/IRScheduler';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import type {
  ArticleDisplay,
  ArticleRow,
  FrontMatterUpdates,
  IArticleBase,
  IArticleReview,
  ReviewArticle,
} from '#/lib/types';
import {
  generateId,
  getContentSlice,
  getDateString,
  getEndOfToday,
} from '#/lib/utils';
import type { TFile } from 'obsidian';
import { normalizePath, Notice } from 'obsidian';
import { ItemManager } from './ItemManager';

export class ArticleManager extends ItemManager {
  static rowToBase(articleRow: ArticleRow): IArticleBase {
    return {
      ...articleRow,
      dismissed: Boolean(articleRow.dismissed),
    };
  }

  static rowToDisplay(articleRow: ArticleRow): ArticleDisplay {
    return {
      ...articleRow,
      due: articleRow.due ? new Date(articleRow.due) : null,
      dismissed: Boolean(articleRow.dismissed),
    };
  }

  static displayToRow(article: ArticleDisplay): ArticleRow {
    return {
      ...article,
      due: article.due ? Date.parse(article.due.toISOString()) : null,
      dismissed: Number(article.dismissed),
    };
  }

  rowToReviewArticle(row: ArticleRow): ReviewArticle | null {
    const base = ArticleManager.rowToBase(row);
    const file = Obsidian.getNote(row.reference, this.app);
    if (!file) return null;
    return {
      data: base,
      file,
    };
  }

  /**
   * Import the currently opened note as an article
   */
  async import(file: TFile, priority: number) {
    try {
      // check if the file is inside the plugin's data directory
      if (file.path.startsWith(DATA_DIRECTORY)) {
        new Notice(
          `Note is already in the plugin data folder; canceling import`,
          ERROR_NOTICE_DURATION_MS
        );
        return;
      }
      // Read the content of the current file
      const content = await this.app.vault.cachedRead(file);
      const frontmatter = Obsidian.getFrontMatter(file, this.app);
      if (frontmatter?.tags) {
        if (
          frontmatter.tags.some((tag) =>
            new Set([SNIPPET_TAG, CARD_TAG]).has(tag)
          )
        ) {
          new Notice(
            `Note contains a snippet or card tag; canceling import`,
            ERROR_NOTICE_DURATION_MS
          );
          return;
        }
      }

      // check if an article with this name already exists
      const getTargetPath = (fileName: string) =>
        normalizePath(`${DATA_DIRECTORY}/${ARTICLE_DIRECTORY}/${fileName}`);
      const isDuplicate = (fileName: string) =>
        this.app.vault.getAbstractFileByPath(getTargetPath(fileName));

      if (isDuplicate(file.name)) {
        new Notice(
          `Warning: article with name already exists "${file.name}"`,
          0
        );
      }

      let importFileName = file.name;
      while (isDuplicate(importFileName)) {
        importFileName = `${file.basename} - ${generateId()}.${file.extension}`;
      }

      // Create a copy in the articles directory
      const articleFile = await Obsidian.createNote({
        content,
        fileName: importFileName,
        directory: Obsidian.getDirectory('article'),
        app: this.app,
      });

      if (!articleFile) {
        throw new Error(
          `Failed to create note ${getTargetPath(importFileName)}`
        );
      }

      // Tag it and create a link to the source if it doesn't exist
      const frontmatterUpdates: FrontMatterUpdates = {
        tags: ARTICLE_TAG,
      };
      if (!frontmatter?.source) {
        const sourceLink = Obsidian.generateMarkdownLink(
          file,
          articleFile,
          this.app
        );
        frontmatterUpdates[`${SOURCE_PROPERTY_NAME}`] = sourceLink;
      }
      await Obsidian.updateFrontMatter(
        articleFile,
        frontmatterUpdates,
        this.app
      );

      // Insert into database with immediate due time
      const dueTime = Date.now();
      const id = crypto.randomUUID();
      await this.repo.mutate(
        'INSERT INTO article (id, reference, due, priority) VALUES ($1, $2, $3, $4)',
        [id, `${ARTICLE_DIRECTORY}/${articleFile.name}`, dueTime, priority]
      );

      const titleSlice = getContentSlice(
        articleFile.basename,
        CONTENT_TITLE_SLICE_LENGTH,
        true
      );
      new Notice(
        `Imported "${titleSlice}" with priority ${priority / 10}`,
        SUCCESS_NOTICE_DURATION_MS
      );
      const result = await this.fetch(id);
      return result;
    } catch (error) {
      new Notice(
        `Failed to import article "${file.name}"`,
        ERROR_NOTICE_DURATION_MS
      );
      console.error(error);
      return null;
    }
  }

  /**
   * Create a new empty article
   */
  async create(priority: number) {
    try {
      const newNoteName = Obsidian.createTitle(
        `New article ${getDateString()}`
      );
      const articleFile = await Obsidian.createNote({
        content: '',
        frontmatter: {
          created: new Date().toISOString(),
        },
        fileName: `${newNoteName}.md`,
        directory: Obsidian.getDirectory('article'),
        app: this.app,
      });

      if (!articleFile) {
        throw new Error(`Failed to create empty article`);
      }

      const frontmatterUpdates: FrontMatterUpdates = {
        tags: ARTICLE_TAG,
      };

      await Obsidian.updateFrontMatter(
        articleFile,
        frontmatterUpdates,
        this.app
      );

      // Insert into database with immediate due time
      const dueTime = Date.now();
      const id = crypto.randomUUID();
      await this.repo.mutate(
        'INSERT INTO article (id, reference, due, priority) VALUES ($1, $2, $3, $4)',
        [id, `${ARTICLE_DIRECTORY}/${articleFile.name}`, dueTime, priority]
      );

      const result = await this.fetch(id);
      return result;
    } catch (error) {
      new Notice(`Failed to create empty article`, ERROR_NOTICE_DURATION_MS);
      console.error(error);
      return null;
    }
  }

  async getDue(
    dueBy?: number,
    limit?: number,
    excludeIds?: string[]
  ): Promise<ReviewArticle[]> {
    const dueTime = dueBy ?? getEndOfToday();
    try {
      const articlesDue = (
        await this.fetchMany({ dueBy: dueTime, limit, excludeIds })
      ).map((row) => this.rowToReviewArticle(row), this);
      return articlesDue.filter(
        (article): article is ReviewArticle =>
          !!article && article.file !== null
      );
    } catch (error) {
      console.error(error);
      return [];
    }
  }

  async fetch(id: string): Promise<ReviewArticle | null> {
    const query = `SELECT * FROM article WHERE id = $1`;
    const result = await this.repo.query(query, [id]);
    if (!result[0]) return null;
    return this.rowToReviewArticle(result[0] as ArticleRow);
  }

  async fetchMany(opts?: {
    dueBy?: number;
    limit?: number;
    includeDismissed?: boolean;
    excludeIds?: string[];
  }) {
    let query = 'SELECT * FROM article';
    const conditions = [];
    const params = [];
    if (opts?.dueBy) {
      params.push(opts.dueBy);
      conditions.push(`due <= $${params.length}`);
    }
    if (!opts?.includeDismissed) {
      conditions.push('dismissed = 0');
    }

    if (opts?.excludeIds) {
      const currentParamCount = params.length;
      let condition = `id NOT IN (`;
      condition +=
        opts.excludeIds
          .map((_, i) => `$${currentParamCount + i + 1}`)
          .join(', ') + ')';
      conditions.push(condition);
      params.push(...opts.excludeIds);
    }

    if (conditions.length) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY priority DESC';

    if (opts?.limit) {
      params.push(opts?.limit);
      query += ` LIMIT $${params.length}`;
    }

    if (params.length > MAX_SQL_QUERY_PARAMS) {
      throw new Error(
        `Param count ${params.length} exceeded the limit for query "${query}"`
      );
    }
    return ((await this.repo.query(query, params)) ?? []) as ArticleRow[];
  }

  protected async getLastReview(article: IArticleBase) {
    const lastReview = (
      await this.repo.query(
        `SELECT * FROM article_review WHERE article_id = $1 ` +
          `ORDER BY review_time DESC LIMIT 1`,
        [article.id]
      )
    )[0] as IArticleReview | undefined;
    return lastReview;
  }

  /**
   * Add a ArticleReview and update the due date and interval
   * TODO: combine the operations into a transaction
   */
  async review(
    article: IArticleBase,
    reviewTime?: number,
    nextReviewInterval?: number
  ) {
    const reviewed = reviewTime || Date.now();
    const nextInterval =
      nextReviewInterval ?? IRScheduler.nextInterval(article);
    const nextDueTime = reviewed + nextInterval;

    try {
      await Promise.all([
        this.repo.mutate(
          'INSERT INTO article_review (id, article_id, review_time) VALUES ($1, $2, $3)',
          [crypto.randomUUID(), article.id, reviewed]
        ),
        this.repo.mutate(
          `UPDATE article SET dismissed = 0, due = $1, interval = $2 WHERE id = $3`,
          [nextDueTime, nextInterval, article.id]
        ),
      ]);
    } catch (error) {
      console.error(error);
    }
  }

  /**
   * @param newName The basename excluding the file extension
   */
  async rename(article: ReviewArticle, newName: string) {
    const sanitized = Obsidian.sanitizeForTitle(newName, true);
    if (sanitized !== newName) {
      new Notice(INVALID_TITLE_MESSAGE, ERROR_NOTICE_DURATION_MS);
      return;
    }

    const { file } = article;
    const currentName = file.basename;
    try {
      await Obsidian.renameFile(file, newName, this.app);
      const newReference = `${ARTICLE_DIRECTORY}/${file.basename}.${file.extension}`;
      await this.repo.mutate(
        `UPDATE article SET reference = $1 WHERE id = $2`,
        [newReference, article.data.id]
      );
    } catch (error) {
      console.error(error);
      await Obsidian.renameFile(file, currentName, this.app);
    }
  }

  /**
   * Change the priority of an article and recalculate its next due date
   */
  async reprioritize(article: IArticleBase, newPriority: number) {
    IRScheduler.validatePriority(newPriority);

    const lastReview = await this.getLastReview(article);
    const newInterval = IRScheduler.nextInterval({
      ...article,
      priority: newPriority,
    });
    const newDueTime = lastReview
      ? lastReview.review_time + newInterval
      : article.due;

    await this.repo.mutate(
      `UPDATE article SET priority = $1, due = $2, interval = $3 WHERE id = $4`,
      [newPriority, newDueTime, newInterval, article.id]
    );
  }
}
