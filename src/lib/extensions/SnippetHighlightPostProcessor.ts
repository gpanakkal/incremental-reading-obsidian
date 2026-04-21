import type IncrementalReadingPlugin from '#/main';
import {
  Component,
  MarkdownPreviewView,
  MarkdownView,
  type App,
  type MarkdownPostProcessorContext,
} from 'obsidian';
import { Markdown } from '../Markdown';
import { ObsidianHelpers } from '../ObsidianHelpers';
import type { SnippetHighlight } from '../SnippetOffsetTracker';

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
      const file = plugin.app.vault.getFileByPath(ctx.sourcePath);
      if (!file) return;

      const isSource = ObsidianHelpers.isSourceNote(file, plugin.app);
      const noteType = ObsidianHelpers.getNoteType(file, plugin.app);
      if (!(isSource || noteType === 'article' || noteType === 'snippet'))
        return;

      const reviewManager = plugin.reviewManager;
      if (!reviewManager) return;

      const sectionInfo = ctx.getSectionInfo(el);
      if (!sectionInfo) return;

      await reviewManager.getSnippetHighlights(file);
      const highlights = reviewManager.snippets.offsetTracker.getHighlights(
        file.path
      );
      if (highlights.length === 0) return;

      // Read the full file to resolve body-relative offsets
      const fileContent = await plugin.app.vault.cachedRead(file);
      const bodyStart = ObsidianHelpers.getBodyStartOffset(fileContent);
      const bodyText = sectionInfo.text.slice(bodyStart);

      // Compute the body-relative character offset of the start of this section
      const lines = fileContent.split('\n');
      let sectionAbsoluteStart = 0;
      for (let i = 0; i < sectionInfo.lineStart; i++) {
        sectionAbsoluteStart += (lines[i]?.length ?? 0) + 1; // +1 for '\n'
      }
      // character offset from the start of the body to this section
      const sectionBodyRelativeStart = sectionAbsoluteStart - bodyStart;
      // do nothing if we're not in the body section yet
      if (sectionBodyRelativeStart < 0) return;

      let sectionLength = 0;
      for (let i = sectionInfo.lineStart; i <= sectionInfo.lineEnd; i += 1) {
        sectionLength += lines[i].length;
      }
      const sectionBodyRelativeEnd = sectionBodyRelativeStart + sectionLength;
      // getSectionInfo().text returns raw Markdown for the entire file
      const beforeSectionText = bodyText.slice(0, sectionBodyRelativeStart);
      // get the raw markdown source for this block
      const sectionText = bodyText.slice(
        sectionBodyRelativeStart,
        sectionBodyRelativeStart + sectionLength
      );

      for (const highlight of highlights) {
        // Skip highlights that don't overlap this section
        if (highlight.end_offset <= sectionBodyRelativeStart) continue;
        if (highlight.start_offset >= sectionBodyRelativeEnd) continue;

        const {
          domSectionStart,
          domSectionEnd,
          domHighlightStart,
          domHighlightEnd,
        } = await getDomOffsets(
          plugin.app,
          beforeSectionText,
          sectionText,
          highlight
        );

        // These are relative to the section, so clamp them
        const domStart = Math.max(0, domHighlightStart - domSectionStart);
        const domEnd = Math.min(
          domSectionEnd,
          domHighlightEnd - domSectionStart
        );

        // const startOffsetText = sectionText.slice(0, srcStart);
        // const snippetText = sectionText.slice(srcStart, srcEnd);

        // console.debug({
        //   // startOffsetText,
        //   // snippetText,
        //   sectionBodyRelativeStart,
        //   highlightOffsetStart: highlight.start_offset,
        //   // srcStart,
        //   domStart,
        //   domEnd,
        //   domHighlightStart,
        //   domHighlightEnd,
        //   // startDiff,
        //   // endDiff,
        //   domSectionStart,
        //   domSectionEnd,
        //   offsetLength: highlight.end_offset - highlight.start_offset,
        //   // srcLength: srcEnd - srcStart,
        //   domLength: domEnd - domStart,
        // });
        if (domStart === undefined || domEnd === undefined) continue;
        if (domStart >= domEnd) continue;

        // Collect text nodes fresh for each highlight — surroundContents /
        // extractContents splits text nodes at range boundaries, which
        // invalidates any previously collected node array.
        const textNodes = collectTextNodes(el);
        if (textNodes.length === 0) continue;

        wrapDomRange(textNodes, domStart, domEnd, highlight);
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

/**
 * Convert raw text offsets to reading view-rendered equivalents
 */
export async function getDomOffsets(
  app: App,
  bodyPrevious: string,
  section: string,
  highlight: SnippetHighlight
): Promise<{
  domSectionStart: number;
  domSectionEnd: number;
  domHighlightStart: number;
  domHighlightEnd: number;
}> {
  // since highlights can span multiple sections, clamp to section bounds
  const [sectionHighlightStart, sectionHighlightEnd] = [
    Math.max(highlight.start_offset - bodyPrevious.length, 0),
    Math.min(highlight.end_offset - bodyPrevious.length, section.length),
  ];

  const sectionPrefix = section.slice(0, sectionHighlightStart);
  const highlightSlice = section.slice(
    sectionHighlightStart,
    sectionHighlightEnd
  );
  const sectionSuffix = section.slice(sectionHighlightEnd);
  const currentCounts = Markdown.countFootnoteRefs(highlightSlice);
  const footnoteRefNames = currentCounts.map((entry) => entry.name);
  // join using a unique separator so we can split later
  const separator = `${crypto.randomUUID()}`;
  let stringToRender = [
    bodyPrevious,
    sectionPrefix,
    highlightSlice,
    sectionSuffix,
  ].join(separator);

  // console.debug({ stringToRender });

  if (footnoteRefNames.length > 0) {
    const priorCounts = Markdown.countFootnoteRefs(bodyPrevious);

    // const pseudoPriorRefs = footnoteRefNames
    //   .map((name) => {
    //     if (!(name in priorCounts)) return '';
    //     return `[^${name}]`.repeat(priorCounts[name]);
    //   })
    //   .join(' ');

    const pseudoFootnotes = [
      ...priorCounts.map((entry) => entry.name),
      ...footnoteRefNames,
    ]
      .map((name) => `[^${name}]: --`)
      .join('\n\n');

    // console.debug({ pseudoFootnotes });
    stringToRender += separator + '\n\n' + pseudoFootnotes;
  }

  const component = new Component();
  const dummyElement = createEl('div');
  await MarkdownPreviewView.render(
    app,
    stringToRender,
    dummyElement,
    '',
    component
  );

  const renderedText = dummyElement.textContent;
  // console.debug({ renderedText });
  const sections = renderedText.split(separator);
  const [
    renderedBodyPrev,
    renderedSectionPrefix,
    renderedSnippet,
    renderedSectionSuffix,
  ] = sections;
  // console.debug({ beforeSnippet: renderedBodyPrev + renderedSectionPrefix });
  // console.debug('original snippet:', highlightSlice);
  // console.debug('rendered snippet:', renderedSnippet);
  // console.debug({ renderedSectionEnd: renderedSectionSuffix });

  const sectionStartDiff = bodyPrevious.length - renderedBodyPrev.length;
  const sectionPrefixDiff = sectionPrefix.length - renderedSectionPrefix.length;
  const domHighlightStart =
    highlight.start_offset - sectionStartDiff - sectionPrefixDiff;
  const domSectionStart = renderedBodyPrev.length;
  const domHighlightEnd =
    Math.max(domHighlightStart, domSectionStart) + renderedSnippet.length;
  const domSectionLength =
    renderedSectionPrefix.length +
    renderedSnippet.length +
    renderedSectionSuffix.length;
  const domSectionEnd = domSectionStart + domSectionLength;

  return {
    domSectionStart,
    domSectionEnd,
    domHighlightStart,
    domHighlightEnd,
  };
}

/** Collect all Text nodes in the current section */
function collectTextNodes(container: HTMLElement): Text[] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    nodes.push(node as Text);
  }
  return nodes;
}

/**
 * Wrap the DOM character range [domStart, domEnd) across the given text nodes
 * with a `<span class="ir-snippet-highlight">`.
 *
 * `domStart` and `domEnd` are offsets into the concatenated text content of
 * all text nodes (the same coordinate space produced by buildSourceToDomOffsetMap).
 */
function wrapDomRange(
  textNodes: Text[],
  domStart: number,
  domEnd: number,
  highlight: SnippetHighlight
): void {
  const startPos = findNodePosition(textNodes, domStart);
  const endPos = findNodePosition(textNodes, domEnd);
  if (!startPos || !endPos) return;

  try {
    const range = document.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);

    const span = document.createElement('span');
    span.className = 'ir-snippet-highlight';
    span.setAttribute('data-snippet-id', highlight.id);
    span.setAttribute('data-snippet-ref', highlight.reference);

    // surroundContents fails when the range partially spans element boundaries
    // (e.g. a highlight that starts inside a <strong> and ends after it).
    // The extract+append+insert fallback handles that correctly.
    try {
      range.surroundContents(span);
    } catch {
      const contents = range.extractContents();
      span.appendChild(contents);
      range.insertNode(span);
    }
  } catch {
    // Silently skip — DOM manipulation can fail in edge cases (read-only nodes,
    // detached trees, etc.) and we must not break the rendered view.
  }
}

interface NodePosition {
  node: Text;
  offset: number;
}

/**
 * Given an array of text nodes in document order and a flat character index
 * into their concatenated text content, return the node and offset within it.
 */
function findNodePosition(
  nodes: Text[],
  flatIndex: number
): NodePosition | null {
  let accumulated = 0;
  for (const node of nodes) {
    const len = node.textContent?.length ?? 0;
    if (flatIndex <= accumulated + len) {
      return { node, offset: flatIndex - accumulated };
    }
    accumulated += len;
  }
  return null;
}
