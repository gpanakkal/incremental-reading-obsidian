import {
  ARTICLE_TAG,
  CARD_TAG,
  CONTENT_TITLE_SLICE_LENGTH,
  DATA_DIRECTORY,
  INVALID_TITLE_MESSAGE,
  MAX_SQL_QUERY_PARAMS,
  SNIPPET_TAG,
  SOURCE_PROPERTY_NAME,
  TEXT_BASE_REVIEW_INTERVAL,
} from '#/lib/constants';
import IRScheduler from '#/lib/IRScheduler';
import {
  isCopyImportable,
  isImportable,
  sniffMimeType,
  supportsFrontmatter,
} from '#/lib/mime';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import {
  applyFrontmatterLinkEdits,
  rebaseLinks,
  resolveLinks,
  type FrontmatterLinkEdit,
  type ResolvedLink,
} from '#/lib/rebase-links';
import type {
  ArticleDisplay,
  ArticleRow,
  FrontMatterUpdates,
  IArticleBase,
  IArticleReview,
  MissingItem,
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
import { type TFile } from 'obsidian';
import { ItemManager } from './ItemManager';

const IMPORT_BLOCKED_TAGS = new Set([SNIPPET_TAG, CARD_TAG]);

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

    if (!this.reconcileNote(row, file, 'article', ARTICLE_TAG)) return null;

    if (this.plugin.settings.fuzzTextReviews && row.due_fuzz === null) {
      void this.setReviewTimeFuzz(row.id, 'article');
    }

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
   * @returns the imported or restored article; for a PDF already imported,
   * that article; or null when nothing was imported
   */
  async import(
    file: TFile,
    priority: number,
    fixedIntervalDays: number | null,
    makeCopy?: boolean
  ) {
    if (!checkImportable(file)) return null;
    // Read once: a rename during the import changes `file.path` in place
    const { path } = file;
    if (this.importing.has(path)) return null;

    const willCopy =
      isCopyImportable(file) && (makeCopy ?? this.plugin.settings.copyOnImport);
    this.importing.add(path);
    try {
      if ((await sniffMimeType(this.app, file)) === null) {
        Obsidian.notify(
          `"${file.name}" doesn't hold what its extension says; canceling import`
        );
        return null;
      }

      if (willCopy) {
        return await this.importCopy(file, priority, fixedIntervalDays);
      }
      return await this.importInPlace(file, priority, fixedIntervalDays);
    } catch (error) {
      Obsidian.notify(`Failed to import article "${file.name}"`);
      console.error(error);
      return null;
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
    await snippets.getHighlights(file);
    this.app.workspace.trigger('ir-highlights-changed', file.path);
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
    const counts = {
      snippets: taken.snippets.length,
      cards: taken.cards.length,
    };
    if (counts.snippets + counts.cards === 0) return counts;
    await this.adoptRows('snippet', taken.snippets, articleId);
    await this.adoptRows('srs_card', taken.cards, articleId);
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

  /**
   * Import a note directly
   */
  private async importInPlace(
    file: TFile,
    priority: number,
    fixedIntervalDays: number | null
  ) {
    if (!supportsFrontmatter(file)) {
      return this.importBinaryInPlace(file, priority, fixedIntervalDays);
    }

    const frontmatter = Obsidian.getFrontMatter(file, this.app);
    if (frontmatter?.tags?.some((tag) => IMPORT_BLOCKED_TAGS.has(tag))) {
      Obsidian.notify(`Note contains a snippet or card tag; canceling import`);
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
      await this.claimInPlace(file, refMatch.id);
      Obsidian.notify(`Note is already an article; canceling import`);
      return null;
    } else if (refMatch) {
      // reference matches, but no ID or ID doesn't match
      // TODO: option to choose any one of the rows matching the id/reference
      Obsidian.notify(
        `Another article is already at this file path; canceling import`
      );
      return null;
    } else if (existingId) {
      const rows = await this.repo.query(
        'SELECT id FROM article WHERE id = $1',
        [existingId]
      );
      if (rows[0]) {
        await this.repo.mutate(
          'UPDATE article SET reference = $1, deleted = FALSE WHERE id = $2',
          [file.path, existingId]
        );
        await this.claimInPlace(file, existingId);
        Obsidian.notify(
          `Linked "${file.basename}" to existing article with the same ID`
        );
        return this.fetch(existingId);
      }
      // Orphaned id + no reference match: fall through to fresh import
    }

    const id = crypto.randomUUID();
    await Obsidian.updateFrontMatter(
      file,
      { 'ir-id': id, tags: ARTICLE_TAG } satisfies FrontMatterUpdates,
      this.app
    );

    await this.insertImported(id, file.path, priority, fixedIntervalDays);

    await this.claimInPlace(file, id);

    const titleSlice = getContentSlice(
      file.basename,
      CONTENT_TITLE_SLICE_LENGTH,
      true
    );
    const schedulingString = describeSchedule(priority, fixedIntervalDays);

    Obsidian.notify(`Imported "${titleSlice}" with ${schedulingString}`);
    return this.fetch(id);
  }

  /** Add the row of a newly imported article at `reference`, due now. */
  private async insertImported(
    id: string,
    reference: string,
    priority: number,
    fixedIntervalDays: number | null
  ) {
    await this.repo.mutate(
      'INSERT INTO article (id, reference, due, interval, priority, fixed_interval_days) VALUES ($1, $2, $3, $4, $5, $6)',
      [
        id,
        reference,
        Date.now(),
        TEXT_BASE_REVIEW_INTERVAL,
        priority,
        fixedIntervalDays,
      ]
    );
  }

  /**
   * Import a file with no frontmatter, a PDF say, where it is. Nothing is
   * written to the file: the row at its path is all that makes it an article,
   * so its path is also all an earlier import of it is known by.
   */
  private async importBinaryInPlace(
    file: TFile,
    priority: number,
    fixedIntervalDays: number | null
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
      await this.claimInPlace(file, existing.id);
      Obsidian.notify(`"${file.name}" is already an article; canceling import`);
      return this.fetch(existing.id);
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
      await this.repo.mutate(
        'UPDATE article SET deleted = 0, dismissed = 0, due = COALESCE(due, $1) WHERE id = $2',
        [Date.now(), existing.id]
      );
      // Taken from the file while its row was deleted, they had no parent
      await this.claimInPlace(file, existing.id);
      Obsidian.notify(
        `Restored the article "${titleSlice}" to the queue with its earlier schedule`
      );
      return this.fetch(existing.id);
    }

    const id = crypto.randomUUID();
    await this.insertImported(id, file.path, priority, fixedIntervalDays);
    await this.claimInPlace(file, id);

    const schedulingString = describeSchedule(priority, fixedIntervalDays);
    Obsidian.notify(`Imported "${titleSlice}" with ${schedulingString}`);
    return this.fetch(id);
  }

  /**
   * A name in the articles folder for a copy of `file`: its own, read as a
   * title reads text, so a name that arrived by sync, git or zip brings no
   * control, bidi or other invisible character into the copy's, and a
   * generated id when nothing is left of it; warning when that changed it.
   * When `isFree` refuses the name, it gets a random suffix until `isFree`
   * accepts one, with a warning that it couldn't keep its own.
   */
  private async nameForCopy(
    file: TFile,
    isFree: (name: string) => boolean | Promise<boolean>
  ): Promise<string> {
    const basename =
      Obsidian.sanitizeForTitle(file.basename, true) || Obsidian.createTitle();
    let name = `${basename}.${file.extension}`;
    if (!(await isFree(name))) {
      Obsidian.notify(
        `Warning: article with name already exists "${name}"`,
        true
      );
      do {
        name = `${basename} - ${generateId()}.${file.extension}`;
      } while (!(await isFree(name)));
    }
    // Obsidian keeps paths as NFC, so a name only NFC changes is its own
    if (basename !== file.basename.normalize('NFC')) {
      Obsidian.notify(
        `Warning: removed characters a note name can't hold; the copy is named "${name}"`,
        true
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
       UNION ALL SELECT 1 FROM rebind WHERE old_reference = $1`,
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
    file: TFile,
    work: (name: string) => Promise<T>
  ): Promise<T> {
    const name = await this.nameForCopy(file, (candidate) =>
      this.claimCopyTarget(candidate)
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
    fixedIntervalDays: number | null
  ) {
    return this.withCopyTarget(file, async (name) => {
      const copyPath = Obsidian.getTargetPath(name, 'article');
      const taken = await this.takenFrom(file);
      await Obsidian.ensureParentFolder(this.app, copyPath);
      const copy = await this.app.vault.copy(file, copyPath);

      const id = crypto.randomUUID();
      try {
        await this.insertImported(id, copy.path, priority, fixedIntervalDays);
      } catch (error) {
        // Left behind, a copy no row refers to would only hold its name
        // against the next import. Failing to remove it is logged, so the
        // error the import fails with is still the one that stopped it.
        await this.app.fileManager.trashFile(copy).catch(console.error);
        throw error;
      }
      const moved = await this.handToCopy(file, taken, id, copy);

      const titleSlice = getContentSlice(
        copy.basename,
        CONTENT_TITLE_SLICE_LENGTH,
        true
      );
      const schedulingString = describeSchedule(priority, fixedIntervalDays);
      Obsidian.notify(
        `Imported "${titleSlice}" with ${schedulingString}${movedToCopy(moved)}`
      );
      return this.fetch(id);
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
    links: ResolvedLink[] | null
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
        if (missed > 0) this.warnLinksKept(file);
        return rebased;
      }
    } catch (error) {
      console.error(error);
    }
    this.warnLinksKept(file);
    return { text: content, frontmatter: [] };
  }

  /** Say that links in the copy of `file` may not lead where they did. */
  private warnLinksKept(file: TFile) {
    Obsidian.notify(
      `Warning: couldn't update the links in the copy of "${file.basename}"; some may not lead where they did`,
      true
    );
  }

  /**
   * Copy a file to the data directory, then import the copy
   */
  private async importCopy(
    file: TFile,
    priority: number,
    fixedIntervalDays: number | null
  ) {
    // check if the file is inside the plugin's data directory
    if (file.path.startsWith(DATA_DIRECTORY)) {
      Obsidian.notify(
        `"${file.name}" is already in the plugin data folder; canceling import`
      );
      return null;
    }
    if (!supportsFrontmatter(file)) {
      return this.importBinaryCopy(file, priority, fixedIntervalDays);
    }

    const frontmatter = Obsidian.getFrontMatter(file, this.app);
    if (frontmatter?.tags?.some((tag) => IMPORT_BLOCKED_TAGS.has(tag))) {
      Obsidian.notify(`Note contains a snippet or card tag; canceling import`);
      return null;
    }

    // Re-associate if the source already carries an ir-id with a matching DB row
    const existingId = frontmatter?.['ir-id'];
    if (existingId) {
      const rows = await this.repo.query(
        'SELECT id FROM article WHERE id = $1',
        [existingId]
      );
      if (rows[0]) {
        await this.repo.mutate(
          'UPDATE article SET reference = $1, deleted = FALSE WHERE id = $2',
          [file.path, existingId]
        );
        // No copy was made — the record now points at this note, so its
        // snippets and cards are adopted in place rather than handed to a copy.
        await this.claimInPlace(file, existingId);
        Obsidian.notify(
          `Linked "${file.basename}" to existing article with the same ID`
        );
        return this.fetch(existingId);
      }
      // Orphaned ir-id: warn but proceed with creating the copy
      Obsidian.notify(
        `Warning: source note has article metadata but no ` +
          `matching record; creating copy`,
        true
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

    return this.withCopyTarget(file, async (importFileName) => {
      const taken = await this.takenFrom(file);
      let frontmatterLinks: FrontmatterLinkEdit[] = [];
      // Create a copy in the articles directory
      const articleFile = await Obsidian.createNote({
        content: (copy) => {
          const rebased = this.rebaseCopy(file, copy, content, links);
          frontmatterLinks = rebased.frontmatter;
          return rebased.text;
        },
        frontmatter: {
          created: new Date().toISOString(),
        },
        fileName: importFileName,
        directory: Obsidian.getDirectory('article'),
        app: this.app,
      });

      if (!articleFile) {
        throw new Error(
          `Failed to create note ${Obsidian.getTargetPath(importFileName, 'article')}`
        );
      }

      const id = crypto.randomUUID();

      // Tag it and create a link to the source if it doesn't exist
      const frontmatterUpdates: FrontMatterUpdates = {
        'ir-id': id,
        tags: ARTICLE_TAG,
      };
      if (!frontmatter?.source) {
        const sourceLink = Obsidian.generateMarkdownLink(
          file,
          articleFile,
          this.app
        );
        frontmatterUpdates[`${SOURCE_PROPERTY_NAME}`] = sourceLink;
      }
      // With its frontmatter links re-based, in the same write
      await Obsidian.updateFrontMatter(
        articleFile,
        frontmatterUpdates,
        this.app,
        (properties) => applyFrontmatterLinkEdits(properties, frontmatterLinks)
      );

      await this.insertImported(
        id,
        articleFile.path,
        priority,
        fixedIntervalDays
      );

      const moved = await this.handToCopy(file, taken, id, articleFile);

      const titleSlice = getContentSlice(
        articleFile.basename,
        CONTENT_TITLE_SLICE_LENGTH,
        true
      );
      const schedulingString = describeSchedule(priority, fixedIntervalDays);
      Obsidian.notify(
        `Imported "${titleSlice}" with ${schedulingString}${movedToCopy(moved)}`
      );
      return this.fetch(id);
    });
  }

  /**
   * Create a new empty article
   */
  async create(priority: number, directory?: string) {
    try {
      const newNoteName = Obsidian.createTitle(
        `New article ${getDateString()}`
      );

      const id = crypto.randomUUID();

      let targetDirectory = Obsidian.getDirectory('article');
      if (directory && this.plugin.settings.createEmptyInCurrentFolder) {
        targetDirectory = directory;
      }

      const articleFile = await Obsidian.createNote({
        content: '',
        frontmatter: {
          'ir-id': id,
          created: new Date().toISOString(),
        },
        fileName: `${newNoteName}.md`,
        directory: targetDirectory,
        app: this.app,
      });

      if (!articleFile) {
        throw new Error(`Failed to create empty article`);
      }

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

      const result = await this.fetch(id);
      return result;
    } catch (error) {
      Obsidian.notify(`Failed to create empty article`);
      console.error(error);
      return null;
    }
  }

  async getDue(
    dueBy?: number,
    limit?: number,
    excludeIds?: string[]
  ): Promise<(ReviewArticle | MissingItem<IArticleBase>)[]> {
    const dueTime =
      dueBy ?? getEndOfDay(this.plugin.settings.dayRolloverOffset);
    let allExcluded = [...(excludeIds ?? [])];
    let due: (ReviewArticle | MissingItem<IArticleBase>)[];
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
    } catch (error) {
      console.error(error);
      return [];
    }
  }

  async fetch(id: string): Promise<ReviewArticle | null> {
    const query = `SELECT * FROM article WHERE id = $1`;
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

    // fuzzed due ASC (nulls last) so LIMIT truncates in presentation order
    query += ' ORDER BY (due IS NULL), due + COALESCE(due_fuzz, 0)';

    if (opts?.limit) {
      params.push(opts?.limit);
      query += ` LIMIT $${params.length}`;
    }

    if (params.length > MAX_SQL_QUERY_PARAMS) {
      throw new Error(
        `Param count ${params.length} exceeded the limit for query "${query}"`
      );
    }
    return ((await this.repo.query(query, params)) ?? []) as ArticleRow[];
  }

  protected async getLastReview(article: IArticleBase) {
    const lastReview = (
      await this.repo.query(
        `SELECT * FROM article_review WHERE article_id = $1 ` +
          `ORDER BY review_time DESC LIMIT 1`,
        [article.id]
      )
    )[0] as IArticleReview | undefined;
    return lastReview;
  }

  protected async getReviewCount(article: IArticleBase) {
    const queryResult = (await this.repo.query(
      `SELECT COUNT(id) FROM article_review WHERE article_id = $1`,
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
        await this.repo.query(`SELECT * FROM article_review WHERE id = $1`, [
          reviewId,
        ])
      )[0] as IArticleReview;
      if (!reviewRow)
        throw new Error(`No article review found with ID "${reviewId}"`);
      await this.repo.mutate(
        `DELETE FROM article_review WHERE article_id = $1 AND (id = $2 OR review_time > $3)`,
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
      return false;
    }
  }

  /**
   * Change the priority of an article and recalculate its next due date
   */
  async reprioritize(article: IArticleBase, newPriority: number) {
    IRScheduler.validatePriority(newPriority);

    const lastReview = await this.getLastReview(article);
    const newInterval = IRScheduler.nextInterval({
      ...article,
      priority: newPriority,
    });
    const newDueTime = lastReview
      ? lastReview.review_time + newInterval
      : article.due;

    await this.repo.mutate(
      `UPDATE article SET priority = $1, due = $2, interval = $3 WHERE id = $4`,
      [newPriority, newDueTime, newInterval, article.id]
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
          `Failed to set fixed interval for "${article.reference}":` + e.message
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
        `Failed to disable fixed interval for article ${article.reference}`
      );
    }
  }
}
