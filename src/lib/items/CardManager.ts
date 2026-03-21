import { Notice, type App, type Editor, type MarkdownView } from 'obsidian';
import { fsrs, generatorParameters, State } from 'ts-fsrs';
import type {
  ISRSCard,
  ISRSCardDisplay,
  ReviewCard,
  SRSCardRow,
} from '#/lib/types';
import {
  CARD_ANSWER_REPLACEMENT,
  CARD_DIRECTORY,
  CARD_TAG,
  CLOZE_DELIMITER_PATTERN,
  CLOZE_DELIMITERS,
  CLOZE_GROUPS_PATTERN,
  ERROR_NOTICE_DURATION_MS,
  literal,
  MAX_SQL_QUERY_PARAMS,
  MS_PER_DAY,
  SOURCE_PROPERTY_NAME,
  TRANSCLUSION_HIDE_TITLE_ALIAS,
} from '../constants';
import { ObsidianHelpers as Obsidian } from '../ObsidianHelpers';
import SRSCard from '../SRSCard';
import SRSCardReview from '../SRSCardReview';
import { getEndOfToday, searchAll } from '../utils';
import { ItemManager } from './ItemManager';
import type { SQLiteRepository } from '../types';
import type { TFile } from 'obsidian';
import type ReviewView from 'src/views/ReviewView';
import type { FSRS, FSRSParameters, Grade, StateType } from 'ts-fsrs';

const FSRS_PARAMETER_DEFAULTS: Partial<FSRSParameters> = {
  enable_fuzz: false,
  enable_short_term: false,
};

export class CardManager extends ItemManager {
  app: App;
  repo: SQLiteRepository;
  #fsrs: FSRS;

  constructor(app: App, repo: SQLiteRepository) {
    super(app, repo);
    const params = generatorParameters(FSRS_PARAMETER_DEFAULTS);
    this.#fsrs = fsrs(params);
  }

  static rowToDisplay(cardRow: SRSCardRow): ISRSCardDisplay {
    const { created_at, due, dismissed, last_review, state, ...rest } = cardRow;
    return {
      ...rest,
      created_at: new Date(created_at),
      due: new Date(due),
      ...(last_review && {
        last_review: new Date(last_review),
      }),
      dismissed: !!dismissed,
      state: State[state] as StateType,
    };
  }

  static displayToRow(card: ISRSCardDisplay): SRSCardRow {
    const { created_at, due, dismissed, last_review, state, ...rest } = card;
    return {
      ...rest,
      created_at: Date.parse(created_at.toISOString()),
      due: Date.parse(due.toISOString()),
      dismissed: dismissed ? 1 : 0,
      last_review: last_review ? Date.parse(last_review?.toISOString()) : null,
      state: State[state],
    };
  }

  static baseToRow(card: ISRSCard): SRSCardRow {
    const { created_at, due, dismissed, last_review, ...rest } = card;
    return {
      ...rest,
      created_at: Date.parse(created_at.toISOString()),
      due: Date.parse(due.toISOString()),
      dismissed: dismissed ? 1 : 0,
      last_review: last_review ? Date.parse(last_review?.toISOString()) : null,
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
    if (!file) return null;
    return {
      data: base,
      file,
    };
  }

  async getDue(
    dueBy?: number,
    limit?: number,
    excludeIds?: string[]
  ): Promise<ReviewCard[]> {
    const dueTime = dueBy ?? getEndOfToday();
    try {
      const cardsDue = (
        await this.fetchMany({ dueBy: dueTime, limit, excludeIds })
      ).map(
        async (item) => ({
          data: CardManager.rowToDisplay(item),
          file: Obsidian.getNote(item.reference, this.app),
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

  async create(editor: Editor, view: MarkdownView | ReviewView) {
    const currentFile = view.file;
    if (!currentFile) {
      new Notice(`A Markdown file must be active`, ERROR_NOTICE_DURATION_MS);
      return;
    }

    const block = Obsidian.getCurrentContent(editor, currentFile);
    // TODO: ensure block content is correct for bullet lists (should only use the current bullet) and code blocks (get the whole code block)
    if (!block) {
      new Notice('No block content found', ERROR_NOTICE_DURATION_MS);
      return;
    }
    const { content, line: blockLine } = block;

    const selectionBounds = Obsidian.getSelectionWithBounds(editor);
    const bounds = selectionBounds
      ? ([selectionBounds.start.ch, selectionBounds.end.ch] as const)
      : null;

    try {
      const withDelimiters = this.delimitText(content, bounds)[0]; // TODO: create many cards at once and transclude/link all?
      const { cardFile } = await this.createFileAndEntry(
        withDelimiters,
        currentFile
      );
      const linkToCard = Obsidian.generateMarkdownLink(
        cardFile,
        currentFile,
        this.app,
        TRANSCLUSION_HIDE_TITLE_ALIAS
      );
      Obsidian.transcludeLink(editor, linkToCard, blockLine);
      // move the cursor to the next block
      editor.setSelection({ line: blockLine + 1, ch: 0 });
    } catch (error) {
      if (error instanceof Error) {
        console.error(error);
      }
      new Notice(`Failed to create card`);
    }
  }

  protected async createFileAndEntry(delimitedText: string, sourceFile: TFile) {
    try {
      // Create the card from the content
      const cardFile = await Obsidian.createFromText(
        delimitedText,
        Obsidian.getDirectory('card'),
        this.app
      );
      const linkToSource = Obsidian.generateMarkdownLink(
        sourceFile,
        cardFile,
        this.app
      );
      await Obsidian.updateFrontMatter(
        cardFile,
        {
          tags: CARD_TAG,
          [`${SOURCE_PROPERTY_NAME}`]: linkToSource,
          delimiters: CLOZE_DELIMITERS,
        },
        this.app
      );

      const parentType = Obsidian.getNoteType(sourceFile, this.app);
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
      await this.repo.mutate(
        `INSERT INTO srs_card (id, reference, parent, created_at, due, last_review, ` +
          `stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state) ` +
          `VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        params
      );

      await this.repo.query('SELECT * FROM srs_card WHERE id = $1', [card.id]);

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
        throw new Error(error.message + refMessage);
      }
    }
  }

  parseCloze(
    text: string,
    delimiters: [string, string]
  ): { start: string; answer: string; end: string } {
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

  async review(card: ISRSCardDisplay, grade: Grade, reviewTime?: Date) {
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
        await this.repo.query(`SELECT * FROM srs_card WHERE id = $1`, [card.id])
      )[0] as SRSCardRow;
      if (!storedCard) {
        throw new Error(`No card found with id ${card.id}`);
      }

      const updatedCard = CardManager.baseToRow(nextCard);
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
      await this.repo.mutate(updateQuery, updateParams);

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
      await this.repo.mutate(insertQuery, insertParams);
    } catch (error) {
      console.error(error);
    }
  }
}
