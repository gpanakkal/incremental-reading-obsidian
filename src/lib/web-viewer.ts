/**
 * What this plugin reads of Obsidian's Web viewer, the core plugin that opens
 * web pages in a tab. It has no public API: everything here is undocumented
 * internals, read from Obsidian's own bundle (`app.js` in obsidian.asar;
 * 1.13.7 and 1.14.4 agree on all of it). The view is read through
 * {@link WebViewerView} and checked at runtime; a view that does not match is
 * not taken for a web viewer, so the plugin behaves as it does without one.
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
