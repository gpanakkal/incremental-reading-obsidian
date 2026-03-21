import {
  Notice,
  TFile,
  type App,
  type Editor,
  type MarkdownView,
} from 'obsidian';
import type {
  ArticleRow,
  ISnippetActive,
  ISnippetBase,
  ISnippetDisplay,
  ISnippetReview,
  ReviewSnippet,
  SnippetRow,
} from '#/lib/types';
import {
  DEFAULT_PRIORITY,
  ERROR_NOTICE_DURATION_MS,
  MAX_SQL_QUERY_PARAMS,
  SNIPPET_DIRECTORY,
  SNIPPET_TAG,
  SOURCE_PROPERTY_NAME,
  SOURCE_TAG,
  SUCCESS_NOTICE_DURATION_MS,
  TEXT_BASE_REVIEW_INTERVAL,
  TEXT_REVIEW_INTERVALS,
  TEXT_REVIEW_MULTIPLIER_BASE,
  TEXT_REVIEW_MULTIPLIER_STEP,
} from '../constants';
import { ObsidianHelpers as Obsidian } from '../ObsidianHelpers';
import {
  SnippetOffsetTracker,
  type SnippetHighlight,
} from '../SnippetOffsetTracker';
import { getEndOfToday } from '../utils';
import { ItemManager } from './ItemManager';
import type { SQLiteRepository } from '../types';
import type ReviewView from 'src/views/ReviewView';

export class SnippetManager extends ItemManager {
  app: App;
  repo: SQLiteRepository;
  offsetTracker: SnippetOffsetTracker;

  constructor(app: App, repo: SQLiteRepository) {
    super(app, repo);
    this.offsetTracker = new SnippetOffsetTracker();
  }

  static rowToBase(snippetRow: SnippetRow): ISnippetBase {
    return {
      ...snippetRow,
      dismissed: Boolean(snippetRow.dismissed),
    };
  }

  static rowToDisplay(snippetRow: SnippetRow): ISnippetDisplay {
    return {
      ...snippetRow,
      due: snippetRow.due ? new Date(snippetRow.due) : null,
      dismissed: Boolean(snippetRow.dismissed),
    };
  }

  static displayToRow(snippet: ISnippetDisplay): SnippetRow {
    return {
      ...snippet,
      due: snippet.due ? Date.parse(snippet.due.toISOString()) : null,
      dismissed: Number(snippet.dismissed),
    };
  }

  rowToReviewSnippet(row: SnippetRow): ReviewSnippet | null {
    const base = SnippetManager.rowToBase(row);
    const file = Obsidian.getNote(row.reference, this.app);
    if (!file) return null;
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
  ): Promise<{ data: ISnippetActive; file: TFile }[]> {
    const dueTime = dueBy ?? getEndOfToday();
    try {
      const snippetsDue = (
        await this.fetchMany({ dueBy: dueTime, limit, excludeIds })
      ).map(
        async (item) => ({
          data: SnippetManager.rowToBase(item),
          file: Obsidian.getNote(item.reference, this.app),
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
   * Save the selected text and add it to the learning queue
   *
   * todo:
   * - handle edge cases (uncommon characters, leading/trailing spaces, )
   * - selections from web viewer
   * - selections from native PDF viewer
   */
  async create(
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

    await Obsidian.updateFrontMatter(
      snippetFile,
      {
        tags: SNIPPET_TAG,
        [`${SOURCE_PROPERTY_NAME}`]: sourceLink,
      },
      this.app
    );

    // Tag the source note as ir-source if it doesn't have any IR tag yet
    const parentType = Obsidian.getNoteType(currentFile, this.app);
    if (!parentType) {
      await Obsidian.updateFrontMatter(
        currentFile,
        { tags: SOURCE_TAG },
        this.app
      );
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
  protected async createEntry(
    snippetFile: TFile,
    reviewTime: number,
    priority: number,
    parentId?: string,
    offsets?: { start: number; end: number }
  ) {
    try {
      const query =
        `INSERT INTO snippet ` +
        `(id, reference, due, priority, parent, start_offset, end_offset) ` +
        `VALUES ($1, $2, $3, $4, $5, $6, $7)`;
      // save the snippet to the database
      const result = await this.repo.mutate(query, [
        crypto.randomUUID(),
        `${SNIPPET_DIRECTORY}/${snippetFile.name}`,
        reviewTime,
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
      return result;
    } catch (error) {
      new Notice(
        `Failed to save snippet to db: ${snippetFile.basename}`,
        ERROR_NOTICE_DURATION_MS
      );
      console.error(error);
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
    const parentType = Obsidian.getNoteType(parentFile, this.app);
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
    parentEntry: ArticleRow | SnippetRow | null | undefined,
    cm: { dispatch: (spec: unknown) => void }
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
            dismissed: Boolean(snippetRow.dismissed),
            start_offset: snippetRow.start_offset,
            end_offset: snippetRow.end_offset,
            parent: snippetRow.parent ?? '',
          },
        ]);
      }
    }

    const { refreshHighlightsEffect } = await import('../extensions');
    cm.dispatch({ effects: refreshHighlightsEffect.of(null) });
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
      if (Obsidian.getNoteType(linkingFile, this.app) !== 'snippet') continue;

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
   * Add a SnippetReview and set the next review date
   */
  async review(
    snippet: ISnippetBase,
    reviewTime?: number,
    nextReviewInterval?: number
  ) {
    const reviewed = reviewTime || Date.now();
    const nextReview =
      reviewed +
      (nextReviewInterval ?? (await this.nextReviewInterval(snippet)));
    try {
      await this.repo.mutate(
        'INSERT INTO snippet_review (id, snippet_id, review_time) VALUES ($1, $2, $3)',
        [crypto.randomUUID(), snippet.id, reviewed]
      );

      await this.repo.mutate(
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
  async reprioritize(snippet: ISnippetBase, newPriority: number) {
    if (newPriority % 1 !== 0 || newPriority < 10 || newPriority > 50) {
      throw new TypeError(
        `Priority must be an integer between 10 and 50 inclusive; received ${newPriority}`
      );
    }
    const { priority: _, ...rest } = snippet;
    const lastReview = await this.getLastReview(snippet);
    const newInterval = await this.nextReviewInterval({
      ...rest,
      priority: newPriority,
    });
    const newDueTime = lastReview
      ? lastReview.review_time + newInterval
      : snippet.due;

    await this.repo.mutate(
      `UPDATE snippet SET priority = $1, due = $2 WHERE id = $3`,
      [newPriority, newDueTime, snippet.id]
    );
  }

  protected async nextReviewInterval(text: ISnippetBase): Promise<number> {
    const intervalMultiplier =
      TEXT_REVIEW_MULTIPLIER_BASE +
      (text.priority - 10) * TEXT_REVIEW_MULTIPLIER_STEP;

    const lastReview = await this.getLastReview(text);

    const lastInterval =
      lastReview && text.due
        ? text.due - lastReview.review_time
        : TEXT_BASE_REVIEW_INTERVAL;

    const nextInterval = Math.round(lastInterval * intervalMultiplier);
    return nextInterval;
  }
}
