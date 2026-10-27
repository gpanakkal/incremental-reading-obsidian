import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import { executeCommandById } from './helpers';
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

/** The test vault's folder of plain notes, and what it holds, by name. */
const SOURCES = 'sources';
const SOURCE_NOTES = [
  'Curse of dimensionality - Wikipedia',
  'Memorizing a programming language using spaced repetition software',
  'Security Principles',
];

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('bulk-import');
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
  // CI runs headed in a smaller window than local runs get
  await window.setViewportSize({ width: 1280, height: 800 });
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
  if (shouldCleanup) {
    await fs
      .rm(vaultPath, { recursive: true, force: true, maxRetries: 3 })
      .catch(() => {});
  }
});

test.describe('Bulk import from the review home', () => {
  test('lists the folder picked in the filter bar, imports it, and the queue shows the new articles', async () => {
    await executeCommandById(window, 'incremental-reading:learn');
    const queueRow = (name: string) =>
      window.locator('.ir-queue-row', { hasText: name });
    await expect(window.locator('#begin-review-button')).toBeVisible();
    for (const name of SOURCE_NOTES)
      await expect(queueRow(name)).toHaveCount(0);

    await window.locator('#bulk-import-button').click();

    const modal = window
      .locator('.modal')
      .filter({ has: window.locator('.ir-bulk-import-filter') });
    await expect(modal.locator('.ir-bulk-import-prompt')).toBeVisible();
    await expect(modal.locator('.ir-bulk-import-row')).toHaveCount(0);
    await modal.locator('.ir-bulk-import-folder-input').fill(SOURCES);
    await window
      .locator('.suggestion-container .suggestion-item')
      .filter({ hasText: new RegExp(`^${SOURCES}$`) })
      .click();

    const rows = modal.locator('.ir-bulk-import-row');
    await expect(modal.locator('.ir-loading')).toHaveCount(0);
    await expect(rows.locator('.ir-bulk-import-name')).toHaveText(SOURCE_NOTES);
    await modal.locator('button.mod-cta').click();

    await expect(modal).toHaveCount(0);
    // No refresh asked for: the imports' own change events reach the queue
    for (const name of SOURCE_NOTES)
      await expect(queueRow(name)).toHaveCount(1);
  });

  test('lists the notes carrying the tag typed, in frontmatter or body, nested too, and imports exactly those', async () => {
    const TAG = 'bulk-tag-e2e';
    const [byFrontmatter, inBody, untagged] = SOURCE_NOTES;
    // One note tagged in its frontmatter, one with a tag nested in it, in its body
    await window.evaluate(
      async ({ tag, frontmatterNote, bodyNote }) => {
        type PageApp = {
          vault: {
            getFileByPath(path: string): unknown;
            process(
              file: unknown,
              fn: (text: string) => string
            ): Promise<string>;
          };
          fileManager: {
            processFrontMatter(
              file: unknown,
              fn: (frontmatter: Record<string, unknown>) => void
            ): Promise<void>;
          };
        };
        const { app } = window as unknown as { app: PageApp };
        await app.fileManager.processFrontMatter(
          app.vault.getFileByPath(frontmatterNote),
          (frontmatter) => {
            frontmatter.tags = [tag];
          }
        );
        await app.vault.process(
          app.vault.getFileByPath(bodyNote),
          (text) => `${text}\n\n#${tag}/sub\n`
        );
      },
      {
        tag: TAG,
        frontmatterNote: `${SOURCES}/${byFrontmatter}.md`,
        bodyNote: `${SOURCES}/${inBody}.md`,
      }
    );
    // The metadata cache catches up on its own time: both notes count
    // toward the tag once cached (`getTags` is undocumented)
    await expect
      .poll(() =>
        window.evaluate(
          (tag) =>
            (
              window as unknown as {
                app: { metadataCache: { getTags(): Record<string, number> } };
              }
            ).app.metadataCache.getTags()[`#${tag}`],
          TAG
        )
      )
      .toBe(2);

    await executeCommandById(window, 'incremental-reading:learn');
    const queueRow = (name: string) =>
      window.locator('.ir-queue-row', { hasText: name });
    await expect(window.locator('#begin-review-button')).toBeVisible();
    await window.locator('#bulk-import-button').click();
    const modal = window
      .locator('.modal')
      .filter({ has: window.locator('.ir-bulk-import-filter') });
    // Folder · Tag · …
    await modal.locator('.ir-segment').nth(1).click();
    await expect(modal.locator('.ir-segment').nth(1)).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    const tagInput = modal.locator('.ir-bulk-import-tag-input');
    await tagInput.fill(`#${TAG}`);
    // Out of the way of the list: the suggestions close with the field
    await tagInput.blur();

    const rows = modal.locator('.ir-bulk-import-row');
    await expect(modal.locator('.ir-bulk-import-folder')).toHaveCount(1);
    await expect(modal.locator('.ir-loading')).toHaveCount(0);
    await expect(rows.locator('.ir-bulk-import-name')).toHaveText(
      [byFrontmatter, inBody].sort((a, b) => a.localeCompare(b))
    );
    await modal.locator('button.mod-cta').click();

    await expect(modal).toHaveCount(0);
    await expect(queueRow(byFrontmatter)).toHaveCount(1);
    await expect(queueRow(inBody)).toHaveCount(1);
    await expect(queueRow(untagged)).toHaveCount(0);
  });

  test("lists what a search matches, as core's Search pane does, imports it, and shows a bad query's error, listing nothing", async () => {
    const query = 'path:sources "spaced repetition"';
    const match = SOURCE_NOTES[1];
    // What core's Search pane lists for the query. Unofficial: the search
    // view's `setQuery` and `dom.resultDomLookup` (a Map keyed by file)
    const paneLists = () =>
      window.evaluate(async (text) => {
        const { app } = window as unknown as {
          app: {
            workspace: {
              getLeavesOfType(type: string): {
                loadIfDeferred(): Promise<void>;
                view: unknown;
              }[];
            };
          };
        };
        const leaf = app.workspace.getLeavesOfType('search')[0];
        await leaf.loadIfDeferred();
        const view = leaf.view as {
          getQuery(): string;
          setQuery(query: string): void;
          dom: { resultDomLookup: Map<{ path: string }, unknown> };
        };
        if (view.getQuery() !== text) view.setQuery(text);
        return [...view.dom.resultDomLookup.keys()].map((file) => file.path);
      }, query);
    await expect.poll(paneLists).toEqual([`${SOURCES}/${match}.md`]);

    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('#bulk-import-button').click();
    const modal = window
      .locator('.modal')
      .filter({ has: window.locator('.ir-bulk-import-filter') });
    const segments = modal.locator('.ir-segment');
    // Search is the last filter
    await segments.last().click();
    await expect(segments.last()).toHaveAttribute('aria-pressed', 'true');
    const input = modal.locator('.ir-bulk-import-search-input');
    await input.fill(query);

    const rows = modal.locator('.ir-bulk-import-row');
    await expect(rows.locator('.ir-bulk-import-name')).toHaveText([match]);
    await expect(modal.locator('.ir-loading')).toHaveCount(0);
    await expect(rows).toHaveCount(1);

    // An operator the engine doesn't know: its message, and nothing listed
    await input.fill('nosuchop:x');
    await expect(modal.locator('.ir-bulk-import-search-error')).toContainText(
      'nosuchop'
    );
    await expect(rows).toHaveCount(0);

    await input.fill(query);
    await expect(rows.locator('.ir-bulk-import-name')).toHaveText([match]);
    await modal.locator('button.mod-cta').click();

    await expect(modal).toHaveCount(0);
    await expect(
      window.locator('.ir-queue-row', { hasText: match })
    ).toHaveCount(1);
  });
});
