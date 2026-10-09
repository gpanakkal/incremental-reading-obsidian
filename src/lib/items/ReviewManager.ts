import type {
  QueueCardMemory,
  QueuePage,
  QueueRow,
  QueueScheduling,
  QueueSubset,
} from '#/components/types';
import { refusedCharsIn } from '#/lib/item-path-guard';
import { batchAfterLinkUpdates } from '#/lib/link-update-queue';
import { appendLog } from '#/lib/log-file';
import {
  extensionOfPath,
  getMimeType,
  isImportable,
  supportsFrontmatter,
} from '#/lib/mime';
import {
  describeReclaim,
  REBIND_LOG_TOPIC,
  reclaimAtPath,
} from '#/lib/rebind-records';
import {
  type ArticleRow,
  type IArticleBase,
  type ISnippetBase,
  type ISRSCardDisplay,
  type MaybeMissingItem,
  type NoteType,
  type ReviewArticle,
  type ReviewCard,
  type ReviewItem,
  type ReviewSnippet,
  type SnippetRow,
  type SRSCardRow,
  isArticle,
} from '#/lib/types';
import type IncrementalReadingPlugin from '#/main';
import type ReviewView from '#/views/ReviewView';
import {
  type App,
  type Editor,
  type MarkdownView,
  type TAbstractFile,
  type TFile,
} from 'obsidian';
import type { Grade } from 'ts-fsrs';
import IRScheduler from '../IRScheduler';
import { evictedSpot } from '../moved-note-scan';
import { ObsidianHelpers as Obsidian } from '../ObsidianHelpers';
import type { SQLiteRepository } from '../types';
import {
  compareDates,
  compareFuzzedDue,
  compareStrings,
  getEndOfDay,
} from '../utils';
import { ArticleManager } from './ArticleManager';
import { type CardSelection, CardManager } from './CardManager';
import { type FileMove, followSourceLinks } from './follow-source-links';
import { SnippetManager } from './SnippetManager';

/**
 * Whether links to the file `move` moved can need following: it went
 * somewhere else, as a type of file an item can be taken from (any that can be
 * imported), and is still that type. Links to a note renamed to a PDF, or the
 * other way round, name a file that isn't there any more.
 */
function isFollowable({ from, file }: FileMove): boolean {
  return (
    from !== file.path &&
    isImportable(file) &&
    getMimeType({ extension: extensionOfPath(from) }) === getMimeType(file)
  );
}

/** `path`, when it breaks links to the item there; else `null`. */
const refusedAt = (path: string) =>
  refusedCharsIn(path).length > 0 ? path : null;

/**
 * The `ir-id` a note's frontmatter holds. An id is a string; anything else
 * there, a number say, matches no row by id, so it counts as no id.
 */
function irIdOf(frontmatter: Record<string, unknown>): string | undefined {
  const id = frontmatter['ir-id'];
  return typeof id === 'string' ? id : undefined;
}

export default class ReviewManager {
  plugin: IncrementalReadingPlugin;
  app: App;
  #repo: SQLiteRepository;
  snippets: SnippetManager;
  cards: CardManager;
  articles: ArticleManager;
  /** Follows the links to files that moved: see {@link handleExternalRename}. */
  #followMoves: (moves: Promise<readonly FileMove[]>) => void;

  constructor(plugin: IncrementalReadingPlugin, repo: SQLiteRepository) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.#repo = repo;
    this.snippets = new SnippetManager(plugin, repo);
    this.cards = new CardManager(plugin, repo);
    this.articles = new ArticleManager(plugin, repo);
    this.#followMoves = batchAfterLinkUpdates(this.app, (moves) =>
      followSourceLinks(this.articles, moves)
    );
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

  /** Create an SRS item from a span chosen in selection mode */
  async createCardFromSelection(
    editor: Editor,
    view: MarkdownView | ReviewView,
    selection: CardSelection,
    answer: readonly [number, number]
  ) {
    return this.cards.createFromSelection(editor, view, selection, answer);
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
   * Re-read cached snippet highlights from the database and notify open views.
   * Used when the database is replaced by a synced copy from another device.
   */
  async refreshAllHighlights() {
    return await this.snippets.refreshAllHighlights();
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
   * Update several snippets' offsets at once, saving the database file once
   * rather than once per snippet. See {@link SnippetManager.updateManyOffsets}.
   */
  async updateManySnippetOffsets(
    highlights: Parameters<SnippetManager['updateManyOffsets']>[0]
  ) {
    return this.snippets.updateManyOffsets(highlights);
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

  async createEmptyArticle(priority: number, directory?: string) {
    return this.articles.create(priority, directory);
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
   * @returns whether it was renamed
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

  /**
   * Map every article and snippet id to its vault path, so a child row's
   * `parent` id can be shown as a path. Fetched separately from the due rows
   * because a parent need not itself be due.
   */
  async #getParentPaths(): Promise<Map<string, string>> {
    const rows = (await this.#repo.query(
      'SELECT id, reference FROM article UNION ALL SELECT id, reference FROM snippet'
    )) as { id: string; reference: string }[] | null;
    return new Map((rows ?? []).map((row) => [row.id, row.reference]));
  }

  /**
   * Single-parent counterpart of {@link #getParentPaths}, for refreshing one
   * queue row without loading the whole id → path map.
   */
  async #getParentPath(parentId: string | null): Promise<Map<string, string>> {
    if (parentId === null) return new Map();
    const rows = (await this.#repo.query(
      'SELECT id, reference FROM article WHERE id = $1 ' +
        'UNION ALL SELECT id, reference FROM snippet WHERE id = $1',
      [parentId]
    )) as { id: string; reference: string }[] | null;
    return new Map((rows ?? []).map((row) => [row.id, row.reference]));
  }

  /**
   * The FSRS memory state shown for a card.
   */
  cardMemory(row: SRSCardRow, now: Date = new Date()): QueueCardMemory {
    const retrievability =
      row.last_review === null
        ? null
        : this.cards
            .getFsrs()
            .get_retrievability(CardManager.rowToDisplay(row), now, false);
    return {
      difficulty: row.difficulty,
      stability: row.stability,
      retrievability,
    };
  }

  /**
   * The note an article was imported from. Articles have no `parent` field: their
   * origin is the `source` frontmatter link written at import time, so it is
   * read from the metadata cache (already in memory) and resolved to a vault
   * path. An unresolvable link falls back to its own text, which is still more
   * use than showing nothing.
   */
  #articleSource(file: TFile): string | null {
    const source = Obsidian.getFrontMatter(file, this.app)?.source;
    if (!source) return null;
    return Obsidian.getSourceFile(file, this.app)?.path ?? source;
  }

  /**
   * Build a QueueRow for an article, resolving its note. A missing item keeps
   * its row, with no file: the queue is where it is found and relinked.
   */
  #articleToQueueRow(row: ArticleRow): QueueRow {
    const file = Obsidian.getNote(row.reference, this.app);
    return {
      id: row.id,
      type: 'article',
      file,
      due: row.due === null ? null : new Date(row.due + (row.due_fuzz ?? 0)),
      reference: row.reference,
      parent: file && this.#articleSource(file),
      scheduling: ReviewManager.articleScheduling(row),
    };
  }

  /** Build a QueueRow for a snippet (always priority-scheduled). */
  #snippetToQueueRow(
    row: SnippetRow,
    parentPaths: Map<string, string>
  ): QueueRow {
    const file = Obsidian.getNote(row.reference, this.app);
    return {
      id: row.id,
      type: 'snippet',
      file,
      due: row.due === null ? null : new Date(row.due + (row.due_fuzz ?? 0)),
      reference: row.reference,
      parent: (row.parent && parentPaths.get(row.parent)) || null,
      scheduling: {
        kind: 'priority',
        value: IRScheduler.toDisplayPriority(row.priority),
      },
    };
  }

  /** Build a QueueRow for a card (no fuzz; scheduled by FSRS memory state). */
  #cardToQueueRow(row: SRSCardRow, parentPaths: Map<string, string>): QueueRow {
    const file = Obsidian.getNote(row.reference, this.app);
    return {
      id: row.id,
      type: 'card',
      file,
      due: new Date(row.due),
      reference: row.reference,
      parent: (row.parent && parentPaths.get(row.parent)) || null,
      scheduling: { kind: 'srs', value: this.cardMemory(row) },
    };
  }

  /**
   * Fetch a whole review-queue subset as one sorted, flat array of `QueueRow`.
   * Unlike {@link getDue}, this fetches everything in the subset (no DB
   * pagination / limit).
   */
  async getQueue(subset?: QueueSubset): Promise<QueuePage> {
    const dueBy = subset?.date?.getTime() ?? Number.POSITIVE_INFINITY;

    const [articleRows, snippetRows, cardRows, parentPaths] = await Promise.all(
      [
        this.articles.fetchMany({ dueBy }),
        this.snippets.fetchMany({ dueBy }),
        this.cards.fetchMany({ dueBy }),
        this.#getParentPaths(),
      ]
    );

    const rows: QueueRow[] = [
      ...articleRows.map((row) => this.#articleToQueueRow(row)),
      ...snippetRows.map((row) => this.#snippetToQueueRow(row, parentPaths)),
      ...cardRows.map((row) => this.#cardToQueueRow(row, parentPaths)),
    ];

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

    // The dated span of the whole queue, read off the sorted array before it
    // is sliced. Rows are due-ascending with undated ones last, so the first
    // row bounds the low end and the last *dated* row the high end. Scanned
    // back by hand rather than with `findLast`, which is ES2023 and outside
    // this project's ES2022 target.
    const firstDue = rows[0]?.due ?? null;
    let lastDue: Date | null = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const { due } = rows[i];
      if (due !== null) {
        lastDue = due;
        break;
      }
    }

    const slice = subset?.slice;
    const totalRows = rows.length;
    if (!slice) return { rows, totalRows, firstDue, lastDue };

    const lastPage = Math.max(
      0,
      Math.ceil(totalRows / slice.entriesPerPage) - 1
    );
    const page = Math.min(slice.pageNumber, lastPage);
    const start = page * slice.entriesPerPage;
    return {
      rows: rows.slice(start, start + slice.entriesPerPage),
      totalRows,
      firstDue,
      lastDue,
    };
  }

  /**
   * Find the 0-based page holding the first queued item due on or after the
   * start of `date`'s day, given a page size of `entriesPerPage`.
   *
   * Paging is uniform, so the page is just the row's rank divided by the page
   * size. Resolving this here rather than in the client keeps queue ordering
   * in one place ({@link getQueue}) and avoids shipping the whole queue to the
   * UI, which only ever holds a single page.
   *
   * Returns the last page when nothing is due that late, and 0 for an empty
   * queue.
   */
  async findPageForDate(date: Date, entriesPerPage: number): Promise<number> {
    const { rows } = await this.getQueue();
    const lastPage = Math.max(0, Math.ceil(rows.length / entriesPerPage) - 1);

    // One review day ends where the next begins, so the start of `date`'s day
    // is the end of the day before it.
    const yesterday = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate() - 1
    );
    const start = getEndOfDay(
      this.plugin.settings.dayRolloverOffset,
      yesterday
    );
    // Rows with no due time sort last and can never satisfy the jump.
    const index = rows.findIndex(
      (row) => row.due !== null && row.due.getTime() >= start
    );
    if (index === -1) return lastPage;
    return Math.floor(index / entriesPerPage);
  }

  /**
   * Resolve a single item id to its current {@link QueueRow}, or `null` when
   * the row no longer belongs in the review queue (dismissed, deleted, or with
   * no due time). A missing item still does. Mirrors the inclusion rules {@link getQueue} applies,
   * so a targeted queue update can refetch just the changed row.
   */
  async getQueueRow(id: string): Promise<QueueRow | null> {
    const articleRow = (
      await this.#repo.query('SELECT * FROM article WHERE id = $1', [id])
    )[0] as ArticleRow | undefined;
    if (articleRow) {
      return this.#includeInQueue(articleRow)
        ? this.#articleToQueueRow(articleRow)
        : null;
    }

    const snippetRow = (
      await this.#repo.query('SELECT * FROM snippet WHERE id = $1', [id])
    )[0] as SnippetRow | undefined;
    if (snippetRow) {
      if (!this.#includeInQueue(snippetRow)) return null;
      return this.#snippetToQueueRow(
        snippetRow,
        await this.#getParentPath(snippetRow.parent)
      );
    }

    const cardRow = (
      await this.#repo.query('SELECT * FROM srs_card WHERE id = $1', [id])
    )[0] as SRSCardRow | undefined;
    if (cardRow) {
      if (!this.#includeInQueue(cardRow)) return null;
      return this.#cardToQueueRow(
        cardRow,
        await this.#getParentPath(cardRow.parent ?? null)
      );
    }

    return null;
  }

  /**
   * Whether a raw row currently qualifies for the queue: not dismissed, not
   * deleted, and with a due time. Matches the `fetchMany` filters used by
   * {@link getQueue} (which selects `dismissed = 0 AND deleted = FALSE` and,
   * because it filters on `due <= dueBy`, never returns null-due rows).
   */
  #includeInQueue(row: ArticleRow | SnippetRow | SRSCardRow): boolean {
    return !row.dismissed && !row.deleted && row.due !== null;
  }

  /**
   * Fetches a ReviewItem given a file.
   * Returns null if the item is not found in the database.
   */
  async getReviewItemFromFile(file: TFile): Promise<ReviewItem | null> {
    const noteType = await this.articles.getItemType(file);
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

  /**
   * The item with id `itemId` as review shows it: with its file, or as a
   * {@link MissingItem} when a live row has no file at its reference. `null`
   * for no such row, a tombstone, or a note that belongs to another item.
   */
  async getItemOrMissingFromId(
    itemId: string
  ): Promise<MaybeMissingItem | null> {
    const item = await this.getReviewItemFromId(itemId);
    if (item) return item;

    const [article] = (await this.#repo.query(
      'SELECT * FROM article WHERE id = $1 AND deleted = FALSE',
      [itemId]
    )) as ArticleRow[];
    if (article)
      return this.articles.asMissing(ArticleManager.rowToBase(article));

    const [snippet] = (await this.#repo.query(
      'SELECT * FROM snippet WHERE id = $1 AND deleted = FALSE',
      [itemId]
    )) as SnippetRow[];
    if (snippet)
      return this.snippets.asMissing(SnippetManager.rowToBase(snippet));

    const [card] = (await this.#repo.query(
      'SELECT * FROM srs_card WHERE id = $1 AND deleted = FALSE',
      [itemId]
    )) as SRSCardRow[];
    if (card) return this.cards.asMissing(CardManager.rowToDisplay(card));

    return null;
  }

  async dismissItem(item: MaybeMissingItem): Promise<void> {
    const type = item.data.type;
    const table = type === 'card' ? 'srs_card' : type;
    await this.#repo.mutate(`UPDATE ${table} SET dismissed = 1 WHERE id = $1`, [
      item.data.id,
    ]);
    // Here rather than in `Actions.dismissItem`, because the note's own action
    // bar dismisses through this method directly and never reaches `Actions` —
    // and that is precisely the case with no review tab open, where nothing
    // else is watching the item the session still points at.
    this.plugin.sessionTracker?.forgetIf(item.data.id);
  }

  async unDismissItem(item: MaybeMissingItem): Promise<void> {
    const type = item.data.type;
    const table = type === 'card' ? 'srs_card' : type;
    await this.#repo.mutate(`UPDATE ${table} SET dismissed = 0 WHERE id = $1`, [
      item.data.id,
    ]);
  }

  /**
   * Whether `file`, which was at `path`, is an item's file: a live row names
   * `path`, and a note there carries that row's `ir-id` (see
   * `ItemPathGuard`). A file with no frontmatter, a PDF say, is known by its
   * path alone.
   *
   * Answers at once, for the `rename` event it is asked from: sql.js answers a
   * query at once, and (undocumented, read from obsidian.asar: its
   * `MetadataCache.onRename` is a `rename` listener registered before any
   * plugin's) the metadata cache moves a note's cache before a plugin hears
   * of the rename. A repository that answers later can't be waited on there,
   * so it gets no.
   */
  isItemFileAt(file: TFile, path: string): boolean {
    const rows = this.#repo.query(
      `SELECT id FROM article WHERE reference = $1 AND deleted = FALSE
       UNION ALL SELECT id FROM snippet WHERE reference = $1 AND deleted = FALSE
       UNION ALL SELECT id FROM srs_card WHERE reference = $1 AND deleted = FALSE`,
      [path]
    );
    if (!Array.isArray(rows)) return false;
    if (!supportsFrontmatter(file)) return rows.length > 0;
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const id = irIdOf(frontmatter ?? {});
    return (rows as unknown as { id: string }[]).some((row) => row.id === id);
  }

  /**
   * The paths in the folder at `folder`, at any depth, that live item rows
   * name: one look for a whole folder (see `ItemPathGuard`). Answers at once,
   * as {@link isItemFileAt} does, or not at all.
   */
  referencesUnder(folder: string): ReadonlySet<string> {
    // `0` sorts right after `/`, so the range is every path under the folder
    const rows = this.#repo.query(
      `SELECT reference FROM article
         WHERE deleted = FALSE AND reference >= $1 AND reference < $2
       UNION ALL SELECT reference FROM snippet
         WHERE deleted = FALSE AND reference >= $1 AND reference < $2
       UNION ALL SELECT reference FROM srs_card
         WHERE deleted = FALSE AND reference >= $1 AND reference < $2`,
      [`${folder}/`, `${folder}0`]
    );
    if (!Array.isArray(rows)) return new Set();
    return new Set(
      (rows as unknown as { reference: string }[]).map(
        ({ reference }) => reference
      )
    );
  }

  /**
   * The paths, in order, of the items' files whose paths hold a character
   * that breaks links to them (see `REFUSED_PATH_CHARS`): made before the
   * rule, or moved while Obsidian was closed. For the startup warning.
   */
  async itemPathsWithRefusedChars(): Promise<string[]> {
    const rows = (await this.#repo.query(
      `SELECT reference FROM article WHERE deleted = FALSE
       UNION SELECT reference FROM snippet WHERE deleted = FALSE
       UNION SELECT reference FROM srs_card WHERE deleted = FALSE
       ORDER BY reference`
    )) as unknown as { reference: string }[];
    return rows
      .map(({ reference }) => reference)
      .filter((path) => {
        if (refusedCharsIn(path).length === 0) return false;
        const file = this.app.vault.getFileByPath(path);
        return file !== null && this.isItemFileAt(file, path);
      });
  }

  /**
   * Update database references in response to Obsidian rename events, and
   * once Obsidian's own link update for the rename is done, point the `source`
   * links that still name where the file was at where it is (see
   * `followSourceLinks`), as Obsidian does only when it is let: they are the
   * record of where items were taken from.
   *
   * Moves are followed in batches (see `batchAfterLinkUpdates`): each event
   * gives its moves to one at once, before its first `await`, so a renamed
   * folder, which fires one event per file all together, is one batch, and
   * the batch waits for every one of them to update the database first.
   * @param oldPath The vault-relative path the file had before it was moved
   */
  handleExternalRename(file: TAbstractFile, oldPath: string): Promise<void> {
    const moves = this.#trackRename(file, oldPath);
    // A failed rename follows nothing; the caller sees its failure
    this.#followMoves(
      moves.then(
        (all) => all.filter(isFollowable),
        () => []
      )
    );
    return moves.then(() => undefined);
  }

  /**
   * Update database references for a rename, see {@link handleExternalRename}.
   * @returns the moves whose links to follow: the file's, with its row's id
   *   when it is an item, and any row it put back where it is
   */
  async #trackRename(
    file: TAbstractFile,
    oldPath: string
  ): Promise<FileMove[]> {
    const newPath = file.path;
    const concreteFile = this.app.vault.getFileByPath(newPath);
    if (!concreteFile) {
      throw new Error(`Failed to find a file at ${newPath}`);
    }
    // Everything below goes by frontmatter, which a PDF has none of
    if (!supportsFrontmatter(concreteFile)) {
      // Only a file that was already known by its path follows by path. A
      // note renamed to another type leaves its row behind, missing, until
      // it's renamed back and found by its ir-id again
      if (!supportsFrontmatter({ extension: extensionOfPath(oldPath) })) {
        return this.#followPathRename(oldPath, concreteFile);
      }
      return [];
    }

    // Read only: a write here would rewrite the note's frontmatter
    const frontmatter = await Obsidian.readFrontMatter(concreteFile, this.app);
    const type = Obsidian.typeOfTags(frontmatter.tags);
    let rowId = irIdOf(frontmatter);
    this.snippets.offsetTracker.renameFile(oldPath, file.path);
    // A plain note may be what snippets and cards were taken from
    if (!type) return [{ from: oldPath, file: concreteFile }];

    const table = type === 'card' ? 'srs_card' : type;

    if (rowId) {
      // Renaming a note to match the reference of a deleted row restores it,
      // e.g. after deleting a note and recreating it under another name
      await this.#repo.mutate(
        `UPDATE ${table} SET reference = $1, deleted = FALSE WHERE id = $2`,
        [file.path, rowId]
      );
    } else {
      if (oldPath === file.path) {
        console.warn('File reference did not change; ignoring');
        return [];
      }

      await this.#repo.mutate(
        `UPDATE ${table} SET reference = $1 WHERE reference = $2`,
        [file.path, oldPath]
      );
      // Its children name it by its id, which its note doesn't carry
      const [row] = (await this.#repo.query(
        `SELECT id FROM ${table} WHERE reference = $1`,
        [file.path]
      )) as unknown as { id: string }[];
      rowId = row?.id;
    }
    return [{ from: oldPath, file: concreteFile, id: rowId }];
  }

  /**
   * Follow a file with no frontmatter, such as a PDF, from `oldPath` to `newPath`.
   * Such a file is known by its path alone, so the article row at the old path
   * is its row, and moves with it; snippets and cards name their parent by id,
   * so they follow along untouched. The rename shows the file is there, so the
   * row is live afterwards whatever it was before.
   *
   * `reference` is `UNIQUE`, so a row still naming the new path has to give it
   * up first: a tombstone left by a file deleted from there, or a row whose file
   * is missing. Neither has its file there any more — this one's is — so it is
   * parked where `moved-note-scan` parks the tombstones it evicts, deleted or
   * not as it was: a missing row stays missing, which is only ever derived,
   * for Relink to find. An untracked file moving onto a tombstone's path takes
   * that row back, as a file created there would — and so does one moving onto
   * the old path of an article the startup scan rebound by filename.
   *
   * Anything else — an image, say — has no row at either path, and costs a
   * read and no write: every write outside a transaction saves the database.
   */
  async #followPathRename(oldPath: string, file: TFile): Promise<FileMove[]> {
    const newPath = file.path;
    if (oldPath === newPath) return [];
    const [moving] = (await this.#repo.query(
      'SELECT id FROM article WHERE reference = $1',
      [oldPath]
    )) as unknown as { id: string }[];
    if (!moving) {
      // As if the file had been created there, but for what was taken from
      // it: their links still name the old path until they are followed. A
      // PDF that is no article may still be what snippets and cards were
      // taken from.
      const reclaimed = await this.#reclaimAtPath(newPath, { claim: false });
      await this.#restoreAtPath(newPath, { claim: false });
      this.snippets.offsetTracker.renameFile(oldPath, newPath);
      const moves: FileMove[] = [{ from: oldPath, file }];
      if (reclaimed) {
        moves.push({ from: reclaimed.from, file, id: reclaimed.id });
      }
      return moves;
    }

    this.snippets.offsetTracker.renameFile(oldPath, newPath);
    await this.#repo.transaction(async () => {
      const holders = (await this.#repo.query(
        'SELECT id FROM article WHERE reference = $1',
        [newPath]
      )) as unknown as { id: string }[];
      for (const { id } of holders) {
        await this.#repo.mutate(
          'UPDATE article SET reference = $1 WHERE id = $2',
          [evictedSpot({ table: 'article', id }), id]
        );
      }
      await this.#repo.mutate(
        'UPDATE article SET reference = $1, deleted = FALSE WHERE id = $2',
        [newPath, moving.id]
      );
    });
    return [{ from: oldPath, file, id: moving.id }];
  }

  /**
   * Point the `source` links of the snippets and cards of each row that moved
   * from `from` to `to` at the file there (see `retargetChildSources`), in
   * step with the row: a link names its file by path, and is the record of
   * where its item was taken from. Links Obsidian has already updated are
   * left alone. A row whose links can't be re-pointed keeps its move; the
   * failure is logged.
   */
  async followChildSources(
    moves: readonly { id: string; from: string; to: string }[]
  ) {
    for (const { id, from, to } of moves) {
      const file = this.app.vault.getFileByPath(to);
      if (!file) continue;
      try {
        await this.articles.retargetChildSources(id, from, file);
      } catch (error) {
        console.error(error);
      }
    }
  }

  /**
   * For each article row the startup scan put at a file with no frontmatter,
   * a PDF, {@link #claimAtPath}: the file had no live row while it was away,
   * so snippets and cards taken from it then have no parent.
   */
  async claimMovedFiles(
    moves: readonly { table: string; id: string; to: string }[]
  ) {
    for (const { table, id, to } of moves) {
      if (table !== 'article') continue;
      if (supportsFrontmatter({ extension: extensionOfPath(to) })) continue;
      await this.#claimAtPath(to, id);
    }
  }

  /**
   * Give the article row `id`, now back at its file `path`, the parentless
   * snippets and cards taken from that file while no live row named it (see
   * `ArticleManager.claimFromBinary`). A failure is logged; the row stays.
   */
  async #claimAtPath(path: string, id: string) {
    const file = this.app.vault.getFileByPath(path);
    if (!file) return;
    try {
      await this.articles.claimFromBinary(file, id);
    } catch (error) {
      console.error(error);
    }
  }

  /**
   * Bring back the tombstoned article row at `path`, now that a file with no
   * frontmatter, known by its path alone, is there again: restored from the
   * trash, say. Reads first, so the many files that are no item cost no write.
   * @param options.claim whether to adopt what was taken from the file
   *   meanwhile (see {@link #claimAtPath})
   */
  async #restoreAtPath(path: string, { claim }: { claim: boolean }) {
    const [tombstone] = (await this.#repo.query(
      'SELECT id FROM article WHERE reference = $1 AND deleted = TRUE',
      [path]
    )) as unknown as { id: string }[];
    if (!tombstone) return false;
    await this.articles.markUndeleted(tombstone.id, 'article');
    if (claim) await this.#claimAtPath(path, tombstone.id);
    return true;
  }

  /**
   * Put back an article the startup scan rebound by filename away from `path`,
   * now that a file — its own, by path — has turned up there: Sync delivering
   * it late, say. See `reclaimAtPath`.
   * @param options.claim as for {@link #restoreAtPath}, and whether to point
   *   the links of its snippets and cards at its file here and now: a rename
   *   follows them once Obsidian has updated links instead
   * @returns the article's move, if it was put back
   */
  async #reclaimAtPath(path: string, { claim }: { claim: boolean }) {
    const moved = await reclaimAtPath(this.#repo, path, Date.now());
    if (!moved) return null;
    this.snippets.offsetTracker.renameFile(moved.from, moved.to);
    if (claim) {
      await this.followChildSources([moved]);
      await this.#claimAtPath(moved.to, moved.id);
    }
    await appendLog(this.app.vault.adapter, REBIND_LOG_TOPIC, [
      describeReclaim(moved),
    ]);
    return moved;
  }

  /**
   * Mark rows as deleted
   * @param path where the database has the file, if not where it was deleted
   *   from: one whose rename was being put back (see `ItemPathGuard`)
   */
  async handleDeletion(file: TAbstractFile, path = file.path) {
    const match = await this.articles.findItem({ path });
    if (!match) return;

    const { row, table } = match;
    if (table === 'snippet') {
      const parent = (row as SnippetRow).parent;
      if (parent) {
        const parentRow = await this.articles.findById(parent);
        if (!parentRow) {
          return;
        }
        const parentPath = parentRow.row.reference;
        this.snippets.offsetTracker.removeHighlight(parentPath, row.id);
        // trigger a re-paint so the highlight disappears
        this.plugin.app.workspace.trigger('ir-highlights-changed', parentPath);
      }
    }
    await this.#repo.mutate(
      `UPDATE ${table} SET deleted = TRUE WHERE reference = $1`,
      [path]
    );
  }

  /**
   * Mark rows as un-deleted where appropriate
   * @returns the file's path when an item came to it just now whose path
   *   breaks links to it (see `REFUSED_PATH_CHARS`), for the user to hear of:
   *   arriving as a new file, by a move Obsidian didn't see as one, it is left
   *   where it is, as at startup; else `null`
   */
  async handleCreation(file: TAbstractFile): Promise<string | null> {
    const concreteFile = this.app.vault.getFileByPath(file.path);
    if (!concreteFile) return null;
    // Everything below goes by frontmatter, which a PDF has none of
    if (!supportsFrontmatter(concreteFile)) {
      // A reclaim only ever takes a path no row names, and a restore only a
      // path a tombstone names, so at most one of the two acts
      const reclaimed = await this.#reclaimAtPath(file.path, { claim: true });
      const restored = await this.#restoreAtPath(file.path, { claim: true });
      return reclaimed || restored ? refusedAt(file.path) : null;
    }

    // Read only: a write to a note just created could recreate it, were it
    // deleted again between the write's read and its write
    const frontmatter = await Obsidian.readFrontMatter(concreteFile, this.app);
    const id = irIdOf(frontmatter);
    const type = Obsidian.typeOfTags(frontmatter.tags);

    if (!id || type === null) return null;

    const table = type === 'card' ? 'srs_card' : type;

    // Copying a note also triggers a creation event; check that the original
    // note exists and has the right ir-id in frontmatter to ignore copies
    const row = (
      await this.#repo.query(
        `SELECT reference, deleted FROM ${table} WHERE id = $1`,
        [id]
      )
    )[0] as { reference: string; deleted: unknown } | undefined;
    if (row && row.reference !== file.path) {
      const referencedFile = this.app.vault.getFileByPath(row.reference);
      if (
        referencedFile &&
        Obsidian.getFrontMatter(referencedFile, this.app)?.['ir-id'] === id
      ) {
        return null;
      }
    }

    await this.#repo.mutate(
      `UPDATE ${table} SET deleted = FALSE, reference = $1 WHERE id = $2`,
      [file.path, id]
    );
    const came = row && (row.reference !== file.path || Boolean(row.deleted));
    return came ? refusedAt(file.path) : null;
  }

  /**
   * Save the scroll anchor for an article or snippet. Cards are excluded.
   *
   * For a note, the `scroll_top` column holds the top-visible document
   * character offset rather than the pixel offset it originally stored — a
   * logical anchor survives viewport-width and layout changes. Legacy pixel
   * values self-correct: a row written before this change restores to the
   * wrong spot once, then the next scroll overwrites it with a real character
   * offset. For a PDF article it holds a packed page and top (see
   * `#/lib/pdf/position`).
   */
  async saveScrollPosition(file: TFile, offset: number) {
    const noteType = await this.articles.getItemType(file);
    if (!noteType || noteType === 'card') return;

    await this.#repo.mutate(
      `UPDATE ${noteType} SET scroll_top = $1 WHERE reference = $2`,
      [Math.round(offset), file.path]
    );
  }

  /**
   * Load the saved scroll anchor for an article or snippet, as
   * {@link saveScrollPosition} stored it. Returns `null` when nothing is stored
   * (`0`) or the file is not an article/snippet.
   */
  async loadScrollPosition(file: TFile): Promise<number | null> {
    const noteType = await this.articles.getItemType(file);

    let row: ArticleRow | SnippetRow | null = null;
    if (noteType === 'article') {
      row = await this.articles.findArticle(file);
    } else if (noteType === 'snippet') {
      row = await this.snippets.findSnippet(file);
    }

    if (row && typeof row.scroll_top === 'number' && row.scroll_top > 0) {
      return row.scroll_top;
    }

    return null;
  }
}
