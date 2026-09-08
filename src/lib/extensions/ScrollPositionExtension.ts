import { EditorView, ViewPlugin } from '@codemirror/view';
import { ObsidianHelpers as Obsidian } from '../ObsidianHelpers';
import { irPluginFacet } from './irPluginFacet';

/**
 * CodeMirror extension that saves and restores scroll position for IR notes.
 *
 * Behavior:
 * - On mount: Restores scroll position from database (after properties widget renders)
 * - On scroll: Saves position to database (debounced via scrollend event)
 * - Only activates for files with ir-* tags
 *
 * The position is stored as a **document character offset** (the top-visible
 * position), not a pixel offset: a logical anchor survives viewport-width
 * changes (mobile <-> desktop), content re-layout, and the frontmatter widget,
 * all of which move a raw pixel value to the wrong place. Restore scrolls that
 * position to the top of the viewport via CodeMirror, which maps it through the
 * current layout and never scrolls past the end of the content.
 */
export const scrollPositionExtension = ViewPlugin.define(
  (view) => {
    let isRestoring = false;
    let scrollTimeout: number | undefined;
    let abortController: AbortController | null = null;
    let mutationObserver: MutationObserver | null = null;
    const propertiesLoadTimeoutMs = 300;

    const plugin = view.state.facet(irPluginFacet);
    const { info } = Obsidian.getFileInfoFromState(view.state);
    if (!info)
      return {
        destroy() {},
      };

    const { file, app } = info;

    if (!plugin || !file || !app) {
      return { destroy() {} };
    }

    // keep track of if the ViewPlugin was destroyed
    let destroyed = false;
    // Kick off async noteType check; initialise listeners only when confirmed IR note.
    void Obsidian.getNoteType(file, app).then((noteType) => {
      if (destroyed || !noteType) return;

      const reviewManager = plugin.reviewManager;
      if (!reviewManager) return;

      // Character offset of the document position at the top edge of the
      // viewport. `precise: false` makes posAtCoords clamp to the nearest
      // position (never null), so a point above or below the content resolves
      // to the document start or end rather than failing.
      const topVisibleOffset = (): number => {
        const rect = view.scrollDOM.getBoundingClientRect();
        return view.posAtCoords({ x: rect.left + 1, y: rect.top + 1 }, false);
      };

      // Save scroll position handler
      const handleScroll = () => {
        if (isRestoring) return;

        const { info } = Obsidian.getFileInfoFromState(view.state);
        if (!info || !info.file) return;

        void reviewManager.saveScrollPosition(info.file, topVisibleOffset());
      };

      // Restore scroll position after properties widget has rendered.
      const restoreScrollPosition = async () => {
        const offset = await reviewManager.loadScrollPosition(file);
        if (offset === null) return;

        isRestoring = true;
        // Clamp to the live document so a stale or externally-shortened note can
        // never scroll past its end into the trailing padding (no text on screen).
        const pos = Math.min(Math.max(0, offset), view.state.doc.length);
        view.dispatch({
          effects: EditorView.scrollIntoView(pos, { y: 'start' }),
        });
        scrollTimeout = window.setTimeout(() => {
          isRestoring = false;
        }, 200);
      };

      // Wait for the properties widget to be fully rendered before restoring
      // scroll. In a standard note pane the widget (cm-embed-block) renders
      // asynchronously after the initial load and inserts height above the body;
      // restoring before it lays out would leave the target position off the top
      // of the viewport. The IREditor hides frontmatter, so no widget appears and
      // the fallback timeout drives the restore.
      const waitForPropertiesAndRestore = async () => {
        const contentDOM = view.contentDOM;

        // Check if properties widget already exists
        const propertiesWidget = contentDOM.querySelector(
          '.metadata-container'
        );
        if (propertiesWidget) {
          // Already rendered, restore immediately
          await restoreScrollPosition();
          return;
        }

        // Use MutationObserver to detect when the properties widget appears
        let timeoutId: number;
        mutationObserver = new MutationObserver((_mutations, observer) => {
          const widget = contentDOM.querySelector('.metadata-container');
          if (widget) {
            observer.disconnect();
            window.clearTimeout(timeoutId);
            // Give the widget a moment to finish layout
            window.requestAnimationFrame(() => {
              void restoreScrollPosition();
            });
          }
        });

        mutationObserver.observe(contentDOM, {
          childList: true,
          subtree: true,
        });

        // Fallback: if no properties widget appears before timeout, restore anyway
        // (file might not have frontmatter, or we're in IREditor)
        timeoutId = window.setTimeout(() => {
          mutationObserver?.disconnect();
          void restoreScrollPosition();
        }, propertiesLoadTimeoutMs);
      };

      // Start the scroll restoration process
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          waitForPropertiesAndRestore()
            .then(() => {
              // Add scroll listener with AbortController for clean lifecycle
              abortController = new AbortController();
              view.scrollDOM.addEventListener('scrollend', handleScroll, {
                signal: abortController.signal,
              });
            })
            .catch(() => {});
        });
      });
    });

    return {
      destroy() {
        destroyed = true;
        abortController?.abort();
        mutationObserver?.disconnect();
        if (scrollTimeout !== undefined) {
          window.clearTimeout(scrollTimeout);
        }
      },
    };
  },
  {
    // No decorations or event handlers needed at the extension level
  }
);
