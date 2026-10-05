import { Markdown } from '#/lib/Markdown';
import { decodeAnchor } from '#/lib/pdf/pdf-anchor';
import {
  type PdfOrigin,
  type PdfSelection,
  originFile,
  pageLinkAlias,
} from '#/lib/pdf/pdf-selection';
import type {
  ISRSCard,
  ISRSCardDisplay,
  MissingItem,
  ReviewCard,
  SQLiteRepository,
  SRSCardReviewRow,
  SRSCardRow,
} from '#/lib/types';
import type IncrementalReadingPlugin from '#/main';
import type ReviewView from '#/views/ReviewView';
import {
  type Editor,
  type EditorPosition,
  type MarkdownView,
  type TFile,
} from 'obsidian';
import {
  type Grade,
  type StateType,
  fsrs,
  generatorParameters,
  State,
} from 'ts-fsrs';
import {
  CARD_ANSWER_REPLACEMENT,
  CARD_TAG,
  CLOZE_DELIMITER_PATTERN,
  CLOZE_DELIMITERS,
  CLOZE_GROUPS_PATTERN,
  literal,
  MAX_SQL_QUERY_PARAMS,
  MS_PER_DAY,
  SOURCE_PROPERTY_NAME,
  TRANSCLUSION_HIDE_TITLE_ALIAS,
  VALID_DELIMITER_PATTERN,
} from '../constants';
import { ObsidianHelpers as Obsidian } from '../ObsidianHelpers';
import { getEndOfDay, searchAll } from '../utils';
import { ItemManager } from './ItemManager';
import SRSCard from './SRSCard';
import SRSCardReview from './SRSCardReview';

/** A span of a note chosen to become a card: its document offsets and text. */
export type CardSelection = { from: number; to: number; text: string };

/**
 * Where a card made other than from a note's text links back to: its parent's
 * row, and the subpath and alias of the link to it. And the text to name its
 * note after, as it reads.
 */
type CardOrigin = {
  parent: string | null;
  subpath: string;
  alias: string;
  title: string;
};

export class CardManager extends ItemManager {
  constructor(plugin: IncrementalReadingPlugin, repo: SQLiteRepository) {
    super(plugin, repo);
  }

  static rowToDisplay(cardRow: SRSCardRow): ISRSCardDisplay {
    const { created_at, due, dismissed, last_review, state, ...rest } = cardRow;
    return {
      ...rest,
      type: 'card',
      created_at: new Date(created_at),
      due: new Date(due),
      ...(last_review !== null && {
        last_review: new Date(last_review),
      }),
      dismissed: !!dismissed,
      state: State[state] as StateType,
    };
  }

  static displayToRow(card: ISRSCardDisplay): SRSCardRow {
    const {
      created_at,
      due,
      dismissed,
      last_review,
      state,
      type: _,
      ...rest
    } = card;
    return {
      ...rest,
      created_at: Date.parse(created_at.toISOString()),
      due: Date.parse(due.toISOString()),
      dismissed: dismissed ? 1 : 0,
      last_review: last_review ? Date.parse(last_review.toISOString()) : null,
      state: State[state],
    };
  }

  static baseToRow(card: ISRSCard): SRSCardRow {
    const { created_at, due, dismissed, last_review, type: _, ...rest } = card;
    return {
      ...rest,
      created_at: Date.parse(created_at.toISOString()),
      due: Date.parse(due.toISOString()),
      dismissed: dismissed ? 1 : 0,
      last_review: last_review ? Date.parse(last_review.toISOString()) : null,
    };
  }

  static getClozeGroupsPattern(delimiters: [string, string]) {
    return new RegExp(
      `([\\s\\S]*)` +
        `${literal(delimiters[0])}` +
        `([\\s\\S]*?)` +
        `${literal(delimiters[1])}` +
        `([\\s\\S]*)`
    );
  }
  /** Format a card's text, replacing the answer with a placeholder */
  static hideAnswer(cardContent: string): string {
    const match = cardContent.match(CLOZE_GROUPS_PATTERN);
    if (!match) {
      throw new Error(`Valid cloze delimiters not found in: ${cardContent}`);
    }
    const [_, pre, _answer, post] = match;
    const formattedContent = pre + CARD_ANSWER_REPLACEMENT + post;
    return formattedContent;
  }

  rowToReviewCard(row: SRSCardRow): ReviewCard | null {
    const base = CardManager.rowToDisplay(row);
    const file = Obsidian.getNote(row.reference, this.app);
    // Missing, which is never stored: see `MissingItem`
    if (!file) return null;

    if (!this.reconcileNote(row, file, 'card', CARD_TAG)) return null;

    return {
      data: base,
      file,
    };
  }

  async getDue(
    dueBy?: number,
    limit?: number,
    excludeIds?: string[]
  ): Promise<(ReviewCard | MissingItem<ISRSCardDisplay>)[]> {
    const dueTime =
      dueBy ?? getEndOfDay(this.plugin.settings.dayRolloverOffset);
    let allExcluded = [...(excludeIds ?? [])];
    let due: (ReviewCard | MissingItem<ISRSCardDisplay>)[];
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
            const item =
              this.rowToReviewCard(row) ??
              this.asMissing(CardManager.rowToDisplay(row));
            if (!item) {
              allExcluded.push(row.id);
              lastMissingNotes += 1;
            }
            return item;
          }, this)
          .filter((card) => card !== null);
      } while (lastMissingNotes !== 0);
      return due;
    } catch (error) {
      console.error(error);
      return [];
    }
  }

  async create(editor: Editor, view: MarkdownView | ReviewView) {
    const currentFile = view.file;
    if (!currentFile) {
      Obsidian.notify(`A Markdown file must be active`);
      return null;
    }

    // remove leading indent and bullet/number/checkbox formatting
    const { line, lineNumber, start, end } = Obsidian.smartGetline(
      editor,
      currentFile,
      this.app
    );
    const selectionBounds = Obsidian.getSelectionWithBounds(editor);
    if (!selectionBounds) {
      Obsidian.notify('Text must be selected');
      return;
    }

    // Moved off any escape pair it splits, and off a backslash that would
    // escape the delimiter put after it
    const bounds = Markdown.snapOffEscapes(
      line,
      [selectionBounds.start.ch - start, selectionBounds.end.ch - start],
      { delimited: true }
    );

    try {
      const withDelimiters = this.delimitText(line, bounds)[0];
      const reviewCard = await this.createAndEmbed(
        editor,
        currentFile,
        withDelimiters,
        { line: lineNumber, ch: start },
        { line: lineNumber, ch: end }
      );
      // move the cursor to the next block
      editor.setSelection({ line: lineNumber + 1, ch: 0 });
      return {
        reviewCard,
        line,
        lineNumber,
        start,
        end,
      };
    } catch (error) {
      if (error instanceof Error) {
        console.error(error);
      }
      Obsidian.notify(`Failed to create card`);
      return null;
    }
  }

  /**
   * Make a card of a span of the note chosen up front — in selection mode —
   * rather than of the line the cursor is on, with its answer chosen apart from
   * it. The span is replaced by the card's embed, as the line is by
   * {@link create}.
   *
   * The span and its text were read before the answer was asked for, and the
   * note can change while that question is open. The text is checked against
   * the span again first, so a card is never made of text the note no longer
   * holds, nor its embed written over text the user never chose.
   *
   * @param selection document offsets of the span, and the text it held
   * @param answer offsets of the answer within that text
   */
  async createFromSelection(
    editor: Editor,
    view: MarkdownView | ReviewView,
    selection: CardSelection,
    answer: readonly [number, number]
  ) {
    const currentFile = view.file;
    if (!currentFile) {
      Obsidian.notify(`A Markdown file must be active`);
      return null;
    }

    if (
      editor.getRange(
        editor.offsetToPos(selection.from),
        editor.offsetToPos(selection.to)
      ) !== selection.text
    ) {
      Obsidian.notify(`The selected text changed before the card was made`);
      return null;
    }
    // The span and its answer, snapped off any escape pair they split
    const doc = editor.getValue();
    const [from, to] = Markdown.snapOffEscapes(doc, [
      selection.from,
      selection.to,
    ]);
    const text = doc.slice(from, to);
    const shift = selection.from - from;
    const start = editor.offsetToPos(from);
    const end = editor.offsetToPos(to);

    try {
      const withDelimiters = this.delimitText(
        text,
        Markdown.snapOffEscapes(text, [answer[0] + shift, answer[1] + shift], {
          delimited: true,
        })
      )[0];
      const reviewCard = await this.createAndEmbed(
        editor,
        currentFile,
        withDelimiters,
        start,
        end
      );
      // Off the embed's line, as `create` does, so live preview renders the
      // embed rather than revealing its source around the cursor. The span may
      // have held several lines, but the embed that replaced it holds one.
      editor.setSelection({
        line: Math.min(start.line + 1, editor.lastLine()),
        ch: 0,
      });
      return {
        reviewCard,
        line: text,
        lineNumber: start.line,
        start: start.ch,
        end: end.ch,
      };
    } catch (error) {
      if (error instanceof Error) {
        console.error(error);
      }
      Obsidian.notify(`Failed to create card`);
      return null;
    }
  }

  /**
   * Make a card of text selected in a PDF. Unlike a card from a note, nothing
   * is put in place of the text: the PDF is never written to. The card links
   * back to the selection as a snippet from the PDF does. Its parent is the
   * article's row, since a PDF has no frontmatter to find it by; a PDF that is
   * no article leaves it parentless, as a note that is none does, until the
   * PDF is imported (see {@link adoptOrphans}).
   * The text is escaped before its answer is delimited, so that whatever the
   * PDF holds reads as plain text: see `Markdown.escape`.
   *
   * @param selection the selection as `readPdfSelection` read it
   * @param answer offsets of the answer within its text
   */
  async createFromPdf({
    text,
    start,
    subpath,
    answer,
    ...origin
  }: PdfSelection &
    PdfOrigin & {
      answer: readonly [number, number];
    }): Promise<ReviewCard | null> {
    const pdf = originFile(origin);
    try {
      const escaped = Markdown.escapeAround(text, answer);
      return await this.createFileAndEntry(
        this.delimitText(escaped.text, escaped.range)[0],
        pdf,
        {
          parent: origin.article?.data.id ?? null,
          subpath,
          alias: pageLinkAlias(pdf.basename, decodeAnchor(start).page),
          // Named as a card from a note is, after its text as it reads
          title: this.delimitText(text, answer)[0],
        }
      );
    } catch (_error) {
      // `createFileAndEntry` has logged it
      Obsidian.notify(`Failed to create card`);
      return null;
    }
  }

  /** Make the card's note and row, and put its embed in place of `start`–`end`. */
  protected async createAndEmbed(
    editor: Editor,
    sourceFile: TFile,
    delimitedText: string,
    start: EditorPosition,
    end: EditorPosition
  ) {
    const reviewCard = await this.createFileAndEntry(delimitedText, sourceFile);
    if (!reviewCard) throw new Error(`Failed to create card`);

    const linkToCard = Obsidian.generateMarkdownLink(
      reviewCard.file,
      sourceFile,
      this.app,
      TRANSCLUSION_HIDE_TITLE_ALIAS
    );
    Obsidian.transcludeLink(editor, linkToCard, start, end);
    return reviewCard;
  }

  /**
   * Make the card's note and row. Its parent is found by `sourceFile`'s note
   * type, unless `origin` gives it, along with how to link to `sourceFile`.
   *
   * A note made for a row that then can't be saved is trashed again: with no
   * row, review would never show it. Once the row is saved, the note is the
   * card's whatever fails after.
   */
  protected async createFileAndEntry(
    delimitedText: string,
    sourceFile: TFile,
    origin?: CardOrigin
  ) {
    let cardFile: TFile | null = null;
    let saved = false;
    try {
      // Create the card from the content
      cardFile = await Obsidian.createFromText(
        delimitedText,
        Obsidian.getDirectory('card'),
        this.app,
        origin?.title
      );

      const card = new SRSCard(cardFile.path);

      const linkToSource = Obsidian.generateMarkdownLink(
        sourceFile,
        cardFile,
        this.app,
        origin?.alias,
        origin?.subpath
      );
      await Obsidian.updateFrontMatter(
        cardFile,
        {
          'ir-id': card.id,
          tags: CARD_TAG,
          [`${SOURCE_PROPERTY_NAME}`]: linkToSource,
          delimiters: CLOZE_DELIMITERS,
        },
        this.app
      );

      const parent = origin
        ? origin.parent
        : await this.findParentId(sourceFile);
      // create the database entry

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
        card.learning_steps,
        card.reps,
        card.lapses,
        card.state,
      ];
      await this.repo.mutate(
        `INSERT INTO srs_card (id, reference, parent, created_at, due, last_review, ` +
          `stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state) ` +
          `VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        params
      );
      saved = true;

      const reviewCard = await this.fetch(card.id);
      return reviewCard;
    } catch (error) {
      console.error(error);
      if (cardFile && !saved) {
        await this.app.fileManager.trashFile(cardFile).catch(console.error);
      }
      throw error;
    }
  }

  /**
   * Hand every parentless card taken from `file` to the item `parentId` now
   * backing it, as an import does for its snippets.
   * @returns the adopted rows, carrying their new parent
   */
  async adoptOrphans(file: TFile, parentId: string): Promise<SRSCardRow[]> {
    return this.adoptParentless<SRSCardRow>('srs_card', file, parentId);
  }

  /** The id of the row of the article or snippet note `file`, if it is one. */
  private async findParentId(file: TFile) {
    const parentType = await Obsidian.getNoteType(file, this.app);
    let entry;
    if (parentType === 'article') {
      entry = await this.findArticle(file);
    } else if (parentType === 'snippet') {
      entry = await this.findSnippet(file);
    }
    return entry ? entry.id : null;
  }

  /**
   * Drop a card's row and delete its note
   *
   * @param options.prompt whether to delete the note as Obsidian does from
   *   its own menus (the default): asking first, if the user has it ask, and
   *   then offering to delete whatever only the note linked to. That includes
   *   the PDF a note made from one links to as its source, so an undo, which
   *   only takes back what it made, says `false` and trashes just the note.
   */
  async delete(id: string, { prompt = true }: { prompt?: boolean } = {}) {
    try {
      const row = (
        await this.repo.query(`SELECT * FROM srs_card WHERE id = $1`, [id])
      )[0] as SRSCardRow | null;
      if (!row) throw new Error(`No card was found with ID "${id}"`);

      const file = Obsidian.getNote(row.reference, this.app);
      if (file) {
        // delete the card file. `promptForFileDeletion` is undocumented
        // Obsidian API (`trashFile` is the public one); its offer to delete
        // unlinked attachments was read from the app bundle.
        await (prompt
          ? this.plugin.app.fileManager.promptForFileDeletion(file)
          : this.plugin.app.fileManager.trashFile(file));
      }

      // remove the row entirely
      await this.repo.mutate(`DELETE FROM srs_card WHERE id = $1`, [id]);
      return true;
    } catch (e) {
      return false;
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
  protected delimitText(
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

  async updateDelimiters(
    reviewCard: ReviewCard,
    oldDelimiters: [string, string]
  ) {
    try {
      let currentDelimiters = oldDelimiters;
      let delimitersChanged = true;
      const [left, right] = CLOZE_DELIMITERS;

      await Obsidian.updateFrontMatter(
        reviewCard.file,
        (frontmatter: Record<string, unknown>) => {
          if ('delimiters' in frontmatter) {
            currentDelimiters = frontmatter.delimiters as [string, string];
          }
          if (!Array.isArray(currentDelimiters)) {
            throw new TypeError(
              `Delimiters stored on note "${reviewCard.data.reference}" were not a list`
            );
          }
          if (currentDelimiters[0] === left && currentDelimiters[1] === right) {
            delimitersChanged = false;
          } else {
            frontmatter.delimiters = CLOZE_DELIMITERS;
          }
        },
        this.app
      );
      if (!delimitersChanged) return;

      await Obsidian.editNote(this.app, reviewCard.file, (fileText) => {
        const split = Obsidian.splitFrontMatter(fileText);
        if (!split)
          throw new Error(
            `Failed to parse frontmatter from note "${reviewCard.data.reference}, but note has frontmatter`
          );
        const { start, answer, end } = this.parseCloze(
          split.body,
          currentDelimiters
        );
        return split.frontMatter + start + `${left}${answer}${right}` + end;
      });
    } catch (error) {
      if (error instanceof Error) {
        const refMessage = `\nThis error occurred in "${reviewCard.data.reference}"`;
        throw new Error(error.message + refMessage, { cause: error });
      }
    }
  }

  parseCloze(
    text: string,
    delimiters: [string, string]
  ): { start: string; answer: string; end: string } {
    if (
      !delimiters.every((delimiter) => VALID_DELIMITER_PATTERN.test(delimiter))
    ) {
      throw new Error(
        `Delimiters cannot start or end with spaces, letters, or digits. ` +
          `Received "${delimiters.join(', ')}"`
      );
    }
    const currentGroupsPattern = CardManager.getClozeGroupsPattern(delimiters);
    const match = text.match(currentGroupsPattern);
    if (!match)
      throw new Error(
        `Failed to find delimiters ${delimiters.toString()} in the note body`
      );
    const [_, start, answer, end] = match;
    return { start, answer, end };
  }

  async fetch(id: string): Promise<ReviewCard | null> {
    const query = `SELECT * FROM srs_card WHERE id = $1`;
    const result = await this.repo.query(query, [id]);
    if (!result[0]) return null;
    return this.rowToReviewCard(result[0] as SRSCardRow);
  }

  async fetchMany(opts?: {
    dueBy?: number;
    limit?: number;
    includeDismissed?: boolean;
    includeDeleted?: boolean;
    excludeIds?: string[];
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

    query += ' ORDER BY due ASC';

    if (opts?.limit) {
      params.push(opts?.limit);
      query += ` LIMIT $${params.length}`;
    }

    if (params.length > MAX_SQL_QUERY_PARAMS) {
      throw new Error(
        `Param count ${params.length} exceeded the limit for query "${query}"`
      );
    }
    return ((await this.repo.query(query, params)) ?? []) as SRSCardRow[];
  }

  getFsrs() {
    const params = generatorParameters(this.plugin.settings.fsrsParams);
    return fsrs(params);
  }

  async review(card: ISRSCardDisplay, grade: Grade, reviewTime?: Date) {
    const recordLog = this.getFsrs().repeat(
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

    const { nextCard, reviewLog } = recordLog;
    const storedCard = (
      await this.repo.query(`SELECT * FROM srs_card WHERE id = $1`, [card.id])
    )[0] as SRSCardRow;
    if (!storedCard) {
      throw new Error(`No card found with id ${card.id}`);
    }

    const reviewRow = SRSCardReview.displayToRow(
      new SRSCardReview(card.id, reviewLog)
    );

    await this.repo.transaction(async () => {
      const updatedCard = CardManager.baseToRow(nextCard);
      let updateQuery = `UPDATE srs_card SET `;
      const columnUpdateSegments = [
        `due = $1, last_review = $2`,
        `stability = $3, difficulty = $4`,
        `elapsed_days = $5`,
        `scheduled_days = $6`,
        `learning_steps = $7`,
        `reps = $8, lapses = $9`,
        `state = $10, dismissed = 0`,
      ];
      updateQuery += columnUpdateSegments.join(', ');
      updateQuery += ` WHERE id = $11`;
      const updateParams = [
        updatedCard.due,
        updatedCard.last_review,
        updatedCard.stability,
        updatedCard.difficulty,
        updatedCard.elapsed_days,
        updatedCard.scheduled_days,
        updatedCard.learning_steps,
        updatedCard.reps,
        updatedCard.lapses,
        updatedCard.state,
        card.id,
      ];
      await this.repo.mutate(updateQuery, updateParams);

      const insertQuery =
        `INSERT INTO srs_card_review ` +
        `(id, card_id, due, review, stability, difficulty, ` +
        `elapsed_days, last_elapsed_days, scheduled_days, ` +
        `learning_steps, rating, state) VALUES ` +
        `($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`;

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
        reviewRow.learning_steps,
        reviewRow.rating,
        reviewRow.state,
      ];
      await this.repo.mutate(insertQuery, insertParams);
    });

    return reviewRow.id;
  }

  async rollbackBeforeReview(card: ISRSCardDisplay, reviewRowId: string) {
    const reviewRow = (
      await this.repo.query(
        `SELECT * FROM srs_card_review WHERE id = $1 AND card_id = $2`,
        [reviewRowId, card.id]
      )
    )[0] as SRSCardReviewRow | undefined;
    if (!reviewRow) {
      throw new Error(
        `No card review found with id ${reviewRowId} for card ${card.id}`
      );
    }

    const rolledBackCard = this.getFsrs().rollback(card, reviewRow);
    await this.repo.transaction(async () => {
      // update the card row
      const updatedCard = CardManager.baseToRow({ ...card, ...rolledBackCard });
      let updateQuery = `UPDATE srs_card SET `;
      const columnUpdateSegments = [
        `due = $1, last_review = $2`,
        `stability = $3, difficulty = $4`,
        `elapsed_days = $5`,
        `scheduled_days = $6`,
        `learning_steps = $7`,
        `reps = $8, lapses = $9`,
        `state = $10, dismissed = 0`,
      ];
      updateQuery += columnUpdateSegments.join(', ');
      updateQuery += ` WHERE id = $11`;
      const updateParams = [
        updatedCard.due,
        updatedCard.last_review,
        updatedCard.stability,
        updatedCard.difficulty,
        updatedCard.elapsed_days,
        updatedCard.scheduled_days,
        updatedCard.learning_steps,
        updatedCard.reps,
        updatedCard.lapses,
        updatedCard.state,
        card.id,
      ];
      await this.repo.mutate(updateQuery, updateParams);

      // delete the specified review and all following reviews for this card
      await this.repo.mutate(
        `DELETE FROM srs_card_review WHERE card_id = $1 AND review >= $2`,
        [card.id, reviewRow.review]
      );
    });
  }
}
