import {
  ARTICLE_TAG,
  CARD_TAG,
  CONTENT_TITLE_SLICE_LENGTH,
  DATA_DIRECTORY,
  INVALID_TITLE_MESSAGE,
  MAX_SQL_QUERY_PARAMS,
  SNIPPET_TAG,
  SOURCE_PROPERTY_NAME,
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
  SnippetRow,
} from '#/lib/types';
import {
  compareFuzzedDue,
  generateId,
  getContentSlice,
  getDateString,
  getEndOfDay,
} from '#/lib/utils';
import { type TFile } from 'obsidian';
import { ItemManager } from './ItemManager';

const IMPORT_BLOCKED_TAGS = new Set([SNIPPET_TAG, CARD_TAG]);

export class ArticleManager extends ItemManager {
  static rowToBase(articleRow: ArticleRow): IArticleBase {
    return {
      ...articleRow,
      type: 'article',
      dismissed: Boolean(articleRow.dismissed),
    };
  }

  static rowToDisplay(articleRow: ArticleRow): ArticleDisplay {
    return {
      ...articleRow,
      type: 'article',
      due: articleRow.due !== null ? new Date(articleRow.due) : null,
      dismissed: Boolean(articleRow.dismissed),
    };
  }

  static displayToRow(article: ArticleDisplay): ArticleRow {
    const { type: _, ...rest } = article;
    return {
      ...rest,
      due: article.due !== null ? Date.parse(article.due.toISOString()) : null,
      dismissed: Number(article.dismissed),
    };
  }

  rowToReviewArticle(row: ArticleRow): ReviewArticle | null {
    const base = ArticleManager.rowToBase(row);
    const file = Obsidian.getNote(row.reference, this.app);
    if (!file) {
      if (!row.deleted) {
        void this.markDeleted(row.id, 'article');
      }
      return null;
    }

    const frontmatter = Obsidian.getFrontMatter(file, this.app);
    const fileId = frontmatter?.['ir-id'];
    // id is present but doesn't match
    if (fileId && fileId !== row.id) {
      void this.markDeleted(row.id, 'article');
      return null;
    }

    // some frontmatter is missing; impute it
    if (!fileId || !frontmatter?.tags?.includes(ARTICLE_TAG)) {
      void this.setFrontmatter(file, row.id, ARTICLE_TAG);
    }

    if (row.deleted) {
      void this.markUndeleted(row.id, 'article');
    }

    if (this.plugin.settings.fuzzTextReviews && row.due_fuzz === null) {
      void this.setReviewTimeFuzz(row.id, 'article');
    }

    return {
      data: base,
      file,
    };
  }

  /**
   * Import the passed note as an article
   */
  async import(
    file: TFile,
    priority: number,
    fixedIntervalDays: number | null,
    makeCopy?: boolean
  ) {
    const willCopy = makeCopy ?? this.plugin.settings.copyOnImport;
    try {
      if (willCopy) {
        return await this.importCopy(file, priority, fixedIntervalDays);
      }
      return await this.importInPlace(file, priority, fixedIntervalDays);
    } catch (error) {
      Obsidian.notify(`Failed to import article "${file.name}"`);
      console.error(error);
      return null;
    }
  }

  /**
   * Adopt the snippets taken from a note before it became an article, then
   * bring any view of that note in line with their new owner.
   *
   * An in-place import leaves the snippets where they are, so the note keeps
   * its highlights — they are simply reached by parent id from here on.
   * @param articleFile the copy, when importing as one. The copy takes
   * ownership: the snippets are re-pointed at it and their highlights move
   * with them, so the note that was copied loses its own.
   * @returns the adopted rows, so a caller can report how many changed hands
   */
  private async claimSnippets(
    noteFile: TFile,
    articleId: string,
    articleFile?: TFile
  ): Promise<SnippetRow[]> {
    const snippets = this.plugin.reviewManager?.snippets;
    if (!snippets) return [];

    const adopted = await snippets.adoptOrphans(noteFile, articleId);
    if (adopted.length === 0) return adopted;

    if (articleFile) {
      await snippets.repointSource(adopted, articleFile);
      snippets.offsetTracker.loadHighlights(noteFile.path, []);
    } else {
      // Reload under the new parent id so the tracker holds the same
      // highlights the backlink lookup used to supply.
      await snippets.getHighlights(noteFile);
    }

    this.app.workspace.trigger('ir-highlights-changed', noteFile.path);
    return adopted;
  }

  /**
   * Import a note directly
   */
  private async importInPlace(
    file: TFile,
    priority: number,
    fixedIntervalDays: number | null
  ) {
    const frontmatter = Obsidian.getFrontMatter(file, this.app);
    if (frontmatter?.tags?.some((tag) => IMPORT_BLOCKED_TAGS.has(tag))) {
      Obsidian.notify(`Note contains a snippet or card tag; canceling import`);
      return null;
    }

    // Re-associate if the file already carries an ir-id
    const existingId = frontmatter?.['ir-id'];

    const byRef = (await this.repo.query(
      'SELECT id FROM article WHERE reference = $1',
      [file.path]
    )) as (ArticleRow | undefined)[];
    const refMatch = byRef[0];

    if (refMatch && refMatch.id === existingId) {
      // Nothing left to import, but re-running it on an article is the only
      // way a user can repair snippets stranded by an earlier import.
      await this.claimSnippets(file, refMatch.id);
      Obsidian.notify(`Note is already an article; canceling import`);
      return null;
    } else if (refMatch) {
      // reference matches, but no ID or ID doesn't match
      // TODO: option to choose any one of the rows matching the id/reference
      Obsidian.notify(
        `Another article is already at this file path; canceling import`
      );
      return null;
    } else if (existingId) {
      const rows = await this.repo.query(
        'SELECT id FROM article WHERE id = $1',
        [existingId]
      );
      if (rows[0]) {
        await this.repo.mutate(
          'UPDATE article SET reference = $1, deleted = FALSE WHERE id = $2',
          [file.path, existingId]
        );
        await this.claimSnippets(file, existingId);
        Obsidian.notify(
          `Linked "${file.basename}" to existing article with the same ID`
        );
        return this.fetch(existingId);
      }
      // Orphaned id + no reference match: fall through to fresh import
    }

    const id = crypto.randomUUID();
    await Obsidian.updateFrontMatter(
      file,
      { 'ir-id': id, tags: ARTICLE_TAG } satisfies FrontMatterUpdates,
      this.app
    );

    const dueTime = Date.now();
    await this.repo.mutate(
      'INSERT INTO article (id, reference, due, interval, priority, fixed_interval_days) VALUES ($1, $2, $3, $4, $5, $6)',
      [
        id,
        file.path,
        dueTime,
        TEXT_BASE_REVIEW_INTERVAL,
        priority,
        fixedIntervalDays,
      ]
    );

    await this.claimSnippets(file, id);

    const titleSlice = getContentSlice(
      file.basename,
      CONTENT_TITLE_SLICE_LENGTH,
      true
    );
    const schedulingString =
      fixedIntervalDays === null
        ? `priority ${IRScheduler.toDisplayPriority(priority)}`
        : `fixed interval of ${fixedIntervalDays} days`;

    Obsidian.notify(`Imported "${titleSlice}" with ${schedulingString}`);
    return this.fetch(id);
  }

  /**
   * Copy a note to the data directory, then import the copy
   */
  private async importCopy(
    file: TFile,
    priority: number,
    fixedIntervalDays: number | null
  ) {
    // check if the file is inside the plugin's data directory
    if (file.path.startsWith(DATA_DIRECTORY)) {
      Obsidian.notify(
        `Note is already in the plugin data folder; canceling import`
      );
      return null;
    }
    // Read the content of the current file
    const content = await this.app.vault.cachedRead(file);
    const frontmatter = Obsidian.getFrontMatter(file, this.app);
    if (frontmatter?.tags?.some((tag) => IMPORT_BLOCKED_TAGS.has(tag))) {
      Obsidian.notify(`Note contains a snippet or card tag; canceling import`);
      return null;
    }

    // Re-associate if the source already carries an ir-id with a matching DB row
    const existingId = frontmatter?.['ir-id'];
    if (existingId) {
      const rows = await this.repo.query(
        'SELECT id FROM article WHERE id = $1',
        [existingId]
      );
      if (rows[0]) {
        await this.repo.mutate(
          'UPDATE article SET reference = $1, deleted = FALSE WHERE id = $2',
          [file.path, existingId]
        );
        // No copy was made — the record now points at this note, so its
        // snippets are adopted in place rather than handed to a copy.
        await this.claimSnippets(file, existingId);
        Obsidian.notify(
          `Linked "${file.basename}" to existing article with the same ID`
        );
        return this.fetch(existingId);
      }
      // Orphaned ir-id: warn but proceed with creating the copy
      Obsidian.notify(
        `Warning: source note has article metadata but no ` +
          `matching record; creating copy`,
        true
      );
    }

    // check if an article with this name already exists
    if (Obsidian.isDuplicate(file.name, 'article', this.app)) {
      Obsidian.notify(
        `Warning: article with name already exists "${file.name}"`,
        true
      );
    }

    let importFileName = file.name;
    while (Obsidian.isDuplicate(importFileName, 'article', this.app)) {
      importFileName = `${file.basename} - ${generateId()}.${file.extension}`;
    }

    // Create a copy in the articles directory
    const articleFile = await Obsidian.createNote({
      content,
      frontmatter: {
        created: new Date().toISOString(),
      },
      fileName: importFileName,
      directory: Obsidian.getDirectory('article'),
      app: this.app,
    });

    if (!articleFile) {
      throw new Error(
        `Failed to create note ${Obsidian.getTargetPath(importFileName, 'article')}`
      );
    }

    const id = crypto.randomUUID();

    // Tag it and create a link to the source if it doesn't exist
    const frontmatterUpdates: FrontMatterUpdates = {
      'ir-id': id,
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
    await Obsidian.updateFrontMatter(articleFile, frontmatterUpdates, this.app);

    // Insert into database with immediate due time
    const dueTime = Date.now();
    await this.repo.mutate(
      'INSERT INTO article (id, reference, due, interval, priority, fixed_interval_days) VALUES ($1, $2, $3, $4, $5, $6)',
      [
        id,
        articleFile.path,
        dueTime,
        TEXT_BASE_REVIEW_INTERVAL,
        priority,
        fixedIntervalDays,
      ]
    );

    const adopted = await this.claimSnippets(file, id, articleFile);

    const titleSlice = getContentSlice(
      articleFile.basename,
      CONTENT_TITLE_SLICE_LENGTH,
      true
    );

    let snippetMigratedNotice = '';
    if (adopted.length > 0) {
      const snippetMigrationCount =
        adopted.length === 1
          ? '1 snippet now refers'
          : `${adopted.length} snippets now refer`;

      snippetMigratedNotice = `; ${snippetMigrationCount} to the copy`;
    }

    const schedulingString =
      fixedIntervalDays === null
        ? `priority ${IRScheduler.toDisplayPriority(priority)}`
        : `fixed interval of ${fixedIntervalDays} days`;

    Obsidian.notify(
      `Imported "${titleSlice}" with ${schedulingString}` +
        snippetMigratedNotice
    );
    return this.fetch(id);
  }

  /**
   * Create a new empty article
   */
  async create(priority: number, directory?: string) {
    try {
      const newNoteName = Obsidian.createTitle(
        `New article ${getDateString()}`
      );

      const id = crypto.randomUUID();

      let targetDirectory = Obsidian.getDirectory('article');
      if (directory && this.plugin.settings.createEmptyInCurrentFolder) {
        targetDirectory = directory;
      }

      const articleFile = await Obsidian.createNote({
        content: '',
        frontmatter: {
          'ir-id': id,
          created: new Date().toISOString(),
        },
        fileName: `${newNoteName}.md`,
        directory: targetDirectory,
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
      await this.repo.mutate(
        'INSERT INTO article (id, reference, due, interval, priority) VALUES ($1, $2, $3, $4, $5)',
        [id, articleFile.path, dueTime, TEXT_BASE_REVIEW_INTERVAL, priority]
      );

      const result = await this.fetch(id);
      return result;
    } catch (error) {
      Obsidian.notify(`Failed to create empty article`);
      console.error(error);
      return null;
    }
  }

  async getDue(
    dueBy?: number,
    limit?: number,
    excludeIds?: string[]
  ): Promise<ReviewArticle[]> {
    const dueTime =
      dueBy ?? getEndOfDay(this.plugin.settings.dayRolloverOffset);
    let allExcluded = [...(excludeIds ?? [])];
    let due: ReviewArticle[];
    try {
      // keep fetching until all fetched rows have a note
      let lastMissingNotes = 0;
      do {
        lastMissingNotes = 0;
        due = (
          await this.fetchMany({
            dueBy: dueTime,
            limit,
            excludeIds: allExcluded,
          })
        )
          .map((row) => {
            const item = this.rowToReviewArticle(row);
            if (!item) {
              allExcluded.push(row.id);
              lastMissingNotes += 1;
            }
            return item;
          }, this)
          .filter(
            (article): article is ReviewArticle =>
              !!article && article.file !== null
          );

        if (this.plugin.settings.fuzzTextReviews) {
          due.sort((a, b) => compareFuzzedDue(a.data, b.data));
        }
      } while (lastMissingNotes > 0);
      return due;
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
    includeDeleted?: boolean;
    excludeIds?: string[];
  }) {
    let query = 'SELECT * FROM article';
    const conditions = [];
    const params = [];
    if (opts?.dueBy !== undefined) {
      params.push(opts.dueBy);
      conditions.push(`due <= $${params.length}`);
    }
    if (!opts?.includeDismissed) {
      conditions.push('dismissed = 0');
    }

    if (!opts?.includeDeleted) {
      conditions.push('deleted = FALSE');
    }

    if (opts?.excludeIds && opts.excludeIds.length) {
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

    // fuzzed due ASC (nulls last) so LIMIT truncates in presentation order
    query += ' ORDER BY (due IS NULL), due + COALESCE(due_fuzz, 0)';

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

  protected async getReviewCount(article: IArticleBase) {
    const queryResult = (await this.repo.query(
      `SELECT COUNT(id) FROM article_review WHERE article_id = $1`,
      [article.id]
    )) as unknown as [{ 'COUNT(id)': number }];
    const reviewCount = queryResult[0]['COUNT(id)'];
    return reviewCount;
  }

  /**
   * Add an ArticleReview and update the due date and interval in a transaction.
   * @returns the id of the inserted `article_review` row
   * @throws if either write fails, leaving the db unchanged
   */
  async review(
    article: IArticleBase,
    reviewTime?: number,
    nextReviewInterval?: number
  ) {
    const reviewed = reviewTime ?? Date.now();
    const nextInterval =
      nextReviewInterval ?? IRScheduler.nextInterval(article);
    const nextDueTime = reviewed + nextInterval;
    const newFuzz = this.plugin.settings.fuzzTextReviews
      ? IRScheduler.getDueFuzz()
      : article.due_fuzz;
    const reviewId = crypto.randomUUID();

    await this.repo.transaction(async () => {
      await this.repo.mutate(
        'INSERT INTO article_review (id, article_id, review_time) VALUES ($1, $2, $3)',
        [reviewId, article.id, reviewed]
      );
      await this.repo.mutate(
        `UPDATE article SET dismissed = 0, due = $1, interval = $2, due_fuzz = $3 WHERE id = $4`,
        [nextDueTime, nextInterval, newFuzz, article.id]
      );
    });

    return reviewId;
  }

  /**
   * Reset the article and remove all reviews from the specified one onwards
   */
  async undoReview(originalArticle: IArticleBase, reviewId: string) {
    await this.repo.transaction(async () => {
      const reviewRow = (
        await this.repo.query(`SELECT * FROM article_review WHERE id = $1`, [
          reviewId,
        ])
      )[0] as IArticleReview;
      if (!reviewRow)
        throw new Error(`No article review found with ID "${reviewId}"`);
      await this.repo.mutate(
        `DELETE FROM article_review WHERE article_id = $1 AND (id = $2 OR review_time > $3`,
        [originalArticle.id, reviewId, reviewRow.review_time]
      );
      await this.repo.mutate(
        `UPDATE article SET dismissed = $1, due = $2, interval = $3, due_fuzz = $4 WHERE id = $5`,
        [
          originalArticle.dismissed,
          originalArticle.due,
          originalArticle.interval,
          originalArticle.due_fuzz,
          originalArticle.id,
        ]
      );
    });
  }

  /**
   * @param newName The basename excluding the file extension
   */
  async rename(article: ReviewArticle, newName: string) {
    const sanitized = Obsidian.sanitizeForTitle(newName, true);
    if (sanitized !== newName) {
      Obsidian.notify(INVALID_TITLE_MESSAGE);
      return;
    }

    const { file } = article;
    const currentName = file.basename;
    try {
      await Obsidian.renameFile(file, newName, this.app);
      const newPath = file.parent
        ? `${file.parent.path}/${newName}.${file.extension}`
        : `${newName}.${file.extension}`;

      await this.repo.mutate(
        `UPDATE article SET reference = $1 WHERE id = $2`,
        [newPath, article.data.id]
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
  /**
   * @param fixedInterval the interval in days
   */
  async setFixedInterval(article: IArticleBase, fixedIntervalDays: number) {
    try {
      IRScheduler.validateFixedInterval(fixedIntervalDays);

      const lastReview = await this.getLastReview(article);
      const fixedIntervalMs = IRScheduler.nextInterval({
        ...article,
        fixed_interval_days: fixedIntervalDays,
      });
      const newDueTime = lastReview
        ? lastReview.review_time + fixedIntervalMs
        : article.due;

      await this.repo.mutate(
        `UPDATE article SET fixed_interval_days = $1, due = $2 ` +
          `WHERE id = $3`,
        [fixedIntervalDays, newDueTime, article.id]
      );
    } catch (e) {
      if (e instanceof Error) {
        Obsidian.notify(
          `Failed to set fixed interval for "${article.reference}":` + e.message
        );
      }
      console.error(e);
    }
  }
  /**
   * @param newPriority the priority to use for calculating the interval
   */
  async disableFixedInterval(article: IArticleBase, newPriority: number) {
    try {
      IRScheduler.validatePriority(newPriority);

      const lastReview = await this.getLastReview(article);
      const reviewCount = await this.getReviewCount(article);
      const mult = IRScheduler.getIntervalMultiplier(newPriority);
      const newInterval = TEXT_BASE_REVIEW_INTERVAL * mult ** reviewCount;

      const newDueTime = lastReview
        ? lastReview.review_time + newInterval
        : article.due;

      await this.repo.mutate(
        `UPDATE article SET fixed_interval_days = NULL, due = $1, interval = $2 ` +
          `WHERE id = $3`,
        [newDueTime, newInterval, article.id]
      );
    } catch (_e) {
      Obsidian.notify(
        `Failed to disable fixed interval for article ${article.reference}`
      );
    }
  }
}
