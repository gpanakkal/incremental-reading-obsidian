import type IncrementalReadingPlugin from '#/main';
import type { Extension } from '@codemirror/state';
import { actionBarExtension } from './ActionBarExtension';
import { answerRevealExtension } from './AnswerRevealExtension';
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
export {
  answerRevealExtension,
  clearAnswerRevealEffect,
  findRevealedAnswerRange,
} from './AnswerRevealExtension';
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

    // Fading highlight on a card's answer at the moment it is revealed
    answerRevealExtension,

    // Action bar panel for IR notes
    actionBarExtension,
  ];

  return extensions;
}
