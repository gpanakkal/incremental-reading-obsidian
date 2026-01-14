import {
  ViewPlugin,
  Decoration,
  DecorationSet,
  EditorView,
} from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import type { TFile } from 'obsidian';
import { irPluginFacet } from './irPluginFacet';
import { getFileFromState, getAppFromState, getIRNoteType } from './utils';
import type { SnippetOffsetTracker, SnippetHighlight } from '../SnippetOffsetTracker';

/**
 * CodeMirror extension that renders snippet highlights as decorations.
 *
 * Features:
 * - Renders yellow highlights on text ranges where snippets were extracted
 * - Highlights are clickable - clicking navigates to the snippet note
 * - Automatically updates highlight positions when document is edited
 * - Shows "corrupted" styling when edits overlap highlight regions
 */
export const snippetHighlightExtension = ViewPlugin.fromClass(
  class SnippetHighlightPlugin {
    decorations: DecorationSet;
    private file: TFile | null;
    private highlightsLoaded: boolean = false;

    constructor(view: EditorView) {
      this.file = getFileFromState(view.state);
      this.decorations = Decoration.none;

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

      // Load highlights from database into tracker
      await reviewManager.getSnippetHighlights(this.file);
      this.highlightsLoaded = true;

      // Build decorations from tracker
      this.decorations = this.buildDecorations(view, reviewManager.snippetTracker);

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
        // Convert CM6 changes to ChangeSpec format
        const changes: Array<{ from: number; to: number; insert?: string }> = [];
        update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
          changes.push({
            from: fromA,
            to: toA,
            insert: inserted.toString(),
          });
        });

        reviewManager.snippetTracker.updateOffsetsForChanges(
          this.file.path,
          changes
        );
      }

      // Rebuild decorations if document changed or viewport changed
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.buildDecorations(
          update.view,
          reviewManager.snippetTracker
        );
      }
    }

    private buildDecorations(
      view: EditorView,
      tracker: SnippetOffsetTracker
    ): DecorationSet {
      if (!this.file) {
        return Decoration.none;
      }

      const highlights = tracker.getHighlights(this.file.path);
      if (highlights.length === 0) {
        return Decoration.none;
      }

      const isCorrupted = tracker.isCorrupted(this.file.path);
      const docLength = view.state.doc.length;
      const builder = new RangeSetBuilder<Decoration>();

      // Sort highlights by start offset for RangeSetBuilder
      const sortedHighlights = [...highlights].sort(
        (a, b) => a.start_offset - b.start_offset
      );

      for (const highlight of sortedHighlights) {
        // Validate offsets are within document bounds
        if (
          highlight.start_offset < 0 ||
          highlight.end_offset > docLength ||
          highlight.start_offset >= highlight.end_offset
        ) {
          continue;
        }

        const classes = ['ir-snippet-highlight'];
        if (isCorrupted) {
          classes.push('ir-corrupted');
        }

        const decoration = Decoration.mark({
          class: classes.join(' '),
          attributes: {
            'data-snippet-id': highlight.id,
            'data-snippet-ref': highlight.reference,
          },
        });

        builder.add(highlight.start_offset, highlight.end_offset, decoration);
      }

      return builder.finish();
    }

    destroy() {
      // Cleanup if needed
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
