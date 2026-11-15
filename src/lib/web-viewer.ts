import type { App, PaneType } from 'obsidian';

/**
 * What this plugin reads of Obsidian's Web viewer, the core plugin that opens
 * web pages in a tab on desktop. It has no public API: everything here is
 * undocumented internals, read from Obsidian's own bundle (`app.js` in
 * obsidian.asar; 1.13.7, 1.14.4 and 1.15.1 agree on all of it, but for what
 * the mobile app's `openUrl` does, see {@link WebViewerPlugin}). The view is
 * read through {@link WebViewerView} and checked at runtime; a view that does
 * not match is not taken for a web viewer, so the plugin behaves as it does
 * without one.
 */

/** The web viewer's view type (`webviewer`; undocumented). */
const WEB_VIEWER_VIEW_TYPE = 'webviewer';

/**
 * The parts of the web viewer's view read here (undocumented).
 *
 * - `getReaderModeContent()`: the page run through Readability, as Obsidian's
 *   own "Save to vault" and reader mode read it: `{ title, md }`, the title
 *   already made safe for a file name. Answers nothing when the page can't be
 *   read, having said why in a notice of its own.
 * - `url`: the address of the page shown.
 */
export interface WebViewerView {
  getViewType(): string;
  getReaderModeContent(): Promise<unknown>;
  url?: unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * `view` when it is a web viewer this plugin can read pages from, or null.
 * Never throws: a view whose members do is not one.
 */
export function asWebViewer(view: unknown): WebViewerView | null {
  try {
    if (
      isObject(view) &&
      typeof view.getViewType === 'function' &&
      (view.getViewType as () => unknown)() === WEB_VIEWER_VIEW_TYPE &&
      typeof view.getReaderModeContent === 'function'
    ) {
      return view as unknown as WebViewerView;
    }
  } catch {
    // Read as not a web viewer
  }
  return null;
}

/** A web page read as Markdown, to import as an article. */
export interface WebPage {
  /** Its title, as Obsidian made it safe for a file name. */
  title: string;
  markdown: string;
  /** Its address, or null when the view holds none. */
  url: string | null;
}

/**
 * The page `viewer` shows, as Markdown, at the address it had when asked.
 * Null when Obsidian can't read it, having said why itself.
 * @throws what reading the page throws, or when Obsidian answers in a shape
 *   this plugin doesn't know
 */
export async function readWebPage(
  viewer: WebViewerView
): Promise<WebPage | null> {
  // Read first: the view can move on to another page while Readability runs
  const url = viewer.url;
  const content = await viewer.getReaderModeContent();
  if (content === undefined) return null;
  if (
    !isObject(content) ||
    typeof content.title !== 'string' ||
    typeof content.md !== 'string'
  ) {
    throw new Error('Unexpected web viewer content');
  }
  return {
    title: content.title,
    markdown: content.md,
    url: typeof url === 'string' ? url : null,
  };
}

/**
 * The part of the web viewer core plugin's instance used here (undocumented).
 *
 * - `openUrl(url, newLeaf, active)`: the plugin's own way to open a page, in
 *   the leaf `Workspace.getLeaf(newLeaf)` picks, as its "Open in web viewer"
 *   link menu item and `web` CLI command do. On the mobile app (1.15.1) it
 *   picks no leaf: it hands an http(s) address to the in-app browser
 *   (Capacitor's `Browser.open`), which opens over the app and closes back to
 *   it, ignoring `newLeaf` and `active`, and answers any other address with a
 *   notice. The mobile app registers no `webviewer` view, so it never has a
 *   web viewer tab for {@link asWebViewer} to read.
 */
export interface WebViewerPlugin {
  openUrl(url: string, newLeaf: PaneType | boolean, active: boolean): void;
}

/**
 * The web viewer core plugin's instance, when it is enabled and opens pages
 * the way this plugin expects; else null. Through `app.internalPlugins`
 * (undocumented), which hands back the instance only while the plugin is on.
 * Never throws.
 */
export function enabledWebViewer(app: App): WebViewerPlugin | null {
  try {
    const plugin: unknown =
      app.internalPlugins.getEnabledPluginById('webviewer');
    if (isObject(plugin) && typeof plugin.openUrl === 'function') {
      return plugin as unknown as WebViewerPlugin;
    }
  } catch {
    // Read as off
  }
  return null;
}

/**
 * The web viewer, when it is the one to open a web page a link names: on,
 * and with its own "Open external links" option on, as when the user follows
 * a link to the page. Else null, the page then going to the system's
 * browser, as such a link's does. The same on the mobile app: 1.15 brought
 * the plugin there (see {@link WebViewerPlugin.openUrl} for what it does
 * with a page), and older mobile apps don't load it, so it reads as off.
 *
 * The option is `options.openExternalURLs` on the plugin's instance
 * (undocumented; on by default, and offered on the mobile app as on desktop,
 * read from obsidian.asar 1.13.7 and 1.15.1). Options it has not loaded yet
 * read as off. `openUrl` itself never reads the option, only Obsidian's
 * handling of a followed link does (1.15.1), so requiring it here is this
 * plugin's choice: Go to source goes where following a link to the page
 * would.
 */
export function linkWebViewer(app: App): WebViewerPlugin | null {
  const viewer = enabledWebViewer(app);
  if (!viewer) return null;
  const { options } = viewer as { options?: unknown };
  return isObject(options) && options.openExternalURLs === true ? viewer : null;
}
