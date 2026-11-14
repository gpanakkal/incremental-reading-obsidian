import { expect, type ElectronApplication, type Page } from '@playwright/test';
import {
  executeCommandById,
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
import {
  confirmation,
  highlights,
  openNote,
  select,
  snippetIds,
  type PageRepo,
} from './setup/item-steps';

let app: ElectronApplication;
let window: Page;
let vaultPath: string;

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('undo-elsewhere');
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
});

test('asks before undoing a snippet another device reviewed: Cancel keeps it, and Undo anyway undoes it', async () => {
  await setDefaultEditingMode(window, 'source');
  await openNote(window, 'Source note.md', 'Intro\n\nSpaced repetition text.');
  await select(window, 'repetition');
  await executeCommandById(window, 'incremental-reading:extract-selection');
  const [snippet] = await snippetIds(window, 1);
  await expect(highlights(window)).toHaveText(['repetition']);

  // A review of the snippet and a card made from it on another device, as a
  // merge brings them in: stamped by that device, past any save of it this
  // database has seen. A statement that sets its own stamp keeps it. The
  // review is what asks: the card outlives the undo, so alone it would not.
  await window.evaluate(async (snippet) => {
    const repo = (window as unknown as RepoWindow).app.plugins.plugins[
      'incremental-reading'
    ].reviewManager.repo as unknown as PageRepo;
    const stamp = Date.now() + 24 * 60 * 60 * 1000;
    await repo.mutate(
      `INSERT INTO snippet_review (id, snippet_id, review_time, updated_at,
         updated_by)
       VALUES ('review-elsewhere', $1, $2, $3, 'other-device')`,
      [snippet, Date.now(), stamp]
    );
    await repo.mutate(
      `INSERT INTO srs_card (id, reference, parent, created_at, due,
         stability, difficulty, elapsed_days, scheduled_days, state,
         updated_at, updated_by)
       VALUES ('card-elsewhere', 'cards/elsewhere.md', $1, $2, $2, 0, 0, 0,
         0, 0, $3, 'other-device')`,
      [snippet, Date.now(), stamp]
    );
  }, snippet);

  await executeCommandById(window, 'incremental-reading:undo');
  await expect(confirmation(window)).toBeVisible();
  await confirmation(window).locator('button.mod-cancel').click();
  await expect(confirmation(window)).toHaveCount(0);
  // Kept: the snippet and its highlight stay, and undo still offers it
  await expect(highlights(window)).toHaveText(['repetition']);
  expect(await snippetIds(window, 1)).toEqual([snippet]);

  await executeCommandById(window, 'incremental-reading:undo');
  await expect(confirmation(window)).toBeVisible();
  await confirmation(window).locator('button.mod-cta').click();
  // The card made there hangs under the snippet: what to do with it is asked
  // next, in a prompt of its own, and removing it too takes it with the snippet
  const choices = confirmation(window).locator(
    '.modal-button-container > button'
  );
  await expect(choices).toHaveCount(3);
  await choices.and(window.locator('.mod-destructive')).click();
  await expect(confirmation(window)).toHaveCount(0);
  await expect(highlights(window)).toHaveCount(0);
  await snippetIds(window, 0);
  await expect
    .poll(() =>
      window.evaluate(async () => {
        const rows = await (
          (window as unknown as RepoWindow).app.plugins.plugins[
            'incremental-reading'
          ].reviewManager.repo as unknown as PageRepo
        ).query(
          "SELECT id FROM srs_card WHERE reference NOT LIKE '/ir-deleted/%'"
        );
        return rows.length;
      })
    )
    .toBe(0);
});
