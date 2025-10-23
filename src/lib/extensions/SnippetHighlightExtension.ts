import { StateField, StateEffect, type Extension } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import type {
  SnippetHighlight,
  SnippetOffsetTracker,
} from '../SnippetOffsetTracker';
import type { App, TFile } from 'obsidian';

/**
 * CodeMirror 6 extension for rendering snippet highlights
 * Uses decorations to overlay highlights without modifying the document
 */

// Effect for adding highlights to the editor
const addHighlightsEffect = StateEffect.define<SnippetHighlight[]>();

// Effect for updating highlights after document changes
const updateHighlightsEffect = StateEffect.define<SnippetHighlight[]>();

/**
 * StateField that manages highlight decorations
 */
export const snippetHighlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },

  update(decorations, tr) {
    // Map existing decorations to new document positions
    decorations = decorations.map(tr.changes);

    // Handle effects
    for (const effect of tr.effects) {
      if (effect.is(addHighlightsEffect)) {
        // Add new highlights
        decorations = createDecorations(effect.value);
      } else if (effect.is(updateHighlightsEffect)) {
        // Replace all highlights with updated ones
        decorations = createDecorations(effect.value);
      }
    }

    return decorations;
  },

  provide: (f) => EditorView.decorations.from(f),
});

/**
 * Create decoration set from highlights
 * Filters out invalid offsets to prevent crashes
 */
function createDecorations(
  highlights: SnippetHighlight[],
  docLength?: number
): DecorationSet {
  const decorations = highlights
    .filter((highlight) => {
      const start = highlight.start_offset;
      const end = highlight.end_offset;

      // Validate offsets
      if (start < 0 || end < 0) {
        console.warn(
          `[SnippetHighlight] Skipping highlight with negative offsets:`,
          highlight
        );
        return false;
      }
      if (start > end) {
        console.warn(
          `[SnippetHighlight] Skipping highlight with start > end:`,
          highlight
        );
        return false;
      }
      if (docLength !== undefined && (start >= docLength || end > docLength)) {
        console.warn(
          `[SnippetHighlight] Skipping highlight out of range (doc length: ${docLength}):`,
          highlight
        );
        return false;
      }

      return true;
    })
    .map((highlight) => {
      const start = highlight.start_offset;
      const end = highlight.end_offset;

      return Decoration.mark({
        class: 'ir-snippet-highlight',
        attributes: {
          'data-snippet-id': highlight.id,
          'data-snippet-ref': highlight.reference,
        },
      }).range(start, end);
    });

  return Decoration.set(decorations, true);
}

/**
 * Configuration for the highlight extension
 */
export interface SnippetHighlightConfig {
  app: App;
  file: TFile;
  tracker: SnippetOffsetTracker;
  onHighlightClick?: (snippetId: string, snippetRef: string) => void;
}

/**
 * Create the complete snippet highlight extension
 * @param config Configuration object
 * @returns CodeMirror extension
 */
export function createSnippetHighlightExtension(
  config: SnippetHighlightConfig
): Extension {
  const { tracker, file, onHighlightClick } = config;

  // Load highlights for the current file
  const highlights = tracker.getHighlights(file.path);
  console.log(
    `[SnippetHighlightExtension] Creating extension with ${highlights.length} highlights for ${file.path}`,
    highlights
  );

  return [
    // Add the StateField
    snippetHighlightField.init((state) => {
      const docLength = state.doc.length;
      const decorations = createDecorations(highlights, docLength);
      console.log(
        `[SnippetHighlightExtension] Created decorations for ${highlights.length} highlights (doc length: ${docLength})`
      );
      return decorations;
    }),

    // Add ViewPlugin for handling clicks and document changes
    ViewPlugin.fromClass(
      class {
        constructor(private view: EditorView) {
          // Add click listener
          this.view.dom.addEventListener('click', this.handleClick);
        }

        update(update: ViewUpdate) {
          // If document changed, update offsets in tracker
          if (update.docChanged) {
            const changes = update.changes.desc.map((desc) => ({
              from: desc.from,
              to: desc.to,
              insert: update.state.doc.sliceString(desc.from, desc.to),
            }));

            tracker.updateOffsetsForChanges(file.path, changes as any);

            // Get updated highlights and dispatch effect
            const updatedHighlights = tracker.getHighlights(file.path);
            this.view.dispatch({
              effects: updateHighlightsEffect.of(updatedHighlights),
            });
          }
        }

        destroy() {
          // Clean up click listener
          this.view.dom.removeEventListener('click', this.handleClick);
        }

        private handleClick = (event: MouseEvent) => {
          event.preventDefault();
          const target = event.target as HTMLElement;
          console.log(`[SnippetHighlight] Click detected on:`, target);

          // Check if click is on a highlight
          const highlight = target.closest('.ir-snippet-highlight');
          console.log(
            `[SnippetHighlight] Closest highlight element:`,
            highlight
          );

          if (!highlight) {
            console.log(`[SnippetHighlight] Not a highlight click, ignoring`);
            return;
          }

          const snippetId = highlight.getAttribute('data-snippet-id');
          const snippetRef = highlight.getAttribute('data-snippet-ref');
          console.log(
            `[SnippetHighlight] Highlight attributes - id: ${snippetId}, ref: ${snippetRef}`
          );

          if (snippetId && snippetRef && onHighlightClick) {
            console.log(`[SnippetHighlight] Calling onHighlightClick callback`);
            event.preventDefault();
            event.stopPropagation();
            onHighlightClick(snippetId, snippetRef);
          } else {
            console.warn(
              `[SnippetHighlight] Missing data or callback - id: ${snippetId}, ref: ${snippetRef}, callback: ${!!onHighlightClick}`
            );
          }
        };
      }
    ),
  ];
}

/**
 * Helper to dispatch highlights to an existing editor
 * @param view The editor view
 * @param highlights The highlights to add
 */
export function setHighlights(
  view: EditorView,
  highlights: SnippetHighlight[]
) {
  view.dispatch({
    effects: addHighlightsEffect.of(highlights),
  });
}

/**
 * Refresh highlights for a file after creating a new snippet
 * @param view The editor view
 * @param tracker The offset tracker
 * @param file The file to refresh highlights for
 */
export function refreshHighlights(
  view: EditorView,
  tracker: SnippetOffsetTracker,
  file: TFile
) {
  const highlights = tracker.getHighlights(file.path);
  console.log(`[refreshHighlights] Refreshing ${highlights.length} highlights for ${file.path}`);
  view.dispatch({
    effects: updateHighlightsEffect.of(highlights),
  });
}
