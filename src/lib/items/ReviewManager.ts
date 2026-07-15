import type {
  QueuePage,
  QueueRow,
  QueueScheduling,
  QueueSubset,
} from '#/components/types';
import { ARTICLE_TAG, CARD_TAG, SNIPPET_TAG } from '#/lib/constants';
import type {
  ArticleRow,
  IArticleBase,
  ISnippetBase,
  ISRSCardDisplay,
  NoteType,
  PluginFrontMatter,
  ReviewArticle,
  ReviewCard,
  ReviewItem,
  ReviewSnippet,
  SnippetRow,
  SRSCardRow,
} from '#/lib/types';
import { getItemType, isArticle } from '#/lib/types';
import type IncrementalReadingPlugin from '#/main';
import type ReviewView from '#/views/ReviewView';
import type { TAbstractFile, TFile } from 'obsidian';
import {
  type App,
  type Editor,
  type MarkdownView,
  normalizePath,
} from 'obsidian';
import type { Grade } from 'ts-fsrs';
import IRScheduler from '../IRScheduler';
import { ObsidianHelpers as Obsidian } from '../ObsidianHelpers';
import type { SQLiteRepository } from '../types';
import { compareDates, compareFuzzedDue, compareStrings } from '../utils';
import { ArticleManager } from './ArticleManager';
import { CardManager } from './CardManager';
import { SnippetManager } from './SnippetManager';

export default class ReviewManager {
  plugin: IncrementalReadingPlugin;
  app: App;
  #repo: SQLiteRepository;
  snippets: SnippetManager;
  cards: CardManager;
  articles: ArticleManager;

  constructor(plugin: IncrementalReadingPlugin, repo: SQLiteRepository) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.#repo = repo;
    this.snippets = new SnippetManager(plugin, repo);
    this.cards = new CardManager(plugin, repo);
    this.articles = new ArticleManager(plugin, repo);
  }

  // TODO: remove for production
  get repo() {
    return this.#repo;
  }

  // #region CARDS
  /**
   * Create an SRS item
   */
  async createCard(editor: Editor, view: MarkdownView | ReviewView) {
    return this.cards.create(editor, view);
  }

  parseCloze(text: string, delimiters: [string, string]) {
    return this.cards.parseCloze(text, delimiters);
  }

  async reviewCard(card: ISRSCardDisplay, grade: Grade, reviewTime?: Date) {
    return this.cards.review(card, grade, reviewTime);
  }
  // #endregion

  // #region SNIPPETS
  /**
   * Save the selected text and add it to the learning queue
   */
  async createSnippet(
    editor: Editor,
    view: MarkdownView | ReviewView,
    firstReview?: number
  ) {
    return this.snippets.create(editor, view, firstReview);
  }

  /**
   * Get all snippet highlights for a parent article or snippet
   * Returns only snippets that have offsets (for highlighting)
   * @param parentFile The parent file to query highlights for
   * @returns Array of snippet highlights
   */
  async getSnippetHighlights(parentFile: TFile) {
    return this.snippets.getHighlights(parentFile);
  }

  /**
   * Update snippet offsets in the database.
   * Used to persist offset changes after document edits.
   * @param startOffset Body-relative start offset
   * @param endOffset Body-relative end offset
   */
  async updateSnippetOffsets(
    snippetId: string,
    startOffset: number,
    endOffset: number
  ) {
    return this.snippets.updateOffsets(snippetId, startOffset, endOffset);
  }

  /**
   * Add a SnippetReview and set the next review date
   */
  async reviewSnippet(
    snippet: ISnippetBase,
    reviewTime?: number,
    nextReviewInterval?: number
  ) {
    return this.snippets.review(snippet, reviewTime, nextReviewInterval);
  }
  // #endregion

  // #region ARTICLES
  /**
   * Import the currently opened note as an article
   */
  async importArticle(
    file: TFile,
    priority: number,
    fixedIntervalDays: number | null,
    makeCopy?: boolean
  ) {
    return this.articles.import(file, priority, fixedIntervalDays, makeCopy);
  }

  async createEmptyArticle(priority: number) {
    return this.articles.create(priority);
  }

  async reviewArticle(
    article: IArticleBase,
    reviewTime?: number,
    nextReviewInterval?: number
  ) {
    return this.articles.review(article, reviewTime, nextReviewInterval);
  }

  /**
   * @param newName The basename excluding the file extension
   */
  async renameArticle(article: ReviewArticle, newName: string) {
    return this.articles.rename(article, newName);
  }

  // #endregion

  /**
   * Change the priority of an article or snippet and recalculate its next due date
   */
  async reprioritize(item: IArticleBase | ISnippetBase, newPriority: number) {
    if (isArticle(item)) {
      return this.articles.reprioritize(item, newPriority);
    }
    return this.snippets.reprioritize(item, newPriority);
  }

  /**
   * Set a new interval without adjusting due date if due in today's review day
   * @param changes an object with the new interval or the new priority
   * @returns
   */
  async manageFixedInterval(
    article: IArticleBase,
    changes: { newIntervalDays: number } | { newPriority: number }
  ) {
    if ('newIntervalDays' in changes) {
      return this.articles.setFixedInterval(article, changes.newIntervalDays);
    } else {
      return this.articles.disableFixedInterval(article, changes.newPriority);
    }
  }

  /**
   * Fetch all snippets, cards, and articles ready for review, then order by
   * fuzzed due, ascending
   * TODO:
   * - paginate
   * @param dueBy Unix timestamp. Defaults to the end of the day plus the rollover offset.
   */
  async getDue({
    dueBy,
    limit = 1,
    excludeIds,
    typesToInclude,
  }: {
    dueBy?: number;
    limit?: number;
    excludeIds?: string[];
    typesToInclude: Partial<Record<NoteType, true>>;
  }) {
    const getCards = 'card' in typesToInclude;
    const getSnippets = 'snippet' in typesToInclude;
    const getArticles = 'article' in typesToInclude;
    try {
      const cardsDue = getCards
        ? await this.cards.getDue(dueBy, limit, excludeIds)
        : [];
      const snippetsDue = getSnippets
        ? await this.snippets.getDue(dueBy, limit, excludeIds)
        : [];
      const articlesDue = getArticles
        ? await this.articles.getDue(dueBy, limit, excludeIds)
        : [];
      const allDue = [...cardsDue, ...snippetsDue, ...articlesDue].sort(
        (a, b) => compareFuzzedDue(a.data, b.data)
      );
      return {
        all: allDue,
        cards: cardsDue,
        snippets: snippetsDue,
        articles: articlesDue,
      };
    } catch (error) {
      console.error(error);
      return { all: [], cards: [], snippets: [], articles: [] };
    }
  }
  /**
   * The scheduling summary shown for an article: its fixed interval when one is
   * set, otherwise its priority. An article never has both at once.
   */
  static articleScheduling(row: ArticleRow): QueueScheduling {
    return row.fixed_interval_days !== null
      ? { kind: 'fixed-interval', value: row.fixed_interval_days.toString() }
      : {
          kind: 'priority',
          value: IRScheduler.toDisplayPriority(row.priority),
        };
  }

  /** Build a QueueRow for an article, resolving its note or returning null. */
  #articleToQueueRow(row: ArticleRow): QueueRow | null {
    const file = Obsidian.getNote(row.reference, this.app);
    if (!file) return null;
    return {
      id: row.id,
      type: 'article',
      file,
      due: row.due === null ? null : new Date(row.due + (row.due_fuzz ?? 0)),
      reference: row.reference,
      scheduling: ReviewManager.articleScheduling(row),
    };
  }

  /** Build a QueueRow for a snippet (always priority-scheduled). */
  #snippetToQueueRow(row: SnippetRow): QueueRow | null {
    const file = Obsidian.getNote(row.reference, this.app);
    if (!file) return null;
    return {
      id: row.id,
      type: 'snippet',
      file,
      due: row.due === null ? null : new Date(row.due + (row.due_fuzz ?? 0)),
      reference: row.reference,
      scheduling: {
        kind: 'priority',
        value: IRScheduler.toDisplayPriority(row.priority),
      },
    };
  }

  /** Build a QueueRow for a card (no fuzz, no priority/interval scheduling). */
  #cardToQueueRow(row: SRSCardRow): QueueRow | null {
    const file = Obsidian.getNote(row.reference, this.app);
    if (!file) return null;
    return {
      id: row.id,
      type: 'card',
      file,
      due: new Date(row.due),
      reference: row.reference,
      scheduling: { kind: 'none', value: null },
    };
  }

  /**
   * Fetch a whole review-queue subset as one sorted, flat array of `QueueRow`.
   * Unlike {@link getDue}, this fetches everything in the subset (no DB
   * pagination / limit).
   */
  async getQueue(subset?: QueueSubset): Promise<QueuePage> {
    const dueBy = subset?.date?.getTime() ?? Number.POSITIVE_INFINITY;

    const [articleRows, snippetRows, cardRows] = await Promise.all([
      this.articles.fetchMany({ dueBy }),
      this.snippets.fetchMany({ dueBy }),
      this.cards.fetchMany({ dueBy }),
    ]);

    const rows: QueueRow[] = [
      ...articleRows.map((row) => this.#articleToQueueRow(row)),
      ...snippetRows.map((row) => this.#snippetToQueueRow(row)),
      ...cardRows.map((row) => this.#cardToQueueRow(row)),
    ].filter((row): row is QueueRow => row !== null);

    // `due` is already the fuzzed timestamp, so ordering by it is fuzz order;
    // rows with no due time sort last (compareDates puts nulls at the end).
    // Ties break on (type, id) so pagination is stable across calls even when
    // the DB returns tied rows in a different order.
    rows.sort(
      (a, b) =>
        compareDates(a.due, b.due) ||
        compareStrings(a.type, b.type) ||
        compareStrings(a.id, b.id)
    );

    const slice = subset?.slice;
    const totalRows = rows.length;
    if (!slice) return { rows, totalRows };

    const lastPage = Math.max(
      0,
      Math.ceil(totalRows / slice.entriesPerPage) - 1
    );
    const page = Math.min(slice.pageNumber, lastPage);
    const start = page * slice.entriesPerPage;
    return {
      rows: rows.slice(start, start + slice.entriesPerPage),
      totalRows,
    };
  }

  /**
   * Fetches a ReviewItem given a file.
   * Returns null if the item is not found in the database.
   */
  async getReviewItemFromFile(file: TFile): Promise<ReviewItem | null> {
    const noteType = await Obsidian.getNoteType(file, this.app);
    if (noteType === 'article') {
      const row = await this.articles.findArticle(file);
      if (!row) return null;
      return {
        data: ArticleManager.rowToBase(row),
        file,
      } satisfies ReviewArticle;
    } else if (noteType === 'snippet') {
      const row = await this.snippets.findSnippet(file);
      if (!row) return null;
      return {
        data: SnippetManager.rowToBase(row),
        file,
      } satisfies ReviewSnippet;
    } else if (noteType === 'card') {
      const row = await this.cards.findCard(file);
      if (!row) return null;
      return { data: CardManager.rowToDisplay(row), file } satisfies ReviewCard;
    }
    return null;
  }
  /**
   * Fetches a ReviewItem.
   * Returns null if the item is not found in the database.
   */
  async getReviewItemFromId(itemId: string): Promise<ReviewItem | null> {
    let row: ReviewItem | null = await this.articles.fetch(itemId);
    if (!row) row = await this.snippets.fetch(itemId);
    if (!row) row = await this.cards.fetch(itemId);
    return row;
  }

  async _logItems() {
    const articles = await this.articles.fetchMany({
      includeDismissed: true,
      includeDeleted: true,
    });
    const snippets = await this.snippets.fetchMany({
      includeDismissed: true,
      includeDeleted: true,
    });
    const cards = await this.cards.fetchMany({
      includeDismissed: true,
      includeDeleted: true,
    });

    if (!articles && !snippets && !cards) {
      // eslint-disable-next-line no-console
      console.log('No entries found');
      return;
    }
    // eslint-disable-next-line no-console
    console.table(articles.map((el) => ArticleManager.rowToDisplay(el)));
    // eslint-disable-next-line no-console
    console.table(snippets.map((el) => SnippetManager.rowToDisplay(el)));
    // eslint-disable-next-line no-console
    console.table(cards.map((el) => CardManager.rowToDisplay(el)));
  }

  async dismissItem(item: ReviewItem): Promise<void> {
    const type: NoteType = getItemType(item);
    const table = type === 'card' ? 'srs_card' : type;
    await this.#repo.mutate(`UPDATE ${table} SET dismissed = 1 WHERE id = $1`, [
      item.data.id,
    ]);
  }

  async unDismissItem(item: ReviewItem): Promise<void> {
    const type: NoteType = getItemType(item);
    const table = type === 'card' ? 'srs_card' : type;
    await this.#repo.mutate(`UPDATE ${table} SET dismissed = 0 WHERE id = $1`, [
      item.data.id,
    ]);
  }

  /**
   * Update database references in response to Obsidian rename events
   * @param oldPath The vault-relative path the file had before it was moved
   */
  async handleExternalRename(file: TAbstractFile, oldPath: string) {
    const newPath = file.path;
    // console.log(`file rename detected: ${oldPath} -> ${newPath}`);
    const concreteFile = this.app.vault.getFileByPath(newPath);
    if (!concreteFile) {
      throw new Error(`Failed to find a file at ${newPath}`);
    }

    let type: string | null = null,
      rowId: string | undefined;
    await this.app.fileManager.processFrontMatter(
      concreteFile,
      (frontmatter: PluginFrontMatter) => {
        if (frontmatter.tags === undefined) return;
        rowId = frontmatter['ir-id'];
        if (frontmatter.tags.includes(ARTICLE_TAG)) type = 'article';
        else if (frontmatter.tags.includes(SNIPPET_TAG)) type = 'snippet';
        else if (frontmatter.tags.includes(CARD_TAG)) type = 'card';
      }
    );
    if (!type) {
      // console.log(`Found no matching IR tags; ignoring`);
      return;
    }

    this.snippets.offsetTracker.renameFile(oldPath, file.path);
    const table = type === 'card' ? 'srs_card' : type;

    if (rowId) {
      await this.#repo.mutate(
        `UPDATE ${table} SET reference = $1 WHERE id = $2`,
        [file.path, rowId]
      );
    } else {
      if (oldPath === file.path) {
        console.warn('File reference did not change; ignoring');
        return;
      }

      await this.#repo.mutate(
        `UPDATE ${table} SET reference = $1 WHERE reference = $2`,
        [file.path, oldPath]
      );
    }
    // console.log(`Reference updated to ${newReference}`);
  }

  /**
   * Mark rows as deleted
   */
  async handleDeletion(file: TAbstractFile) {
    const match = await this.articles.findItem(file);
    if (!match) return;

    const { row, table } = match;
    if (table === 'snippet') {
      const parent = (row as SnippetRow).parent;
      if (parent) {
        this.snippets.offsetTracker.removeHighlight(
          normalizePath(parent),
          row.id
        );
      }
    }
    await this.#repo.mutate(
      `UPDATE ${table} SET deleted = TRUE WHERE reference = $1`,
      [file.path]
    );
  }

  /**
   * Mark rows as un-deleted where appropriate
   */
  async handleCreation(file: TAbstractFile) {
    const concreteFile = this.app.vault.getFileByPath(file.path);
    if (!concreteFile) return;

    let id: string | undefined;
    let type: string | null = null;
    await this.app.fileManager.processFrontMatter(
      concreteFile,
      (frontmatter: PluginFrontMatter) => {
        if (!frontmatter?.['ir-id']) return;
        id = frontmatter['ir-id'];
        if (frontmatter.tags?.includes(ARTICLE_TAG)) type = 'article';
        else if (frontmatter.tags?.includes(SNIPPET_TAG)) type = 'snippet';
        else if (frontmatter.tags?.includes(CARD_TAG)) type = 'card';
      }
    );

    if (!id || type === null) return;

    const table = type === 'card' ? 'srs_card' : type;
    await this.#repo.mutate(
      `UPDATE ${table} SET deleted = FALSE, reference = $1 WHERE id = $2`,
      [file.path, id]
    );
  }
  /**
   * Save scroll position to database for the article or snippet
   */
  async saveScrollPosition(
    file: TFile,
    scrollInfo: { top: number; left: number }
  ) {
    const noteType = await Obsidian.getNoteType(file, this.app);
    if (!noteType || noteType === 'card') return;

    await this.#repo.mutate(
      `UPDATE ${noteType} SET scroll_top = $1 WHERE reference = $2`,
      [Math.round(scrollInfo.top), file.path]
    );
  }

  /**
   * Load scroll position from database for the article or snippet
   */
  async loadScrollPosition(
    file: TFile
  ): Promise<{ top: number; left: number } | null> {
    const noteType = await Obsidian.getNoteType(file, this.app);

    let row: ArticleRow | SnippetRow | null = null;
    if (noteType === 'article') {
      row = await this.articles.findArticle(file);
    } else if (noteType === 'snippet') {
      row = await this.snippets.findSnippet(file);
    }

    if (row && row.scroll_top > 0) {
      return { top: row.scroll_top, left: 0 };
    }

    return null;
  }
}
