import { expect, type Page } from '@playwright/test';
import {
  executeCommandById,
  finalizeArticleImport,
  openFileInActiveLeaf,
  REVIEW_VIEW_TYPE,
} from './helpers';
import { test } from './setup/fixtures';
import { createVaultCopy } from './setup/helpers';
import { openNote, query } from './setup/item-steps';
import {
  closeDevices,
  launchDevice,
  launchSecondDevice,
  waitForTakenOn,
  type Device,
} from './setup/two-device';

let deviceA: Device | undefined;
let deviceB: Device | undefined;

// #region HELPERS

/** The article note the test damages, at the vault's top. */
const NOTE = 'Shared.md';

/** An article note left whole beside it, whose queue row stays unflagged. */
const WHOLE = 'Whole.md';

/**
 * What the page-side calls below reach on Obsidian. `window.app` is
 * unofficial Obsidian API: stable in practice, but undocumented.
 */
type PageApp = {
  vault: {
    getFileByPath(path: string): unknown;
    process(file: unknown, edit: (text: string) => string): Promise<string>;
  };
  metadataCache: {
    getFileCache(file: unknown): { frontmatter?: Record<string, unknown> };
  };
  workspace: {
    getLeavesOfType(type: string): { detach(): void }[];
  };
};

/** The `ir-id` the metadata cache on `page` holds for {@link NOTE}. */
const cachedIrId = (page: Page) =>
  page.evaluate((at) => {
    const { app } = window as unknown as { app: PageApp };
    const file = app.vault.getFileByPath(at);
    return file
      ? (app.metadataCache.getFileCache(file)?.frontmatter?.['ir-id'] ?? null)
      : null;
  }, NOTE);

/** Take the `ir-id` line off {@link NOTE} through the vault on `page`. */
const takeIdOff = (page: Page) =>
  page.evaluate(async (at) => {
    const { app } = window as unknown as { app: PageApp };
    await app.vault.process(app.vault.getFileByPath(at), (text) =>
      text.replace(/^ir-id:.*\n/m, '')
    );
  }, NOTE);

/** The notices on `page` listing damaged notes. */
const notices = (page: Page) => page.locator('.notice.ir-damaged-notes-notice');

/** The row the damaged-notes notice on `page` lists for {@link NOTE}. */
const noticeRow = (page: Page) =>
  notices(page)
    .locator('.ir-damaged-note')
    .and(page.locator(`[data-path="${NOTE}"]`));

/**
 * The queue row of the note named `name` on `page`, {@link NOTE}'s by
 * default.
 */
const queueRow = (page: Page, name = 'Shared') =>
  page.locator('.ir-queue-row').filter({ hasText: name });

/** That `page` lists the note named `name` once in its queue, unflagged. */
async function expectUnflagged(page: Page, name = 'Shared') {
  await expect(queueRow(page, name)).toHaveCount(1);
  await expect(queueRow(page, name)).not.toHaveAttribute('data-unlinked');
  await expect(
    queueRow(page, name).locator('.ir-queue-unlinked-badge')
  ).toHaveCount(0);
}

/**
 * Close every review tab on `page` and open review's home afresh, so its
 * queue is drawn from the note as it is now. Returns once the queue shows its
 * rows, or says it has none.
 */
async function freshReviewHome(page: Page) {
  await page.evaluate((viewType) => {
    const { app } = window as unknown as { app: PageApp };
    for (const leaf of app.workspace.getLeavesOfType(viewType)) leaf.detach();
  }, REVIEW_VIEW_TYPE);
  await executeCommandById(page, 'incremental-reading:learn');
  await expect(
    page
      .locator('.ir-queue-panel')
      .locator('.ir-queue-row, .ir-review-placeholder')
      .first()
  ).toBeVisible();
}

// #endregion

test.beforeEach(async () => {
  // One vault copy, two installs: a note edited on one reaches the other
  // through its own file watcher, as a Sync download does
  const vaultPath = await createVaultCopy('two-unlink');
  deviceA = await launchDevice(vaultPath);
  deviceB = await launchSecondDevice(vaultPath);
});

test.afterEach(async () => {
  await closeDevices([deviceA, deviceB]);
  deviceA = undefined;
  deviceB = undefined;
});

test('offers on one device to re-associate an article note whose ir-id was taken off on another, flags its queue row there, and the repair clears both devices', async () => {
  const a = deviceA!.window;
  const b = deviceB!.window;

  // On A: import two notes as articles, the one to damage last
  await openNote(a, WHOLE, 'Whole text.');
  await executeCommandById(a, 'incremental-reading:import-article');
  await finalizeArticleImport(a);
  await expect
    .poll(
      async () =>
        (await query(a, `SELECT id FROM article WHERE reference = '${WHOLE}'`))
          .length
    )
    .toBe(1);
  await openNote(a, NOTE, 'Shared text.');
  await executeCommandById(a, 'incremental-reading:import-article');
  await finalizeArticleImport(a);
  let id = '';
  await expect
    .poll(async () => {
      const [row] = await query(
        a,
        `SELECT id FROM article WHERE reference = '${NOTE}'`
      );
      id = row ? String(row.id) : '';
      return id;
    })
    .not.toBe('');
  await expect.poll(() => cachedIrId(a)).toBe(id);
  await waitForTakenOn(a, b);
  await expect.poll(() => cachedIrId(b)).toBe(id);

  // On A: the id goes from the note, and B's cache reads the note without it
  await takeIdOff(a);
  await expect.poll(() => cachedIrId(a)).toBeNull();
  await waitForTakenOn(a, b);
  await expect.poll(() => cachedIrId(b)).toBeNull();

  // On B: the queue flags the row, that row only, and opening the note
  // offers it back
  await freshReviewHome(b);
  await expect(queueRow(b)).toHaveAttribute('data-unlinked', '');
  await expect(queueRow(b).locator('.ir-queue-unlinked-badge')).toBeVisible();
  await expectUnflagged(b, 'Whole');
  await openFileInActiveLeaf(b, NOTE);
  const offered = noticeRow(b).locator('.ir-damaged-note-actions [data-id]');
  await expect(offered).toHaveCount(1);
  await expect(offered).toHaveAttribute('data-by', 'path');
  await expect(offered).toHaveAttribute('data-id', id);
  // One notice, one line for the note, however many ways it was told of
  await expect(notices(b)).toHaveCount(1);
  await expect(noticeRow(b)).toHaveCount(1);

  await offered.click();

  await expect(noticeRow(b)).toHaveCount(0);
  await expect.poll(() => cachedIrId(b)).toBe(id);
  await freshReviewHome(b);
  await expectUnflagged(b);
  await expectUnflagged(b, 'Whole');
  await waitForTakenOn(b, a);

  // On A as well: the note holds the id again, and nothing is flagged
  await expect.poll(() => cachedIrId(a)).toBe(id);
  await expect(noticeRow(a)).toHaveCount(0);
  await freshReviewHome(a);
  await expectUnflagged(a);
  await expectUnflagged(a, 'Whole');
});
