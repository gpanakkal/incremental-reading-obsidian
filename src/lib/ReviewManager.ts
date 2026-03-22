import { type App, type Editor, type MarkdownView } from 'obsidian';
import { isArticle } from '#/lib/types';
import type {
  ArticleRow,
  IArticleBase,
  ISRSCardDisplay,
  ISnippetBase,
  ReviewItem,
  SnippetRow,
  ReviewArticle,
  ReviewCard,
  ReviewSnippet,
} from '#/lib/types';
import type ReviewView from '#/views/ReviewView';
import { DATA_DIRECTORY } from './constants';
import { ArticleManager } from './items/ArticleManager';
import { CardManager } from './items/CardManager';
import { SnippetManager } from './items/SnippetManager';
import { ObsidianHelpers as Obsidian } from './ObsidianHelpers';
import { compareDates } from './utils';
import type { SQLiteRepository } from './types';
import type { TAbstractFile, TFile } from 'obsidian';
import type { Grade } from 'ts-fsrs';

export default class ReviewManager {
  app: App;
  #repo: SQLiteRepository;
  snippets: SnippetManager;
  cards: CardManager;
  articles: ArticleManager;

  constructor(app: App, repo: SQLiteRepository) {
    this.app = app;
    this.#repo = repo;
    this.snippets = new SnippetManager(app, repo);
    this.cards = new CardManager(app, repo);
    this.articles = new ArticleManager(app, repo);
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
   *
   * todo:
   * - handle edge cases (uncommon characters, leading/trailing spaces, )
   * - selections from web viewer
   * - selections from native PDF viewer
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
  async importArticle(file: TFile, priority: number) {
    return this.articles.import(file, priority);
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
   * Fetch all snippets, cards, and articles ready for review, then order by due ASC
   * TODO:
   * - paginate
   * - allow filtering out a list of IDs
   * @param dueBy Unix timestamp. Defaults to current time.
   */
  async getDue({
    dueBy,
    limit = 1,
    excludeIds,
  }: {
    dueBy?: number;
    limit?: number;
    excludeIds?: string[];
  }) {
    try {
      const cardsDue = await this.cards.getDue(dueBy, limit, excludeIds);
      const snippetsDue = await this.snippets.getDue(dueBy, limit, excludeIds);
      const articlesDue = await this.articles.getDue(dueBy, limit, excludeIds);
      const allDue = [...cardsDue, ...snippetsDue, ...articlesDue].sort(
        (a, b) => compareDates(a.data.due, b.data.due)
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
   * Fetches a ReviewItem given a file.
   * Returns null if the item is not found in the database.
   */
  async getReviewItemFromFile(file: TFile): Promise<ReviewItem | null> {
    const noteType = Obsidian.getNoteType(file, this.app);
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
    });
    const snippets = await this.snippets.fetchMany({
      includeDismissed: true,
    });
    const cards = await this.cards.fetchMany({
      includeDismissed: true,
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
    const type = Obsidian.getNoteType(item.file, this.app);
    const table = type === 'card' ? 'srs_card' : type;
    await this.#repo.mutate(`UPDATE ${table} SET dismissed = 1 WHERE id = $1`, [
      item.data.id,
    ]);
  }

  async unDismissItem(item: ReviewItem): Promise<void> {
    const type = Obsidian.getNoteType(item.file, this.app);
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
    // TODO: handle files being moved into or out of the IR folder
    const newPath = file.path;
    // console.log(`file rename detected: ${oldPath} -> ${newPath}`);
    const concreteFile = this.app.vault.getFileByPath(newPath);
    if (!concreteFile) {
      throw new Error(`Failed to find a file at ${newPath}`);
    }
    this.snippets.offsetTracker.renameFile(oldPath, newPath);
    const type = Obsidian.getNoteType(concreteFile, this.app);
    if (!type) {
      // console.log(`Found no matching IR tags; ignoring`);
      return;
    }
    if (!oldPath.startsWith(DATA_DIRECTORY)) {
      // console.log('File was not previously in IR directory; ignoring');
      return;
    }
    if (!newPath.startsWith(DATA_DIRECTORY)) {
      // console.log('File is no longer in IR directory; ignoring');
      return;
    }

    const oldReference = Obsidian.getReferenceFromPath(oldPath);
    const newReference = Obsidian.getReferenceFromPath(newPath);
    if (oldReference === newReference) {
      console.warn('File reference did not change; ignoring');
      return;
    }

    const table = type === 'card' ? 'srs_card' : type;
    await this.#repo.mutate(
      `UPDATE ${table} SET reference = $1 WHERE reference = $2`,
      [newReference, oldReference]
    );
    // console.log(`Reference updated to ${newReference}`);
  }

  /**
   * Save scroll position to database for the article or snippet
   */
  async saveScrollPosition(
    file: TFile,
    scrollInfo: { top: number; left: number }
  ) {
    const noteType = Obsidian.getNoteType(file, this.app);
    if (!noteType || noteType === 'card') return;

    const reference = Obsidian.getReferenceFromPath(file.path);

    await this.#repo.mutate(
      `UPDATE ${noteType} SET scroll_top = $1 WHERE reference = $2`,
      [Math.round(scrollInfo.top), reference]
    );
  }

  /**
   * Load scroll position from database for the article or snippet
   */
  async loadScrollPosition(
    file: TFile
  ): Promise<{ top: number; left: number } | null> {
    const noteType = Obsidian.getNoteType(file, this.app);
    if (!noteType || noteType === 'card') return null;

    let row: ArticleRow | SnippetRow | null = null;
    if (noteType === 'article') {
      row = await this.articles.findArticle(file);
    } else if (noteType === 'snippet') {
      row = await this.snippets.findSnippet(file);
    }

    if (row && typeof row.scroll_top === 'number' && row.scroll_top > 0) {
      return { top: row.scroll_top, left: 0 };
    }

    return null;
  }
}
