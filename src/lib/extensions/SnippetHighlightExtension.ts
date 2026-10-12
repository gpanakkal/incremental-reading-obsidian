// Whatever paints a PDF's highlights must keep this class on a card's, for the
// notice below to name it a card
import { narrowChanges } from '#/lib/minimal-change';
import { CARD_HIGHLIGHT_CLASS } from '#/lib/pdf/pdf-highlights';
import type IncrementalReadingPlugin from '#/main';
import type ReviewView from '#/views/ReviewView';
import { invertedEffects } from '@codemirror/commands';
import {
  Annotation,
  RangeSetBuilder,
  StateEffect,
  type EditorState,
  type Transaction,
} from '@codemirror/state';
import {
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view';
import { Keymap, type EventRef, type TFile } from 'obsidian';
import type ReviewManager from '../items/ReviewManager';
import { ObsidianHelpers as Obsidian } from '../ObsidianHelpers';
import type {
  SnippetHighlight,
  SnippetOffsetTracker,
} from '../SnippetOffsetTracker';
import { irPluginFacet, isReviewInterfaceFacet } from './irPluginFacet';

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
 * Whether a transaction is a sync, whose text arrives with the tracker already
 * moved by the editor that made the edit:
 *   - isExternalSync: IREditor's value prop update after React Query invalidation
 *   - userEvent 'set': Obsidian's cross-pane sync when the same file is open in
 *     several panes, and its reload of a note changed on disk (undocumented:
 *     what Obsidian's MarkdownEditor `set` dispatches)
 */
const isSync = (tr: Transaction) =>
  !!tr.annotation(isExternalSync) || tr.isUserEvent('set');

/**
 * A note's highlights, by id, at absolute positions in one document. Ids are
 * enough to find them again, even if the note was renamed since.
 */
type HighlightSnapshot = (readonly [id: string, start: number, end: number])[];

/**
 * Where a note's highlights were before an edit, for undoing (or redoing) it
 * to put them back exactly. It stands for the one document it was taken of,
 * so any mapping drops it: the history maps a step's effects through changes
 * it doesn't keep as though they were in today's document, which they aren't,
 * and a step of joined edits needs only its earliest, which it never maps.
 * Undoing a step without one maps the highlights, as before.
 */
export const restoreHighlightsEffect = StateEffect.define<HighlightSnapshot>({
  map: () => undefined,
});

/**
 * The states each editor last mapped the tracker to, with the tracker and the
 * note: where an edit's starting state is among them, the tracker says where
 * the note's highlights were before it.
 */
const syncedStates = new WeakMap<
  EditorState,
  { tracker: SnippetOffsetTracker; path: string }
>();

/**
 * Hands the history, with each edit made here, where the note's highlights
 * were before it. Undoing an edit then puts every highlight it moved or
 * erased back where it was — which mapping can't, as text put back says
 * nothing of whose it was — and redoing it puts them where the edit took
 * them.
 */
export const snippetHighlightHistory = invertedEffects.of((tr) => {
  // Not for a sync, whose text arrives with the offsets moved already, nor
  // where the tracker wasn't mapped to the edit's starting state, as between
  // transactions dispatched together: undoing those maps, as before. Nor for
  // one that changes no text — which history would then keep as a step of
  // its own, as cursor moves — unless it's the undo or redo of a step whose
  // edits cancel out, which redo or undo again needs to put back.
  const synced = syncedStates.get(tr.startState);
  if (!synced || isSync(tr)) return [];
  if (
    tr.changes.empty &&
    !tr.effects.some((e) => e.is(restoreHighlightsEffect))
  ) {
    return [];
  }
  const highlights = synced.tracker.getHighlights(synced.path);
  if (highlights.length === 0) return [];
  // All of them, not just those the edit reaches: one it doesn't reach can
  // still move, as when the edit makes or unmakes the frontmatter
  const bodyStart = Obsidian.getBodyStartOffset(tr.startState.doc.toString());
  return [
    restoreHighlightsEffect.of(
      highlights.map(
        (h) =>
          [h.id, h.start_offset + bodyStart, h.end_offset + bodyStart] as const
      )
    ),
  ];
});

/** `MouseEvent.button` value for the middle mouse button. */
export const MIDDLE_MOUSE_BUTTON = 1;

/**
 * Open the snippet, or in a PDF the card, whose highlight the event targeted,
 * honoring the modifier keys the same way Obsidian's own links do.
 *
 * `Keymap.isModEvent` maps Ctrl/Cmd-click and middle-click to `'tab'`,
 * Ctrl/Cmd+Alt to `'split'`, and Ctrl/Cmd+Alt+Shift to `'window'`. A plain
 * click yields `false`, which `openLinkText` reads as "reuse the active leaf".
 *
 * An item missing its file (see `MissingItem`) keeps its highlight, but is
 * not opened: following the link would create an empty note at its reference,
 * which the next review fetch would take for the item's own, leaving its
 * real file no longer relinkable. A plain click in the review tab shows it in
 * review instead, as review shows any missing item, with the way to relink
 * it; anywhere else there is no review to show it in, so a notice says how.
 *
 * @param highlight the highlight to open, when the event's target isn't in
 *   it: a PDF's highlights lie under its text layer, out of the pointer's way.
 * @returns true when the event targeted a highlight and was consumed.
 */
export function openHighlightFromEvent(
  plugin: IncrementalReadingPlugin,
  event: MouseEvent,
  highlight = (event.target as HTMLElement | null)?.closest(
    '.ir-snippet-highlight'
  )
): boolean {
  if (!highlight) return false;

  const ref = highlight.getAttribute('data-snippet-ref');
  if (!ref) return false;

  event.preventDefault();
  event.stopPropagation();

  if (!Obsidian.getNote(ref, plugin.app)) {
    const notify = () => {
      const kind = highlight.classList.contains(CARD_HIGHLIGHT_CLASS)
        ? 'card'
        : 'snippet';
      Obsidian.notify(
        `No file at "${ref}". Relink the ${kind} from the review queue.`
      );
    };
    const review = plugin.getOpenReviewLeaf()?.view as ReviewView | undefined;
    if (
      review?.containerEl.contains(highlight) &&
      Keymap.isModEvent(event) === false
    ) {
      void review
        .showMissingInReview(ref)
        .catch((error: unknown) => {
          console.error('Incremental Reading: could not look a link up', error);
          return false;
        })
        .then((shown) => {
          if (!shown) notify();
        });
    } else {
      notify();
    }
    return true;
  }

  void plugin.app.workspace.openLinkText(ref, '', Keymap.isModEvent(event));
  return true;
}

/**
 * CodeMirror extension that renders snippet highlights as decorations.
 *
 * Features:
 * - Renders highlights on text ranges from which snippets were extracted
 * - Highlights are clickable - clicking navigates to the snippet note, in the
 *   active tab or in a new tab/split/window depending on the modifier keys
 *
 * Note: All offsets in the tracker are body-relative (excluding frontmatter).
 * Conversion to absolute positions happens only at render time.
 */
export const snippetHighlightExtension = ViewPlugin.fromClass(
  class SnippetHighlightPlugin {
    decorations: DecorationSet;
    private file: TFile | null;
    private highlightsLoaded: boolean = false;
    private persistTimeout: number | null = null;
    private isReviewInterface: boolean = false;
    // keep track of if the ViewPlugin was destroyed
    private destroyed: boolean = false;
    private highlightsChangedRef: EventRef | null = null;
    private plugin: IncrementalReadingPlugin | null = null;

    constructor(view: EditorView) {
      const { info } = Obsidian.getFileInfoFromState(view.state);
      this.file = info?.file ?? null;
      this.decorations = Decoration.none;

      // Determined via facet provided by IREditor's buildLocalExtensions().
      // More reliable than getActiveViewOfType, which reflects focus at a point
      // in time and can be wrong when the editor is rebuilt by a React effect.
      this.isReviewInterface = view.state.facet(isReviewInterfaceFacet);

      this.plugin = view.state.facet(irPluginFacet);
      this.highlightsChangedRef =
        this.plugin?.app.workspace.on(
          'ir-highlights-changed',
          (...args: unknown[]) => {
            if (args[0] !== this.file?.path) return;
            view.dispatch({ effects: refreshHighlightsEffect.of(null) });
          }
        ) ?? null;

      // Load highlights asynchronously
      void this.loadHighlights(view);
    }

    private async loadHighlights(view: EditorView) {
      const plugin = view.state.facet(irPluginFacet);
      const { info } = Obsidian.getFileInfoFromState(view.state);

      if (!plugin || !info || !this.file) return;

      const isSource = Obsidian.isSourceNote(this.file, info.app);
      const noteType = await Obsidian.getNoteType(this.file, info.app);
      if (this.destroyed) return;
      // Only sources, articles, and snippets can have child snippets
      if (!(isSource || noteType === 'article' || noteType === 'snippet')) {
        return;
      }

      const reviewManager = plugin.reviewManager;
      if (!reviewManager) return;

      // Load highlights from database into tracker (offsets are body-relative)
      await reviewManager.getSnippetHighlights(this.file);
      if (this.destroyed) return;
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
          syncedStates.set(update.state, {
            tracker: reviewManager.snippets.offsetTracker,
            path: this.file.path,
          });
        }
        return;
      }

      // If document changed, update offsets in tracker
      if (update.docChanged) {
        // Every edit made in this editor moves the highlights, whoever made
        // it: typing, undo, and edits with no userEvent at all, such as
        // Obsidian's `editor.replaceRange` (how a card's embed goes in) and
        // other plugins'. Only a sync (see `isSync`) is left alone.
        if (!this.isReviewInterface && update.transactions.some(isSync)) {
          // Standard editor: cross-pane sync → reload from DB.
          // The other pane (which owns the edit) has already persisted.
          // Until the reload paints them anew, the painted ones move with the
          // text: left in the old document's positions, they could lie past
          // the new one's end, where CodeMirror throws on the next update.
          this.decorations = this.decorations.map(update.changes);
          void this.reloadHighlightsFromDB(update.view, reviewManager);
          return;
        }

        // A sync's offsets the shared tracker has already, from the editor
        // that made the edit (in review, that's the standard editor), so only
        // the edits made here are mapped, each from the document it was made
        // to, and the decorations are rebuilt from the tracker below.
        for (const tr of update.transactions) {
          if (!tr.docChanged || isSync(tr)) continue;
          const newBodyStart = Obsidian.getBodyStartOffset(
            tr.state.doc.toString()
          );
          // The ChangeSet correctly represents the transformation (or its
          // inverse for undo), so mapPos() handles everything - even when
          // Obsidian groups multiple edits into a single undo action.
          reviewManager.snippets.offsetTracker.updateOffsetsWithMapping(
            this.file.path,
            // Narrowed, or a highlight in a span replaced with itself (as
            // `editor.setValue` replaces the whole document) would collapse
            narrowChanges(tr.changes, tr.startState.doc),
            Obsidian.getBodyStartOffset(tr.startState.doc.toString()),
            newBodyStart,
            // Where only the text says where the edit was, it may have been
            // beside a highlight rather than at its edge, inside it
            narrowChanges(tr.changes, tr.startState.doc, 'earliest')
          );
          // Undo and redo then put back where the step found them
          for (const effect of tr.effects) {
            if (!effect.is(restoreHighlightsEffect)) continue;
            reviewManager.snippets.offsetTracker.restoreHighlights(
              this.file.path,
              effect.value.map(
                ([id, start, end]) =>
                  [id, start - newBodyStart, end - newBodyStart] as const
              )
            );
          }
        }

        // In regular Obsidian editor, we handle persistence here with debouncing.
        // In the review interface, ReviewItem.saveNote() handles persistence.
        if (!this.isReviewInterface) {
          const highlights = reviewManager.snippets.offsetTracker.getHighlights(
            this.file.path
          );
          this.schedulePersist(reviewManager, highlights);
        }
      }

      // Always rebuild decorations - the tracker data may have changed
      // (either from document edits above, or from external refresh after snippet creation)
      this.decorations = this.buildDecorations(
        update.view,
        reviewManager.snippets.offsetTracker,
        reviewManager
      );
      syncedStates.set(update.state, {
        tracker: reviewManager.snippets.offsetTracker,
        path: this.file.path,
      });
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
      if (this.destroyed) return;

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
      highlights: SnippetHighlight[]
    ) {
      if (this.persistTimeout) {
        window.clearTimeout(this.persistTimeout);
      }
      this.persistTimeout = window.setTimeout(() => {
        void this.persistHighlights(reviewManager, highlights);
      }, 2000); // 2 second debounce
    }

    private async persistHighlights(
      reviewManager: ReviewManager,
      highlights: SnippetHighlight[]
    ) {
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
      const builder = new RangeSetBuilder<Decoration>();

      // Sort highlights by start offset for RangeSetBuilder
      // (sort by absolute position for proper ordering)
      const sortedHighlights = [...highlights].sort(
        (a, b) => a.start_offset - b.start_offset
      );

      for (const highlight of sortedHighlights) {
        const range = tracker.shownRange(
          this.file.path,
          highlight,
          bodyStart,
          view.state.doc.length
        );
        if (!range) continue;

        const decoration = Decoration.mark({
          class: 'ir-snippet-highlight',
          attributes: {
            'data-snippet-id': highlight.id,
            'data-snippet-ref': highlight.reference,
          },
        });

        builder.add(...range, decoration);
      }

      return builder.finish();
    }

    destroy() {
      this.destroyed = true;
      if (this.highlightsChangedRef) {
        this.plugin?.app.workspace.offref(this.highlightsChangedRef);
        this.highlightsChangedRef = null;
      }

      if (this.persistTimeout) {
        window.clearTimeout(this.persistTimeout);
        this.persistTimeout = null;
      }
    }
  },
  {
    decorations: (v) => v.decorations,

    eventHandlers: {
      click: (event: MouseEvent, view: EditorView) => {
        const plugin = view.state.facet(irPluginFacet);
        if (!plugin) return false;
        return openHighlightFromEvent(plugin, event);
      },

      // A middle click never fires `click` — browsers emit `auxclick` for every
      // non-primary button — so it needs its own handler. Right-click emits
      // auxclick too, hence the button check: without it, opening the context
      // menu on a highlight would navigate away.
      auxclick: (event: MouseEvent, view: EditorView) => {
        if (event.button !== MIDDLE_MOUSE_BUTTON) return false;
        const plugin = view.state.facet(irPluginFacet);
        if (!plugin) return false;
        return openHighlightFromEvent(plugin, event);
      },

      // Middle-mousedown starts autoscroll on Windows and pastes the primary
      // selection on Linux. Claim it so the auxclick that follows is a clean
      // navigation rather than a navigation plus an unwanted default action.
      mousedown: (event: MouseEvent) => {
        if (event.button !== MIDDLE_MOUSE_BUTTON) return false;
        const target = event.target as HTMLElement | null;
        if (!target?.closest('.ir-snippet-highlight')) return false;
        event.preventDefault();
        return false;
      },
    },
  }
);
