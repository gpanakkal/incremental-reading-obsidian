import { actionCooldownFor } from '#/lib/action-cooldown';
import { Actions, itemName, type ActionStackEntry } from '#/lib/Actions';
import type {
  BulkOutcome,
  ImportEffect,
  ImportedArticle,
} from '#/lib/bulk-import/types';
import { CONTENT_TITLE_SLICE_LENGTH, MS_PER_DAY } from '#/lib/constants';
import * as contextFlash from '#/lib/context-flash';
import * as itemContext from '#/lib/item-context';
import { configureSuccessNotices } from '#/lib/notices';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import * as obsidianPdf from '#/lib/pdf/obsidian-pdf';
import * as pdfSelection from '#/lib/pdf/pdf-selection';
import {
  fetchCurrentItem,
  invalidateCurrentItemQuery,
} from '#/lib/query-client';
import { ActionRefusedError, refusalReason } from '#/lib/readiness';
import * as reviewPosition from '#/lib/review-position';
import type { SuccessNoticeLevel } from '#/lib/settings';
import {
  addCompletedReview,
  removeCompletedReview,
  removeSeenId,
  resetCurrentItem,
  setCurrentItemId,
  setSelectionMode,
  store,
  type SelectionKind,
} from '#/lib/store';
import {
  NOTE_TYPES,
  type MaybeMissingItem,
  type NoteType,
  type Readiness,
  type ReviewArticle,
  type ReviewCard,
  type ReviewItem,
  type ReviewSnippet,
  type ReviewText,
} from '#/lib/types';
import * as unimportArticle from '#/lib/unimport-article';
import { getContentSlice, getEndOfDay } from '#/lib/utils';
import type IncrementalReadingPlugin from '#/main';
import fc from 'fast-check';
// The Vitest alias points `obsidian` at this same file, so the class imported
// here is the one `ObsidianHelpers.notify` constructs — importing it by path is
// what gives TS the mock's `messages`/`reset`, which the real class lacks.
import { Notice } from '#/test/__mocks__/obsidian';
import { runOutMergeWait } from '#/test/item-vault';
import { showSuccessNotices } from '#/test/success-notices';
import * as CardAnswerModal from '#/views/CardAnswerModal';
import type ReviewView from '#/views/ReviewView';
import { EditorState } from '@codemirror/state';
import type { FileView, PaneType, TFile } from 'obsidian';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

vi.mock('#/lib/query-client', () => ({
  invalidateItemQuery: vi.fn().mockResolvedValue(undefined),
  invalidateCurrentItemQuery: vi.fn().mockResolvedValue(undefined),
  fetchCurrentItem: vi.fn().mockResolvedValue(null),
}));

// #region HELPERS

function makeTFile(basename: string, path?: string): TFile {
  return {
    path: path ?? `incremental-reading/articles/${basename}.md`,
    basename,
    name: `${basename}.md`,
    extension: 'md',
  } as unknown as TFile;
}

function makePlugin() {
  return {
    store: { dispatch: vi.fn() },
    settings: { dayRolloverOffset: 4 },
    reviewManager: {
      dismissItem: vi.fn().mockResolvedValue(undefined),
      unDismissItem: vi.fn().mockResolvedValue(undefined),
      repo: { writeRefusal: () => null, readiness: 'ready' },
    },
    app: {
      workspace: {
        activeEditor: null,
        getActiveViewOfType: vi.fn().mockReturnValue(null),
      },
    },
  } as unknown as IncrementalReadingPlugin;
}

function makeReviewItem(basename: string, pathOverride?: string): ReviewItem {
  return {
    data: {
      id: 'item-1',
      type: 'article',
      reference: pathOverride ?? `incremental-reading/articles/${basename}.md`,
      due: Date.now(),
      dismissed: false,
      deleted: false,
    },
    file: makeTFile(basename, pathOverride),
  } as unknown as ReviewItem;
}

/**
 * A plugin whose review writes all resolve to `reviewId`, and whose reversals
 * of them all run `reverse` — enough to follow what the review actions tell the
 * store without a database behind them.
 */
function makeReviewingPlugin({
  reviewId,
  dayRolloverOffset,
  reverse = vi.fn().mockResolvedValue(undefined),
}: {
  reviewId: string;
  dayRolloverOffset: number;
  reverse?: () => Promise<void>;
}) {
  return {
    store: { dispatch: vi.fn() },
    settings: { dayRolloverOffset },
    reviewManager: {
      reviewArticle: vi.fn().mockResolvedValue(reviewId),
      reviewSnippet: vi.fn().mockResolvedValue(reviewId),
      reviewCard: vi.fn().mockResolvedValue(reviewId),
      dismissItem: vi.fn().mockResolvedValue(undefined),
      unDismissItem: vi.fn().mockResolvedValue(undefined),
      articles: { undoReview: reverse },
      snippets: { undoReview: reverse },
      cards: { rollbackBeforeReview: reverse },
      repo: { writeRefusal: () => null, readiness: 'ready' },
    },
    app: {
      workspace: {
        activeEditor: null,
        getActiveViewOfType: vi.fn().mockReturnValue(null),
      },
    },
  } as unknown as IncrementalReadingPlugin & {
    store: { dispatch: ReturnType<typeof vi.fn> };
  };
}

function makeTypedItem<T extends ReviewItem>(
  type: NoteType,
  { id, dismissed }: { id: string; dismissed: boolean }
): T {
  return {
    data: { id, type, dismissed, reference: `${id}.md` },
    file: makeTFile(id),
  } as unknown as T;
}

/** Everything handed to `store.dispatch`, in order. */
function dispatched(plugin: { store: { dispatch: ReturnType<typeof vi.fn> } }) {
  return plugin.store.dispatch.mock.calls.map(([action]) => action as unknown);
}

/**
 * Review the item the way the action bar does, whichever kind it is: a text is
 * marked reviewed, a card graded.
 */
async function reviewWith(
  actions: Actions,
  item: ReviewItem,
  { grade, nextInterval }: { grade: 1 | 2 | 3 | 4; nextInterval?: number }
) {
  if (item.data.type === 'card') {
    await actions.gradeCard(item as ReviewCard, grade);
  } else {
    await actions.review(item as ReviewText, nextInterval);
  }
}

const noteTypeArb = fc.constantFrom<NoteType>('article', 'snippet', 'card');

/** Every set of types the filter can be left in, the empty one included. */
const typesToReviewArb: fc.Arbitrary<Partial<Record<NoteType, true>>> = fc
  .subarray([...NOTE_TYPES])
  .map((types) =>
    types.reduce(
      (acc, type) => Object.assign(acc, { [type]: true }),
      {} as Partial<Record<NoteType, true>>
    )
  );

/**
 * Stage the state a filter change reads — which types are on, and what is on
 * screen — and hand back the plugin, the actions, and a stubbed `_getNext`.
 *
 * The plugin's `dispatch` is a spy, so the real store never moves and state the
 * action reads has to be put in place here rather than dispatched. Mocks are
 * reset per call: a property runs this many times over, and `afterEach` fires
 * once per `it`.
 */
function wireTypeFilter({
  typesToReview,
  currentItem,
}: {
  typesToReview: Partial<Record<NoteType, true>>;
  currentItem: ReviewItem | null;
}) {
  vi.restoreAllMocks();
  vi.spyOn(store, 'getState').mockReturnValue({ typesToReview } as never);
  vi.mocked(fetchCurrentItem).mockResolvedValue(currentItem);
  vi.mocked(invalidateCurrentItemQuery).mockClear();
  // `makePlugin` hands back the plugin type, which hides the spy behind
  // `store.dispatch`; these tests read the dispatches back out of it.
  const plugin = makePlugin() as unknown as IncrementalReadingPlugin & {
    store: { dispatch: ReturnType<typeof vi.fn> };
  };
  const actions = new Actions(plugin);
  // Stubbed rather than left to run: the real advance dispatches and reaches
  // the session tracker, and its dispatches would land in the same spy the
  // filter's own dispatch is read out of.
  const getNext = vi.spyOn(actions, '_getNext').mockImplementation(() => {});
  return { plugin, actions, getNext };
}

/** The types the one `setTypesToReview` dispatch carried. */
function dispatchedTypes(plugin: {
  store: { dispatch: ReturnType<typeof vi.fn> };
}): NoteType[] {
  const calls = dispatched(plugin) as { payload: NoteType[] }[];
  expect(calls).toHaveLength(1);
  return calls[0].payload;
}

/** Clock readings whose end of day still fits in a `Date`. */
const nowArb = fc.integer({ min: 0, max: 8_639_000_000_000_000 });

/** Every rollover offset the setting could be saved with, and then some. */
const rolloverOffsetArb = fc.integer({ min: -48, max: 48 });

const reviewCaseArb = fc.record({
  type: noteTypeArb,
  reviewId: fc.string(),
  itemId: fc.string(),
  dismissed: fc.boolean(),
  currentItemId: fc.option(fc.string(), { nil: null }),
  dayRolloverOffset: rolloverOffsetArb,
  now: nowArb,
  grade: fc.constantFrom<1 | 2 | 3 | 4>(1, 2, 3, 4),
  nextInterval: fc.option(fc.integer({ min: 1 }), { nil: undefined }),
});

type ReviewCase =
  typeof reviewCaseArb extends fc.Arbitrary<infer T> ? T : never;

/** Put the case's clock and current item in place, and return its plugin. */
function wireCase(c: ReviewCase, reverse?: () => Promise<void>) {
  Notice.reset();
  vi.restoreAllMocks();
  vi.setSystemTime(c.now);
  vi.spyOn(store, 'getState').mockReturnValue({
    currentItemId: c.currentItemId,
  } as never);
  const plugin = makeReviewingPlugin({
    reviewId: c.reviewId,
    dayRolloverOffset: c.dayRolloverOffset,
    reverse,
  });
  const item = makeTypedItem(c.type, {
    id: c.itemId,
    dismissed: c.dismissed,
  });
  return { plugin, item, actions: new Actions(plugin) };
}

/**
 * A plugin for `goToContext`: the database hands back `item` for any note,
 * views are registered for `registered` extensions, and whatever gets opened
 * is recorded.
 */
function wireGoToContext({
  item,
  registered = ['md'],
}: {
  item: ReviewItem | null;
  registered?: string[];
}) {
  const openFile = vi.fn().mockResolvedValue(undefined);
  const getLeaf = vi.fn((_newLeaf?: PaneType | boolean) => ({ openFile }));
  const openWithDefaultApp = vi.fn();
  const getReviewItemFromFile = vi.fn().mockResolvedValue(item);
  // No review tab, unless a test opens one
  const getOpenReviewLeaf = vi.fn((): unknown => null);
  const plugin = {
    reviewManager: { getReviewItemFromFile },
    getOpenReviewLeaf,
    app: {
      workspace: { getLeaf },
      viewRegistry: {
        isExtensionRegistered: (ext: string) => registered.includes(ext),
      },
      openWithDefaultApp,
    },
  } as unknown as IncrementalReadingPlugin;
  return {
    plugin,
    openFile,
    getLeaf,
    openWithDefaultApp,
    getReviewItemFromFile,
    getOpenReviewLeaf,
  };
}

/** A vault file of any extension, some with a view registered, some not. */
const vaultFileArb = fc
  .record({
    name: fc.string(),
    extension: fc.constantFrom('md', 'pdf', 'canvas', 'html', 'zip', ''),
  })
  .map(
    ({ name, extension }) =>
      ({
        basename: name,
        extension,
        path: `notes/${name}.${extension}`,
      }) as unknown as TFile
  );

/** Every set of extensions a vault could have views registered for. */
const registeredArb = fc.subarray(['md', 'pdf', 'canvas', 'html', 'zip']);

const contextArb = fc.option(
  fc.record({
    file: vaultFileArb,
    eState: fc.option(
      fc.record({
        match: fc.record({
          content: fc.string(),
          matches: fc.array(fc.tuple(fc.nat(), fc.nat()), {
            minLength: 1,
            maxLength: 1,
          }),
        }),
      }),
      { nil: null }
    ),
  }),
  { nil: null }
);

/**
 * Where Go to context can be asked to open: `Keymap.isModEvent`'s answers for
 * a click, `true` as a new tab, and `false` — a plain click, or a command —
 * for where the user already is.
 */
const newLeafArb = fc.constantFrom<PaneType | boolean>(
  false,
  true,
  'tab',
  'split',
  'window'
);

/**
 * Assert that `file` opened exactly once, the way following a link to it
 * would: in the active tab at `eState` if a view takes its extension — or in
 * a new one of `newLeaf`'s kind when asked for — else in the system's
 * default app.
 */
function expectOpened(
  wired: ReturnType<typeof wireGoToContext>,
  registered: string[],
  file: TFile,
  eState: unknown,
  newLeaf: PaneType | boolean = false
) {
  if (registered.includes(file.extension)) {
    expect(wired.openWithDefaultApp).not.toHaveBeenCalled();
    expect(wired.getLeaf).toHaveBeenCalledExactlyOnceWith(newLeaf);
    expect(wired.openFile).toHaveBeenCalledOnce();
    expect(wired.openFile.mock.calls[0]).toStrictEqual([
      file,
      eState ? { active: true, eState } : { active: true },
    ]);
  } else {
    expect(wired.getLeaf).not.toHaveBeenCalled();
    expect(wired.openWithDefaultApp).toHaveBeenCalledExactlyOnceWith(file.path);
  }
}

/** Assert that nothing was opened anywhere. */
function expectNothingOpened(wired: ReturnType<typeof wireGoToContext>) {
  expect(wired.getLeaf).not.toHaveBeenCalled();
  expect(wired.openWithDefaultApp).not.toHaveBeenCalled();
}

/**
 * A review tab whose editor holds `doc` with `anchor`-`head` selected, or one
 * with no editor on screen when passed null: what the selection actions read
 * off the view. `domSelection` stands in for the browser's selection, which
 * starts inside the editor's content.
 */
function makeSelectingView(
  editor: { doc: string; anchor: number; head: number } | null,
  itemFile: TFile | null = null
) {
  const domSelection = { anchorNode: {}, removeAllRanges: vi.fn() };
  const contentDOM = {
    contains: vi.fn(() => true),
    ownerDocument: { getSelection: () => domSelection },
  };
  const cm = editor && {
    state: EditorState.create({
      doc: editor.doc,
      selection: { anchor: editor.anchor, head: editor.head },
    }),
    dispatch: vi.fn(),
    contentDOM,
  };
  const reviewView = {
    reviewEditor: () => (cm ? { cm } : null),
    currentItemFile: () => itemFile,
  } as unknown as ReviewView;
  return { reviewView, cm, contentDOM, domSelection };
}

/** Put the store in selection mode for `kind`, or out of it. */
function wireSelectionMode(kind: SelectionKind | null) {
  vi.spyOn(store, 'getState').mockReturnValue({
    selectionMode: kind,
  } as never);
}

/**
 * Actions over a plugin whose dispatches are read back, with the two creators
 * stubbed: what they do with the editor is theirs to test, and here only
 * whether and how they are reached matters.
 */
function wireSelectionActions() {
  const plugin = makePlugin() as unknown as IncrementalReadingPlugin & {
    store: { dispatch: ReturnType<typeof vi.fn> };
  };
  const actions = new Actions(plugin);
  const createSnippet = vi
    .spyOn(actions, 'createSnippet')
    .mockResolvedValue(null);
  const createCard = vi.spyOn(actions, 'createCard').mockResolvedValue(null);
  const prompt = vi
    .spyOn(CardAnswerModal, 'promptForCardAnswer')
    .mockResolvedValue(null);
  return { plugin, actions, createSnippet, createCard, prompt };
}

const selectionKindArb = fc.constantFrom<SelectionKind>('snippet', 'card');

/**
 * Spy on the two makers of a snippet or card from a PDF, keyed by kind: what
 * they do is theirs to test, and here only whether they are reached.
 */
function spyPdfCreators(
  actions: Actions
): Record<
  SelectionKind,
  MockInstance<(reviewView: ReviewView) => Promise<null>>
> {
  return {
    snippet: vi.spyOn(actions, 'createPdfSnippet').mockResolvedValue(null),
    card: vi.spyOn(actions, 'createPdfCard').mockResolvedValue(null),
  } as never;
}

/** `pdf` in any casing: the MIME table ignores case. */
const pdfExtensionArb = fc.mixedCase(fc.constant('pdf'));

function pdfFile(extension = 'pdf', basename = 'paper') {
  return {
    path: `papers/${basename}.${extension}`,
    basename,
    extension,
  } as TFile;
}

/**
 * A pdf.js document stand-in with `pages` as the text of each page's items:
 * an empty list for a scanned page.
 */
function pdfDocumentWith(pages: string[][]) {
  return {
    numPages: pages.length,
    getPage: vi.fn((n: number) =>
      Promise.resolve({
        view: [0, 0, 612, 792],
        getTextContent: () =>
          Promise.resolve({ items: pages[n - 1].map((str) => ({ str })) }),
      })
    ),
  };
}

/** Text selected in a PDF viewer, as far as review passes it along. */
const SELECTED = { selected: true } as unknown as Range;

/**
 * What a PDF article's viewer has selected: some text, nothing, or no viewer
 * at all (undefined), as when it couldn't load.
 */
const pdfViewerSelectionArb = fc.constantFrom<Range | null | undefined>(
  SELECTED,
  null,
  undefined
);

/**
 * Put a PDF viewer on `reviewView`, whose selection is `selection`, or none
 * at all when `selection` is undefined.
 */
function withPdfViewer(
  reviewView: ReviewView,
  selection: Range | null | undefined,
  pdfDocument: unknown = pdfDocumentWith([['Some text']])
) {
  const viewer =
    selection === undefined
      ? null
      : {
          containerEl: { isViewer: true },
          selection: vi.fn(() => selection),
          clearSelection: vi.fn(),
          pdfDocument: vi.fn(() => pdfDocument),
          visiblePages: vi.fn((): number[] => [1]),
        };
  Object.assign(reviewView, { pdfViewer: viewer });
  return { viewer };
}

/** A document with a selection in it, which may be empty or run backwards. */
const editorArb = fc
  .string({ maxLength: 40 })
  .chain((doc) =>
    fc
      .tuple(fc.nat(doc.length), fc.nat(doc.length))
      .map(([anchor, head]) => ({ doc, anchor, head }))
  );

/**
 * Go to context asked for from review on the `type` item at `itemFile`: the
 * tab the user is in is the review tab, whose view shows a context in review
 * when `shows`, and a new tab is another.
 */
function wireInReview(
  itemFile: TFile,
  shows: boolean,
  type: NoteType = 'snippet'
) {
  const item = {
    data: { id: 'item-1', type },
    file: itemFile,
  } as unknown as ReviewItem;
  const wired = wireGoToContext({ item, registered: ['md'] });
  const showInReview = vi.fn(
    async (_file: TFile, _openState: unknown): Promise<boolean> => shows
  );
  const review = {
    openFile: vi.fn().mockResolvedValue(undefined),
    view: { showInReview },
  };
  const newTab = { openFile: vi.fn().mockResolvedValue(undefined) };
  wired.getLeaf.mockImplementation((newLeaf) => (newLeaf ? newTab : review));
  wired.getOpenReviewLeaf.mockReturnValue(review);
  return { ...wired, review, newTab, showInReview };
}

/** Where in its note a snippet's or card's context is, when known. */
const contextEStateArb = fc.option(
  fc.record({
    match: fc.record({
      content: fc.string(),
      matches: fc.array(fc.tuple(fc.nat(), fc.nat()), {
        minLength: 1,
        maxLength: 1,
      }),
    }),
  }),
  { nil: null }
);

/**
 * A database merging another device's copy until `becomes` ends the merge,
 * telling the gate's listeners as the real one does.
 */
function mergingRepo() {
  const listeners = new Set<(state: Readiness) => void>();
  const repo = {
    readiness: 'merging' as Readiness,
    writeRefusal: () => null,
    onReadinessChange: (listener: (state: Readiness) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    becomes(next: Readiness) {
      repo.readiness = next;
      for (const listener of [...listeners]) listener(next);
    },
  };
  return repo;
}

/** Actions over a plugin whose database refuses writes with `reason`. */
function refusing(reason: string) {
  const plugin = makePlugin();
  Object.assign(plugin.reviewManager, {
    repo: { writeRefusal: () => new Error(reason), readiness: 'starting' },
  });
  return new Actions(plugin);
}
/**
 * A note holding a card's embed between `before` and `after`, and the line the
 * card was made of: any text, shorter or longer than the embed. The text
 * around the embed never holds it, as the cache finds the embed by itself.
 */
const cardNoteArb = fc
  .record({
    before: fc.string(),
    after: fc.string(),
    line: fc.string(),
    embed: fc.constantFrom('![[card|ir-hide-title]]', '![[c]]'),
  })
  .filter(({ before, after, embed }) => {
    const text = before + embed + after;
    return (
      text.indexOf(embed) === before.length &&
      text.lastIndexOf(embed) === before.length
    );
  });
type CardNote = typeof cardNoteArb extends fc.Arbitrary<infer T> ? T : never;

/**
 * A card made of `note`'s line, whose embed now stands in its place, undone
 * with a card manager whose delete answers `deleted`, after `meanwhile` has
 * edited the note. The card was made saying it put `around` the embed.
 */
async function makeCardThenUndo(
  { before, after, line, embed }: CardNote,
  deleted: boolean,
  meanwhile: (text: string) => string = (text) => text,
  around = { before: '', after: '' }
) {
  const plugin = makePlugin();
  const sourceFile = makeTFile('source');
  const cardFile = makeTFile('card');
  let text = before + embed + after;
  const process = vi.fn(async (_file: TFile, fn: (data: string) => string) => {
    text = fn(text);
    return text;
  });
  Object.assign(plugin.app, {
    vault: { read: vi.fn(async () => text), process },
  });
  vi.spyOn(Obsidian, 'findEmbeds').mockImplementation(() => {
    const start = text.indexOf(embed);
    return start < 0
      ? null
      : ({
          position: {
            start: { offset: start },
            end: { offset: start + embed.length },
          },
        } as never);
  });
  vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
  const reviewCard = { data: { id: 'card-1', parent: null }, file: cardFile };
  const deleteCard = vi.fn(async () => {
    text = meanwhile(text);
    return deleted ? ('deleted' as const) : ('declined' as const);
  });
  const error = vi.spyOn(console, 'error').mockReturnValue(undefined);
  Object.assign(plugin.reviewManager, {
    createCard: vi.fn().mockResolvedValue({ reviewCard, line, ...around }),
    cards: { delete: deleteCard },
  });
  Object.assign(plugin.app.workspace, {
    activeEditor: { editor: {} },
    getActiveViewOfType: () => ({ file: sourceFile }),
  });
  Object.assign(plugin, { getActiveReviewView: () => null });
  const actions = new Actions(plugin);
  await actions.createCard();

  await actions.undo();

  return { text: () => text, deleteCard, error, actions };
}

/**
 * Actions over a plugin whose item rows are marked deleted and back through
 * `log`, and whose prompt to delete a note does `prompt`, leaving the
 * note there or not as `deletes` says.
 */
function wireDeleteItem(prompt: () => Promise<unknown>, deletes = false) {
  const plugin = makePlugin();
  const log: string[] = [];
  let note: unknown = null;
  const promptForFileDeletion = vi.fn(async (file: unknown) => {
    log.push('prompt');
    note = deletes ? null : file;
    return prompt();
  });
  Object.assign(plugin.app, {
    fileManager: { promptForFileDeletion },
    vault: { getFileByPath: () => note },
  });
  const markDeleted = vi.fn(async (id: string, type: string) => {
    log.push(`deleted ${type} ${id}`);
  });
  Object.assign(plugin.reviewManager, {
    articles: {
      markDeleted,
      markUndeleted: vi.fn(async (id: string, type: string) => {
        log.push(`undeleted ${type} ${id}`);
      }),
    },
  });
  vi.spyOn(store, 'getState').mockReturnValue({
    currentItemId: 'item-1',
  } as never);
  vi.spyOn(console, 'error').mockReturnValue(undefined);
  const actions = new Actions(plugin);
  const getNext = vi.spyOn(actions, '_getNext').mockImplementation(() => {});
  return { actions, log, promptForFileDeletion, getNext, markDeleted };
}

/**
 * A notice that names the selection kind `kind` as a word of its own, and
 * never the other kind: its wording is free, which kind it is about is not.
 */
const namingKind = (kind: SelectionKind) =>
  expect.stringMatching(
    new RegExp(
      `^(?!.*\\b${kind === 'snippet' ? 'card' : 'snippet'}\\b).*\\b${kind}\\b`,
      's'
    )
  ) as unknown;

/** What an import may report it did, by any article. */
const importedArb: fc.Arbitrary<ImportedArticle> = fc.record(
  {
    articleId: fc.uuid(),
    effect: fc.constantFrom<ImportEffect>('created', 'restored', 'linked'),
    madeFile: fc.string().map((name) => makeTFile(name)),
  },
  { requiredKeys: ['articleId', 'effect'] }
);

/**
 * What a bulk import may report of one file: imported, saying what it did, or
 * not, saying nothing of it.
 */
const bulkOutcomeArb: fc.Arbitrary<BulkOutcome> = fc.oneof(
  importedArb.map((imported) => ({
    file: makeTFile('f'),
    status: 'imported' as const,
    ...imported,
  })),
  fc
    .constantFrom<
      BulkOutcome['status']
    >('imported', 'unimported', 'skipped', 'failed')
    .map((status) => ({ file: makeTFile('f'), status }))
);

/** What of `imports` an undo takes back: all but what only linked. */
const undoable = (imports: readonly Partial<ImportedArticle>[]) =>
  imports.flatMap(({ articleId, effect, madeFile }) =>
    articleId !== undefined && effect !== undefined && effect !== 'linked'
      ? [{ articleId, effect, madeFile }]
      : []
  );

/**
 * Actions whose review manager takes back what `undone` picks of the imports
 * it is handed (all of them by default), the refresh after it and the
 * notices spied on.
 */
function wireImports(
  undone: (imports: readonly ImportedArticle[]) => string[] = (imports) =>
    imports.map(({ articleId }) => articleId)
) {
  const plugin = makePlugin();
  const undoImports = vi.fn(async (imports: readonly ImportedArticle[]) =>
    undone(imports)
  );
  Object.assign(plugin.reviewManager, { undoImports });
  const refresh = vi
    .spyOn(unimportArticle, 'refreshAfterImportUndo')
    .mockResolvedValue(undefined);
  const notify = vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
  const actions = new Actions(plugin);
  const listener = vi.fn();
  actions.subscribe(listener);
  return { actions, undoImports, refresh, notify, listener };
}

/** A plain entry for the stack, which undoes as `undo` says. */
function plainEntry(
  description: string,
  undo: ActionStackEntry['undo'] = () => undefined
): ActionStackEntry {
  return { description, undo: vi.fn(undo), writes: false };
}

// #endregion

describe('itemName', () => {
  it('names an item with a file by its file', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (basename, reference) => {
        const item = {
          data: { reference },
          file: { basename },
        } as unknown as ReviewItem;
        expect(itemName(item)).toBe(basename);
      })
    );
  });

  it('names a missing item by the last segment of its reference, less its extension', () => {
    const segment = fc.string().map((text) => text.replace(/\//g, ''));
    fc.assert(
      fc.property(
        fc.array(segment, { maxLength: 3 }),
        segment,
        fc.option(segment, { nil: undefined }),
        (dirs, stem, extension) => {
          const name = extension === undefined ? stem : `${stem}.${extension}`;
          const reference = [...dirs, name].join('/');
          const item = {
            data: { reference },
            file: null,
          } as unknown as MaybeMissingItem;

          // A leading dot starts a hidden name, not an extension
          const lastDot = name.lastIndexOf('.');
          const expected = lastDot > 0 ? name.slice(0, lastDot) : name;
          expect(itemName(item)).toBe(expected);
        }
      )
    );
  });

  it.each([
    ['papers/deep/paper.v2.pdf', 'paper.v2'],
    ['.hidden', '.hidden'],
    ['folder/noext', 'noext'],
    ['a.b/c', 'c'],
  ])('names a missing item at %s "%s"', (reference, expected) => {
    const item = {
      data: { reference },
      file: null,
    } as unknown as MaybeMissingItem;
    expect(itemName(item)).toBe(expected);
  });
});

describe('Actions on a missing item', () => {
  beforeEach(() => {
    Notice.reset();
    vi.spyOn(store, 'getState').mockReturnValue({
      currentItemId: null,
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const missing = {
    data: {
      id: 'item-1',
      type: 'article',
      reference: 'gone/away.pdf',
      dismissed: false,
    },
    file: null,
  } as unknown as MaybeMissingItem;

  it('skips, dismisses and restores it by the name its reference gave it', async () => {
    const plugin = makePlugin();
    const actions = new Actions(plugin);

    actions.skipItem(missing);
    await actions.dismissItem(missing);
    await actions.unDismissItem(missing);

    const byName = expect.stringContaining('away') as unknown;
    expect(Notice.messages).toEqual([byName, byName, byName]);
    expect(Notice.messages.join()).not.toContain('gone');
    expect(
      (plugin.reviewManager.dismissItem as ReturnType<typeof vi.fn>).mock.calls
    ).toEqual([[missing]]);
    expect(actions.undoStack.map((entry) => entry.description)).toEqual([
      byName,
      byName,
    ]);
  });
});

describe('Actions.reprioritize', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a priority it could not save as an error naming the item', async () => {
    const plugin = makePlugin();
    Object.assign(plugin.reviewManager, {
      reprioritize: vi.fn().mockRejectedValue(new Error('disk full')),
    });
    const notify = vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
    const item = makeReviewItem('my-article') as ReviewText;

    await new Actions(plugin).reprioritize(item, 30);

    expect(notify).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(item.data.reference),
      { kind: 'error' }
    );
  });
});

describe('Actions — success notice levels', () => {
  beforeEach(() => {
    vi.spyOn(store, 'getState').mockReturnValue({
      currentItemId: null,
    } as never);
  });

  afterEach(() => {
    configureSuccessNotices(null);
    vi.restoreAllMocks();
  });

  it('confirms each action only at the all level, and an undo at minimal too', async () => {
    /** Every notice the same run of actions raises at `level`. */
    const noticesAt = async (level: SuccessNoticeLevel) => {
      Notice.reset();
      showSuccessNotices(level);
      const plugin = makeReviewingPlugin({
        reviewId: 'review-1',
        dayRolloverOffset: 4,
      });
      Object.assign(plugin.reviewManager, {
        reprioritize: vi.fn().mockResolvedValue(undefined),
      });
      const actions = new Actions(plugin);
      const item = (type: NoteType) =>
        makeTypedItem(type, { id: type, dismissed: false });

      await actions.reviewArticle(item('article') as ReviewArticle, MS_PER_DAY);
      await actions.reviewSnippet(item('snippet') as ReviewSnippet, MS_PER_DAY);
      await actions.gradeCard(item('card') as ReviewCard, 3);
      await actions.reprioritize(item('article') as ReviewText, 40);
      actions.skipItem(item('article'));
      await actions.dismissItem(item('snippet'));
      await actions.unDismissItem(item('snippet'));
      await actions.undo();
      return [...Notice.messages];
    };
    /** A notice showing `n` as a number of its own. */
    const showing = (n: number) =>
      expect.stringMatching(
        new RegExp(`(^|[^\\d.])${n}([^\\d.]|$)`)
      ) as unknown;

    const all = await noticesAt('all');

    // Only the values each notice carries; its wording is free to change
    expect(all).toEqual([
      showing(1), // days to the article's next review
      showing(1), // days to the snippet's next review
      expect.stringContaining('Good'), // the grade's name
      showing(4), // the priority, out of 5
      expect.stringContaining('article'), // the skipped item's name
      expect.stringContaining('snippet'), // the dismissed item's name
      expect.stringContaining('snippet'), // the restored item's name
      expect.stringContaining('snippet'), // what was undone
    ]);
    expect(await noticesAt('minimal')).toEqual([all.at(-1)]);
    expect(await noticesAt('none')).toEqual([]);
  });
});

describe('Actions.skipItem — Notice message', () => {
  beforeEach(() => {
    Notice.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Notice contains the file basename', () => {
    const actions = new Actions(makePlugin());
    actions.skipItem(makeReviewItem('my-article'));
    expect(Notice.messages).toHaveLength(1);
    const [message] = Notice.messages;
    expect(message).toContain('my-article');
  });

  it('does not leak folder name from multi-segment path into Notice', () => {
    // Regression: reference.split('/')[1] → folder name ('articles'), not file
    const item = makeReviewItem('note', 'folder-a/subfolder/note.md');
    const actions = new Actions(makePlugin());
    actions.skipItem(item);
    expect(Notice.messages).toHaveLength(1);
    const [message] = Notice.messages;
    expect(message).toContain('note');
    expect(message).not.toContain('folder-a');
    expect(message).not.toContain('subfolder');
  });

  it('truncates long basename with ellipsis', () => {
    const longName = 'a'.repeat(CONTENT_TITLE_SLICE_LENGTH + 20);
    const actions = new Actions(makePlugin());
    actions.skipItem(makeReviewItem(longName));
    expect(Notice.messages).toHaveLength(1);
    const [message] = Notice.messages;
    expect(message).toContain('...');
  });

  it('does not truncate a name at exactly CONTENT_TITLE_SLICE_LENGTH + 5 characters', () => {
    // Kills ArithmeticOperator mutant: +5 → -5 (a 55-char name is truncated at 45 but not at 55)
    const name = 'a'.repeat(CONTENT_TITLE_SLICE_LENGTH + 5);
    const actions = new Actions(makePlugin());
    actions.skipItem(makeReviewItem(name));
    expect(Notice.messages).toHaveLength(1);
    const [message] = Notice.messages;
    expect(message).not.toContain('...');
  });
});

describe('Actions.dismissItem — Notice message', () => {
  beforeEach(() => {
    Notice.reset();
    vi.spyOn(store, 'getState').mockReturnValue({
      currentItemId: null,
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Notice contains the file basename', async () => {
    const actions = new Actions(makePlugin());
    await actions.dismissItem(makeReviewItem('my-article'));
    expect(Notice.messages).toHaveLength(1);
    const [message] = Notice.messages;
    expect(message).toContain('my-article');
  });

  it('does not leak folder name from multi-segment path into Notice', async () => {
    const item = makeReviewItem('note', 'folder-a/subfolder/note.md');
    const actions = new Actions(makePlugin());
    await actions.dismissItem(item);
    expect(Notice.messages).toHaveLength(1);
    const [message] = Notice.messages;
    expect(message).toContain('note');
    expect(message).not.toContain('folder-a');
  });

  it('truncates long basename with ellipsis', async () => {
    const longName = 'a'.repeat(CONTENT_TITLE_SLICE_LENGTH + 20);
    const actions = new Actions(makePlugin());
    await actions.dismissItem(makeReviewItem(longName));
    expect(Notice.messages).toHaveLength(1);
    const [message] = Notice.messages;
    expect(message).toContain('...');
  });
});

describe('Actions.unDismissItem — Notice message', () => {
  beforeEach(() => {
    Notice.reset();
    vi.spyOn(store, 'getState').mockReturnValue({
      currentItemId: null,
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Notice contains the file basename', async () => {
    const actions = new Actions(makePlugin());
    await actions.unDismissItem(makeReviewItem('my-article'));
    expect(Notice.messages).toHaveLength(1);
    const [message] = Notice.messages;
    expect(message).toContain('my-article');
  });

  it('does not leak folder name from multi-segment path into Notice', async () => {
    const item = makeReviewItem('note', 'folder-a/subfolder/note.md');
    const actions = new Actions(makePlugin());
    await actions.unDismissItem(item);
    expect(Notice.messages).toHaveLength(1);
    const [message] = Notice.messages;
    expect(message).toContain('note');
    expect(message).not.toContain('folder-a');
  });

  it('truncates long basename with ellipsis', async () => {
    const longName = 'a'.repeat(CONTENT_TITLE_SLICE_LENGTH + 20);
    const actions = new Actions(makePlugin());
    await actions.unDismissItem(makeReviewItem(longName));
    expect(Notice.messages).toHaveLength(1);
    const [message] = Notice.messages;
    expect(message).toContain('...');
  });
});

describe('Actions.skipItem — dispatch', () => {
  beforeEach(() => {
    Notice.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches addSeenId and resets current item (store.dispatch called twice)', () => {
    const plugin = makePlugin();
    const actions = new Actions(plugin);
    actions.skipItem(makeReviewItem('my-article'));
    // skipItem calls dispatch(addSeenId) directly, then _getNext() calls dispatch(resetCurrentItem)
    expect(plugin.store.dispatch).toHaveBeenCalledTimes(2);
  });
});

describe('Actions.dismissItem — dispatch', () => {
  beforeEach(() => {
    Notice.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls store.dispatch (_getNext) when the dismissed item is the current item', async () => {
    vi.spyOn(store, 'getState').mockReturnValue({
      currentItemId: 'item-1',
    } as never);
    const plugin = makePlugin();
    const actions = new Actions(plugin);
    await actions.dismissItem(makeReviewItem('my-article')); // item id is 'item-1'
    expect(plugin.store.dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not call store.dispatch when the dismissed item is not the current item', async () => {
    vi.spyOn(store, 'getState').mockReturnValue({
      currentItemId: 'other-item',
    } as never);
    const plugin = makePlugin();
    const actions = new Actions(plugin);
    await actions.dismissItem(makeReviewItem('my-article')); // item id 'item-1' !== 'other-item'
    expect(plugin.store.dispatch).not.toHaveBeenCalled();
  });
});

describe('Actions.unDismissItem — dispatch', () => {
  beforeEach(() => {
    Notice.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls store.dispatch (_getNext) when currentItemId is null', async () => {
    vi.spyOn(store, 'getState').mockReturnValue({
      currentItemId: null,
    } as never);
    const plugin = makePlugin();
    const actions = new Actions(plugin);
    await actions.unDismissItem(makeReviewItem('my-article'));
    expect(plugin.store.dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not call store.dispatch when currentItemId is not null', async () => {
    vi.spyOn(store, 'getState').mockReturnValue({
      currentItemId: 'some-item',
    } as never);
    const plugin = makePlugin();
    const actions = new Actions(plugin);
    await actions.unDismissItem(makeReviewItem('my-article'));
    expect(plugin.store.dispatch).not.toHaveBeenCalled();
  });
});

describe('Actions — undo stack notifications', () => {
  beforeEach(() => {
    Notice.reset();
    vi.spyOn(store, 'getState').mockReturnValue({
      currentItemId: null,
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('notifies subscribers when a skip is recorded', () => {
    // Regression: the stack was pushed to directly, so subscribers heard
    // nothing and the undo button kept showing the action before it.
    const actions = new Actions(makePlugin());
    const listener = vi.fn();
    actions.subscribe(listener);

    actions.skipItem(makeReviewItem('my-article'));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies subscribers when a dismissal is recorded', async () => {
    const actions = new Actions(makePlugin());
    const listener = vi.fn();
    actions.subscribe(listener);

    await actions.dismissItem(makeReviewItem('my-article'));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies subscribers when an action is undone', async () => {
    const actions = new Actions(makePlugin());
    actions.skipItem(makeReviewItem('my-article'));
    const listener = vi.fn();
    actions.subscribe(listener);

    await actions.undo();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not notify when there is nothing to undo', async () => {
    const actions = new Actions(makePlugin());
    const listener = vi.fn();
    actions.subscribe(listener);

    await actions.undo();

    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies even when the reversal itself throws', async () => {
    // The entry is already off the stack by then, so subscribers must not be
    // left reading an entry that is no longer there.
    const actions = new Actions(makePlugin());
    actions._pushUndo({
      item: makeReviewItem('my-article'),
      description: 'doing something reversible',
      undo: () => {
        throw new Error('reversal failed');
      },
    });
    const listener = vi.fn();
    actions.subscribe(listener);

    await expect(actions.undo()).rejects.toThrow('reversal failed');

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops notifying after unsubscribe', () => {
    const actions = new Actions(makePlugin());
    const listener = vi.fn();
    const unsubscribe = actions.subscribe(listener);

    unsubscribe();
    actions.skipItem(makeReviewItem('my-article'));

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('Actions._getNext', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tells the session tracker the item is finished', () => {
    // The tracker cannot read "finished" off the store, and the close that
    // races this one is indistinguishable there — see `SessionTracker.finish`.
    const plugin = makePlugin();
    const finish = vi.fn();
    Object.assign(plugin, { sessionTracker: { finish } });
    const actions = new Actions(plugin);

    actions._getNext();

    expect(finish).toHaveBeenCalledTimes(1);
    expect(plugin.store.dispatch).toHaveBeenCalled();
  });

  it('still advances when no session tracker is running', () => {
    // `onload` wires the tracker up after the review manager, so an action can
    // land before it exists.
    const plugin = makePlugin();
    const actions = new Actions(plugin);

    expect(() => actions._getNext()).not.toThrow();
    expect(plugin.store.dispatch).toHaveBeenCalled();
  });

  it('asks for the next item itself when review is already holding none', () => {
    // The reset is what normally refetches, by changing the id the current-item
    // query is keyed on. Between items — the completion screen, most of all —
    // the id is already null, so the reset changes nothing, nothing refetches,
    // and the advance landed only when the `CURRENT_ITEM_REFETCH_TIME` poll
    // next came around.
    vi.spyOn(store, 'getState').mockReturnValue({
      currentItemId: null,
    } as never);
    vi.mocked(invalidateCurrentItemQuery).mockClear();
    const actions = new Actions(makePlugin());

    actions._getNext();

    expect(invalidateCurrentItemQuery).toHaveBeenCalledTimes(1);
  });

  it('leaves the refetch to the id change when review is on an item', () => {
    // There the reset does change the id, and the hook refetches off that. A
    // second invalidation here would read the queue twice per advance.
    vi.spyOn(store, 'getState').mockReturnValue({
      currentItemId: 'item-1',
    } as never);
    vi.mocked(invalidateCurrentItemQuery).mockClear();
    const actions = new Actions(makePlugin());

    actions._getNext();

    expect(invalidateCurrentItemQuery).not.toHaveBeenCalled();
  });
});

describe('Actions — completed reviews', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('counts each review under its type, stamped with the end of the day, before advancing', async () => {
    // Advancing past the last item due is what brings up the summary, so the
    // review has to be in the store by then or the summary misses it.
    await fc.assert(
      fc.asyncProperty(reviewCaseArb, async (c) => {
        const { plugin, item, actions } = wireCase(c);

        await reviewWith(actions, item, c);

        const actionsSent = dispatched(plugin);
        const recorded = actionsSent.filter((a) =>
          addCompletedReview.match(a as never)
        );
        expect(recorded).toEqual([
          addCompletedReview({
            reviewId: c.reviewId,
            type: c.type,
            resetTime: getEndOfDay(c.dayRolloverOffset),
          }),
        ]);
        const advance = actionsSent.findIndex((a) =>
          resetCurrentItem.match(a as never)
        );
        expect(advance).toBeGreaterThan(actionsSent.indexOf(recorded[0]));
      })
    );
  });

  it('takes back the review it counted once that review is undone', async () => {
    await fc.assert(
      fc.asyncProperty(reviewCaseArb, async (c) => {
        const { plugin, item, actions } = wireCase(c);
        await reviewWith(actions, item, c);
        plugin.store.dispatch.mockClear();

        await actions.undo();

        const removed = dispatched(plugin).filter((a) =>
          removeCompletedReview.match(a as never)
        );
        expect(removed).toEqual([
          removeCompletedReview({ reviewId: c.reviewId }),
        ]);
      })
    );
  });

  it('keeps counting a review whose reversal failed', async () => {
    // The review is still in the database, so it still happened.
    await fc.assert(
      fc.asyncProperty(reviewCaseArb, async (c) => {
        const failure = new Error('reversal failed');
        const { plugin, item, actions } = wireCase(
          c,
          vi.fn().mockRejectedValue(failure)
        );
        await reviewWith(actions, item, c);
        plugin.store.dispatch.mockClear();

        await expect(actions.undo()).rejects.toBe(failure);

        expect(
          dispatched(plugin).some((a) =>
            removeCompletedReview.match(a as never)
          )
        ).toBe(false);
      })
    );
  });
});

describe('Actions — undo of a review', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('puts review back on the item whose review it reverses, from wherever review has got to', async () => {
    // Including the completion screen, where the store already holds no item:
    // asking the queue for the next one dispatches nothing that changes there,
    // so the summary stayed up until the refetch interval happened to pick the
    // item back up.
    await fc.assert(
      fc.asyncProperty(reviewCaseArb, async (c) => {
        const { plugin, item, actions } = wireCase(c);
        await reviewWith(actions, item, c);
        plugin.store.dispatch.mockClear();

        await actions.undo();

        const sent = dispatched(plugin);
        const arrival = sent.findIndex((a) =>
          setCurrentItemId.match(a as never)
        );
        expect(sent[arrival]).toEqual(setCurrentItemId(c.itemId));
        // Preceded by the reset, which drops the per-item state on the way in
        // the way arriving from the queue does — a card's answer goes back to
        // hidden; and last, so nothing takes review off the item again.
        expect(sent[arrival - 1]).toEqual(resetCurrentItem());
        expect(sent.slice(arrival + 1)).toEqual([]);
      })
    );
  });

  it('leaves review where it is when the reversal fails', async () => {
    // The review is still in the database, so the item's turn has not come
    // back and review must not go to it.
    await fc.assert(
      fc.asyncProperty(reviewCaseArb, async (c) => {
        const failure = new Error('reversal failed');
        const { plugin, item, actions } = wireCase(
          c,
          vi.fn().mockRejectedValue(failure)
        );
        await reviewWith(actions, item, c);
        plugin.store.dispatch.mockClear();

        await expect(actions.undo()).rejects.toBe(failure);

        expect(
          dispatched(plugin).some((a) => setCurrentItemId.match(a as never))
        ).toBe(false);
      })
    );
  });
});

describe('Actions — undo of a skip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('puts review back on the item whose skip it reverses, from wherever review has got to', async () => {
    // Including the completion screen, where the store already holds no item:
    // asking the queue for the next one dispatches nothing that changes there,
    // so the summary stayed up until the refetch interval happened to pick the
    // item back up.
    await fc.assert(
      fc.asyncProperty(reviewCaseArb, async (c) => {
        const { plugin, item, actions } = wireCase(c);
        actions.skipItem(item);
        plugin.store.dispatch.mockClear();

        await actions.undo();

        const sent = dispatched(plugin);
        const arrival = sent.findIndex((a) =>
          setCurrentItemId.match(a as never)
        );
        expect(sent[arrival]).toEqual(setCurrentItemId(c.itemId));
        // The skip comes off first: arriving at an item review still counts as
        // seen would put it straight back behind the next advance.
        expect(sent[0]).toEqual(removeSeenId({ id: c.itemId }));
        // Then the reset, which drops the per-item state on the way in the way
        // arriving from the queue does; and the arrival last, so nothing takes
        // review off the item again.
        expect(sent[arrival - 1]).toEqual(resetCurrentItem());
        expect(sent.slice(arrival + 1)).toEqual([]);
      })
    );
  });

  it('does not count the undo as an item finished', async () => {
    // Returning to the item is the opposite of finishing one — telling the
    // tracker otherwise closes the item's own segment as review arrives on it.
    await fc.assert(
      fc.asyncProperty(reviewCaseArb, async (c) => {
        const { plugin, item, actions } = wireCase(c);
        const finish = vi.fn();
        Object.assign(plugin, { sessionTracker: { finish } });
        actions.skipItem(item);
        finish.mockClear();

        await actions.undo();

        expect(finish).not.toHaveBeenCalled();
      })
    );
  });
});

describe('Actions — undo of a dismissal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('puts review back on the item whose dismissal took it off screen', async () => {
    // Including from the completion screen, where the store already holds no
    // item: see the undo of a review.
    await fc.assert(
      fc.asyncProperty(reviewCaseArb, async (c) => {
        const { plugin, item, actions } = wireCase({
          ...c,
          currentItemId: c.itemId,
        });
        await actions.dismissItem(item);
        plugin.store.dispatch.mockClear();

        await actions.undo();

        const sent = dispatched(plugin);
        const arrival = sent.findIndex((a) =>
          setCurrentItemId.match(a as never)
        );
        expect(sent[arrival]).toEqual(setCurrentItemId(c.itemId));
        expect(sent[arrival - 1]).toEqual(resetCurrentItem());
        expect(sent.slice(arrival + 1)).toEqual([]);
      })
    );
  });

  it('leaves review where it is when the dismissal never took it off an item', async () => {
    // An item dismissed from somewhere other than review — the queue table, a
    // command run against another note — never interrupted review, so undoing
    // it must not pull review off whatever it is on now.
    await fc.assert(
      fc.asyncProperty(reviewCaseArb, async (c) => {
        const elsewhere = `${c.itemId}-other`;
        const { plugin, item, actions } = wireCase({
          ...c,
          currentItemId: elsewhere,
        });
        await actions.dismissItem(item);
        plugin.store.dispatch.mockClear();

        await actions.undo();

        expect(dispatched(plugin)).toEqual([]);
      })
    );
  });
});

describe('Actions.setCardsOnly', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('narrows review to cards alone', async () => {
    const { plugin, actions } = wireTypeFilter({
      typesToReview: { article: true, snippet: true, card: true },
      currentItem: null,
    });

    await actions.setCardsOnly(true);

    expect(dispatchedTypes(plugin)).toEqual(['card']);
  });

  it('restores every type when turned off', async () => {
    // Starting from cards-only rather than from the full set: the widening is
    // the whole behavior, and starting at the answer would pass on a no-op.
    const { plugin, actions } = wireTypeFilter({
      typesToReview: { card: true },
      currentItem: null,
    });

    await actions.setCardsOnly(false);

    expect(dispatchedTypes(plugin)).toEqual([...NOTE_TYPES]);
  });
});

describe('Actions.toggleReviewType', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('turns the named type off when it was on, and on when it was off', async () => {
    await fc.assert(
      fc.asyncProperty(
        typesToReviewArb,
        noteTypeArb,
        async (typesToReview, toggled) => {
          const { plugin, actions } = wireTypeFilter({
            typesToReview,
            currentItem: null,
          });

          await actions.toggleReviewType(toggled);

          expect(dispatchedTypes(plugin).includes(toggled)).toBe(
            !typesToReview[toggled]
          );
        }
      )
    );
  });

  it('leaves every other type as it found it', async () => {
    await fc.assert(
      fc.asyncProperty(
        typesToReviewArb,
        noteTypeArb,
        async (typesToReview, toggled) => {
          const { plugin, actions } = wireTypeFilter({
            typesToReview,
            currentItem: null,
          });

          await actions.toggleReviewType(toggled);

          const next = dispatchedTypes(plugin);
          for (const type of NOTE_TYPES) {
            if (type === toggled) continue;
            expect(next.includes(type)).toBe(Boolean(typesToReview[type]));
          }
        }
      )
    );
  });

  it('keeps the types in reading order however they were last written', async () => {
    // The filter lays its toggles out in this order; a set rebuilt from its own
    // keys instead would drift out of it as types were turned on and off.
    await fc.assert(
      fc.asyncProperty(
        typesToReviewArb,
        noteTypeArb,
        async (typesToReview, toggled) => {
          const { plugin, actions } = wireTypeFilter({
            typesToReview,
            currentItem: null,
          });

          await actions.toggleReviewType(toggled);

          const next = dispatchedTypes(plugin);
          expect(next).toEqual(
            NOTE_TYPES.filter((type) => next.includes(type))
          );
        }
      )
    );
  });

  it('moves review off the item on screen when its type stops being reviewed', async () => {
    await fc.assert(
      fc.asyncProperty(
        typesToReviewArb,
        noteTypeArb,
        noteTypeArb,
        async (typesToReview, toggled, onScreen) => {
          const { plugin, actions, getNext } = wireTypeFilter({
            typesToReview,
            currentItem: makeTypedItem(onScreen, {
              id: 'on-screen',
              dismissed: false,
            }),
          });

          await actions.toggleReviewType(toggled);

          const stillReviewed = dispatchedTypes(plugin).includes(onScreen);
          expect(getNext).toHaveBeenCalledTimes(stillReviewed ? 0 : 1);
          // The advance is its own refetch; a second reads the queue twice.
          expect(invalidateCurrentItemQuery).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('refetches when review is holding no item, whichever way the filter moved', async () => {
    // Nothing on screen means nothing to advance past and no id to change, so
    // without this the new filter landed only on the next poll.
    await fc.assert(
      fc.asyncProperty(
        typesToReviewArb,
        noteTypeArb,
        async (typesToReview, toggled) => {
          const { actions, getNext } = wireTypeFilter({
            typesToReview,
            currentItem: null,
          });

          await actions.toggleReviewType(toggled);

          expect(invalidateCurrentItemQuery).toHaveBeenCalledTimes(1);
          expect(getNext).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('reads what is on screen before the filter changes', async () => {
    // Afterwards the current-item query is keyed on the new filter, so asking
    // it what is on screen would advance the queue as a side effect.
    const { plugin, actions } = wireTypeFilter({
      typesToReview: { article: true, snippet: true, card: true },
      currentItem: null,
    });
    const order: string[] = [];
    vi.mocked(fetchCurrentItem).mockImplementation(async () => {
      order.push('fetch');
      return null;
    });
    plugin.store.dispatch.mockImplementation(() => {
      order.push('dispatch');
    });

    await actions.toggleReviewType('card');

    expect(order).toEqual(['fetch', 'dispatch']);
  });
});

describe('Actions.goToContext', () => {
  beforeEach(() => {
    Notice.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Titles long enough, some of them, for the notice to cut them short. */
  const basenameArb = fc.string({
    maxLength: CONTENT_TITLE_SLICE_LENGTH * 2,
    size: 'max',
  });

  const titleOf = (basename: string) =>
    getContentSlice(basename, CONTENT_TITLE_SLICE_LENGTH, true);

  it('says a note with no item row is not an item, and opens nothing', async () => {
    await fc.assert(
      fc.asyncProperty(basenameArb, async (basename) => {
        vi.restoreAllMocks();
        Notice.reset();
        const file = makeTFile(basename);
        const resolve = vi.spyOn(itemContext, 'resolveItemContext');
        const find = vi.spyOn(itemContext, 'findArticleSource');
        const wired = wireGoToContext({ item: null });

        await new Actions(wired.plugin).goToContext(file);

        expect(wired.getReviewItemFromFile).toHaveBeenCalledWith(file);
        expect(resolve).not.toHaveBeenCalled();
        expect(find).not.toHaveBeenCalled();
        expectNothingOpened(wired);
        expect(Notice.messages).toEqual([
          `"${titleOf(basename)}" is not an incremental reading item`,
        ]);
      })
    );
  });

  it('opens the context of a snippet or card, at its location when known, or says there is none', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<NoteType>('snippet', 'card'),
        basenameArb,
        contextArb,
        registeredArb,
        newLeafArb,
        async (type, basename, context, registered, newLeaf) => {
          vi.restoreAllMocks();
          Notice.reset();
          const itemFile = makeTFile(basename);
          const item = {
            data: { id: 'item-1', type },
            file: itemFile,
          } as unknown as ReviewItem;
          const resolve = vi
            .spyOn(itemContext, 'resolveItemContext')
            .mockResolvedValue(context);
          const wired = wireGoToContext({ item, registered });

          await new Actions(wired.plugin).goToContext(itemFile, newLeaf);

          expect(wired.getReviewItemFromFile).toHaveBeenCalledWith(itemFile);
          expect(resolve).toHaveBeenCalledWith(
            wired.plugin.app,
            wired.plugin.reviewManager,
            item
          );
          if (context === null) {
            expect(Notice.messages).toEqual([
              expect.stringContaining(titleOf(basename)),
            ]);
            expectNothingOpened(wired);
            return;
          }
          expect(Notice.messages).toEqual([]);
          expectOpened(
            wired,
            registered,
            context.file,
            context.eState,
            newLeaf
          );
        }
      )
    );
  });

  it("highlights a PDF snippet's passage in the tab its context opened in, once it has opened", async () => {
    await fc.assert(
      fc.asyncProperty(
        basenameArb,
        fc.record({ start: fc.nat(), end: fc.nat() }),
        fc.string(),
        registeredArb,
        newLeafArb,
        async (basename, pdfRange, subpath, registered, newLeaf) => {
          vi.restoreAllMocks();
          Notice.reset();
          const itemFile = makeTFile(basename);
          const item = {
            data: { id: 'item-1', type: 'snippet' },
            file: itemFile,
          } as unknown as ReviewItem;
          const pdf = {
            basename: 'Paper',
            extension: 'pdf',
            path: 'papers/Paper.pdf',
          } as unknown as TFile;
          vi.spyOn(itemContext, 'resolveItemContext').mockResolvedValue({
            file: pdf,
            eState: { subpath },
            pdfRange,
          });
          const order: string[] = [];
          const reveal = vi
            .spyOn(itemContext, 'revealPdfContext')
            .mockImplementation(() => {
              order.push('reveal');
              return Promise.resolve();
            });
          // Its passage is highlighted in the PDF, not flashed
          const flash = vi.spyOn(contextFlash, 'flashSnippetContext');
          const wired = wireGoToContext({ item, registered });
          const view = { getViewType: () => 'pdf' };
          wired.openFile.mockImplementation(() => {
            order.push('open');
            return Promise.resolve();
          });
          wired.getLeaf.mockImplementation(() => ({
            openFile: wired.openFile,
            view,
          }));

          await new Actions(wired.plugin).goToContext(itemFile, newLeaf);

          expectOpened(wired, registered, pdf, { subpath }, newLeaf);
          expect(flash).not.toHaveBeenCalled();
          if (registered.includes('pdf')) {
            expect(reveal).toHaveBeenCalledExactlyOnceWith(view, pdfRange);
            expect(order).toEqual(['open', 'reveal']);
          } else {
            expect(reveal).not.toHaveBeenCalled();
          }
        }
      )
    );
  });

  it("flashes a snippet's passage where its context opened, once it has, and marks it for review to flash; a card's, neither", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<NoteType>('snippet', 'card'),
        contextArb.filter((context) => context !== null),
        registeredArb,
        newLeafArb,
        async (type, context, registered, newLeaf) => {
          vi.restoreAllMocks();
          const itemFile = makeTFile('Item');
          const item = {
            data: { id: 'item-1', type },
            file: itemFile,
          } as unknown as ReviewItem;
          vi.spyOn(itemContext, 'resolveItemContext').mockResolvedValue(
            context
          );
          const order: string[] = [];
          const flash = vi
            .spyOn(contextFlash, 'flashSnippetContext')
            .mockImplementation(() => void order.push('flash'));
          const mark = vi
            .spyOn(reviewPosition, 'markContextFlash')
            .mockImplementation(() => void order.push('mark'));
          const wired = wireGoToContext({ item, registered });
          const view = { getViewType: () => 'markdown' };
          wired.openFile.mockImplementation(() => {
            order.push('open');
            return Promise.resolve();
          });
          wired.getLeaf.mockImplementation(() => ({
            openFile: wired.openFile,
            view,
          }));

          await new Actions(wired.plugin).goToContext(itemFile, newLeaf);

          const snippet = type === 'snippet';
          const opened = registered.includes(context.file.extension);
          if (snippet && context.eState) {
            expect(mark).toHaveBeenCalledExactlyOnceWith(context.eState);
          } else {
            expect(mark).not.toHaveBeenCalled();
          }
          if (snippet && opened) {
            expect(flash).toHaveBeenCalledExactlyOnceWith(view, item, context);
          } else {
            expect(flash).not.toHaveBeenCalled();
          }
          // Marked before review can be handed it, flashed once it has opened
          expect(order).toEqual(
            [
              snippet && context.eState ? ['mark'] : [],
              opened ? ['open'] : [],
              snippet && opened ? ['flash'] : [],
            ].flat()
          );
        }
      )
    );
  });

  it('opens the context where the user already is when not asked for a new tab', async () => {
    // A command has no click to read a modifier off: it navigates in place,
    // which in review keeps review showing the parent item.
    const itemFile = makeTFile('Item');
    const context = { file: makeTFile('Parent'), eState: null };
    vi.spyOn(itemContext, 'resolveItemContext').mockResolvedValue(context);
    const wired = wireGoToContext({
      item: {
        data: { id: 'item-1', type: 'snippet' },
        file: itemFile,
      } as unknown as ReviewItem,
      registered: [context.file.extension],
    });

    await new Actions(wired.plugin).goToContext(itemFile);

    expectOpened(wired, [context.file.extension], context.file, null, false);
  });

  describe('in the review tab', () => {
    it('hands a context review can show to review, where the user is', async () => {
      await fc.assert(
        fc.asyncProperty(contextEStateArb, async (eState) => {
          vi.restoreAllMocks();
          const itemFile = makeTFile('Item');
          const context = { file: makeTFile('Parent'), eState };
          vi.spyOn(itemContext, 'resolveItemContext').mockResolvedValue(
            context
          );
          const wired = wireInReview(itemFile, true);

          await new Actions(wired.plugin).goToContext(itemFile);

          expect(wired.showInReview).toHaveBeenCalledExactlyOnceWith(
            context.file,
            eState ? { active: true, eState } : { active: true }
          );
          expect(wired.review.openFile).not.toHaveBeenCalled();
          expect(wired.newTab.openFile).not.toHaveBeenCalled();
        })
      );
    });

    it('opens a context review cannot show in a new tab, leaving review as it is', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('snippet', 'article'),
          contextEStateArb,
          async (type, eState) => {
            vi.restoreAllMocks();
            const itemFile = makeTFile('Item');
            const contextFile = makeTFile('Source');
            vi.spyOn(itemContext, 'resolveItemContext').mockResolvedValue({
              file: contextFile,
              eState,
            });
            vi.spyOn(itemContext, 'findArticleSource').mockReturnValue({
              file: contextFile,
            });
            const wired = wireInReview(itemFile, false, type);

            await new Actions(wired.plugin).goToContext(itemFile);

            const opened =
              type === 'snippet' && eState
                ? { active: true, eState }
                : { active: true };
            expect(wired.showInReview).toHaveBeenCalledExactlyOnceWith(
              contextFile,
              opened
            );
            expect(wired.review.openFile).not.toHaveBeenCalled();
            expect(wired.newTab.openFile).toHaveBeenCalledExactlyOnceWith(
              contextFile,
              opened
            );
            expect(wired.getLeaf).toHaveBeenLastCalledWith('tab');
          }
        )
      );
    });
  });

  it('highlights nothing more for a context with no PDF passage', async () => {
    await fc.assert(
      fc.asyncProperty(contextArb, async (context) => {
        vi.restoreAllMocks();
        Notice.reset();
        const itemFile = makeTFile('Item');
        const item = {
          data: { id: 'item-1', type: 'snippet' },
          file: itemFile,
        } as unknown as ReviewItem;
        vi.spyOn(itemContext, 'resolveItemContext').mockResolvedValue(context);
        const reveal = vi.spyOn(itemContext, 'revealPdfContext');
        const wired = wireGoToContext({
          item,
          registered: ['md', 'pdf', 'canvas', 'html', 'zip', ''],
        });

        await new Actions(wired.plugin).goToContext(itemFile);

        expect(reveal).not.toHaveBeenCalled();
      })
    );
  });

  it("opens an article's source the way Obsidian opens a vault file, or says why it cannot", async () => {
    await fc.assert(
      fc.asyncProperty(
        basenameArb,
        fc.oneof(
          vaultFileArb.map((file) => ({ file })),
          fc.constantFrom(
            { file: null, reason: 'none' as const },
            { file: null, reason: 'outside-vault' as const }
          )
        ),
        registeredArb,
        newLeafArb,
        async (basename, source, registered, newLeaf) => {
          vi.restoreAllMocks();
          Notice.reset();
          const itemFile = makeTFile(basename);
          const article = {
            data: { id: 'item-1', type: 'article' },
            file: itemFile,
          } as unknown as ReviewArticle;
          const find = vi
            .spyOn(itemContext, 'findArticleSource')
            .mockReturnValue(source);
          const resolve = vi.spyOn(itemContext, 'resolveItemContext');
          const wired = wireGoToContext({ item: article, registered });

          await new Actions(wired.plugin).goToContext(itemFile, newLeaf);

          expect(find).toHaveBeenCalledExactlyOnceWith(
            wired.plugin.app,
            article
          );
          expect(resolve).not.toHaveBeenCalled();
          if (source.file === null) {
            const title = titleOf(basename);
            expect(Notice.messages).toEqual([expect.stringContaining(title)]);
            expectNothingOpened(wired);
            return;
          }
          expect(Notice.messages).toEqual([]);
          expectOpened(wired, registered, source.file, null, newLeaf);
        }
      )
    );
  });

  it('tells an article with no source apart from one whose source is outside the vault', async () => {
    const said = [];
    for (const reason of ['none', 'outside-vault'] as const) {
      vi.restoreAllMocks();
      Notice.reset();
      const itemFile = makeTFile('Paper');
      const article = {
        data: { id: 'item-1', type: 'article' },
        file: itemFile,
      } as unknown as ReviewArticle;
      vi.spyOn(itemContext, 'findArticleSource').mockReturnValue({
        file: null,
        reason,
      });
      const wired = wireGoToContext({ item: article });

      await new Actions(wired.plugin).goToContext(itemFile, false);

      expect(Notice.messages).toHaveLength(1);
      said.push(Notice.messages[0]);
    }
    expect(said[0]).not.toBe(said[1]);
  });
});

describe('Actions.extract', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enters selection mode for a PDF when nothing is selected in it', async () => {
    await fc.assert(
      fc.asyncProperty(
        pdfExtensionArb,
        selectionKindArb,
        async (extension, kind) => {
          Notice.reset();
          const { plugin, actions, createSnippet, createCard } =
            wireSelectionActions();
          const fromPdf = spyPdfCreators(actions);
          wireSelectionMode(null);
          const { reviewView } = makeSelectingView(null, pdfFile(extension));
          withPdfViewer(reviewView, null);

          await actions.extract(kind, reviewView);

          expect(dispatched(plugin)).toEqual([setSelectionMode(kind)]);
          expect(fromPdf.snippet).not.toHaveBeenCalled();
          expect(fromPdf.card).not.toHaveBeenCalled();
          expect(createSnippet).not.toHaveBeenCalled();
          expect(createCard).not.toHaveBeenCalled();
          expect(Notice.messages).toEqual([]);
          vi.restoreAllMocks();
        }
      )
    );
  });

  it('says pages with no text have nothing to select, rather than entering the mode', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('', ' ', '\n'), { maxLength: 3 }),
        fc.subarray([2, 3], { minLength: 1 }),
        selectionKindArb,
        async (blank, visible, kind) => {
          Notice.reset();
          const { plugin, actions } = wireSelectionActions();
          const fromPdf = spyPdfCreators(actions);
          wireSelectionMode(null);
          const { reviewView } = makeSelectingView(null, pdfFile());
          const { viewer } = withPdfViewer(
            reviewView,
            null,
            pdfDocumentWith([['Text'], blank, []])
          );
          viewer!.visiblePages.mockReturnValue(visible);

          await actions.extract(kind, reviewView);

          expect(Notice.messages).toHaveLength(1);
          expect(dispatched(plugin)).toEqual([]);
          expect(fromPdf.snippet).not.toHaveBeenCalled();
          expect(fromPdf.card).not.toHaveBeenCalled();
          vi.restoreAllMocks();
        }
      )
    );
  });

  it('enters the mode when any page on screen has text', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.subarray([1, 2, 3], { minLength: 1 }).filter((v) => v.includes(2)),
        selectionKindArb,
        async (visible, kind) => {
          Notice.reset();
          const { plugin, actions } = wireSelectionActions();
          wireSelectionMode(null);
          const { reviewView } = makeSelectingView(null, pdfFile());
          const { viewer } = withPdfViewer(
            reviewView,
            null,
            pdfDocumentWith([[], ['Text'], [' ']])
          );
          viewer!.visiblePages.mockReturnValue(visible);

          await actions.extract(kind, reviewView);

          expect(dispatched(plugin)).toEqual([setSelectionMode(kind)]);
          expect(Notice.messages).toEqual([]);
          vi.restoreAllMocks();
        }
      )
    );
  });

  it('enters the mode once nothing has changed while the pages were read', async () => {
    for (const change of ['mode', 'viewer'] as const) {
      Notice.reset();
      const { plugin, actions } = wireSelectionActions();
      const getState = vi
        .spyOn(store, 'getState')
        .mockReturnValue({ selectionMode: null } as never);
      const { reviewView } = makeSelectingView(null, pdfFile());
      const doc = pdfDocumentWith([['Text']]);
      withPdfViewer(reviewView, null, doc);
      // Meanwhile, a second press enters the mode, or review moves on
      doc.getPage.mockImplementation(() => {
        if (change === 'mode') {
          getState.mockReturnValue({ selectionMode: 'snippet' } as never);
        } else {
          Object.assign(reviewView, { pdfViewer: null });
        }
        return Promise.resolve({
          view: [0, 0, 612, 792],
          getTextContent: () => Promise.resolve({ items: [{ str: 'Text' }] }),
        });
      });

      await actions.extract('snippet', reviewView);

      expect(dispatched(plugin)).toEqual([]);
      expect(Notice.messages).toEqual([]);
      vi.restoreAllMocks();
    }
  });

  it('ignores a second press while the snippet or card from the first is being made, whichever way it was made', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('button', 'confirm'),
        fc.constantFrom('made', 'failed'),
        selectionKindArb,
        selectionKindArb,
        async (first, outcome, kind, secondKind) => {
          Notice.reset();
          const { plugin, actions } = wireSelectionActions();
          const fromPdf = spyPdfCreators(actions);
          const getState = vi.spyOn(store, 'getState').mockReturnValue({
            selectionMode: first === 'confirm' ? kind : null,
          } as never);
          // Ending the mode is what a real store does with the dispatch
          plugin.store.dispatch.mockImplementation(
            (action: { payload: unknown }) => {
              getState.mockReturnValue({
                selectionMode: action.payload,
              } as never);
            }
          );
          const { reviewView } = makeSelectingView(null, pdfFile());
          const { viewer } = withPdfViewer(reviewView, SELECTED);
          let finish!: () => void;
          // A card stays under way while its answer is asked for
          fromPdf[kind].mockImplementation(() => {
            // Reading it drops the selection, as the real one does
            viewer!.selection.mockReturnValue(null);
            return new Promise((resolve, reject) => {
              finish = () =>
                outcome === 'made' ? resolve(null) : reject(new Error('x'));
            });
          });

          const firstPress = actions.extract(kind, reviewView);
          await actions.extract(secondKind, reviewView);
          finish();
          await firstPress.catch(() => {});

          expect(fromPdf[kind]).toHaveBeenCalledOnce();
          expect(
            fromPdf[kind === 'snippet' ? 'card' : 'snippet']
          ).not.toHaveBeenCalled();
          expect(dispatched(plugin)).toEqual(
            first === 'confirm' ? [setSelectionMode(null)] : []
          );
          expect(Notice.messages).toEqual([]);

          // Over once the snippet or card is: the next press is heard again
          await actions.extract(secondKind, reviewView);
          expect(dispatched(plugin).at(-1)).toEqual(
            setSelectionMode(secondKind)
          );
          vi.restoreAllMocks();
        }
      )
    );
  });

  it('enters the mode all the same when the pages on screen cannot be told', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = pdfDocumentWith([['Text']]);
    failing.getPage.mockRejectedValue(new Error('worker gone'));
    for (const [pages, doc] of [
      [[], pdfDocumentWith([[]])],
      [[1], null],
      [[1], failing],
    ] as const) {
      Notice.reset();
      const { plugin, actions } = wireSelectionActions();
      wireSelectionMode(null);
      const { reviewView } = makeSelectingView(null, pdfFile());
      const { viewer } = withPdfViewer(reviewView, null, doc);
      viewer!.visiblePages.mockReturnValue([...pages]);

      await actions.extract('snippet', reviewView);

      expect(dispatched(plugin)).toEqual([setSelectionMode('snippet')]);
      expect(Notice.messages).toEqual([]);
    }
    expect(error).toHaveBeenCalledOnce();
  });

  it('makes the snippet or card from a PDF at once when text is selected in it, or there is no viewer to select in', async () => {
    await fc.assert(
      fc.asyncProperty(
        pdfExtensionArb,
        fc.constantFrom<Range | undefined>(SELECTED, undefined),
        selectionKindArb,
        async (extension, selection, kind) => {
          const { plugin, actions, createSnippet, createCard } =
            wireSelectionActions();
          const fromPdf = spyPdfCreators(actions);
          wireSelectionMode(null);
          const { reviewView } = makeSelectingView(null, pdfFile(extension));
          const { viewer } = withPdfViewer(reviewView, selection);

          await actions.extract(kind, reviewView);

          expect(fromPdf[kind]).toHaveBeenCalledExactlyOnceWith(reviewView);
          expect(
            fromPdf[kind === 'snippet' ? 'card' : 'snippet']
          ).not.toHaveBeenCalled();
          expect(dispatched(plugin)).toEqual([]);
          expect(createSnippet).not.toHaveBeenCalled();
          expect(createCard).not.toHaveBeenCalled();
          // Outside the mode the selection stays, as the editor's does
          if (viewer) expect(viewer.clearSelection).not.toHaveBeenCalled();
          vi.restoreAllMocks();
        }
      )
    );
  });

  it('confirms or refuses as before for a PDF while in the mode', async () => {
    await fc.assert(
      fc.asyncProperty(
        pdfExtensionArb,
        selectionKindArb,
        selectionKindArb,
        pdfViewerSelectionArb,
        async (extension, kind, mode, selection) => {
          Notice.reset();
          const { plugin, actions } = wireSelectionActions();
          const fromPdf = spyPdfCreators(actions);
          const confirmSelection = vi
            .spyOn(actions, 'confirmSelection')
            .mockResolvedValue();
          wireSelectionMode(mode);
          const { reviewView } = makeSelectingView(null, pdfFile(extension));
          withPdfViewer(reviewView, selection);

          await actions.extract(kind, reviewView);

          if (mode === kind) {
            expect(confirmSelection).toHaveBeenCalledExactlyOnceWith(
              reviewView
            );
            expect(Notice.messages).toEqual([]);
          } else {
            expect(confirmSelection).not.toHaveBeenCalled();
            expect(Notice.messages).toEqual([namingKind(mode)]);
          }
          expect(dispatched(plugin)).toEqual([]);
          expect(fromPdf.snippet).not.toHaveBeenCalled();
          expect(fromPdf.card).not.toHaveBeenCalled();
          vi.restoreAllMocks();
        }
      )
    );
  });

  it('extracts as before from any item but a PDF', async () => {
    await fc.assert(
      fc.asyncProperty(
        selectionKindArb,
        // Markdown, and anything with no MIME type at all
        fc.oneof(
          fc.mixedCase(fc.constant('md')),
          fc.string().filter((ext) => ext.toLowerCase() !== 'pdf')
        ),
        async (kind, extension) => {
          Notice.reset();
          const { actions, createSnippet, createCard } = wireSelectionActions();
          const file = { path: `notes/a.${extension}`, extension } as TFile;
          const { reviewView } = makeSelectingView(null, file);

          await actions.extract(kind, reviewView);

          expect(Notice.messages).toEqual([]);
          expect(createSnippet).toHaveBeenCalledTimes(
            kind === 'snippet' ? 1 : 0
          );
          expect(createCard).toHaveBeenCalledTimes(kind === 'card' ? 1 : 0);
          vi.restoreAllMocks();
        }
      )
    );
  });

  it('enters selection mode when nothing is selected', async () => {
    await fc.assert(
      fc.asyncProperty(
        selectionKindArb,
        editorArb.map((e) => ({ ...e, head: e.anchor })),
        async (kind, editor) => {
          const { plugin, actions, createSnippet, createCard } =
            wireSelectionActions();
          const { reviewView } = makeSelectingView(editor);

          await actions.extract(kind, reviewView);

          expect(dispatched(plugin)).toEqual([setSelectionMode(kind)]);
          expect(createSnippet).not.toHaveBeenCalled();
          expect(createCard).not.toHaveBeenCalled();
          vi.restoreAllMocks();
        }
      )
    );
  });

  it('makes the snippet or card at once when text is selected', async () => {
    await fc.assert(
      fc.asyncProperty(
        selectionKindArb,
        editorArb.filter((e) => e.anchor !== e.head),
        async (kind, editor) => {
          const { plugin, actions, createSnippet, createCard } =
            wireSelectionActions();
          const { reviewView } = makeSelectingView(editor);

          await actions.extract(kind, reviewView);

          expect(dispatched(plugin)).toEqual([]);
          expect(createSnippet).toHaveBeenCalledTimes(
            kind === 'snippet' ? 1 : 0
          );
          // Called bare: the card is made of the line, as outside the mode.
          if (kind === 'card') {
            expect(createCard).toHaveBeenCalledExactlyOnceWith();
          } else {
            expect(createCard).not.toHaveBeenCalled();
          }
          vi.restoreAllMocks();
        }
      )
    );
  });

  it('makes the snippet or card at once where there is no editor to select in', async () => {
    await fc.assert(
      fc.asyncProperty(selectionKindArb, async (kind) => {
        const { plugin, actions, createSnippet, createCard } =
          wireSelectionActions();
        const { reviewView } = makeSelectingView(null);

        await actions.extract(kind, reviewView);

        expect(dispatched(plugin)).toEqual([]);
        expect(createSnippet).toHaveBeenCalledTimes(kind === 'snippet' ? 1 : 0);
        expect(createCard).toHaveBeenCalledTimes(kind === 'card' ? 1 : 0);
        vi.restoreAllMocks();
      })
    );
  });

  // In the mode, the item's buttons are hidden, so only the commands reach
  // here: the one for the mode's kind stands in for its Confirm button, and
  // the other must not start something else halfway through.
  it('confirms the selection when already in the mode for that kind', async () => {
    await fc.assert(
      fc.asyncProperty(
        selectionKindArb,
        fc.option(editorArb, { nil: null }),
        async (kind, editor) => {
          Notice.reset();
          const { plugin, actions, createSnippet, createCard, prompt } =
            wireSelectionActions();
          const confirmSelection = vi
            .spyOn(actions, 'confirmSelection')
            .mockResolvedValue();
          const cancelSelection = vi.spyOn(actions, 'cancelSelection');
          wireSelectionMode(kind);
          const { reviewView } = makeSelectingView(editor);

          await actions.extract(kind, reviewView);

          expect(confirmSelection).toHaveBeenCalledExactlyOnceWith(reviewView);
          expect(cancelSelection).not.toHaveBeenCalled();
          expect(dispatched(plugin)).toEqual([]);
          expect(createSnippet).not.toHaveBeenCalled();
          expect(createCard).not.toHaveBeenCalled();
          expect(prompt).not.toHaveBeenCalled();
          expect(Notice.messages).toEqual([]);
          vi.restoreAllMocks();
        }
      )
    );
  });

  it('refuses the other kind while in the mode, says so, and leaves the selection be', async () => {
    await fc.assert(
      fc.asyncProperty(
        selectionKindArb,
        fc.option(editorArb, { nil: null }),
        async (kind, editor) => {
          Notice.reset();
          const { plugin, actions, createSnippet, createCard, prompt } =
            wireSelectionActions();
          const confirmSelection = vi.spyOn(actions, 'confirmSelection');
          const cancelSelection = vi.spyOn(actions, 'cancelSelection');
          const mode = kind === 'snippet' ? 'card' : 'snippet';
          wireSelectionMode(mode);
          const { reviewView, cm, domSelection } = makeSelectingView(editor);

          await actions.extract(kind, reviewView);

          expect(Notice.messages).toEqual([namingKind(mode)]);
          expect(dispatched(plugin)).toEqual([]);
          if (cm) expect(cm.dispatch).not.toHaveBeenCalled();
          expect(domSelection.removeAllRanges).not.toHaveBeenCalled();
          expect(confirmSelection).not.toHaveBeenCalled();
          expect(cancelSelection).not.toHaveBeenCalled();
          expect(createSnippet).not.toHaveBeenCalled();
          expect(createCard).not.toHaveBeenCalled();
          expect(prompt).not.toHaveBeenCalled();
          vi.restoreAllMocks();
        }
      )
    );
  });
});

describe('Actions.confirmSelection', () => {
  beforeEach(() => {
    Notice.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing outside selection mode', async () => {
    await fc.assert(
      fc.asyncProperty(editorArb, async (editor) => {
        const { plugin, actions, createSnippet, createCard, prompt } =
          wireSelectionActions();
        wireSelectionMode(null);
        const { reviewView } = makeSelectingView(editor);

        await actions.confirmSelection(reviewView);

        expect(dispatched(plugin)).toEqual([]);
        expect(createSnippet).not.toHaveBeenCalled();
        expect(createCard).not.toHaveBeenCalled();
        expect(prompt).not.toHaveBeenCalled();
        vi.restoreAllMocks();
      })
    );
  });

  it('stays in the mode, and says so, while nothing is selected', async () => {
    await fc.assert(
      fc.asyncProperty(
        selectionKindArb,
        editorArb.map((e) => ({ ...e, head: e.anchor })),
        async (kind, editor) => {
          Notice.reset();
          const { plugin, actions, createSnippet, createCard, prompt } =
            wireSelectionActions();
          wireSelectionMode(kind);
          const { reviewView, cm, domSelection } = makeSelectingView(editor);

          await actions.confirmSelection(reviewView);

          expect(dispatched(plugin)).toEqual([]);
          expect(cm!.dispatch).not.toHaveBeenCalled();
          expect(domSelection.removeAllRanges).not.toHaveBeenCalled();
          expect(Notice.messages).toHaveLength(1);
          expect(createSnippet).not.toHaveBeenCalled();
          expect(createCard).not.toHaveBeenCalled();
          expect(prompt).not.toHaveBeenCalled();
          vi.restoreAllMocks();
        }
      )
    );
  });

  it('ends the mode, extracts the selection to a snippet, then drops the selection', async () => {
    await fc.assert(
      fc.asyncProperty(
        editorArb.filter((e) => e.anchor !== e.head),
        async (editor) => {
          const { plugin, actions, createSnippet, createCard, prompt } =
            wireSelectionActions();
          wireSelectionMode('snippet');
          const { reviewView, cm, domSelection } = makeSelectingView(editor);
          // The snippet is made of the editor's selection, so it must still be
          // there when the snippet is made.
          let untouchedWhenMade = false;
          createSnippet.mockImplementation(() => {
            untouchedWhenMade =
              cm!.dispatch.mock.calls.length === 0 &&
              domSelection.removeAllRanges.mock.calls.length === 0;
            return Promise.resolve(null);
          });

          await actions.confirmSelection(reviewView);

          expect(dispatched(plugin)).toEqual([setSelectionMode(null)]);
          expect(createSnippet).toHaveBeenCalledOnce();
          expect(untouchedWhenMade).toBe(true);
          expect(cm!.dispatch).toHaveBeenCalledExactlyOnceWith({
            selection: { anchor: editor.head },
          });
          expect(domSelection.removeAllRanges).toHaveBeenCalledOnce();
          expect(createCard).not.toHaveBeenCalled();
          expect(prompt).not.toHaveBeenCalled();
          vi.restoreAllMocks();
        }
      )
    );
  });

  it('ends the mode, asks for the answer in the selected text, and makes the card of both', async () => {
    await fc.assert(
      fc.asyncProperty(
        editorArb.filter((e) => e.anchor !== e.head),
        fc.tuple(fc.nat(), fc.nat()),
        async (editor, answer) => {
          const { plugin, actions, createSnippet, createCard, prompt } =
            wireSelectionActions();
          prompt.mockResolvedValue(answer);
          wireSelectionMode('card');
          const { reviewView, cm, domSelection } = makeSelectingView(editor);
          const from = Math.min(editor.anchor, editor.head);
          const to = Math.max(editor.anchor, editor.head);
          const text = editor.doc.slice(from, to);

          await actions.confirmSelection(reviewView);

          expect(dispatched(plugin)).toEqual([setSelectionMode(null)]);
          expect(prompt).toHaveBeenCalledExactlyOnceWith(plugin.app, text);
          expect(createCard).toHaveBeenCalledExactlyOnceWith({
            selection: { from, to, text },
            answer,
          });
          expect(cm!.dispatch).toHaveBeenCalledExactlyOnceWith({
            selection: { anchor: editor.head },
          });
          expect(domSelection.removeAllRanges).toHaveBeenCalledOnce();
          expect(createSnippet).not.toHaveBeenCalled();
          vi.restoreAllMocks();
        }
      )
    );
  });

  it('makes no card when the answer prompt is cancelled', async () => {
    const { plugin, actions, createCard, prompt } = wireSelectionActions();
    wireSelectionMode('card');
    const { reviewView, cm, domSelection } = makeSelectingView({
      doc: 'some text',
      anchor: 0,
      head: 4,
    });

    await actions.confirmSelection(reviewView);

    expect(prompt).toHaveBeenCalledOnce();
    expect(createCard).not.toHaveBeenCalled();
    // The mode is over all the same: the prompt is its last step.
    expect(dispatched(plugin)).toEqual([setSelectionMode(null)]);
    expect(cm!.dispatch).toHaveBeenCalledExactlyOnceWith({
      selection: { anchor: 4 },
    });
    expect(domSelection.removeAllRanges).toHaveBeenCalledOnce();
  });

  it('leaves a selection outside the editor alone', async () => {
    const { actions } = wireSelectionActions();
    wireSelectionMode('snippet');
    const { reviewView, contentDOM, domSelection } = makeSelectingView({
      doc: 'some text',
      anchor: 0,
      head: 4,
    });
    contentDOM.contains.mockReturnValue(false);

    await actions.confirmSelection(reviewView);

    expect(domSelection.removeAllRanges).not.toHaveBeenCalled();
  });

  it('ends the mode having made nothing when there is no editor to read', async () => {
    await fc.assert(
      fc.asyncProperty(selectionKindArb, async (kind) => {
        const { plugin, actions, createSnippet, createCard, prompt } =
          wireSelectionActions();
        wireSelectionMode(kind);
        const { reviewView } = makeSelectingView(null);

        await actions.confirmSelection(reviewView);

        expect(dispatched(plugin)).toEqual([setSelectionMode(null)]);
        expect(createSnippet).not.toHaveBeenCalled();
        expect(createCard).not.toHaveBeenCalled();
        expect(prompt).not.toHaveBeenCalled();
        vi.restoreAllMocks();
      })
    );
  });
});

describe('Actions — the double-click guard on making snippets and cards', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const timeArb = fc.integer({ min: 0, max: 1e9 });
  /** Whole milliseconds, up past the setting's maximum, 0 (off) included. */
  const cooldownMsArb = fc.integer({ min: 0, max: 5000 });
  const delayArb = fc.integer({ min: 0, max: 10_000 });
  /** A selection with something in it. */
  const filledEditorArb = editorArb.filter((e) => e.anchor !== e.head);

  /**
   * A review tab with something selected to make a snippet or card of: text
   * in its editor, or text in a PDF article's viewer.
   */
  function selectedIn(
    source: 'text' | 'pdf',
    editor: { doc: string; anchor: number; head: number }
  ) {
    if (source === 'text') return makeSelectingView(editor).reviewView;
    const { reviewView } = makeSelectingView(null, pdfFile());
    withPdfViewer(reviewView, SELECTED);
    return reviewView;
  }

  /**
   * Stub every maker so that it takes `wait` ms by the guard's clock, as the
   * database write and a card's answer modal do.
   */
  function slowMakers(actions: Actions, startedAt: number, wait: number) {
    const takeWait = () => {
      vi.spyOn(performance, 'now').mockReturnValue(startedAt + wait);
      return Promise.resolve(null);
    };
    vi.spyOn(actions, 'createSnippet').mockImplementation(takeWait);
    vi.spyOn(actions, 'createCard').mockImplementation(takeWait);
    vi.spyOn(actions, 'createPdfSnippet').mockImplementation(takeWait);
    vi.spyOn(actions, 'createPdfCard').mockImplementation(takeWait);
    vi.spyOn(CardAnswerModal, 'promptForCardAnswer').mockResolvedValue([0, 1]);
  }

  it.each(['extract', 'confirmSelection'] as const)(
    '%s arms the guard from the moment making starts, not once it is made',
    async (method) => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('text' as const, 'pdf' as const),
          selectionKindArb,
          filledEditorArb,
          timeArb,
          delayArb,
          cooldownMsArb,
          delayArb,
          async (source, kind, editor, pressedAt, wait, cooldownMs, delay) => {
            const actions = new Actions(makePlugin() as never);
            slowMakers(actions, pressedAt, wait);
            wireSelectionMode(method === 'extract' ? null : kind);
            const reviewView = selectedIn(source, editor);
            vi.spyOn(performance, 'now').mockReturnValue(pressedAt);

            await (method === 'extract'
              ? actions.extract(kind, reviewView)
              : actions.confirmSelection(reviewView));

            expect(
              actionCooldownFor(reviewView).isCoolingDown(
                pressedAt + delay,
                cooldownMs / 1000
              )
            ).toBe(delay < cooldownMs);
            vi.restoreAllMocks();
          }
        )
      );
    }
  );

  it('arms nothing on a press that makes nothing', async () => {
    // Entering the mode, refusing the other kind's command in it, and asking
    // for a selection first: none would make a second snippet if repeated
    const pressesMakingNothing = fc.oneof(
      fc.record({
        what: fc.constant('enter mode' as const),
        kind: selectionKindArb,
        editor: editorArb.map((e) => ({ ...e, head: e.anchor })),
      }),
      fc.record({
        what: fc.constant('other kind in mode' as const),
        kind: selectionKindArb,
        editor: filledEditorArb,
      }),
      fc.record({
        what: fc.constant('confirm with nothing selected' as const),
        kind: selectionKindArb,
        editor: editorArb.map((e) => ({ ...e, head: e.anchor })),
      })
    );
    await fc.assert(
      fc.asyncProperty(
        pressesMakingNothing,
        timeArb,
        fc.integer({ min: 1, max: 5000 }),
        async ({ what, kind, editor }, pressedAt, cooldownMs) => {
          Notice.reset();
          const { actions, createSnippet, createCard } = wireSelectionActions();
          const other = kind === 'snippet' ? 'card' : 'snippet';
          wireSelectionMode(
            what === 'enter mode'
              ? null
              : what === 'other kind in mode'
                ? other
                : kind
          );
          const { reviewView } = makeSelectingView(editor);
          vi.spyOn(performance, 'now').mockReturnValue(pressedAt);

          await (what === 'confirm with nothing selected'
            ? actions.confirmSelection(reviewView)
            : actions.extract(kind, reviewView));

          expect(createSnippet).not.toHaveBeenCalled();
          expect(createCard).not.toHaveBeenCalled();
          expect(
            actionCooldownFor(reviewView).isCoolingDown(
              pressedAt,
              cooldownMs / 1000
            )
          ).toBe(false);
          vi.restoreAllMocks();
        }
      )
    );
  });
});

describe('Actions.createPdfSnippet', () => {
  beforeEach(() => {
    Notice.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const readArb = fc.record({
    start: fc.integer({ min: 1e10, max: 1e14 }),
    end: fc.integer({ min: 1e10, max: 1e14 }),
    text: fc.string({ minLength: 1 }),
    subpath: fc.string(),
  });

  /**
   * Review on a PDF article whose viewer has `selection` selected, with the
   * reading of it answering `read`, and the manager's `createFromPdf` making
   * `snippet`. The item's row is `item`, an article by default.
   */
  function wirePdfSnippet({
    read = null,
    selection = SELECTED,
    pdfDocument = pdfDocumentWith([['Text']]),
    snippet = null,
    item,
    noViewer = false,
    deleted = true,
    adoptedBy = null,
  }: {
    read?: pdfSelection.PdfSelection | null | Error;
    selection?: Range | null;
    noViewer?: boolean;
    pdfDocument?: unknown;
    snippet?: unknown;
    item?: unknown;
    /** Whether deleting the snippet, to undo it, succeeds. */
    deleted?: boolean;
    /** The note or PDF of the item that took the snippet over meanwhile. */
    adoptedBy?: TFile | null;
  }) {
    const file = pdfFile('pdf', 'paper');
    const article =
      item === undefined
        ? { data: { id: 'article-1', type: 'article' }, file }
        : item;
    const plugin = makePlugin();
    const createFromPdf = vi.fn().mockResolvedValue(snippet);
    const deleteSnippet = vi
      .fn()
      .mockResolvedValue(deleted ? 'deleted' : 'declined');
    const removeHighlight = vi.fn();
    const trigger = vi.fn();
    const getReviewItemFromFile = vi.fn().mockResolvedValue(article);
    const fetchSnippet = vi.fn((id: string) =>
      Promise.resolve(
        adoptedBy ? { data: { id, parent: 'adopter' } } : { data: { id } }
      )
    );
    const getReviewItemFromId = vi.fn((id: string) =>
      Promise.resolve(
        adoptedBy && id === 'adopter' ? { data: { id }, file: adoptedBy } : null
      )
    );
    Object.assign(plugin.reviewManager, {
      getReviewItemFromFile,
      getReviewItemFromId,
      snippets: {
        createFromPdf,
        delete: deleteSnippet,
        fetch: fetchSnippet,
        offsetTracker: { removeHighlight },
      },
    });
    Object.assign(plugin.app.workspace, { trigger });
    const actions = new Actions(plugin);
    const readPdfSelection = vi
      .spyOn(pdfSelection, 'readPdfSelection')
      .mockImplementation(() =>
        read instanceof Error ? Promise.reject(read) : Promise.resolve(read)
      );
    const { reviewView } = makeSelectingView(null, file);
    const { viewer } = withPdfViewer(
      reviewView,
      noViewer ? undefined : selection,
      pdfDocument
    );
    return {
      actions,
      reviewView,
      viewer,
      file,
      article,
      readPdfSelection,
      getReviewItemFromFile,
      createFromPdf,
      deleteSnippet,
      removeHighlight,
      trigger,
    };
  }

  it('makes a snippet of the text the viewer has selected, which undo deletes, highlight and all', async () => {
    await fc.assert(
      fc.asyncProperty(readArb, fc.uuid(), async (read, id) => {
        Notice.reset();
        const snippet = { data: { id }, file: { basename: 'A snippet' } };
        const wired = wirePdfSnippet({ read, snippet });

        const made = await wired.actions.createPdfSnippet(wired.reviewView);

        expect(made).toBe(snippet);
        expect(wired.readPdfSelection).toHaveBeenCalledExactlyOnceWith(
          SELECTED,
          wired.viewer!.containerEl,
          wired.viewer!.pdfDocument()
        );
        expect(wired.getReviewItemFromFile).toHaveBeenCalledExactlyOnceWith(
          wired.file
        );
        expect(wired.createFromPdf).toHaveBeenCalledExactlyOnceWith({
          article: wired.article,
          ...read,
        });
        expect(Notice.messages).toEqual([]);
        expect(wired.actions.undoStack).toHaveLength(1);
        expect(wired.actions.undoStack[0]).toMatchObject({
          item: snippet,
          description: 'creating snippet "A snippet"',
        });

        await wired.actions.undo();

        expect(wired.deleteSnippet).toHaveBeenCalledExactlyOnceWith(id, {
          prompt: false,
        });
        expect(wired.removeHighlight).toHaveBeenCalledExactlyOnceWith(
          wired.file.path,
          id
        );
        expect(wired.trigger).toHaveBeenCalledExactlyOnceWith(
          'ir-highlights-changed',
          wired.file.path
        );
        vi.restoreAllMocks();
      })
    );
  });

  it('leaves the highlight when undo could not delete the snippet', async () => {
    const snippet = { data: { id: 'snippet-1' }, file: { basename: 'A' } };
    const wired = wirePdfSnippet({
      read: { start: 1e10, end: 1e10 + 1, text: 'a', subpath: '#page=1' },
      snippet,
      deleted: false,
    });
    await wired.actions.createPdfSnippet(wired.reviewView);

    await wired.actions.undo();

    expect(wired.deleteSnippet).toHaveBeenCalledExactlyOnceWith('snippet-1', {
      prompt: false,
    });
    expect(wired.removeHighlight).not.toHaveBeenCalled();
    expect(wired.trigger).not.toHaveBeenCalled();
    // Still there to undo once it can be
    expect(wired.actions.undoStack).toHaveLength(1);
  });

  it('records nothing to undo when the snippet could not be saved', async () => {
    const wired = wirePdfSnippet({
      read: { start: 1e10, end: 1e10 + 1, text: 'a', subpath: '#page=1' },
    });

    expect(await wired.actions.createPdfSnippet(wired.reviewView)).toBeNull();
    expect(wired.createFromPdf).toHaveBeenCalledOnce();
    expect(wired.actions.undoStack).toEqual([]);
  });

  it('says there is no selectable text, and makes nothing, when the selection holds none', async () => {
    const cases = [{ read: null }, { selection: null }];
    for (const options of cases) {
      Notice.reset();
      const wired = wirePdfSnippet(options);

      expect(await wired.actions.createPdfSnippet(wired.reviewView)).toBeNull();

      expect(Notice.messages).toHaveLength(1);
      expect(wired.createFromPdf).not.toHaveBeenCalled();
      expect(wired.readPdfSelection).toHaveBeenCalledTimes(
        'read' in options ? 1 : 0
      );
      vi.restoreAllMocks();
    }
  });

  it('drops the selection as it reads it, so one made meanwhile stays', async () => {
    const wired = wirePdfSnippet({
      read: { start: 1e10, end: 1e10 + 1, text: 'a', subpath: '#page=1' },
    });
    let clearedBeforeReading = false;
    wired.readPdfSelection.mockImplementation(() => {
      clearedBeforeReading =
        wired.viewer!.clearSelection.mock.calls.length === 1;
      return Promise.resolve(null);
    });

    await wired.actions.createPdfSnippet(wired.reviewView);

    expect(clearedBeforeReading).toBe(true);
    expect(wired.viewer!.clearSelection).toHaveBeenCalledOnce();
    expect(wired.readPdfSelection).toHaveBeenCalledWith(
      SELECTED,
      wired.viewer!.containerEl,
      expect.anything()
    );
  });

  it('says so, and keeps the selection, while the PDF is still loading', async () => {
    const wired = wirePdfSnippet({ pdfDocument: null });

    expect(await wired.actions.createPdfSnippet(wired.reviewView)).toBeNull();

    expect(Notice.messages).toHaveLength(1);
    expect(wired.readPdfSelection).not.toHaveBeenCalled();
    expect(wired.viewer!.clearSelection).not.toHaveBeenCalled();
    expect(wired.createFromPdf).not.toHaveBeenCalled();
  });

  it('says so, and makes nothing, when the PDF cannot be read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('worker gone');
    const wired = wirePdfSnippet({ read: failure });
    const notify = vi.spyOn(Obsidian, 'notify');

    expect(await wired.actions.createPdfSnippet(wired.reviewView)).toBeNull();

    expect(Notice.messages).toHaveLength(1);
    expect(notify).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      kind: 'error',
    });
    expect(error).toHaveBeenCalledExactlyOnceWith(failure);
    expect(wired.createFromPdf).not.toHaveBeenCalled();
  });

  it('says so, and makes nothing, with no viewer to select in', async () => {
    const wired = wirePdfSnippet({ noViewer: true });

    expect(await wired.actions.createPdfSnippet(wired.reviewView)).toBeNull();

    expect(Notice.messages).toHaveLength(1);
    expect(wired.readPdfSelection).not.toHaveBeenCalled();
    expect(wired.createFromPdf).not.toHaveBeenCalled();
  });

  it('says so, and makes nothing, with no item on screen', async () => {
    const wired = wirePdfSnippet({});
    Object.assign(wired.reviewView, { currentItemFile: () => null });

    expect(await wired.actions.createPdfSnippet(wired.reviewView)).toBeNull();

    expect(Notice.messages).toHaveLength(1);
    expect(wired.readPdfSelection).not.toHaveBeenCalled();
    expect(wired.createFromPdf).not.toHaveBeenCalled();
  });

  it('makes a parentless snippet of a PDF that is no article where any PDF is taken, which undo deletes, highlight and all', async () => {
    await fc.assert(
      fc.asyncProperty(
        readArb,
        fc.uuid(),
        fc.constantFrom<unknown>(null, {
          data: { id: 's', type: 'snippet' },
          file: pdfFile(),
        }),
        async (read, id, item) => {
          Notice.reset();
          const snippet = { data: { id }, file: { basename: 'A snippet' } };
          const wired = wirePdfSnippet({ read, snippet, item });
          const tab = {
            pdfViewer: wired.reviewView.pdfViewer,
            currentItemFile: () => wired.file,
            takesAnyPdf: true,
          };

          expect(await wired.actions.createPdfSnippet(tab)).toBe(snippet);

          expect(wired.createFromPdf).toHaveBeenCalledExactlyOnceWith({
            pdf: wired.file,
            ...read,
          });
          expect(Notice.messages).toEqual([]);

          await wired.actions.undo();

          expect(wired.deleteSnippet).toHaveBeenCalledExactlyOnceWith(id, {
            prompt: false,
          });
          expect(wired.removeHighlight).toHaveBeenCalledExactlyOnceWith(
            wired.file.path,
            id
          );
          expect(wired.trigger).toHaveBeenCalledExactlyOnceWith(
            'ir-highlights-changed',
            wired.file.path
          );
          vi.restoreAllMocks();
        }
      )
    );
  });

  it('takes the highlight off the copy that took the snippet over too, when it is undone', async () => {
    const snippet = { data: { id: 'snippet-1' }, file: { basename: 'A' } };
    const copy = pdfFile('pdf', 'copy');
    const wired = wirePdfSnippet({
      read: { start: 1e10, end: 1e10 + 1, text: 'a', subpath: '#page=1' },
      snippet,
      item: null,
      adoptedBy: copy,
    });
    await wired.actions.createPdfSnippet({
      pdfViewer: wired.reviewView.pdfViewer,
      currentItemFile: () => wired.file,
      takesAnyPdf: true,
    });

    await wired.actions.undo();

    expect(wired.removeHighlight.mock.calls).toEqual([
      [wired.file.path, 'snippet-1'],
      [copy.path, 'snippet-1'],
    ]);
    expect(wired.trigger.mock.calls).toEqual([
      ['ir-highlights-changed', wired.file.path],
      ['ir-highlights-changed', copy.path],
    ]);
  });

  it('takes the highlight off the PDF where it is now, renamed since the snippet was made', async () => {
    const snippet = { data: { id: 'snippet-1' }, file: { basename: 'A' } };
    const wired = wirePdfSnippet({
      read: { start: 1e10, end: 1e10 + 1, text: 'a', subpath: '#page=1' },
      snippet,
      item: null,
    });
    await wired.actions.createPdfSnippet({
      pdfViewer: wired.reviewView.pdfViewer,
      currentItemFile: () => wired.file,
      takesAnyPdf: true,
    });
    // Obsidian renames a file by changing its TFile's path in place
    (wired.file as { path: string }).path = 'papers/renamed.pdf';

    await wired.actions.undo();

    expect(wired.removeHighlight.mock.calls).toEqual([
      ['papers/renamed.pdf', 'snippet-1'],
    ]);
    expect(wired.trigger.mock.calls).toEqual([
      ['ir-highlights-changed', 'papers/renamed.pdf'],
    ]);
  });

  it('says so, and makes nothing, in review on a PDF that is no article', async () => {
    const read = { start: 1e10, end: 1e10 + 1, text: 'a', subpath: '#page=1' };
    for (const item of [
      null,
      { data: { id: 's', type: 'snippet' }, file: pdfFile() },
    ]) {
      Notice.reset();
      const wired = wirePdfSnippet({ read, item });

      expect(await wired.actions.createPdfSnippet(wired.reviewView)).toBeNull();

      expect(Notice.messages).toEqual([expect.stringContaining('paper')]);
      expect(wired.createFromPdf).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  });
});

describe('Actions.createPdfCard', () => {
  beforeEach(() => {
    Notice.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const readArb = fc.record({
    start: fc.integer({ min: 1e10, max: 1e14 }),
    end: fc.integer({ min: 1e10, max: 1e14 }),
    text: fc.string({ minLength: 1 }),
    subpath: fc.string(),
  });

  const READ = { start: 1e10, end: 1e10 + 1, text: 'a', subpath: '#page=1' };

  /**
   * Review on a PDF article whose viewer has `selection` selected, with the
   * reading of it answering `read`, the answer prompt answering `answer`, and
   * the card manager's `createFromPdf` making `card`. The item's row is
   * `item`, an article by default.
   */
  function wirePdfCard({
    read = null,
    selection = SELECTED,
    pdfDocument = pdfDocumentWith([['Text']]),
    answer = [0, 1],
    card = null,
    item,
    noViewer = false,
    deleted = true,
    adoptedBy = null,
  }: {
    read?: pdfSelection.PdfSelection | null | Error;
    selection?: Range | null;
    noViewer?: boolean;
    pdfDocument?: unknown;
    answer?: readonly [number, number] | null;
    card?: unknown;
    item?: unknown;
    /** Whether deleting the card, to undo it, succeeds. */
    deleted?: boolean;
    /** The PDF of the article that took the card over meanwhile. */
    adoptedBy?: TFile | null;
  }) {
    const file = pdfFile('pdf', 'paper');
    const article =
      item === undefined
        ? { data: { id: 'article-1', type: 'article' }, file }
        : item;
    const plugin = makePlugin();
    const createFromPdf = vi.fn().mockResolvedValue(card);
    const deleteCard = vi
      .fn()
      .mockResolvedValue(deleted ? 'deleted' : 'declined');
    const trigger = vi.fn();
    const getReviewItemFromFile = vi.fn().mockResolvedValue(article);
    const fetchCard = vi.fn((id: string) =>
      Promise.resolve(
        adoptedBy ? { data: { id, parent: 'adopter' } } : { data: { id } }
      )
    );
    const getReviewItemFromId = vi.fn((id: string) =>
      Promise.resolve(
        adoptedBy && id === 'adopter' ? { data: { id }, file: adoptedBy } : null
      )
    );
    Object.assign(plugin.reviewManager, {
      getReviewItemFromFile,
      getReviewItemFromId,
      cards: { createFromPdf, delete: deleteCard, fetch: fetchCard },
    });
    Object.assign(plugin.app.workspace, { trigger });
    const actions = new Actions(plugin);
    const readPdfSelection = vi
      .spyOn(pdfSelection, 'readPdfSelection')
      .mockImplementation(() =>
        read instanceof Error ? Promise.reject(read) : Promise.resolve(read)
      );
    const prompt = vi
      .spyOn(CardAnswerModal, 'promptForCardAnswer')
      .mockResolvedValue(answer as never);
    const editNote = vi.spyOn(Obsidian, 'editNote');
    const { reviewView } = makeSelectingView(null, file);
    const { viewer } = withPdfViewer(
      reviewView,
      noViewer ? undefined : selection,
      pdfDocument
    );
    return {
      plugin,
      actions,
      reviewView,
      viewer,
      file,
      article,
      readPdfSelection,
      prompt,
      editNote,
      getReviewItemFromFile,
      createFromPdf,
      deleteCard,
      trigger,
    };
  }

  it('makes a card of the text the viewer has selected, with the answer chosen in the modal, which undo deletes and nothing else', async () => {
    await fc.assert(
      fc.asyncProperty(
        readArb,
        fc.tuple(fc.nat(), fc.nat()),
        fc.uuid(),
        async (read, answer, id) => {
          Notice.reset();
          const card = { data: { id }, file: { basename: 'A card' } };
          const wired = wirePdfCard({ read, answer, card });

          const made = await wired.actions.createPdfCard(wired.reviewView);

          expect(made).toBe(card);
          expect(wired.readPdfSelection).toHaveBeenCalledExactlyOnceWith(
            SELECTED,
            wired.viewer!.containerEl,
            wired.viewer!.pdfDocument()
          );
          expect(wired.prompt).toHaveBeenCalledExactlyOnceWith(
            wired.plugin.app,
            read.text
          );
          expect(wired.createFromPdf).toHaveBeenCalledExactlyOnceWith({
            article: wired.article,
            ...read,
            answer,
          });
          expect(Notice.messages).toEqual([]);
          expect(wired.actions.undoStack).toHaveLength(1);
          expect(wired.actions.undoStack[0]).toMatchObject({
            item: card,
            description: 'creating card "A card"',
          });

          await wired.actions.undo();

          expect(wired.deleteCard).toHaveBeenCalledExactlyOnceWith(id, {
            prompt: false,
          });
          // A PDF never held the card's embed, so there is nothing to put back
          expect(wired.editNote).not.toHaveBeenCalled();
          // Its row is deleted outright, which the repository reports no
          // change for
          expect(wired.trigger).toHaveBeenCalledExactlyOnceWith(
            'ir-highlights-changed',
            wired.file.path
          );
          vi.restoreAllMocks();
        }
      )
    );
  });

  it('makes a parentless card of a PDF that is no article, which undo deletes', async () => {
    await fc.assert(
      fc.asyncProperty(
        readArb,
        fc.tuple(fc.nat(), fc.nat()),
        fc.uuid(),
        fc.constantFrom<unknown>(null, {
          data: { id: 's', type: 'snippet' },
          file: pdfFile(),
        }),
        async (read, answer, id, item) => {
          Notice.reset();
          const card = { data: { id }, file: { basename: 'A card' } };
          const wired = wirePdfCard({ read, answer, card, item });
          const tab = {
            pdfViewer: wired.reviewView.pdfViewer,
            currentItemFile: () => wired.file,
            takesAnyPdf: true,
          };

          expect(await wired.actions.createPdfCard(tab)).toBe(card);

          expect(wired.createFromPdf).toHaveBeenCalledExactlyOnceWith({
            pdf: wired.file,
            ...read,
            answer,
          });
          expect(Notice.messages).toEqual([]);

          await wired.actions.undo();

          expect(wired.deleteCard).toHaveBeenCalledExactlyOnceWith(id, {
            prompt: false,
          });
          expect(wired.trigger).toHaveBeenCalledExactlyOnceWith(
            'ir-highlights-changed',
            wired.file.path
          );
          vi.restoreAllMocks();
        }
      )
    );
  });

  it('takes the highlight off the copy that took the card over too, when it is undone', async () => {
    const card = { data: { id: 'card-1' }, file: { basename: 'A' } };
    const copy = pdfFile('pdf', 'copy');
    const wired = wirePdfCard({
      read: READ,
      card,
      item: null,
      adoptedBy: copy,
    });
    await wired.actions.createPdfCard({
      pdfViewer: wired.reviewView.pdfViewer,
      currentItemFile: () => wired.file,
      takesAnyPdf: true,
    });

    await wired.actions.undo();

    expect(wired.trigger.mock.calls).toEqual([
      ['ir-highlights-changed', wired.file.path],
      ['ir-highlights-changed', copy.path],
    ]);
  });

  it('takes the highlight off the PDF where it is now, renamed since the card was made', async () => {
    const card = { data: { id: 'card-1' }, file: { basename: 'A' } };
    const wired = wirePdfCard({ read: READ, card, item: null });
    await wired.actions.createPdfCard({
      pdfViewer: wired.reviewView.pdfViewer,
      currentItemFile: () => wired.file,
      takesAnyPdf: true,
    });
    // Obsidian renames a file by changing its TFile's path in place
    (wired.file as { path: string }).path = 'papers/renamed.pdf';

    await wired.actions.undo();

    expect(wired.trigger.mock.calls).toEqual([
      ['ir-highlights-changed', 'papers/renamed.pdf'],
    ]);
  });

  it('leaves the highlight when undo could not delete the card', async () => {
    const card = { data: { id: 'card-1' }, file: { basename: 'A' } };
    const wired = wirePdfCard({ read: READ, card, deleted: false });
    await wired.actions.createPdfCard(wired.reviewView);

    await wired.actions.undo();

    expect(wired.deleteCard).toHaveBeenCalledExactlyOnceWith('card-1', {
      prompt: false,
    });
    expect(wired.trigger).not.toHaveBeenCalled();
    expect(wired.actions.undoStack).toHaveLength(1);
  });

  it('makes nothing when the answer is not chosen', async () => {
    const wired = wirePdfCard({ read: READ, answer: null });

    expect(await wired.actions.createPdfCard(wired.reviewView)).toBeNull();

    expect(wired.prompt).toHaveBeenCalledOnce();
    expect(wired.createFromPdf).not.toHaveBeenCalled();
    expect(wired.actions.undoStack).toEqual([]);
    // The selection was the card's input all the same, so it stays dropped
    expect(wired.viewer!.clearSelection).toHaveBeenCalledOnce();
    expect(Notice.messages).toEqual([]);
  });

  it('records nothing to undo when the card could not be saved', async () => {
    const wired = wirePdfCard({ read: READ });

    expect(await wired.actions.createPdfCard(wired.reviewView)).toBeNull();
    expect(wired.createFromPdf).toHaveBeenCalledOnce();
    expect(wired.actions.undoStack).toEqual([]);
  });

  it('says why, and asks for no answer, when there is no text to make a card of', async () => {
    const failure = new Error('worker gone');
    const anyNotice = expect.any(String) as unknown;
    const namingPaper = expect.stringContaining('paper') as unknown;
    const cases: [Parameters<typeof wirePdfCard>[0], unknown][] = [
      [{ read: null }, anyNotice],
      [{ selection: null }, anyNotice],
      [{ pdfDocument: null }, anyNotice],
      [{ read: failure }, anyNotice],
      [{ noViewer: true }, anyNotice],
      // Review only ever shows articles
      [{ read: READ, item: null }, namingPaper],
      [
        {
          read: READ,
          item: { data: { id: 's', type: 'snippet' }, file: pdfFile() },
        },
        namingPaper,
      ],
    ];
    for (const [options, message] of cases) {
      Notice.reset();
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const wired = wirePdfCard(options);

      expect(await wired.actions.createPdfCard(wired.reviewView)).toBeNull();

      expect(Notice.messages).toEqual([message]);
      expect(wired.prompt).not.toHaveBeenCalled();
      expect(wired.createFromPdf).not.toHaveBeenCalled();
      expect(wired.actions.undoStack).toEqual([]);
      expect(error.mock.calls).toEqual(
        options.read === failure ? [[failure]] : []
      );
      vi.restoreAllMocks();
    }
  });
});

describe('Actions.confirmSelection for a PDF', () => {
  beforeEach(() => {
    Notice.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stays in the mode, and says so, while nothing is selected in the viewer', async () => {
    const said = async (pageHasText: boolean, kind: SelectionKind) => {
      Notice.reset();
      const { plugin, actions } = wireSelectionActions();
      const fromPdf = spyPdfCreators(actions);
      wireSelectionMode(kind);
      const { reviewView } = makeSelectingView(null, pdfFile());
      const { viewer } = withPdfViewer(
        reviewView,
        null,
        pdfDocumentWith([pageHasText ? ['Text'] : []])
      );

      await actions.confirmSelection(reviewView);

      expect(Notice.messages).toHaveLength(1);
      expect(dispatched(plugin)).toEqual([]);
      expect(fromPdf.snippet).not.toHaveBeenCalled();
      expect(fromPdf.card).not.toHaveBeenCalled();
      expect(viewer!.clearSelection).not.toHaveBeenCalled();
      vi.restoreAllMocks();
      return Notice.messages[0];
    };

    const selectFirst = {
      snippet: await said(true, 'snippet'),
      card: await said(true, 'card'),
    };
    const scanned = await said(false, 'snippet');

    // Asking for a selection names what it is for
    expect(selectFirst.snippet).not.toBe(selectFirst.card);
    // A scanned page has nothing to select, which is worth saying, whatever
    // the selection was for
    expect(await said(false, 'card')).toBe(scanned);
    expect(Object.values(selectFirst)).not.toContain(scanned);
  });

  it('ends the mode and makes the snippet or card of the selection', async () => {
    for (const kind of ['snippet', 'card'] as const) {
      Notice.reset();
      const { plugin, actions, createSnippet, createCard, prompt } =
        wireSelectionActions();
      wireSelectionMode(kind);
      const { reviewView } = makeSelectingView(null, pdfFile());
      withPdfViewer(reviewView, SELECTED);
      const fromPdf = spyPdfCreators(actions);

      await actions.confirmSelection(reviewView);

      expect(dispatched(plugin)).toEqual([setSelectionMode(null)]);
      expect(fromPdf[kind]).toHaveBeenCalledExactlyOnceWith(reviewView);
      expect(
        fromPdf[kind === 'snippet' ? 'card' : 'snippet']
      ).not.toHaveBeenCalled();
      expect(createSnippet).not.toHaveBeenCalled();
      expect(createCard).not.toHaveBeenCalled();
      // The card's own path asks for its answer, not the editor's
      expect(prompt).not.toHaveBeenCalled();
      expect(Notice.messages).toEqual([]);
      vi.restoreAllMocks();
    }
  });
});

describe('Actions.extractFromPdfTab', () => {
  beforeEach(() => {
    Notice.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Obsidian's PDF tab showing `file`, whose selection source (see
   * `pdfTabSelection`) has `selection` selected, or which has none with
   * `noViewer`. The database types the file `type`. Review is in selection
   * mode for `mode`, which a tab has nothing to do with.
   */
  function wirePdfTab({
    selection = SELECTED as Range | null,
    noViewer = false,
    pdfDocument = pdfDocumentWith([['Some text']]) as unknown,
    mode = null as SelectionKind | null,
    file = pdfFile() as TFile | null,
    type = 'article' as NoteType | null | Error,
  } = {}) {
    const { plugin, actions, createSnippet, createCard } =
      wireSelectionActions();
    const getItemType = vi.fn(() =>
      type instanceof Error ? Promise.reject(type) : Promise.resolve(type)
    );
    Object.assign(plugin.reviewManager, { articles: { getItemType } });
    const fromPdf = spyPdfCreators(actions);
    wireSelectionMode(mode);
    const host = makeSelectingView(null, null).reviewView;
    const { viewer } = withPdfViewer(
      host,
      noViewer ? undefined : selection,
      pdfDocument
    );
    const view = { file } as unknown as FileView;
    const tabSelection = vi
      .spyOn(obsidianPdf, 'pdfTabSelection')
      .mockReturnValue(viewer as never);
    return {
      plugin,
      actions,
      fromPdf,
      createSnippet,
      createCard,
      viewer,
      view,
      file,
      tabSelection,
      getItemType,
    };
  }

  /**
   * What the snippet or card was made through: the tab's source and file,
   * taking any PDF, article or not.
   */
  function madeFrom(creator: MockInstance) {
    const [host] = creator.mock.calls[0] as [
      { pdfViewer: unknown; currentItemFile(): unknown; takesAnyPdf?: boolean },
    ];
    expect(host.takesAnyPdf).toBe(true);
    return { viewer: host.pdfViewer, file: host.currentItemFile() };
  }

  it('makes the snippet or card at once of the text selected in the tab, whatever mode review is in', async () => {
    await fc.assert(
      fc.asyncProperty(
        selectionKindArb,
        fc.option(selectionKindArb, { nil: null }),
        async (kind, mode) => {
          Notice.reset();
          const wired = wirePdfTab({ mode });

          await wired.actions.extractFromPdfTab(kind, wired.view);

          expect(wired.tabSelection).toHaveBeenCalledWith(wired.view);
          expect(wired.fromPdf[kind]).toHaveBeenCalledOnce();
          expect(madeFrom(wired.fromPdf[kind])).toEqual({
            viewer: wired.viewer,
            file: wired.file,
          });
          expect(
            wired.fromPdf[kind === 'snippet' ? 'card' : 'snippet']
          ).not.toHaveBeenCalled();
          // A tab has no selection mode: review's is left as it was
          expect(dispatched(wired.plugin)).toEqual([]);
          expect(wired.createSnippet).not.toHaveBeenCalled();
          expect(wired.createCard).not.toHaveBeenCalled();
          expect(Notice.messages).toEqual([]);
          vi.restoreAllMocks();
        }
      )
    );
  });

  it('asks for a selection first, and makes nothing, with nothing selected in the tab', async () => {
    const said: Record<SelectionKind, string[]> = { snippet: [], card: [] };
    for (const kind of ['snippet', 'card'] as const) {
      for (const mode of [null, 'snippet', 'card'] as const) {
        Notice.reset();
        const wired = wirePdfTab({ selection: null, mode });

        await wired.actions.extractFromPdfTab(kind, wired.view);

        expect(Notice.messages).toHaveLength(1);
        said[kind].push(Notice.messages[0]);
        expect(wired.fromPdf.snippet).not.toHaveBeenCalled();
        expect(wired.fromPdf.card).not.toHaveBeenCalled();
        expect(dispatched(wired.plugin)).toEqual([]);
        vi.restoreAllMocks();
      }
    }

    // One request per kind, whatever mode review is in
    expect(new Set(said.snippet).size).toBe(1);
    expect(new Set(said.card).size).toBe(1);
    expect(said.snippet[0]).not.toBe(said.card[0]);
  });

  it('says there is no selectable text when no page on screen has any', async () => {
    await fc.assert(
      fc.asyncProperty(selectionKindArb, async (kind) => {
        Notice.reset();
        const wired = wirePdfTab({
          selection: null,
          pdfDocument: pdfDocumentWith([[' ']]),
        });

        await wired.actions.extractFromPdfTab(kind, wired.view);
        const [scanned] = Notice.messages;
        expect(Notice.messages).toHaveLength(1);
        expect(wired.fromPdf[kind]).not.toHaveBeenCalled();
        vi.restoreAllMocks();

        // Not the request for a selection a page with text gets
        Notice.reset();
        const withText = wirePdfTab({ selection: null });
        await withText.actions.extractFromPdfTab(kind, withText.view);
        expect(Notice.messages).toHaveLength(1);
        expect(Notice.messages).not.toContain(scanned);
        vi.restoreAllMocks();
      })
    );
  });

  it('makes the snippet or card of any PDF, article or not, leaving it to them to tell which', async () => {
    await fc.assert(
      fc.asyncProperty(
        selectionKindArb,
        fc.constantFrom<NoteType | null | Error>(
          null,
          'article',
          'snippet',
          'card',
          new Error('db gone')
        ),
        async (kind, type) => {
          Notice.reset();
          const wired = wirePdfTab({ type });

          await wired.actions.extractFromPdfTab(kind, wired.view);

          // Not asked first: the snippet or card reads the row itself
          expect(wired.getItemType).not.toHaveBeenCalled();
          expect(wired.fromPdf[kind]).toHaveBeenCalledOnce();
          expect(madeFrom(wired.fromPdf[kind])).toEqual({
            viewer: wired.viewer,
            file: wired.file,
          });
          expect(Notice.messages).toEqual([]);
          vi.restoreAllMocks();
        }
      )
    );
  });

  it("leaves it to the snippet or card to say why, when the tab's viewer is not one this knows", async () => {
    await fc.assert(
      fc.asyncProperty(selectionKindArb, async (kind) => {
        const wired = wirePdfTab({ noViewer: true });

        await wired.actions.extractFromPdfTab(kind, wired.view);

        expect(wired.fromPdf[kind]).toHaveBeenCalledOnce();
        expect(madeFrom(wired.fromPdf[kind])).toEqual({
          viewer: null,
          file: wired.file,
        });
        vi.restoreAllMocks();
      })
    );
  });

  it('ignores a second press while the first is making its snippet or card, wherever it was made', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('tab', 'review'),
        selectionKindArb,
        selectionKindArb,
        async (first, kind, secondKind) => {
          Notice.reset();
          const wired = wirePdfTab();
          let finish!: () => void;
          wired.fromPdf[kind].mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                finish = () => resolve(null);
              })
          );
          const { reviewView } = makeSelectingView(null, pdfFile());
          withPdfViewer(reviewView, SELECTED);

          const firstPress =
            first === 'tab'
              ? wired.actions.extractFromPdfTab(kind, wired.view)
              : wired.actions.extract(kind, reviewView);
          // Pressed while the first is still looking the PDF up, and again
          // once it is making the snippet or card
          await wired.actions.extractFromPdfTab(secondKind, wired.view);
          await vi.waitFor(() =>
            expect(wired.fromPdf[kind]).toHaveBeenCalled()
          );
          await wired.actions.extractFromPdfTab(secondKind, wired.view);
          finish();
          await firstPress;

          expect(wired.fromPdf[kind]).toHaveBeenCalledOnce();
          expect(
            wired.fromPdf[kind === 'snippet' ? 'card' : 'snippet']
          ).not.toHaveBeenCalled();

          // Over once it is: the next press is heard again
          await wired.actions.extractFromPdfTab(secondKind, wired.view);
          expect(wired.fromPdf[secondKind]).toHaveBeenCalledTimes(
            kind === secondKind ? 2 : 1
          );
          vi.restoreAllMocks();
        }
      )
    );
  });
});

describe('Actions.createPdfSnippet and createPdfCard from a PDF tab', () => {
  beforeEach(() => {
    Notice.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("read the tab's selection in its viewer, for the article the tab shows", async () => {
    await fc.assert(
      fc.asyncProperty(selectionKindArb, async (kind) => {
        Notice.reset();
        const file = pdfFile('pdf', 'paper');
        const article = { data: { id: 'article-1', type: 'article' }, file };
        const read = {
          start: 1e10,
          end: 1e10 + 1,
          text: 'a',
          subpath: '#page=1',
        };
        const plugin = makePlugin();
        const getReviewItemFromFile = vi.fn().mockResolvedValue(article);
        const made = { data: { id: 'made' }, file: { basename: 'Made' } };
        const createFromPdf = vi.fn().mockResolvedValue(made);
        Object.assign(plugin.reviewManager, {
          getReviewItemFromFile,
          articles: { getItemType: vi.fn().mockResolvedValue('article') },
          snippets: { createFromPdf },
          cards: { createFromPdf },
        });
        const actions = new Actions(plugin);
        const readPdfSelection = vi
          .spyOn(pdfSelection, 'readPdfSelection')
          .mockResolvedValue(read);
        vi.spyOn(CardAnswerModal, 'promptForCardAnswer').mockResolvedValue([
          0, 1,
        ]);
        const host = makeSelectingView(null, null).reviewView;
        const { viewer } = withPdfViewer(host, SELECTED);
        vi.spyOn(obsidianPdf, 'pdfTabSelection').mockReturnValue(
          viewer as never
        );
        const view = { file } as unknown as FileView;

        await actions.extractFromPdfTab(kind, view);

        expect(readPdfSelection).toHaveBeenCalledExactlyOnceWith(
          SELECTED,
          viewer!.containerEl,
          viewer!.pdfDocument()
        );
        expect(viewer!.clearSelection).toHaveBeenCalledOnce();
        expect(getReviewItemFromFile).toHaveBeenCalledExactlyOnceWith(file);
        expect(createFromPdf).toHaveBeenCalledExactlyOnceWith(
          kind === 'snippet'
            ? { article, ...read }
            : { article, ...read, answer: [0, 1] }
        );
        expect(actions.undoStack).toHaveLength(1);
        expect(Notice.messages).toEqual([]);
        vi.restoreAllMocks();
      })
    );
  });

  it('says why, and makes nothing, for a tab that has no file', async () => {
    const plugin = makePlugin();
    const actions = new Actions(plugin);
    const readPdfSelection = vi.spyOn(pdfSelection, 'readPdfSelection');
    const host = makeSelectingView(null, null).reviewView;
    const { viewer } = withPdfViewer(host, SELECTED);
    vi.spyOn(obsidianPdf, 'pdfTabSelection').mockReturnValue(viewer as never);

    await actions.extractFromPdfTab('snippet', {
      file: null,
    } as unknown as FileView);

    expect(Notice.messages).toHaveLength(1);
    expect(readPdfSelection).not.toHaveBeenCalled();
  });
});

describe('Actions.cancelSelection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ends the mode and collapses the selection where it ended', () => {
    fc.assert(
      fc.property(editorArb, (editor) => {
        const { plugin, actions, createSnippet, createCard } =
          wireSelectionActions();
        const { reviewView, cm, domSelection } = makeSelectingView(editor);

        actions.cancelSelection(reviewView);

        expect(dispatched(plugin)).toEqual([setSelectionMode(null)]);
        expect(cm!.dispatch).toHaveBeenCalledExactlyOnceWith({
          selection: { anchor: editor.head },
        });
        expect(domSelection.removeAllRanges).toHaveBeenCalledOnce();
        expect(createSnippet).not.toHaveBeenCalled();
        expect(createCard).not.toHaveBeenCalled();
        vi.restoreAllMocks();
      })
    );
  });

  it('leaves a selection outside the editor alone', () => {
    const { actions } = wireSelectionActions();
    const { reviewView, contentDOM, domSelection } = makeSelectingView({
      doc: 'some text',
      anchor: 0,
      head: 4,
    });
    contentDOM.contains.mockReturnValue(false);

    actions.cancelSelection(reviewView);

    expect(domSelection.removeAllRanges).not.toHaveBeenCalled();
  });

  it('ends the mode where there is no editor', () => {
    const { plugin, actions } = wireSelectionActions();
    const { reviewView } = makeSelectingView(null);

    actions.cancelSelection(reviewView);

    expect(dispatched(plugin)).toEqual([setSelectionMode(null)]);
  });

  it("ends the mode and drops a PDF viewer's selection", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Range | null>(SELECTED, null),
        (selection) => {
          const { plugin, actions } = wireSelectionActions();
          const { reviewView } = makeSelectingView(null, pdfFile());
          const { viewer } = withPdfViewer(reviewView, selection);

          actions.cancelSelection(reviewView);

          expect(dispatched(plugin)).toEqual([setSelectionMode(null)]);
          expect(viewer!.clearSelection).toHaveBeenCalledOnce();
          vi.restoreAllMocks();
        }
      )
    );
  });
});

describe('Actions — undo of a card grade', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('puts the card back as it was, dismissal and all, in its one rollback, leaving nothing else to undo', async () => {
    await fc.assert(
      fc.asyncProperty(reviewCaseArb, async (c) => {
        const { plugin, item, actions } = wireCase({ ...c, type: 'card' });
        await actions.gradeCard(item as ReviewCard, c.grade);

        await actions.undo();

        const { reviewManager } = plugin;
        expect(
          (reviewManager.cards.rollbackBeforeReview as ReturnType<typeof vi.fn>)
            .mock.calls
        ).toEqual([
          [
            expect.objectContaining({ id: c.itemId, dismissed: c.dismissed }),
            c.reviewId,
          ],
        ]);
        // A dismissal written apart from the rollback could be lost apart
        // from it, and would be an undo of its own
        expect(
          (reviewManager.dismissItem as ReturnType<typeof vi.fn>).mock.calls
        ).toEqual([]);
        expect(actions.undoStack).toEqual([]);
      })
    );
  });
});

describe('Actions.undo while writes are refused', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves an undo that writes on the stack, unrun, and says why', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.string(),
        async (description, reason) => {
          vi.restoreAllMocks();
          const notify = vi
            .spyOn(Obsidian, 'notify')
            .mockReturnValue(undefined);
          const actions = refusing(reason);
          const undo = vi.fn();
          const entry = { item: makeReviewItem('a'), description, undo };
          actions._pushUndo(entry);

          await actions.undo();

          expect(undo).not.toHaveBeenCalled();
          expect(actions.undoStack).toEqual([entry]);
          expect(notify).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
            kind: 'error',
          });
          const [message] = notify.mock.calls[0];
          expect(message).toContain(description);
          expect(message).toContain(reason);
        }
      )
    );
  });

  it('still undoes a skip, which writes nothing', async () => {
    const actions = refusing('paused');
    vi.spyOn(actions, '_returnToItem').mockImplementation(() => {});
    vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
    actions.skipItem(makeReviewItem('a'));

    await actions.undo();

    expect(actions.undoStack).toEqual([]);
    expect(actions._returnToItem).toHaveBeenCalledOnce();
  });
});

describe('Actions — undo of a card made from a note', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('puts the line back in place of the embed once the card is deleted', async () => {
    await fc.assert(
      fc.asyncProperty(cardNoteArb, async (note) => {
        vi.restoreAllMocks();
        const { text, deleteCard } = await makeCardThenUndo(note, true);

        expect(deleteCard).toHaveBeenCalledOnce();
        expect(text()).toBe(note.before + note.line + note.after);
      })
    );
  });

  it('leaves the embed where it was when the card is not deleted, keeping the undo, and says why in the console', async () => {
    await fc.assert(
      fc.asyncProperty(cardNoteArb, async (note) => {
        vi.restoreAllMocks();
        const { text, error, actions } = await makeCardThenUndo(note, false);

        expect(text()).toBe(note.before + note.embed + note.after);
        expect(actions.undoStack).toHaveLength(1);
        expect(String(error.mock.calls[0]?.[0])).toBe(
          'Error: Kept the card "card"'
        );
      })
    );
  });

  it('takes the delimiters it put around the embed out with it, while they are still there', async () => {
    await fc.assert(
      fc.asyncProperty(
        cardNoteArb,
        fc.record({ before: fc.string(), after: fc.string() }),
        fc.boolean(),
        async (note, around, kept) => {
          vi.restoreAllMocks();
          const written = kept ? around : { before: '', after: '' };
          fc.pre(
            kept ||
              (!note.before.endsWith(around.before) &&
                !note.after.startsWith(around.after))
          );
          const { text } = await makeCardThenUndo(
            {
              ...note,
              before: note.before + written.before,
              after: written.after + note.after,
            },
            true,
            undefined,
            around
          );

          expect(text()).toBe(note.before + note.line + note.after);
        }
      )
    );
  });

  it('puts the embed back with the delimiters around it when the card is not deleted', async () => {
    await fc.assert(
      fc.asyncProperty(
        cardNoteArb,
        fc.record({ before: fc.string(), after: fc.string() }),
        async (note, around) => {
          vi.restoreAllMocks();
          const written = {
            ...note,
            before: note.before + around.before,
            after: around.after + note.after,
          };
          const { text } = await makeCardThenUndo(
            written,
            false,
            undefined,
            around
          );

          expect(text()).toBe(written.before + note.embed + written.after);
        }
      )
    );
  });

  it('puts no embed over a line edited meanwhile', async () => {
    await fc.assert(
      fc.asyncProperty(cardNoteArb, fc.string(), async (note, edited) => {
        fc.pre(!(edited + note.after).startsWith(note.line));
        vi.restoreAllMocks();
        const changed = note.before + edited + note.after;

        const { text } = await makeCardThenUndo(note, false, () => changed);

        expect(text()).toBe(changed);
      })
    );
  });
});

describe('Actions — plain writes the database refused', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Each action whose one write `method` of the review manager makes. */
  const WRITES = [
    {
      method: 'reviewArticle',
      run: (a: Actions, item: (type: NoteType) => ReviewItem) =>
        a.reviewArticle(item('article') as ReviewArticle),
    },
    {
      method: 'reviewSnippet',
      run: (a: Actions, item: (type: NoteType) => ReviewItem) =>
        a.reviewSnippet(item('snippet') as ReviewSnippet),
    },
    {
      method: 'reviewCard',
      run: (a: Actions, item: (type: NoteType) => ReviewItem) =>
        a.gradeCard(item('card') as ReviewCard, 3),
    },
    {
      method: 'reprioritize',
      run: (a: Actions, item: (type: NoteType) => ReviewItem) =>
        a.reprioritize(item('article') as ReviewText, 40),
    },
    {
      method: 'manageFixedInterval',
      run: (a: Actions, item: (type: NoteType) => ReviewItem) =>
        a.manageFixedInterval(item('article') as ReviewArticle, {
          newIntervalDays: 3,
        }),
    },
    {
      method: 'dismissItem',
      run: (a: Actions, item: (type: NoteType) => ReviewItem) =>
        a.dismissItem(item('snippet')),
    },
    {
      method: 'unDismissItem',
      run: (a: Actions, item: (type: NoteType) => ReviewItem) =>
        a.unDismissItem(item('snippet')),
    },
  ] as const;

  it.each(WRITES)(
    'leaves $method refused quietly, the user told why already: no undo, no confirmation, no failure, nothing thrown',
    async ({ method, run }) => {
      const plugin = makeReviewingPlugin({
        reviewId: 'review-1',
        dayRolloverOffset: 4,
      });
      Object.assign(plugin.reviewManager, {
        [method]: vi.fn().mockRejectedValue(new ActionRefusedError(method)),
      });
      const notify = vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
      const logged = vi.spyOn(console, 'error').mockReturnValue(undefined);
      const actions = new Actions(plugin);
      const item = (type: NoteType) =>
        makeTypedItem(type, { id: type, dismissed: false });

      await expect(run(actions, item)).resolves.toBeUndefined();

      expect(actions.undoStack).toEqual([]);
      expect(notify).not.toHaveBeenCalled();
      expect(logged).not.toHaveBeenCalled();
    }
  );

  it.each(WRITES)(
    'still lets any other failure of $method out',
    async ({ method, run }) => {
      const plugin = makeReviewingPlugin({
        reviewId: 'review-1',
        dayRolloverOffset: 4,
      });
      const failure = new Error('disk full');
      Object.assign(plugin.reviewManager, {
        [method]: vi.fn().mockRejectedValue(failure),
      });
      const notify = vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
      const logged = vi.spyOn(console, 'error').mockReturnValue(undefined);
      const actions = new Actions(plugin);
      const item = (type: NoteType) =>
        makeTypedItem(type, { id: type, dismissed: false });

      const outcome = await run(actions, item).then(
        () => null,
        (error: unknown) => error
      );

      // Thrown on, logged, or told as a failure: anything but swallowed
      const told =
        outcome === failure ||
        logged.mock.calls.some(([error]) => error === failure) ||
        notify.mock.calls.some(([, options]) => options?.kind === 'error');
      expect(told).toBe(true);
      expect(actions.undoStack).toEqual([]);
    }
  );
});

describe('Actions.deleteItem', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['starting', 'merging'] as const)(
    'deletes no note, and says why, while not ready (%s): its row would be left behind',
    async (state) => {
      const plugin = makePlugin();
      const markDeleted = vi.fn();
      // A merge that outlasts the wait for it (see `refusedAction`)
      runOutMergeWait();
      Object.assign(plugin.reviewManager, {
        repo: {
          writeRefusal: () =>
            state === 'starting' ? new Error('Saving is paused.') : null,
          readiness: state,
          onReadinessChange: () => () => undefined,
        },
        articles: { markDeleted },
      });
      const promptForFileDeletion = vi.fn().mockResolvedValue(true);
      Object.assign(plugin.app, { fileManager: { promptForFileDeletion } });
      const notify = vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
      const item = makeReviewItem('my-article');

      await new Actions(plugin).deleteItem(item);

      expect(promptForFileDeletion).not.toHaveBeenCalled();
      expect(markDeleted).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
        kind: 'error',
      });
      const [message] = notify.mock.calls[0];
      expect(message).toContain('my-article');
      expect(message).toContain(refusalReason(state));
    }
  );

  it('marks the row deleted before deleting the note as Obsidian does, then moves on', async () => {
    const wired = wireDeleteItem(async () => true);
    const item = makeReviewItem('my-article');

    await wired.actions.deleteItem(item);

    expect(wired.promptForFileDeletion).toHaveBeenCalledExactlyOnceWith(
      item.file
    );
    // Marked again once the note is gone, as review may have unmarked it
    expect(wired.log).toEqual([
      'deleted article item-1',
      'prompt',
      'deleted article item-1',
    ]);
    expect(wired.getNext).toHaveBeenCalledOnce();
  });

  it('puts the row back, and stays on the item, when the note is not deleted', async () => {
    const declined = async () => false;
    for (const prompt of [
      declined,
      async () => {
        throw new Error('trash failed');
      },
    ]) {
      vi.restoreAllMocks();
      const wired = wireDeleteItem(prompt);

      await wired.actions.deleteItem(makeReviewItem('my-article'));

      expect(wired.log).toEqual([
        'deleted article item-1',
        'prompt',
        'undeleted article item-1',
      ]);
      expect(wired.getNext).not.toHaveBeenCalled();
      expect(
        vi.mocked(console.error).mock.calls.map(([e]) => String(e))
      ).toEqual([
        prompt === declined
          ? `Error: Kept ${makeReviewItem('my-article').file.path}`
          : 'Error: trash failed',
      ]);
    }
  });

  it('keeps the row deleted when the prompt fails past trashing the note', async () => {
    const failure = new Error('attachment busy');
    const wired = wireDeleteItem(async () => {
      throw failure;
    }, true);

    await wired.actions.deleteItem(makeReviewItem('my-article'));

    expect(wired.log).toEqual([
      'deleted article item-1',
      'prompt',
      'deleted article item-1',
    ]);
    expect(console.error).toHaveBeenCalledWith(failure);
    expect(wired.getNext).toHaveBeenCalledOnce();
  });

  it('asks nothing when the row cannot be marked deleted', async () => {
    const wired = wireDeleteItem(async () => true);
    wired.markDeleted.mockRejectedValueOnce(new Error('write failed'));

    await wired.actions.deleteItem(makeReviewItem('my-article'));

    expect(wired.promptForFileDeletion).not.toHaveBeenCalled();
    expect(wired.getNext).not.toHaveBeenCalled();
  });
});

describe('Actions.undo of something it could not take back', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the entry to try again, and says it was not undone rather than undone', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (description) => {
        vi.restoreAllMocks();
        const notify = vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
        const actions = new Actions(makePlugin());
        const entry = {
          item: makeReviewItem('a'),
          description,
          undo: vi.fn(async () => 'retry' as const),
        };
        actions._pushUndo(entry);
        const listener = vi.fn();
        actions.subscribe(listener);

        await actions.undo();

        expect(actions.undoStack).toEqual([entry]);
        // No success kind: a plain notice, not the one an undo confirms with
        expect(notify).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining(description)
        );
        // Told it is back as well as that it came off
        expect(listener).toHaveBeenCalledTimes(2);
      })
    );
  });

  it('drops the entry, and says it could not undo it, when it failed for any other reason', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.boolean(),
        async (description, throws) => {
          vi.restoreAllMocks();
          const notify = vi
            .spyOn(Obsidian, 'notify')
            .mockReturnValue(undefined);
          const actions = new Actions(makePlugin());
          const failure = new Error('undo failed');
          actions._pushUndo({
            item: makeReviewItem('a'),
            description,
            undo: async () => {
              if (throws) throw failure;
              return 'failed' as const;
            },
          });

          const undone = actions.undo();
          if (throws) await expect(undone).rejects.toBe(failure);
          else await undone;

          expect(actions.undoStack).toEqual([]);
          expect(notify).toHaveBeenCalledExactlyOnceWith(
            expect.stringContaining(description),
            { kind: 'error' }
          );
        }
      )
    );
  });
});

describe('Actions — undo of a snippet made from a note', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the undo when deleting the snippet is turned down or refused, and drops it when that fails otherwise', async () => {
    for (const outcome of ['declined', 'refused', 'failed'] as const) {
      vi.restoreAllMocks();
      const plugin = makePlugin();
      const snippet = { data: { id: 'snippet-1' }, file: makeTFile('snippet') };
      const deleteSnippet = vi.fn().mockResolvedValue(outcome);
      Object.assign(plugin.reviewManager, {
        createSnippet: vi.fn().mockResolvedValue(snippet),
        snippets: { delete: deleteSnippet },
      });
      Object.assign(plugin.app.workspace, {
        activeEditor: { editor: {} },
        getActiveViewOfType: () => ({ file: makeTFile('source') }),
      });
      Object.assign(plugin, { getActiveReviewView: () => null });
      const notify = vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
      const actions = new Actions(plugin);
      await actions.createSnippet();

      await actions.undo();

      expect(deleteSnippet).toHaveBeenCalledExactlyOnceWith('snippet-1');
      expect(actions.undoStack).toHaveLength(outcome === 'failed' ? 0 : 1);
      if (outcome === 'failed') {
        expect(notify).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining('snippet'),
          { kind: 'error' }
        );
      } else {
        expect(notify).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining('snippet')
        );
      }
    }
  });
});

describe('Actions.recordImport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('property: records one entry for an import of one file, unless it made or brought back nothing', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Long ones too, which the description cuts short
        fc.oneof(fc.string(), fc.string({ minLength: 40, maxLength: 120 })),
        fc.option(importedArb, { nil: null }),
        async (name, result) => {
          vi.restoreAllMocks();
          const { actions, undoImports, refresh, listener } = wireImports();

          const entry = actions.recordImport({ name, result });

          if (result === null || result.effect === 'linked') {
            expect(entry).toBeNull();
            expect(actions.undoStack).toEqual([]);
            expect(listener).not.toHaveBeenCalled();
            return;
          }
          expect(actions.undoStack).toEqual([entry]);
          expect(listener).toHaveBeenCalledOnce();
          expect(entry!.writes).toBe(true);
          expect(entry!.description).toContain(
            `"${getContentSlice(name, CONTENT_TITLE_SLICE_LENGTH, true)}"`
          );

          await actions.undo();

          expect(undoImports).toHaveBeenCalledExactlyOnceWith([result]);
          expect(refresh).toHaveBeenCalledExactlyOnceWith([result.articleId]);
          expect(actions.undoStack).toEqual([]);
        }
      )
    );
  });

  it('property: records one entry for a bulk import that made or brought back anything, counting those', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.array(bulkOutcomeArb, { maxLength: 6 }),
        async (from, outcomes) => {
          vi.restoreAllMocks();
          const { actions, undoImports, listener } = wireImports();
          const expected = undoable(outcomes);

          const entry = actions.recordImport({ from, outcomes });

          if (expected.length === 0) {
            expect(entry).toBeNull();
            expect(actions.undoStack).toEqual([]);
            expect(listener).not.toHaveBeenCalled();
            return;
          }
          expect(actions.undoStack).toEqual([entry]);
          expect(listener).toHaveBeenCalledOnce();
          expect(entry!.writes).toBe(true);
          const count = expected.length;
          expect(entry!.description).toContain(
            ` ${count} article${count === 1 ? '' : 's'} `
          );
          expect(entry!.description.endsWith(` ${from}`)).toBe(true);

          await actions.undo();

          // In the order imported: the manager takes them back last first
          expect(undoImports).toHaveBeenCalledExactlyOnceWith(expected);
        }
      )
    );
  });

  it('property: says it could not undo an import when nothing was taken back, and that it did when anything was', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          importedArb.filter(({ effect }) => effect !== 'linked'),
          { minLength: 1, maxLength: 4 }
        ),
        fc.nat(),
        async (imports, kept) => {
          vi.restoreAllMocks();
          const keep = kept % (imports.length + 1);
          const undone = imports.slice(keep).map(({ articleId }) => articleId);
          const { actions, refresh, notify } = wireImports(() => undone);
          const outcomes = imports.map((imported) => ({
            file: makeTFile('f'),
            status: 'imported' as const,
            ...imported,
          }));
          const entry = actions.recordImport({ from: 'x', outcomes })!;

          await actions.undo();

          expect(refresh).toHaveBeenCalledExactlyOnceWith(undone);
          expect(actions.undoStack).toEqual([]);
          expect(notify).toHaveBeenCalledExactlyOnceWith(
            expect.stringContaining(entry.description),
            undone.length === 0
              ? { kind: 'error' }
              : { kind: 'success', category: 'undo' }
          );
        }
      )
    );
  });

  it('is held while writes are refused, as every undo that writes is', async () => {
    const { actions, undoImports } = wireImports();
    Object.assign(actions.plugin.reviewManager, {
      repo: {
        writeRefusal: () => new Error('Saving is paused.'),
        readiness: 'starting',
      },
    });
    const entry = actions.recordImport({
      name: 'a',
      result: { articleId: 'a', effect: 'created' },
    });

    await actions.undo();

    expect(undoImports).not.toHaveBeenCalled();
    expect(actions.undoStack).toEqual([entry]);
  });
});

describe('Actions.undoEntry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('property: undoes the entry given wherever it is, leaving the rest in order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.nat(),
        async (count, at) => {
          vi.restoreAllMocks();
          const { actions, notify, listener } = wireImports();
          const entries = Array.from({ length: count }, (_, i) =>
            plainEntry(`doing ${i}`)
          );
          entries.forEach((entry) => actions._pushUndo(entry));
          listener.mockClear();
          const target = entries[at % count];

          await actions.undoEntry(target);

          expect(target.undo).toHaveBeenCalledOnce();
          for (const other of entries.filter((entry) => entry !== target)) {
            expect(other.undo).not.toHaveBeenCalled();
          }
          expect(actions.undoStack).toEqual(
            entries.filter((entry) => entry !== target)
          );
          expect(listener).toHaveBeenCalledOnce();
          expect(notify).toHaveBeenCalledExactlyOnceWith(
            expect.stringContaining(target.description),
            { kind: 'success', category: 'undo' }
          );
        }
      )
    );
  });

  it('undoes an entry asked for twice while a merge is under way once, after the merge', async () => {
    const { actions } = wireImports();
    const repo = mergingRepo();
    Object.assign(actions.plugin.reviewManager, { repo });
    const below: ActionStackEntry = {
      description: 'below',
      undo: vi.fn(),
      writes: true,
    };
    const target: ActionStackEntry = {
      description: 'target',
      undo: vi.fn(),
      writes: true,
    };
    actions._pushUndo(below);
    actions._pushUndo(target);

    const first = actions.undoEntry(target);
    const second = actions.undoEntry(target);
    await Promise.resolve();
    expect(target.undo).not.toHaveBeenCalled();
    repo.becomes('ready');
    await Promise.all([first, second]);

    expect(target.undo).toHaveBeenCalledOnce();
    expect(below.undo).not.toHaveBeenCalled();
    expect(actions.undoStack).toEqual([below]);
  });

  it('property: puts an entry to try again back where it was, or on top once what was above it is gone', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.nat(),
        fc.nat(),
        async (count, at, dropped) => {
          vi.restoreAllMocks();
          const { actions } = wireImports();
          const index = at % count;
          // What its undo takes off the top meanwhile, of what was above it
          const drop = dropped % (count - index);
          const entries = Array.from({ length: count }, (_, i) =>
            plainEntry(`doing ${i}`, () => {
              if (i !== index) return;
              for (let n = 0; n < drop; n++) actions.undoStack.pop();
              return 'retry';
            })
          );
          entries.forEach((entry) => actions._pushUndo(entry));

          await actions.undoEntry(entries[index]);

          expect(actions.undoStack).toEqual([
            ...entries.slice(0, index),
            entries[index],
            ...entries.slice(index + 1, count - drop),
          ]);
        }
      )
    );
  });

  it('says the entry was undone already, doing nothing, once it is off the stack', async () => {
    const { actions, notify, listener } = wireImports();
    const kept = [plainEntry('kept'), plainEntry('kept too')];
    const gone = plainEntry('gone');
    kept.forEach((entry) => actions._pushUndo(entry));
    listener.mockClear();

    for (const entry of [gone, undefined]) {
      notify.mockClear();

      await actions.undoEntry(entry);

      expect(notify).toHaveBeenCalledExactlyOnceWith(expect.any(String));
      expect(gone.undo).not.toHaveBeenCalled();
      for (const { undo } of kept) expect(undo).not.toHaveBeenCalled();
      expect(actions.undoStack).toEqual(kept);
      expect(listener).not.toHaveBeenCalled();
    }
  });

  it('undoes the top entry through undo, and says so when there is none', async () => {
    const { actions, notify } = wireImports();
    const [below, top] = [plainEntry('below'), plainEntry('top')];
    actions._pushUndo(below);
    actions._pushUndo(top);

    await actions.undo();

    expect(top.undo).toHaveBeenCalledOnce();
    expect(below.undo).not.toHaveBeenCalled();
    expect(actions.undoStack).toEqual([below]);
    const undoEntry = vi.spyOn(actions, 'undoEntry');
    actions.undoStack.pop();
    notify.mockClear();

    await actions.undo();

    expect(undoEntry).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledOnce();
  });
});

describe('Actions.undoImport and undoAction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('undo the entry recorded for an import, wherever it is, and only once', async () => {
    for (const how of ['undoImport', 'undoAction'] as const) {
      vi.restoreAllMocks();
      const { actions, undoImports, notify } = wireImports();
      const result = { articleId: 'a', effect: 'created' as const };
      const entry = actions.recordImport({ name: 'a', result })!;
      const above = plainEntry('above');
      actions._pushUndo(above);
      const run = () =>
        how === 'undoImport'
          ? actions.undoImport(result)
          : actions.undoAction(entry).onClick({ button: 0 } as MouseEvent);

      await run();
      // Its success said once it is done
      await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());

      expect(undoImports).toHaveBeenCalledExactlyOnceWith([result]);
      expect(actions.undoStack).toEqual([above]);
      notify.mockClear();

      await run();
      await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());

      expect(undoImports).toHaveBeenCalledOnce();
      expect(above.undo).not.toHaveBeenCalled();
    }
  });

  it('says an import none was recorded for is undone already', async () => {
    const { actions, undoImports, notify } = wireImports();
    const recorded = { articleId: 'a', effect: 'created' as const };
    actions.recordImport({ name: 'a', result: recorded });

    for (const result of [
      null,
      { articleId: 'a', effect: 'created' as const },
    ]) {
      notify.mockClear();

      await actions.undoImport(result);

      expect(notify).toHaveBeenCalledOnce();
    }
    expect(undoImports).not.toHaveBeenCalled();
    expect(actions.undoStack).toHaveLength(1);
  });
});
