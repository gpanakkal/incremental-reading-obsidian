import type { TFile, TAbstractFile, FileView } from 'obsidian';
import {
  normalizePath,
  Notice,
  type App,
  type Editor,
  type MarkdownView,
} from 'obsidian';
import type { SQLiteRepository } from './repository';
import type { IArticleReview, NoteType, ReviewArticle } from '#/lib/types';
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
} from '#/lib/types';
import {
  SNIPPET_DIRECTORY,
  TEXT_BASE_REVIEW_INTERVAL,
  SNIPPET_TAG,
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
  SCROLL_TOP_PROPERTY_NAME,
  SCROLL_LEFT_PROPERTY_NAME,
} from './constants';
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
} from './utils';
import SRSCard from './SRSCard';
import { randomUUID } from 'crypto';
import type ReviewView from 'src/views/ReviewView';
import SRSCardReview from './SRSCardReview';
import Article from './Article';
import Snippet from './Snippet';

const FSRS_PARAMETER_DEFAULTS: Partial<FSRSParameters> = {
  enable_fuzz: false,
  enable_short_term: false,
};

export default class ReviewManager {
  app: App;
  #repo: SQLiteRepository;
  #fsrs: FSRS;

  constructor(app: App, repo: SQLiteRepository) {
    this.app = app;
    this.#repo = repo;
    const params = generatorParameters(FSRS_PARAMETER_DEFAULTS);

    this.#fsrs = fsrs(params);
  }

  // TODO: remove for production
  get repo() {
    return this.#repo;
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

  async getCardsDue(
    dueBy?: number,
    limit?: number
  ): Promise<{ data: ISRSCardDisplay; file: TFile }[]> {
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

  transcludeLink(editor: Editor, link: string, blockLine: number) {
    const line = editor.getLine(blockLine);
    editor.replaceRange(
      `!${link}`,
      { line: blockLine, ch: 0 },
      { line: blockLine, ch: line.length }
    );
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
    // console.log('blockContent:', block);
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
        card.due.getTime(),
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

  /**
   * TODO: store the updates in db
   */
  async reviewCard(card: ISRSCardDisplay, grade: Grade, reviewTime?: Date) {
    const recordLog = this.#fsrs.repeat(
      card,
      reviewTime || new Date(),
      (recordLog) => {
        const recordLogItem = recordLog[grade];
        // console.log({ card, recordLog, recordLogItem });
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
        `state = $9`,
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

  async dismissCard(card: ISRSCard | ISRSCardDisplay) {
    try {
      await this.#repo.mutate(
        'UPDATE srs_card SET dismissed = 1 WHERE id = $1',
        [card.id]
      );
    } catch (error) {
      console.error(error);
    }
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
    if (!view.file) {
      new Notice(
        `Snipping not supported from ${view.getViewType()}`,
        ERROR_NOTICE_DURATION_MS
      );
      return;
    }
    const selection = editor.getSelection() || view.getSelection();
    if (!selection) {
      new Notice('Text must be selected', ERROR_NOTICE_DURATION_MS);
      return;
    }

    const currentFile = view.file;
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

    // inherit priority from the source file if it has one, or assign default priority
    const parentType = this.getNoteType(currentFile);
    let currentFileEntry;
    if (parentType === 'article') {
      currentFileEntry = await this.findArticle(currentFile);
    } else if (parentType === 'snippet') {
      currentFileEntry = await this.findSnippet(currentFile);
    }
    const priority = currentFileEntry?.priority ?? DEFAULT_PRIORITY;

    // Transclude the snippet into its source location
    const linkToSnippet = this.generateMarkdownLink(
      snippetFile,
      currentFile,
      TRANSCLUSION_HIDE_TITLE_ALIAS
    );
    editor.replaceSelection(`!${linkToSnippet}`);

    return this.createSnippetEntry(
      snippetFile,
      reviewTime,
      priority,
      currentFileEntry?.id
    );
  }

  /**
   * Given a preexisting snippet file, insert into database
   */
  protected async createSnippetEntry(
    snippetFile: TFile,
    reviewTime: number,
    priority: number,
    parentId?: string
  ) {
    try {
      // save the snippet to the database
      const result = await this.#repo.mutate(
        'INSERT INTO snippet (id, reference, due, priority, parent) VALUES ($1, $2, $3, $4, $5)',
        [
          randomUUID(),
          `${SNIPPET_DIRECTORY}/${snippetFile.name}`,
          reviewTime,
          priority,
          parentId,
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

  protected async getLastSnippetReview(snippet: ISnippetActive) {
    const lastReview = (await this.#repo.query(
      `SELECT review_time FROM snippet_review WHERE snippet_id = $1 ` +
        `ORDER BY review_time DESC LIMIT 1`,
      [snippet.id]
    )) as ISnippetReview[];
    return lastReview;
  }

  /**
   * Add a SnippetReview and set the next review date
   */
  async reviewSnippet(
    snippet: ISnippetActive,
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
        [randomUUID(), snippet.id, reviewed]
      );

      const updateResult = await this.#repo.mutate(
        `UPDATE snippet SET due = $1 WHERE id = $2`,
        [nextReview, snippet.id]
      );
    } catch (error) {
      console.error(error);
    }
  }

  /**
   * Change the priority of a snippet, automatically adjusting the next due date
   */
  async reprioritizeSnippet(snippet: ISnippetActive, newPriority: number) {
    if (newPriority % 1 !== 0 || newPriority < 10 || newPriority > 50) {
      throw new TypeError(
        `Priority must be an integer between 10 and 50 inclusive; received ${newPriority}`
      );
    }
    const { priority: _, ...rest } = snippet;
    const newInterval = await this.nextTextReviewInterval({
      ...rest,
      priority: newPriority,
    });
    const newDueTime = Date.now() + newInterval;

    await this.#repo.mutate(
      `UPDATE snippet SET priority = $1, due = $2 WHERE id = $3`,
      [newPriority, newDueTime, snippet.id]
    );
  }

  async dismissSnippet(snippet: ISnippetActive) {
    try {
      await this.#repo.mutate(
        'UPDATE snippet SET dismissed = 1 WHERE id = $1',
        [snippet.id]
      );
    } catch (error) {
      console.error(error);
    }
  }
  // #endregion
  // #region ARTICLES
  /**
   * Import the currently opened note as an article
   */
  async importArticle(view: MarkdownView | FileView, priority: number) {
    const currentFile = view.file;
    if (!currentFile) {
      new Notice(`A markdown file must be active`, ERROR_NOTICE_DURATION_MS);
      return;
    }

    try {
      // check if the file is inside the plugin's data directory
      const inDataDir = currentFile.path.startsWith(DATA_DIRECTORY);
      if (currentFile.path.startsWith(DATA_DIRECTORY)) {
        new Notice(
          `Note is already in the plugin data folder; canceling import`,
          ERROR_NOTICE_DURATION_MS
        );
        return;
      }
      // Read the content of the current file
      const content = await this.app.vault.cachedRead(currentFile);
      const frontmatter =
        this.app.metadataCache.getFileCache(currentFile)?.frontmatter;
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

      if (isDuplicate(currentFile.name)) {
        new Notice(
          `Warning: article with name already exists "${currentFile.name}"`,
          ERROR_NOTICE_DURATION_MS
        );
      }

      let importFileName = currentFile.name;
      while (isDuplicate(importFileName)) {
        importFileName = `${currentFile.basename} - ${generateId()}.${currentFile.extension}`;
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
        const sourceLink = this.generateMarkdownLink(currentFile, articleFile);
        frontmatterUpdates[`${SOURCE_PROPERTY_NAME}`] = sourceLink;
      }
      await this.updateFrontMatter(articleFile, frontmatterUpdates);

      // Insert into database with immediate due time
      const dueTime = Date.now();
      const result = await this.#repo.mutate(
        'INSERT INTO article (id, reference, due, priority) VALUES ($1, $2, $3, $4)',
        [
          randomUUID(),
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
        `Failed to import article "${currentFile.name}"`,
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

  protected async getLastArticleReview(snippet: IArticleActive) {
    const lastReview = (await this.#repo.query(
      `SELECT review_time FROM article_review WHERE article_id = $1 ` +
        `ORDER BY review_time DESC LIMIT 1`,
      [snippet.id]
    )) as IArticleReview[];
    return lastReview;
  }

  async reviewArticle(
    article: IArticleActive,
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
        [randomUUID(), article.id, reviewed]
      );

      const updateResult = await this.#repo.mutate(
        `UPDATE article SET due = $1 WHERE id = $2`,
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
   * Change the priority of an article, automatically adjusting the next due date
   */
  async reprioritizeArticle(article: IArticleActive, newPriority: number) {
    if (newPriority % 1 !== 0 || newPriority < 10 || newPriority > 50) {
      throw new TypeError(
        `Priority must be an integer between 10 and 50 inclusive; received ${newPriority}`
      );
    }
    const { priority: _, ...rest } = article;
    const newInterval = await this.nextTextReviewInterval({
      ...rest,
      priority: newPriority,
    });
    const newDueTime = Date.now() + newInterval;

    await this.#repo.mutate(
      `UPDATE article SET priority = $1, due = $2 WHERE id = $3`,
      [newPriority, newDueTime, article.id]
    );
  }

  async dismissArticle(article: IArticleActive) {
    try {
      await this.#repo.mutate(
        'UPDATE article SET dismissed = 1 WHERE id = $1',
        [article.id]
      );
    } catch (error) {
      console.error(error);
    }
  }
  // #endregion
  // #region HELPERS
  protected async nextTextReviewInterval(
    text: IArticleActive | ISnippetActive
  ) {
    const intervalMultiplier =
      TEXT_REVIEW_MULTIPLIER_BASE +
      (text.priority - 10) * TEXT_REVIEW_MULTIPLIER_STEP;

    const lastReview = await (isArticle(text)
      ? this.getLastArticleReview(text)
      : this.getLastSnippetReview(text));

    const lastInterval = lastReview[0]
      ? text.due - lastReview[0].review_time
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
   * Given a file's path, append to the end of the file, or
   * if passed a callback, modify the file's contents
   */
  protected async updateFile(
    filePath: string,
    update: string | ((currentText: string) => string | Promise<string>)
  ) {
    const file = this.app.vault.getFileByPath(normalizePath(filePath));
    if (!file) {
      throw new Error(`Failed to open file at ${filePath}`);
    }

    if (typeof update === 'function') {
      const currentText = await this.app.vault.read(file);
      await update(currentText);
    } else {
      await this.app.vault.append(file, update);
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
      // new Notice(errorMsg);
      // return;
      throw new Error(errorMsg);
    }

    return newNote;
  }

  protected getNoteType(note: TFile): NoteType | null {
    // get tags
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
   * Save scroll position to file frontmatter
   */
  async saveScrollPosition(
    file: TFile,
    scrollInfo: { top: number; left: number }
  ) {
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter[SCROLL_TOP_PROPERTY_NAME] = scrollInfo.top;
      frontmatter[SCROLL_LEFT_PROPERTY_NAME] = scrollInfo.left;
    });
  }

  /**
   * Load scroll position from file frontmatter
   */
  loadScrollPosition(file: TFile): { top: number; left: number } | null {
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter;

    if (!frontmatter) return null;

    const top = frontmatter[SCROLL_TOP_PROPERTY_NAME];
    const left = frontmatter[SCROLL_LEFT_PROPERTY_NAME];

    if (typeof top === 'number' && typeof left === 'number') {
      return { top, left };
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
