import { ViewPlugin } from '@codemirror/view';
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
 * The scroll position is stored as a body-relative value (excluding frontmatter).
 * In the standard note view (which shows frontmatter), we adjust by the frontmatter
 * widget height when saving/restoring.
 */
export const scrollPositionExtension = ViewPlugin.define(
  (view) => {
    let isRestoring = false;
    let scrollTimeout: number | undefined;
    let abortController: AbortController | null = null;
    let mutationObserver: MutationObserver | null = null;
    const propertiesLoadTimeoutMs = 300;

    const plugin = view.state.facet(irPluginFacet);
    const info = Obsidian.getFileInfoFromState(view.state);
    if (!info)
      return {
        destroy() {},
      };

    const { file, app } = info;
    if (!file)
      return {
        destroy() {},
      };

    // Early return if plugin/file not available or not an IR note
    if (!plugin || !file || !app || !Obsidian.getNoteType(file, app)) {
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

    /**
     * Get the height of the frontmatter/properties widget if visible.
     * Returns 0 if not present (e.g., in IREditor which hides frontmatter).
     */
    const getFrontmatterHeight = (): number => {
      const propertiesWidget = view.contentDOM.querySelector(
        '.metadata-container'
      );
      if (propertiesWidget) {
        return propertiesWidget.getBoundingClientRect().height;
      }
      return 0;
    };

    // Save scroll position handler
    // Subtracts frontmatter height so we store body-relative position
    const handleScroll = async () => {
      if (isRestoring) return;

      const info = Obsidian.getFileInfoFromState(view.state);
      if (!info || !info.file) return;

      const scroller = view.scrollDOM;
      const frontmatterHeight = getFrontmatterHeight();

      // Store body-relative scroll position (subtract frontmatter height)
      const bodyRelativeTop = Math.max(
        0,
        scroller.scrollTop - frontmatterHeight
      );
      const currentPos = {
        top: bodyRelativeTop,
        left: scroller.scrollLeft,
      };

      await reviewManager.saveScrollPosition(info.file, currentPos);
    };

    // Restore scroll position after properties widget has rendered
    // Adds frontmatter height to convert from body-relative to absolute position
    const restoreScrollPosition = async () => {
      const storedScrollPos = await reviewManager.loadScrollPosition(file);
      if (storedScrollPos) {
        isRestoring = true;
        const frontmatterHeight = getFrontmatterHeight();

        // Convert body-relative position to absolute (add frontmatter height)
        view.scrollDOM.scrollTo({
          top: storedScrollPos.top + frontmatterHeight,
          left: storedScrollPos.left,
          behavior: 'auto',
        });
        scrollTimeout = window.setTimeout(() => {
          isRestoring = false;
        }, 200);
      }
    };

    // Wait for the properties widget to be fully rendered before restoring scroll.
    // The properties widget is an embedded block (cm-embed-block) that renders
    // asynchronously after the initial document load.
    const waitForPropertiesAndRestore = () => {
      const contentDOM = view.contentDOM;

      // Check if properties widget already exists
      const propertiesWidget = contentDOM.querySelector('.metadata-container');
      if (propertiesWidget) {
        // Already rendered, restore immediately
        restoreScrollPosition();
        return;
      }

      // Use MutationObserver to detect when the properties widget appears
      let timeoutId: number | undefined;
      mutationObserver = new MutationObserver((_mutations, observer) => {
        const widget = contentDOM.querySelector('.metadata-container');
        if (widget) {
          observer.disconnect();
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          // Give the widget a moment to finish layout
          requestAnimationFrame(() => {
            restoreScrollPosition();
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
        restoreScrollPosition();
      }, propertiesLoadTimeoutMs);
    };

    // Start the scroll restoration process
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        waitForPropertiesAndRestore();

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
        mutationObserver?.disconnect();
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
