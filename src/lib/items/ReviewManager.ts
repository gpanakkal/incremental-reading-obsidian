import type {
  QueueCardMemory,
  QueuePage,
  QueueRow,
  QueueScheduling,
  QueueSubset,
} from '#/components/types';
import type { AutoImportEntry } from '#/lib/AutoImportWatcher';
import type {
  BulkImportEntry,
  BulkImportOptions,
  BulkOutcome,
  ImportedArticle,
} from '#/lib/bulk-import/types';
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
  type ItemTable,
  evictedSpot,
  ITEM_TABLES,
} from '#/lib/moved-note-scan';
import type { PositionRow } from '#/lib/position-store';
import { assertReady, outlastMerge } from '#/lib/readiness';
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
  type SQLiteRepository,
  type SRSCardRow,
  isArticle,
} from '#/lib/types';
import type { WebPage } from '#/lib/web-viewer';
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
import { ObsidianHelpers as Obsidian } from '../ObsidianHelpers';
import {
  compareDates,
  compareFuzzedDue,
  compareStrings,
  getEndOfDay,
} from '../utils';
import {
  ArticleManager,
  liveArticleLookup,
  ownNoteKeepsRow,
} from './ArticleManager';
import { type CardSelection, CardManager } from './CardManager';
import { type FileMove, followSourceLinks } from './follow-source-links';
import { deleteRowStatements, NOT_PURGED, purgedReference } from './row-delete';
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

/** An item row's reading position, and which table the row is in. */
export interface ItemPositionRow extends PositionRow {
  table: 'article' | 'snippet';
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

  /**
   * @throws {ActionRefusedError} while the database is not ready (see
   *   `requireReady`), held first over a merge under way
   */
  async reviewCard(card: ISRSCardDisplay, grade: Grade, reviewTime?: Date) {
    await assertReady(this.#repo, 'db-write', 'grade the card');
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

  /** See `ItemManager.backfillReviewTimeFuzz`. */
  async backfillReviewTimeFuzz(): Promise<void> {
    await this.articles.backfillReviewTimeFuzz('article');
    await this.snippets.backfillReviewTimeFuzz('snippet');
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
   * @throws {ActionRefusedError} as {@link reviewCard} does
   */
  async reviewSnippet(
    snippet: ISnippetBase,
    reviewTime?: number,
    nextReviewInterval?: number
  ) {
    await assertReady(this.#repo, 'db-write', 'mark the snippet reviewed');
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

  /**
   * Import many files as articles at once, quietly: what came of each is
   * returned for the caller to say (see `ArticleManager.importMany`)
   */
  async importArticles(
    entries: readonly BulkImportEntry[],
    options: BulkImportOptions
  ): Promise<BulkOutcome[]> {
    return this.articles.importMany(entries, options);
  }

  /**
   * Import notes for their trigger tags or their arrival in a watched folder
   * (see `AutoImportWatcher`), as {@link importArticles} does, always where
   * they are: a copy would leave its note unmarked, for its next trigger to
   * import again, whatever `copyOnImport` says.
   */
  async importTaggedNotes(
    entries: readonly AutoImportEntry[],
    { priority }: { priority: number }
  ): Promise<BulkOutcome[]> {
    // Nothing asked for this now, and a note it fails is never tried again
    // while the plugin runs (see `AutoImportWatcher`), so a merge is waited
    // out; `importMany` still refuses one the database isn't ready for
    await outlastMerge(this.#repo);
    return this.articles.importMany(
      entries.map(({ file }) => ({ file })),
      { priority, fixedIntervalDays: null, makeCopy: false }
    );
  }

  /**
   * Make many articles plain files again, quietly: what came of each is
   * returned for the caller to say (see `ArticleManager.unimportMany`)
   */
  async unimportArticles(files: readonly TFile[]): Promise<BulkOutcome[]> {
    return this.articles.unimportMany(files);
  }

  /**
   * Take back what imports did, for an undo of them (see
   * `ArticleManager.undoImports`)
   * @returns the ids of the articles taken back
   */
  async undoImports(imports: readonly ImportedArticle[]): Promise<string[]> {
    return this.articles.undoImports(imports);
  }

  /**
   * The id of the live article `file` is, or `null` when it is none: a note
   * by its cached `ir-id` and its path, a copy of an article's note being
   * none, and a note claiming no id or a file with no frontmatter by its path
   * (see `liveArticleLookup`).
   *
   * Answers at once, for a menu being built: sql.js answers a query at once,
   * as in {@link isItemFileAt}. A repository that answers later can't be
   * waited on there, so it gets `null`.
   */
  articleIdAt(file: TFile): string | null {
    const lookup = liveArticleLookup(file, this.app);
    if (!lookup) return null;
    const rows = this.#repo.query(lookup.sql, lookup.params);
    if (!Array.isArray(rows)) return null;
    return (rows as unknown as { id: string }[])[0]?.id ?? null;
  }

  /**
   * Whether any item table holds a row with id `id`, deleted or not: an
   * `ir-id` none holds is an orphan, which `AutoImportWatcher` may import
   */
  async hasItemRow(id: string): Promise<boolean> {
    return (await this.articles.findById(id)) !== null;
  }

  /**
   * Import a page read from Obsidian's web viewer as a new article
   */
  async importWebPage(
    page: WebPage,
    priority: number,
    fixedIntervalDays: number | null
  ) {
    return this.articles.importWebPage(page, priority, fixedIntervalDays);
  }

  async createEmptyArticle(priority: number, directory?: string) {
    return this.articles.create(priority, directory);
  }

  /** @throws {ActionRefusedError} as {@link reviewCard} does */
  async reviewArticle(
    article: IArticleBase,
    reviewTime?: number,
    nextReviewInterval?: number
  ) {
    await assertReady(this.#repo, 'db-write', 'mark the article reviewed');
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
   * @throws {ActionRefusedError} as {@link reviewCard} does
   */
  async reprioritize(item: IArticleBase | ISnippetBase, newPriority: number) {
    await assertReady(this.#repo, 'db-write', 'change the priority');
    if (isArticle(item)) {
      return this.articles.reprioritize(item, newPriority);
    }
    return this.snippets.reprioritize(item, newPriority);
  }

  /**
   * Set a new interval without adjusting due date if due in today's review day
   * @param changes an object with the new interval or the new priority
   * @throws {ActionRefusedError} as {@link reviewCard} does
   */
  async manageFixedInterval(
    article: IArticleBase,
    changes: { newIntervalDays: number } | { newPriority: number }
  ) {
    await assertReady(this.#repo, 'db-write', 'change the review interval');
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
   * @throws if a table of an included type cannot be read. A failed read must
   * not pass for an empty queue: review would report nothing due.
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
      // Logged here because review's message points the user at the console,
      // and only a failed query logs itself on the way up
      console.error('Incremental Reading - Failed to get due items:', error);
      throw error;
    }
  }

  /**
   * Whether anything of `typesToInclude` is due, by the cutoffs
   * {@link getDue} uses, without its writes: no note is squared with its row,
   * no tombstone set or lifted, no fuzz filled in, and no notice shown. For
   * asking often with no review open.
   *
   * It reads only the rows, so a due row whose note claims another item's id
   * counts here though {@link getDue} drops it (marking it deleted, after
   * which neither counts it).
   * @throws if a table of an included type cannot be read
   */
  async anyDue(
    typesToInclude: Partial<Record<NoteType, true>>
  ): Promise<boolean> {
    try {
      return (
        ('card' in typesToInclude && (await this.cards.anyDue())) ||
        ('snippet' in typesToInclude && (await this.snippets.anyDue())) ||
        ('article' in typesToInclude && (await this.articles.anyDue()))
      );
    } catch (error) {
      console.error(
        'Incremental Reading - Failed to check for due items:',
        error
      );
      throw error;
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
      `SELECT id, reference FROM article WHERE ${NOT_PURGED} ` +
        `UNION ALL SELECT id, reference FROM snippet WHERE ${NOT_PURGED}`
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
      `SELECT id, reference FROM article WHERE id = $1 AND ${NOT_PURGED} ` +
        `UNION ALL SELECT id, reference FROM snippet WHERE id = $1 AND ${NOT_PURGED}`,
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
   *
   * @throws if the queue cannot be read. An unreadable table must not pass
   * for an empty one: the queue is where the user sees what they have, and
   * "nothing due" over a database that failed to load reads as data loss.
   */
  async getQueue(subset?: QueueSubset): Promise<QueuePage> {
    const dueBy = subset?.date?.getTime() ?? Number.POSITIVE_INFINITY;
    const fetch = { dueBy, throwOnError: true };
    const types = subset?.typesToInclude;
    // A type filtered out is never read, rather than read and dropped
    const wants = (type: NoteType) => !types || type in types;

    const [articleRows, snippetRows, cardRows, parentPaths] = await Promise.all(
      [
        wants('article') ? this.articles.fetchMany(fetch) : [],
        wants('snippet') ? this.snippets.fetchMany(fetch) : [],
        wants('card') ? this.cards.fetchMany(fetch) : [],
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
   *
   * `typesToInclude` must be the filter the table's pages were fetched with,
   * or the rank is taken in a different queue than the one on screen.
   */
  async findPageForDate(
    date: Date,
    entriesPerPage: number,
    typesToInclude?: QueueSubset['typesToInclude']
  ): Promise<number> {
    const { rows } = await this.getQueue({ typesToInclude });
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
      await this.#repo.query(
        `SELECT * FROM article WHERE id = $1 AND ${NOT_PURGED}`,
        [id]
      )
    )[0] as ArticleRow | undefined;
    if (articleRow) {
      return this.#includeInQueue(articleRow)
        ? this.#articleToQueueRow(articleRow)
        : null;
    }

    const snippetRow = (
      await this.#repo.query(
        `SELECT * FROM snippet WHERE id = $1 AND ${NOT_PURGED}`,
        [id]
      )
    )[0] as SnippetRow | undefined;
    if (snippetRow) {
      if (!this.#includeInQueue(snippetRow)) return null;
      return this.#snippetToQueueRow(
        snippetRow,
        await this.#getParentPath(snippetRow.parent)
      );
    }

    const cardRow = (
      await this.#repo.query(
        `SELECT * FROM srs_card WHERE id = $1 AND ${NOT_PURGED}`,
        [id]
      )
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
   * Returns null if the item is not found in the database, or its row there
   * is deleted: the queue leaves a tombstone out, and so do review and the
   * note bar, which go by this (0228).
   */
  async getReviewItemFromFile(file: TFile): Promise<ReviewItem | null> {
    const noteType = await this.articles.getItemType(file);
    if (noteType === 'article') {
      const row = await this.articles.findArticle(file);
      if (!row || row.deleted) return null;
      return {
        data: ArticleManager.rowToBase(row),
        file,
      } satisfies ReviewArticle;
    } else if (noteType === 'snippet') {
      const row = await this.snippets.findSnippet(file);
      if (!row || row.deleted) return null;
      return {
        data: SnippetManager.rowToBase(row),
        file,
      } satisfies ReviewSnippet;
    } else if (noteType === 'card') {
      const row = await this.cards.findCard(file);
      if (!row || row.deleted) return null;
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

  /** @throws {ActionRefusedError} as {@link reviewCard} does */
  async dismissItem(item: MaybeMissingItem): Promise<void> {
    await assertReady(this.#repo, 'db-write', 'dismiss the item');
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

  /** @throws {ActionRefusedError} as {@link reviewCard} does */
  async unDismissItem(item: MaybeMissingItem): Promise<void> {
    await assertReady(this.#repo, 'db-write', 'restore the item');
    const type = item.data.type;
    const table = type === 'card' ? 'srs_card' : type;
    await this.#repo.mutate(`UPDATE ${table} SET dismissed = 0 WHERE id = $1`, [
      item.data.id,
    ]);
  }

  /**
   * Remove the `table` row `id` for good, leaving its note, if any, alone.
   *
   * Its review history and any startup rebind of it go with it. All are
   * tombstoned rather than deleted (see `tombstoneRowStatements`), so the
   * delete reaches the other devices. The snippets and cards taken from
   * it stay, with no parent, as if taken from nothing: `parent` has no foreign
   * key to clear it, and one left naming a row that no longer exists would be
   * a parent no lookup can find. All in one transaction, so a failed delete
   * leaves everything as it was.
   *
   * Whatever shows the row should still be refreshed by the caller. An id no
   * row of `table` holds changes nothing.
   * @throws whatever the delete throws, after rolling it back
   */
  async deleteRow(table: ItemTable, id: string): Promise<void> {
    // An article's row has no `parent`, and reads as having none
    const [row] = (await this.#repo.query(
      `SELECT * FROM ${table} WHERE id = $1 AND ${NOT_PURGED}`,
      [id]
    )) as { parent?: string | null }[];
    if (!row) return;
    const parent = row.parent ? await this.articles.findById(row.parent) : null;

    try {
      await this.#repo.transaction(async () => {
        for (const { query, params } of deleteRowStatements(table, id)) {
          await this.#repo.mutate(query, params);
        }
      });
    } catch (error) {
      // A save failing after the commit throws as well, with the delete held
      // in memory for the next save to write: only a rolled-back one failed
      const [left] = await this.#repo.query(
        `SELECT id FROM ${table} WHERE id = $1 AND reference != $2`,
        [id, purgedReference(id)]
      );
      if (left) throw error;
      // Lost if Obsidian closes before anything else saves
      Obsidian.notify("Deleted, but the database couldn't be saved yet", {
        kind: 'error',
      });
    }

    // Here, as in `dismissItem`, so a session left on the row cannot resume
    // onto an id that no longer exists
    this.plugin.sessionTracker?.forgetIf(id);
    if (parent) {
      // Off the note it was taken from, a PDF's included
      const parentPath = parent.row.reference;
      this.snippets.offsetTracker.removeHighlight(parentPath, id);
      this.plugin.app.workspace.trigger('ir-highlights-changed', parentPath);
    }
  }

  /**
   * The id of the live item — article, snippet or card — whose reference is
   * `reference`, or `null` when none is: for an item missing its file, which
   * no note at the path can name by its `ir-id`.
   */
  async liveItemIdAt(reference: string): Promise<string | null> {
    const rows = (await this.#repo.query(
      `SELECT id FROM article WHERE reference = $1 AND deleted = FALSE
       UNION ALL SELECT id FROM snippet WHERE reference = $1 AND deleted = FALSE
       UNION ALL SELECT id FROM srs_card WHERE reference = $1 AND deleted = FALSE`,
      [reference]
    )) as { id: string }[];
    return rows[0]?.id ?? null;
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
   * Whether a live article row names a path in the folder at `folder`, at any
   * depth, `/` being the vault: what an un-import from the folder may find.
   * Answers at once, as {@link referencesUnder} does, or `false`.
   */
  hasArticleUnder(folder: string): boolean {
    const rows =
      folder === '/'
        ? this.#repo.query(
            'SELECT 1 FROM article WHERE deleted = FALSE LIMIT 1'
          )
        : this.#repo.query(
            `SELECT 1 FROM article
               WHERE deleted = FALSE AND reference >= $1 AND reference < $2
               LIMIT 1`,
            // `0` sorts right after `/`, as in `referencesUnder`
            [`${folder}/`, `${folder}0`]
          );
    return Array.isArray(rows) && rows.length > 0;
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
    if (!type) {
      // A plain note may be what snippets and cards were taken from, and an
      // item's note that lost its tag still names its row by its id
      const id =
        rowId && (await this.#followUntagged(rowId, oldPath, concreteFile));
      return [{ from: oldPath, file: concreteFile, ...(id ? { id } : {}) }];
    }

    const table = type === 'card' ? 'srs_card' : type;

    if (rowId) {
      // A copy carries its original's id, as Make a copy writes it: renaming
      // the copy is a plain note's rename while the original is still there
      const row = await this.#rowOf(table, rowId);
      if (row && ownNoteKeepsRow(this.app, rowId, row.reference, file.path)) {
        return [{ from: oldPath, file: concreteFile }];
      }
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
   * Move the live row `id` holds from `oldPath` to where `file`, which claims
   * `id` with no type tag, now is: the note at a row's reference is that row's
   * note iff it carries the row's `ir-id`, tag or no tag (0230). Only a row at
   * `oldPath` follows, its note being the one that moved: a copy renamed from
   * elsewhere never takes it (see `ownNoteKeepsRow`), and with no tag nothing
   * says a note from elsewhere is the item's, as it does for a tagged one. A
   * deleted row stays as it is: only an import brings one back to an untagged
   * note (0228). Moves made while nothing listened are `scanForMovedNotes`'s,
   * which goes by `ir-id` alone.
   * @returns the id of the row moved, if any
   */
  async #followUntagged(
    id: string,
    oldPath: string,
    file: TFile
  ): Promise<string | undefined> {
    if (oldPath === file.path) return undefined;
    for (const table of ITEM_TABLES) {
      const row = await this.#rowOf(table, id);
      if (!row || row.deleted || row.reference !== oldPath) continue;
      await this.#repo.mutate(
        `UPDATE ${table} SET reference = $1 WHERE id = $2`,
        [file.path, id]
      );
      return id;
    }
    return undefined;
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

    if (!id) return null;
    if (type === null) {
      return (await this.#restoreOwnTombstone(file.path, id))
        ? refusedAt(file.path)
        : null;
    }

    const table = type === 'card' ? 'srs_card' : type;

    // Copying a note also triggers a creation event, which leaves the row
    // with its original
    const row = await this.#rowOf(table, id);
    if (row && ownNoteKeepsRow(this.app, id, row.reference, file.path)) {
      return null;
    }

    await this.#repo.mutate(
      `UPDATE ${table} SET deleted = FALSE, reference = $1 WHERE id = $2 AND ${NOT_PURGED}`,
      [file.path, id]
    );
    const came = row && (row.reference !== file.path || Boolean(row.deleted));
    return came ? refusedAt(file.path) : null;
  }

  /** The `reference` and `deleted` of row `id` in `table`, unless purged. */
  async #rowOf(
    table: ItemTable,
    id: string
  ): Promise<{ reference: string; deleted: unknown } | undefined> {
    return (
      await this.#repo.query(
        `SELECT reference, deleted FROM ${table} WHERE id = $1 AND ${NOT_PURGED}`,
        [id]
      )
    )[0] as { reference: string; deleted: unknown } | undefined;
  }

  /**
   * Bring back the row `id`, deleted at `path`, now that a note claiming its
   * id is there again, though the note lacks its type tag: a note deleted and
   * brought back, from the trash or by an editor that saves by replacing the
   * file, while its tag was off. The note at a row's reference is that row's
   * note iff it carries its id, tag or no tag, and a tag added back later only
   * changes the note, which no handler takes to restore a row: left deleted,
   * the item stayed out of the queue for good (0228). A row anywhere else is
   * left alone: with no tag, nothing says which item the note is if not the
   * one at its own path. Reads first, as most notes created are no item.
   * @returns whether a row was brought back
   */
  async #restoreOwnTombstone(path: string, id: string): Promise<boolean> {
    for (const table of ITEM_TABLES) {
      const [row] = await this.#repo.query(
        `SELECT id FROM ${table} WHERE id = $1 AND reference = $2 AND deleted = TRUE`,
        [id, path]
      );
      if (!row) continue;
      await this.#repo.mutate(
        `UPDATE ${table} SET deleted = FALSE WHERE id = $1 AND reference = $2`,
        [id, path]
      );
      return true;
    }
    return false;
  }

  /**
   * The id an article's or snippet's reading position is kept under (see
   * `#/lib/position-store`), or `null` for a card or a note with no row.
   */
  async positionIdOf(file: TFile): Promise<string | null> {
    const noteType = await this.articles.getItemType(file);
    let row: ArticleRow | SnippetRow | null = null;
    if (noteType === 'article') {
      row = await this.articles.findArticle(file);
    } else if (noteType === 'snippet') {
      row = await this.snippets.findSnippet(file);
    }
    return row?.id ?? null;
  }

  /**
   * The reading position stored in article or snippet `id`'s row, with the
   * row's change stamp, or `null` when no such row exists.
   *
   * The `scroll_top` column holds the top-visible document character offset
   * for a note — a logical anchor that survives viewport-width and layout
   * changes; a legacy pixel value restores to the wrong spot once, then the
   * next position stored replaces it — and a packed page and top for a PDF
   * article (see `#/lib/pdf/position`). `0` means unset.
   */
  async readPosition(id: string): Promise<ItemPositionRow | null> {
    const [row] = ((await this.#repo.query(
      `SELECT 'article' AS item_table, scroll_top, updated_at, updated_by FROM article WHERE id = $1 AND ${NOT_PURGED} ` +
        `UNION ALL SELECT 'snippet', scroll_top, updated_at, updated_by FROM snippet WHERE id = $1 AND ${NOT_PURGED}`,
      [id]
    )) ?? []) as unknown as {
      item_table: ItemPositionRow['table'];
      scroll_top: number;
      updated_at: number;
      updated_by: string;
    }[];
    if (!row) return null;
    return {
      table: row.item_table,
      position: row.scroll_top,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  }

  /** Store `position` in the row {@link readPosition} found for `id`. */
  async writePosition(id: string, position: number, row: ItemPositionRow) {
    await this.#repo.mutate(
      `UPDATE ${row.table} SET scroll_top = $1 WHERE id = $2 AND ${NOT_PURGED}`,
      [Math.round(position), id]
    );
  }
}
