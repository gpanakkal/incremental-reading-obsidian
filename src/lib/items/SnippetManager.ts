import {
  DEFAULT_PRIORITY,
  ERROR_NOTICE_DURATION_MS,
  MAX_SQL_QUERY_PARAMS,
  REVIEW_COUNT_FOR_PRIORITY_SCALING,
  SNIPPET_DIRECTORY,
  SNIPPET_TAG,
  SOURCE_PROPERTY_NAME,
  SOURCE_TAG,
  SUCCESS_NOTICE_DURATION_MS,
  TEXT_BASE_REVIEW_INTERVAL,
  TEXT_REVIEW_INTERVALS,
} from '#/lib/constants';
import IRScheduler from '#/lib/IRScheduler';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import {
  SnippetOffsetTracker,
  type SnippetHighlight,
} from '#/lib/SnippetOffsetTracker';
import type {
  IArticleBase,
  ISnippetBase,
  ISnippetDisplay,
  ISnippetReview,
  ReviewSnippet,
  SnippetRow,
  SQLiteRepository,
} from '#/lib/types';
import { getEndOfToday } from '#/lib/utils';
import type IncrementalReadingPlugin from '#/main';
import type ReviewView from '#/views/ReviewView';
import { Notice, TFile, type Editor, type MarkdownView } from 'obsidian';
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
    if (!file) {
      if (!row.deleted) {
        void this.markDeleted(row.id, 'snippet');
      }
      if (row.parent) {
        const parentPath = Obsidian.getPathFromReference(row.parent);
        this.offsetTracker.removeHighlight(parentPath, row.id);
      }
      return null;
    }

    const frontmatter = Obsidian.getFrontMatter(file, this.app);
    const fileId = frontmatter?.['ir-id'];
    // id is present but doesn't match
    if (fileId && fileId !== row.id) {
      void this.markDeleted(row.id, 'snippet');
      return null;
    }

    // some frontmatter is missing; impute it
    if (!fileId || !frontmatter?.tags?.includes(SNIPPET_TAG)) {
      void this.setFrontmatter(file, row.id, SNIPPET_TAG);
    }

    if (row.deleted) {
      void this.markUndeleted(row.id, 'snippet');
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

  async getDue(
    dueBy?: number,
    limit?: number,
    excludeIds?: string[]
  ): Promise<ReviewSnippet[]> {
    const dueTime =
      dueBy ?? getEndOfToday(this.plugin.settings.dayRolloverOffset);
    let allExcluded = [...(excludeIds ?? [])];
    let due: ReviewSnippet[] = [];
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
            const item = this.rowToReviewSnippet(row);
            if (!item) {
              allExcluded.push(row.id);
              lastMissingNotes += 1;
            }
            return item;
          }, this)
          .filter(
            (snippet): snippet is ReviewSnippet =>
              !!snippet && snippet.file !== null
          );
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
      new Notice(
        `Snipping not supported from ${view.getViewType()}`,
        ERROR_NOTICE_DURATION_MS
      );
      return null;
    }

    const selection = editor.getSelection() || view.getSelection();
    if (!selection) {
      new Notice('Text must be selected', ERROR_NOTICE_DURATION_MS);
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

    // Tag the source note as ir-source if it doesn't have any IR tag yet
    const parentType = await Obsidian.getNoteType(currentFile, this.app);
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

    let priority = currentFileEntry?.priority ?? DEFAULT_PRIORITY;
    // if the parent is on a fixed-interval schedule, calculate priority
    // for this snippet so its first n reviews occur before the first n
    // reviews of the parent item
    if (
      currentFileEntry &&
      'fixed_interval_days' in currentFileEntry &&
      currentFileEntry.fixed_interval_days
    ) {
      priority = IRScheduler.childPriorityFromFixedInterval(
        currentFileEntry,
        REVIEW_COUNT_FOR_PRIORITY_SCALING,
        snippetDueTime
      );
    }

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
        `${SNIPPET_DIRECTORY}/${snippetFile.name}`,
        dueTime,
        TEXT_BASE_REVIEW_INTERVAL,
        priority,
        parentId,
        offsets?.start ?? null,
        offsets?.end ?? null,
      ]);

      // TODO: verify this correctly catches failed inserts
      new Notice(
        `snippet created: ${snippetFile.basename}`,
        SUCCESS_NOTICE_DURATION_MS
      );

      const result = await this.fetch(id);
      return result;
    } catch (error) {
      new Notice(
        `Failed to save snippet to db: ${snippetFile.basename}`,
        ERROR_NOTICE_DURATION_MS
      );
      console.error(error);
      return null;
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

    query += ' ORDER BY priority DESC';

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

    if (parentType === 'article') {
      parentEntry = await this.findArticle(parentFile);
    } else if (parentType === 'snippet') {
      parentEntry = await this.findSnippet(parentFile);
    }

    // For articles/snippets with a DB entry, use the existing parent ID query
    if (parentEntry) {
      const results = (await this.repo.query(
        'SELECT * FROM snippet WHERE parent = $1 AND start_offset IS NOT NULL AND end_offset IS NOT NULL',
        [parentEntry.id]
      )) as SnippetRow[];

      const highlights = results.map((r) => ({
        ...r,
        type: 'snippet' as const,
        dismissed: Boolean(r.dismissed),
        start_offset: r.start_offset!,
        end_offset: r.end_offset!,
        parent: r.parent!,
      }));

      this.offsetTracker.loadHighlights(parentFile.path, highlights);
      return highlights;
    }

    // For source notes (or any note without a DB entry), find snippets via backlinks
    if (Obsidian.isSourceNote(parentFile, this.app)) {
      const highlights =
        await this.getSnippetHighlightsViaBacklinks(parentFile);
      this.offsetTracker.loadHighlights(parentFile.path, highlights);
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
    parentEntry: boolean,
    cm: Editor['cm']
  ) {
    if (parentEntry) {
      await this.getHighlights(parentFile);
    } else {
      const snippetRow = await this.findSnippet(snippetFile);
      if (
        snippetRow &&
        snippetRow.start_offset != null &&
        snippetRow.end_offset != null
      ) {
        const existing = this.offsetTracker.getHighlights(parentFile.path);
        this.offsetTracker.loadHighlights(parentFile.path, [
          ...existing,
          {
            ...snippetRow,
            type: 'snippet' as const,
            dismissed: Boolean(snippetRow.dismissed),
            start_offset: snippetRow.start_offset,
            end_offset: snippetRow.end_offset,
            parent: snippetRow.parent ?? '',
          },
        ]);
      }
    }

    cm.dispatch({ effects: refreshHighlightsEffect.of(null) });
    this.plugin.app.workspace.trigger('ir-highlights-changed', parentFile.path);
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
      if ((await Obsidian.getNoteType(linkingFile, this.app)) !== 'snippet')
        continue;

      const snippetRow = await this.findSnippet(linkingFile);
      if (
        !snippetRow ||
        snippetRow.start_offset == null ||
        snippetRow.end_offset == null
      )
        continue;

      highlights.push({
        ...snippetRow,
        type: 'snippet' as const,
        dismissed: Boolean(snippetRow.dismissed),
        start_offset: snippetRow.start_offset,
        end_offset: snippetRow.end_offset,
        parent: snippetRow.parent ?? '',
      });
    }

    return highlights;
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
   * Add a SnippetReview and update the due date and interval
   * TODO: combine the operations into a transaction
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

    try {
      await Promise.all([
        this.repo.mutate(
          'INSERT INTO snippet_review (id, snippet_id, review_time) VALUES ($1, $2, $3)',
          [crypto.randomUUID(), snippet.id, reviewed]
        ),
        this.repo.mutate(
          `UPDATE snippet SET dismissed = 0, due = $1, interval = $2 WHERE id = $3`,
          [nextDueTime, nextInterval, snippet.id]
        ),
      ]);
    } catch (error) {
      console.error(error);
    }
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
