import {
  DEFAULT_PRIORITY,
  MAX_SQL_QUERY_PARAMS,
  REVIEW_COUNT_FOR_PRIORITY_SCALING,
  SNIPPET_TAG,
  SOURCE_INDEX_TIMEOUT_MS,
  SOURCE_PROPERTY_NAME,
  SOURCE_TAG,
  TEXT_BASE_REVIEW_INTERVAL,
  TEXT_REVIEW_INTERVALS,
} from '#/lib/constants';
import IRScheduler from '#/lib/IRScheduler';
import { getMimeType, supportsFrontmatter } from '#/lib/mime';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { decodeAnchor, MIN_ANCHOR } from '#/lib/pdf/pdf-anchor';
import {
  originFile,
  pageLinkAlias,
  type PdfOrigin,
} from '#/lib/pdf/pdf-selection';
import {
  SnippetOffsetTracker,
  type SnippetHighlight,
} from '#/lib/SnippetOffsetTracker';
import type {
  IArticleBase,
  ISnippetBase,
  ISnippetDisplay,
  ISnippetReview,
  MissingItem,
  ReviewSnippet,
  SnippetRow,
  SQLiteRepository,
} from '#/lib/types';
import { compareFuzzedDue, getEndOfDay } from '#/lib/utils';
import type IncrementalReadingPlugin from '#/main';
import type ReviewView from '#/views/ReviewView';
import {
  normalizePath,
  type Editor,
  type MarkdownView,
  type TFile,
} from 'obsidian';
import { refreshHighlightsEffect } from '../extensions';
import { ArticleManager } from './ArticleManager';
import { ItemManager } from './ItemManager';

export class SnippetManager extends ItemManager {
  offsetTracker: SnippetOffsetTracker;

  constructor(plugin: IncrementalReadingPlugin, repo: SQLiteRepository) {
    super(plugin, repo);
    this.offsetTracker = new SnippetOffsetTracker();
  }

  static rowToBase(snippetRow: SnippetRow): ISnippetBase {
    return {
      ...snippetRow,
      type: 'snippet',
      dismissed: Boolean(snippetRow.dismissed),
    };
  }

  static rowToDisplay(snippetRow: SnippetRow): ISnippetDisplay {
    return {
      ...snippetRow,
      type: 'snippet',
      due: snippetRow.due !== null ? new Date(snippetRow.due) : null,
      dismissed: Boolean(snippetRow.dismissed),
    };
  }

  /**
   * Narrow a row to a highlight, or null if it has no offsets to render.
   * A snippet without offsets predates offset tracking or was taken from a
   * view that could not report a selection range.
   */
  static rowToHighlight(snippetRow: SnippetRow): SnippetHighlight | null {
    if (snippetRow.start_offset == null || snippetRow.end_offset == null) {
      return null;
    }
    return {
      ...snippetRow,
      type: 'snippet',
      dismissed: Boolean(snippetRow.dismissed),
      start_offset: snippetRow.start_offset,
      end_offset: snippetRow.end_offset,
      parent: snippetRow.parent ?? '',
    };
  }

  static displayToRow(snippet: ISnippetDisplay): SnippetRow {
    const { type: _, ...rest } = snippet;
    return {
      ...rest,
      due: snippet.due ? Date.parse(snippet.due.toISOString()) : null,
      dismissed: Number(snippet.dismissed),
    };
  }

  rowToReviewSnippet(row: SnippetRow): ReviewSnippet | null {
    const base = SnippetManager.rowToBase(row);
    const file = Obsidian.getNote(row.reference, this.app);
    // Missing, which is never stored: see `MissingItem`
    if (!file) {
      if (row.parent) {
        const parentPath = normalizePath(row.parent);
        this.offsetTracker.removeHighlight(parentPath, row.id);
      }
      return null;
    }

    if (!this.reconcileNote(row, file, 'snippet', SNIPPET_TAG)) return null;

    if (this.plugin.settings.fuzzTextReviews && row.due_fuzz === null) {
      void this.setReviewTimeFuzz(row.id, 'snippet');
    }

    return {
      data: base,
      file,
    };
  }

  /**
   * Update snippet offsets in the database.
   * Used to persist offset changes after document edits.
   * @param snippetId The snippet ID
   * @param startOffset Body-relative start offset
   * @param endOffset Body-relative end offset
   */
  async updateOffsets(
    snippetId: string,
    startOffset: number,
    endOffset: number
  ): Promise<void> {
    await this.repo.mutate(
      `UPDATE snippet SET start_offset = $1, end_offset = $2 WHERE id = $3`,
      [startOffset, endOffset, snippetId]
    );
  }

  /**
   * Persist the offsets of several highlights in one transaction.
   *
   * Every standalone write saves the whole database file, so writing a note's
   * highlights one {@link updateOffsets} at a time rewrote the file once per
   * highlight — on every save of a note being typed into. One transaction
   * saves it once for the lot. Nothing is written for an empty list.
   */
  async updateManyOffsets(
    highlights: readonly Pick<
      SnippetHighlight,
      'id' | 'start_offset' | 'end_offset'
    >[]
  ): Promise<void> {
    if (highlights.length === 0) return;
    await this.repo.transaction(async () => {
      for (const { id, start_offset, end_offset } of highlights) {
        await this.repo.mutate(
          `UPDATE snippet SET start_offset = $1, end_offset = $2 WHERE id = $3`,
          [start_offset, end_offset, id]
        );
      }
    });
  }

  async getDue(
    dueBy?: number,
    limit?: number,
    excludeIds?: string[]
  ): Promise<(ReviewSnippet | MissingItem<ISnippetBase>)[]> {
    const dueTime =
      dueBy ?? getEndOfDay(this.plugin.settings.dayRolloverOffset);
    let allExcluded = [...(excludeIds ?? [])];
    let due: (ReviewSnippet | MissingItem<ISnippetBase>)[];
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
              this.rowToReviewSnippet(row) ??
              this.asMissing(SnippetManager.rowToBase(row));
            if (!item) {
              allExcluded.push(row.id);
              lastMissingNotes += 1;
            }
            return item;
          }, this)
          .filter((snippet) => snippet !== null);

        if (this.plugin.settings.fuzzTextReviews) {
          due.sort((a, b) => compareFuzzedDue(a.data, b.data));
        }
      } while (lastMissingNotes !== 0);
      return due;
    } catch (error) {
      console.error(error);
      return [];
    }
  }

  /**
   * Save the selected text and add it to the learning queue
   *
   * TODO:
   * - handle edge cases (uncommon characters, leading/trailing spaces or omitted delimiters)
   * - selections from web viewer
   * - selections from native PDF viewer
   */
  async create(
    editor: Editor,
    view: MarkdownView | ReviewView,
    firstReview?: number
  ) {
    const snippetDueTime =
      firstReview ?? Date.now() + TEXT_REVIEW_INTERVALS.TOMORROW;

    // capture the current file BEFORE any async operations
    // to avoid race conditions where view.file changes during processing
    const currentFile = view.file;

    if (!currentFile) {
      Obsidian.notify(`Snipping not supported from ${view.getViewType()}`);
      return null;
    }

    const selection = editor.getSelection() || view.getSelection();
    if (!selection) {
      Obsidian.notify('Text must be selected');
      return null;
    }
    const snippetFile = await Obsidian.createFromText(
      selection,
      Obsidian.getDirectory('snippet'),
      this.app
    );

    // Tag it and link to the source file
    const sourceLink = Obsidian.generateMarkdownLink(
      currentFile,
      snippetFile,
      this.app
    );

    const id = crypto.randomUUID();
    await Obsidian.updateFrontMatter(
      snippetFile,
      {
        'ir-id': id,
        tags: SNIPPET_TAG,
        [`${SOURCE_PROPERTY_NAME}`]: sourceLink,
      },
      this.app
    );

    // Tag the source note as ir-source if it doesn't have any IR tag yet (a
    // PDF, which has no tags, is left untagged by `updateFrontMatter`)
    const parentType = await this.getItemType(currentFile);
    if (!parentType) {
      await Obsidian.updateFrontMatter(
        currentFile,
        { tags: SOURCE_TAG },
        this.app
      );
    }

    // inherit priority from the source file if it has one, or assign default priority
    let currentFileEntry: IArticleBase | ISnippetBase | null = null;
    if (parentType === 'article') {
      const articleRow = await this.findArticle(currentFile);
      if (articleRow) {
        currentFileEntry = ArticleManager.rowToBase(articleRow);
      }
    } else if (parentType === 'snippet') {
      const snippetRow = await this.findSnippet(currentFile);
      if (snippetRow) {
        currentFileEntry = SnippetManager.rowToBase(snippetRow);
      }
    }

    if (parentType && !currentFileEntry) {
      throw new Error(
        `Couldn't find entry for ${parentType} ${currentFile.path}`
      );
    }

    const priority = currentFileEntry
      ? SnippetManager.childPriority(currentFileEntry, snippetDueTime)
      : DEFAULT_PRIORITY;

    // Calculate body-relative character offsets for highlighting
    let offsets: { start: number; end: number } | null = null;

    // Try to get offsets from CodeMirror
    const cm = editor.cm;
    if (cm && cm.state && cm.state.selection) {
      const range = cm.state.selection.ranges[0];
      if (range) {
        // Get body start to convert to body-relative offsets
        const docContent = cm.state.doc.toString();
        const bodyStart = Obsidian.getBodyStartOffset(docContent);

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
    const result = await this.createEntry(
      snippetFile,
      id,
      snippetDueTime,
      priority,
      currentFileEntry?.id,
      offsets ?? undefined
    );

    // Refresh highlights immediately after snippet creation.
    if (offsets && cm) {
      await this.refreshHighlightsAfterSnippetCreation(
        currentFile,
        snippetFile,
        !!currentFileEntry,
        cm
      );
    }

    return result;
  }

  /**
   * The priority of a snippet taken from `parent`, first due at `dueTime`: the
   * parent's own, unless the parent is on a fixed-interval schedule, when it
   * is calculated so the snippet's first n reviews occur before the first n
   * reviews of the parent.
   */
  private static childPriority(
    parent: IArticleBase | ISnippetBase,
    dueTime: number
  ): number {
    if ('fixed_interval_days' in parent && parent.fixed_interval_days) {
      return IRScheduler.childPriorityFromFixedInterval(
        parent,
        REVIEW_COUNT_FOR_PRIORITY_SCALING,
        dueTime
      );
    }
    return parent.priority;
  }

  /**
   * Save `text`, selected in a PDF, as a snippet and add it to the learning
   * queue, first due tomorrow: a child of the PDF's `article` at its priority,
   * or for a `pdf` that is no article, a parentless one at the default
   * priority, as from a note that is none, until the PDF is imported (see
   * {@link adoptOrphans}).
   *
   * The row keeps the selection's anchors as its offsets, which the MIME type
   * of the file its source names says to read as PDF anchors. The note's
   * source links to the selection itself, as Obsidian's own selection links
   * do. Nothing is written to the PDF.
   *
   * @param start anchor of the selection's first character (see
   *   `pdf-anchor`); its page is the one the link names.
   * @param end anchor just past its last character.
   * @param subpath the link's subpath, as `selectionSubpath` writes it.
   * @returns the new snippet, or null when its row couldn't be saved.
   */
  async createFromPdf({
    text,
    start,
    end,
    subpath,
    ...origin
  }: PdfOrigin & {
    text: string;
    start: number;
    end: number;
    subpath: string;
  }): Promise<ReviewSnippet | null> {
    const dueTime = Date.now() + TEXT_REVIEW_INTERVALS.TOMORROW;
    const pdf = originFile(origin);
    const snippetFile = await Obsidian.createFromText(
      text,
      Obsidian.getDirectory('snippet'),
      this.app
    );
    const sourceLink = Obsidian.generateMarkdownLink(
      pdf,
      snippetFile,
      this.app,
      pageLinkAlias(pdf.basename, decodeAnchor(start).page),
      subpath
    );
    const id = crypto.randomUUID();
    await Obsidian.updateFrontMatter(
      snippetFile,
      {
        'ir-id': id,
        tags: SNIPPET_TAG,
        [SOURCE_PROPERTY_NAME]: sourceLink,
      },
      this.app
    );
    const { article } = origin;
    if (!article) {
      // Its row's change tells the PDF's tab to read its highlights again,
      // which finds a parentless snippet by its source link: in the cache by
      // then, or the snippet's highlight waits for the next change
      await this.sourceIndexed(snippetFile, pdf);
    }
    return this.createEntry(
      snippetFile,
      id,
      dueTime,
      article
        ? SnippetManager.childPriority(article.data, dueTime)
        : DEFAULT_PRIORITY,
      article?.data.id,
      { start, end }
    );
  }

  /**
   * Settles once the metadata cache has `note`'s `source` link resolving to
   * `source`, or after {@link SOURCE_INDEX_TIMEOUT_MS} whatever it has.
   */
  private sourceIndexed(note: TFile, source: TFile): Promise<void> {
    const indexed = () =>
      Obsidian.getSourceFile(note, this.app)?.path === source.path;
    if (indexed()) return Promise.resolve();
    const { metadataCache } = this.app;
    return new Promise((resolve) => {
      const done = () => {
        metadataCache.offref(ref);
        window.clearTimeout(timer);
        resolve();
      };
      const ref = metadataCache.on('changed', (file) => {
        if (file.path === note.path && indexed()) done();
      });
      const timer = window.setTimeout(done, SOURCE_INDEX_TIMEOUT_MS);
    });
  }

  /**
   * Given a preexisting snippet file, insert into database
   * @param dueTime when the snippet should first be due. Intervals between
   * subsequent reviews always scale from the base review interval regardless
   * of how far `dueTime` is in the future.
   */
  protected async createEntry(
    snippetFile: TFile,
    id: string,
    dueTime: number,
    priority: number,
    parentId?: string,
    offsets?: { start: number; end: number }
  ) {
    try {
      const query =
        `INSERT INTO snippet ` +
        `(id, reference, due, interval, priority, parent, start_offset, end_offset) ` +
        `VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;
      // save the snippet to the database
      await this.repo.mutate(query, [
        id,
        snippetFile.path,
        dueTime,
        TEXT_BASE_REVIEW_INTERVAL,
        priority,
        parentId,
        offsets?.start ?? null,
        offsets?.end ?? null,
      ]);

      Obsidian.notify(`snippet created: ${snippetFile.basename}`);

      const result = await this.fetch(id);
      return result;
    } catch (error) {
      Obsidian.notify(`Failed to save snippet to db: ${snippetFile.basename}`);
      console.error(error);
      return null;
    }
  }

  /**
   * Delete snippet file and drop its row.
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
        await this.repo.query(`SELECT * FROM snippet WHERE id = $1`, [id])
      )[0] as SnippetRow | null;
      if (!row) throw new Error(`No snippet was found with ID "${id}"`);

      const file = Obsidian.getNote(row.reference, this.app);
      if (file) {
        // delete the snippet file. `promptForFileDeletion` is undocumented
        // Obsidian API (`trashFile` is the public one); its offer to delete
        // unlinked attachments was read from the app bundle.
        await (prompt
          ? this.plugin.app.fileManager.promptForFileDeletion(file)
          : this.plugin.app.fileManager.trashFile(file));
      }

      // remove the row entirely
      await this.repo.mutate(`DELETE FROM snippet WHERE id = $1`, [id]);

      return true;
    } catch (_e) {
      return false;
    }
  }

  async fetch(id: string): Promise<ReviewSnippet | null> {
    const query = `SELECT * FROM snippet WHERE id = $1`;
    const result = await this.repo.query(query, [id]);
    if (!result[0]) return null;
    return this.rowToReviewSnippet(result[0] as SnippetRow);
  }

  async fetchMany(opts?: {
    dueBy?: number;
    limit?: number;
    includeDismissed?: boolean;
    includeDeleted?: boolean;
    excludeIds?: string[];
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
    return ((await this.repo.query(query, params)) ?? []) as SnippetRow[];
  }

  /**
   * Get all snippet highlights for a parent article or snippet
   * Returns only snippets that have offsets (for highlighting)
   * @param parentFile The parent file to query highlights for
   * @returns Array of snippet highlights
   */
  async getHighlights(parentFile: TFile) {
    // First find the parent's ID
    const parentType = await Obsidian.getNoteType(parentFile, this.app);
    let parentEntry;

    if (parentType === 'article' || !supportsFrontmatter(parentFile)) {
      // A file without frontmatter, a PDF, is an article only by its row
      parentEntry = await this.findArticle(parentFile);
    } else if (parentType === 'snippet') {
      parentEntry = await this.findSnippet(parentFile);
    }

    // For articles/snippets with a DB entry, use the existing parent ID query
    if (parentEntry) {
      const results = (await this.repo.query(
        'SELECT * FROM snippet WHERE parent = $1 AND start_offset IS NOT NULL AND end_offset IS NOT NULL AND deleted = FALSE',
        [parentEntry.id]
      )) as SnippetRow[];

      const highlights = results
        .map((r) => SnippetManager.rowToHighlight(r))
        .filter((h): h is SnippetHighlight => h !== null);

      this.offsetTracker.loadHighlights(parentFile.path, highlights);
      return highlights;
    }

    // A PDF that is no article has its snippets by their source links too,
    // but no tag to say it has any: every parentless one is asked. Only those
    // with anchors can be its, and their offsets are read as anchors since it
    // is a PDF their links name (see `pdf-anchor`).
    if (getMimeType(parentFile) === 'application/pdf') {
      const highlights = await this.getOrphanSnippetHighlights(
        parentFile,
        MIN_ANCHOR
      );
      this.offsetTracker.loadHighlights(parentFile.path, highlights);
      return highlights;
    }

    // For source notes (or any note without a DB entry), find snippets by the
    // source property that names this note
    if (Obsidian.isSourceNote(parentFile, this.app)) {
      const highlights = await this.getOrphanSnippetHighlights(parentFile);
      this.offsetTracker.loadHighlights(parentFile.path, highlights);
      return highlights;
    }

    return [];
  }

  /**
   * Re-read every cached file's highlights from the database and tell open
   * views to redraw them.
   *
   * Called after the database file is replaced by another device's copy —
   * Obsidian Sync delivering a snippet taken elsewhere, say. That swap discards
   * the rows the tracker was built from without passing through any of the
   * paths that normally keep it current, so its entries describe a database
   * that no longer exists: a snippet the other device added is missing, and one
   * it deleted lingers. The reload names no files, so every tracked path is
   * refreshed; the tracker holds an entry for each note whose highlights have
   * been read this session, which is exactly the set that can be on screen.
   */
  async refreshAllHighlights() {
    for (const path of this.offsetTracker.getTrackedPaths()) {
      const file = this.app.vault.getFileByPath(path);
      if (!file) {
        // The note was deleted on the other device. Drop the entry so a later
        // note reusing the path does not inherit its highlights.
        this.offsetTracker.invalidateCache(path);
        continue;
      }

      // getHighlights caches what it finds, but returns early without touching
      // the tracker for a note that no longer has highlights to look up (its
      // article row was deleted, its source tag removed). Writing the result
      // back covers that case, so a stale entry can never survive the refresh.
      const highlights = await this.getHighlights(file);
      this.offsetTracker.loadHighlights(path, highlights);

      this.plugin.app.workspace.trigger('ir-highlights-changed', path);
    }
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
    parentEntry: boolean,
    cm: Editor['cm']
  ) {
    if (parentEntry) {
      await this.getHighlights(parentFile);
    } else {
      const snippetRow = await this.findSnippet(snippetFile);
      const highlight = snippetRow
        ? SnippetManager.rowToHighlight(snippetRow)
        : null;
      if (highlight) {
        const existing = this.offsetTracker.getHighlights(parentFile.path);
        this.offsetTracker.loadHighlights(parentFile.path, [
          ...existing,
          highlight,
        ]);
      }
    }

    cm.dispatch({ effects: refreshHighlightsEffect.of(null) });
    this.plugin.app.workspace.trigger('ir-highlights-changed', parentFile.path);
  }

  /**
   * Find snippet highlights for a note that has no database entry of its own,
   * by way of the snippets that name it as their source.
   */
  private async getOrphanSnippetHighlights(
    sourceFile: TFile,
    minStartOffset?: number
  ): Promise<SnippetHighlight[]> {
    const rows = await this.findOrphanSnippetsFrom(sourceFile, minStartOffset);
    return rows
      .map((row) => SnippetManager.rowToHighlight(row))
      .filter((h): h is SnippetHighlight => h !== null);
  }

  /** Snippet rows taken from `file` that belong to no item: see `findParentlessFrom`. */
  private async findOrphanSnippetsFrom(
    file: TFile,
    minStartOffset?: number
  ): Promise<SnippetRow[]> {
    return this.findParentlessFrom<SnippetRow>('snippet', file, minStartOffset);
  }

  /**
   * Hand every parentless snippet taken from `parentFile` to the item now
   * backing that file.
   *
   * Snippets made before the file was imported carry no parent id, so the
   * moment it gains a database entry the parent-id lookup in
   * {@link getHighlights} stops finding them and their highlights vanish.
   * @returns the adopted rows, carrying their new parent
   */
  async adoptOrphans(
    parentFile: TFile,
    parentId: string
  ): Promise<SnippetRow[]> {
    return this.adoptParentless<SnippetRow>('snippet', parentFile, parentId);
  }

  /**
   * Rewrite the `source` property of each snippet note to link to `newSource`,
   * so it reads as though the snippet had been taken from that note.
   *
   * Uses the callback form of `updateFrontMatter` to leave tags untouched.
   */
  async repointSource(snippetRows: SnippetRow[], newSource: TFile) {
    for (const row of snippetRows) {
      const snippetFile = Obsidian.getNote(row.reference, this.app);
      if (!snippetFile) continue;

      const sourceLink = Obsidian.generateMarkdownLink(
        newSource,
        snippetFile,
        this.app
      );
      await Obsidian.updateFrontMatter(
        snippetFile,
        (frontmatter) => {
          frontmatter[SOURCE_PROPERTY_NAME] = sourceLink;
        },
        this.app
      );
    }
  }

  protected async getLastReview(snippet: ISnippetBase) {
    const lastReview = (
      await this.repo.query(
        `SELECT * FROM snippet_review WHERE snippet_id = $1 ` +
          `ORDER BY review_time DESC LIMIT 1`,
        [snippet.id]
      )
    )[0] as ISnippetReview | undefined;
    return lastReview;
  }

  /**
   * Add a SnippetReview and update the due date and interval in a transaction.
   * @returns the id of the inserted `snippet_review` row
   * @throws if either write fails, leaving the db unchanged
   */
  async review(
    snippet: ISnippetBase,
    reviewTime?: number,
    nextReviewInterval?: number
  ) {
    const reviewed = reviewTime ?? Date.now();
    const nextInterval =
      nextReviewInterval ?? IRScheduler.nextInterval(snippet);
    const nextDueTime = reviewed + nextInterval;
    const newFuzz = this.plugin.settings.fuzzTextReviews
      ? IRScheduler.getDueFuzz()
      : snippet.due_fuzz;
    const reviewId = crypto.randomUUID();

    await this.repo.transaction(async () => {
      await this.repo.mutate(
        'INSERT INTO snippet_review (id, snippet_id, review_time) VALUES ($1, $2, $3)',
        [reviewId, snippet.id, reviewed]
      );
      await this.repo.mutate(
        `UPDATE snippet SET dismissed = 0, due = $1, interval = $2, due_fuzz = $3 WHERE id = $4`,
        [nextDueTime, nextInterval, newFuzz, snippet.id]
      );
    });

    return reviewId;
  }

  /**
   * Reset the snippet and remove all reviews from the specified one onwards
   */
  async undoReview(originalSnippet: ISnippetBase, reviewId: string) {
    await this.repo.transaction(async () => {
      const reviewRow = (
        await this.repo.query(`SELECT * FROM snippet_review WHERE id = $1`, [
          reviewId,
        ])
      )[0] as ISnippetReview;
      if (!reviewRow)
        throw new Error(`No snippet review found with ID "${reviewId}"`);
      await this.repo.mutate(
        `DELETE FROM snippet_review WHERE snippet_id = $1 AND (id = $2 OR review_time > $3)`,
        [originalSnippet.id, reviewId, reviewRow.review_time]
      );
      await this.repo.mutate(
        `UPDATE snippet SET dismissed = $1, due = $2, interval = $3, due_fuzz = $4 WHERE id = $5`,
        [
          originalSnippet.dismissed,
          originalSnippet.due,
          originalSnippet.interval,
          originalSnippet.due_fuzz,
          originalSnippet.id,
        ]
      );
    });
  }
  /**
   * Change the priority of a snippet and recalculate its next due date
   */
  async reprioritize(snippet: ISnippetBase, newPriority: number) {
    IRScheduler.validatePriority(newPriority);

    const lastReview = await this.getLastReview(snippet);
    const newInterval = IRScheduler.nextInterval({
      ...snippet,
      priority: newPriority,
    });
    const newDueTime = lastReview
      ? lastReview.review_time + newInterval
      : snippet.due;

    await this.repo.mutate(
      `UPDATE snippet SET priority = $1, due = $2, interval = $3 WHERE id = $4`,
      [newPriority, newDueTime, newInterval, snippet.id]
    );
  }
}
