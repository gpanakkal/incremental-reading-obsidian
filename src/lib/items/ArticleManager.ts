import type {
  BulkImportEntry,
  BulkImportOptions,
  BulkOutcome,
  ImportedArticle,
} from '#/lib/bulk-import/types';
import { refusedWrite, withCompensation } from '#/lib/compensation';
import {
  ARTICLE_TAG,
  CONTENT_TITLE_MAX_BYTES,
  CONTENT_TITLE_SLICE_LENGTH,
  DATA_DIRECTORY,
  DEFAULT_PRIORITY,
  IMPORT_BLOCKED_TAGS,
  INVALID_TITLE_MESSAGE,
  SOURCE_PROPERTY_NAME,
  TEXT_BASE_REVIEW_INTERVAL,
} from '#/lib/constants';
import IRScheduler from '#/lib/IRScheduler';
import {
  listChars,
  refusedCharsIn,
  refusedPathWarning,
} from '#/lib/item-path-guard';
import {
  isCopyImportable,
  isImportable,
  sniffMimeType,
  supportsFrontmatter,
} from '#/lib/mime';
import type { NoticeAction } from '#/lib/notices';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import {
  applyFrontmatterLinkEdits,
  rebaseLinks,
  resolveLinks,
  type FrontmatterLinkEdit,
  type ResolvedLink,
} from '#/lib/rebase-links';
import { BulkMutateError } from '#/lib/repository/BulkMutateError';
import { stripFrontmatterTags } from '#/lib/tags';
import type {
  ArticleDisplay,
  ArticleRow,
  FrontMatterUpdates,
  IArticleBase,
  IArticleReview,
  MissingItem,
  MutationStatement,
  PluginFrontMatter,
  ReviewArticle,
  SnippetRow,
  SRSCardRow,
} from '#/lib/types';
import {
  compareFuzzedDue,
  generateId,
  getContentSlice,
  getDateString,
  getEndOfDay,
} from '#/lib/utils';
import type { WebPage } from '#/lib/web-viewer';
import { Keymap, type App, type TFile } from 'obsidian';
import { idNotIn } from './id-exclusion';
import { ItemManager } from './ItemManager';
import { deleteRowStatements, NOT_PURGED } from './row-delete';
import type { SnippetManager } from './SnippetManager';

/**
 * Whether `file` can be imported as an article, telling the user why not when
 * it can't. The menus and commands hide the entries for such a file already;
 * this is the guard behind them, for a stale menu or a caller that skipped
 * the check, so none of them can leave a row behind that nothing identifies.
 */
export function checkImportable(file: TFile): boolean {
  if (isImportable(file)) return true;
  Obsidian.notify(`"${file.name}" can't be imported as an article`);
  return false;
}

/**
 * Why an import of a file did nothing: `notice` is what an import of that file
 * alone tells the user, `reason` the short form a batch's outcome keeps.
 */
interface Refusal {
  notice: string;
  reason: string;
  /** Nothing was left to do: the file is an article already. */
  skipped?: boolean;
}

/**
 * Where an import says what came of it. An import of one file tells the user
 * (see {@link toUser}); one of a batch is quiet, and keeps only why it did
 * nothing, for its outcome (see `importMany`).
 */
interface ImportReport {
  /** Nothing was imported, for the reason given. */
  refuse(refusal: Refusal): void;
  /**
   * What was imported, or done instead (see {@link confirmImport}), with a
   * button for the notice to carry, if any.
   */
  confirm(message: string, action?: NoticeAction): void;
  /** Something about an import that goes ahead. */
  warn(...args: Parameters<typeof Obsidian.notify>): void;
  /**
   * The button that undoes the import, for a notice of one made where its
   * file is: a copy's notice opens the copy instead (see `openAction`).
   */
  undo?: NoticeAction;
}

/** What an import of one file did, and the article it made or brought back. */
export interface ImportResult extends ImportedArticle {
  /** Null when the article can't be shown: see `ArticleManager.fetch`. */
  article: ReviewArticle | null;
}

/** The report of an import of one file: every word of it a notice. */
const toUser: ImportReport = {
  refuse: ({ notice }) => Obsidian.notify(notice),
  confirm: confirmImport,
  warn: (...args) => Obsidian.notify(...args),
};

/** The short form of what an import threw, for a batch's outcome. */
function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether `file` is in the plugin's data folder, where a copy of it would be
 * one of the plugin's own: `importCopy` refuses it. Not a note whose own name
 * or folder only starts as the folder's does.
 */
const inDataDirectory = (file: TFile) =>
  file.path.startsWith(`${DATA_DIRECTORY}/`);

/** A snippet's or card's note is no article to be. */
function blockedTag(): Refusal {
  return {
    notice: `Note contains a snippet or card tag; canceling import`,
    reason: 'has a snippet or card tag',
  };
}

/**
 * Whether `file` must not become an article where it is, saying why: its path
 * holds a character that breaks links to it (see `REFUSED_PATH_CHARS`). A copy
 * is named from text, which drops them; every type that can be imported in
 * place can be copied today.
 */
function refusedInPlace(file: TFile, report: ImportReport): boolean {
  const chars = refusedCharsIn(file.path);
  if (chars.length === 0) return false;
  report.refuse({
    notice:
      `Can't import "${file.name}" in place: its name or folder contains ` +
      `${listChars(chars)}. Rename it or import a copy`,
    reason: `its name or folder contains ${listChars(chars)}`,
  });
  return true;
}

/**
 * Tell the user when an existing article, relinked or restored, is now at a
 * path that breaks links to it: it stays there, as existing paths do.
 */
function warnIfRefused(path: string, report: ImportReport) {
  const warning = refusedPathWarning(path);
  if (warning) report.warn(warning);
}

/** How an import says it scheduled the article, for its notice. */
function describeSchedule(
  priority: number,
  fixedIntervalDays: number | null
): string {
  return fixedIntervalDays === null
    ? `priority ${IRScheduler.toDisplayPriority(priority)}`
    : `fixed interval of ${fixedIntervalDays} days`;
}

/**
 * Confirm an import, or what an import did instead (link or restore an article
 * already in the database). The `minimal` success notice level keeps these.
 * @param action a button on the notice: one that opens the note an import
 *   made, which one made in place has no need of
 */
function confirmImport(message: string, action?: NoticeAction) {
  Obsidian.notify(message, { kind: 'success', category: 'import', action });
}

/**
 * What a copy import's notice adds about the snippets and cards it took over
 * from the original (see `handToCopy`): nothing when it took none.
 */
function movedToCopy({
  snippets,
  cards,
}: {
  snippets: number;
  cards: number;
}): string {
  const counted = (
    [
      [snippets, 'snippet'],
      [cards, 'card'],
    ] as const
  )
    .filter(([count]) => count > 0)
    .map(([count, noun]) => `${count} ${noun}${count === 1 ? '' : 's'}`);
  if (counted.length === 0) return '';
  const verb = snippets + cards === 1 ? 'refers' : 'refer';
  return `; ${counted.join(' and ')} now ${verb} to the copy`;
}

/**
 * What an article takes over from the file it was imported from: the snippets
 * and cards taken from that file while it was no article.
 */
interface Claim<T> {
  /** Take them, writing as it goes, once the article's row is written. */
  now(): Promise<T>;
  /**
   * Find them, for a writer that writes the rows that take them along with
   * the article's own.
   */
  rows(): Promise<ClaimRows<T>>;
}

/** What {@link Claim.rows} found. */
interface ClaimRows<T> {
  /** The writes that take them. */
  statements: MutationStatement[];
  /** What follows once `statements` are written. */
  after: () => Promise<T>;
}

/**
 * Where an import's row writes go. An import of one file writes each as it
 * reaches it (see `ArticleManager.import`); one of a batch holds them for one
 * write of the whole batch (see {@link HeldWriter}).
 */
interface RowWriter {
  /**
   * An import's commit point, reached once per import: write `row`, the
   * article's own row write if it has one, and with it, for a writer that
   * holds rows for a batch, those that take over what `claim` finds.
   * @returns the rest of `claim`, to run once the import is committed (see
   *   `afterImport`); it rejects when what it follows was not written
   * @throws when `row` was not written, so the import is taken back
   */
  commit<T>(
    row: MutationStatement | null,
    claim: Claim<T>
  ): Promise<() => Promise<T>>;
}

/**
 * A step that fails with `error` once run: thrown as it is called, which a
 * caller awaiting it takes as its rejection.
 */
function failing(error: unknown): () => never {
  return () => {
    throw error;
  };
}

/**
 * The {@link RowWriter} of one file of a batch (see
 * `ArticleManager.importMany`): holds its import at its commit point, until
 * the batch has written every file's rows in one run, then lets it go on as
 * its own rows fared.
 */
class HeldWriter implements RowWriter {
  /** The rows held, from when the import reaches its commit point. */
  held: readonly MutationStatement[] = [];
  /** Settles once the import reaches its commit point. */
  readonly reached: Promise<void>;
  #reach!: () => void;
  #release: (written: number) => void = () => undefined;
  #stopped: unknown = null;

  constructor() {
    this.reached = new Promise((resolve) => {
      this.#reach = resolve;
    });
  }

  async commit<T>(row: MutationStatement | null, claim: Claim<T>) {
    const own = row ? [row] : [];
    let claimed: ClaimRows<T> | null = null;
    let notFound: unknown = null;
    try {
      claimed = await claim.rows();
    } catch (error) {
      // Not this import's to fail, as an import of one file takes them only
      // once committed (see `afterImport`)
      notFound = error;
    }
    const statements = [...own, ...(claimed?.statements ?? [])];
    const written = statements.length === 0 ? 0 : await this.#hold(statements);
    if (written < own.length) throw this.#stopped;
    if (!claimed) return failing(notFound);
    if (written < statements.length) return failing(this.#stopped);
    return claimed.after;
  }

  /** Hold `statements` for the batch's run: see {@link release}. */
  #hold(statements: readonly MutationStatement[]): Promise<number> {
    this.held = statements;
    return new Promise((resolve) => {
      this.#release = resolve;
      this.#reach();
    });
  }

  /**
   * Let the import go on, the batch's run having written `written` of its
   * held rows, from the first (all of them, when at least their number), and
   * stopped for `stopped` if not all. A no-op for an import that held none.
   */
  release(written: number, stopped: unknown) {
    this.#stopped = stopped;
    this.#release(written);
  }
}

/**
 * What an import that made the article `articleId` did: see `ImportEffect`.
 */
function imported(
  articleId: string,
  effect: ImportedArticle['effect'],
  madeFile?: TFile
): ImportedArticle {
  return madeFile ? { articleId, effect, madeFile } : { articleId, effect };
}

/**
 * The write that makes the article `id`, deleted or not, the live article at
 * `path`.
 */
function relinkRow(path: string, id: string): MutationStatement {
  return {
    query: 'UPDATE article SET reference = $1, deleted = FALSE WHERE id = $2',
    params: [path, id],
  };
}

/** How `nameForCopy` names a copy. */
interface CopyNameOptions {
  warnCleaned: boolean;
  maxBytes?: number;
  /** Where its warnings go. */
  report: ImportReport;
}

/** The parentless snippets and cards taken from a file. */
interface Taken {
  /** The file's path when they were found, which their links name */
  from: string;
  snippets: SnippetRow[];
  cards: SRSCardRow[];
}

export class ArticleManager extends ItemManager {
  /** The paths of the files being imported right now. */
  private readonly importing = new Set<string>();
  /**
   * The paths, lowercased, that copies being imported right now are claimed
   * to land at.
   */
  private readonly copyTargets = new Set<string>();
  /** The {@link RowWriter} of an import of one file: writes as it goes. */
  private readonly writeNow: RowWriter = {
    commit: async <T>(row: MutationStatement | null, claim: Claim<T>) => {
      if (row) await this.repo.mutate(row.query, row.params);
      return () => claim.now();
    },
  };

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
    // Missing, which is never stored: see `MissingItem`
    if (!file) return null;

    if (!this.reconcileNote(row, file, 'article')) return null;

    return {
      data: base,
      file,
    };
  }

  /**
   * Import the passed file as an article, refusing one whose type can't be
   * imported (see {@link checkImportable}), or whose content isn't the type
   * its extension says, before the database is touched.
   *
   * A file that can only be imported in place is, whatever copy was asked for.
   * A second import of a file while one is still running is dropped: both
   * would find no row at its path, and the second would fail on inserting it.
   *
   * The notice of an article made or brought back where its file is carries
   * an Undo button, which undoes the entry the caller records for the import
   * (see `Actions.recordImport`).
   * @returns what the import did, or null when nothing was imported (a file
   * already an article among them)
   */
  async import(
    file: TFile,
    priority: number,
    fixedIntervalDays: number | null,
    makeCopy?: boolean
  ): Promise<ImportResult | null> {
    if (!checkImportable(file)) return null;
    if (refusedWrite(this.repo, `import "${file.name}"`)) return null;
    if (this.importing.has(file.path)) return null;

    const willCopy =
      isCopyImportable(file) && (makeCopy ?? this.plugin.settings.copyOnImport);
    // Filled in once the import returns, before its notice can be clicked
    let result: ImportResult | null = null;
    const report: ImportReport = {
      ...toUser,
      undo: {
        label: 'Undo',
        onClick: () => void this.plugin.actions.undoImport(result),
      },
    };
    try {
      const made = await this.importFile(
        file,
        priority,
        fixedIntervalDays,
        willCopy,
        report,
        this.writeNow
      );
      if (made) result = { ...made, article: await this.fetch(made.articleId) };
      return result;
    } catch (error) {
      Obsidian.notify(`Failed to import article "${file.name}"`, {
        kind: 'error',
      });
      console.error(error);
      return null;
    }
  }

  /**
   * Import each of `entries` as {@link import} does, with the same schedule
   * and the same copy choice (a file that can only be imported in place is,
   * whatever was chosen, as is one in the plugin's data folder, which a copy
   * would be refused for every time). Quiet: nothing here tells the user
   * anything, so the caller can say it once for the whole batch. One file
   * that fails short of its rows never stops the rest; one whose rows fail to
   * be written does (see below). A file copied has its entry's
   * `stripFromSource` tags taken off it.
   *
   * In two phases, as every `mutate` saves the whole database file: first each
   * file in turn, up to its import's commit point, with its note's
   * frontmatter or its copy written then (see {@link HeldWriter}), and a
   * copied file's tags stripped; then every file's rows in one paced run (see
   * `SQLiteRepository.bulkMutate`), saving once a chunk. A file whose rows
   * that run didn't write is failed, and its frontmatter or copy taken back,
   * with its stripped tags put back on it; once the run stops, no file after
   * it is written. No transaction is held open across the first phase: the
   * run's chunks would join it, and its writes to files would hold it open.
   *
   * The frontmatter goes first on purpose: a crash between the phases leaves
   * a note with an `ir-id` no row holds, which no later import takes for an
   * article, and which `crash-leftovers` offers to repair.
   * @returns what came of each file, in the order given: `skipped` for one
   * already an article or being imported already, `failed` with a short
   * reason for one that could not be imported
   */
  async importMany(
    entries: readonly BulkImportEntry[],
    { priority, fixedIntervalDays, makeCopy }: BulkImportOptions
  ): Promise<BulkOutcome[]> {
    const started: { writer: HeldWriter; run: Promise<BulkOutcome> }[] = [];
    for (const { file, stripFromSource } of entries) {
      const writer = new HeldWriter();
      const run = this.importQuietly(
        file,
        priority,
        fixedIntervalDays,
        makeCopy,
        writer,
        stripFromSource
      );
      started.push({ writer, run });
      // On to the next once this one has reached its commit point, or ended
      // short of it
      await Promise.race([run, writer.reached]);
    }

    const statements = started.flatMap(({ writer }) => writer.held);
    let written = statements.length;
    let stopped: unknown = null;
    try {
      await this.repo.bulkMutate(statements);
    } catch (error) {
      const short = error instanceof BulkMutateError;
      written = short ? error.committed : 0;
      stopped = short ? error.cause : error;
    }

    // One at a time, as an import of each would: what follows a commit writes
    // to files as well
    const outcomes: BulkOutcome[] = [];
    let start = 0;
    for (const { writer, run } of started) {
      writer.release(written - start, stopped);
      start += writer.held.length;
      outcomes.push(await run);
    }
    return outcomes;
  }

  /** One file of {@link importMany}, writing its rows through `writer`. */
  private async importQuietly(
    file: TFile,
    priority: number,
    fixedIntervalDays: number | null,
    makeCopy: boolean,
    writer: RowWriter,
    stripFromSource: readonly string[] = []
  ): Promise<BulkOutcome> {
    if (!isImportable(file)) {
      return {
        file,
        status: 'failed',
        reason: "can't be imported as an article",
      };
    }
    if (this.repo.writeRefusal()) {
      return {
        file,
        status: 'failed',
        reason: 'saving to the database is paused',
      };
    }
    if (this.importing.has(file.path)) {
      return { file, status: 'skipped', reason: 'already being imported' };
    }

    let refusal: Refusal | null = null;
    const quiet: ImportReport = {
      refuse: (given) => {
        refusal = given;
      },
      confirm: () => undefined,
      // Kept where a developer can find them, not shown
      warn: (message) => console.warn(message),
    };
    let made: ImportedArticle | null;
    try {
      made = await this.importFile(
        file,
        priority,
        fixedIntervalDays,
        isCopyImportable(file) && makeCopy && !inDataDirectory(file),
        quiet,
        writer,
        stripFromSource
      );
    } catch (error) {
      console.error(error);
      return { file, status: 'failed', reason: errorReason(error) };
    }
    const refused = refusal as Refusal | null;
    if (refused === null) return { file, status: 'imported', ...made };
    return {
      file,
      status: refused.skipped ? 'skipped' : 'failed',
      reason: refused.reason,
    };
  }

  /**
   * Import `file`, which is importable and not being imported already, where
   * it is or as a copy, its rows written through `writer`. Holds its path in
   * `importing` until done, from the caller's own synchronous step, so no
   * second import of it can start.
   * @param stripFromSource tags to take off `file` once it is copied
   * @returns what the import did, or null when it did nothing, its report
   *   having said why
   * @throws whatever the import throws, its report having said nothing of it
   */
  private async importFile(
    file: TFile,
    priority: number,
    fixedIntervalDays: number | null,
    willCopy: boolean,
    report: ImportReport,
    writer: RowWriter,
    stripFromSource: readonly string[] = []
  ): Promise<ImportedArticle | null> {
    // Read once: a rename during the import changes `file.path` in place
    const { path } = file;
    this.importing.add(path);
    try {
      if ((await sniffMimeType(this.app, file)) === null) {
        report.refuse({
          notice: `"${file.name}" doesn't hold what its extension says; canceling import`,
          reason: "its content isn't what its extension says",
        });
        return null;
      }

      if (willCopy) {
        return await this.importCopy(
          file,
          priority,
          fixedIntervalDays,
          report,
          writer,
          stripFromSource
        );
      }
      return await this.importInPlace(
        file,
        priority,
        fixedIntervalDays,
        report,
        writer
      );
    } finally {
      this.importing.delete(path);
    }
  }

  /**
   * Adopt the snippets and cards taken from `file` before it became the
   * article `articleId` where it is (see `adoptOrphans`), then reload its
   * highlights: they stay where they are, reached by parent id from here on.
   * A card made from a note keeps its embed there, which is where its context
   * is found (see `backlinkRange`).
   */
  private async claimInPlace(file: TFile, articleId: string): Promise<void> {
    const reviewManager = this.plugin.reviewManager;
    if (!reviewManager) return;
    const { snippets, cards } = reviewManager;

    const adopted = [
      ...(await snippets.adoptOrphans(file, articleId)),
      ...(await cards.adoptOrphans(file, articleId)),
    ];
    if (adopted.length === 0) return;
    await this.repaint(snippets, file);
  }

  /** Reload the highlights of `file`, whose snippets and cards changed hands. */
  private async repaint(snippets: SnippetManager, file: TFile) {
    await snippets.getHighlights(file);
    this.app.workspace.trigger('ir-highlights-changed', file.path);
  }

  /** {@link claimInPlace}, as a {@link Claim}. */
  private inPlaceClaim(file: TFile, articleId: string): Claim<void> {
    return {
      now: () => this.claimInPlace(file, articleId),
      rows: async () => {
        const reviewManager = this.plugin.reviewManager;
        // Nothing is taken without it, as `claimInPlace` takes nothing
        if (!reviewManager) {
          return { statements: [], after: () => Promise.resolve() };
        }
        // The rows `adoptOrphans` finds, as both managers share this database
        const statements = this.handoverRows(
          await this.takenFrom(file),
          articleId
        );
        return {
          statements,
          after: async () => {
            if (statements.length > 0) {
              await this.repaint(reviewManager.snippets, file);
            }
          },
        };
      },
    };
  }

  /** The writes that give `taken` to the article `articleId`. */
  private handoverRows(taken: Taken, articleId: string): MutationStatement[] {
    return [
      ...this.adoptStatements('snippet', taken.snippets, articleId),
      ...this.adoptStatements('srs_card', taken.cards, articleId),
    ];
  }

  /**
   * {@link claimInPlace} for a file with no frontmatter, a PDF say, whose row
   * is all that makes it an article.
   */
  async claimFromBinary(pdf: TFile, articleId: string): Promise<void> {
    return this.claimInPlace(pdf, articleId);
  }

  /**
   * The parentless snippets and cards taken from `file`, for
   * {@link handToCopy}. Read before the copy is made: once it is, a link by
   * name alone may resolve to the copy instead. The path is kept as well:
   * renamed meanwhile, `file` would carry its new one.
   */
  private async takenFrom(file: TFile): Promise<Taken> {
    return {
      from: file.path,
      snippets: await this.findParentlessFrom<SnippetRow>('snippet', file),
      cards: await this.findParentlessFrom<SRSCardRow>('srs_card', file),
    };
  }

  /**
   * Give `taken` from `file` to the article `articleId` imported as its copy
   * `copy`, which takes them over: their source links are re-pointed at it,
   * keeping each link's subpath (a PDF's page and selection), and `file`
   * loses their highlights to it. Nothing is written to `file`: a card made
   * from a note keeps its embed there, as the copy, made from its text, has
   * one too.
   * @returns how many snippets and cards changed hands
   */
  private async handToCopy(
    file: TFile,
    taken: Taken,
    articleId: string,
    copy: TFile
  ): Promise<{ snippets: number; cards: number }> {
    await this.adoptRows('snippet', taken.snippets, articleId);
    await this.adoptRows('srs_card', taken.cards, articleId);
    return this.followCopy(file, taken, copy);
  }

  /**
   * What follows the rows of `taken` from `file` naming the article of its
   * copy `copy`: see {@link handToCopy}.
   * @returns how many snippets and cards changed hands
   */
  private async followCopy(
    file: TFile,
    taken: Taken,
    copy: TFile
  ): Promise<{ snippets: number; cards: number }> {
    const counts = {
      snippets: taken.snippets.length,
      cards: taken.cards.length,
    };
    if (counts.snippets + counts.cards === 0) return counts;
    await this.retargetSources(
      [...taken.snippets, ...taken.cards],
      taken.from,
      copy
    );
    this.plugin.reviewManager?.snippets.offsetTracker.loadHighlights(
      file.path,
      []
    );
    this.app.workspace.trigger('ir-highlights-changed', file.path);
    return counts;
  }

  /** {@link handToCopy}, as a {@link Claim}. */
  private copyClaim(
    file: TFile,
    taken: Taken,
    articleId: string,
    copy: TFile
  ): Claim<{ snippets: number; cards: number }> {
    return {
      now: () => this.handToCopy(file, taken, articleId, copy),
      rows: () =>
        Promise.resolve({
          statements: this.handoverRows(taken, articleId),
          after: () => this.followCopy(file, taken, copy),
        }),
    };
  }

  /**
   * Import a note directly
   */
  private async importInPlace(
    file: TFile,
    priority: number,
    fixedIntervalDays: number | null,
    report: ImportReport,
    writer: RowWriter
  ) {
    if (!supportsFrontmatter(file)) {
      return this.importBinaryInPlace(
        file,
        priority,
        fixedIntervalDays,
        report,
        writer
      );
    }

    const frontmatter = Obsidian.getFrontMatter(file, this.app);
    if (frontmatter?.tags?.some((tag) => IMPORT_BLOCKED_TAGS.has(tag))) {
      report.refuse(blockedTag());
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
      // way a user can repair snippets and cards stranded by an earlier import.
      const claimed = await writer.commit(
        null,
        this.inPlaceClaim(file, refMatch.id)
      );
      await claimed();
      report.refuse({
        notice: `Note is already an article; canceling import`,
        reason: 'already an article',
        skipped: true,
      });
      return null;
    } else if (refMatch) {
      // reference matches, but no ID or ID doesn't match
      // TODO: option to choose any one of the rows matching the id/reference
      report.refuse({
        notice: `Another article is already at this file path; canceling import`,
        reason: 'another article is at its path',
      });
      return null;
    }
    if (existingId) {
      const rows = (await this.repo.query(
        `SELECT id, deleted FROM article WHERE id = $1 AND ${NOT_PURGED}`,
        [existingId]
      )) as Pick<ArticleRow, 'id' | 'deleted'>[];
      if (rows[0]) {
        const claimed = await writer.commit(
          relinkRow(file.path, existingId),
          this.inPlaceClaim(file, existingId)
        );
        await this.afterImport(
          file.basename,
          'in place',
          claimed,
          undefined,
          report
        );
        // A deleted row is brought back, which an undo deletes again
        const effect = rows[0].deleted ? 'restored' : 'linked';
        report.confirm(
          `Linked "${file.basename}" to existing article with the same ID`,
          effect === 'restored' ? report.undo : undefined
        );
        warnIfRefused(file.path, report);
        return imported(existingId, effect);
      }
      // Orphaned id + no reference match: fall through to fresh import
    }

    // Past here a new article is made where the note is. An article it
    // already was, above, keeps its path, as existing paths do
    if (refusedInPlace(file, report)) return null;
    const id = crypto.randomUUID();
    // The note is the user's own, so a row that can't be saved puts its
    // `ir-id` and tags back as they were
    const claimed = await withCompensation(async (step) => {
      await step(
        () =>
          Obsidian.updateFrontMatterUndoably(
            file,
            { 'ir-id': id, tags: ARTICLE_TAG } satisfies FrontMatterUpdates,
            this.app
          ),
        (undo) => undo()
      );
      return writer.commit(
        this.importRow(id, file.path, priority, fixedIntervalDays),
        this.inPlaceClaim(file, id)
      );
    });

    await this.afterImport(
      file.basename,
      'in place',
      claimed,
      undefined,
      report
    );

    const titleSlice = getContentSlice(
      file.basename,
      CONTENT_TITLE_SLICE_LENGTH,
      true
    );
    const schedulingString = describeSchedule(priority, fixedIntervalDays);

    report.confirm(
      `Imported "${titleSlice}" with ${schedulingString}`,
      report.undo
    );
    return imported(id, 'created');
  }

  /**
   * Run `work`, which follows the commit of an import of `name`: its note and
   * row are kept, so what fails there is no reason to report the import as
   * failed. Says what was left undone instead: adopting the snippets and cards
   * taken from a file imported where it is, or handing a copy those taken
   * from its original.
   * @returns what `work` answers, or `fallback` when it fails
   */
  private async afterImport<T>(
    name: string,
    kind: 'in place' | 'copy',
    work: () => Promise<T>,
    fallback: T,
    report: ImportReport
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      console.error(error);
      report.warn(
        kind === 'in place'
          ? `"${name}" is an article, but the snippets and cards taken from it couldn't be adopted`
          : `Imported "${name}", but the snippets and cards taken from its original couldn't be handed to it`,
        { kind: 'error', persist: true }
      );
      return fallback;
    }
  }

  /**
   * The button an import's notice opens the note it made with, `title` being
   * how the notice names it.
   */
  private openAction(id: string, title: string): NoticeAction {
    return {
      label: 'Open',
      onClick: (evt) => void this.openImported(id, title, evt),
    };
  }

  /**
   * Open the note of the article `id`, imported as `title`, where it is now:
   * found by its row, which follows a rename, not by the path it was made at.
   * Opened as Go to context opens a note, in the tab the user is in unless
   * `evt` was a modified or middle click (see `Keymap.isModEvent`). Says the
   * article is gone instead when its row or its note is.
   */
  private async openImported(id: string, title: string, evt: MouseEvent) {
    const rows = (await this.repo.query(
      'SELECT reference FROM article WHERE id = $1 AND deleted = 0',
      [id]
    )) as Pick<ArticleRow, 'reference'>[];
    const file = rows[0] ? Obsidian.getNote(rows[0].reference, this.app) : null;
    if (!file) {
      Obsidian.notify(`Couldn't open "${title}": the article is gone`, {
        kind: 'error',
      });
      return;
    }
    await this.plugin.actions._openFile(file, null, Keymap.isModEvent(evt));
  }

  /**
   * Give the note `file`, which holds the `ir-id` `id` no row does, a row of
   * its own: an article whose making or import was cut short before its row
   * was saved (see `crash-leftovers`). Due now at the default priority, as an
   * import is by default, adopting what was taken from it as an import does.
   */
  async adoptLeftover(file: TFile, id: string): Promise<void> {
    await this.insertImported(id, file.path, DEFAULT_PRIORITY, null);
    await this.afterImport(
      file.basename,
      'in place',
      () => this.claimInPlace(file, id),
      undefined,
      toUser
    );
  }

  /** Add the row of a newly imported article at `reference`, due now. */
  private async insertImported(
    id: string,
    reference: string,
    priority: number,
    fixedIntervalDays: number | null
  ) {
    const { query, params } = this.importRow(
      id,
      reference,
      priority,
      fixedIntervalDays
    );
    await this.repo.mutate(query, params);
  }

  /**
   * The write that adds a newly imported article at `reference`, due now,
   * fuzzed if text reviews are. Drawn here, not on its first fetch as for a row
   * that predates fuzzing (see `rowToReviewArticle`): a batch fetches none of
   * its rows, which unfuzzed would come up in the order they were imported.
   */
  private importRow(
    id: string,
    reference: string,
    priority: number,
    fixedIntervalDays: number | null
  ): MutationStatement {
    return {
      query:
        'INSERT INTO article (id, reference, due, interval, priority, fixed_interval_days, due_fuzz) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      params: [
        id,
        reference,
        Date.now(),
        TEXT_BASE_REVIEW_INTERVAL,
        priority,
        fixedIntervalDays,
        this.plugin.settings.fuzzTextReviews ? IRScheduler.getDueFuzz() : null,
      ],
    };
  }

  /**
   * Import a file with no frontmatter, a PDF say, where it is. Nothing is
   * written to the file: the row at its path is all that makes it an article,
   * so its path is also all an earlier import of it is known by.
   */
  private async importBinaryInPlace(
    file: TFile,
    priority: number,
    fixedIntervalDays: number | null,
    report: ImportReport,
    writer: RowWriter
  ) {
    const existing = (
      (await this.repo.query(
        'SELECT id, deleted FROM article WHERE reference = $1',
        [file.path]
      )) as Pick<ArticleRow, 'id' | 'deleted'>[]
    )[0];

    if (existing && !existing.deleted) {
      // Nothing left to import, but re-running it is how a user repairs
      // snippets and cards stranded without a parent
      const claimed = await writer.commit(
        null,
        this.inPlaceClaim(file, existing.id)
      );
      await claimed();
      report.refuse({
        notice: `"${file.name}" is already an article; canceling import`,
        reason: 'already an article',
        skipped: true,
      });
      return null;
    }
    const titleSlice = getContentSlice(
      file.basename,
      CONTENT_TITLE_SLICE_LENGTH,
      true
    );

    if (existing) {
      // A deleted row still holds the path, which is unique, so a new row
      // can't take it. The file is back, so the row is too, with its schedule
      // and history; importing it again asks for it in the queue, so a
      // dismissal is lifted. Only a dismissed row may lack a due date, so one
      // that does is due now.
      const claimed = await writer.commit(
        {
          query:
            'UPDATE article SET deleted = 0, dismissed = 0, due = COALESCE(due, $1) WHERE id = $2',
          params: [Date.now(), existing.id],
        },
        this.inPlaceClaim(file, existing.id)
      );
      // Taken from the file while its row was deleted, they had no parent
      await this.afterImport(
        file.basename,
        'in place',
        claimed,
        undefined,
        report
      );
      report.confirm(
        `Restored the article "${titleSlice}" to the queue with its earlier schedule`,
        report.undo
      );
      warnIfRefused(file.path, report);
      return imported(existing.id, 'restored');
    }

    // Past here a new article is made where the file is. One it was before,
    // above, comes back at its path, as existing paths do
    if (refusedInPlace(file, report)) return null;
    const id = crypto.randomUUID();
    const claimed = await writer.commit(
      this.importRow(id, file.path, priority, fixedIntervalDays),
      this.inPlaceClaim(file, id)
    );
    await this.afterImport(
      file.basename,
      'in place',
      claimed,
      undefined,
      report
    );

    const schedulingString = describeSchedule(priority, fixedIntervalDays);
    report.confirm(
      `Imported "${titleSlice}" with ${schedulingString}`,
      report.undo
    );
    return imported(id, 'created');
  }

  /**
   * A name in the articles folder for a copy of `file`: its own, read as a
   * title reads text, so a name that arrived by sync, git or zip brings no
   * control, bidi or other invisible character into the copy's, and a
   * generated id when nothing is left of it; warning when that changed it.
   * When `isFree` refuses the name, it gets a random suffix until `isFree`
   * accepts one, with a warning that it couldn't keep its own.
   * @param file the file copied, or what the new note is named for
   * @param options.warnCleaned whether to warn when reading it as a title
   *   changed it
   * @param options.maxBytes the most UTF-8 bytes of its basename to keep (see
   *   `sanitizeForTitle`), for a name that isn't yet one on disk
   */
  private async nameForCopy(
    file: Pick<TFile, 'basename' | 'extension'>,
    isFree: (name: string) => boolean | Promise<boolean>,
    { warnCleaned, maxBytes, report }: CopyNameOptions
  ): Promise<string> {
    const basename =
      Obsidian.sanitizeForTitle(file.basename, true, undefined, maxBytes) ||
      Obsidian.createTitle();
    let name = `${basename}.${file.extension}`;
    if (!(await isFree(name))) {
      report.warn(`Warning: article with name already exists "${name}"`, {
        persist: true,
      });
      do {
        name = `${basename} - ${generateId()}.${file.extension}`;
      } while (!(await isFree(name)));
    }
    // Obsidian keeps paths as NFC, so a name only NFC changes is its own
    if (warnCleaned && basename !== file.basename.normalize('NFC')) {
      report.warn(
        `Warning: removed characters a note name can't hold; the copy is named "${name}"`,
        { persist: true }
      );
    }
    return name;
  }

  /**
   * Claim the articles-folder path for a copy named `name`, unless a file
   * there has the name in any case (a case-insensitive file system can't hold
   * both), an article row holds the path, a rebind record names it as an
   * article's old path, or another copy has claimed it. A row holds its path
   * even once deleted, and the path is unique; and a copy landing on a deleted
   * row's path, or on a rebound article's old one, would bring that article
   * back to it (see `ReviewManager.handleCreation`).
   * @returns whether the path is now this caller's, to release once done
   */
  private async claimCopyTarget(name: string): Promise<boolean> {
    const path = Obsidian.getTargetPath(name, 'article');
    // Undocumented: Vault.getAbstractFileByPathInsensitive, which Obsidian's
    // own getAvailablePath uses for the same reason.
    if (this.app.vault.getAbstractFileByPathInsensitive(path)) return false;
    // Any rebind record, reclaimable or not: a stale one costs only a suffix
    const rows = await this.repo.query(
      `SELECT 1 FROM article WHERE reference = $1
       UNION ALL SELECT 1 FROM rebind WHERE old_reference = $1 AND deleted = FALSE`,
      [path]
    );
    // Checked and claimed with no await between, so two imports can't both
    // pass the checks above and take the same path.
    const key = path.toLowerCase();
    if (rows.length > 0 || this.copyTargets.has(key)) return false;
    this.copyTargets.add(key);
    return true;
  }

  /**
   * Claim a name in the articles folder for a copy of `file` (see
   * `nameForCopy` and `claimCopyTarget`), and hold it while `work` makes the
   * copy under it, releasing it once `work` settles either way.
   */
  private async withCopyTarget<T>(
    file: Pick<TFile, 'basename' | 'extension'>,
    options: CopyNameOptions,
    work: (name: string) => Promise<T>
  ): Promise<T> {
    const name = await this.nameForCopy(
      file,
      (candidate) => this.claimCopyTarget(candidate),
      options
    );
    try {
      return await work(name);
    } finally {
      this.copyTargets.delete(
        Obsidian.getTargetPath(name, 'article').toLowerCase()
      );
    }
  }

  /**
   * Copy a file with no frontmatter, a PDF say, byte for byte into the
   * articles folder, and import the copy where it lands. Nothing is written
   * to either file, so the copy keeps no link to its original.
   */
  private async importBinaryCopy(
    file: TFile,
    priority: number,
    fixedIntervalDays: number | null,
    report: ImportReport,
    writer: RowWriter
  ) {
    const naming: CopyNameOptions = { warnCleaned: true, report };
    return this.withCopyTarget(file, naming, async (name) => {
      const copyPath = Obsidian.getTargetPath(name, 'article');
      const taken = await this.takenFrom(file);
      await Obsidian.ensureParentFolder(this.app, copyPath);
      const id = crypto.randomUUID();
      // Left behind, a copy no row refers to would only hold its name against
      // the next import
      const { copy, claimed } = await withCompensation(async (step) => {
        const made = await step(
          () => this.app.vault.copy(file, copyPath),
          (copied) => this.app.fileManager.trashFile(copied)
        );
        return {
          copy: made,
          claimed: await writer.commit(
            this.importRow(id, made.path, priority, fixedIntervalDays),
            this.copyClaim(file, taken, id, made)
          ),
        };
      });
      const moved = await this.afterImport(
        copy.basename,
        'copy',
        claimed,
        { snippets: 0, cards: 0 },
        report
      );

      const titleSlice = getContentSlice(
        copy.basename,
        CONTENT_TITLE_SLICE_LENGTH,
        true
      );
      const schedulingString = describeSchedule(priority, fixedIntervalDays);
      report.confirm(
        `Imported "${titleSlice}" with ${schedulingString}${movedToCopy(moved)}`,
        this.openAction(id, titleSlice)
      );
      return imported(id, 'created', copy);
    });
  }

  /**
   * The text of `copy`, which is being made of `file`'s text `content`, and
   * the edits its frontmatter needs: each of `links` (see `resolveLinks`)
   * re-based so it resolves from `copy` to what it did from `file`, or to
   * `copy` where that was `file` (see `rebaseLinks`). Read while `copy` is
   * there, so a link by name alone that it would take is seen to. With no
   * `links`, which `file`'s cache couldn't say, or when re-basing fails, the
   * text is as it was. Then, or when some link couldn't be re-based, a
   * warning says so: a copy with some links that don't resolve beats none.
   */
  private rebaseCopy(
    file: TFile,
    copy: TFile,
    content: string,
    links: ResolvedLink[] | null,
    report: ImportReport
  ): { text: string; frontmatter: FrontmatterLinkEdit[] } {
    const { metadataCache } = this.app;
    try {
      if (links) {
        const { missed, ...rebased } = rebaseLinks(content, links, {
          original: file,
          copy,
          resolve: (linkpath) =>
            metadataCache.getFirstLinkpathDest(linkpath, copy.path),
          linktext: (target, omitMd) =>
            metadataCache.fileToLinktext(target, copy.path, omitMd),
        });
        if (missed > 0) this.warnLinksKept(file, report);
        return rebased;
      }
    } catch (error) {
      console.error(error);
    }
    this.warnLinksKept(file, report);
    return { text: content, frontmatter: [] };
  }

  /** Say that links in the copy of `file` may not lead where they did. */
  private warnLinksKept(file: TFile, report: ImportReport) {
    report.warn(
      `Warning: couldn't update the links in the copy of "${file.basename}"; some may not lead where they did`,
      { kind: 'error', persist: true }
    );
  }

  /**
   * Copy a file to the data directory, then import the copy
   * @param stripFromSource tags to take off `file` once the copy is the
   *   article, so the tags that asked for the import end on the note carrying
   *   the `ir-id` and `file` no longer asks. Only when a copy is made: a
   *   note linked back to its own row keeps them.
   */
  private async importCopy(
    file: TFile,
    priority: number,
    fixedIntervalDays: number | null,
    report: ImportReport,
    writer: RowWriter,
    stripFromSource: readonly string[]
  ) {
    if (inDataDirectory(file)) {
      report.refuse({
        notice: `"${file.name}" is already in the plugin data folder; canceling import`,
        reason: 'already in the plugin data folder',
      });
      return null;
    }
    if (!supportsFrontmatter(file)) {
      return this.importBinaryCopy(
        file,
        priority,
        fixedIntervalDays,
        report,
        writer
      );
    }

    const frontmatter = Obsidian.getFrontMatter(file, this.app);
    if (frontmatter?.tags?.some((tag) => IMPORT_BLOCKED_TAGS.has(tag))) {
      report.refuse(blockedTag());
      return null;
    }

    // Re-associate if the source already carries an ir-id with a matching DB row
    const existingId = frontmatter?.['ir-id'];
    if (existingId) {
      const rows = (await this.repo.query(
        `SELECT id, deleted FROM article WHERE id = $1 AND ${NOT_PURGED}`,
        [existingId]
      )) as Pick<ArticleRow, 'id' | 'deleted'>[];
      if (rows[0]) {
        const claimed = await writer.commit(
          relinkRow(file.path, existingId),
          this.inPlaceClaim(file, existingId)
        );
        // No copy was made — the record now points at this note, so its
        // snippets and cards are adopted in place rather than handed to a copy.
        await this.afterImport(
          file.basename,
          'in place',
          claimed,
          undefined,
          report
        );
        // A deleted row is brought back, which an undo deletes again
        const effect = rows[0].deleted ? 'restored' : 'linked';
        report.confirm(
          `Linked "${file.basename}" to existing article with the same ID`,
          effect === 'restored' ? report.undo : undefined
        );
        warnIfRefused(file.path, report);
        return imported(existingId, effect);
      }
      // Orphaned ir-id: warn but proceed with creating the copy
      report.warn(
        `Warning: source note has article metadata but no ` +
          `matching record; creating copy`,
        { persist: true }
      );
    }

    // Read once Obsidian has read the note, so its cache describes this text
    await Obsidian.settleMetadataCache(this.app);
    const content = await this.app.vault.cachedRead(file);
    // Where its links go from it, before a copy is there to take any
    const links = resolveLinks(
      content,
      this.app.metadataCache.getFileCache(file),
      (linkpath) =>
        this.app.metadataCache.getFirstLinkpathDest(linkpath, file.path)
    );

    const naming: CopyNameOptions = { warnCleaned: true, report };
    return this.withCopyTarget(file, naming, async (importFileName) => {
      const taken = await this.takenFrom(file);
      let frontmatterLinks: FrontmatterLinkEdit[] = [];
      const id = crypto.randomUUID();
      // Left behind, a copy no row refers to would read as an article review
      // never shows, and hold its name against the next import
      const committed = await withCompensation(async (step) => {
        // Create a copy in the articles directory
        const copy = await step(
          async () => {
            const made = await Obsidian.createNote({
              content: (note) => {
                const rebased = this.rebaseCopy(
                  file,
                  note,
                  content,
                  links,
                  report
                );
                frontmatterLinks = rebased.frontmatter;
                return rebased.text;
              },
              // No properties until the text is there: it opens with the
              // note's own, which the write below then adds to
              fileName: importFileName,
              directory: Obsidian.getDirectory('article'),
              app: this.app,
            });
            if (!made) {
              throw new Error(
                `Failed to create note ${Obsidian.getTargetPath(importFileName, 'article')}`
              );
            }
            return made;
          },
          (made) => this.app.fileManager.trashFile(made)
        );

        // Tag it and create a link to the source if it doesn't exist
        const frontmatterUpdates: FrontMatterUpdates = {
          created: new Date().toISOString(),
          'ir-id': id,
          tags: ARTICLE_TAG,
        };
        if (!frontmatter?.source) {
          const sourceLink = Obsidian.generateMarkdownLink(
            file,
            copy,
            this.app
          );
          frontmatterUpdates[`${SOURCE_PROPERTY_NAME}`] = sourceLink;
        }
        // With its frontmatter links re-based, in the same write
        await Obsidian.updateFrontMatter(
          copy,
          frontmatterUpdates,
          this.app,
          (properties) =>
            applyFrontmatterLinkEdits(properties, frontmatterLinks)
        );

        // The trigger tags went to the copy with the rest of the note's
        // properties; off the note, they no longer ask for an import. Before
        // the commit point, so rows a batch fails to write put them back
        if (stripFromSource.length > 0) {
          await step(
            () =>
              Obsidian.removeFrontMatterTags(file, stripFromSource, this.app),
            (undo) => undo()
          );
        }

        return {
          copy,
          claimed: await writer.commit(
            this.importRow(id, copy.path, priority, fixedIntervalDays),
            this.copyClaim(file, taken, id, copy)
          ),
        };
      });
      const { copy: articleFile, claimed } = committed;

      const moved = await this.afterImport(
        articleFile.basename,
        'copy',
        claimed,
        { snippets: 0, cards: 0 },
        report
      );

      const titleSlice = getContentSlice(
        articleFile.basename,
        CONTENT_TITLE_SLICE_LENGTH,
        true
      );
      const schedulingString = describeSchedule(priority, fixedIntervalDays);
      report.confirm(
        `Imported "${titleSlice}" with ${schedulingString}${movedToCopy(moved)}`,
        this.openAction(id, titleSlice)
      );
      return imported(id, 'created', articleFile);
    });
  }

  /**
   * Import `page`, read from Obsidian's web viewer, as a note made for it in
   * the articles folder: named for its title (see `nameForCopy`), holding its
   * Markdown, with its address as its source. The note and its row are made
   * together or not at all, as a copy's are. Its title was made safe for a
   * file name by Obsidian, so what reading it as a title drops goes unsaid,
   * as does a cut to the length a file name can hold.
   * @returns what the import did, the note it made among it, or null when
   *   nothing was imported
   */
  async importWebPage(
    page: WebPage,
    priority: number,
    fixedIntervalDays: number | null
  ): Promise<ImportResult | null> {
    if (refusedWrite(this.repo, `import "${page.title}"`)) return null;
    try {
      return await this.withCopyTarget(
        { basename: page.title, extension: 'md' },
        // A page title is no name on disk yet: past ~255 bytes, none can be
        {
          warnCleaned: false,
          maxBytes: CONTENT_TITLE_MAX_BYTES,
          report: toUser,
        },
        async (fileName) => {
          const id = crypto.randomUUID();
          const note = await withCompensation(async (step) => {
            // Marked as the article from the start, in one write: a note
            // holding an ir-id no row has is how a cut-short import is found
            // and adopted (see `crash-leftovers`)
            const frontmatter: PluginFrontMatter = {
              created: new Date().toISOString(),
              'ir-id': id,
              tags: [ARTICLE_TAG],
            };
            if (page.url !== null) {
              frontmatter[SOURCE_PROPERTY_NAME] = page.url;
            }
            const made = await step(
              async () => {
                const created = await Obsidian.createNote({
                  content: page.markdown,
                  frontmatter,
                  fileName,
                  directory: Obsidian.getDirectory('article'),
                  app: this.app,
                });
                if (!created) {
                  throw new Error(
                    `Failed to create note ${Obsidian.getTargetPath(fileName, 'article')}`
                  );
                }
                return created;
              },
              (created) => this.app.fileManager.trashFile(created)
            );

            await this.insertImported(
              id,
              made.path,
              priority,
              fixedIntervalDays
            );
            return made;
          });

          const titleSlice = getContentSlice(
            note.basename,
            CONTENT_TITLE_SLICE_LENGTH,
            true
          );
          const schedulingString = describeSchedule(
            priority,
            fixedIntervalDays
          );
          confirmImport(
            `Imported "${titleSlice}" with ${schedulingString}`,
            this.openAction(id, titleSlice)
          );
          return {
            ...imported(id, 'created', note),
            article: await this.fetch(id),
          };
        }
      );
    } catch (error) {
      Obsidian.notify(`Failed to import "${page.title}"`);
      console.error(error);
      return null;
    }
  }

  /**
   * Create a new empty article
   */
  async create(priority: number, directory?: string) {
    if (refusedWrite(this.repo, 'create the article')) return null;
    try {
      const newNoteName = Obsidian.createTitle(
        `New article ${getDateString()}`
      );

      const id = crypto.randomUUID();

      let targetDirectory = Obsidian.getDirectory('article');
      if (directory && this.plugin.settings.createEmptyInCurrentFolder) {
        // Not in a folder whose path would break links to it
        const refused = refusedCharsIn(directory);
        if (refused.length === 0) {
          targetDirectory = directory;
        } else {
          Obsidian.notify(
            `The current folder contains ${listChars(refused)}; created the ` +
              `article in "${targetDirectory}" instead`
          );
        }
      }

      await withCompensation(async (step) => {
        const articleFile = await step(
          async () => {
            const made = await Obsidian.createNote({
              content: '',
              frontmatter: {
                'ir-id': id,
                created: new Date().toISOString(),
              },
              fileName: `${newNoteName}.md`,
              directory: targetDirectory,
              app: this.app,
            });
            if (!made) throw new Error(`Failed to create empty article`);
            return made;
          },
          (made) => this.app.fileManager.trashFile(made)
        );

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
      });

      const result = await this.fetch(id);
      return result;
    } catch (error) {
      Obsidian.notify(`Failed to create empty article`, { kind: 'error' });
      console.error(error);
      return null;
    }
  }

  /**
   * Whether any article is due, as {@link getDue} would find, read straight
   * off the table: no note is squared with its row and no fuzz filled in, so
   * it writes nothing.
   * @throws if the article table cannot be read
   */
  async anyDue(): Promise<boolean> {
    return (await this.fetchMany({ ...this.dueFilter(), limit: 1 })).length > 0;
  }

  /** The `fetchMany` options of articles due by `dueBy`, or by the end of today. */
  private dueFilter(dueBy?: number) {
    return {
      dueBy: dueBy ?? getEndOfDay(this.plugin.settings.dayRolloverOffset),
      // A failed read is not an empty queue
      throwOnError: true,
    };
  }

  /**
   * Articles ready for review.
   * @throws if the article table cannot be read
   */
  async getDue(
    dueBy?: number,
    limit?: number,
    excludeIds?: string[]
  ): Promise<(ReviewArticle | MissingItem<IArticleBase>)[]> {
    const filter = this.dueFilter(dueBy);
    let allExcluded = [...(excludeIds ?? [])];
    let due: (ReviewArticle | MissingItem<IArticleBase>)[];
    // keep fetching until all fetched rows have a note
    let lastMissingNotes = 0;
    do {
      lastMissingNotes = 0;
      due = (
        await this.fetchMany({ ...filter, limit, excludeIds: allExcluded })
      )
        .map((row) => {
          const item =
            this.rowToReviewArticle(row) ??
            this.asMissing(ArticleManager.rowToBase(row));
          if (!item) {
            allExcluded.push(row.id);
            lastMissingNotes += 1;
          }
          return item;
        }, this)
        .filter((article) => article !== null);

      if (this.plugin.settings.fuzzTextReviews) {
        due.sort((a, b) => compareFuzzedDue(a.data, b.data));
      }
    } while (lastMissingNotes > 0);
    return due;
  }

  async fetch(id: string): Promise<ReviewArticle | null> {
    const query = `SELECT * FROM article WHERE id = $1 AND ${NOT_PURGED}`;
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
    /** Reject on a failed query rather than resolve to no rows */
    throwOnError?: boolean;
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

    // Even with the deleted, never those deleted for good
    conditions.push(opts?.includeDeleted ? NOT_PURGED : 'deleted = FALSE');

    if (opts?.excludeIds && opts.excludeIds.length) {
      conditions.push(idNotIn(opts.excludeIds, params));
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

    const rows = opts?.throwOnError
      ? await this.repo.query(query, params, { throwOnError: true })
      : await this.repo.query(query, params);
    return (rows ?? []) as ArticleRow[];
  }

  protected async getLastReview(article: IArticleBase) {
    const lastReview = (
      await this.repo.query(
        `SELECT * FROM article_review WHERE article_id = $1 ` +
          `AND deleted = FALSE ORDER BY review_time DESC LIMIT 1`,
        [article.id]
      )
    )[0] as IArticleReview | undefined;
    return lastReview;
  }

  protected async getReviewCount(article: IArticleBase) {
    const queryResult = (await this.repo.query(
      `SELECT COUNT(id) FROM article_review WHERE article_id = $1 AND deleted = FALSE`,
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
        await this.repo.query(
          `SELECT * FROM article_review WHERE id = $1 AND deleted = FALSE`,
          [reviewId]
        )
      )[0] as IArticleReview;
      if (!reviewRow)
        throw new Error(`No article review found with ID "${reviewId}"`);
      await this.repo.mutate(
        // Tombstoned, not deleted, so the undo reaches the other devices
        `UPDATE article_review SET deleted = TRUE WHERE article_id = $1 AND (id = $2 OR review_time > $3)`,
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
   * Rename an article's note, saying why when the name is refused.
   * @param newName The basename excluding the file extension
   * @returns whether it was renamed: if not, it keeps its old name
   */
  async rename(article: ReviewArticle, newName: string): Promise<boolean> {
    const { file } = article;
    if (!Obsidian.isValidRename(newName, file.basename)) {
      Obsidian.notify(INVALID_TITLE_MESSAGE);
      return false;
    }

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
      return true;
    } catch (error) {
      console.error(error);
      // Unchecked: a name made before a title rule changed is still its own
      await Obsidian.restoreName(file, currentName, this.app);
      // Should the old name break links, the guard puts the new one back
      // (see `ItemPathGuard`), and the article is renamed after all. Known
      // here only when its undo joins the restore's link update, which it
      // does wherever Obsidian has `runAsyncLinkUpdate`
      return file.basename !== currentName;
    }
  }

  /**
   * Change the priority of an article, rescaling the interval its last review
   * set and moving its due date with it (see `IRScheduler.reprioritize`)
   */
  async reprioritize(article: IArticleBase, newPriority: number) {
    IRScheduler.validatePriority(newPriority);

    await this.reprioritizeText(
      'article',
      article,
      newPriority,
      await this.getLastReview(article)
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
          `Failed to set fixed interval for "${article.reference}":` +
            e.message,
          { kind: 'error' }
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
        `UPDATE article SET fixed_interval_days = NULL, due = $1, interval = $2, ` +
          `priority = $3 WHERE id = $4`,
        [newDueTime, newInterval, newPriority, article.id]
      );
    } catch (_e) {
      Obsidian.notify(
        `Failed to disable fixed interval for article ${article.reference}`,
        { kind: 'error' }
      );
    }
  }

  // #region UN-IMPORT
  /**
   * Make each of `files` that is a live article a plain file again: its row
   * goes for good, with its review history (see `ReviewManager.deleteRow`),
   * and a note loses its `ir-id`, its article tag and every auto-import
   * trigger tag, so nothing imports it again. The snippets and cards taken
   * from it keep reviewing with no parent, until an import of the note adopts
   * them again. A copy stays where it is, a plain note now.
   *
   * The rows go first, all of them in one paced run (see
   * `SQLiteRepository.bulkMutate`), saving once a chunk rather than once a
   * file: while a row is there, the `ir-id` watch would report the note as
   * damaged for what it lost. Only then is each note's frontmatter cleared, one after
   * another. A note whose properties can't be cleared after is left with an
   * orphan `ir-id`, the leftover the startup notice offers to deal with. A
   * file whose rows the run didn't delete fails, as does every one after it
   * once the run stops; the rows of one it stopped part way through are
   * still there, its snippets and cards freed, which un-importing it again
   * finishes.
   *
   * Quiet, as {@link importMany} is: the caller says what came of the batch,
   * and refreshes whatever shows the rows, which a hard delete never reports
   * as changed. One file that can't be looked up never stops the rest.
   * @returns what came of each file, in the order given: `unimported`,
   * `skipped` for one that is no live article, or `failed` with a short reason
   */
  async unimportMany(files: readonly TFile[]): Promise<BulkOutcome[]> {
    const outcomes: BulkOutcome[] = [];
    // The live articles found, and where their outcomes go
    const found: { at: number; file: TFile; id: string }[] = [];
    for (const file of files) {
      const row = await this.unimportRow(file);
      if (typeof row === 'string') {
        found.push({ at: outcomes.length, file, id: row });
        outcomes.push({ file, status: 'unimported' });
      } else {
        outcomes.push(row);
      }
    }

    const failures = await this.deleteArticleRows(found);
    for (const [i, { at, file }] of found.entries()) {
      const reason = failures[i];
      outcomes[at] =
        reason === null
          ? await this.clearArticleProperties(file)
          : { file, status: 'failed', reason };
    }
    return outcomes;
  }

  /**
   * The id of the live article row `file` is, for {@link unimportMany} to
   * delete, or what comes of it when there is none to: `skipped`, or
   * `failed` while saving is paused or the lookup fails.
   */
  private async unimportRow(file: TFile): Promise<string | BulkOutcome> {
    try {
      const lookup = liveArticleLookup(file, this.app);
      const [row] = lookup
        ? ((await this.repo.query(lookup.sql, lookup.params)) as {
            id: string;
          }[])
        : [];
      if (!row) return { file, status: 'skipped', reason: 'not an article' };
      if (this.repo.writeRefusal()) {
        return {
          file,
          status: 'failed',
          reason: 'saving to the database is paused',
        };
      }
      return row.id;
    } catch (error) {
      console.error(error);
      return { file, status: 'failed', reason: errorReason(error) };
    }
  }

  /**
   * Delete the article rows `rows` name for good, in one paced run (see
   * {@link unimportMany}).
   * @returns for each, in order, `null` once its row is gone, or why it isn't
   */
  private async deleteArticleRows(
    rows: readonly { file: TFile; id: string }[]
  ): Promise<(string | null)[]> {
    // Before the rows go, which would make each note an orphan to import
    for (const { file } of rows) {
      this.plugin.autoImportWatcher?.unimporting(file);
    }
    const statements = rows.map(({ id }) => deleteRowStatements('article', id));
    // How many statements went in before the run stopped, and why it did
    let stopped: { written: number; reason: string } | null = null;
    try {
      await this.repo.bulkMutate(statements.flat());
    } catch (error) {
      const short = error instanceof BulkMutateError;
      const cause: unknown = short ? error.cause : error;
      console.error(cause);
      stopped = {
        written: short ? error.committed : 0,
        reason: errorReason(cause),
      };
    }
    let end = 0;
    return rows.map(({ id }, i) => {
      end += statements[i].length;
      if (stopped && end > stopped.written) return stopped.reason;
      // As `deleteRow` does, so a session left on the row cannot resume onto
      // an id that no longer exists
      this.plugin.sessionTracker?.forgetIf(id);
      return null;
    });
  }

  /**
   * Take the article properties off `file`, whose row {@link unimportMany}
   * has deleted, and reload its highlights.
   */
  private async clearArticleProperties(file: TFile): Promise<BulkOutcome> {
    let outcome: BulkOutcome = { file, status: 'unimported' };
    try {
      // Does nothing to a file with no frontmatter, whose row was all of it
      await Obsidian.updateFrontMatter(
        file,
        (frontmatter) => {
          delete frontmatter['ir-id'];
          stripFrontmatterTags(frontmatter, [
            ARTICLE_TAG,
            ...this.plugin.settings.autoImportTags,
          ]);
        },
        this.app
      );
    } catch (error) {
      console.error(error);
      outcome = {
        file,
        status: 'failed',
        reason: `its review history is gone, but its properties couldn't be cleared: ${errorReason(error)}`,
      };
    }
    await this.refreshHighlights(file);
    return outcome;
  }

  /**
   * Reload the highlights of `file`, which is no article now: those of its
   * snippets lose the parent they were found by.
   */
  private async refreshHighlights(file: TFile): Promise<void> {
    try {
      await this.plugin.reviewManager.snippets.getHighlights(file);
    } catch (error) {
      console.error(error);
    }
    this.app.workspace.trigger('ir-highlights-changed', file.path);
  }

  /**
   * Take back what `imports` did, the last first (see `Actions.recordImport`):
   * - an article made where its file is is un-imported (see
   *   {@link unimportMany}), trigger tags and all, or the auto-import watcher
   *   would import it again at once;
   * - one made as a note of its own, a copy or a web page's, loses its row for
   *   good, its snippets and cards kept with no parent, and its note goes to
   *   the trash; the file copied is left as it is;
   * - one brought back is deleted again, keeping its history.
   *
   * Only a live article is taken back: one gone since, un-imported or deleted
   * by hand, is passed over, as is one only linked, which had nothing made to
   * take back. What fails is logged, and never stops the rest.
   * @returns the ids of the articles taken back, which are live no longer
   */
  async undoImports(imports: readonly ImportedArticle[]): Promise<string[]> {
    const undone: string[] = [];
    for (const one of [...imports].reverse()) {
      try {
        if (await this.undoImport(one)) undone.push(one.articleId);
      } catch (error) {
        console.error(error);
      }
    }
    return undone;
  }

  /**
   * One of {@link undoImports}.
   * @returns whether its article was taken back
   */
  private async undoImport({
    articleId,
    effect,
    madeFile,
  }: ImportedArticle): Promise<boolean> {
    if (effect === 'linked') return false;
    const reference = await this.liveReference(articleId);
    if (reference === null) {
      console.warn(`Not undoing the import of ${articleId}: it is gone`);
      return false;
    }
    // Where its row says, which follows its file on a rename
    const file = this.app.vault.getFileByPath(reference);
    if (effect === 'restored') {
      await this.markDeleted(articleId, 'article');
      if (file) await this.refreshHighlights(file);
      return true;
    }
    if (madeFile || !file) {
      // Held back from automatic import before its row goes, as an un-import
      if (file) this.plugin.autoImportWatcher?.unimporting(file);
      await this.plugin.reviewManager.deleteRow('article', articleId);
      if (!madeFile || !file) return true;
      try {
        await this.app.fileManager.trashFile(file);
      } catch (error) {
        // Its row gone, it is a plain note: taken back all the same
        console.error(error);
      }
      return true;
    }
    const [outcome] = await this.unimportMany([file]);
    if (outcome.status !== 'unimported') {
      console.warn(`Undoing the import of "${file.path}": ${outcome.reason}`);
    }
    // Its properties failing to clear leaves it taken back all the same
    return (await this.liveReference(articleId)) === null;
  }

  /** Where the live article `id` is, or null when it is none. */
  private async liveReference(id: string): Promise<string | null> {
    const rows = (await this.repo.query(
      'SELECT reference FROM article WHERE id = $1 AND deleted = FALSE',
      [id]
    )) as Pick<ArticleRow, 'reference'>[];
    return rows[0]?.reference ?? null;
  }
  // #endregion
}

/**
 * How to look up the live article row of `file`: for a note, the row its
 * cached `ir-id` names, and only while that row's `reference` is the note's
 * own path, as `ReviewManager.isItemFileAt` asks; for a note claiming no id,
 * or a file with no frontmatter, a PDF say, the row at its path. `null` for a
 * note whose `ir-id` is no string, which no row can answer to. A snippet's or
 * card's id names no article row, so their notes have none.
 *
 * The path matters for a copy of an article's note, which carries the
 * original's `ir-id`: un-importing the copy would otherwise delete the
 * original's row and history, and leave the original an orphan `ir-id`. A
 * row's `reference` follows its note on every rename, so the one cost is that
 * the copy, itself no article, is offered no un-import.
 *
 * A note with no `ir-id` at a live row's path is that row's note, as a review
 * fetch takes it (`ItemManager.reconcileNote`): an
 * article imported before notes carried ids, or one whose properties were
 * cleared, or one the cache is still parsing. `reference` is unique, so no
 * other note can be at that path to be mistaken for it.
 */
export function liveArticleLookup(
  file: TFile,
  app: App
): { sql: string; params: string[] } | null {
  // A file with no frontmatter has no cache entry to carry one. Read as
  // `reconcileNote` reads it: anything falsy claims no id
  const id: unknown =
    app.metadataCache.getFileCache(file)?.frontmatter?.['ir-id'];
  if (!id) {
    return {
      sql: 'SELECT id FROM article WHERE reference = $1 AND deleted = FALSE',
      params: [file.path],
    };
  }
  if (typeof id !== 'string') return null;
  return {
    sql: 'SELECT id FROM article WHERE id = $1 AND reference = $2 AND deleted = FALSE',
    params: [id, file.path],
  };
}
