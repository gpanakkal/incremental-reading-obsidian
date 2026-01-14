import { ViewPlugin, EditorView } from '@codemirror/view';
import { irPluginFacet } from './irPluginFacet';
import { getFileFromState, getAppFromState, isIRNote } from './utils';

/**
 * CodeMirror extension that saves and restores scroll position for IR notes.
 *
 * Behavior:
 * - On mount: Restores scroll position from frontmatter (if saved)
 * - On scroll: Saves position to frontmatter (debounced via scrollend event)
 * - Only activates for files with ir-* tags
 */
export const scrollPositionExtension = ViewPlugin.define(
  (view) => {
    let isRestoring = false;
    let scrollTimeout: number | undefined;
    let abortController: AbortController | null = null;

    const plugin = view.state.facet(irPluginFacet);
    const file = getFileFromState(view.state);
    const app = getAppFromState(view.state);

    // Early return if plugin/file not available or not an IR note
    if (!plugin || !file || !app || !isIRNote(app, file)) {
      return {
        destroy() {},
      };
    }

    const reviewManager = plugin.reviewManager;
    if (!reviewManager) {
      // ReviewManager not yet initialized - skip for now
      return {
        destroy() {},
      };
    }

    // Save scroll position handler
    const handleScroll = async () => {
      if (isRestoring) return;

      const currentFile = getFileFromState(view.state);
      if (!currentFile) return;

      const scroller = view.scrollDOM;
      const currentPos = {
        top: scroller.scrollTop,
        left: scroller.scrollLeft,
      };

      await reviewManager.saveScrollPosition(currentFile, currentPos);
    };

    // Restore scroll position on mount
    // Double requestAnimationFrame ensures DOM is fully updated
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const storedScrollPos = reviewManager.loadScrollPosition(file);
        if (storedScrollPos) {
          isRestoring = true;
          view.scrollDOM.scrollTo({
            top: storedScrollPos.top,
            left: storedScrollPos.left,
            behavior: 'auto',
          });
          scrollTimeout = window.setTimeout(() => {
            isRestoring = false;
          }, 200);
        }

        // Add scroll listener with AbortController for clean lifecycle
        abortController = new AbortController();
        view.scrollDOM.addEventListener('scrollend', handleScroll, {
          signal: abortController.signal,
        });
      });
    });

    return {
      destroy() {
        abortController?.abort();
        if (scrollTimeout !== undefined) {
          clearTimeout(scrollTimeout);
        }
      },
    };
  },
  {
    // No decorations or event handlers needed at the extension level
  }
);
