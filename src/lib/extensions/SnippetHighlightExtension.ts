import { ViewPlugin, Decoration } from '@codemirror/view';
import type { ViewUpdate, DecorationSet, EditorView } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import type { TFile } from 'obsidian';
import { irPluginFacet } from './irPluginFacet';
import { getFileFromState, getAppFromState, getIRNoteType } from './utils';
import type {
  SnippetOffsetTracker,
  SnippetHighlight,
} from '../SnippetOffsetTracker';

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

      // Check if we're in the review interface (IREditor sets this marker)
      this.isReviewInterface = !!(view as any).dom?.closest?.(
        '.incremental-reading-review-view'
      );

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
        // Detect if this is an undo or redo transaction
        const isUndo = update.transactions.some((tr) => tr.isUserEvent('undo'));
        const isRedo = update.transactions.some((tr) => tr.isUserEvent('redo'));

        if (isUndo) {
          // Restore offsets from undo history (fully restores previous state)
          reviewManager.snippetTracker.restoreFromUndo(this.file.path);
        } else if (isRedo) {
          // Restore offsets from redo history
          reviewManager.snippetTracker.restoreFromRedo(this.file.path);
        } else {
          // Normal edit: save state before applying changes, then map positions
          reviewManager.snippetTracker.pushUndoState(this.file.path);

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
        }

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

    private schedulePersist(reviewManager: any) {
      if (this.persistTimeout) {
        clearTimeout(this.persistTimeout);
      }
      this.persistTimeout = setTimeout(() => {
        this.persistHighlights(reviewManager);
      }, 2000); // 2 second debounce
    }

    private async persistHighlights(reviewManager: any) {
      if (!this.file) return;

      const highlights = reviewManager.snippetTracker.getHighlights(
        this.file.path
      );
      for (const h of highlights) {
        await reviewManager.updateSnippetOffsets(
          h.id,
          h.start_offset,
          h.end_offset
        );
      }
    }

    private buildDecorations(
      view: EditorView,
      tracker: SnippetOffsetTracker,
      reviewManager: any
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
