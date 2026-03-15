import type {
  ArticleDisplay,
  ArticleRow,
  IArticleActive,
  IArticleBase,
  IArticleReview,
  ReviewArticle,
} from '#/lib/types';
import type { App, TFile } from 'obsidian';
import { normalizePath, Notice } from 'obsidian';
import {
  ARTICLE_DIRECTORY,
  ARTICLE_TAG,
  CARD_TAG,
  CONTENT_TITLE_SLICE_LENGTH,
  DATA_DIRECTORY,
  ERROR_NOTICE_DURATION_MS,
  INVALID_TITLE_MESSAGE,
  SNIPPET_TAG,
  SOURCE_PROPERTY_NAME,
  SUCCESS_NOTICE_DURATION_MS,
  TEXT_BASE_REVIEW_INTERVAL,
  TEXT_REVIEW_MULTIPLIER_BASE,
  TEXT_REVIEW_MULTIPLIER_STEP,
} from '../constants';
import { ObsidianHelpers as Obsidian } from '../ObsidianHelpers';
import type { SQLiteRepository } from '../repository';
import { generateId, getContentSlice, getEndOfToday } from '../utils';
import { ItemManager } from './ItemManager';

export class ArticleManager extends ItemManager {
  app: App;
  repo: SQLiteRepository;
  helpers: Obsidian;

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
      const frontmatter =
        this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (frontmatter?.tags?.length) {
        const tags: string[] = frontmatter.tags;
        if (tags.some((tag) => new Set([SNIPPET_TAG, CARD_TAG]).has(tag))) {
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
          ERROR_NOTICE_DURATION_MS
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
      const frontmatterUpdates: Record<string, any> = {
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
      const result = await this.repo.mutate(
        'INSERT INTO article (id, reference, due, priority) VALUES ($1, $2, $3, $4)',
        [
          crypto.randomUUID(),
          `${ARTICLE_DIRECTORY}/${articleFile.name}`,
          dueTime,
          priority,
        ]
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
      return result;
    } catch (error) {
      new Notice(
        `Failed to import article "${file.name}"`,
        ERROR_NOTICE_DURATION_MS
      );
      console.error(error);
    }
  }

  async getDue(
    dueBy?: number,
    limit?: number
  ): Promise<{ data: IArticleActive; file: TFile }[]> {
    const dueTime = dueBy ?? getEndOfToday();
    try {
      const articlesDue = (await this.fetchMany({ dueBy: dueTime, limit })).map(
        async (item) => ({
          data: ArticleManager.rowToBase(item),
          file: Obsidian.getNote(item.reference, this.app),
        }),
        this
      );
      const result = await Promise.all(articlesDue);
      return result.filter(
        (article): article is { data: IArticleActive; file: TFile } =>
          article.file !== null
      );
    } catch (error) {
      console.error(error);
      return [];
    }
  }

  async fetchMany(opts?: {
    dueBy?: number;
    limit?: number;
    includeDismissed?: boolean;
  }) {
    let query = 'SELECT * FROM article';
    const conditions = [];
    const params = [];
    if (opts?.dueBy) {
      params.push(opts?.dueBy);
      conditions.push(`due <= $${params.length}`);
    }
    if (!opts?.includeDismissed) {
      conditions.push('dismissed = 0');
    }

    if (conditions.length) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY priority DESC';

    if (opts?.limit) {
      params.push(opts?.limit);
      query += ` LIMIT $${params.length}`;
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

  async review(
    article: IArticleBase,
    reviewTime?: number,
    nextReviewInterval?: number
  ) {
    const reviewed = reviewTime || Date.now();
    const nextReview =
      reviewed +
      (nextReviewInterval ?? (await this.nextReviewInterval(article)));
    try {
      const insertReviewResult = await this.repo.mutate(
        'INSERT INTO article_review (id, article_id, review_time) VALUES ($1, $2, $3)',
        [crypto.randomUUID(), article.id, reviewed]
      );

      const updateResult = await this.repo.mutate(
        `UPDATE article SET dismissed = 0, due = $1 WHERE id = $2`,
        [nextReview, article.id]
      );
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

    try {
      const { file } = article;
      const currentName = file.basename;
      await Obsidian.renameFile(file, newName, this.app);
      const newReference = `${ARTICLE_DIRECTORY}/${file.basename}.${file.extension}`;
      await this.repo
        .mutate(`UPDATE article SET reference = $1 WHERE id = $2`, [
          newReference,
          article.data.id,
        ])
        .catch(async () => {
          await Obsidian.renameFile(file, currentName, this.app);
        });
    } catch (error) {
      console.error(error);
    }
  }

  /**
   * Change the priority of an article and recalculate its next due date
   */
  async reprioritize(article: IArticleBase, newPriority: number) {
    if (newPriority % 1 !== 0 || newPriority < 10 || newPriority > 50) {
      throw new TypeError(
        `Priority must be an integer between 10 and 50 inclusive; received ${newPriority}`
      );
    }
    const { priority: _, ...rest } = article;
    const lastReview = await this.getLastReview(article);
    const newInterval = await this.nextReviewInterval({
      ...rest,
      priority: newPriority,
    });
    const newDueTime = lastReview
      ? lastReview.review_time + newInterval
      : article.due;

    await this.repo.mutate(
      `UPDATE article SET priority = $1, due = $2 WHERE id = $3`,
      [newPriority, newDueTime, article.id]
    );
  }

  protected async nextReviewInterval(text: IArticleBase): Promise<number> {
    const intervalMultiplier =
      TEXT_REVIEW_MULTIPLIER_BASE +
      (text.priority - 10) * TEXT_REVIEW_MULTIPLIER_STEP;

    const lastReview = await this.getLastReview(text);

    const lastInterval =
      lastReview && text.due
        ? text.due - lastReview.review_time
        : TEXT_BASE_REVIEW_INTERVAL;

    const nextInterval = Math.round(lastInterval * intervalMultiplier);
    return nextInterval;
  }
}
