import { ViewPlugin, Decoration } from '@codemirror/view';
import type { ViewUpdate, DecorationSet, EditorView } from '@codemirror/view';
import { Annotation, RangeSetBuilder } from '@codemirror/state';
import type { TFile } from 'obsidian';
import { irPluginFacet } from './irPluginFacet';
import { getFileFromState, getAppFromState, getIRNoteType } from './utils';
import type {
  SnippetOffsetTracker,
  SnippetHighlight,
} from '../SnippetOffsetTracker';
import type ReviewManager from '../ReviewManager';
import ReviewView from '#/views/ReviewView';

/**
 * Annotation to mark transactions from external value sync (e.g., when IREditor
 * receives updated content from React Query after the standard editor modified the file).
 * SnippetHighlightExtension reloads from DB for these instead of mapping positions.
 */
export const isExternalSync = Annotation.define<boolean>();

/**
 * CodeMirror extension that renders snippet highlights as decorations.
 *
 * Features:
 * - Renders highlights on text ranges from which snippets were extracted
 * - Highlights are clickable - clicking navigates to the snippet note in another tab
 *
 * Note: All offsets in the tracker are body-relative (excluding frontmatter).
 * Conversion to absolute positions happens only at render time.
 */
export const snippetHighlightExtension = ViewPlugin.fromClass(
  class SnippetHighlightPlugin {
    decorations: DecorationSet;
    private file: TFile | null;
    private highlightsLoaded: boolean = false;
    private persistTimeout: ReturnType<typeof setTimeout> | null = null;
    private isReviewInterface: boolean = false;

    constructor(view: EditorView) {
      this.file = getFileFromState(view.state);
      this.decorations = Decoration.none;

      // Check if we're in the review interface
      const app = getAppFromState(view.state);
      if (!app) throw new Error(`Couldn't retrieve app from view state`);
      const activeView = app.workspace.getActiveViewOfType(ReviewView);
      this.isReviewInterface = activeView !== null;

      // Load highlights asynchronously
      this.loadHighlights(view);
    }

    private async loadHighlights(view: EditorView) {
      const plugin = view.state.facet(irPluginFacet);
      const app = getAppFromState(view.state);

      if (!plugin || !app || !this.file) {
        return;
      }

      const noteType = getIRNoteType(app, this.file);
      // Only articles and snippets can have child snippets
      if (noteType !== 'article' && noteType !== 'snippet') {
        return;
      }

      const reviewManager = plugin.reviewManager;
      if (!reviewManager) {
        return;
      }

      // Load highlights from database into tracker (offsets are body-relative)
      await reviewManager.getSnippetHighlights(this.file);
      this.highlightsLoaded = true;

      // Build decorations from tracker
      this.decorations = this.buildDecorations(
        view,
        reviewManager.snippetTracker,
        reviewManager
      );

      // Force a view update to show the decorations
      view.dispatch({});
    }

    update(update: ViewUpdate) {
      const plugin = update.state.facet(irPluginFacet);
      const reviewManager = plugin?.reviewManager;

      if (!reviewManager || !this.file || !this.highlightsLoaded) {
        return;
      }

      // If document changed, update offsets in tracker
      if (update.docChanged) {
        // Detect if this is a full document replacement (external sync).
        // This happens when the review interface receives updated content from
        // the standard editor via query invalidation. In this case, the standard
        // editor has already updated and persisted the offsets correctly, so we
        // should reload from the database rather than trying to map positions
        // (which would double-apply the transformation).
        const isFullReplacement = this.isFullDocumentReplacement(update);

        if (isFullReplacement && this.isReviewInterface) {
          // Reload highlights from database - the standard editor already
          // persisted the correct offsets
          console.log(
            `[SnippetHighlightExtension] Full document replacement detected in review interface, reloading from DB`
          );
          this.reloadHighlightsFromDB(update.view, reviewManager);
          return;
        }

        // Check if this is an external sync transaction (from IREditor's value prop update).
        // This happens when the same note is open in both review and standard editor panes:
        // the standard editor's changes trigger query invalidation, which causes IREditor
        // to dispatch a replacement transaction. We must reload from DB for these since
        // the ChangeSet doesn't represent the actual user edit.
        const isExtSync = update.transactions.some(
          (tr) => tr.annotation(isExternalSync)
        );

        if (isExtSync && this.isReviewInterface) {
          console.log(
            `[SnippetHighlightExtension] External sync detected in review interface, reloading from DB`
          );
          this.reloadHighlightsFromDB(update.view, reviewManager);
          return;
        }

        // For standard editor panes: only update offsets if this is a direct user edit.
        // When the same file is open in multiple panes, Obsidian syncs changes to unfocused
        // panes, but these syncs produce ChangeSets that don't represent the actual edit.
        // We detect user edits via the Transaction.userEvent annotation.
        if (!this.isReviewInterface) {
          const hasUserEvent = update.transactions.some(
            (tr) => tr.isUserEvent('input') || tr.isUserEvent('delete') ||
                    tr.isUserEvent('undo') || tr.isUserEvent('redo')
          );

          if (!hasUserEvent) {
            // This is a sync from another pane, not a direct edit - reload from DB
            console.log(
              `[SnippetHighlightExtension] External file sync in standard editor, reloading from DB`
            );
            this.reloadHighlightsFromDB(update.view, reviewManager);
            return;
          }
        }

        // Use CodeMirror's ChangeSet for ALL document changes, including undo/redo.
        // The ChangeSet correctly represents the transformation (or its inverse for undo),
        // so mapPos() handles everything - even when Obsidian groups multiple edits
        // into a single undo action.
        const oldDocContent = update.startState.doc.toString();
        const oldBodyStart = reviewManager.getBodyStartOffset(oldDocContent);
        const newDocContent = update.state.doc.toString();
        const newBodyStart = reviewManager.getBodyStartOffset(newDocContent);

        reviewManager.snippetTracker.updateOffsetsWithMapping(
          this.file.path,
          update.changes,
          oldBodyStart,
          newBodyStart
        );

        // In regular Obsidian editor, we handle persistence here with debouncing.
        // In the review interface, ReviewItem.saveNote() handles persistence.
        if (!this.isReviewInterface) {
          this.schedulePersist(reviewManager);
        }
      }

      // Always rebuild decorations - the tracker data may have changed
      // (either from document edits above, or from external refresh after snippet creation)
      this.decorations = this.buildDecorations(
        update.view,
        reviewManager.snippetTracker,
        reviewManager
      );
    }

    /**
     * Detect if this update is a full document replacement (external sync).
     * This happens when content is replaced wholesale, like when the review
     * interface receives updated content from another editor.
     */
    private isFullDocumentReplacement(update: ViewUpdate): boolean {
      // Check if there's a single change that replaces the entire old document
      let isFullReplace = false;
      const oldDocLength = update.startState.doc.length;
      const changes: Array<{
        fromA: number;
        toA: number;
        fromB: number;
        toB: number;
      }> = [];

      update.changes.iterChanges((fromA, toA, fromB, toB) => {
        changes.push({ fromA, toA, fromB, toB });
        // If the change starts at 0 and covers the entire old document length,
        // it's a full replacement
        if (fromA === 0 && toA === oldDocLength) {
          isFullReplace = true;
        }
      });

      console.log(
        `[SnippetHighlightExtension] isFullDocumentReplacement check:`,
        {
          isFullReplace,
          oldDocLength,
          newDocLength: update.state.doc.length,
          isReviewInterface: this.isReviewInterface,
          changes,
        }
      );

      return isFullReplace;
    }

    /**
     * Reload highlights from the database.
     * Used when external changes are detected to avoid double-applying transformations.
     */
    private async reloadHighlightsFromDB(
      view: EditorView,
      reviewManager: ReviewManager
    ) {
      if (!this.file) return;

      // Reload from database
      await reviewManager.getSnippetHighlights(this.file);

      // Rebuild decorations
      this.decorations = this.buildDecorations(
        view,
        reviewManager.snippetTracker,
        reviewManager
      );

      // Force view update
      view.dispatch({});
    }

    private schedulePersist(reviewManager: ReviewManager) {
      if (this.persistTimeout) {
        clearTimeout(this.persistTimeout);
      }
      this.persistTimeout = setTimeout(() => {
        this.persistHighlights(reviewManager);
      }, 2000); // 2 second debounce
    }

    private async persistHighlights(reviewManager: ReviewManager) {
      if (!this.file) return;

      const highlights = reviewManager.snippetTracker.getHighlights(
        this.file.path
      );
      console.log(
        `[SnippetHighlightExtension] Persisting ${highlights.length} highlights to database`,
        highlights.map((h: SnippetHighlight) => ({
          id: h.id.slice(0, 8),
          start: h.start_offset,
          end: h.end_offset,
        }))
      );
      for (const h of highlights) {
        await reviewManager.updateSnippetOffsets(
          h.id,
          h.start_offset,
          h.end_offset
        );
      }
      console.log(`[SnippetHighlightExtension] Persistence complete`);
    }

    private buildDecorations(
      view: EditorView,
      tracker: SnippetOffsetTracker,
      reviewManager: ReviewManager
    ): DecorationSet {
      if (!this.file) {
        return Decoration.none;
      }

      const highlights = tracker.getHighlights(this.file.path);
      if (highlights.length === 0) {
        return Decoration.none;
      }

      // Calculate body start offset for converting body-relative to absolute
      const docContent = view.state.doc.toString();
      const bodyStart = reviewManager.getBodyStartOffset(docContent);

      const docLength = view.state.doc.length;
      const builder = new RangeSetBuilder<Decoration>();

      // Sort highlights by start offset for RangeSetBuilder
      // (sort by absolute position for proper ordering)
      const sortedHighlights = [...highlights].sort(
        (a, b) => a.start_offset - b.start_offset
      );

      for (const highlight of sortedHighlights) {
        // Convert body-relative to absolute offsets for decoration
        const absoluteStart = highlight.start_offset + bodyStart;
        const absoluteEnd = highlight.end_offset + bodyStart;

        // Validate offsets are within document bounds
        if (
          absoluteStart < 0 ||
          absoluteEnd > docLength ||
          absoluteStart >= absoluteEnd
        ) {
          continue;
        }

        const decoration = Decoration.mark({
          class: 'ir-snippet-highlight',
          attributes: {
            'data-snippet-id': highlight.id,
            'data-snippet-ref': highlight.reference,
          },
        });

        builder.add(absoluteStart, absoluteEnd, decoration);
      }

      return builder.finish();
    }

    destroy() {
      // Clear any pending persist timeout
      if (this.persistTimeout) {
        clearTimeout(this.persistTimeout);
        this.persistTimeout = null;
      }
    }
  },
  {
    decorations: (v) => v.decorations,

    eventHandlers: {
      click: (event: MouseEvent, view: EditorView) => {
        const target = event.target as HTMLElement;
        const highlight = target.closest('.ir-snippet-highlight');

        if (!highlight) {
          return false;
        }

        const snippetRef = highlight.getAttribute('data-snippet-ref');
        if (!snippetRef) {
          return false;
        }

        // Navigate to the snippet note
        const plugin = view.state.facet(irPluginFacet);
        if (plugin) {
          event.preventDefault();
          event.stopPropagation();

          plugin.app.workspace.openLinkText(snippetRef, '', true);
          return true;
        }

        return false;
      },
    },
  }
);

/**
 * Refresh highlights for a file after snippet creation.
 * Called by ReviewManager when a new snippet is created.
 */
export function refreshHighlights(
  view: EditorView,
  tracker: SnippetOffsetTracker,
  file: TFile
) {
  // Dispatch an empty transaction to trigger plugin update
  // The plugin will rebuild decorations from the updated tracker
  view.dispatch({});
}
