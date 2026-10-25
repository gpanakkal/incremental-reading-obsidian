import {
  type ImputedDelimiters,
  imputeDelimiters,
  isLiteralAt,
  openBlockAtEnd,
  readSections,
} from '#/lib/block-delimiters';
import { refusedWrite, withCompensation } from '#/lib/compensation';
import { Markdown } from '#/lib/Markdown';
import { noteFingerprint } from '#/lib/note-fingerprint';
import { decodeAnchor } from '#/lib/pdf/pdf-anchor';
import type { PdfHighlight } from '#/lib/pdf/pdf-highlights';
import {
  type PdfOrigin,
  type PdfSelection,
  originFile,
  pageLinkAlias,
  parseSelectionSubpath,
} from '#/lib/pdf/pdf-selection';
import { parseSourceLink } from '#/lib/source-link';
import type {
  ISRSCard,
  ISRSCardDisplay,
  MissingItem,
  ReviewCard,
  SQLiteRepository,
  SRSCardRow,
} from '#/lib/types';
import { getEndOfDay, reviewDayOf, searchAll } from '#/lib/utils';
import type IncrementalReadingPlugin from '#/main';
import type ReviewView from '#/views/ReviewView';
import {
  type Editor,
  type EditorPosition,
  type MarkdownView,
  type TFile,
} from 'obsidian';
import {
  type FSRS,
  type Grade,
  type StateType,
  fsrs,
  generatorParameters,
  get_fuzz_range,
  Grades,
  State,
} from 'ts-fsrs';
import {
  CARD_ANSWER_REPLACEMENT,
  CARD_ANSWER_REPLACEMENT_IN_CODE,
  CARD_ANSWER_REPLACEMENT_IN_MATH,
  CARD_TAG,
  CLOZE_DELIMITER_PATTERN,
  CLOZE_DELIMITERS,
  CLOZE_GROUPS_PATTERN,
  literal,
  MS_PER_DAY,
  SOURCE_PROPERTY_NAME,
  TRANSCLUSION_HIDE_TITLE_ALIAS,
  VALID_DELIMITER_PATTERN,
} from '../constants';
import { ObsidianHelpers as Obsidian } from '../ObsidianHelpers';
import { idNotIn } from './id-exclusion';
import { ItemManager } from './ItemManager';
import { cardAfterUndo } from './review-undo';
import { NOT_PURGED } from './row-delete';
import SRSCard from './SRSCard';
import SRSCardReview from './SRSCardReview';

/**
 * What the grade buttons show for a card (see {@link CardManager.gradePreview}):
 * how far past the moment it was previewed each grade would put it, in ms —
 * NaN for none — and, per grade, whether that is approximate: fuzz is on and
 * could move it.
 */
export type GradePreview = {
  approximate: Record<Grade, boolean>;
  inMs: Record<Grade, number>;
};

/** Which end of its fuzz range each fuzzed interval is pinned to. */
type FuzzEdge = 'min_ivl' | 'max_ivl';

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
    // In code the placeholder's markup would show as it is, and in math it
    // would break the formula. A card from a comment shows nothing anyway.
    const block = openBlockAtEnd(pre);
    const placeholder =
      block === 'code'
        ? CARD_ANSWER_REPLACEMENT_IN_CODE
        : block === 'math'
          ? CARD_ANSWER_REPLACEMENT_IN_MATH
          : CARD_ANSWER_REPLACEMENT;
    return pre + placeholder + post;
  }

  rowToReviewCard(row: SRSCardRow): ReviewCard | null {
    const base = CardManager.rowToDisplay(row);
    const file = Obsidian.getNote(row.reference, this.app);
    // Missing, which is never stored: see `MissingItem`
    if (!file) return null;

    if (!this.reconcileNote(row, file, 'card')) return null;

    return {
      data: base,
      file,
    };
  }

  /**
   * Whether any card is due, as {@link getDue} would find, read straight off
   * the table: no note is squared with its row, so it writes nothing.
   * @param now The current time, as a Unix timestamp.
   * @throws if the card table cannot be read
   */
  async anyDue(now = Date.now()): Promise<boolean> {
    const filter = this.dueFilter(undefined, now);
    return (await this.fetchMany({ ...filter, limit: 1 })).length > 0;
  }

  /**
   * The `fetchMany` options of cards due by `dueBy`, or by the end of the
   * review day `now` falls in; a learning card, by `now` at the latest.
   */
  private dueFilter(dueBy: number | undefined, now: number) {
    const offset = this.plugin.settings.dayRolloverOffset;
    const dueTime =
      dueBy ?? getEndOfDay(offset, reviewDayOf(new Date(now), offset));
    return {
      dueBy: dueTime,
      learningDueBy: Math.min(now, dueTime),
      // A failed read is not an empty queue
      throwOnError: true,
    };
  }

  /**
   * Cards ready for review, soonest due first.
   *
   * New and Review cards are due once their due time falls on or before
   * `dueBy`, by default the end of the review day `now` falls in. Learning and
   * Relearning cards wait for their due time itself: they are the only states
   * whose steps are shorter than a day, so one graded minutes ago is still due
   * "today" and would otherwise come straight back.
   *
   * A Review card is always scheduled a whole day or more out, which clears
   * the end of its review day on every day but the one the clocks go back
   * on, when the day is 25 hours long. Rare enough to leave.
   *
   * @param now The current time, as a Unix timestamp.
   * @throws if the card table cannot be read
   */
  async getDue(
    dueBy?: number,
    limit?: number,
    excludeIds?: string[],
    now = Date.now()
  ): Promise<(ReviewCard | MissingItem<ISRSCardDisplay>)[]> {
    const filter = this.dueFilter(dueBy, now);
    let allExcluded = [...(excludeIds ?? [])];
    let due: (ReviewCard | MissingItem<ISRSCardDisplay>)[];
    // keep fetching until all fetched rows have a note
    let lastMissingNotes = 0;
    do {
      lastMissingNotes = 0;
      due = (
        await this.fetchMany({ ...filter, limit, excludeIds: allExcluded })
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
  }

  /**
   * How many cards {@link getDue} leaves out at `now` but will hand review
   * before the review day `now` falls in is over: the Learning and Relearning
   * cards due after `now` and before the day's end. New and Review cards due
   * that day are due already, and an instant at the end itself belongs to the
   * next day.
   *
   * Only cards review could show are counted: not dismissed or deleted, and at
   * a note of their own.
   *
   * @param now The current time, as a Unix timestamp.
   */
  async countDueLaterToday(now = Date.now()): Promise<number> {
    // The end of the review day, as `getDue` cuts off at
    const { dueBy: endOfDay } = this.dueFilter(undefined, now);
    const rows = (await this.repo.query(
      `SELECT * FROM srs_card
       WHERE state IN (${State.Learning}, ${State.Relearning})
         AND due > $1 AND due < $2
         AND dismissed = 0 AND deleted = FALSE`,
      [now, endOfDay]
    )) as SRSCardRow[];
    return rows.filter((row) => this.rowToReviewCard(row) !== null).length;
  }

  async create(editor: Editor, view: MarkdownView | ReviewView) {
    const currentFile = view.file;
    if (!currentFile) {
      Obsidian.notify(`A Markdown file must be active`);
      return null;
    }

    const selectionBounds = Obsidian.getSelectionWithBounds(editor);
    if (!selectionBounds) {
      Obsidian.notify('Text must be selected');
      return;
    }
    let selected: { start: EditorPosition; end: EditorPosition } =
      selectionBounds;
    if (selected.start.line !== selected.end.line) {
      // A selection over several lines: the blank space around it is no
      // answer (a line selected whole ends at the next line's start)
      const { selection, startOffset, endOffset } = selectionBounds;
      if (!selection.trim()) {
        Obsidian.notify('Text must be selected');
        return;
      }
      const from =
        startOffset + selection.length - selection.trimStart().length;
      let to = endOffset - selection.length + selection.trimEnd().length;
      selected = {
        start: editor.offsetToPos(from),
        end: editor.offsetToPos(to),
      };
      // Nor is a last line selected no further than its list marker, which a
      // card of it cuts off: the line before it is the last
      while (
        selected.end.line > selected.start.line &&
        selected.end.ch <=
          Obsidian.smartGetline(
            editor,
            currentFile,
            this.app,
            selected.end.line
          ).start
      ) {
        // `from` holds the selection's first non-blank char, before this line
        to =
          from +
          editor
            .getRange(selected.start, { line: selected.end.line, ch: 0 })
            .trimEnd().length;
        selected = { ...selected, end: editor.offsetToPos(to) };
      }
      if (selected.start.line !== selected.end.line) {
        return this.createFromLines(editor, view, currentFile, selected);
      }
    }

    // remove leading indent and bullet/number/checkbox formatting
    const { line, lineNumber, start, end } = Obsidian.smartGetline(
      editor,
      currentFile,
      this.app,
      selected.start.line
    );
    // Nothing past the list marker the line is cut from: nothing to ask
    if (selected.end.ch <= start) {
      Obsidian.notify('Text must be selected');
      return;
    }

    // Moved off any escape pair it splits, and off a backslash that would
    // escape the delimiter put after it. One starting in the list marker cut
    // off starts with the line.
    const bounds = Markdown.snapOffEscapes(
      line,
      [Math.max(selected.start.ch - start, 0), selected.end.ch - start],
      { delimited: true }
    );

    // The line starts a block in the note, its list marker cut off, so only
    // the answer's start can form syntax there that the note didn't, unless
    // it is code. A line in a code block, math or a table gets the
    // delimiters it lacks to render as it did (see `imputeDelimiters`).
    // A whole line never splits a delimiter but where it is all delimiter,
    // and then nothing is imputed, so the line's bounds stay as they are,
    // as long as blank space by a delimiter isn't taken for part of it.
    // `editor.cm`, the CodeMirror view, is undocumented Obsidian API.
    const [a, b] = bounds;
    const cm = editor.cm as Editor['cm'] | undefined;
    const note = cm && {
      doc: cm.state.doc.toString(),
      lineFrom: cm.state.doc.line(lineNumber + 1).from,
    };
    const sections = note && (await readSections(this.app, note.doc));
    const imputed =
      note &&
      sections &&
      imputeDelimiters(
        note.doc,
        sections,
        [note.lineFrom + start, note.lineFrom + end],
        { overBlanks: false }
      );
    const answer =
      note &&
      sections &&
      isLiteralAt(note.doc, sections, note.lineFrom + start + a)
        ? line.slice(a, b)
        : Markdown.escapeCutStart(line, bounds, 'answer');
    if (await refusedWrite(this.repo, 'create the card')) return null;

    try {
      const withDelimiters = this.delimitText(
        line.slice(0, a) + answer + line.slice(b),
        [a, a + answer.length]
      )[0];
      const reviewCard = await this.createAndEmbed(
        editor,
        currentFile,
        withDelimiters,
        { line: lineNumber, ch: start },
        { line: lineNumber, ch: end },
        imputed
      );
      // move the cursor to the next block
      editor.setSelection({ line: lineNumber + 1, ch: 0 });
      return {
        reviewCard,
        line,
        lineNumber,
        start,
        end,
        before: imputed?.before ?? '',
        after: imputed?.after ?? '',
      };
    } catch (error) {
      if (error instanceof Error) {
        console.error(error);
      }
      Obsidian.notify(`Failed to create card`, { kind: 'error' });
      return null;
    }
  }

  /**
   * Make a card, as {@link create} does of the cursor's line, of the lines a
   * selection spans: from the first's start, its list marker cut off as
   * `create` cuts it, to the last's end, the selection its answer. The span
   * is then made a card of as one chosen in selection mode is, its delimiters
   * imputed where it cuts into a block.
   *
   * @param selected the selection, starting and ending on different lines
   */
  private createFromLines(
    editor: Editor,
    view: MarkdownView | ReviewView,
    file: TFile,
    selected: { start: EditorPosition; end: EditorPosition }
  ) {
    const { start, end } = selected;
    const cut = Obsidian.smartGetline(editor, file, this.app, start.line).start;
    const from = editor.posToOffset({ line: start.line, ch: cut });
    const to = editor.posToOffset({
      line: end.line,
      ch: editor.getLine(end.line).length,
    });
    const text = editor.getValue().slice(from, to);
    return this.createFromSelection(editor, view, { from, to, text }, [
      Math.max(editor.posToOffset(start) - from, 0),
      editor.posToOffset(end) - from,
    ]);
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
    // The span and its answer, snapped off any escape pair they split, and
    // the span moved off any delimiter line it split (see `imputeDelimiters`)
    const doc = editor.getValue();
    const snapped = Markdown.snapOffEscapes(doc, [
      selection.from,
      selection.to,
    ]);
    const sections = await readSections(this.app, doc);
    const imputed = sections && imputeDelimiters(doc, sections, snapped);
    const [from, to] = imputed?.range ?? snapped;
    const text = doc.slice(from, to);
    const shift = selection.from - from;
    const start = editor.offsetToPos(from);
    const end = editor.offsetToPos(to);

    const [a, b] = Markdown.snapOffEscapes(
      text,
      [answer[0] + shift, answer[1] + shift],
      { delimited: true }
    );
    // Each start escaped where it forms syntax the note didn't there, but
    // where its delimiters give it back the context it had, or in code
    const pre = imputed?.raw
      ? text.slice(0, a)
      : Markdown.escapeCutStart(doc, [from, from + a], 'note');
    const hidden =
      sections && isLiteralAt(doc, sections, from + a)
        ? text.slice(a, b)
        : Markdown.escapeCutStart(doc, [from + a, from + b], 'answer');
    if (await refusedWrite(this.repo, 'create the card')) return null;

    try {
      const delimited = this.delimitText(pre + hidden + text.slice(b), [
        pre.length,
        pre.length + hidden.length,
      ])[0];
      // Its second line kept from underlining its first, as delimited
      const withDelimiters = imputed?.raw
        ? delimited
        : Markdown.escapeCutUnderline(doc, from, delimited);
      const reviewCard = await this.createAndEmbed(
        editor,
        currentFile,
        withDelimiters,
        start,
        end,
        imputed
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
        before: imputed?.before ?? '',
        after: imputed?.after ?? '',
      };
    } catch (error) {
      if (error instanceof Error) {
        console.error(error);
      }
      Obsidian.notify(`Failed to create card`, { kind: 'error' });
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
    if (await refusedWrite(this.repo, 'create the card')) return null;
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
      Obsidian.notify(`Failed to create card`, { kind: 'error' });
      return null;
    }
  }

  /**
   * Make the card's note and row, and put its embed in place of `start`–`end`.
   * With `imputed`, the note gets the delimiters its text lacks, and is named
   * after its text alone, and the embed gets those its note needs around it.
   */
  protected async createAndEmbed(
    editor: Editor,
    sourceFile: TFile,
    delimitedText: string,
    start: EditorPosition,
    end: EditorPosition,
    imputed?: ImputedDelimiters | null
  ) {
    const { open = '', close = '', before = '', after = '' } = imputed ?? {};
    const reviewCard = await (open || close
      ? this.createFileAndEntry(
          open + delimitedText + close,
          sourceFile,
          undefined,
          delimitedText
        )
      : this.createFileAndEntry(delimitedText, sourceFile));
    if (!reviewCard) throw new Error(`Failed to create card`);

    const linkToCard = Obsidian.generateMarkdownLink(
      reviewCard.file,
      sourceFile,
      this.app,
      TRANSCLUSION_HIDE_TITLE_ALIAS
    );
    Obsidian.transcludeLink(editor, linkToCard, start, end, before, after);
    return reviewCard;
  }

  /**
   * Make the card's note and row. Its parent is found by `sourceFile`'s note
   * type, unless `origin` gives it, along with how to link to `sourceFile`.
   *
   * The note and row are made as one (see `withCompensation`): a note made
   * for a row that then can't be saved is trashed again, since with no row,
   * review would never show it. Once the row is saved, the note is the card's
   * whatever fails after.
   */
  protected async createFileAndEntry(
    delimitedText: string,
    sourceFile: TFile,
    origin?: CardOrigin,
    title = origin?.title
  ) {
    try {
      const card = await withCompensation(async (step) => {
        // Create the card from the content
        const cardFile = await step(
          () =>
            Obsidian.createFromText(
              delimitedText,
              Obsidian.getDirectory('card'),
              this.app,
              title
            ),
          (made) => this.app.fileManager.trashFile(made)
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
        if (origin) {
          // Its row's change tells the PDF's tabs to read their card
          // highlights again, which come from this link's subpath, article or
          // not: in the cache by then, or the card's highlight waits for the
          // next change
          await this.sourceIndexed(cardFile, sourceFile);
        }

        // create the database entry: the commit point
        await this.insertRow(card, parent, cardFile);
        return card;
      });

      const reviewCard = await this.fetch(card.id);
      return reviewCard;
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  /**
   * Add the row of the new card `card`, the child of `parent`, whose note
   * `file` has its identity frontmatter by now: the row records the
   * fingerprint that left it with (see `noteFingerprint`).
   */
  private async insertRow(card: SRSCard, parent: string | null, file: TFile) {
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
      noteFingerprint(file),
    ];
    await this.repo.mutate(
      `INSERT INTO srs_card (id, reference, parent, created_at, due, last_review, ` +
        `stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, note_mtime) ` +
        `VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      params
    );
  }

  /**
   * Give the note `file`, which holds the `ir-id` `id` no row does, a row of
   * its own: a card whose making was cut short before its row was saved (see
   * `crash-leftovers`). New, as a card just made is, and the child of the
   * item its `source` links to, if any.
   */
  async adoptLeftover(file: TFile, id: string): Promise<void> {
    const card = new SRSCard(file.path);
    card.id = id;
    const source = Obsidian.getSourceFile(file, this.app);
    await this.insertRow(
      card,
      source ? await this.findParentId(source) : null,
      file
    );
  }

  /**
   * Hand every parentless card taken from `file` to the item `parentId` now
   * backing it, as an import does for its snippets.
   * @returns the adopted rows, carrying their new parent
   */
  async adoptOrphans(file: TFile, parentId: string): Promise<SRSCardRow[]> {
    return this.adoptParentless<SRSCardRow>('srs_card', file, parentId);
  }

  /**
   * The highlights of the cards made from the PDF `pdf`, as their notes'
   * `source` links name their selections (see `parseSelectionSubpath`): of
   * the live cards whose parent is `pdf`'s article, wherever their links now
   * resolve, or for a PDF that is no article, of the live parentless cards
   * whose links resolve to it (see `findParentlessFrom`). A dismissed card
   * keeps its highlight, as a dismissed snippet does.
   *
   * A link names one page only, so a card whose text runs onto the next page
   * is highlighted up to the end of its first. A card whose note is gone, or
   * whose link names no selection, has no highlight.
   */
  async getPdfHighlights(pdf: TFile): Promise<PdfHighlight[]> {
    const article = await this.findArticle(pdf);
    if (article) {
      const rows = (await this.repo.query(
        'SELECT * FROM srs_card WHERE parent = $1 AND deleted = FALSE',
        [article.id]
      )) as SRSCardRow[];
      return rows.flatMap((row) => this.pdfHighlight(row) ?? []);
    }

    // No offsets to narrow these down by, as a PDF's snippets have: every
    // parentless card is asked, but only one whose link names a selection has
    // its link resolved
    const rows = (await this.repo.query(
      'SELECT * FROM srs_card WHERE parent IS NULL AND deleted = FALSE'
    )) as SRSCardRow[];
    return rows.flatMap((row) => this.pdfHighlight(row, pdf) ?? []);
  }

  /**
   * The highlight of the card `row`, as its note's `source` link names its
   * selection; when `from` is given, only if that link resolves to `from`.
   * A note at its reference with another item's `ir-id` is that item's, not
   * the card's (see `reconcileNote`), and gives it none.
   */
  private pdfHighlight(row: SRSCardRow, from?: TFile): PdfHighlight | null {
    const note = Obsidian.getNote(row.reference, this.app);
    if (!note) return null;
    const frontmatter = Obsidian.getFrontMatter(note, this.app);
    const id = frontmatter?.['ir-id'];
    if (id && id !== row.id) return null;
    const source = frontmatter?.[SOURCE_PROPERTY_NAME];
    if (typeof source !== 'string') return null;
    const range = parseSelectionSubpath(parseSourceLink(source)?.subpath ?? '');
    if (!range) return null;
    if (from && !Obsidian.sourceIs(note, from, this.app)) return null;
    return { ref: row.reference, kind: 'card', ...range };
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
   * Drop a card's row and delete its note, as one (see `deleteWithNote`).
   * @returns how it went: `deleted` once both are gone
   */
  async delete(id: string, options: { prompt?: boolean } = {}) {
    return this.deleteWithNote('srs_card', id, options, 'delete the card');
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
    const query = `SELECT * FROM srs_card WHERE id = $1 AND ${NOT_PURGED}`;
    const result = await this.repo.query(query, [id]);
    if (!result[0]) return null;
    return this.rowToReviewCard(result[0] as SRSCardRow);
  }

  /**
   * @param opts.dueBy Only cards due at or before this Unix timestamp.
   * @param opts.learningDueBy With `dueBy`, the earlier cutoff Learning and
   * Relearning cards are held to; New and Review cards keep `dueBy`. One later
   * than `dueBy` is no different from `dueBy`.
   */
  async fetchMany(opts?: {
    dueBy?: number;
    learningDueBy?: number;
    limit?: number;
    includeDismissed?: boolean;
    includeDeleted?: boolean;
    excludeIds?: string[];
    /** Reject on a failed query rather than resolve to no rows */
    throwOnError?: boolean;
  }) {
    let query = 'SELECT * FROM srs_card';
    const conditions = [];
    const params = [];
    if (opts?.dueBy !== undefined) {
      params.push(opts.dueBy);
      conditions.push(`due <= $${params.length}`);
      if (opts.learningDueBy !== undefined) {
        // Placeholders have to appear in the text in order of N: SQLite numbers
        // `$N` names by first appearance, not by N.
        params.push(opts.learningDueBy);
        conditions.push(
          `(state IN (${State.New}, ${State.Review}) ` +
            `OR due <= $${params.length})`
        );
      }
    }
    if (!opts?.includeDismissed) {
      conditions.push('dismissed = 0');
    }

    // Even with the deleted, never those deleted for good
    conditions.push(opts?.includeDeleted ? NOT_PURGED : 'deleted = FALSE');

    if (opts?.excludeIds && opts.excludeIds.length) {
      conditions.push(idNotIn(opts.excludeIds, params));
    }

    if (conditions.length) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY due ASC';

    if (opts?.limit) {
      params.push(opts?.limit);
      query += ` LIMIT $${params.length}`;
    }

    const rows = opts?.throwOnError
      ? await this.repo.query(query, params, { throwOnError: true })
      : await this.repo.query(query, params);
    return (rows ?? []) as SRSCardRow[];
  }

  /**
   * The scheduler grading uses, as the settings have it now. Its fuzz, when
   * on, is seeded by ts-fsrs from the moment of the review, the card's review
   * count and its difficulty × stability, so the same card graded a moment
   * later can land on another fuzzed interval.
   */
  getFsrs() {
    const params = generatorParameters(this.plugin.settings.fsrsParams);
    return fsrs(params);
  }

  /**
   * When each grade would make `card` due next, were it graded at `now`: the
   * same scheduler {@link review} grades it with, so the two agree for as long
   * as the settings and the moment do — and, with fuzz on, only for the very
   * same moment (see {@link getFsrs}). `unfuzzed` leaves the fuzz out, as
   * the grade buttons ask for it ({@link gradePreview}); the fuzzed default is
   * what grading itself would write, which the tests pin it to.
   */
  previewDue(
    card: ISRSCardDisplay,
    now: Date,
    { unfuzzed = false }: { unfuzzed?: boolean } = {}
  ): Record<Grade, Date> {
    const scheduler = unfuzzed
      ? fsrs(
          generatorParameters({
            ...this.plugin.settings.fsrsParams,
            enable_fuzz: false,
          })
        )
      : this.getFsrs();
    const preview = scheduler.repeat(card, now);
    return Object.fromEntries(
      Grades.map((grade) => [grade, preview[grade].card.due])
    ) as Record<Grade, Date>;
  }

  /** The last {@link gradePreview}, and the card and settings it is for. */
  private lastGradePreview: { key: string; preview: GradePreview } | null =
    null;

  /**
   * What the grade buttons show for `card`: how far out each grade would put
   * it, previewed once while it is the card shown and then kept, however
   * often it is asked for and whenever. Polls hand the card over anew every
   * few seconds, and a preview taken at each new moment would reseed the fuzz
   * (see {@link getFsrs}), so the buttons would change under the reader.
   *
   * Asked for another card, a new state of this one (graded, say) or with
   * other settings, it previews afresh; only the last preview is kept, so a
   * card shown again after another is previewed again. A card left up across
   * a UTC midnight keeps what it first showed, though grading it then counts
   * the day that passed (ts-fsrs counts elapsed days by UTC date).
   *
   * The intervals leave fuzz out. With fuzz on, those it could move are
   * `approximate`: grading still applies it, within ts-fsrs's fuzz range of
   * the interval shown. The rest — learning steps, intervals too short to
   * fuzz — are exact either way (see {@link fuzzEdgeDue}).
   *
   * A card ts-fsrs will not preview gets NaN for every grade, and a warning,
   * once; grading it reports why.
   */
  gradePreview(card: ISRSCardDisplay, now = new Date()): GradePreview {
    const { fsrsParams } = this.plugin.settings;
    const key = JSON.stringify([card, fsrsParams]);
    if (this.lastGradePreview?.key === key) {
      return this.lastGradePreview.preview;
    }

    let due: Record<Grade, Date> | null = null;
    try {
      due = this.previewDue(card, now, { unfuzzed: true });
    } catch (e) {
      console.warn('Could not preview the grades of a card', e);
    }
    // Null while it can't be told which intervals fuzz could move: then any
    // could, as far as the buttons say
    let edges: Record<Grade, Date>[] | null = [];
    if (due && fsrsParams.enable_fuzz) {
      try {
        edges = [
          this.fuzzEdgeDue(card, now, 'min_ivl'),
          this.fuzzEdgeDue(card, now, 'max_ivl'),
        ];
      } catch {
        edges = null;
      }
    }
    const inMs = (dates: Record<Grade, Date> | null, grade: Grade) =>
      dates ? dates[grade].getTime() - now.getTime() : NaN;
    const perGrade = <T>(value: (grade: Grade) => T) =>
      Object.fromEntries(Grades.map((g) => [g, value(g)])) as Record<Grade, T>;
    const preview: GradePreview = {
      approximate: perGrade(
        (g) =>
          !Number.isNaN(inMs(due, g)) &&
          (edges === null ||
            edges.some((edge) => !Object.is(inMs(edge, g), inMs(due, g))))
      ),
      inMs: perGrade((g) => inMs(due, g)),
    };
    this.lastGradePreview = { key, preview };
    return preview;
  }

  /**
   * When each grade would make `card` due, graded at `now` with fuzz on and
   * every roll of it landing on `edge` of its range.
   *
   * Every interval ts-fsrs computes from another only takes the larger or
   * smaller of the two, or adds a day, so each grade's interval only grows
   * with the fuzzed ones: the two edges are its least and greatest. A grade
   * fuzz can move differs at one edge or the other from its unfuzzed preview;
   * one it cannot, at neither.
   *
   * Which intervals get fuzzed is left to ts-fsrs's own `apply_fuzz` (5.4.1):
   * it reads the fuzz seed only once it decides to fuzz, so a read of `_seed`
   * (internal to ts-fsrs) is what tells the two apart. A fuzzed one is then
   * pinned to `edge` of the same `get_fuzz_range` it draws from.
   */
  private fuzzEdgeDue(
    card: ISRSCardDisplay,
    now: Date,
    edge: FuzzEdge
  ): Record<Grade, Date> {
    const params = generatorParameters({
      ...this.plugin.settings.fsrsParams,
      enable_fuzz: true,
    });
    // An untouched scheduler under the same settings, asked first whether it
    // would fuzz each interval: it reads its `_seed` only if it does
    const reference = fsrs(params);
    const scheduler = fsrs(params);
    scheduler.apply_fuzz = (ivl, elapsedDays) => {
      let fuzzes = false;
      const probe = Object.create(reference, {
        _seed: {
          get() {
            fuzzes = true;
            return '';
          },
        },
      }) as FSRS;
      const exact = probe.apply_fuzz(ivl, elapsedDays);
      if (!fuzzes) return exact;
      return get_fuzz_range(ivl, elapsedDays, params.maximum_interval)[
        edge
      ] as typeof exact;
    };
    const preview = scheduler.repeat(card, now);
    return Object.fromEntries(
      Grades.map((grade) => [grade, preview[grade].card.due])
    ) as Record<Grade, Date>;
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
      await this.repo.query(
        `SELECT * FROM srs_card WHERE id = $1 AND ${NOT_PURGED}`,
        [card.id]
      )
    )[0] as SRSCardRow;
    if (!storedCard) {
      throw new Error(`No card found with id ${card.id}`);
    }

    const reviewRow = SRSCardReview.displayToRow(
      new SRSCardReview(card.id, reviewLog)
    );

    await this.repo.transaction(async () => {
      await this.noteLogBefore('srs_card', card.id, reviewRow.id);
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

  /**
   * Undo the review `reviewRowId` of `card`: take it back with the later
   * reviews this device made of it, and give the card the state the reviews
   * left imply (see `cardAfterUndo`), dismissed or not as it was, all in one
   * transaction. A dismissal put back by a write of its own could be lost on
   * its own, leaving a card that was dismissed back in the queue.
   * @param card the card as it was before the review
   * @throws when the review is no live review of the card, undone already
   */
  async rollbackBeforeReview(card: ISRSCardDisplay, reviewRowId: string) {
    const taken = await this.repo.transaction(async () => {
      const plan = await this.takeBackReview('srs_card', card.id, reviewRowId);
      const [{ created_at }] = (await this.repo.query(
        `SELECT created_at FROM srs_card WHERE id = $1`,
        [card.id]
      )) as unknown as Pick<SRSCardRow, 'created_at'>[];
      const updatedCard = cardAfterUndo(
        plan,
        CardManager.displayToRow(card),
        created_at,
        this.plugin.settings.fsrsParams
      );
      let updateQuery = `UPDATE srs_card SET `;
      const columnUpdateSegments = [
        `due = $1, last_review = $2`,
        `stability = $3, difficulty = $4`,
        `elapsed_days = $5`,
        `scheduled_days = $6`,
        `learning_steps = $7`,
        `reps = $8, lapses = $9`,
        `state = $10, dismissed = $11`,
      ];
      updateQuery += columnUpdateSegments.join(', ');
      updateQuery += ` WHERE id = $12`;
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
        Number(card.dismissed),
        card.id,
      ];
      await this.repo.mutate(updateQuery, updateParams);
      return plan.taken;
    });
    this.forgetNotes(taken);
  }
}
