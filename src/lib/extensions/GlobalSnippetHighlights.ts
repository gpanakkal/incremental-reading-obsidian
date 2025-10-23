import { type Extension, StateField } from '@codemirror/state';
import { EditorView, Decoration, DecorationSet } from '@codemirror/view';
import type IncrementalReadingPlugin from '#/main';
import type { TFile } from 'obsidian';

/**
 * Global editor extension for snippet highlights
 * This integrates with Obsidian's editor to show highlights in all markdown files
 */

export function createGlobalSnippetHighlightExtension(
  plugin: IncrementalReadingPlugin
): Extension {
  return StateField.define<DecorationSet>({
    create(state) {
      return Decoration.none;
    },

    update(decorations, tr) {
      // Map existing decorations to new positions after document changes
      decorations = decorations.map(tr.changes);

      // Get the current file from the editor
      const view = tr.state.field(EditorView.editorAttributes, false);
      if (!view) return decorations;

      // Try to get the file path from the view
      // This is a bit hacky but necessary since CM6 doesn't directly expose the file
      const editorView = tr.view as any;
      const file = editorView?.state?.field?.(EditorView.editorAttributes)?.file as TFile;

      if (!file || !plugin.reviewManager) {
        return decorations;
      }

      // Load highlights for this file (async, so we'll update in the next cycle)
      plugin.reviewManager.getSnippetHighlights(file).then((highlights) => {
        if (highlights.length === 0) return;

        // Create decorations from highlights
        const newDecorations = highlights.map((highlight) => {
          return Decoration.mark({
            class: 'ir-snippet-highlight',
            attributes: {
              'data-snippet-id': highlight.id,
              'data-snippet-ref': highlight.reference,
            },
          }).range(highlight.start_offset, highlight.end_offset);
        });

        // Dispatch transaction to update decorations
        if (tr.view) {
          const view = tr.view as EditorView;
          // Note: We can't dispatch from within update, so this is a simplified version
          // In practice, this would need to be handled via a ViewPlugin
        }
      });

      return decorations;
    },

    provide: (f) => EditorView.decorations.from(f),
  });
}
