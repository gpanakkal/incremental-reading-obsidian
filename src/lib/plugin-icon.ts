import { addIcon } from 'obsidian';
import { PLUGIN_ICON } from './constants';

/**
 * Lucide's open book with text lines, with Lucide's 8-spoke gear in the bottom-right
 * corner, drawn on Lucide's 24-unit grid.
 *
 * Obsidian's `getIcon` wraps `addIcon` markup in a bare
 * `<svg viewBox="0 0 100 100">` with no stroke attributes, unlike its Lucide
 * icons, which get a 24-unit viewBox, `stroke="currentColor"` and round
 * joins. The nested `<svg>` puts all of that back, so the drawing sits on the
 * same grid as its Lucide neighbours. It sets no `stroke-width`: Obsidian's
 * `svg.svg-icon { stroke-width: var(--icon-stroke) }` is inherited down to the
 * paths and read in their 24-unit space, exactly as it is for a Lucide icon,
 * so the weight follows the icon size tokens wherever the icon is shown.
 *
 * The gear sits at (19, 19), a unit further into the corner than Lucide's
 * other `-cog` icons put it (18, 18), so the book can keep its spine and the
 * left half of its bottom notch. At (18, 18) the spine runs into the gear's
 * left teeth, and carving the book back the usual ~8 units leaves a page and
 * a half that no longer reads as a book. The right page gives up its bottom
 * edge, its lower text line and the right half of the notch to the gear.
 */
const PLUGIN_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M22 12V4a1 1 0 0 0-1-1h-5a4 4 0 0 0-4 4 4 4 0 0 0-4-4H3a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h6a3 3 0 0 1 3 3"/>' +
  '<path d="M12 7v14"/>' +
  '<path d="M6 8h2"/>' +
  '<path d="M6 12h2"/>' +
  '<path d="M16 8h2"/>' +
  '<path d="m16.228 17.852-.923-.383"/>' +
  '<path d="m16.228 20.148-.923.383"/>' +
  '<path d="m17.47 15.305.382.923"/>' +
  '<path d="m17.852 21.772-.383.924"/>' +
  '<path d="m20.148 16.228.383-.923"/>' +
  '<path d="m20.53 22.696-.382-.924"/>' +
  '<path d="m21.772 17.852.924-.383"/>' +
  '<path d="m21.772 20.148.924.383"/>' +
  '<circle cx="19" cy="19" r="3"/>' +
  '</svg>';

/**
 * Registers the plugin's icon under {@link PLUGIN_ICON}. Call it at load,
 * before anything draws the icon: `setIcon` draws nothing for an id Obsidian
 * doesn't know yet. Registering again replaces the earlier copy, so a plugin
 * reload is harmless.
 */
export function registerPluginIcon(): void {
  addIcon(PLUGIN_ICON, PLUGIN_ICON_SVG);
}
