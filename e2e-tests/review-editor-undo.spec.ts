import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import {
  emulateMobile,
  executeCommandById,
  expectReviewOn,
  importArticle,
  leafSnapshot,
  waitForReviewItem,
} from './helpers';
import {
  closeElectron,
  createVaultCopy,
  launchElectron,
  openVault,
  shouldCleanup,
} from './setup/helpers';

let app: ElectronApplication;
let window: Page;
let vaultPath: string;

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('core');
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
  if (shouldCleanup) {
    await fs
      .rm(vaultPath, { recursive: true, force: true, maxRetries: 3 })
      .catch(() => {});
  }
});

// #region HELPERS

/**
 * The page-side surface the helpers below reach. Unofficial Obsidian API:
 * `window.app`, and `workspace.activeEditor`, which review points at the
 * editor of the item on screen.
 */
type PageApp = {
  plugins: {
    plugins: Record<string, { retiredEditors?: { enabled: boolean } }>;
  };
  workspace: {
    activeLeaf: {
      id: string;
      /** Unofficial: set while `setViewState` runs. */
      working: boolean;
      view: { getViewType(): string; file?: { path: string } | null };
    } | null;
    activeEditor: {
      editor: {
        getValue(): string;
        setSelection(pos: unknown): void;
        offsetToPos(offset: number): unknown;
        focus(): void;
        cm: { contentDOM: HTMLElement };
      };
    } | null;
  };
  vault: {
    getFileByPath(path: string): unknown;
    cachedRead(file: unknown): Promise<string>;
  };
};

/** The two articles review is given, as they are named once imported in place. */
const ARTICLE_PATHS = [
  'sources/Memorizing a programming language using spaced repetition software.md',
  'sources/Curse of dimensionality - Wikipedia.md',
];

/** Typed in one go, well inside CodeMirror's 500ms grouping window. */
const BURST = 'QWERT';

/** The text the review editor on screen holds. */
async function reviewText(): Promise<string> {
  return await window.evaluate(() => {
    const { app } = window as unknown as { app: PageApp };
    return app.workspace.activeEditor?.editor.getValue() ?? '';
  });
}

/** Put the cursor at the start of the note's body in review, and type. */
async function typeAtBodyStart(text: string) {
  await window.evaluate(() => {
    const { app } = window as unknown as { app: PageApp };
    const editor = app.workspace.activeEditor?.editor;
    if (!editor) throw new Error('No editor in review');
    const value = editor.getValue();
    const body = /^---\n[\s\S]*?\n---\n/.exec(value)?.[0].length ?? 0;
    editor.setSelection(editor.offsetToPos(body));
    editor.focus();
  });
  await window.keyboard.type(text);
}

/** The Files view's row for `path`. */
const explorerRow = (path: string) =>
  window.locator(`.nav-file-title[data-path="${path}"]`);

/**
 * Wait for the note at `path` to hold `text`: the review editor saves on its
 * own schedule, and a user navigating away has long since seen it land.
 */
async function waitForSaved(path: string, text: string) {
  await expect
    .poll(
      async () =>
        await window.evaluate(async (notePath) => {
          const { app } = window as unknown as { app: PageApp };
          const file = app.vault.getFileByPath(notePath);
          return file ? await app.vault.cachedRead(file) : '';
        }, path)
    )
    .toContain(text);
}

/**
 * Review on two articles, a burst typed into the first, then over to the
 * second through the Files view, as a reader clicks there, and back.
 * Returns the text the first note had before the burst.
 *
 * Back through the tab's history rather than the Files view: the row the
 * Files view marks as the open file stays on the first article while review
 * moves, and the Files view swallows a plain click on that row.
 *
 * `stayOnSecond` stops on the second article instead of going back.
 * `asOnIos` has review keep the editors it takes down, as it does in iOS's
 * engine, whose native undo reaches an element typed into only while it is in
 * the document. `leave: 'to a plain note'` opens a note that is no item from
 * the Files view instead, which takes the review tab's place.
 */
async function typeThenLeaveAndReturn(
  leave:
    | 'files view'
    | 'with nothing focused'
    | 'to a plain note' = 'files view',
  { stayOnSecond = false, asOnIos = false } = {}
): Promise<string> {
  await importArticle(
    window,
    'sources/Memorizing a programming language using spaced repetition'
  );
  await importArticle(window, 'sources/Curse of dimensionality - Wikipedia');
  if (leave === 'files view') {
    // Opens the folder both articles were imported in place in.
    await executeCommandById(window, 'file-explorer:reveal-active-file');
  }
  await executeCommandById(window, 'incremental-reading:learn');
  await window.locator('css=#begin-review-button').click();
  const first = await waitForReviewItem(window);
  if (asOnIos) {
    await window.evaluate(() => {
      const { app } = window as unknown as { app: PageApp };
      const park = app.plugins.plugins['incremental-reading']?.retiredEditors;
      if (!park) throw new Error('The plugin keeps no taken-down editors');
      park.enabled = true;
    });
  }
  const firstPath = (await leafSnapshot(window)).file;
  if (!firstPath) throw new Error('Review holds no file');
  const original = await reviewText();

  await typeAtBodyStart(BURST);
  await waitForSaved(firstPath, BURST);
  // The editor element the burst went into, for a test to reach once review
  // has moved on from it: WebKit sends its native undo of typing there.
  await window.evaluate(() => {
    const { app } = window as unknown as { app: PageApp };
    (window as unknown as { typedInto?: HTMLElement }).typedInto =
      app.workspace.activeEditor?.editor.cm.contentDOM;
  });

  if (leave === 'to a plain note') {
    await openPlainNoteFromFilesView();
    await executeCommandById(window, 'app:go-back');
    await expectReviewOn(window, first);
    return original;
  }

  const secondPath = ARTICLE_PATHS.find((path) => path !== firstPath);
  if (!secondPath) throw new Error(`Review is on ${firstPath}`);
  if (leave === 'files view') {
    await explorerRow(secondPath).click();
  } else {
    // As a click on a button that goes with the item leaves it: on the body.
    await window.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await executeCommandById(window, 'incremental-reading:skip-item');
  }
  // Review names an imported article after its note.
  await expectReviewOn(window, {
    id: '',
    title: secondPath.replace(/^.*\//, '').replace(/\.md$/, ''),
  });
  if (stayOnSecond) return original;

  await executeCommandById(window, 'app:go-back');
  await expectReviewOn(window, first);
  return original;
}

/** A note of the test vault that no test imports. */
const PLAIN_NOTE = 'testing/Table.md';

/**
 * Open {@link PLAIN_NOTE} with a tap in the Files view, as a reader does from
 * the sidebar, and check where it opened: in the review tab's place, the tab
 * a plain tap reuses (`getLeaf(false)` → the active leaf, read from
 * obsidian.asar 1.14.5).
 */
async function openPlainNoteFromFilesView() {
  const reviewLeaf = await window.evaluate(() => {
    const { app } = window as unknown as { app: PageApp };
    return app.workspace.activeLeaf?.id;
  });
  await executeCommandById(window, 'file-explorer:open');
  const folder = window.locator('.nav-folder-title[data-path="testing"]');
  const row = explorerRow(PLAIN_NOTE);
  if (!(await row.isVisible())) await folder.click();
  await row.click();
  await expect
    .poll(async () =>
      window.evaluate((id) => {
        const { app } = window as unknown as { app: PageApp };
        const leaf = app.workspace.activeLeaf;
        return {
          sameTab: leaf?.id === id,
          type: leaf?.view.getViewType(),
          file: leaf?.view.file?.path,
          // The note done opening: the tab's history takes the review it
          // replaced only then, for back to return to (`setViewState` records
          // it last, read from obsidian.asar 1.14.5).
          opening: leaf?.working,
        };
      }, reviewLeaf)
    )
    .toEqual({
      sameTab: true,
      type: 'markdown',
      file: PLAIN_NOTE,
      opening: false,
    });
}

/** CodeMirror's redo key, as Obsidian leaves it bound on each platform. */
const REDO = process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y';

/** Redo as Electron's Edit menu binds it on every platform. */
const SHIFT_REDO = 'ControlOrMeta+Shift+z';

/**
 * Press CodeMirror's redo key with focus in the editor, which answers it with
 * its own keymap.
 *
 * On macOS, Playwright's Cmd+Shift+Z doesn't reach CodeMirror's redo binding
 * on CI, where Cmd+Z does reach undo: CodeMirror reads a Cmd+Shift+letter key
 * on macOS from `keyCode` rather than `key` (w3c-keyname, as a real Mac
 * reports the letter unshifted there). So on macOS this sends the keydown a
 * real Cmd+Shift+Z makes, which is also what Obsidian's own Edit > Redo menu
 * item sends the focused element there (read from obsidian.asar 1.15.0).
 */
async function pressEditorRedo() {
  if (process.platform !== 'darwin') {
    await window.keyboard.press(REDO);
    return;
  }
  await window.evaluate(() => {
    activeDocument.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', {
        keyCode: 90,
        which: 90,
        code: 'KeyZ',
        key: 'z',
        metaKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      })
    );
  });
}

/** What holds focus, as the class list of the focused element and where it is. */
async function focusedElement() {
  return await window.evaluate(() => {
    const focused = document.activeElement;
    return {
      body: focused === document.body,
      inEditor: focused?.closest('.cm-content') != null,
      inActionBar: focused?.closest('.ir-action-bar') != null,
    };
  });
}

/** The review tab's action bar, in the active leaf. */
const actionBar = () =>
  window.locator('.workspace-leaf.mod-active .ir-action-bar');

/**
 * Read the review editor's text over and over for a while, failing on the first
 * read that isn't `text`: long enough for an undo landing late, as one in a
 * background tab of the note does once that tab saves.
 */
async function expectNoteStays(text: string, ms = 2500) {
  const until = Date.now() + ms;
  do {
    expect(await reviewText()).toBe(text);
  } while (Date.now() < until);
}

/** Undo, then each redo key in turn, checking the note after each. */
async function expectUndoAndRedoReachTheEditor(original: string) {
  await window.keyboard.press('ControlOrMeta+z');
  await expect.poll(reviewText, PROMPT).toBe(original);
  await window.keyboard.press(SHIFT_REDO);
  await expect.poll(reviewText, PROMPT).toContain(BURST);
  await window.keyboard.press('ControlOrMeta+z');
  await expect.poll(reviewText, PROMPT).toBe(original);
  await window.keyboard.press(REDO);
  await expect.poll(reviewText, PROMPT).toContain(BURST);
}

/** Undo bound tight: the bug's undo landed over a second late. */
const PROMPT = { timeout: 1000 };

/** Phone width, where Obsidian's mobile emulation lays out as a phone. */
const PHONE = { width: 420, height: 900 };

/** Where a native undo of the burst can arrive, as a test names it. */
type HistoryInputTarget =
  | 'the editor the burst was typed into'
  | 'the editor on screen'
  | 'the focused element';

/**
 * Send the editor history `beforeinput` a native undo or redo makes (iOS
 * shake to undo, a browser's Edit menu) to `target`, as WebKit sends it: to
 * the root of the editing it takes back, wherever focus is.
 */
async function sendHistoryInput(
  target: HistoryInputTarget,
  inputType: 'historyUndo' | 'historyRedo'
) {
  await window.evaluate(
    ({ target, inputType }) => {
      const { app, typedInto } = window as unknown as {
        app: PageApp;
        typedInto?: HTMLElement;
      };
      const el =
        target === 'the editor the burst was typed into'
          ? typedInto
          : target === 'the editor on screen'
            ? app.workspace.activeEditor?.editor.cm.contentDOM
            : document.activeElement;
      if (!el) throw new Error(`Nothing to send ${inputType} to`);
      el.dispatchEvent(
        new InputEvent('beforeinput', {
          inputType,
          bubbles: true,
          cancelable: true,
        })
      );
    },
    { target, inputType }
  );
}

/**
 * Mobile emulation at phone width, review keeping the editors it takes down
 * as on iOS, then the repro of the burst left behind.
 */
async function typeThenLeaveAndReturnOnPhone(
  options: { stayOnSecond?: boolean; toPlainNote?: boolean } = {}
): Promise<string> {
  await emulateMobile(window, true);
  await window.setViewportSize(PHONE);
  await expect(window.locator('body')).toHaveClass(/\bis-phone\b/);
  return await typeThenLeaveAndReturn(
    options.toPlainNote ? 'to a plain note' : 'with nothing focused',
    { stayOnSecond: options.stayOnSecond, asOnIos: true }
  );
}

/**
 * Where the editor the burst was typed into is: whether it is in the
 * document, where WebKit's native undo still reaches it; whether it shows;
 * and how many editors review keeps beside it.
 */
async function typedIntoEditorPlace() {
  return await window.evaluate(() => {
    const { typedInto } = window as unknown as { typedInto?: HTMLElement };
    if (!typedInto) throw new Error('No editor typed into');
    return {
      connected: typedInto.isConnected,
      visible: typedInto.checkVisibility(),
      keptBeside: (typedInto.parentElement?.childElementCount ?? 0) - 1,
    };
  });
}

// #endregion

for (const focusFirst of [true, false]) {
  test(`one undo in review after leaving and returning takes back the burst typed, and redo puts it back (${focusFirst ? 'editor focused first' : 'focus left as the Files view left it'})`, async () => {
    const original = await typeThenLeaveAndReturn();
    expect(await reviewText()).toContain(BURST);

    if (focusFirst) {
      await window.evaluate(() => {
        const { app } = window as unknown as { app: PageApp };
        app.workspace.activeEditor?.editor.focus();
      });
    }

    await window.keyboard.press('ControlOrMeta+z');
    await expect.poll(reviewText, PROMPT).toBe(original);

    await pressEditorRedo();
    await expect.poll(reviewText, PROMPT).toContain(BURST);
  });
}

test('undo and redo keys pressed on the action bar after leaving and returning reach the editor', async () => {
  const original = await typeThenLeaveAndReturn();
  await actionBar().locator('button').filter({ visible: true }).first().focus();
  expect(await focusedElement()).toMatchObject({ inActionBar: true });

  await expectUndoAndRedoReachTheEditor(original);
});

test('undo and redo keys reach the editor with focus where review left it after moving on', async () => {
  const original = await typeThenLeaveAndReturn('with nothing focused');
  expect(await focusedElement()).toMatchObject({ body: true });

  await expectUndoAndRedoReachTheEditor(original);
});

test('undo in the priority field leaves the note alone', async () => {
  await typeThenLeaveAndReturn();
  const typed = await reviewText();
  const priority = actionBar().locator('input.ir-priority-input');
  await priority.click();
  await priority.press('End');
  await priority.pressSequentially('5');

  await priority.press('ControlOrMeta+z');

  // The key is the field's: whatever its own undo makes of an input whose
  // value the page sets as it goes, the note keeps the burst.
  await expect(priority).toBeFocused();
  await expectNoteStays(typed);
});

test.describe('on a phone', () => {
  const targets: HistoryInputTarget[] = [
    'the editor the burst was typed into',
    'the editor on screen',
    'the focused element',
  ];
  for (const target of targets) {
    test(`a native undo of the burst sent to ${target} after leaving and returning takes it back, and a native redo puts it back`, async () => {
      const original = await typeThenLeaveAndReturnOnPhone();
      expect(await reviewText()).toContain(BURST);
      if (target === 'the focused element') {
        // A phone's editor doesn't take focus back with the item: the keyboard
        // would come up.
        expect(await focusedElement()).toMatchObject({ body: true });
      }
      if (target === 'the editor the burst was typed into') {
        // Review built a new editor for the item's return. The one typed
        // into stays in the document, out of sight; the second item's, which
        // took no typing, isn't kept.
        expect(await typedIntoEditorPlace()).toEqual({
          connected: true,
          visible: false,
          keptBeside: 0,
        });
      }

      await sendHistoryInput(target, 'historyUndo');
      await expect.poll(reviewText, PROMPT).toBe(original);

      await sendHistoryInput(target, 'historyRedo');
      await expect.poll(reviewText, PROMPT).toContain(BURST);
    });
  }

  test('a native undo of the burst typed into one note leaves the next note review moved on to alone', async () => {
    await typeThenLeaveAndReturnOnPhone({ stayOnSecond: true });
    // Typing of its own in the second note, for an undo reaching its editor
    // to take back.
    await typeAtBodyStart('ZX');
    const second = await reviewText();
    expect(second).toContain('ZX');
    expect(second).not.toContain(BURST);

    await sendHistoryInput(
      'the editor the burst was typed into',
      'historyUndo'
    );

    await expectNoteStays(second, 1500);
  });

  for (const toPlainNote of [false, true]) {
    const away = toPlainNote
      ? 'opening a plain note in its place'
      : 'leaving and returning';
    test(`the mobile toolbar's undo and redo after ${away} take back the burst and put it back`, async () => {
      const original = await typeThenLeaveAndReturnOnPhone({ toPlainNote });

      await executeCommandById(window, 'editor:undo');
      await expect.poll(reviewText, PROMPT).toBe(original);

      await executeCommandById(window, 'editor:redo');
      await expect.poll(reviewText, PROMPT).toContain(BURST);
    });
  }

  test('a native undo of the burst sent to the editor it was typed into, after a plain note opened from the Files view took the review tab’s place and back, takes it back, and a native redo puts it back', async () => {
    const original = await typeThenLeaveAndReturnOnPhone({ toPlainNote: true });
    expect(await reviewText()).toContain(BURST);
    // The review tab that took the editor down is gone; the editor isn't.
    expect(await typedIntoEditorPlace()).toMatchObject({
      connected: true,
      visible: false,
    });

    await sendHistoryInput(
      'the editor the burst was typed into',
      'historyUndo'
    );
    await expect.poll(reviewText, PROMPT).toBe(original);

    await sendHistoryInput(
      'the editor the burst was typed into',
      'historyRedo'
    );
    await expect.poll(reviewText, PROMPT).toContain(BURST);
  });
});
