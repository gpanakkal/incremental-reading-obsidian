import type IncrementalReadingPlugin from '#/main';
import type { Extension } from '@codemirror/state';
import { actionBarExtension } from './ActionBarExtension';
import { irPluginFacet } from './irPluginFacet';
import { scrollPositionExtension } from './ScrollPositionExtension';
import { snippetHighlightExtension } from './SnippetHighlightExtension';

// Re-export for convenience
export {
  actionBarStateField,
  setReviewCallbacks,
  setReviewModeEffect,
  setShowAnswerEffect,
  type ReviewCallbacks,
} from './ActionBarExtension';
export { irPluginFacet, isReviewInterfaceFacet } from './irPluginFacet';
export {
  isExternalSync,
  refreshHighlightsEffect,
} from './SnippetHighlightExtension';

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
