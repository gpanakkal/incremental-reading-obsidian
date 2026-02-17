import { Facet } from '@codemirror/state';
import type IncrementalReadingPlugin from '#/main';

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
