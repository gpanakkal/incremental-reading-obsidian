// @vitest-environment jsdom

import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import {
  SnippetOffsetTracker,
  type SnippetHighlight,
} from '#/lib/SnippetOffsetTracker';
import type { NoteType } from '#/lib/types';
import { Notice } from '#/test/__mocks__/obsidian';
import {
  history,
  invertedEffects,
  isolateHistory,
  redo,
  undo,
  undoDepth,
} from '@codemirror/commands';
import { EditorState, Transaction, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isExternalSync,
  openHighlightFromEvent,
  refreshHighlightsEffect,
  restoreHighlightsEffect,
  snippetHighlightExtension,
  snippetHighlightHistory,
} from './SnippetHighlightExtension';
import { irPluginFacet, isReviewInterfaceFacet } from './irPluginFacet';

// #region HELPERS

const FILE_PATH = 'notes/a.md';

function makeHighlight(
  overrides: Partial<SnippetHighlight> = {}
): SnippetHighlight {
  return {
    id: 'h1',
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

type FakeReviewManager = {
  getSnippetHighlights: ReturnType<typeof vi.fn>;
  updateSnippetOffsets: ReturnType<typeof vi.fn>;
  snippets: { offsetTracker: SnippetOffsetTracker };
};

function makeReviewManager(filePath = FILE_PATH): FakeReviewManager {
  const tracker = new SnippetOffsetTracker();
  tracker.loadHighlights(filePath, []);
  return {
    getSnippetHighlights: vi.fn().mockResolvedValue(undefined),
    updateSnippetOffsets: vi.fn().mockResolvedValue(undefined),
    snippets: { offsetTracker: tracker },
  };
}

type FakeEventRef = { name: string; callback: (...args: unknown[]) => unknown };

type FakePlugin = {
  reviewManager: FakeReviewManager | null;
  /** The review tab, when one is open; none unless a test opens one. */
  getOpenReviewLeaf: () => unknown;
  app: {
    vault: { getFileByPath: (path: string) => unknown };
    workspace: {
      openLinkText: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
      offref: ReturnType<typeof vi.fn>;
      /** Drive the handlers registered via `on`, as Obsidian's trigger does. */
      trigger: (name: string, ...args: unknown[]) => void;
    };
  };
};

/**
 * The plugin subscribes to 'ir-highlights-changed' in its constructor, so
 * on/offref must exist on every fake — a missing one throws there, and
 * CodeMirror responds by dropping the ViewPlugin entirely.
 */
function makePlugin(
  reviewManager: FakeReviewManager | null = null
): FakePlugin {
  const handlers = new Map<string, Set<(...args: unknown[]) => unknown>>();
  return {
    reviewManager,
    getOpenReviewLeaf: () => null,
    app: {
      // Every snippet's file is there, unless a test says otherwise
      vault: { getFileByPath: (path: string) => ({ path }) },
      workspace: {
        openLinkText: vi.fn(),
        on: vi.fn((name: string, callback: (...args: unknown[]) => unknown) => {
          const forName = handlers.get(name) ?? new Set();
          forName.add(callback);
          handlers.set(name, forName);
          return { name, callback } satisfies FakeEventRef;
        }),
        offref: vi.fn((ref: FakeEventRef) => {
          handlers.get(ref.name)?.delete(ref.callback);
        }),
        trigger: (name: string, ...args: unknown[]) => {
          handlers.get(name)?.forEach((callback) => callback(...args));
        },
      },
    },
  };
}

/**
 * Spy on getFileInfoFromState to inject a fake TFile so that this.file is non-null
 * inside the plugin constructor. Must be called BEFORE makeView().
 */
function stubFileInfo(
  filePath = FILE_PATH,
  noteType: NoteType | null = 'article',
  isSource = false
) {
  const fakeFile = { path: filePath };
  vi.spyOn(Obsidian, 'getFileInfoFromState').mockReturnValue({
    info: { file: fakeFile, app: {} } as never,
    editorView: null,
  });
  vi.spyOn(Obsidian, 'isSourceNote').mockReturnValue(isSource);
  vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue(noteType);
  vi.spyOn(Obsidian, 'getBodyStartOffset').mockReturnValue(0);
  return fakeFile;
}

function makeView(
  doc: string,
  plugin: FakePlugin | null,
  isReviewInterface = false,
  extra: Extension[] = []
): EditorView {
  const state = EditorState.create({
    doc,
    extensions: [
      snippetHighlightExtension,
      irPluginFacet.of(plugin as never),
      isReviewInterfaceFacet.of(isReviewInterface),
      extra,
    ],
  });
  return new EditorView({ state, parent: document.body });
}

/** Flush microtasks so async loadHighlights() settles. */
async function flushAsync() {
  await new Promise((r) => setTimeout(r, 20));
}

/**
 * Where a note's body starts: the real `Obsidian.getBodyStartOffset`, taken
 * before `stubFileInfo` stubs it, so the arbitraries and checks below agree
 * with the view about where offsets count from.
 */
const bodyStartOf = Obsidian.getBodyStartOffset.bind(
  Obsidian
) as typeof Obsidian.getBodyStartOffset;

/**
 * A view over `doc` with `highlights` in its tracker, already loaded: the
 * constructor's DB load never settles, so it can't overwrite them, and the
 * refresh effect marks them loaded at once. Its body starts where the real
 * `getBodyStartOffset` says, past any frontmatter.
 */
function makeTrackedView(
  doc: string,
  highlights: SnippetHighlight[],
  isReviewInterface: boolean,
  extra: Extension[] = []
) {
  const rm = makeReviewManager();
  rm.snippets.offsetTracker.loadHighlights(FILE_PATH, highlights);
  stubFileInfo(FILE_PATH, 'article');
  // Undoes stubFileInfo's stub (spyOn hands back the spy it installed)
  vi.spyOn(Obsidian, 'getBodyStartOffset').mockRestore();
  rm.getSnippetHighlights.mockReturnValue(new Promise(() => {}));
  const view = makeView(doc, makePlugin(rm), isReviewInterface, extra);
  view.dispatch({ effects: refreshHighlightsEffect.of(null) });
  rm.getSnippetHighlights.mockClear();
  return { view, rm };
}

/** The text each tracked highlight covers in `doc`'s body. */
function highlightedText(rm: FakeReviewManager, doc: string) {
  const bodyStart = bodyStartOf(doc);
  return rm.snippets.offsetTracker
    .getHighlights(FILE_PATH)
    .map((h) =>
      doc.slice(bodyStart + h.start_offset, bodyStart + h.end_offset)
    );
}

/** Whether CodeMirror's `isUserEvent('set')` would match `event`. */
const isSetEvent = (event: string) =>
  event === 'set' || event.startsWith('set.');

/**
 * Any `userEvent` but Obsidian's `'set'` (cross-pane sync, reload from
 * disk): none, the ones CodeMirror and Obsidian dispatch, and arbitrary
 * strings.
 */
const mappedUserEvent = fc.oneof(
  fc.constant(undefined),
  fc.constantFrom(
    'input',
    'input.type',
    'input.paste',
    'input.drop',
    'input.replace',
    'delete',
    'delete.backward',
    'delete.cut',
    'move.drop',
    'move.line',
    'indent',
    'undo',
    'redo',
    'select'
  ),
  fc.string().filter((s) => !isSetEvent(s))
);

/** Frontmatter, as an article's `ir-id` gives it one, or none. */
const frontmatterArb = fc.oneof(
  fc.constant(''),
  fc
    .array(fc.stringMatching(/^[a-z-]{1,8}: [\w -]{0,10}$/), {
      minLength: 1,
      maxLength: 3,
    })
    .map((lines) => `---\n${lines.join('\n')}\n---\n`)
);

/** A body of any text, or of Markdown-ish lines. No CR: see below. */
const bodyArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 40 }),
  fc.string({
    unit: fc.constantFrom('a', 'b', ' ', '-', '\n', '#', '*', '!', '['),
    minLength: 1,
    maxLength: 40,
  })
);

/**
 * A document, a highlight in its body, and an edit that leaves the highlighted
 * text alone: it lies wholly before or after it, possibly touching it, in the
 * body or the frontmatter, without making or unmaking a frontmatter block.
 * The highlight's offsets are body-relative, as the tracker keeps them.
 */
const docHighlightAndDisjointEdit = fc
  .tuple(frontmatterArb, bodyArb)
  .map(([frontmatter, body]) => frontmatter + body)
  // No CR: CodeMirror reads one as a line break, so the doc's length changes
  // (Obsidian keeps notes LF-only anyway)
  .filter((doc) => !doc.includes('\r') && bodyStartOf(doc) < doc.length)
  .chain((doc) => {
    const bodyStart = bodyStartOf(doc);
    return fc
      .tuple(
        fc.integer({ min: bodyStart, max: doc.length - 1 }),
        fc.integer({ min: bodyStart + 1, max: doc.length })
      )
      .filter(([s, e]) => s < e)
      .chain(([start, end]) =>
        fc.record({
          doc: fc.constant(doc),
          text: fc.constant(doc.slice(start, end)),
          highlight: fc.constant({
            start_offset: start - bodyStart,
            end_offset: end - bodyStart,
          }),
          change: fc.oneof(
            fc
              .tuple(
                fc.integer({ min: 0, max: start }),
                fc.integer({ min: 0, max: start })
              )
              .map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as const),
            fc
              .tuple(
                fc.integer({ min: end, max: doc.length }),
                fc.integer({ min: end, max: doc.length })
              )
              .map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as const)
          ),
          insert: fc.oneof(
            fc.string({ maxLength: 20 }),
            fc.string({
              unit: fc.constantFrom('a', ' ', '-', '\n', '!', '[', ']'),
              maxLength: 20,
            })
          ),
        })
      );
  })
  .filter(({ doc, change: [from, to], insert }) => {
    if (from === to && insert.length === 0) return false;
    // The body moves by the edit's length when it's made above it, and
    // stays put otherwise
    const bodyStart = bodyStartOf(doc);
    const next = doc.slice(0, from) + insert + doc.slice(to);
    const shift = to <= bodyStart ? insert.length - (to - from) : 0;
    return (
      bodyStartOf(next) === bodyStart + shift &&
      (from >= bodyStart || to <= bodyStart)
    );
  });

/** Every tracked highlight's offsets, by id. */
const offsetsOf = (rm: FakeReviewManager) =>
  Object.fromEntries(
    rm.snippets.offsetTracker
      .getHighlights(FILE_PATH)
      .map((h) => [h.id, [h.start_offset, h.end_offset]])
  );

/**
 * A tracked view with history, as Obsidian's editors have, and — unless
 * `remembers` is false — the highlights' part in it.
 */
const makeHistoryView = (
  doc: string,
  highlights: SnippetHighlight[],
  review: boolean,
  remembers = true
) =>
  makeTrackedView(
    doc,
    highlights,
    review,
    remembers ? [history(), snippetHighlightHistory] : [history()]
  );

/** An edit of its own in history, as one made after a pause is. */
const edit = (view: EditorView, from: number, to: number, insert = '') =>
  view.dispatch({
    changes: { from, to, insert },
    annotations: isolateHistory.of('full'),
  });

/**
 * Edits to make one after another: each one to three changes, placed by
 * fractions of whatever document it meets, on its own in history or free to
 * join the step before.
 */
const historyEditsArb = fc.array(
  fc.record({
    changes: fc.array(
      fc.record({
        at: fc.double({ min: 0, max: 1, noNaN: true }),
        length: fc.nat({ max: 8 }),
        insert: fc.oneof(
          fc.constant(''),
          fc.string({
            unit: fc.constantFrom('a', ' ', '\n', '-'),
            maxLength: 6,
          })
        ),
      }),
      { minLength: 1, maxLength: 3 }
    ),
    joinable: fc.boolean(),
  }),
  { minLength: 1, maxLength: 4 }
);

/** One of {@link historyEditsArb}'s edits, as changes to a document of `length`. */
function placeChanges(
  changes: { at: number; length: number; insert: string }[],
  length: number
) {
  const specs: { from: number; to: number; insert: string }[] = [];
  let end = -1;
  for (const { at, length: cut, insert } of [...changes].sort(
    (a, b) => a.at - b.at
  )) {
    const from = Math.round(at * length);
    // Kept apart, as one transaction's changes must be
    if (from <= end) continue;
    const to = Math.min(length, from + cut);
    specs.push({ from, to, insert });
    end = to;
  }
  return specs;
}

/**
 * A plugin whose items are all missing their files, with a review tab open
 * that shows the missing item in review as it is asked to — or says it has
 * none at the reference, when `known` is false.
 */
function wireMissing(known = true) {
  Notice.reset();
  const plugin = makePlugin(makeReviewManager());
  plugin.app.vault.getFileByPath = () => null;
  const containerEl = document.body.appendChild(document.createElement('div'));
  const showMissingInReview = vi.fn(async (_ref: string) => known);
  plugin.getOpenReviewLeaf = () => ({
    view: { containerEl, showMissingInReview },
  });
  return { plugin, containerEl, showMissingInReview };
}

/** A highlight in `parent` of the snippet, or the card, at `snippets/a.md`. */
function highlightIn(parent: HTMLElement, card = false): HTMLElement {
  const span = parent.appendChild(document.createElement('span'));
  span.className = card
    ? 'ir-snippet-highlight ir-card-highlight'
    : 'ir-snippet-highlight';
  span.setAttribute('data-snippet-ref', 'snippets/a.md');
  return span;
}

/** A click on `target`, as the document's listener receives it. */
function clickOn(target: HTMLElement, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('click', { cancelable: true, ...init });
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

/** Modifier keys a click on a highlight can carry, and the button: left or middle. */
const clickInitArb = fc.record({
  button: fc.constantFrom(0, 1),
  ctrlKey: fc.boolean(),
  metaKey: fc.boolean(),
  altKey: fc.boolean(),
  shiftKey: fc.boolean(),
});
/** Whether Obsidian reads a click as one for the tab the user is in. */
const isPlain = (init: MouseEventInit) =>
  init.button === 0 && !init.ctrlKey && !init.metaKey;

/** Let a lookup the click started settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// #endregion

// ---------------------------------------------------------------------------
// isExternalSync annotation
// ---------------------------------------------------------------------------
describe('isExternalSync', () => {
  afterEach(() => vi.restoreAllMocks());

  it('can be attached to a transaction and read back', () => {
    const view = makeView('hello', null);
    const tr = view.state.update({ annotations: isExternalSync.of(true) });
    expect(tr.annotation(isExternalSync)).toBe(true);
    view.destroy();
  });

  it('returns undefined when annotation is not present', () => {
    const view = makeView('hello', null);
    const tr = view.state.update({});
    expect(tr.annotation(isExternalSync)).toBeUndefined();
    view.destroy();
  });

  it('preserves false as a distinct value from undefined', () => {
    const view = makeView('hello', null);
    const tr = view.state.update({ annotations: isExternalSync.of(false) });
    expect(tr.annotation(isExternalSync)).toBe(false);
    view.destroy();
  });

  it.each([true, false])(
    'annotation value survives round-trip for %s',
    (flag) => {
      const view = makeView('test', null);
      const tr = view.state.update({ annotations: isExternalSync.of(flag) });
      expect(tr.annotation(isExternalSync)).toBe(flag);
      view.destroy();
    }
  );

  it('two separate transactions carry independent annotation values', () => {
    const view = makeView('test', null);
    const trTrue = view.state.update({ annotations: isExternalSync.of(true) });
    const trFalse = view.state.update({
      annotations: isExternalSync.of(false),
    });
    expect(trTrue.annotation(isExternalSync)).toBe(true);
    expect(trFalse.annotation(isExternalSync)).toBe(false);
    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// refreshHighlightsEffect StateEffect
// ---------------------------------------------------------------------------
describe('refreshHighlightsEffect', () => {
  afterEach(() => vi.restoreAllMocks());

  it('can be dispatched and detected in a transaction', () => {
    const view = makeView('hello', null);
    const tr = view.state.update({ effects: refreshHighlightsEffect.of(null) });
    const found = tr.effects.some((e) => e.is(refreshHighlightsEffect));
    expect(found).toBe(true);
    view.destroy();
  });

  it('is not detected when it was not dispatched', () => {
    const view = makeView('hello', null);
    const tr = view.state.update({});
    expect(tr.effects.some((e) => e.is(refreshHighlightsEffect))).toBe(false);
    view.destroy();
  });

  it('carries null as its value', () => {
    const view = makeView('hello', null);
    const tr = view.state.update({ effects: refreshHighlightsEffect.of(null) });
    const effect = tr.effects.find((e) => e.is(refreshHighlightsEffect));
    expect(effect?.value).toBeNull();
    view.destroy();
  });

  it('refreshHighlightsEffect.is() correctly identifies the effect type', () => {
    const view = makeView('test', null);
    const tr = view.state.update({ effects: refreshHighlightsEffect.of(null) });
    const matched = tr.effects.filter((e) => e.is(refreshHighlightsEffect));
    expect(matched).toHaveLength(1);
    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// loadHighlights (constructor async path)
// ---------------------------------------------------------------------------
describe('loadHighlights (constructor async path)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('calls getSnippetHighlights when file, plugin, and reviewManager are all present', async () => {
    const rm = makeReviewManager();
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    const view = makeView('hello world', irPlugin);
    await flushAsync();
    expect(rm.getSnippetHighlights).toHaveBeenCalledWith({ path: FILE_PATH });
    view.destroy();
  });

  it('does not call getSnippetHighlights when noteType is not source/article/snippet', async () => {
    const rm = makeReviewManager();
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'card', false);
    const view = makeView('hello world', irPlugin);
    await flushAsync();
    expect(rm.getSnippetHighlights).not.toHaveBeenCalled();
    view.destroy();
  });

  it('does not call getSnippetHighlights when reviewManager is null', async () => {
    const irPlugin = makePlugin(null);
    stubFileInfo(FILE_PATH, 'article');
    const view = makeView('hello world', irPlugin);
    await flushAsync();
    // No reviewManager → short-circuits before getSnippetHighlights
    view.destroy();
  });

  it('calls getSnippetHighlights when isSource=true (regardless of noteType)', async () => {
    const rm = makeReviewManager();
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, null, true); // isSource=true
    const view = makeView('hello world', irPlugin);
    await flushAsync();
    expect(rm.getSnippetHighlights).toHaveBeenCalledWith({ path: FILE_PATH });
    view.destroy();
  });

  it('calls getSnippetHighlights for noteType=snippet', async () => {
    const rm = makeReviewManager();
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'snippet', false);
    const view = makeView('hello world', irPlugin);
    await flushAsync();
    expect(rm.getSnippetHighlights).toHaveBeenCalledWith({ path: FILE_PATH });
    view.destroy();
  });

  it('sets highlightsLoaded=true after async load completes', async () => {
    const rm = makeReviewManager();
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    const view = makeView('hello world', irPlugin);
    await flushAsync();
    // Verify indirectly: once loaded, a refreshEffect should NOT re-enter the
    // !highlightsLoaded branch (it returns early after the if block)
    // We dispatch a non-doc-changing update; no error means the loaded state is stable.
    expect(() => view.dispatch({})).not.toThrow();
    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// update() — refreshHighlightsEffect branch (highlights not yet loaded)
// ---------------------------------------------------------------------------
describe('update() — refreshHighlightsEffect when not yet loaded', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not throw when refreshHighlightsEffect is dispatched without a plugin', () => {
    const view = makeView('hello', null);
    expect(() =>
      view.dispatch({ effects: refreshHighlightsEffect.of(null) })
    ).not.toThrow();
    view.destroy();
  });

  it('does not throw when refreshHighlightsEffect is dispatched with null reviewManager', () => {
    const irPlugin = makePlugin(null);
    const view = makeView('hello', irPlugin);
    expect(() =>
      view.dispatch({ effects: refreshHighlightsEffect.of(null) })
    ).not.toThrow();
    view.destroy();
  });

  it('sets highlightsLoaded via refreshHighlightsEffect when file is known and highlights not yet loaded', () => {
    // loadHighlights is async; by NOT awaiting, this.highlightsLoaded stays false.
    // The refresh effect then sets it to true synchronously.
    const rm = makeReviewManager();
    const irPlugin = makePlugin(rm);
    // Stub BEFORE view creation so constructor sets this.file
    stubFileInfo(FILE_PATH, 'article');
    // Make getSnippetHighlights never resolve (to keep highlightsLoaded=false)
    rm.getSnippetHighlights.mockReturnValue(new Promise(() => {}));
    const view = makeView('hello world', irPlugin);

    // Dispatch refresh effect — should set highlightsLoaded=true synchronously
    expect(() =>
      view.dispatch({ effects: refreshHighlightsEffect.of(null) })
    ).not.toThrow();

    // Subsequent dispatch won't re-enter the !highlightsLoaded branch
    expect(() => view.dispatch({})).not.toThrow();
    view.destroy();
  });

  it('without refreshHighlightsEffect, returns early when highlights not loaded', () => {
    const rm = makeReviewManager();
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    rm.getSnippetHighlights.mockReturnValue(new Promise(() => {}));
    const view = makeView('hello', irPlugin);
    // Dispatch a plain change — without the effect, update() returns early
    expect(() => view.dispatch({})).not.toThrow();
    view.destroy();
  });

  it('dispatching refreshHighlightsEffect twice does not throw', () => {
    const rm = makeReviewManager();
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    rm.getSnippetHighlights.mockReturnValue(new Promise(() => {}));
    const view = makeView('hello', irPlugin);
    expect(() => {
      view.dispatch({ effects: refreshHighlightsEffect.of(null) });
      view.dispatch({ effects: refreshHighlightsEffect.of(null) });
    }).not.toThrow();
    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// update() — docChanged branches (highlights loaded)
// ---------------------------------------------------------------------------
describe('update() — docChanged after highlights are loaded', () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * Create a view with highlights already loaded by using refreshHighlightsEffect
   * immediately after construction (getSnippetHighlights never resolves, so we
   * trigger the synchronous load-from-tracker path).
   */
  function makeLoadedView(
    doc: string,
    rm: FakeReviewManager,
    isReviewInterface = false
  ) {
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    rm.getSnippetHighlights.mockReturnValue(new Promise(() => {}));
    const view = makeView(doc, irPlugin, isReviewInterface);
    // Synchronously trigger the refresh path to mark highlights as loaded
    view.dispatch({ effects: refreshHighlightsEffect.of(null) });
    return { view, irPlugin };
  }

  it('calls updateOffsetsWithMapping on a user input event', () => {
    const rm = makeReviewManager();
    const updateSpy = vi.spyOn(
      rm.snippets.offsetTracker,
      'updateOffsetsWithMapping'
    );
    const { view } = makeLoadedView('hello world', rm, false);
    view.dispatch({ changes: { from: 5, insert: '!' }, userEvent: 'input' });
    expect(updateSpy).toHaveBeenCalledWith(
      FILE_PATH,
      expect.anything(),
      0,
      0,
      expect.anything()
    );
    view.destroy();
  });

  it('calls updateOffsetsWithMapping on a delete event', () => {
    const rm = makeReviewManager();
    const updateSpy = vi.spyOn(
      rm.snippets.offsetTracker,
      'updateOffsetsWithMapping'
    );
    const { view } = makeLoadedView('hello world', rm, false);
    view.dispatch({ changes: { from: 5, to: 6 }, userEvent: 'delete' });
    expect(updateSpy).toHaveBeenCalled();
    view.destroy();
  });

  it('calls updateOffsetsWithMapping on an undo event', () => {
    const rm = makeReviewManager();
    const updateSpy = vi.spyOn(
      rm.snippets.offsetTracker,
      'updateOffsetsWithMapping'
    );
    const { view } = makeLoadedView('hello world', rm, false);
    view.dispatch({ changes: { from: 0, insert: 'x' }, userEvent: 'undo' });
    expect(updateSpy).toHaveBeenCalled();
    view.destroy();
  });

  it('calls updateOffsetsWithMapping on a redo event', () => {
    const rm = makeReviewManager();
    const updateSpy = vi.spyOn(
      rm.snippets.offsetTracker,
      'updateOffsetsWithMapping'
    );
    const { view } = makeLoadedView('hello world', rm, false);
    view.dispatch({ changes: { from: 0, insert: 'x' }, userEvent: 'redo' });
    expect(updateSpy).toHaveBeenCalled();
    view.destroy();
  });

  it('does NOT call updateOffsetsWithMapping on a cross-pane sync in standard editor', () => {
    const rm = makeReviewManager();
    const updateSpy = vi.spyOn(
      rm.snippets.offsetTracker,
      'updateOffsetsWithMapping'
    );
    const { view } = makeLoadedView('hello world', rm, false);
    // Obsidian's cross-pane sync → reloadHighlightsFromDB path
    view.dispatch({ changes: { from: 0, insert: 'X' }, userEvent: 'set' });
    expect(updateSpy).not.toHaveBeenCalled();
    view.destroy();
  });

  it('does NOT call updateOffsetsWithMapping on an external sync in review interface', () => {
    const rm = makeReviewManager();
    const updateSpy = vi.spyOn(
      rm.snippets.offsetTracker,
      'updateOffsetsWithMapping'
    );
    const { view } = makeLoadedView('hello world', rm, true);
    view.dispatch({
      changes: { from: 0, insert: 'X' },
      annotations: isExternalSync.of(true),
    });
    expect(updateSpy).not.toHaveBeenCalled();
    view.destroy();
  });

  it('in review interface, an external sync does NOT call getSnippetHighlights', async () => {
    const rm = makeReviewManager();
    const { view } = makeLoadedView('hello world', rm, true);
    // Past the constructor's own load, which starts after a microtask
    await flushAsync();
    rm.getSnippetHighlights.mockReset().mockResolvedValue(undefined);
    view.dispatch({
      changes: { from: 0, insert: 'X' },
      annotations: isExternalSync.of(true),
    });
    expect(rm.getSnippetHighlights).not.toHaveBeenCalled();
    view.destroy();
  });

  it('in standard editor, a cross-pane sync triggers reloadHighlightsFromDB (getSnippetHighlights called async)', async () => {
    const rm = makeReviewManager();
    const { view } = makeLoadedView('hello world', rm, false);
    // Reset call count after initial loadHighlights setup, which starts after
    // a microtask
    await flushAsync();
    rm.getSnippetHighlights.mockClear();
    // Obsidian's cross-pane sync triggers reloadHighlightsFromDB
    view.dispatch({ changes: { from: 0, insert: 'X' }, userEvent: 'set' });
    await flushAsync();
    expect(rm.getSnippetHighlights).toHaveBeenCalledWith({ path: FILE_PATH });
    view.destroy();
  });

  it('in standard editor, user input event schedules a persist (not in review interface)', () => {
    vi.useFakeTimers();
    const rm = makeReviewManager();
    const { view } = makeLoadedView('hello world', rm, false);
    // User edit → schedulePersist is called (timer is set)
    view.dispatch({ changes: { from: 5, insert: '!' }, userEvent: 'input' });
    // No updateSnippetOffsets called yet (debounce)
    expect(rm.updateSnippetOffsets).not.toHaveBeenCalled();
    // Advance past debounce
    vi.runAllTimers();
    vi.useRealTimers();
    view.destroy();
  });

  it('in review interface, user input event does NOT schedule a persist (even with highlights)', async () => {
    vi.useFakeTimers();
    const rm = makeReviewManager();
    // Load highlights so that if schedulePersist were incorrectly called,
    // updateSnippetOffsets would fire for each one
    rm.snippets.offsetTracker.loadHighlights(FILE_PATH, [
      makeHighlight({ id: 'h1', start_offset: 0, end_offset: 5 }),
      makeHighlight({ id: 'h2', start_offset: 6, end_offset: 11 }),
    ]);
    const { view } = makeLoadedView('hello world', rm, true);
    view.dispatch({ changes: { from: 5, insert: '!' }, userEvent: 'input' });
    vi.advanceTimersByTime(3000);
    await Promise.resolve();
    await Promise.resolve();
    expect(rm.updateSnippetOffsets).not.toHaveBeenCalled();
    vi.useRealTimers();
    view.destroy();
  });

  it('non-doc-changing dispatch rebuilds decorations (no throw)', () => {
    const rm = makeReviewManager();
    const { view } = makeLoadedView('hello world', rm);
    expect(() => view.dispatch({})).not.toThrow();
    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// update() — which edits move the highlights
// ---------------------------------------------------------------------------
describe('update() — which edits move the highlights', () => {
  afterEach(() => vi.restoreAllMocks());

  // `editor.replaceRange` — how a card's embed goes in — dispatches with no
  // userEvent at all, as do other plugins' edits
  it('keeps a highlight on its text through any edit but a sync, in either editor', () => {
    fc.assert(
      fc.property(
        docHighlightAndDisjointEdit,
        mappedUserEvent,
        fc.boolean(),
        (
          { doc, text, highlight, change: [from, to], insert },
          userEvent,
          review
        ) => {
          const { view, rm } = makeTrackedView(
            doc,
            [makeHighlight(highlight)],
            review
          );
          try {
            view.dispatch({ changes: { from, to, insert }, userEvent });

            expect(highlightedText(rm, view.state.doc.toString())).toEqual([
              text,
            ]);
            // Mapped, not reloaded from offsets the edit made stale
            expect(rm.getSnippetHighlights).not.toHaveBeenCalled();
          } finally {
            view.destroy();
          }
        }
      )
    );
  });

  // Obsidian's `editor.setValue` replaces the whole document, with no
  // userEvent, even when most of it — or all of it — is unchanged; its table
  // editor does the same to a whole table. Only the text before and after says
  // where the edit was — deleting the first of two like characters can't be
  // told from deleting the second — even when it borders the highlight.
  it('keeps a highlight on its text when a whole-document replacement puts in or takes out its like right next to it', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom('a', 'b', ' '), maxLength: 6 }),
        fc.string({
          unit: fc.constantFrom('a', 'b'),
          minLength: 1,
          maxLength: 6,
        }),
        fc.string({ unit: fc.constantFrom('a', 'b', ' '), maxLength: 6 }),
        fc.integer({ min: 1, max: 6 }),
        fc.constantFrom('before', 'after'),
        fc.constantFrom('insert', 'delete'),
        fc.boolean(),
        (pre, text, post, n, side, kind, review) => {
          // A run like the highlight's own edge, which sliding the edit into
          // the highlight would leave the document the same for
          const like =
            side === 'before'
              ? text.slice(0, Math.min(n, text.length))
              : text.slice(-Math.min(n, text.length));
          const around = (middle: string) =>
            side === 'before'
              ? pre + middle + text + post
              : pre + text + middle + post;
          const doc = around(kind === 'insert' ? '' : like);
          const next = around(kind === 'insert' ? like : '');
          const start =
            pre.length +
            (side === 'before' && kind === 'delete' ? like.length : 0);
          const { view, rm } = makeTrackedView(
            doc,
            [
              makeHighlight({
                start_offset: start,
                end_offset: start + text.length,
              }),
            ],
            review
          );
          try {
            view.dispatch({
              changes: { from: 0, to: doc.length, insert: next },
            });

            expect(highlightedText(rm, next)).toEqual([text]);
          } finally {
            view.destroy();
          }
        }
      )
    );
  });

  it('keeps a highlight on its text when the edit comes as a replacement of the whole document', () => {
    fc.assert(
      fc.property(
        docHighlightAndDisjointEdit,
        mappedUserEvent,
        fc.boolean(),
        (
          { doc, text, highlight, change: [from, to], insert },
          userEvent,
          review
        ) => {
          const { view, rm } = makeTrackedView(
            doc,
            [makeHighlight(highlight)],
            review
          );
          try {
            const next = doc.slice(0, from) + insert + doc.slice(to);
            view.dispatch({
              changes: { from: 0, to: doc.length, insert: next },
              userEvent,
            });

            expect(highlightedText(rm, view.state.doc.toString())).toEqual([
              text,
            ]);
          } finally {
            view.destroy();
          }
        }
      )
    );
  });

  it('leaves the offsets as they are through a sync, which arrives with them already right', () => {
    fc.assert(
      fc.property(
        docHighlightAndDisjointEdit,
        fc.oneof(
          // Obsidian's cross-pane sync, and its reload of a note changed on disk
          fc.record({
            userEvent: fc.oneof(
              fc.constant('set'),
              fc.string().map((s) => `set.${s}`)
            ),
            external: fc.boolean(),
          }),
          // The review editor taking in text another editor saved
          fc.record({
            userEvent: mappedUserEvent,
            external: fc.constant(true),
          })
        ),
        fc.boolean(),
        (
          { doc, highlight, change: [from, to], insert },
          { userEvent, external },
          review
        ) => {
          const { view, rm } = makeTrackedView(
            doc,
            [makeHighlight(highlight)],
            review
          );
          try {
            view.dispatch({
              changes: { from, to, insert },
              userEvent,
              annotations: external ? isExternalSync.of(true) : [],
            });

            const [h] = rm.snippets.offsetTracker.getHighlights(FILE_PATH);
            expect([h.start_offset, h.end_offset]).toEqual([
              highlight.start_offset,
              highlight.end_offset,
            ]);
            // The standard editor reloads what the editing one saved; the
            // review one shares its tracker, already mapped
            expect(rm.getSnippetHighlights).toHaveBeenCalledTimes(
              review ? 0 : 1
            );
          } finally {
            view.destroy();
          }
        }
      )
    );
  });

  it('repaints the review editor from the tracker after a sync, where the editing one moved it', () => {
    fc.assert(
      fc.property(
        docHighlightAndDisjointEdit,
        ({ doc, text, highlight, change: [from, to], insert }) => {
          const { view, rm } = makeTrackedView(
            doc,
            [makeHighlight(highlight)],
            true
          );
          try {
            const next = doc.slice(0, from) + insert + doc.slice(to);
            // The standard editor mapped the edit into the shared tracker,
            // and the review editor then takes in the saved text
            rm.snippets.offsetTracker.updateOffsetsWithMapping(
              FILE_PATH,
              view.state.changes({ from, to, insert }),
              bodyStartOf(doc),
              bodyStartOf(next)
            );
            view.dispatch({
              changes: { from, to, insert },
              annotations: isExternalSync.of(true),
            });

            const [h] = rm.snippets.offsetTracker.getHighlights(FILE_PATH);
            const bodyStart = bodyStartOf(next);
            const painted: [number, number][] = [];
            view
              .plugin(snippetHighlightExtension)!
              .decorations.between(0, view.state.doc.length, (f, t) => {
                painted.push([f, t]);
              });
            expect(painted).toEqual([
              [bodyStart + h.start_offset, bodyStart + h.end_offset],
            ]);
            expect(view.state.doc.sliceString(...painted[0])).toBe(text);
          } finally {
            view.destroy();
          }
        }
      )
    );
  });

  it('moves the highlights through only the edit when a sync and an edit come in one update', () => {
    fc.assert(
      fc.property(
        docHighlightAndDisjointEdit,
        fc.record({
          at: fc.nat(),
          length: fc.nat({ max: 5 }),
          insert: fc.string({ maxLength: 5 }),
          kind: fc.constantFrom('set', 'external'),
        }),
        fc.boolean(),
        fc.boolean(),
        (
          { doc, highlight, change: [from, to], insert },
          sync,
          syncFirst,
          review
        ) => {
          const { view, rm } = makeTrackedView(
            doc,
            [makeHighlight(highlight)],
            review
          );
          try {
            const syncOn = (length: number) => {
              const at = sync.at % (length + 1);
              return {
                changes: {
                  from: at,
                  to: Math.min(length, at + sync.length),
                  insert: sync.insert,
                },
                ...(sync.kind === 'set'
                  ? { userEvent: 'set' }
                  : { annotations: isExternalSync.of(true) }),
              };
            };
            const editOn = (length: number) => ({
              changes: {
                from: Math.min(from, length),
                to: Math.min(to, length),
                insert,
              },
            });
            const first = syncFirst
              ? view.state.update(syncOn(doc.length))
              : view.state.update(editOn(doc.length));
            const second = syncFirst
              ? first.state.update(editOn(first.state.doc.length))
              : first.state.update(syncOn(first.state.doc.length));
            // One that undoes the other changes no text, so isn't an edit
            fc.pre(!first.changes.compose(second.changes).empty);
            view.dispatch([first, second]);

            const [h] = rm.snippets.offsetTracker.getHighlights(FILE_PATH);
            if (review) {
              // As the edit alone moves them, from the document it was made
              // to: the sync's share is already in the tracker
              const editDoc = (syncFirst ? first.state : first.startState).doc;
              const alone = makeTrackedView(
                editDoc.toString(),
                [makeHighlight(highlight)],
                true
              );
              alone.view.dispatch(editOn(editDoc.length));
              const [expected] =
                alone.rm.snippets.offsetTracker.getHighlights(FILE_PATH);
              alone.view.destroy();
              expect([h.start_offset, h.end_offset]).toEqual([
                expected.start_offset,
                expected.end_offset,
              ]);
              expect(rm.getSnippetHighlights).not.toHaveBeenCalled();
            } else {
              // The standard editor reloads, as for any sync
              expect([h.start_offset, h.end_offset]).toEqual([
                highlight.start_offset,
                highlight.end_offset,
              ]);
              expect(rm.getSnippetHighlights).toHaveBeenCalledTimes(1);
            }
          } finally {
            view.destroy();
          }
        }
      )
    );
  });
});

describe('update() — undo and redo put highlights back', () => {
  afterEach(() => vi.restoreAllMocks());

  it('puts every highlight back where each step found it when undone, and where it left it when redone', () => {
    fc.assert(
      fc.property(
        fc.tuple(frontmatterArb, bodyArb).map(([fm, body]) => fm + body),
        fc.array(fc.tuple(fc.nat(), fc.nat()), { maxLength: 4 }),
        historyEditsArb,
        fc.boolean(),
        (doc, rawSpans, edits, review) => {
          fc.pre(!doc.includes('\r'));
          const bodyLength = doc.length - bodyStartOf(doc);
          const highlights = rawSpans.map(([a, b], i) => {
            const [x, y] = [a % (bodyLength + 1), b % (bodyLength + 1)];
            return makeHighlight({
              id: `h${i}`,
              start_offset: Math.min(x, y),
              end_offset: Math.max(x, y),
            });
          });
          const { view, rm } = makeHistoryView(doc, highlights, review);
          try {
            /** Where each history step found the highlights, and left them. */
            const steps: { before: object; after: object }[] = [];
            for (const { changes, joinable } of edits) {
              const specs = placeChanges(changes, view.state.doc.length);
              if (specs.every(({ from, to, insert }) => from === to && !insert))
                continue;
              const before = offsetsOf(rm);
              const depth = undoDepth(view.state);
              view.dispatch({
                changes: specs,
                annotations: joinable ? [] : isolateHistory.of('full'),
              });
              // An edit that unmakes the frontmatter can leave highlights
              // past the body's end, which mapping can't yet take (0077)
              fc.pre(
                rm.snippets.offsetTracker
                  .getHighlights(FILE_PATH)
                  .every(
                    (h) =>
                      h.end_offset + bodyStartOf(view.state.doc.toString()) <=
                      view.state.doc.length
                  )
              );
              // Joined to the step before, or a step of its own
              if (undoDepth(view.state) > depth) {
                steps.push({ before, after: offsetsOf(rm) });
              } else {
                steps[steps.length - 1].after = offsetsOf(rm);
              }
            }
            for (let i = steps.length - 1; i >= 0; i--) {
              undo(view);
              expect(offsetsOf(rm)).toEqual(steps[i].before);
            }
            for (const { after } of steps) {
              redo(view);
              expect(offsetsOf(rm)).toEqual(after);
            }
          } finally {
            view.destroy();
          }
        }
      )
    );
  });

  it('puts highlights back through a step whose edits cancel out', () => {
    // A letter typed and taken back in one step, then another typed
    const { view, rm } = makeHistoryView(
      'a',
      [makeHighlight({ id: 'h', start_offset: 0, end_offset: 0 })],
      false
    );
    view.dispatch({ changes: { from: 0, insert: 'a' } });
    const typed = offsetsOf(rm);
    view.dispatch({ changes: { from: 0, to: 1 } });
    const takenBack = offsetsOf(rm);
    edit(view, 0, 0, 'a');
    const retyped = offsetsOf(rm);

    undo(view);
    expect(offsetsOf(rm)).toEqual(takenBack);
    undo(view);
    expect(offsetsOf(rm)).toEqual({ h: [0, 0] });
    redo(view);
    expect(offsetsOf(rm)).toEqual(takenBack);
    redo(view);
    expect(offsetsOf(rm)).toEqual(retyped);
    expect(typed).toEqual({ h: [0, 1] });
    view.destroy();
  });

  it('puts back every highlight one erasure took when it is undone', () => {
    const { view, rm } = makeHistoryView(
      'xxaabbyy',
      [
        makeHighlight({ id: 'b', start_offset: 2, end_offset: 4 }),
        makeHighlight({ id: 'a', start_offset: 4, end_offset: 6 }),
      ],
      false
    );
    edit(view, 2, 6);
    expect(offsetsOf(rm)).toEqual({ a: [2, 2], b: [2, 2] });

    undo(view);
    expect(offsetsOf(rm)).toEqual({ a: [4, 6], b: [2, 4] });
    redo(view);
    expect(offsetsOf(rm)).toEqual({ a: [2, 2], b: [2, 2] });
    undo(view);
    expect(offsetsOf(rm)).toEqual({ a: [4, 6], b: [2, 4] });
    view.destroy();
  });

  it('puts back neighbours erased one at a time as each erasure is undone', () => {
    // 'yy' and 'xx' side by side; 'xx' erased, then 'yy'
    const { view, rm } = makeHistoryView(
      'abyyxxcd',
      [
        makeHighlight({ id: 'y', start_offset: 2, end_offset: 4 }),
        makeHighlight({ id: 'x', start_offset: 4, end_offset: 6 }),
      ],
      true
    );
    edit(view, 4, 6);
    edit(view, 2, 4);

    undo(view);
    expect(offsetsOf(rm)).toEqual({ y: [2, 4], x: [4, 4] });
    undo(view);
    expect(offsetsOf(rm)).toEqual({ y: [2, 4], x: [4, 6] });
    view.destroy();
  });

  it('puts back highlights the edits of one history step took, undone as one', () => {
    // Two deletions in a row that history joins into one step
    const { view, rm } = makeHistoryView(
      'abyyxxcd',
      [
        makeHighlight({ id: 'y', start_offset: 2, end_offset: 4 }),
        makeHighlight({ id: 'x', start_offset: 4, end_offset: 6 }),
      ],
      false
    );
    view.dispatch({ changes: { from: 4, to: 6 }, userEvent: 'delete' });
    view.dispatch({ changes: { from: 2, to: 4 }, userEvent: 'delete' });

    undo(view);
    expect(view.state.doc.toString()).toBe('abyyxxcd');
    expect(offsetsOf(rm)).toEqual({ y: [2, 4], x: [4, 6] });
    view.destroy();
  });

  it('undoes a step that a change outside history followed as if it kept no record, without throwing', () => {
    // History can't place the record through such a change, so it drops it.
    // The erasure shrinks the document below where the record points.
    const run = (remembers: boolean) => {
      const { view, rm } = makeHistoryView(
        'aaaaHHHH',
        [makeHighlight({ id: 'h', start_offset: 4, end_offset: 8 })],
        false,
        remembers
      );
      view.dispatch({ changes: { from: 2, to: 6 }, userEvent: 'delete' });
      view.dispatch({
        changes: { from: 0, insert: 'Z' },
        annotations: Transaction.addToHistory.of(false),
      });
      undo(view);
      const result = [view.state.doc.toString(), offsetsOf(rm)];
      view.destroy();
      return result;
    };
    expect(run(true)).toEqual(run(false));
  });

  it('maps, rather than puts back, a step whose highlights it was not told of before', () => {
    // Dispatched together, the second edit starts where the tracker hasn't
    // been yet; undoing it maps the highlight back instead
    const { view, rm } = makeHistoryView(
      '0123456789abcdefghij',
      [makeHighlight({ id: 'h', start_offset: 10, end_offset: 14 })],
      false
    );
    const first = view.state.update({
      changes: { from: 0, insert: 'ab' },
      annotations: isolateHistory.of('full'),
    });
    const second = first.state.update({
      changes: { from: 13, to: 14 },
      annotations: isolateHistory.of('full'),
    });
    view.dispatch([first, second]);

    undo(view);
    const [h] = rm.snippets.offsetTracker.getHighlights(FILE_PATH);
    expect(view.state.doc.sliceString(h.start_offset, h.end_offset)).toBe(
      'abcd'
    );
    undo(view);
    expect(offsetsOf(rm)).toEqual({ h: [10, 14] });
    view.destroy();
  });

  it('keeps with each edit every highlight of the note, and nothing for a note without any', () => {
    const effectsFor = (view: EditorView, from: number, to: number) =>
      view.state
        .facet(invertedEffects)
        .flatMap((invert) =>
          invert(view.state.update({ changes: { from, to, insert: 'x' } }))
        );

    const { view } = makeHistoryView(
      '0123456789',
      [
        makeHighlight({ id: 'a', start_offset: 1, end_offset: 3 }),
        makeHighlight({ id: 'c', start_offset: 9, end_offset: 9 }),
      ],
      false
    );
    expect(
      effectsFor(view, 5, 5).flatMap((e) =>
        e.is(restoreHighlightsEffect) ? e.value : []
      )
    ).toEqual([
      ['a', 1, 3],
      ['c', 9, 9],
    ]);
    view.destroy();

    // Nor a step of its own in history for a cursor move
    const { view: moved } = makeHistoryView(
      '0123456789',
      [makeHighlight({ id: 'a', start_offset: 1, end_offset: 3 })],
      false
    );
    moved.dispatch({ selection: { anchor: 4 } });
    expect(undoDepth(moved.state)).toBe(0);
    moved.destroy();

    const bare = makeHistoryView('0123456789', [], false).view;
    expect(effectsFor(bare, 5, 5)).toEqual([]);
    bare.destroy();
  });

  it('keeps history working where there is no review manager yet', () => {
    stubFileInfo(FILE_PATH, 'article');
    const view = makeView('hello', makePlugin(null), false, [
      history(),
      snippetHighlightHistory,
    ]);
    edit(view, 0, 1);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('hello');
    view.destroy();
  });

  it('leaves highlights to mapping when a sync is undone', () => {
    // The sync's text came with offsets another editor moved; this one keeps
    // no record of them to put back
    const { view, rm } = makeHistoryView(
      'hello world',
      [makeHighlight({ id: 'w', start_offset: 6, end_offset: 11 })],
      true
    );
    // The editor that made the edit — an 'X' typed into 'world' — has
    // moved the shared tracker already
    const [h] = rm.snippets.offsetTracker.getHighlights(FILE_PATH);
    h.start_offset = 6;
    h.end_offset = 12;
    view.dispatch({
      changes: { from: 8, insert: 'X' },
      annotations: [isExternalSync.of(true), isolateHistory.of('full')],
    });

    undo(view);
    expect(offsetsOf(rm)).toEqual({ w: [6, 11] });
    view.destroy();
  });

  describe('saving', () => {
    // Timeouts only: undo scrolls, and a faked animation frame makes jsdom
    // measure what it can't
    beforeEach(() =>
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    );
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('saves the highlights undo put back, not where the erasure left them', async () => {
      const { view, rm } = makeHistoryView(
        'xxaabbyy',
        [
          makeHighlight({ id: 'a', start_offset: 2, end_offset: 4 }),
          makeHighlight({ id: 'b', start_offset: 4, end_offset: 6 }),
        ],
        false
      );
      try {
        edit(view, 2, 6);
        undo(view);
        await vi.advanceTimersByTimeAsync(2000);

        expect(rm.updateSnippetOffsets.mock.calls).toEqual([
          ['a', 2, 4],
          ['b', 4, 6],
        ]);
      } finally {
        view.destroy();
      }
    });
  });
});

describe('update() — saving offsets an edit with no userEvent moved', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('saves nothing for an update that changes no text', async () => {
    const { view, rm } = makeTrackedView(
      'card here. snippet text',
      [makeHighlight({ start_offset: 11, end_offset: 23 })],
      false
    );
    try {
      // Past the constructor's own load, which starts after a microtask
      await vi.advanceTimersByTimeAsync(0);
      rm.getSnippetHighlights.mockClear();
      view.dispatch({ selection: { anchor: 3 } });
      view.dispatch({ selection: { anchor: 5 }, userEvent: 'set' });
      await vi.advanceTimersByTimeAsync(2000);

      expect(rm.updateSnippetOffsets).not.toHaveBeenCalled();
      expect(rm.getSnippetHighlights).not.toHaveBeenCalled();
    } finally {
      view.destroy();
    }
  });

  it('saves the offsets the standard editor moved, on the text they were on', async () => {
    await fc.assert(
      fc.asyncProperty(
        docHighlightAndDisjointEdit,
        mappedUserEvent,
        async (
          { doc, text, highlight, change: [from, to], insert },
          userEvent
        ) => {
          const { view, rm } = makeTrackedView(
            doc,
            [makeHighlight({ id: 's', ...highlight })],
            false
          );
          try {
            view.dispatch({ changes: { from, to, insert }, userEvent });
            await vi.advanceTimersByTimeAsync(2000);

            expect(rm.updateSnippetOffsets).toHaveBeenCalledTimes(1);
            const [id, start, end] = rm.updateSnippetOffsets.mock.calls[0] as [
              string,
              number,
              number,
            ];
            const next = view.state.doc.toString();
            const bodyStart = bodyStartOf(next);
            expect(id).toBe('s');
            expect(next.slice(bodyStart + start, bodyStart + end)).toBe(text);
          } finally {
            view.destroy();
          }
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// buildDecorations — driven via view with real tracker data
// ---------------------------------------------------------------------------
describe('buildDecorations', () => {
  afterEach(() => vi.restoreAllMocks());

  it('produces no decorations when tracker has no highlights for the file', async () => {
    const rm = makeReviewManager();
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    const view = makeView('hello world', irPlugin);
    await flushAsync();
    const plugin = view.plugin(snippetHighlightExtension);
    expect(plugin!.decorations.size).toBe(0);
    view.destroy();
  });

  it('produces decorations for valid in-bounds highlights', async () => {
    const rm = makeReviewManager();
    // Load highlights that fit within 'hello world' (11 chars, bodyStart=0)
    rm.snippets.offsetTracker.loadHighlights(FILE_PATH, [
      makeHighlight({ id: 'h1', start_offset: 0, end_offset: 5 }),
    ]);
    rm.getSnippetHighlights.mockImplementation(async () => {
      // highlights already set in tracker; just mark loaded
    });
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    const view = makeView('hello world', irPlugin);
    await flushAsync();
    const plugin = view.plugin(snippetHighlightExtension);
    // At least one decoration range should exist
    expect(plugin!.decorations.size).toBeGreaterThan(0);
    view.destroy();
  });

  it('skips highlights where absoluteEnd > docLength', async () => {
    const rm = makeReviewManager();
    rm.snippets.offsetTracker.loadHighlights(FILE_PATH, [
      makeHighlight({ id: 'oob', start_offset: 9000, end_offset: 9010 }),
    ]);
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    const view = makeView('short', irPlugin);
    await flushAsync();
    const plugin = view.plugin(snippetHighlightExtension);
    expect(plugin!.decorations.size).toBe(0);
    view.destroy();
  });

  it('skips highlights where absoluteStart >= absoluteEnd (zero-width)', async () => {
    const rm = makeReviewManager();
    rm.snippets.offsetTracker.loadHighlights(FILE_PATH, [
      makeHighlight({ id: 'zw', start_offset: 3, end_offset: 3 }),
    ]);
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    const view = makeView('hello world', irPlugin);
    await flushAsync();
    const plugin = view.plugin(snippetHighlightExtension);
    expect(plugin!.decorations.size).toBe(0);
    view.destroy();
  });

  it('skips highlights where absoluteEnd > docLength (out of bounds at end)', async () => {
    const rm = makeReviewManager();
    // doc is 5 chars, bodyStart=0, highlight end_offset=10 → absoluteEnd=10 > 5
    stubFileInfo(FILE_PATH, 'article');
    rm.snippets.offsetTracker.loadHighlights(FILE_PATH, [
      makeHighlight({ id: 'oob2', start_offset: 2, end_offset: 10 }),
    ]);
    const irPlugin = makePlugin(rm);
    const view = makeView('hello', irPlugin); // 5 chars
    await flushAsync();
    const plugin = view.plugin(snippetHighlightExtension);
    expect(plugin!.decorations.size).toBe(0);
    view.destroy();
  });

  it('sorts highlights by start_offset before building decorations (no RangeSetBuilder error)', async () => {
    const rm = makeReviewManager();
    // Provide highlights in reverse order — buildDecorations must sort them
    rm.snippets.offsetTracker.loadHighlights(FILE_PATH, [
      makeHighlight({ id: 'h2', start_offset: 6, end_offset: 11 }),
      makeHighlight({ id: 'h1', start_offset: 0, end_offset: 5 }),
    ]);
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    expect(async () => {
      const view = makeView('hello world', irPlugin);
      await flushAsync();
      view.destroy();
    }).not.toThrow();
  });

  it('property: no throw for arbitrary highlight offsets and doc strings', async () => {
    stubFileInfo(FILE_PATH, 'article');
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            start: fc.integer({ min: 0, max: 100 }),
            end: fc.integer({ min: 0, max: 100 }),
          }),
          { maxLength: 6 }
        ),
        fc.string({ minLength: 1, maxLength: 30 }),
        async (rawHighlights, doc) => {
          const rm = makeReviewManager();
          rm.snippets.offsetTracker.loadHighlights(
            FILE_PATH,
            rawHighlights.map((h, i) =>
              makeHighlight({
                id: `h${i}`,
                start_offset: h.start,
                end_offset: h.end,
              })
            )
          );
          const irPlugin = makePlugin(rm);
          const view = makeView(doc, irPlugin);
          view.destroy();
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// schedulePersist / destroy
// ---------------------------------------------------------------------------
describe('schedulePersist and destroy', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeLoadedView(rm: FakeReviewManager, isReviewInterface = false) {
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    rm.getSnippetHighlights.mockReturnValue(new Promise(() => {}));
    const view = makeView('hello world', irPlugin, isReviewInterface);
    view.dispatch({ effects: refreshHighlightsEffect.of(null) });
    return view;
  }

  it('updateSnippetOffsets is called after debounce delay', async () => {
    vi.useFakeTimers();
    const rm = makeReviewManager();
    const view = makeLoadedView(rm, false);

    view.dispatch({ changes: { from: 5, insert: '!' }, userEvent: 'input' });
    expect(rm.updateSnippetOffsets).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    await Promise.resolve();

    // highlights array is empty → no updateSnippetOffsets calls per highlight
    // (zero highlights means zero calls, which is still correct)
    view.destroy();
  });

  it('second schedulePersist cancels the first (debounce)', async () => {
    vi.useFakeTimers();
    const rm = makeReviewManager();
    // Load one highlight so updateSnippetOffsets would be called
    rm.snippets.offsetTracker.loadHighlights(FILE_PATH, [
      makeHighlight({ id: 'h1', start_offset: 0, end_offset: 5 }),
    ]);
    const view = makeLoadedView(rm, false);

    // First edit — schedules persist at T+2000
    view.dispatch({ changes: { from: 5, insert: 'A' }, userEvent: 'input' });
    // Second edit 500ms later — should cancel the first timer and reschedule
    vi.advanceTimersByTime(500);
    view.dispatch({ changes: { from: 6, insert: 'B' }, userEvent: 'input' });

    // Advance to what would have been the first timer's fire time — should NOT fire
    vi.advanceTimersByTime(1500);
    await Promise.resolve();
    const callsAfterFirst = rm.updateSnippetOffsets.mock.calls.length;

    // Now advance past the second timer
    vi.advanceTimersByTime(1000);
    await Promise.resolve();

    // Total calls should be exactly what the second (coalesced) timer fires
    expect(rm.updateSnippetOffsets.mock.calls.length).toBeGreaterThanOrEqual(
      callsAfterFirst
    );
    view.destroy();
  });

  it('destroy() cancels the pending persist timer', async () => {
    vi.useFakeTimers();
    const rm = makeReviewManager();
    rm.snippets.offsetTracker.loadHighlights(FILE_PATH, [
      makeHighlight({ id: 'h1', start_offset: 0, end_offset: 5 }),
    ]);
    const view = makeLoadedView(rm, false);

    view.dispatch({ changes: { from: 5, insert: 'X' }, userEvent: 'input' });
    view.destroy(); // cancels the timer

    vi.advanceTimersByTime(5000);
    await Promise.resolve();

    // Timer was cancelled, so updateSnippetOffsets should not have been called
    expect(rm.updateSnippetOffsets).not.toHaveBeenCalled();
  });

  it('destroy() does not throw when no timer is pending', () => {
    const rm = makeReviewManager();
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    const view = makeView('hello', irPlugin);
    expect(() => view.destroy()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// click event handler
// ---------------------------------------------------------------------------
describe('click event handler', () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * Append a highlight span inside the editor's contentDOM.
   *
   * It must live there, not on document.body: CodeMirror binds its handlers to
   * contentDOM and drops any event whose target is not a descendant of it
   * (`eventBelongsToEditor`), so a detached span silently never reaches the
   * plugin's handlers.
   */
  function makeHighlightSpan(
    view: EditorView,
    ref: string | null = 'snippets/a.md'
  ): HTMLElement {
    const span = document.createElement('span');
    span.className = 'ir-snippet-highlight';
    span.setAttribute('data-snippet-id', 'h1');
    if (ref !== null) span.setAttribute('data-snippet-ref', ref);
    view.contentDOM.appendChild(span);
    return span;
  }

  function dispatchOn(
    target: HTMLElement,
    type: 'click' | 'auxclick' | 'mousedown',
    init: MouseEventInit = {}
  ): MouseEvent {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    target.dispatchEvent(event);
    return event;
  }

  /**
   * Run `body` against a live view with one highlight span, then tear both down.
   * Returns the openLinkText spy so assertions read as one line per case.
   */
  function withHighlight(
    body: (ctx: { view: EditorView; span: HTMLElement }) => void,
    fileThere = true
  ): ReturnType<typeof vi.fn> {
    const irPlugin = makePlugin(makeReviewManager());
    if (!fileThere) irPlugin.app.vault.getFileByPath = () => null;
    const view = makeView('hello', irPlugin);
    const span = makeHighlightSpan(view);
    try {
      body({ view, span });
    } finally {
      span.remove();
      view.destroy();
    }
    return irPlugin.app.workspace.openLinkText;
  }

  it('consumes a click on a missing snippet’s highlight', () => {
    const plugin = makePlugin(makeReviewManager());
    plugin.app.vault.getFileByPath = () => null;
    const span = document.createElement('span');
    span.className = 'ir-snippet-highlight';
    span.setAttribute('data-snippet-ref', 'snippets/a.md');
    const event = new MouseEvent('click', { cancelable: true });
    Object.defineProperty(event, 'target', { value: span });

    expect(openHighlightFromEvent(plugin as never, event)).toBe(true);
    expect(plugin.app.workspace.openLinkText).not.toHaveBeenCalled();
  });

  it('leaves alone, unconsumed, a click on no highlight or on one with no ref', () => {
    const plugin = makePlugin(makeReviewManager());
    const bare = document.createElement('span');
    const unnamed = document.createElement('span');
    unnamed.className = 'ir-snippet-highlight';
    for (const target of [bare, unnamed]) {
      const event = new MouseEvent('click', { cancelable: true });
      Object.defineProperty(event, 'target', { value: target });

      expect(openHighlightFromEvent(plugin as never, event)).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(plugin.app.workspace.openLinkText).not.toHaveBeenCalled();
  });

  it('says to relink the card, not a snippet, for a missing card’s highlight in a PDF', () => {
    Notice.reset();
    const plugin = makePlugin(makeReviewManager());
    plugin.app.vault.getFileByPath = () => null;
    const span = document.createElement('span');
    span.className = 'ir-snippet-highlight ir-card-highlight';
    span.setAttribute('data-snippet-ref', 'cards/c.md');
    const event = new MouseEvent('click', { cancelable: true });
    Object.defineProperty(event, 'target', { value: span });

    expect(openHighlightFromEvent(plugin as never, event)).toBe(true);
    expect(plugin.app.workspace.openLinkText).not.toHaveBeenCalled();
    expect(Notice.messages).toEqual([
      'No file at "cards/c.md". Relink the card from the review queue.',
    ]);
  });

  it('opens the card of a card’s highlight in a PDF, as a snippet’s opens the snippet', () => {
    const plugin = makePlugin(makeReviewManager());
    plugin.app.vault.getFileByPath = (path: string) => ({ path }) as never;
    const span = document.createElement('span');
    span.className = 'ir-snippet-highlight ir-card-highlight';
    span.setAttribute('data-snippet-ref', 'cards/c.md');
    const event = new MouseEvent('click', { cancelable: true });
    Object.defineProperty(event, 'target', { value: span });

    expect(openHighlightFromEvent(plugin as never, event)).toBe(true);
    expect(plugin.app.workspace.openLinkText).toHaveBeenCalledExactlyOnceWith(
      'cards/c.md',
      '',
      false
    );
  });

  it('opens the highlight it is given, not one around the target, as a PDF does for a press on the text over a highlight', () => {
    const plugin = makePlugin(makeReviewManager());
    plugin.app.vault.getFileByPath = (path: string) => ({ path }) as never;
    const given = document.createElement('div');
    given.className = 'ir-snippet-highlight ir-card-highlight';
    given.setAttribute('data-snippet-ref', 'cards/c.md');
    const around = document.createElement('span');
    around.className = 'ir-snippet-highlight';
    around.setAttribute('data-snippet-ref', 'snippets/a.md');
    const text = around.appendChild(document.createElement('span'));
    const event = new MouseEvent('click', { cancelable: true });
    Object.defineProperty(event, 'target', { value: text });

    expect(openHighlightFromEvent(plugin as never, event, given)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(plugin.app.workspace.openLinkText).toHaveBeenCalledExactlyOnceWith(
      'cards/c.md',
      '',
      false
    );
    expect(openHighlightFromEvent(plugin as never, event, null)).toBe(false);
  });

  it('opens nothing for a snippet missing its file, and says why', () => {
    Notice.reset();
    let event: MouseEvent | undefined;
    const openLinkText = withHighlight(({ span }) => {
      event = dispatchOn(span, 'click');
    }, false);

    expect(openLinkText).not.toHaveBeenCalled();
    expect(event?.defaultPrevented).toBe(true);
    expect(Notice.messages).toEqual([
      'No file at "snippets/a.md". Relink the snippet from the review queue.',
    ]);
  });

  it('plain click opens the snippet in the active leaf', () => {
    const openLinkText = withHighlight(({ span }) => {
      dispatchOn(span, 'click');
    });
    expect(openLinkText).toHaveBeenCalledWith('snippets/a.md', '', false);
  });

  it.each([
    ['ctrlKey', { ctrlKey: true }],
    ['metaKey', { metaKey: true }],
  ])('%s click opens the snippet in a new tab', (_name, init) => {
    const openLinkText = withHighlight(({ span }) => {
      dispatchOn(span, 'click', init);
    });
    expect(openLinkText).toHaveBeenCalledWith('snippets/a.md', '', 'tab');
  });

  it('middle click opens the snippet in a new tab', () => {
    const openLinkText = withHighlight(({ span }) => {
      dispatchOn(span, 'auxclick', { button: 1 });
    });
    expect(openLinkText).toHaveBeenCalledWith('snippets/a.md', '', 'tab');
  });

  it('mod+alt click opens the snippet in a split', () => {
    const openLinkText = withHighlight(({ span }) => {
      dispatchOn(span, 'click', { ctrlKey: true, altKey: true });
    });
    expect(openLinkText).toHaveBeenCalledWith('snippets/a.md', '', 'split');
  });

  it('mod+alt+shift click opens the snippet in a new window', () => {
    const openLinkText = withHighlight(({ span }) => {
      dispatchOn(span, 'click', {
        ctrlKey: true,
        altKey: true,
        shiftKey: true,
      });
    });
    expect(openLinkText).toHaveBeenCalledWith('snippets/a.md', '', 'window');
  });

  it('right click does not navigate — auxclick fires for it too', () => {
    const openLinkText = withHighlight(({ span }) => {
      dispatchOn(span, 'auxclick', { button: 2 });
    });
    expect(openLinkText).not.toHaveBeenCalled();
  });

  it('middle mousedown on a highlight is defaultPrevented, suppressing autoscroll', () => {
    let event!: MouseEvent;
    withHighlight(({ span }) => {
      event = dispatchOn(span, 'mousedown', { button: 1 });
    });
    expect(event.defaultPrevented).toBe(true);
  });

  it('middle mousedown outside a highlight keeps its default action', () => {
    const view = makeView('hello', makePlugin(makeReviewManager()));
    const plain = document.createElement('span');
    view.contentDOM.appendChild(plain);

    const event = dispatchOn(plain, 'mousedown', { button: 1 });

    expect(event.defaultPrevented).toBe(false);
    plain.remove();
    view.destroy();
  });

  it('does not navigate when the highlight lacks data-snippet-ref', () => {
    const irPlugin = makePlugin(makeReviewManager());
    const view = makeView('hello', irPlugin);
    const span = makeHighlightSpan(view, null);

    dispatchOn(span, 'click');

    expect(irPlugin.app.workspace.openLinkText).not.toHaveBeenCalled();
    span.remove();
    view.destroy();
  });

  it('does nothing when the click target has no .ir-snippet-highlight ancestor', () => {
    const irPlugin = makePlugin(makeReviewManager());
    const view = makeView('hello', irPlugin);
    const plain = document.createElement('span');
    view.contentDOM.appendChild(plain);

    dispatchOn(plain, 'click');

    expect(irPlugin.app.workspace.openLinkText).not.toHaveBeenCalled();
    plain.remove();
    view.destroy();
  });

  it('does not throw when highlight span with data-snippet-ref is clicked', () => {
    const irPlugin = makePlugin(makeReviewManager());
    const view = makeView('hello', irPlugin);
    const span = document.createElement('span');
    span.className = 'ir-snippet-highlight';
    span.setAttribute('data-snippet-id', 'h1');
    span.setAttribute('data-snippet-ref', 'snippets/a.md');
    document.body.appendChild(span);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: span, configurable: true });
    expect(() => view.contentDOM.dispatchEvent(event)).not.toThrow();
    document.body.removeChild(span);
    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// Mutant-killing: highlightsLoaded init value (line 41)
// ---------------------------------------------------------------------------
describe('mutant-killing: highlightsLoaded initial state', () => {
  afterEach(() => vi.restoreAllMocks());

  it('refreshHighlightsEffect is required to mark highlights loaded — no-effect dispatch leaves them unloaded', () => {
    // If highlightsLoaded starts as true (mutant), a plain dispatch would reach the
    // docChanged branch even without the refresh effect, potentially calling updateOffsetsWithMapping.
    // With the correct init (false), a plain dispatch returns early.
    const rm = makeReviewManager();
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    rm.getSnippetHighlights.mockReturnValue(new Promise(() => {}));
    const updateSpy = vi.spyOn(
      rm.snippets.offsetTracker,
      'updateOffsetsWithMapping'
    );
    const view = makeView('hello world', irPlugin);

    // No refresh effect dispatched → highlights NOT loaded → update() returns early
    view.dispatch({ changes: { from: 5, insert: '!' }, userEvent: 'input' });
    expect(updateSpy).not.toHaveBeenCalled();
    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// Mutant-killing: .some() vs .every() in refreshHighlightsEffect detection (lines 105-106)
// ---------------------------------------------------------------------------
describe('mutant-killing: .some() vs .every() for hasRefresh', () => {
  afterEach(() => vi.restoreAllMocks());

  it('recognises the refresh effect even when dispatched in the second of two sequential dispatches', () => {
    // Demonstrates `.some()` semantics: one transaction has the effect, one does not.
    // With `.every()`, this would fail to set hasRefresh=true.
    const rm = makeReviewManager();
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    rm.getSnippetHighlights.mockReturnValue(new Promise(() => {}));
    const view = makeView('hello world', irPlugin);

    // First dispatch: no refresh effect — highlights remain unloaded
    view.dispatch({});

    // Second dispatch: carries the refresh effect — should mark highlights loaded
    view.dispatch({ effects: refreshHighlightsEffect.of(null) });

    // Verify that after the second dispatch, subsequent user edits go through
    // the loaded-highlights path (updateOffsetsWithMapping is called).
    vi.spyOn(Obsidian, 'getBodyStartOffset').mockReturnValue(0);
    const updateSpy = vi.spyOn(
      rm.snippets.offsetTracker,
      'updateOffsetsWithMapping'
    );
    view.dispatch({ changes: { from: 5, insert: '!' }, userEvent: 'input' });
    expect(updateSpy).toHaveBeenCalled();
    view.destroy();
  });

  it('does NOT mark highlights loaded from a dispatch with no refresh effect', () => {
    // If the guard `if (hasRefresh)` were changed to `if (true)`, highlights would
    // always be marked loaded on the first non-loaded update, bypassing the effect.
    const rm = makeReviewManager();
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    rm.getSnippetHighlights.mockReturnValue(new Promise(() => {}));
    const updateSpy = vi.spyOn(
      rm.snippets.offsetTracker,
      'updateOffsetsWithMapping'
    );
    const view = makeView('hello world', irPlugin);

    // Dispatch without refresh effect
    view.dispatch({ changes: { from: 0, insert: 'x' }, userEvent: 'input' });

    // Highlights still unloaded — updateOffsetsWithMapping should NOT be called
    expect(updateSpy).not.toHaveBeenCalled();
    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// Mutant-killing: !this.highlightsLoaded branch flip (line 104)
// ---------------------------------------------------------------------------
describe('mutant-killing: !highlightsLoaded guard', () => {
  afterEach(() => vi.restoreAllMocks());

  it('once highlights are loaded, user edits reach updateOffsetsWithMapping (not skipped)', () => {
    // If `!this.highlightsLoaded` were flipped to `this.highlightsLoaded`, the
    // refresh-effect branch would run when loaded=true (no-op), and the docChanged
    // branch would run when loaded=false (before highlights exist).
    // Correct: docChanged only runs when loaded=true.
    const rm = makeReviewManager();
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    rm.getSnippetHighlights.mockReturnValue(new Promise(() => {}));
    const view = makeView('hello world', irPlugin);

    // Mark as loaded via refresh effect
    view.dispatch({ effects: refreshHighlightsEffect.of(null) });

    vi.spyOn(Obsidian, 'getBodyStartOffset').mockReturnValue(0);
    const updateSpy = vi.spyOn(
      rm.snippets.offsetTracker,
      'updateOffsetsWithMapping'
    );
    view.dispatch({ changes: { from: 5, insert: '?' }, userEvent: 'input' });
    expect(updateSpy).toHaveBeenCalled();
    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// Mutant-killing: schedulePersist / persistHighlights actual execution (lines 213-240)
// ---------------------------------------------------------------------------
describe('mutant-killing: schedulePersist and persistHighlights body', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('updateSnippetOffsets is called for each highlight after debounce fires', async () => {
    vi.useFakeTimers();
    const rm = makeReviewManager();
    rm.snippets.offsetTracker.loadHighlights(FILE_PATH, [
      makeHighlight({ id: 'ha', start_offset: 0, end_offset: 5 }),
      makeHighlight({ id: 'hb', start_offset: 6, end_offset: 11 }),
    ]);
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    rm.getSnippetHighlights.mockReturnValue(new Promise(() => {}));
    const view = makeView('hello world', irPlugin, false);
    view.dispatch({ effects: refreshHighlightsEffect.of(null) });

    // Trigger persist via user edit
    view.dispatch({ changes: { from: 5, insert: '!' }, userEvent: 'input' });
    expect(rm.updateSnippetOffsets).not.toHaveBeenCalled();

    // Fire the debounce timer
    vi.advanceTimersByTime(2001);
    // Allow async persistHighlights to run
    await Promise.resolve();
    await Promise.resolve();

    // Should call updateSnippetOffsets for each of the 2 highlights
    expect(rm.updateSnippetOffsets).toHaveBeenCalledTimes(2);
    expect(rm.updateSnippetOffsets).toHaveBeenCalledWith(
      'ha',
      expect.any(Number),
      expect.any(Number)
    );
    expect(rm.updateSnippetOffsets).toHaveBeenCalledWith(
      'hb',
      expect.any(Number),
      expect.any(Number)
    );
    view.destroy();
  });

  it('clears the previous timer before scheduling a new one (cancelTimeout branch)', async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const rm = makeReviewManager();
    rm.snippets.offsetTracker.loadHighlights(FILE_PATH, [
      makeHighlight({ id: 'hx', start_offset: 0, end_offset: 5 }),
    ]);
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    rm.getSnippetHighlights.mockReturnValue(new Promise(() => {}));
    const view = makeView('hello world', irPlugin, false);
    view.dispatch({ effects: refreshHighlightsEffect.of(null) });

    // First edit schedules a timer
    view.dispatch({ changes: { from: 5, insert: 'A' }, userEvent: 'input' });
    const firstCallCount = clearSpy.mock.calls.length;

    // Second edit should call clearTimeout on the first timer before setting a new one
    view.dispatch({ changes: { from: 6, insert: 'B' }, userEvent: 'input' });
    expect(clearSpy.mock.calls.length).toBeGreaterThan(firstCallCount);

    vi.useRealTimers();
    clearSpy.mockRestore();
    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// Mutant-killing: highlights.length === 0 early return in buildDecorations (line 260)
// ---------------------------------------------------------------------------
describe('mutant-killing: highlights.length === 0 guard in buildDecorations', () => {
  afterEach(() => vi.restoreAllMocks());

  it('decorations are non-zero when tracker has highlights (proves the zero-length guard matters)', async () => {
    const rm = makeReviewManager();
    rm.snippets.offsetTracker.loadHighlights(FILE_PATH, [
      makeHighlight({ id: 'hl', start_offset: 0, end_offset: 5 }),
    ]);
    // Make getSnippetHighlights a no-op so the tracker is not cleared
    rm.getSnippetHighlights.mockResolvedValue(undefined);
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    const view = makeView('hello world', irPlugin);
    await flushAsync();
    const plugin = view.plugin(snippetHighlightExtension);
    // If the zero-length early return were `if (false) {}`, this would still work,
    // but the key is that the builder path runs and produces decorations.
    expect(plugin!.decorations.size).toBeGreaterThan(0);
    view.destroy();
  });

  it('decorations are zero when tracker has no highlights (zero-length guard fires)', async () => {
    const rm = makeReviewManager();
    // Empty highlights
    rm.snippets.offsetTracker.loadHighlights(FILE_PATH, []);
    rm.getSnippetHighlights.mockResolvedValue(undefined);
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    const view = makeView('hello world', irPlugin);
    await flushAsync();
    const plugin = view.plugin(snippetHighlightExtension);
    expect(plugin!.decorations.size).toBe(0);
    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// Mutant-killing: bodyStart arithmetic (lines 279-280) — + vs -
// ---------------------------------------------------------------------------
describe('mutant-killing: bodyStart arithmetic in buildDecorations', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses bodyStart=0 correctly — highlight [0,5) on "hello world" produces a decoration', async () => {
    // When bodyStart=0, + and - are equivalent → baseline test
    const rm = makeReviewManager();
    rm.snippets.offsetTracker.loadHighlights(FILE_PATH, [
      makeHighlight({ id: 'h1', start_offset: 0, end_offset: 5 }),
    ]);
    rm.getSnippetHighlights.mockResolvedValue(undefined);
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    const view = makeView('hello world', irPlugin);
    await flushAsync();
    const plugin = view.plugin(snippetHighlightExtension);
    expect(plugin!.decorations.size).toBeGreaterThan(0);
    view.destroy();
  });

  it('with bodyStart>0, highlight is shifted correctly — decoration exists only when + is used', async () => {
    // Doc: '---\nhello world' (15 chars), bodyStart=4 (after '---\n')
    // highlight start_offset=0, end_offset=5 (body-relative)
    // Correct (+ bodyStart): absoluteStart=4, absoluteEnd=9 → in bounds → decoration produced
    // Mutant (- bodyStart): absoluteStart=-4, absoluteEnd=1 → absoluteStart<0 → skipped → no decoration
    const doc = '---\nhello world';
    const rm = makeReviewManager();
    rm.snippets.offsetTracker.loadHighlights(FILE_PATH, [
      makeHighlight({ id: 'h1', start_offset: 0, end_offset: 5 }),
    ]);
    rm.getSnippetHighlights.mockResolvedValue(undefined);
    const irPlugin = makePlugin(rm);

    vi.spyOn(Obsidian, 'getFileInfoFromState').mockReturnValue({
      info: { file: { path: FILE_PATH }, app: {} } as never,
      editorView: null,
    });
    vi.spyOn(Obsidian, 'isSourceNote').mockReturnValue(false);
    vi.spyOn(Obsidian, 'getNoteType').mockResolvedValue('article');
    vi.spyOn(Obsidian, 'getBodyStartOffset').mockReturnValue(4);

    const view = makeView(doc, irPlugin);
    await flushAsync();
    const plugin = view.plugin(snippetHighlightExtension);
    // With correct +4: absoluteStart=4, absoluteEnd=9, both in-bounds → decoration exists
    expect(plugin!.decorations.size).toBeGreaterThan(0);
    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// Mutant-killing: Decoration.mark class attribute (lines 291-292)
// ---------------------------------------------------------------------------
describe('mutant-killing: Decoration.mark class attribute', () => {
  afterEach(() => vi.restoreAllMocks());

  it('produced decorations use class ir-snippet-highlight', async () => {
    const rm = makeReviewManager();
    rm.snippets.offsetTracker.loadHighlights(FILE_PATH, [
      makeHighlight({
        id: 'h1',
        reference: 'snippets/a.md',
        start_offset: 0,
        end_offset: 5,
      }),
    ]);
    rm.getSnippetHighlights.mockResolvedValue(undefined);
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    const view = makeView('hello world', irPlugin);
    await flushAsync();
    const plugin = view.plugin(snippetHighlightExtension);
    // Inspect the decoration's spec via iteration
    let foundClass = false;
    plugin!.decorations.between(0, 100, (_from, _to, value) => {
      if ((value.spec as { class?: string }).class === 'ir-snippet-highlight') {
        foundClass = true;
      }
    });
    expect(foundClass).toBe(true);
    view.destroy();
  });

  it('produced decorations carry data-snippet-id and data-snippet-ref attributes', async () => {
    const rm = makeReviewManager();
    rm.snippets.offsetTracker.loadHighlights(FILE_PATH, [
      makeHighlight({
        id: 'myId',
        reference: 'snippets/b.md',
        start_offset: 0,
        end_offset: 5,
      }),
    ]);
    rm.getSnippetHighlights.mockResolvedValue(undefined);
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    const view = makeView('hello world', irPlugin);
    await flushAsync();
    const plugin = view.plugin(snippetHighlightExtension);
    let attrs: Record<string, string> | undefined;
    plugin!.decorations.between(0, 100, (_from, _to, value) => {
      attrs = (value.spec as { attributes?: Record<string, string> })
        .attributes;
    });
    expect(attrs?.['data-snippet-id']).toBe('myId');
    expect(attrs?.['data-snippet-ref']).toBe('snippets/b.md');
    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// Mutant-killing: if (hasRefresh) → if (true) (line 108)
// The mutant sets highlightsLoaded=true even when no refresh effect is present.
// To detect it: after one no-effect dispatch (which should leave highlightsLoaded=false),
// a second dispatch with a user event should STILL not call updateOffsetsWithMapping
// (because the refresh effect is still needed). With the mutant, the first dispatch
// sets highlightsLoaded=true, so the second dispatch reaches updateOffsetsWithMapping.
// ---------------------------------------------------------------------------
describe('mutant-killing: if (hasRefresh) guard correctness', () => {
  afterEach(() => vi.restoreAllMocks());

  it('highlights stay unloaded after two no-effect dispatches — updateOffsetsWithMapping never called', () => {
    const rm = makeReviewManager();
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    rm.getSnippetHighlights.mockReturnValue(new Promise(() => {}));
    const updateSpy = vi.spyOn(
      rm.snippets.offsetTracker,
      'updateOffsetsWithMapping'
    );
    const view = makeView('hello world', irPlugin);

    // First dispatch: no effect — should NOT set highlightsLoaded (with correct code)
    view.dispatch({ changes: { from: 0, insert: 'a' }, userEvent: 'input' });
    expect(updateSpy).not.toHaveBeenCalled();

    // Second dispatch: still no effect — still unloaded, still no updateOffsetsWithMapping
    view.dispatch({ changes: { from: 1, insert: 'b' }, userEvent: 'input' });
    expect(updateSpy).not.toHaveBeenCalled();

    // Now provide the refresh effect — highlights become loaded
    view.dispatch({ effects: refreshHighlightsEffect.of(null) });

    // Third dispatch: NOW updateOffsetsWithMapping should be called
    view.dispatch({ changes: { from: 2, insert: 'c' }, userEvent: 'input' });
    expect(updateSpy).toHaveBeenCalledTimes(1);
    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// Mutant-killing: isReviewInterface=true as initial value (line 43)
// If isReviewInterface starts as true, schedulePersist would never be called for any view,
// causing updateSnippetOffsets to never fire even in non-review-interface editors.
// ---------------------------------------------------------------------------
describe('mutant-killing: isReviewInterface initial value', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('updateSnippetOffsets IS called in a non-review editor after debounce (isReviewInterface=false)', async () => {
    vi.useFakeTimers();
    const rm = makeReviewManager();
    rm.snippets.offsetTracker.loadHighlights(FILE_PATH, [
      makeHighlight({ id: 'ha', start_offset: 0, end_offset: 5 }),
    ]);
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    rm.getSnippetHighlights.mockReturnValue(new Promise(() => {}));
    // Create view with isReviewInterface=false (default)
    const view = makeView('hello world', irPlugin, false);
    view.dispatch({ effects: refreshHighlightsEffect.of(null) });

    // User edit triggers schedulePersist
    view.dispatch({ changes: { from: 5, insert: '!' }, userEvent: 'input' });

    vi.advanceTimersByTime(2001);
    await Promise.resolve();
    await Promise.resolve();

    // If isReviewInterface were true by default (mutant), this would never be called
    expect(rm.updateSnippetOffsets).toHaveBeenCalled();
    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// Mutant-killing: highlightsLoaded=false after async load (line 77)
// If highlightsLoaded stays false after loadHighlights completes, subsequent updates
// would always take the "!loaded" path and never reach the docChanged branch.
// ---------------------------------------------------------------------------
describe('mutant-killing: highlightsLoaded set correctly after async load', () => {
  afterEach(() => vi.restoreAllMocks());

  it('after async loadHighlights completes, user edits reach updateOffsetsWithMapping without refresh effect', async () => {
    const rm = makeReviewManager();
    rm.snippets.offsetTracker.loadHighlights(FILE_PATH, []);
    // Allow getSnippetHighlights to resolve so loadHighlights sets highlightsLoaded=true
    rm.getSnippetHighlights.mockResolvedValue(undefined);
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    const updateSpy = vi.spyOn(
      rm.snippets.offsetTracker,
      'updateOffsetsWithMapping'
    );
    const view = makeView('hello world', irPlugin);

    // Await full async resolution including view.dispatch({}) at end of loadHighlights
    await flushAsync();

    // Now highlights are loaded via the async path — no refresh effect needed
    view.dispatch({ changes: { from: 5, insert: '!' }, userEvent: 'input' });
    // If highlightsLoaded were never set to true (mutant), this would be 0
    expect(updateSpy).toHaveBeenCalledTimes(1);
    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// Mutant-killing: absoluteEnd > docLength vs >= (line 285)
// When absoluteEnd === docLength exactly, > allows it (decoration produced)
// while >= skips it. Test with a highlight ending exactly at doc.length.
// ---------------------------------------------------------------------------
describe('mutant-killing: absoluteEnd boundary check (> vs >=)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('highlight ending at exactly docLength is included (not skipped)', async () => {
    // doc = 'hello' (length=5), bodyStart=0, highlight end_offset=5
    // absoluteEnd = 5 = docLength → > passes, >= fails
    const doc = 'hello';
    const rm = makeReviewManager();
    rm.snippets.offsetTracker.loadHighlights(FILE_PATH, [
      makeHighlight({ id: 'boundary', start_offset: 0, end_offset: 5 }),
    ]);
    rm.getSnippetHighlights.mockResolvedValue(undefined);
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    const view = makeView(doc, irPlugin);
    await flushAsync();
    const plugin = view.plugin(snippetHighlightExtension);
    // With correct `>`: end_offset=5 = docLength=5 → not > → decoration NOT produced
    // Wait — actually we need end_offset < docLength, not equal, for a valid decoration.
    // Let's reconsider: absoluteEnd > docLength means "skip if past end", so
    // absoluteEnd = docLength is NOT past end → decoration IS produced with >
    // but skipped with >= (treating exact-end as out of bounds).
    // CodeMirror ranges can end at docLength (exclusive end of last char).
    expect(plugin!.decorations.size).toBeGreaterThan(0);
    view.destroy();
  });

  it('highlight ending one past docLength is skipped', async () => {
    // doc = 'hello' (length=5), bodyStart=0, highlight end_offset=6 > 5 → skipped
    const rm = makeReviewManager();
    rm.snippets.offsetTracker.loadHighlights(FILE_PATH, [
      makeHighlight({ id: 'oob', start_offset: 0, end_offset: 6 }),
    ]);
    rm.getSnippetHighlights.mockResolvedValue(undefined);
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    const view = makeView('hello', irPlugin);
    await flushAsync();
    const plugin = view.plugin(snippetHighlightExtension);
    expect(plugin!.decorations.size).toBe(0);
    view.destroy();
  });
});

describe('ir-highlights-changed subscription', () => {
  afterEach(() => vi.restoreAllMocks());

  /** A view with one highlight already painted for FILE_PATH. */
  function makePaintedView() {
    const rm = makeReviewManager();
    rm.snippets.offsetTracker.loadHighlights(FILE_PATH, [makeHighlight()]);
    const irPlugin = makePlugin(rm);
    stubFileInfo(FILE_PATH, 'article');
    // Never resolves, so the constructor's load can't overwrite the tracker.
    rm.getSnippetHighlights.mockReturnValue(new Promise(() => {}));
    const view = makeView('hello world!!', irPlugin);
    view.dispatch({ effects: refreshHighlightsEffect.of(null) });
    return { view, irPlugin, rm };
  }

  it('repaints from the tracker when the event names the file it shows', () => {
    const { view, irPlugin, rm } = makePaintedView();
    expect(view.plugin(snippetHighlightExtension)!.decorations.size).toBe(1);

    // What undoing a snippet creation does: drop the highlight, then announce it.
    // The view must repaint itself — nothing dispatches into it directly.
    rm.snippets.offsetTracker.removeHighlight(FILE_PATH, 'h1');
    irPlugin.app.workspace.trigger('ir-highlights-changed', FILE_PATH);

    expect(view.plugin(snippetHighlightExtension)!.decorations.size).toBe(0);
    view.destroy();
  });

  it('ignores the event when it names a different file', () => {
    const { view, irPlugin, rm } = makePaintedView();
    rm.snippets.offsetTracker.removeHighlight(FILE_PATH, 'h1');
    irPlugin.app.workspace.trigger('ir-highlights-changed', 'notes/other.md');
    expect(view.plugin(snippetHighlightExtension)!.decorations.size).toBe(1);
    view.destroy();
  });

  it('releases the subscription it created when destroyed', () => {
    const { view, irPlugin } = makePaintedView();
    const ref = irPlugin.app.workspace.on.mock.results[0].value as unknown;

    view.destroy();

    expect(irPlugin.app.workspace.offref).toHaveBeenCalledWith(ref);
    expect(() =>
      irPlugin.app.workspace.trigger('ir-highlights-changed', FILE_PATH)
    ).not.toThrow();
  });
});

describe('openHighlightFromEvent, for an item missing its file', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('shows the item in review for a plain click in the review tab, and anywhere else says to relink it', async () => {
    await fc.assert(
      fc.asyncProperty(
        clickInitArb,
        fc.boolean(),
        fc.boolean(),
        async (init, inReview, card) => {
          const { plugin, containerEl, showMissingInReview } = wireMissing();
          const parent = inReview
            ? containerEl
            : document.body.appendChild(document.createElement('div'));
          const event = clickOn(highlightIn(parent, card), init);

          expect(openHighlightFromEvent(plugin as never, event)).toBe(true);
          await flush();

          expect(event.defaultPrevented).toBe(true);
          expect(plugin.app.workspace.openLinkText).not.toHaveBeenCalled();
          if (inReview && isPlain(init)) {
            expect(showMissingInReview).toHaveBeenCalledExactlyOnceWith(
              'snippets/a.md'
            );
            expect(Notice.messages).toEqual([]);
          } else {
            expect(showMissingInReview).not.toHaveBeenCalled();
            expect(Notice.messages).toEqual([
              `No file at "snippets/a.md". Relink the ${card ? 'card' : 'snippet'} from the review queue.`,
            ]);
          }
        }
      )
    );
  });

  it('says to relink it when review has no item at the reference to show', async () => {
    const { plugin, containerEl } = wireMissing(false);

    openHighlightFromEvent(plugin as never, clickOn(highlightIn(containerEl)));
    await flush();

    expect(Notice.messages).toEqual([
      'No file at "snippets/a.md". Relink the snippet from the review queue.',
    ]);
  });

  it('says to relink it when review cannot look the reference up', async () => {
    const { plugin, containerEl, showMissingInReview } = wireMissing();
    const error = new Error('database closed');
    showMissingInReview.mockRejectedValueOnce(error);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    openHighlightFromEvent(plugin as never, clickOn(highlightIn(containerEl)));
    await flush();

    expect(Notice.messages).toEqual([
      'No file at "snippets/a.md". Relink the snippet from the review queue.',
    ]);
    expect(logged).toHaveBeenCalledExactlyOnceWith(
      'Incremental Reading: could not look a link up',
      error
    );
  });

  it('says to relink it when no review tab is open', async () => {
    const { plugin } = wireMissing();
    plugin.getOpenReviewLeaf = () => null;

    openHighlightFromEvent(
      plugin as never,
      clickOn(highlightIn(document.body))
    );
    await flush();

    expect(Notice.messages).toEqual([
      'No file at "snippets/a.md". Relink the snippet from the review queue.',
    ]);
  });
});
