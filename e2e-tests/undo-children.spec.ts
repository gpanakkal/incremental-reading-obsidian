import { expect, type ElectronApplication, type Page } from '@playwright/test';
import {
  executeCommandById,
  finalizeArticleImport,
  setDefaultEditingMode,
  type RepoWindow,
} from './helpers';
import { test } from './setup/fixtures';
import {
  closeElectron,
  createVaultCopy,
  launchElectron,
  openVault,
} from './setup/helpers';

let app: ElectronApplication;
let window: Page;
let vaultPath: string;

// #region HELPERS

/** The page-side Obsidian these tests reach. Unofficial: `window.app`. */
type PageApp = {
  vault: {
    create(path: string, data: string): Promise<unknown>;
    getFileByPath(path: string): unknown;
  };
  workspace: {
    getLeaf(newLeaf: 'tab'): {
      openFile(file: unknown, state?: unknown): Promise<void>;
    };
    setActiveLeaf(leaf: unknown, params: { focus: boolean }): void;
    activeEditor: {
      editor?: {
        cm: {
          state: { doc: { toString(): string } };
          dispatch(spec: { selection: { anchor: number; head: number } }): void;
        };
      };
    } | null;
  };
};

/** The plugin's undo stack, as a test reaches it from inside the page. */
type PageActions = {
  undoStack: unknown[];
  emitter: { emit(): void };
};

type PagePlugin = RepoWindow['app']['plugins']['plugins'][string] & {
  actions: PageActions;
};

const plugin = (page: Page) =>
  page.evaluateHandle(
    () =>
      (window as unknown as RepoWindow).app.plugins.plugins[
        'incremental-reading'
      ] as PagePlugin
  );

/** Open the note at `path`, new with `text` when given, in a tab of its own, active. */
const openNote = (page: Page, path: string, text?: string) =>
  page.evaluate(
    async ([path, text]) => {
      const { app } = window as unknown as { app: PageApp };
      const file =
        text === undefined
          ? app.vault.getFileByPath(path)
          : await app.vault.create(path, text);
      const leaf = app.workspace.getLeaf('tab');
      await leaf.openFile(file, { active: true });
      app.workspace.setActiveLeaf(leaf, { focus: true });
    },
    [path, text] as const
  );

/** Select the last `text` in the active editor, past any properties. */
const select = (page: Page, text: string) =>
  page.evaluate((text) => {
    const { app } = window as unknown as { app: PageApp };
    const { cm } = app.workspace.activeEditor!.editor!;
    const at = cm.state.doc.toString().lastIndexOf(text);
    cm.dispatch({ selection: { anchor: at, head: at + text.length } });
  }, text);

/** The references of the `table` rows not deleted for good, once there are `count`. */
async function liveReferences(
  page: Page,
  table: 'snippet' | 'srs_card',
  count: number
) {
  const read = async () =>
    (await plugin(page)).evaluate(async (plugin, table) => {
      const rows =
        (await plugin.reviewManager.repo.query(
          `SELECT reference FROM ${table}
           WHERE deleted = FALSE AND reference NOT LIKE '/ir-deleted/%'`
        )) ?? [];
      return rows.map(({ reference }) => String(reference));
    }, table);
  await expect.poll(async () => (await read()).length).toBe(count);
  return read();
}

/**
 * Import a new note as an article, extract a snippet from it, and make a card
 * from the snippet's note. The card's own entry is then taken off the undo
 * stack, which only ever undoes its top: a snippet a card hangs under comes
 * up there once the card's entry is gone, as on a device that merged the
 * card from another, or after an undo of the card that failed.
 * @returns the snippet's and the card's note names, as the queue shows them
 */
async function snippetWithCard(page: Page, article: string) {
  await openNote(page, `${article}.md`, 'Intro\n\nSpaced repetition text.');
  await executeCommandById(page, 'incremental-reading:import-article');
  await finalizeArticleImport(page);

  await select(page, 'repetition');
  await executeCommandById(page, 'incremental-reading:extract-selection');
  const [snippet] = await liveReferences(page, 'snippet', 1);

  await openNote(page, snippet);
  await select(page, 'repetition');
  await executeCommandById(page, 'incremental-reading:create-card');
  const [card] = await liveReferences(page, 'srs_card', 1);

  const stack = await (
    await plugin(page)
  ).evaluate((plugin) => {
    plugin.actions.undoStack.pop();
    plugin.actions.emitter.emit();
    return plugin.actions.undoStack.length;
  });
  // The import's entry, and the snippet's above it
  expect(stack).toBe(2);
  const name = (path: string) => path.slice(path.lastIndexOf('/') + 1, -3);
  return { snippet: name(snippet), card: name(card) };
}

const confirmation = (page: Page) =>
  page.locator('.modal-container.mod-confirmation');

const buttons = (page: Page) =>
  confirmation(page).locator('.modal-button-container > button');

/** The queue's row for the item whose note is named `name`. */
const queueRow = (page: Page, name: string) =>
  page.locator('.ir-queue-row').filter({
    has: page.locator('.ir-queue-cell[data-column="reference"]', {
      hasText: name,
    }),
  });

/**
 * Undo, and wait for the question about the children it asks, which names
 * the one card, whose note is named `card`, on a row of its own.
 */
async function undoAskingAboutChildren(page: Page, card: string) {
  await executeCommandById(page, 'incremental-reading:undo');
  await expect(confirmation(page)).toBeVisible();
  // Cancel, remove the children too, keep them
  await expect(buttons(page)).toHaveCount(3);
  const rows = confirmation(page).locator('.ir-children-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.locator('.ir-item-icon[data-type="card"]')).toHaveCount(1);
  await expect(rows.locator('.ir-item-name')).toHaveText(card);
}

// #endregion

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('undo-children');
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
  await setDefaultEditingMode(window, 'source');
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
});

test('asks before undoing a snippet a card was made from: Cancel keeps both, and keeping the children leaves the card under the article', async () => {
  const { snippet, card } = await snippetWithCard(window, 'Children source');
  await executeCommandById(window, 'incremental-reading:learn');
  await expect(queueRow(window, snippet)).toHaveCount(1);
  await expect(queueRow(window, card)).toHaveCount(1);

  await undoAskingAboutChildren(window, card);
  await buttons(window).and(window.locator('.mod-cancel')).click();
  await expect(confirmation(window)).toHaveCount(0);
  await expect(queueRow(window, snippet)).toHaveCount(1);
  await expect(queueRow(window, card)).toHaveCount(1);

  // Still there to undo
  await undoAskingAboutChildren(window, card);
  await buttons(window).and(window.locator('.mod-cta')).click();
  await expect(confirmation(window)).toHaveCount(0);
  await expect(queueRow(window, snippet)).toHaveCount(0, { timeout: 4_000 });
  await expect(queueRow(window, card)).toHaveCount(1);
  // Moved up from the snippet to the article it was taken from
  await expect(
    queueRow(window, card).locator('.ir-queue-cell[data-column="parent"]')
  ).toContainText('Children source', { timeout: 4_000 });
});

test('removes the card with the snippet when told to remove the children too', async () => {
  const { snippet, card } = await snippetWithCard(window, 'Children source');
  await executeCommandById(window, 'incremental-reading:learn');
  await expect(queueRow(window, card)).toHaveCount(1);

  await undoAskingAboutChildren(window, card);
  await buttons(window).and(window.locator('.mod-destructive')).click();
  await expect(confirmation(window)).toHaveCount(0);

  await expect(queueRow(window, snippet)).toHaveCount(0, { timeout: 4_000 });
  await expect(queueRow(window, card)).toHaveCount(0, { timeout: 4_000 });
  await liveReferences(window, 'srs_card', 0);
  await liveReferences(window, 'snippet', 0);
});
