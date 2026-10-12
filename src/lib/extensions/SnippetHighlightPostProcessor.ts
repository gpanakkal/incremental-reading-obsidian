import { ObsidianHelpers } from '#/lib/ObsidianHelpers';
import {
  paintSectionHighlights,
  readingSection,
} from '#/lib/reading-highlights';
import type IncrementalReadingPlugin from '#/main';
import {
  Component,
  MarkdownRenderer,
  MarkdownView,
  type MarkdownPostProcessorContext,
} from 'obsidian';

/**
 * Registers a Markdown post-processor that injects snippet highlight spans
 * into reading-mode rendered HTML.
 *
 * The CodeMirror SnippetHighlightExtension handles editing mode (source /
 * live-preview). This post-processor covers the case where the user switches
 * a note to Reading view, where no CodeMirror editor exists.
 */
export function registerSnippetHighlightPostProcessor(
  plugin: IncrementalReadingPlugin
): void {
  plugin.registerMarkdownPostProcessor(
    async (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
      // Only a note's own sections have section info. Loose markdown has none,
      // including the render below, which runs this post-processor too.
      const sectionInfo = ctx.getSectionInfo(el);
      if (!sectionInfo) return;

      const file = plugin.app.vault.getFileByPath(ctx.sourcePath);
      if (!file) return;

      const isSource = ObsidianHelpers.isSourceNote(file, plugin.app);
      const noteType = await ObsidianHelpers.getNoteType(file, plugin.app);
      if (!(isSource || noteType === 'article' || noteType === 'snippet'))
        return;

      const reviewManager = plugin.reviewManager;
      if (!reviewManager) return;

      // The text this section was rendered from, frontmatter and all
      const { text, lineStart, lineEnd } = sectionInfo;
      const bodyStart = ObsidianHelpers.getBodyStartOffset(text);
      const section = readingSection(text, lineStart, lineEnd, bodyStart);
      if (!section) return;

      await reviewManager.getSnippetHighlights(file);
      const tracker = reviewManager.snippets.offsetTracker;
      // Those live preview shows, so the console hears of one past the
      // note's end here too. Painting cuts each to the section anyway, but
      // would paint one starting before the note from the section's start.
      const highlights = tracker
        .getHighlights(file.path)
        .filter((h) =>
          tracker.shownRange(file.path, h, bodyStart, text.length)
        );

      const component = new Component();
      component.load();
      try {
        await paintSectionHighlights(
          el,
          section,
          highlights,
          (markdown, into) =>
            MarkdownRenderer.render(
              plugin.app,
              markdown,
              into,
              ctx.sourcePath,
              component
            )
        );
      } finally {
        component.unload();
      }
    }
  );
}

export function registerHighlightRefreshListener(
  plugin: IncrementalReadingPlugin
): void {
  // Files whose highlights changed while in edit mode, pending a reading-mode render.
  const pendingRefresh = new Set<string>();

  plugin.registerEvent(
    plugin.app.workspace.on('ir-highlights-changed', (...args: unknown[]) => {
      const filePath = args[0] as string;
      // If already in preview, rerender immediately; otherwise queue for next mode switch.
      let rerenderred = false;
      plugin.app.workspace.iterateAllLeaves((leaf) => {
        if (!(leaf.view instanceof MarkdownView)) return;
        if (leaf.view.getMode() !== 'preview') return;
        if (leaf.view.file?.path !== filePath) return;
        leaf.view.previewMode.rerender(true);
        rerenderred = true;
      });
      if (!rerenderred) pendingRefresh.add(filePath);
    })
  );

  plugin.registerEvent(
    plugin.app.workspace.on('layout-change', () => {
      if (pendingRefresh.size === 0) return;
      plugin.app.workspace.iterateAllLeaves((leaf) => {
        if (!(leaf.view instanceof MarkdownView)) return;
        if (leaf.view.getMode() !== 'preview') return;
        const filePath = leaf.view.file?.path;
        if (!filePath || !pendingRefresh.has(filePath)) return;
        leaf.view.previewMode.rerender(true);
        pendingRefresh.delete(filePath);
      });
    })
  );
}
