// @vitest-environment jsdom

// The Obsidian DOM globals this module needs (`createDiv`, `createSpan`)
// are installed by src/test/obsidian-globals.setup.ts via setupFiles.

import { ObsidianHelpers } from '#/lib/ObsidianHelpers';
import {
  SnippetOffsetTracker,
  type SnippetHighlight,
} from '#/lib/SnippetOffsetTracker';
import {
  registerHighlightRefreshListener,
  registerSnippetHighlightPostProcessor,
} from '#/lib/extensions/SnippetHighlightPostProcessor';
import { RERENDERING_CLASS } from '#/lib/preview-rerender';
import type { NoteType } from '#/lib/types';
import fc from 'fast-check';
import { Component, MarkdownRenderer, MarkdownView } from 'obsidian';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

// #region HELPERS

function makeHighlight(
  overrides: Partial<SnippetHighlight> = {}
): SnippetHighlight {
  return {
    id: 'snippet-1',
    type: 'snippet',
    reference: 'snippets/a.md',
    due: null,
    due_fuzz: null,
    interval: 1,
    dismissed: false,
    deleted: false,
    priority: 50,
    parent: 'articles/parent.md',
    start_offset: 0,
    end_offset: 10,
    scroll_top: 0,
    ...overrides,
  };
}

type PostProcessor = (
  el: HTMLElement,
  ctx: {
    sourcePath: string;
    getSectionInfo: (
      el: HTMLElement
    ) => { text: string; lineStart: number; lineEnd: number } | null;
  }
) => Promise<void>;

/**
 * Register the post-processor on a plugin holding `highlights` for a note at
 * `notes/a.md` of type `noteType`, and return it with the plugin's spies.
 */
function setUp({
  highlights = [makeHighlight()],
  noteType = 'article' as NoteType | null,
  isSource = false,
  file = { path: 'notes/a.md' } as { path: string } | null,
  withReviewManager = true,
} = {}) {
  vi.spyOn(ObsidianHelpers, 'isSourceNote').mockReturnValue(isSource);
  const getNoteType = vi
    .spyOn(ObsidianHelpers, 'getNoteType')
    .mockResolvedValue(noteType);
  const offsetTracker = new SnippetOffsetTracker();
  const getHighlights = vi
    .spyOn(offsetTracker, 'getHighlights')
    .mockReturnValue(highlights);
  const reviewManager = {
    getSnippetHighlights: vi.fn().mockResolvedValue(undefined),
    snippets: { offsetTracker },
  };
  const plugin = {
    registerMarkdownPostProcessor: vi.fn(),
    app: { vault: { getFileByPath: vi.fn().mockReturnValue(file) } },
    reviewManager: withReviewManager ? reviewManager : null,
  };
  registerSnippetHighlightPostProcessor(plugin as never);
  const processor = plugin.registerMarkdownPostProcessor.mock
    .calls[0][0] as PostProcessor;
  return { plugin, reviewManager, processor, getNoteType, getHighlights };
}

/** Paragraph sections' elements, as reading mode renders `text`'s lines. */
function paragraphEl(line: string): HTMLElement {
  const el = document.createElement('div');
  const p = document.createElement('p');
  p.textContent = line;
  el.appendChild(p);
  return el;
}

/** The text each highlight paints in `el`, by snippet id. */
function painted(el: HTMLElement): Record<string, string> {
  const result: Record<string, string> = {};
  for (const span of el.querySelectorAll('.ir-snippet-highlight')) {
    const id = span.getAttribute('data-snippet-id') ?? '';
    result[id] = (result[id] ?? '') + span.textContent;
  }
  return result;
}

const FRONTMATTER = '---\ntags:\n  - ir-article\n---\n';

/** A paragraph of plain words, which reading mode shows as typed. */
const wordArb = fc.stringMatching(/^[a-z]{1,6}$/);
const paragraphArb = fc
  .array(wordArb, { minLength: 1, maxLength: 5 })
  .map((words) => words.join(' '));
// #endregion

// ---------------------------------------------------------------------------
// registerSnippetHighlightPostProcessor
// ---------------------------------------------------------------------------
describe('registerSnippetHighlightPostProcessor', () => {
  let render: MockInstance<typeof MarkdownRenderer.render>;
  beforeEach(() => {
    render = vi.spyOn(MarkdownRenderer, 'render');
  });
  afterEach(() => vi.restoreAllMocks());

  it('registers one post-processor', () => {
    const { plugin } = setUp();
    expect(plugin.registerMarkdownPostProcessor).toHaveBeenCalledOnce();
  });

  it('paints a highlight on its text in a body section', async () => {
    // Lines: frontmatter 0-3, "# Title" 4, "" 5, paragraph 6
    const paragraph = 'Some words to highlight here';
    const text = `${FRONTMATTER}# Title\n\n${paragraph}\n`;
    const start = '# Title\n\nSome '.length;
    const { processor } = setUp({
      highlights: [
        makeHighlight({ start_offset: start, end_offset: start + 5 }),
      ],
    });
    const el = paragraphEl(paragraph);
    await processor(el, {
      sourcePath: 'notes/a.md',
      getSectionInfo: () => ({ text, lineStart: 6, lineEnd: 6 }),
    });
    expect(painted(el)).toEqual({ 'snippet-1': 'words' });
  });

  it('paints the end of a multi-line section', async () => {
    const lines = ['first line', 'second line', 'third line'];
    const text = `${FRONTMATTER}${lines.join('\n')}`;
    const end = lines.join('\n').length;
    const { processor } = setUp({
      highlights: [makeHighlight({ start_offset: end - 4, end_offset: end })],
    });
    const el = paragraphEl(lines.join('\n'));
    await processor(el, {
      sourcePath: 'notes/a.md',
      getSectionInfo: () => ({ text, lineStart: 4, lineEnd: 6 }),
    });
    expect(painted(el)).toEqual({ 'snippet-1': 'line' });
  });

  it('paints any paragraph section on the text its highlight covers', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.array(paragraphArb, { minLength: 1, maxLength: 4 }),
        fc.nat(),
        fc.nat(),
        fc.nat(),
        async (withFrontmatter, paragraphs, rawIndex, rawA, rawB) => {
          const body = paragraphs.join('\n\n');
          const text = (withFrontmatter ? FRONTMATTER : '') + body;
          const index = rawIndex % paragraphs.length;
          const paragraph = paragraphs[index];
          const a = rawA % (paragraph.length + 1);
          const b = rawB % (paragraph.length + 1);
          const [from, to] = [Math.min(a, b), Math.max(a, b)];
          const paragraphStart = paragraphs
            .slice(0, index)
            .reduce((sum, p) => sum + p.length + 2, 0);
          const { processor } = setUp({
            highlights: [
              makeHighlight({
                start_offset: paragraphStart + from,
                end_offset: paragraphStart + to,
              }),
            ],
          });
          const line = (withFrontmatter ? 4 : 0) + 2 * index;
          const el = paragraphEl(paragraph);
          await processor(el, {
            sourcePath: 'notes/a.md',
            getSectionInfo: () => ({ text, lineStart: line, lineEnd: line }),
          });
          expect(painted(el)['snippet-1'] ?? '').toBe(
            paragraph.slice(from, to)
          );
        }
      )
    );
  });

  it('paints any stored offsets on their part in the note, whatever their order or range', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.array(paragraphArb, { minLength: 1, maxLength: 4 }),
        fc.nat(),
        fc.array(
          fc.tuple(
            fc.integer({ min: -40, max: 80 }),
            fc.integer({ min: -40, max: 80 })
          ),
          { minLength: 1, maxLength: 4 }
        ),
        async (withFrontmatter, paragraphs, rawIndex, offsets) => {
          const body = paragraphs.join('\n\n');
          const bodyStart = withFrontmatter ? FRONTMATTER.length : 0;
          const text = (withFrontmatter ? FRONTMATTER : '') + body;
          const index = rawIndex % paragraphs.length;
          const paragraph = paragraphs[index];
          const paragraphStart = paragraphs
            .slice(0, index)
            .reduce((sum, p) => sum + p.length + 2, 0);
          const { processor } = setUp({
            highlights: offsets.map(([start, end], i) =>
              makeHighlight({
                id: `${i}`,
                start_offset: start,
                end_offset: end,
              })
            ),
          });
          const line = (withFrontmatter ? 4 : 0) + 2 * index;
          const el = paragraphEl(paragraph);
          await processor(el, {
            sourcePath: 'notes/a.md',
            getSectionInfo: () => ({ text, lineStart: line, lineEnd: line }),
          });
          const result = painted(el);
          offsets.forEach(([start, end], i) => {
            // In the note: from its start, if that's in it, to the end
            const shown =
              start >= -bodyStart && start < Math.min(end, body.length);
            const at = (offset: number) =>
              Math.min(Math.max(offset - paragraphStart, 0), paragraph.length);
            expect(result[`${i}`] ?? '').toBe(
              shown
                ? paragraph.slice(at(start), at(Math.min(end, body.length)))
                : ''
            );
          });
        }
      ),
      { numRuns: 300 }
    );
  });

  it('renders with the note as source path and a component it unloads after', async () => {
    const load = vi.spyOn(Component.prototype, 'load');
    const unload = vi.spyOn(Component.prototype, 'unload');
    const text = 'Some words here';
    const { plugin, processor } = setUp({
      highlights: [makeHighlight({ start_offset: 0, end_offset: 4 })],
    });
    render.mockImplementation(async (_app, markdown, into) => {
      expect(load).toHaveBeenCalledOnce();
      expect(unload).not.toHaveBeenCalled();
      into.textContent = markdown;
    });
    await processor(paragraphEl(text), {
      sourcePath: 'notes/a.md',
      getSectionInfo: () => ({ text, lineStart: 0, lineEnd: 0 }),
    });
    expect(render).toHaveBeenCalledOnce();
    expect(render.mock.calls[0][0]).toBe(plugin.app);
    expect(render.mock.calls[0][3]).toBe('notes/a.md');
    expect(render.mock.calls[0][4]).toBe(load.mock.contexts[0]);
    expect(unload.mock.contexts).toEqual(load.mock.contexts);
  });

  it('unloads the component when the render fails', async () => {
    const unload = vi.spyOn(Component.prototype, 'unload');
    const text = 'Some words here';
    const { processor } = setUp({
      highlights: [makeHighlight({ start_offset: 0, end_offset: 4 })],
    });
    render.mockRejectedValue(new Error('render failed'));
    await expect(
      processor(paragraphEl(text), {
        sourcePath: 'notes/a.md',
        getSectionInfo: () => ({ text, lineStart: 0, lineEnd: 0 }),
      })
    ).rejects.toThrow('render failed');
    expect(unload).toHaveBeenCalledOnce();
  });

  it('reads nothing for markdown that is not a section of a note', async () => {
    const { plugin, processor, getNoteType } = setUp();
    await processor(paragraphEl('loose markdown'), {
      sourcePath: 'notes/a.md',
      getSectionInfo: () => null,
    });
    expect(plugin.app.vault.getFileByPath).not.toHaveBeenCalled();
    expect(getNoteType).not.toHaveBeenCalled();
  });

  it.each([
    ['there is no such note', { file: null }],
    ['the note is a card', { noteType: 'card' as NoteType }],
    ['the note has no item type', { noteType: null }],
    ['the review manager is not ready', { withReviewManager: false }],
  ])('paints nothing when %s', async (_, options) => {
    const text = 'Some words here';
    const { reviewManager, processor } = setUp({
      highlights: [makeHighlight({ start_offset: 0, end_offset: 4 })],
      ...options,
    });
    const el = paragraphEl(text);
    await processor(el, {
      sourcePath: 'notes/a.md',
      getSectionInfo: () => ({ text, lineStart: 0, lineEnd: 0 }),
    });
    expect(painted(el)).toEqual({});
    expect(reviewManager.getSnippetHighlights).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it.each([
    ['an article', { noteType: 'article' as NoteType }],
    ['a snippet', { noteType: 'snippet' as NoteType }],
    ['a source note', { noteType: null, isSource: true }],
  ])('paints the highlights of %s', async (_, options) => {
    const text = 'Some words here';
    const { reviewManager, processor, getHighlights } = setUp({
      highlights: [makeHighlight({ start_offset: 0, end_offset: 4 })],
      ...options,
    });
    const el = paragraphEl(text);
    await processor(el, {
      sourcePath: 'notes/a.md',
      getSectionInfo: () => ({ text, lineStart: 0, lineEnd: 0 }),
    });
    expect(reviewManager.getSnippetHighlights).toHaveBeenCalledWith({
      path: 'notes/a.md',
    });
    expect(getHighlights).toHaveBeenCalledWith('notes/a.md');
    expect(painted(el)).toEqual({ 'snippet-1': 'Some' });
  });

  it('paints a highlight running past the note’s end up to it, none wholly past it, and warns once of each', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const text = `${FRONTMATTER}Some words`;
    const { processor } = setUp({
      highlights: [
        makeHighlight({
          id: 'live',
          reference: 'snippets/live.md',
          start_offset: 0,
          end_offset: 4,
        }),
        makeHighlight({
          id: 'over',
          reference: 'snippets/over.md',
          start_offset: 5,
          end_offset: 30,
        }),
        makeHighlight({
          id: 'stale',
          reference: 'snippets/stale.md',
          start_offset: 40,
          end_offset: 50,
        }),
      ],
    });
    const els = [paragraphEl('Some words'), paragraphEl('Some words')];
    for (const el of els) {
      await processor(el, {
        sourcePath: 'notes/a.md',
        getSectionInfo: () => ({ text, lineStart: 4, lineEnd: 4 }),
      });
    }

    for (const el of els) {
      expect(painted(el)).toEqual({ live: 'Some', over: 'words' });
    }
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
      expect.stringContaining('"snippets/over.md"'),
      expect.stringContaining('"snippets/stale.md"'),
    ]);
  });

  it('paints nothing in the frontmatter', async () => {
    const text = `${FRONTMATTER}Body text`;
    const { reviewManager, processor } = setUp({
      highlights: [makeHighlight({ start_offset: 0, end_offset: 4 })],
    });
    const el = paragraphEl('tags: - ir-article');
    await processor(el, {
      sourcePath: 'notes/a.md',
      getSectionInfo: () => ({ text, lineStart: 0, lineEnd: 3 }),
    });
    expect(painted(el)).toEqual({});
    expect(reviewManager.getSnippetHighlights).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// registerHighlightRefreshListener
// ---------------------------------------------------------------------------
describe('registerHighlightRefreshListener', () => {
  afterEach(() => vi.restoreAllMocks());

  function makePlugin(
    overrides: {
      eventHandlers?: Map<string, ((...args: unknown[]) => void)[]>;
      leaves?: Array<{
        view: {
          constructor: unknown;
          getMode?: () => string;
          file?: { path: string } | null;
          previewMode?: {
            rerender: ReturnType<typeof vi.fn>;
            containerEl: HTMLElement;
          };
        };
      }>;
    } = {}
  ) {
    const eventHandlers: Map<string, ((...args: unknown[]) => void)[]> =
      overrides.eventHandlers ?? new Map();
    const leaves = overrides.leaves ?? [];

    return {
      registerEvent: vi.fn(),
      registerMarkdownPostProcessor: vi.fn(),
      app: {
        workspace: {
          on: vi
            .fn()
            .mockImplementation(
              (event: string, handler: (...args: unknown[]) => void) => {
                if (!eventHandlers.has(event)) eventHandlers.set(event, []);
                eventHandlers.get(event)!.push(handler);
                return { event, handler };
              }
            ),
          iterateAllLeaves: vi
            .fn()
            .mockImplementation(
              (cb: (leaf: (typeof leaves)[number]) => void) => {
                for (const leaf of leaves) cb(leaf);
              }
            ),
        },
      },
      reviewManager: undefined,
      _handlers: eventHandlers,
    };
  }

  it('registers exactly two events: ir-highlights-changed and layout-change', () => {
    const plugin = makePlugin();
    registerHighlightRefreshListener(plugin as never);

    expect(plugin.app.workspace.on).toHaveBeenCalledTimes(2);
    const calls = (plugin.app.workspace.on as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown][];
    const events = calls.map(([e]) => e);
    expect(events).toContain('ir-highlights-changed');
    expect(events).toContain('layout-change');
  });

  it('calls plugin.registerEvent for each workspace.on call', () => {
    const plugin = makePlugin();
    registerHighlightRefreshListener(plugin as never);
    expect(plugin.registerEvent).toHaveBeenCalledTimes(2);
  });

  it('rerenders immediately when a matching preview leaf is open on ir-highlights-changed', () => {
    const rerender = vi.fn();
    const leaf = {
      view: Object.assign(Object.create(MarkdownView.prototype), {
        getMode: () => 'preview',
        file: { path: 'notes/article.md' },
        previewMode: { rerender, containerEl: document.createElement('div') },
      }),
    };

    const handlers: Map<string, ((...args: unknown[]) => void)[]> = new Map();
    const plugin = makePlugin({ eventHandlers: handlers, leaves: [leaf] });
    registerHighlightRefreshListener(plugin as never);

    const highlightsChanged = handlers.get('ir-highlights-changed')![0];
    highlightsChanged('notes/article.md');

    expect(rerender).toHaveBeenCalledWith(true);
  });

  it('re-renders with scroll anchoring off, on either path', () => {
    vi.useFakeTimers();
    try {
      const makeLeaf = () => {
        const containerEl = document.createElement('div');
        const scroller = containerEl.createDiv('markdown-preview-view');
        const anchoring: string[] = [];
        const rerender = vi.fn(() => anchoring.push(scroller.className));
        let mode: 'source' | 'preview' = 'source';
        const leaf = {
          view: Object.assign(
            Object.create(MarkdownView.prototype) as MarkdownView,
            {
              getMode: () => mode,
              file: { path: 'notes/article.md' },
              previewMode: { rerender, containerEl },
              register: vi.fn(),
            }
          ),
        };
        const setMode = (to: typeof mode) => {
          mode = to;
        };
        return { leaf, anchoring, setMode };
      };
      const queued = makeLeaf();
      const open = makeLeaf();
      open.setMode('preview');
      const handlers: Map<string, ((...args: unknown[]) => void)[]> = new Map();
      const plugin = makePlugin({
        eventHandlers: handlers,
        leaves: [queued.leaf, open.leaf],
      });
      registerHighlightRefreshListener(plugin as never);

      handlers.get('ir-highlights-changed')![0]('notes/article.md');
      expect(open.anchoring).toEqual([
        'markdown-preview-view ' + RERENDERING_CLASS,
      ]);
      expect(queued.anchoring).toEqual([]);

      // Queued only when no tab shows it in reading view
      open.setMode('source');
      handlers.get('ir-highlights-changed')![0]('notes/article.md');
      queued.setMode('preview');
      handlers.get('layout-change')![0]();
      expect(queued.anchoring).toEqual([
        'markdown-preview-view ' + RERENDERING_CLASS,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not rerender when leaf is not in preview mode', async () => {
    const rerender = vi.fn();
    const { MarkdownView } = await import('obsidian');
    const leaf = {
      view: Object.assign(Object.create(MarkdownView.prototype), {
        getMode: () => 'source',
        file: { path: 'notes/article.md' },
        previewMode: { rerender, containerEl: document.createElement('div') },
      }),
    };

    const handlers: Map<string, ((...args: unknown[]) => void)[]> = new Map();
    const plugin = makePlugin({ eventHandlers: handlers, leaves: [leaf] });
    registerHighlightRefreshListener(plugin as never);

    handlers.get('ir-highlights-changed')![0]('notes/article.md');

    expect(rerender).not.toHaveBeenCalled();
  });

  it('does not rerender when leaf file path does not match', async () => {
    const rerender = vi.fn();
    const { MarkdownView } = await import('obsidian');
    const leaf = {
      view: Object.assign(Object.create(MarkdownView.prototype), {
        getMode: () => 'preview',
        file: { path: 'notes/other.md' },
        previewMode: { rerender, containerEl: document.createElement('div') },
      }),
    };

    const handlers: Map<string, ((...args: unknown[]) => void)[]> = new Map();
    const plugin = makePlugin({ eventHandlers: handlers, leaves: [leaf] });
    registerHighlightRefreshListener(plugin as never);

    handlers.get('ir-highlights-changed')![0]('notes/article.md');

    expect(rerender).not.toHaveBeenCalled();
  });

  it('queues path for later if no matching preview leaf was found', async () => {
    const rerender = vi.fn();
    const { MarkdownView } = await import('obsidian');
    const leaf = {
      view: Object.assign(Object.create(MarkdownView.prototype), {
        getMode: () => 'preview',
        file: { path: 'notes/article.md' },
        previewMode: { rerender, containerEl: document.createElement('div') },
      }),
    };

    const handlers: Map<string, ((...args: unknown[]) => void)[]> = new Map();
    // Initially no leaves → queues the path
    const plugin = makePlugin({ eventHandlers: handlers, leaves: [] });
    registerHighlightRefreshListener(plugin as never);

    handlers.get('ir-highlights-changed')![0]('notes/article.md');
    expect(rerender).not.toHaveBeenCalled();

    // Now add the leaf and fire layout-change
    (
      plugin.app.workspace.iterateAllLeaves as ReturnType<typeof vi.fn>
    ).mockImplementation((cb: (leaf: unknown) => void) => cb(leaf));
    handlers.get('layout-change')![0]();

    expect(rerender).toHaveBeenCalledWith(true);
  });

  it('layout-change is a no-op when the pending set is empty', () => {
    const handlers: Map<string, ((...args: unknown[]) => void)[]> = new Map();
    const plugin = makePlugin({ eventHandlers: handlers });
    registerHighlightRefreshListener(plugin as never);

    // Should not throw and should not iterate leaves
    handlers.get('layout-change')![0]();
    expect(plugin.app.workspace.iterateAllLeaves).not.toHaveBeenCalled();
  });

  it('removes path from pending set after layout-change rerender', async () => {
    const rerender = vi.fn();
    const { MarkdownView } = await import('obsidian');
    const leaf = {
      view: Object.assign(Object.create(MarkdownView.prototype), {
        getMode: () => 'preview',
        file: { path: 'notes/article.md' },
        previewMode: { rerender, containerEl: document.createElement('div') },
      }),
    };

    const handlers: Map<string, ((...args: unknown[]) => void)[]> = new Map();
    const plugin = makePlugin({ eventHandlers: handlers, leaves: [] });
    registerHighlightRefreshListener(plugin as never);

    handlers.get('ir-highlights-changed')![0]('notes/article.md');

    (
      plugin.app.workspace.iterateAllLeaves as ReturnType<typeof vi.fn>
    ).mockImplementation((cb: (leaf: unknown) => void) => cb(leaf));

    // First layout-change: rerenders and removes from pending
    handlers.get('layout-change')![0]();
    expect(rerender).toHaveBeenCalledTimes(1);

    // Second layout-change: pending set is empty, iterateAllLeaves is not called again
    const iterateCalls = (
      plugin.app.workspace.iterateAllLeaves as ReturnType<typeof vi.fn>
    ).mock.calls.length;
    handlers.get('layout-change')![0]();
    expect(
      (plugin.app.workspace.iterateAllLeaves as ReturnType<typeof vi.fn>).mock
        .calls.length
    ).toBe(iterateCalls); // no new calls
  });

  it('does not rerender when leaf view is not a MarkdownView instance', async () => {
    const rerender = vi.fn();
    const leaf = {
      view: {
        // Plain object, NOT instanceof MarkdownView
        getMode: () => 'preview',
        file: { path: 'notes/article.md' },
        previewMode: { rerender, containerEl: document.createElement('div') },
      },
    };

    const handlers: Map<string, ((...args: unknown[]) => void)[]> = new Map();
    const plugin = makePlugin({
      eventHandlers: handlers,
      leaves: [leaf as never],
    });
    registerHighlightRefreshListener(plugin as never);

    handlers.get('ir-highlights-changed')![0]('notes/article.md');
    expect(rerender).not.toHaveBeenCalled();
  });

  it('does not rerender when leaf.view.file is null', async () => {
    const rerender = vi.fn();
    const { MarkdownView } = await import('obsidian');
    const leaf = {
      view: Object.assign(Object.create(MarkdownView.prototype), {
        getMode: () => 'preview',
        file: null,
        previewMode: { rerender, containerEl: document.createElement('div') },
      }),
    };

    const handlers: Map<string, ((...args: unknown[]) => void)[]> = new Map();
    const plugin = makePlugin({ eventHandlers: handlers, leaves: [leaf] });
    registerHighlightRefreshListener(plugin as never);

    handlers.get('layout-change')![0]();
    expect(rerender).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// registerHighlightRefreshListener — mutant-killing tests
// ---------------------------------------------------------------------------
describe('registerHighlightRefreshListener — mutant coverage', () => {
  afterEach(() => vi.restoreAllMocks());

  function makePlugin2(leaves: Array<{ view: unknown }> = []) {
    const handlers: Map<string, ((...args: unknown[]) => void)[]> = new Map();
    return {
      plugin: {
        registerEvent: vi.fn(),
        app: {
          workspace: {
            on: vi
              .fn()
              .mockImplementation(
                (event: string, handler: (...args: unknown[]) => void) => {
                  if (!handlers.has(event)) handlers.set(event, []);
                  handlers.get(event)!.push(handler);
                  return { event, handler };
                }
              ),
            iterateAllLeaves: vi
              .fn()
              .mockImplementation((cb: (leaf: unknown) => void) => {
                for (const l of leaves) cb(l);
              }),
          },
        },
      },
      handlers,
    };
  }

  it('does not add to pendingRefresh when rerender was called (rerenderred=true gates the add)', () => {
    const rerender = vi.fn();
    const leaf = {
      view: Object.assign(Object.create(MarkdownView.prototype), {
        getMode: () => 'preview',
        file: { path: 'notes/article.md' },
        previewMode: { rerender, containerEl: document.createElement('div') },
      }),
    };
    const { plugin, handlers } = makePlugin2([leaf]);
    registerHighlightRefreshListener(plugin as never);

    handlers.get('ir-highlights-changed')![0]('notes/article.md');

    // Simulate a layout-change: if path was incorrectly added to pendingRefresh,
    // rerender would be called a second time
    handlers.get('layout-change')![0]();
    expect(rerender).toHaveBeenCalledTimes(1);
  });

  it('layout-change does not rerender when leaf is NOT in preview mode', () => {
    const rerender = vi.fn();
    const leaf = {
      view: Object.assign(Object.create(MarkdownView.prototype), {
        getMode: () => 'source',
        file: { path: 'notes/article.md' },
        previewMode: { rerender, containerEl: document.createElement('div') },
      }),
    };
    const { plugin, handlers } = makePlugin2([leaf]);
    registerHighlightRefreshListener(plugin as never);

    // Queue the path (no matching preview leaf)
    handlers.get('ir-highlights-changed')![0]('notes/article.md');

    // Now fire layout-change — leaf is in source mode, so no rerender
    handlers.get('layout-change')![0]();
    expect(rerender).not.toHaveBeenCalled();
  });

  it('layout-change rerenders only the queued file, not other files', () => {
    const rerenderA = vi.fn();
    const rerenderB = vi.fn();
    const leafA = {
      view: Object.assign(Object.create(MarkdownView.prototype), {
        getMode: () => 'preview',
        file: { path: 'notes/a.md' },
        previewMode: {
          rerender: rerenderA,
          containerEl: document.createElement('div'),
        },
      }),
    };
    const leafB = {
      view: Object.assign(Object.create(MarkdownView.prototype), {
        getMode: () => 'preview',
        file: { path: 'notes/b.md' },
        previewMode: {
          rerender: rerenderB,
          containerEl: document.createElement('div'),
        },
      }),
    };

    const { plugin, handlers } = makePlugin2([leafA, leafB]);
    registerHighlightRefreshListener(plugin as never);

    // Only queue 'notes/a.md'
    handlers.get('ir-highlights-changed')![0]('notes/a.md');
    handlers.get('layout-change')![0]();

    expect(rerenderA).toHaveBeenCalledWith(true);
    expect(rerenderB).not.toHaveBeenCalled();
  });

  it('layout-change: skips leaf whose view is not a MarkdownView instance when path is pending', () => {
    // Covers the layout-change path where !(leaf.view instanceof MarkdownView) → return
    const rerender = vi.fn();
    const nonMarkdownLeaf = {
      view: {
        getMode: () => 'preview',
        file: { path: 'notes/article.md' },
        previewMode: { rerender, containerEl: document.createElement('div') },
      },
    };
    // Queue by firing ir-highlights-changed with no matching leaves,
    // then swap in the non-MarkdownView leaf for layout-change
    const { plugin: p2, handlers: h2 } = makePlugin2([]);
    registerHighlightRefreshListener(p2 as never);
    h2.get('ir-highlights-changed')![0]('notes/article.md');

    // Fire layout-change via a plugin whose iterateAllLeaves yields our non-MarkdownView leaf
    (
      p2.app.workspace.iterateAllLeaves as ReturnType<typeof vi.fn>
    ).mockImplementation((cb: (leaf: unknown) => void) => cb(nonMarkdownLeaf));
    h2.get('layout-change')![0]();
    expect(rerender).not.toHaveBeenCalled();
  });

  it('layout-change: skips leaf whose file path is undefined when path is pending', () => {
    // Covers the !filePath branch in layout-change (leaf.view.file?.path is undefined)
    const rerender = vi.fn();
    const noFileLeaf = {
      view: Object.assign(Object.create(MarkdownView.prototype), {
        getMode: () => 'preview',
        file: undefined,
        previewMode: { rerender, containerEl: document.createElement('div') },
      }),
    };

    const { plugin, handlers } = makePlugin2([]);
    registerHighlightRefreshListener(plugin as never);
    handlers.get('ir-highlights-changed')![0]('notes/article.md');

    (
      plugin.app.workspace.iterateAllLeaves as ReturnType<typeof vi.fn>
    ).mockImplementation((cb: (leaf: unknown) => void) => cb(noFileLeaf));
    handlers.get('layout-change')![0]();
    expect(rerender).not.toHaveBeenCalled();
  });
});
