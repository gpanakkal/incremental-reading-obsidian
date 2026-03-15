import type IncrementalReadingPlugin from '#/main';
import { Facet } from '@codemirror/state';

/**
 * Facet that marks a CodeMirror editor as belonging to the IR review interface.
 * Provided as `true` by IREditor via buildLocalExtensions(); standard Obsidian
 * editor panes never provide it, so it defaults to false.
 *
 * Using a facet (rather than checking getActiveViewOfType at construction time)
 * ensures the flag is stable and correct regardless of which pane has focus.
 */
export const isReviewInterfaceFacet = Facet.define<boolean, boolean>({
  combine: (values) => values[0] ?? false,
});

/**
 * Facet that provides access to the plugin instance from within CodeMirror extensions.
 *
 * Usage in extensions:
 * ```ts
 * const plugin = view.state.facet(irPluginFacet);
 * if (plugin) {
 *   // Access reviewManager, app, etc.
 * }
 * ```
 */
export const irPluginFacet = Facet.define<
  IncrementalReadingPlugin,
  IncrementalReadingPlugin | null
>({
  combine: (values) => values[0] ?? null,
});
