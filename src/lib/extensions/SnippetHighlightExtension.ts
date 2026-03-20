import { Annotation, RangeSetBuilder, StateEffect } from '@codemirror/state';
import { Decoration, ViewPlugin } from '@codemirror/view';
import { ObsidianHelpers as Obsidian } from '../ObsidianHelpers';
import { irPluginFacet, isReviewInterfaceFacet } from './irPluginFacet';
import type ReviewManager from '../ReviewManager';
import type {
  SnippetHighlight,
  SnippetOffsetTracker,
} from '../SnippetOffsetTracker';
import type { DecorationSet, EditorView, ViewUpdate } from '@codemirror/view';
import type { TFile } from 'obsidian';

/**
 * Annotation to mark transactions from external value sync (e.g., when IREditor
 * receives updated content from React Query after the standard editor modified the file).
 * SnippetHighlightExtension reloads from DB for these instead of mapping positions.
 */
export const isExternalSync = Annotation.define<boolean>();

/**
 * Effect dispatched after snippet creation to force the highlight plugin
 * to rebuild decorations. An empty dispatch({}) may be optimized away by
 * CodeMirror, but a transaction carrying an effect is always processed.
 */
export const refreshHighlightsEffect = StateEffect.define<null>();

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
      const info = Obsidian.getFileInfoFromState(view.state);
      this.file = info?.file ?? null;
      this.decorations = Decoration.none;

      // Determined via facet provided by IREditor's buildLocalExtensions().
      // More reliable than getActiveViewOfType, which reflects focus at a point
      // in time and can be wrong when the editor is rebuilt by a React effect.
      this.isReviewInterface = view.state.facet(isReviewInterfaceFacet);

      // Load highlights asynchronously
      void this.loadHighlights(view);
    }

    private async loadHighlights(view: EditorView) {
      const plugin = view.state.facet(irPluginFacet);
      const info = Obsidian.getFileInfoFromState(view.state);

      if (!plugin || !info || !this.file) return;

      const isSource = Obsidian.isSourceNote(this.file, info.app);
      const noteType = Obsidian.getNoteType(this.file, info.app);
      // Only sources, articles, and snippets can have child snippets
      if (!(isSource || noteType === 'article' || noteType === 'snippet')) {
        return;
      }

      const reviewManager = plugin.reviewManager;
      if (!reviewManager) return;

      // Load highlights from database into tracker (offsets are body-relative)
      await reviewManager.getSnippetHighlights(this.file);
      this.highlightsLoaded = true;

      // Build decorations from tracker
      this.decorations = this.buildDecorations(
        view,
        reviewManager.snippets.offsetTracker,
        reviewManager
      );

      // Force a view update to show the decorations
      view.dispatch({});
    }

    update(update: ViewUpdate) {
      const plugin = update.state.facet(irPluginFacet);
      const reviewManager = plugin?.reviewManager;

      if (!reviewManager || !this.file) return;

      // If highlights haven't been loaded yet but we received a refresh effect
      // (e.g. a snippet was just created from this note, which tagged it as
      // ir-source mid-session), mark as loaded and build decorations directly
      // from the tracker, which was already populated by the caller.
      // We intentionally skip loadHighlights() here because it would call
      // getSnippetHighlights() which relies on resolvedLinks — those may not
      // have indexed the new snippet file yet, overwriting the tracker with
      // an empty result.
      if (!this.highlightsLoaded) {
        const hasRefresh = update.transactions.some((tr) =>
          tr.effects.some((e) => e.is(refreshHighlightsEffect))
        );
        if (hasRefresh) {
          this.highlightsLoaded = true;
          this.decorations = this.buildDecorations(
            update.view,
            reviewManager.snippets.offsetTracker,
            reviewManager
          );
        }
        return;
      }

      // If document changed, update offsets in tracker
      if (update.docChanged) {
        // Check if this is a direct user edit (input, delete, undo, redo).
        // Non-user changes include:
        //   - isExternalSync: IREditor's value prop update after React Query invalidation
        //   - Obsidian's cross-pane sync when the same file is open in multiple panes
        // In both cases the ChangeSet represents a full replacement, not the actual
        // edit, so we can't map positions from it.
        const hasUserEvent = update.transactions.some(
          (tr) =>
            tr.isUserEvent('input') ||
            tr.isUserEvent('delete') ||
            tr.isUserEvent('undo') ||
            tr.isUserEvent('redo')
        );

        if (!hasUserEvent) {
          if (!this.isReviewInterface) {
            // Standard editor: cross-pane sync → reload from DB.
            // The other pane (which owns the edit) has already persisted.
            // console.log(
            //   `[SnippetHighlightExtension] External file sync in standard editor, reloading from DB`
            // );
            void this.reloadHighlightsFromDB(update.view, reviewManager);
          }
          // Review interface: the shared snippetTracker already has correct
          // offsets from the standard editor's mapping. Just rebuild decorations
          // (which happens unconditionally below).
          return;
        }

        // Direct user edit → map offsets using the ChangeSet.
        // The ChangeSet correctly represents the transformation (or its inverse
        // for undo), so mapPos() handles everything - even when Obsidian groups
        // multiple edits into a single undo action.
        const oldDocContent = update.startState.doc.toString();
        const oldBodyStart = Obsidian.getBodyStartOffset(oldDocContent);
        const newDocContent = update.state.doc.toString();
        const newBodyStart = Obsidian.getBodyStartOffset(newDocContent);

        reviewManager.snippets.offsetTracker.updateOffsetsWithMapping(
          this.file.path,
          update.changes,
          oldBodyStart,
          newBodyStart
        );

        // In regular Obsidian editor, we handle persistence here with debouncing.
        // In the review interface, ReviewItem.saveNote() handles persistence.
        if (!this.isReviewInterface) {
          const highlights = reviewManager.snippets.offsetTracker.getHighlights(
            this.file.path
          );
          this.schedulePersist(reviewManager, this.file, highlights);
        }
      }

      // Always rebuild decorations - the tracker data may have changed
      // (either from document edits above, or from external refresh after snippet creation)
      this.decorations = this.buildDecorations(
        update.view,
        reviewManager.snippets.offsetTracker,
        reviewManager
      );
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
        reviewManager.snippets.offsetTracker,
        reviewManager
      );

      // Force view update
      view.dispatch({});
    }

    private schedulePersist(
      reviewManager: ReviewManager,
      file: TFile,
      highlights: SnippetHighlight[]
    ) {
      if (this.persistTimeout) {
        clearTimeout(this.persistTimeout);
      }
      this.persistTimeout = setTimeout(() => {
        void this.persistHighlights(reviewManager, file, highlights);
      }, 2000); // 2 second debounce
    }

    private async persistHighlights(
      reviewManager: ReviewManager,
      file: TFile,
      highlights: SnippetHighlight[]
    ) {
      if (!file) return;

      // const highlights = reviewManager.snippets.offsetTracker.getHighlights(
      //   this.file.path
      // );
      // console.log(
      //   `[SnippetHighlightExtension] Persisting ${highlights.length} highlights to database`,
      //   highlights.map((h: SnippetHighlight) => ({
      //     id: h.id.slice(0, 8),
      //     start: h.start_offset,
      //     end: h.end_offset,
      //   }))
      // );
      for (const h of highlights) {
        await reviewManager.updateSnippetOffsets(
          h.id,
          h.start_offset,
          h.end_offset
        );
      }
      // console.log(`[SnippetHighlightExtension] Persistence complete`);
    }

    private buildDecorations(
      view: EditorView,
      tracker: SnippetOffsetTracker,
      _reviewManager: ReviewManager
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
      const bodyStart = Obsidian.getBodyStartOffset(docContent);

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

          void plugin.app.workspace.openLinkText(snippetRef, '', true);
          return true;
        }

        return false;
      },
    },
  }
);
