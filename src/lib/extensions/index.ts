import type { Extension } from '@codemirror/state';
import { irPluginFacet } from './irPluginFacet';
import { scrollPositionExtension } from './ScrollPositionExtension';
import { snippetHighlightExtension } from './SnippetHighlightExtension';
import { actionBarExtension } from './ActionBarExtension';
import type IncrementalReadingPlugin from '#/main';

// Re-export for convenience
export { irPluginFacet } from './irPluginFacet';
export {
  isExternalSync,
  refreshHighlightsEffect,
} from './SnippetHighlightExtension';
export {
  setReviewModeEffect,
  setShowAnswerEffect,
  setReviewCallbacks,
  actionBarStateField,
  type ReviewCallbacks,
} from './ActionBarExtension';
export * from './utils';

/**
 * Creates the complete set of IR extensions for registration with Obsidian.
 *
 * Usage in main.ts:
 * ```ts
 * this.registerEditorExtension(createIRExtensions(this));
 * ```
 */
export function createIRExtensions(
  plugin: IncrementalReadingPlugin
): Extension {
  const extensions: Extension[] = [
    // Plugin access facet - must be first so other extensions can use it
    irPluginFacet.of(plugin),

    // Scroll position save/restore for IR notes
    scrollPositionExtension,

    // Snippet highlight decorations with click navigation
    snippetHighlightExtension,

    // Action bar panel for IR notes
    actionBarExtension,
  ];

  return extensions;
}
