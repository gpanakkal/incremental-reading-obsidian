import { TRANSCLUSION_HIDE_TITLE_ALIAS } from '#/lib/constants';
import type IncrementalReadingPlugin from '#/main';

/**
 * Marks the block a title-hidden transclusion sits in, so `styles.css` can
 * style the host without a `:has()` parent selector.
 *
 * The CSS used to ask the question directly:
 *
 * ```css
 * :is(p, h1, …, li):has(> .internal-embed[alt*='ir-hide-title'])
 * ```
 *
 * which forces Blink to flag every paragraph, heading and list item in a
 * rendered note as "affected by :has" and recheck them on any child mutation.
 * The same question is cheap to answer once, here, at render time.
 *
 * Live Preview is not covered by this: there the host is a `.cm-line` that
 * CodeMirror owns, and the transclusion is a widget whose contents arrive
 * asynchronously. See the comment in `styles.css` on the one surviving
 * `:has()`.
 */

/** Block elements a transclusion can host, mirroring the old `:is(…)` list. */
const HOST_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI']);

/** The block directly contains at least one title-hidden transclusion. */
export const TRANSCLUSION_HOST_CLASS = 'ir-transclusion-host';

/**
 * ...and no transclusion in it starts on its own line, so the accent rule can
 * be painted on the host instead of per-fragment on the embed.
 */
export const TRANSCLUSION_RULE_CLASS = 'ir-transclusion-rule';

const EMBED_SELECTOR = `.internal-embed[alt*='${TRANSCLUSION_HIDE_TITLE_ALIAS}']`;

/**
 * Add the host marker classes to every qualifying block under `el`.
 *
 * Exported for testing; production callers go through
 * {@link registerTransclusionHostPostProcessor}.
 */
export function markTransclusionHosts(el: HTMLElement): void {
  // host -> whether any of its transclusions is pushed onto its own line by a
  // preceding <br>. Collected per host rather than per embed because the rule
  // it replaces was `:not(:has(> br + .internal-embed))` — a single own-line
  // transclusion suppresses the host rule for the whole block, even if a
  // sibling transclusion sits inline.
  const hosts = new Map<HTMLElement, boolean>();

  for (const embed of Array.from(
    el.querySelectorAll<HTMLElement>(EMBED_SELECTOR)
  )) {
    const host = embed.parentElement;
    if (!host || !HOST_TAGS.has(host.tagName)) continue;

    const startsOwnLine = embed.previousElementSibling?.tagName === 'BR';
    hosts.set(host, (hosts.get(host) ?? false) || startsOwnLine);
  }

  for (const [host, anyStartsOwnLine] of hosts) {
    host.classList.add(TRANSCLUSION_HOST_CLASS);
    if (!anyStartsOwnLine) host.classList.add(TRANSCLUSION_RULE_CLASS);
  }
}

/**
 * Registers the reading-mode post-processor that marks transclusion hosts.
 *
 * Runs on every rendered section, including the markdown ReviewView renders
 * and the contents of other embeds, since Obsidian post-processes those
 * through the same pipeline.
 */
export function registerTransclusionHostPostProcessor(
  plugin: IncrementalReadingPlugin
): void {
  plugin.registerMarkdownPostProcessor((el: HTMLElement) => {
    markTransclusionHosts(el);
  });
}
