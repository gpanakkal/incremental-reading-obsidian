import type { TAbstractFile } from 'obsidian';
import {
  TFile,
  normalizePath,
  Notice,
  type App,
  type Editor,
  type MarkdownView,
} from 'obsidian';
import type { SQLiteRepository } from './repository';
import type {
  IArticleBase,
  IArticleReview,
  ISnippetBase,
  NoteType,
  ReviewItem,
} from '#/lib/types';
import {
  type ISnippetActive,
  type ISnippetReview,
  type ISRSCard,
  type ISRSCardDisplay,
  type SRSCardRow,
  type IArticleActive,
  type SnippetRow,
  type ArticleRow,
  isArticle,
  ReviewCard,
  ReviewArticle,
  ReviewSnippet,
} from '#/lib/types';
import {
  SNIPPET_DIRECTORY,
  TEXT_BASE_REVIEW_INTERVAL,
  SNIPPET_TAG,
  SOURCE_TAG,
  SOURCE_PROPERTY_NAME,
  ERROR_NOTICE_DURATION_MS,
  SUCCESS_NOTICE_DURATION_MS,
  CARD_DIRECTORY,
  CARD_TAG,
  REVIEW_FETCH_COUNT,
  TEXT_REVIEW_INTERVALS,
  TEXT_REVIEW_MULTIPLIER_BASE,
  TEXT_REVIEW_MULTIPLIER_STEP,
  DEFAULT_PRIORITY,
  CLOZE_DELIMITERS,
  CLOZE_DELIMITER_PATTERN,
  TRANSCLUSION_HIDE_TITLE_ALIAS,
  MS_PER_MINUTE,
  MS_PER_DAY,
  DAY_ROLLOVER_OFFSET_HOURS,
  ARTICLE_DIRECTORY,
  ARTICLE_TAG,
  CONTENT_TITLE_SLICE_LENGTH,
  DATA_DIRECTORY,
  INVALID_TITLE_MESSAGE,
} from './constants';
import { getClozeGroupsPattern } from './utils';
import type { FSRS, FSRSParameters, Grade } from 'ts-fsrs';
import { fsrs, generatorParameters } from 'ts-fsrs';
import {
  compareDates,
  createFile,
  createTitle,
  generateId,
  getContentSlice,
  getSelectionWithBounds,
  sanitizeForTitle,
  searchAll,
  splitFrontMatter,
} from './utils';
import SRSCard from './SRSCard';
import type ReviewView from 'src/views/ReviewView';
import SRSCardReview from './SRSCardReview';
import Article from './Article';
import Snippet from './Snippet';
import {
  SnippetOffsetTracker,
  type SnippetHighlight,
} from './SnippetOffsetTracker';

const FSRS_PARAMETER_DEFAULTS: Partial<FSRSParameters> = {
  enable_fuzz: false,
  enable_short_term: false,
};

export default class ReviewManager {
  app: App;
  #repo: SQLiteRepository;
  #fsrs: FSRS;
  snippetTracker: SnippetOffsetTracker;
  currentEditorView: { view: any; file: TFile } | null = null;

  constructor(app: App, repo: SQLiteRepository) {
    this.app = app;
    this.#repo = repo;
    const params = generatorParameters(FSRS_PARAMETER_DEFAULTS);

    this.#fsrs = fsrs(params);
    this.snippetTracker = new SnippetOffsetTracker();
  }

  // TODO: remove for production
  get repo() {
    return this.#repo;
  }

  /**
   * Calculate the character offset where the body starts (after frontmatter).
   * Returns 0 if no frontmatter is present.
   * @param fileContent The full file content
   */
  getBodyStartOffset(fileContent: string): number {
    const result = splitFrontMatter(fileContent);
    if (result) {
      return fileContent.length - result.body.length;
    }
    return 0;
  }

  /**
   * Update snippet offsets in the database.
   * Used to persist offset changes after document edits.
   * @param snippetId The snippet ID
   * @param startOffset Body-relative start offset
   * @param endOffset Body-relative end offset
   */
  async updateSnippetOffsets(
    snippetId: string,
    startOffset: number,
    endOffset: number
  ): Promise<void> {
    await this.#repo.mutate(
      `UPDATE snippet SET start_offset = $1, end_offset = $2 WHERE id = $3`,
      [startOffset, endOffset, snippetId]
    );
  }

  /**
   * Get the rollover-adjusted end of day as a Unix timestamp.
   */
  protected getEndOfToday() {
    const date = new Date();
    // get start of day in local time zone
    const startOfToday = Date.parse(date.toDateString());
    const rolloverOffsetMs = DAY_ROLLOVER_OFFSET_HOURS * 60 * MS_PER_MINUTE;
    let endOfDayLocal = startOfToday + rolloverOffsetMs;
    if (Date.parse(date.toUTCString()) - startOfToday >= rolloverOffsetMs) {
      // add a full day since we're past the rollover point
      endOfDayLocal += MS_PER_DAY;
    }
    return endOfDayLocal;
  }

  async getCardsDue(dueBy?: number, limit?: number): Promise<ReviewCard[]> {
    const dueTime = dueBy ?? this.getEndOfToday();
    try {
      const cardsDue = (
        await this._fetchCardData({ dueBy: dueTime, limit })
      ).map(
        async (item) => ({
          data: SRSCard.rowToDisplay(item),
          file: this.getNote(item.reference),
        }),
        this
      );
      const result = await Promise.all(cardsDue);
      return result.filter(
        (card): card is { data: ISRSCardDisplay; file: TFile } =>
          card.file !== null
      );
    } catch (error) {
      console.error(error);
      return [];
    }
  }

  async getSnippetsDue(
    dueBy?: number,
    limit?: number
  ): Promise<{ data: ISnippetActive; file: TFile }[]> {
    const dueTime = dueBy ?? this.getEndOfToday();
    try {
      const snippetsDue = (
        await this._fetchSnippetData({ dueBy: dueTime, limit })
      ).map(
        async (item) => ({
          data: Snippet.rowToBase(item),
          file: this.getNote(item.reference),
        }),
        this
      );
      const result = await Promise.all(snippetsDue);
      return result.filter(
        (snippet): snippet is { data: ISnippetActive; file: TFile } =>
          snippet.file !== null
      );
    } catch (error) {
      console.error(error);
      return [];
    }
  }

  /**
   * Fetch all snippets, cards, and articles ready for review, then order by due ASC
   * TODO:
   * - paginate
   * - invalidate after some time (e.g., the configured minimum review interval)
   * @param dueBy Unix timestamp. Defaults to current time.
   */
  async getDue({
    dueBy,
    limit = REVIEW_FETCH_COUNT,
  }: {
    dueBy?: number;
    limit?: number;
  }) {
    try {
      const cardsDue = await this.getCardsDue(dueBy, limit);
      const snippetsDue = await this.getSnippetsDue(dueBy, limit);
      const articlesDue = await this.getArticlesDue(dueBy, limit);
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

  // #region CARDS
  /**
   * Create an SRS item
   */
  async createCard(editor: Editor, view: MarkdownView | ReviewView) {
    const currentFile = view.file;
    if (!currentFile) {
      new Notice(`A markdown file must be active`, ERROR_NOTICE_DURATION_MS);
      return;
    }

    const block = this.getCurrentContent(editor, currentFile);
    // TODO: ensure block content is correct for bullet lists (should only use the current bullet) and code blocks (get the whole code block)
    if (!block) {
      new Notice('No block content found', ERROR_NOTICE_DURATION_MS);
      return;
    }
    const { content, line: blockLine } = block;

    const selectionBounds = getSelectionWithBounds(editor);
    const bounds = selectionBounds
      ? ([selectionBounds.start.ch, selectionBounds.end.ch] as const)
      : null;

    try {
      const withDelimiters = this.delimitCardTexts(content, bounds)[0]; // TODO: create many cards at once and transclude/link all?
      const { card, cardFile } = await this.createCardFileAndRow(
        withDelimiters,
        currentFile
      );
      const linkToCard = this.generateMarkdownLink(
        cardFile,
        currentFile,
        TRANSCLUSION_HIDE_TITLE_ALIAS
      );
      this.transcludeLink(editor, linkToCard, blockLine);
      // move the cursor to the next block
      editor.setSelection({ line: blockLine + 1, ch: 0 });
    } catch (error) {
      new Notice(error);
    }
  }

  protected async createCardFileAndRow(
    delimitedText: string,
    sourceFile: TFile
  ) {
    try {
      // Create the card from the content
      const cardFile = await this.createFromText(
        delimitedText,
        this.getDirectory('card')
      );
      const linkToSource = this.generateMarkdownLink(sourceFile, cardFile);
      await this.updateFrontMatter(cardFile, {
        tags: CARD_TAG,
        [`${SOURCE_PROPERTY_NAME}`]: linkToSource,
        delimiters: CLOZE_DELIMITERS,
      });

      const parentType = this.getNoteType(sourceFile);
      let currentFileEntry;
      if (parentType === 'article') {
        currentFileEntry = await this.findArticle(sourceFile);
      } else if (parentType === 'snippet') {
        currentFileEntry = await this.findSnippet(sourceFile);
      }
      const parent = currentFileEntry ? currentFileEntry.id : null;
      // create the database entry as FSRS card + reference
      const reference = `${CARD_DIRECTORY}/${cardFile.basename}.md`;
      const card = new SRSCard(reference);
      const params = [
        card.id,
        card.reference,
        parent,
        card.created_at.getTime(),
        card.due.getTime() + MS_PER_DAY, // new cards due the next day
        card.last_review?.getTime() ?? null,
        card.stability,
        card.difficulty,
        card.elapsed_days,
        card.scheduled_days,
        card.reps,
        card.lapses,
        card.state,
      ];
      const insertResult = await this.#repo.mutate(
        `INSERT INTO srs_card (id, reference, parent, created_at, due, last_review, ` +
          `stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state) ` +
          `VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        params
      );

      const fetchedCard = (
        await this.#repo.query('SELECT * FROM srs_card WHERE id = $1', [
          card.id,
        ])
      )[0];

      return { card, cardFile };
    } catch (error) {
      console.error(error);
      // TODO: error handling
      throw error;
    }
  }

  /**
   * If text is selected, adds cloze deletion delimiters around the selection
   * and removes them elsewhere.
   * If no text is selected, searches for preexisting delimiters.
   * @param selectionOffsets the character positions of the selection relative
   * to the start of the passed text
   * @throws if no text is selected and no preexisting delimiters are found
   */
  protected delimitCardTexts(
    text: string,
    selectionOffsets: readonly [number, number] | null
  ): string[] {
    const removeDelimiters = (text: string) =>
      text
        .replaceAll(CLOZE_DELIMITERS[0], '')
        .replaceAll(CLOZE_DELIMITERS[1], '');
    if (selectionOffsets) {
      // remove preexisting delimiters
      const pre = removeDelimiters(text.slice(0, selectionOffsets[0]));
      const answer = text.slice(selectionOffsets[0], selectionOffsets[1]);
      const post = removeDelimiters(text.slice(selectionOffsets[1]));
      const result =
        pre + `${CLOZE_DELIMITERS[0]} ${answer} ${CLOZE_DELIMITERS[1]}` + post;
      return [result];
    } else {
      // find the first pair of valid delimiters and remove others
      // TODO: create multiple cards
      const matches = searchAll(text, CLOZE_DELIMITER_PATTERN);
      if (!matches.length) {
        throw new Error(`No valid delimiters found in text:` + `\n\n${text}`);
      }
      // remove all other delimiters for each match
      return matches.map(({ match, index }) => {
        const pre = removeDelimiters(text.slice(0, index));
        const post = removeDelimiters(text.slice(match.length + index));
        return pre + match + post;
      });
    }
  }

  parseCloze(
    text: string,
    delimiters: [string, string]
  ): { start: string; answer: string; end: string } {
    const currentGroupsPattern = getClozeGroupsPattern(delimiters);
    const match = text.match(currentGroupsPattern);
    if (!match)
      throw new Error(
        `Failed to find delimiters ${delimiters.toString()} in the note body`
      );
    const [_, start, answer, end] = match;
    return { start, answer, end };
  }

  async _fetchCardData(opts?: {
    dueBy?: number;
    limit?: number;
    includeDismissed?: boolean;
  }) {
    let query = 'SELECT * FROM srs_card';
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

    query += ' ORDER BY due ASC';

    if (opts?.limit) {
      params.push(opts?.limit);
      query += ` LIMIT $${params.length}`;
    }

    return ((await this.#repo.query(query, params)) ?? []) as SRSCardRow[];
  }

  async reviewCard(card: ISRSCardDisplay, grade: Grade, reviewTime?: Date) {
    const recordLog = this.#fsrs.repeat(
      card,
      reviewTime || new Date(),
      (recordLog) => {
        const recordLogItem = recordLog[grade];
        const result = {
          nextCard: {
            ...card,
            ...recordLogItem.card,
          },
          reviewLog: recordLogItem.log,
        };

        return result;
      }
    );

    try {
      const { nextCard, reviewLog } = recordLog;
      const storedCard = (
        await this.#repo.query(`SELECT * FROM srs_card WHERE id = $1`, [
          card.id,
        ])
      )[0] as SRSCardRow;
      if (!storedCard) {
        throw new Error(`No card found with id ${card.id}`);
      }

      const updatedCard = SRSCard.cardToRow(nextCard);
      let updateQuery = `UPDATE srs_card SET `;
      const columnUpdateSegments = [
        `due = $1, last_review = $2`,
        `stability = $3, difficulty = $4`,
        `elapsed_days = $5`,
        `scheduled_days = $6`,
        `reps = $7, lapses = $8`,
        `state = $9, dismissed = 0`,
      ];
      updateQuery += columnUpdateSegments.join(', ');
      updateQuery += ` WHERE id = $10`;
      const updateParams = [
        updatedCard.due,
        updatedCard.last_review,
        updatedCard.stability,
        updatedCard.difficulty,
        updatedCard.elapsed_days,
        updatedCard.scheduled_days,
        updatedCard.reps,
        updatedCard.lapses + storedCard.lapses,
        updatedCard.state,
        card.id,
      ];
      await this.#repo.mutate(updateQuery, updateParams);

      const insertQuery =
        `INSERT INTO srs_card_review ` +
        `(id, card_id, due, review, stability, difficulty, ` +
        `elapsed_days, last_elapsed_days, scheduled_days, ` +
        `rating, state) VALUES ` +
        `($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`;

      const reviewRow = SRSCardReview.displayToRow(
        new SRSCardReview(card.id, reviewLog)
      );
      const insertParams = [
        reviewRow.id,
        reviewRow.card_id,
        reviewRow.due,
        reviewRow.review,
        reviewRow.stability,
        reviewRow.difficulty,
        reviewRow.elapsed_days,
        reviewRow.last_elapsed_days,
        reviewRow.scheduled_days,
        reviewRow.rating,
        reviewRow.state,
      ];
      await this.#repo.mutate(insertQuery, insertParams);
    } catch (error) {
      console.error(error);
    }
  }

  protected transcludeLink(editor: Editor, link: string, blockLine: number) {
    const line = editor.getLine(blockLine);
    editor.replaceRange(
      `!${link}`,
      { line: blockLine, ch: 0 },
      { line: blockLine, ch: line.length }
    );
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
    const reviewTime =
      firstReview || Date.now() + TEXT_REVIEW_INTERVALS.TOMORROW;

    // capture the current file BEFORE any async operations
    // to avoid race conditions where view.file changes during processing
    const currentFile = view.file;

    if (!currentFile) {
      new Notice(
        `Snipping not supported from ${view.getViewType()}`,
        ERROR_NOTICE_DURATION_MS
      );
      return;
    }

    // console.log(
    //   `[createSnippet] Creating snippet from file: ${currentFile.path}`
    // );

    const selection = editor.getSelection() || view.getSelection();
    if (!selection) {
      new Notice('Text must be selected', ERROR_NOTICE_DURATION_MS);
      return;
    }
    const snippetFile = await this.createFromText(
      selection,
      this.getDirectory('snippet')
    );

    // Tag it and link to the source file
    const sourceLink = this.generateMarkdownLink(currentFile, snippetFile);

    await this.updateFrontMatter(snippetFile, {
      tags: SNIPPET_TAG,
      [`${SOURCE_PROPERTY_NAME}`]: sourceLink,
    });

    // Tag the source note as ir-source if it doesn't have any IR tag yet
    const parentType = this.getNoteType(currentFile);
    if (!parentType) {
      await this.updateFrontMatter(currentFile, { tags: SOURCE_TAG });
    }

    // inherit priority from the source file if it has one, or assign default priority
    let currentFileEntry;
    if (parentType === 'article') {
      currentFileEntry = await this.findArticle(currentFile);
    } else if (parentType === 'snippet') {
      currentFileEntry = await this.findSnippet(currentFile);
    }

    // console.log(
    //   `[createSnippet] Parent type: ${parentType}, entry:`,
    //   currentFileEntry
    // );

    const priority = currentFileEntry?.priority ?? DEFAULT_PRIORITY;

    // Calculate body-relative character offsets for highlighting
    let offsets: { start: number; end: number } | null = null;

    // Try to get offsets from CodeMirror
    const cm = (editor as any).cm;
    if (cm && cm.state && cm.state.selection) {
      const range = cm.state.selection.ranges[0];
      if (range) {
        // Get body start to convert to body-relative offsets
        const docContent = cm.state.doc.toString();
        const bodyStart = this.getBodyStartOffset(docContent);

        offsets = {
          start: range.from - bodyStart, // body-relative
          end: range.to - bodyStart, // body-relative
        };
      } else {
        console.warn(`[createSnippet] CodeMirror selection has no ranges`);
      }
    } else {
      console.warn(
        `[createSnippet] Could not access CodeMirror instance or selection:`,
        {
          hasCm: !!cm,
          hasState: !!cm?.state,
          hasSelection: !!cm?.state?.selection,
        }
      );
    }

    // Create the snippet entry
    const result = await this.createSnippetEntry(
      snippetFile,
      reviewTime,
      priority,
      currentFileEntry?.id,
      offsets ?? undefined
    );

    // Refresh highlights immediately after snippet creation.
    // Always use `cm` (the CodeMirror EditorView from the active editor) rather
    // than `currentEditorView`, which may point to a different view (e.g. the
    // review interface's editor) even when the snippet was created from the
    // standard note view.
    if (offsets && cm) {
      await this.refreshHighlightsAfterSnippetCreation(
        currentFile,
        snippetFile,
        currentFileEntry,
        cm
      );
    }

    return result;
  }

  /**
   * Given a preexisting snippet file, insert into database
   */
  protected async createSnippetEntry(
    snippetFile: TFile,
    reviewTime: number,
    priority: number,
    parentId?: string,
    offsets?: { start: number; end: number }
  ) {
    try {
      // save the snippet to the database
      const result = await this.#repo.mutate(
        'INSERT INTO snippet (id, reference, due, priority, parent, start_offset, end_offset) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [
          crypto.randomUUID(),
          `${SNIPPET_DIRECTORY}/${snippetFile.name}`,
          reviewTime,
          priority,
          parentId,
          offsets?.start ?? null,
          offsets?.end ?? null,
        ]
      );

      // TODO: verify this correctly catches failed inserts
      new Notice(
        `snippet created: ${snippetFile.basename}`,
        SUCCESS_NOTICE_DURATION_MS
      );
      return result;
    } catch (error) {
      new Notice(
        `Failed to save snippet to db: ${snippetFile.basename}`,
        ERROR_NOTICE_DURATION_MS
      );
      console.error(error);
    }
  }

  async _fetchSnippetData(opts?: {
    dueBy?: number;
    limit?: number;
    includeDismissed?: boolean;
  }) {
    let query = 'SELECT * FROM snippet';
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

    return ((await this.#repo.query(query, params)) ?? []) as SnippetRow[];
  }

  async findSnippet(snippetFile: TAbstractFile): Promise<SnippetRow | null> {
    const results = await this.#repo.query(
      'SELECT * FROM snippet WHERE reference = $1',
      [this.getReferenceFromPath(snippetFile.path)]
    );

    return (results[0] as SnippetRow) ?? null;
  }

  async findCard(cardFile: TAbstractFile): Promise<SRSCardRow | null> {
    const results = await this.#repo.query(
      'SELECT * FROM srs_card WHERE reference = $1',
      [this.getReferenceFromPath(cardFile.path)]
    );

    return (results[0] as SRSCardRow) ?? null;
  }

  /**
   * Fetches a ReviewItem given a file.
   * Returns null if the item is not found in the database.
   */
  async getReviewItemFromFile(file: TFile): Promise<ReviewItem | null> {
    const noteType = this.getNoteType(file);
    if (noteType === 'article') {
      const row = await this.findArticle(file);
      if (!row) return null;
      return { data: Article.rowToBase(row), file } satisfies ReviewArticle;
    } else if (noteType === 'snippet') {
      const row = await this.findSnippet(file);
      if (!row) return null;
      return { data: Snippet.rowToBase(row), file } satisfies ReviewSnippet;
    } else if (noteType === 'card') {
      const row = await this.findCard(file);
      if (!row) return null;
      return { data: SRSCard.rowToDisplay(row), file } satisfies ReviewCard;
    }
    return null;
  }

  /**
   * Dismiss an item by type and ID
   */
  async dismissItem(type: NoteType, id: string): Promise<void> {
    const table = type === 'card' ? 'srs_card' : type;
    await this.#repo.mutate(`UPDATE ${table} SET dismissed = 1 WHERE id = $1`, [
      id,
    ]);
  }

  /**
   * Un-dismiss an item by type and ID
   */
  async unDismissItem(type: NoteType, id: string): Promise<void> {
    const table = type === 'card' ? 'srs_card' : type;
    await this.#repo.mutate(`UPDATE ${table} SET dismissed = 0 WHERE id = $1`, [
      id,
    ]);
  }

  /**
   * Get all snippet highlights for a parent article or snippet
   * Returns only snippets that have offsets (for highlighting)
   * @param parentFile The parent file to query highlights for
   * @returns Array of snippet highlights
   */
  async getSnippetHighlights(parentFile: TFile) {
    // First find the parent's ID
    const parentType = this.getNoteType(parentFile);
    let parentEntry;

    if (parentType === 'article') {
      parentEntry = await this.findArticle(parentFile);
    } else if (parentType === 'snippet') {
      parentEntry = await this.findSnippet(parentFile);
    }

    // For articles/snippets with a DB entry, use the existing parent ID query
    if (parentEntry) {
      const results = (await this.#repo.query(
        'SELECT * FROM snippet WHERE parent = $1 AND start_offset IS NOT NULL AND end_offset IS NOT NULL',
        [parentEntry.id]
      )) as SnippetRow[];

      const highlights = results.map((r) => ({
        ...r,
        dismissed: Boolean(r.dismissed),
        start_offset: r.start_offset!,
        end_offset: r.end_offset!,
        parent: r.parent!,
      }));

      this.snippetTracker.loadHighlights(parentFile.path, highlights);
      return highlights;
    }

    // For source notes (or any note without a DB entry), find snippets via backlinks
    if (this.isSourceNote(parentFile)) {
      const highlights =
        await this.getSnippetHighlightsViaBacklinks(parentFile);
      this.snippetTracker.loadHighlights(parentFile.path, highlights);
      return highlights;
    }

    return [];
  }

  /**
   * Reload or append snippet highlights into the tracker after a new snippet
   * is created, then dispatch a refresh effect so the CodeMirror extension
   * rebuilds decorations.
   *
   * For articles/snippets (which have a DB entry), we reload all highlights
   * via the parent ID query. For source notes, Obsidian's resolvedLinks may
   * not have indexed the new snippet file yet, so we look up the just-inserted
   * row directly and append it to the tracker.
   */
  private async refreshHighlightsAfterSnippetCreation(
    parentFile: TFile,
    snippetFile: TFile,
    parentEntry: ArticleRow | SnippetRow | null | undefined,
    cm: { dispatch: (spec: any) => void }
  ) {
    if (parentEntry) {
      await this.getSnippetHighlights(parentFile);
    } else {
      const snippetRow = await this.findSnippet(snippetFile);
      if (
        snippetRow &&
        snippetRow.start_offset != null &&
        snippetRow.end_offset != null
      ) {
        const existing = this.snippetTracker.getHighlights(parentFile.path);
        this.snippetTracker.loadHighlights(parentFile.path, [
          ...existing,
          {
            ...snippetRow,
            dismissed: Boolean(snippetRow.dismissed),
            start_offset: snippetRow.start_offset,
            end_offset: snippetRow.end_offset,
            parent: snippetRow.parent ?? '',
          },
        ]);
      }
    }

    const { refreshHighlightsEffect } = await import('./extensions');
    cm.dispatch({ effects: refreshHighlightsEffect.of(null) });
  }

  /**
   * Check if a file has the ir-source tag
   */
  private isSourceNote(file: TFile): boolean {
    const tags = this.app.metadataCache.getFileCache(file)?.frontmatter?.tags;
    if (!tags) return false;
    const tagSet: Set<string> = new Set(Array.isArray(tags) ? tags : [tags]);
    return tagSet.has(SOURCE_TAG);
  }

  /**
   * Find snippet highlights for a source note by scanning Obsidian's resolved backlinks.
   * For each file that links to the source and is tagged as a snippet, look up its
   * offsets in the DB.
   */
  private async getSnippetHighlightsViaBacklinks(
    sourceFile: TFile
  ): Promise<SnippetHighlight[]> {
    const resolvedLinks = this.app.metadataCache.resolvedLinks;
    const highlights: SnippetHighlight[] = [];

    for (const [linkingFilePath, links] of Object.entries(resolvedLinks)) {
      if (!(sourceFile.path in links)) continue;

      const linkingFile = this.app.vault.getAbstractFileByPath(linkingFilePath);
      if (!linkingFile || !(linkingFile instanceof TFile)) continue;
      if (this.getNoteType(linkingFile) !== 'snippet') continue;

      const snippetRow = await this.findSnippet(linkingFile);
      if (
        !snippetRow ||
        snippetRow.start_offset == null ||
        snippetRow.end_offset == null
      )
        continue;

      highlights.push({
        ...snippetRow,
        dismissed: Boolean(snippetRow.dismissed),
        start_offset: snippetRow.start_offset,
        end_offset: snippetRow.end_offset,
        parent: snippetRow.parent ?? '',
      });
    }

    return highlights;
  }

  protected async getLastSnippetReview(snippet: ISnippetBase) {
    const lastReview = (
      await this.#repo.query(
        `SELECT * FROM snippet_review WHERE snippet_id = $1 ` +
          `ORDER BY review_time DESC LIMIT 1`,
        [snippet.id]
      )
    )[0] as ISnippetReview | undefined;
    return lastReview;
  }

  /**
   * Add a SnippetReview and set the next review date
   */
  async reviewSnippet(
    snippet: ISnippetBase,
    reviewTime?: number,
    nextReviewInterval?: number
  ) {
    const reviewed = reviewTime || Date.now();
    const nextReview =
      reviewed +
      (nextReviewInterval ?? (await this.nextTextReviewInterval(snippet)));
    try {
      const insertReviewResult = await this.#repo.mutate(
        'INSERT INTO snippet_review (id, snippet_id, review_time) VALUES ($1, $2, $3)',
        [crypto.randomUUID(), snippet.id, reviewed]
      );

      const updateResult = await this.#repo.mutate(
        `UPDATE snippet SET dismissed = 0, due = $1 WHERE id = $2`,
        [nextReview, snippet.id]
      );
    } catch (error) {
      console.error(error);
    }
  }

  /**
   * Change the priority of a snippet and recalculate its next due date
   */
  async reprioritizeSnippet(snippet: ISnippetBase, newPriority: number) {
    if (newPriority % 1 !== 0 || newPriority < 10 || newPriority > 50) {
      throw new TypeError(
        `Priority must be an integer between 10 and 50 inclusive; received ${newPriority}`
      );
    }
    const { priority: _, ...rest } = snippet;
    const lastReview = await this.getLastSnippetReview(snippet);
    const newInterval = await this.nextTextReviewInterval({
      ...rest,
      priority: newPriority,
    });
    const newDueTime = lastReview
      ? lastReview.review_time + newInterval
      : snippet.due;

    await this.#repo.mutate(
      `UPDATE snippet SET priority = $1, due = $2 WHERE id = $3`,
      [newPriority, newDueTime, snippet.id]
    );
  }

  // #endregion
  // #region ARTICLES
  /**
   * Import the currently opened note as an article
   */
  async importArticle(file: TFile, priority: number) {
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
      const articleFile = await this.createNote({
        content,
        fileName: importFileName,
        directory: this.getDirectory('article'),
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
        const sourceLink = this.generateMarkdownLink(file, articleFile);
        frontmatterUpdates[`${SOURCE_PROPERTY_NAME}`] = sourceLink;
      }
      await this.updateFrontMatter(articleFile, frontmatterUpdates);

      // Insert into database with immediate due time
      const dueTime = Date.now();
      const result = await this.#repo.mutate(
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

  async getArticlesDue(
    dueBy?: number,
    limit?: number
  ): Promise<{ data: IArticleActive; file: TFile }[]> {
    const dueTime = dueBy ?? this.getEndOfToday();
    try {
      const articlesDue = (
        await this._fetchArticleData({ dueBy: dueTime, limit })
      ).map(
        async (item) => ({
          data: Article.rowToBase(item),
          file: this.getNote(item.reference),
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

  async _fetchArticleData(opts?: {
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

    return ((await this.#repo.query(query, params)) ?? []) as ArticleRow[];
  }

  getReferenceFromPath(vaultPath: string): string {
    const reference = vaultPath.split(`${DATA_DIRECTORY}/`)[1];
    return reference;
  }

  async findArticle(articleFile: TAbstractFile): Promise<ArticleRow | null> {
    const results = await this.#repo.query(
      'SELECT * FROM article WHERE reference = $1',
      [this.getReferenceFromPath(articleFile.path)]
    );

    return (results[0] as ArticleRow) ?? null;
  }

  protected async getLastArticleReview(snippet: IArticleBase) {
    const lastReview = (
      await this.#repo.query(
        `SELECT * FROM article_review WHERE article_id = $1 ` +
          `ORDER BY review_time DESC LIMIT 1`,
        [snippet.id]
      )
    )[0] as IArticleReview | undefined;
    return lastReview;
  }

  async reviewArticle(
    article: IArticleBase,
    reviewTime?: number,
    nextReviewInterval?: number
  ) {
    const reviewed = reviewTime || Date.now();
    const nextReview =
      reviewed +
      (nextReviewInterval ?? (await this.nextTextReviewInterval(article)));
    try {
      const insertReviewResult = await this.#repo.mutate(
        'INSERT INTO article_review (id, article_id, review_time) VALUES ($1, $2, $3)',
        [crypto.randomUUID(), article.id, reviewed]
      );

      const updateResult = await this.#repo.mutate(
        `UPDATE article SET dismissed = 0, due = $1 WHERE id = $2`,
        [nextReview, article.id]
      );
    } catch (error) {
      console.error(error);
    }
  }

  async renameArticle(article: ReviewArticle, newName: string) {
    const sanitized = sanitizeForTitle(newName, true);
    if (sanitized !== newName) {
      new Notice(INVALID_TITLE_MESSAGE, ERROR_NOTICE_DURATION_MS);
      return;
    }

    try {
      const currentName = article.file.basename;
      await this.renameFile(article.file, newName);
      const newReference = `${ARTICLE_DIRECTORY}/${article.file.basename}.md`;
      await this.#repo
        .mutate(`UPDATE article SET reference = $1 WHERE id = $2`, [
          newReference,
          article.data.id,
        ])
        .catch(async () => {
          await this.renameFile(article.file, currentName);
        });
    } catch (error) {
      console.error(error);
    }
  }

  /**
   * Rename a file without moving it
   * @throws if the title contains invalid characters
   * or if the rename operation fails
   */
  async renameFile(file: TFile, newName: string) {
    const sanitized = sanitizeForTitle(newName, true);
    if (sanitized !== newName) {
      throw new Error(`${INVALID_TITLE_MESSAGE}. Title was ${newName}`);
    }

    const newPath = file.parent
      ? `${file.parent.path}/${newName}.${file.extension}`
      : `${newName}.${file.extension}`;

    await this.app.fileManager.renameFile(file, newPath);
  }

  /**
   * Update database references in response to Obsidian rename events
   * @param oldPath The vault-relative path the file had before it was moved
   */
  async handleExternalRename(file: TAbstractFile, oldPath: string) {
    // TODO: handle files being moved into or out of the IR folder
    const newPath = file.path;
    console.log(`file rename detected: ${oldPath} -> ${newPath}`);
    const concreteFile = this.app.vault.getFileByPath(newPath);
    if (!concreteFile) {
      throw new Error(`Failed to find a file at ${newPath}`);
    }
    const type = this.getNoteType(concreteFile);
    if (!type) {
      console.log(`Found no matching IR tags; ignoring`);
      return;
    }
    if (!oldPath.startsWith(DATA_DIRECTORY)) {
      console.log('File was not previously in IR directory; ignoring');
      return;
    }
    if (!newPath.startsWith(DATA_DIRECTORY)) {
      console.log('File is no longer in IR directory; ignoring');
      return;
    }

    const oldReference = this.getReferenceFromPath(oldPath);
    const newReference = this.getReferenceFromPath(newPath);
    if (oldReference === newReference) {
      console.log('File reference did not change; ignoring');
      return;
    }

    const table = type === 'card' ? 'srs_card' : type;
    await this.#repo.mutate(
      `UPDATE ${table} SET reference = $1 WHERE reference = $2`,
      [newReference, oldReference]
    );
    console.log(`Reference updated to ${newReference}`);
  }

  /**
   * Change the priority of an article and recalculate its next due date
   */
  async reprioritizeArticle(article: IArticleBase, newPriority: number) {
    if (newPriority % 1 !== 0 || newPriority < 10 || newPriority > 50) {
      throw new TypeError(
        `Priority must be an integer between 10 and 50 inclusive; received ${newPriority}`
      );
    }
    const { priority: _, ...rest } = article;
    const lastReview = await this.getLastArticleReview(article);
    const newInterval = await this.nextTextReviewInterval({
      ...rest,
      priority: newPriority,
    });
    const newDueTime = lastReview
      ? lastReview.review_time + newInterval
      : article.due;

    await this.#repo.mutate(
      `UPDATE article SET priority = $1, due = $2 WHERE id = $3`,
      [newPriority, newDueTime, article.id]
    );
  }

  // #endregion
  // #region HELPERS
  protected async nextTextReviewInterval(text: IArticleBase | ISnippetBase) {
    const intervalMultiplier =
      TEXT_REVIEW_MULTIPLIER_BASE +
      (text.priority - 10) * TEXT_REVIEW_MULTIPLIER_STEP;

    const lastReview = await (isArticle(text)
      ? this.getLastArticleReview(text)
      : this.getLastSnippetReview(text));

    const lastInterval =
      lastReview && text.due
        ? text.due - lastReview.review_time
        : TEXT_BASE_REVIEW_INTERVAL;

    const nextInterval = Math.round(lastInterval * intervalMultiplier);
    return nextInterval;
  }

  /** Retrieves notes from the data directory given a row's reference */
  getNote(reference: string): TFile | null {
    return this.app.vault.getFileByPath(
      normalizePath(`${DATA_DIRECTORY}/${reference}`)
    );
  }

  /**
   *
   * @param directory path relative to the vault root
   */
  protected async createNote({
    content,
    frontmatter,
    fileName,
    directory,
  }: {
    content: string;
    frontmatter?: Record<string, any>;
    fileName: string;
    directory: string;
  }) {
    try {
      const fullPath = normalizePath(`${directory}/${fileName}`);
      const file = await createFile(this.app, fullPath);
      await this.app.vault.append(file, content);
      frontmatter && (await this.updateFrontMatter(file, frontmatter));
      return file;
    } catch (error) {
      console.error(error);
    }
  }

  /**
   * Shared logic for creating snippets and cards.
   * Throws if it fails to create the file.
   */
  protected async createFromText(textContent: string, directory: string) {
    const newNoteName = createTitle(textContent);
    const newNote = await this.createNote({
      content: textContent,
      frontmatter: {
        created: new Date().toISOString(),
      },
      fileName: `${newNoteName}.md`,
      directory,
    });

    if (!newNote) {
      const errorMsg = `Failed to create note "${newNoteName}"`;
      throw new Error(errorMsg);
    }

    return newNote;
  }

  getNoteType(note: TFile): NoteType | null {
    const tags = this.app.metadataCache.getFileCache(note)?.frontmatter?.tags;
    if (!tags) return null;

    const tagSet: Set<string> = new Set(Array.isArray(tags) ? tags : [tags]);
    if (tagSet.has(ARTICLE_TAG)) return 'article';
    else if (tagSet.has(SNIPPET_TAG)) return 'snippet';
    else if (tagSet.has(CARD_TAG)) return 'card';
    else return null;
  }

  /** Get the vault absolute directory for a type of review item */
  getDirectory(type: NoteType) {
    let subDirectory;
    if (type === 'article') subDirectory = ARTICLE_DIRECTORY;
    else if (type === 'snippet') subDirectory = SNIPPET_DIRECTORY;
    else if (type === 'card') subDirectory = CARD_DIRECTORY;
    else throw new TypeError(`Type "${type}" is invalid`);
    return normalizePath(`${DATA_DIRECTORY}/${subDirectory}`);
  }

  /**
   * Generates a link with an absolute path and the file name as alias
   */
  generateMarkdownLink(
    fileLinkedTo: TFile,
    fileContainingLink: TFile,
    alias?: string,
    subpath?: string
  ) {
    return this.app.fileManager.generateMarkdownLink(
      fileLinkedTo,
      fileContainingLink.path,
      subpath,
      alias || fileLinkedTo.basename
    );
  }

  protected async updateFrontMatter(file: TFile, updates: Record<string, any>) {
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      const { tags } = frontmatter;
      const updateTags = Array.isArray(updates.tags)
        ? updates.tags
        : [updates.tags];
      const combinedTags = tags
        ? [...new Set([...tags, ...updateTags])]
        : updateTags;
      Object.assign(frontmatter, {
        ...updates,
        tags: combinedTags,
      });
    });
  }

  /**
   * Save scroll position to database for the article or snippet
   */
  async saveScrollPosition(
    file: TFile,
    scrollInfo: { top: number; left: number }
  ) {
    const noteType = this.getNoteType(file);
    if (!noteType || noteType === 'card') return;

    const table = noteType === 'article' ? 'article' : 'snippet';
    const reference = this.getReferenceFromPath(file.path);

    await this.#repo.mutate(
      `UPDATE ${table} SET scroll_top = $1 WHERE reference = $2`,
      [Math.round(scrollInfo.top), reference]
    );
  }

  /**
   * Load scroll position from database for the article or snippet
   */
  async loadScrollPosition(
    file: TFile
  ): Promise<{ top: number; left: number } | null> {
    const noteType = this.getNoteType(file);
    if (!noteType || noteType === 'card') return null;

    let row: ArticleRow | SnippetRow | null = null;
    if (noteType === 'article') {
      row = await this.findArticle(file);
    } else if (noteType === 'snippet') {
      row = await this.findSnippet(file);
    }

    if (row && typeof row.scroll_top === 'number' && row.scroll_top > 0) {
      return { top: row.scroll_top, left: 0 };
    }

    return null;
  }
  /**
   * Get the content of the markdown block/section where the cursor is currently positioned
   * Uses Obsidian's metadata cache for accurate block detection
   */
  getCurrentBlockContent(editor: Editor, file: TFile): string | null {
    const cursor = editor.getCursor();
    const cursorOffset = editor.posToOffset(cursor);

    // Get the cached metadata for the current file
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache?.sections) {
      return null;
    }

    // Find the section that contains the cursor position
    const currentSection = cache.sections.find((section) => {
      return (
        cursorOffset >= section.position.start.offset &&
        cursorOffset <= section.position.end.offset
      );
    });

    if (!currentSection) {
      return null;
    }

    // Get the content of the section
    const sectionStart = currentSection.position.start.offset;
    const sectionEnd = currentSection.position.end.offset;
    const fullContent = editor.getValue();

    return fullContent.slice(sectionStart, sectionEnd);
  }
  /**
   * (WIP) Get the block, bullet list item, or code block the cursor is currently within
   */
  getCurrentContent(editor: Editor, file: TFile) {
    const cursor = editor.getCursor();
    const block = editor.getLine(cursor.line);

    return { content: block, line: cursor.line };
  }
  // #endregion
}
