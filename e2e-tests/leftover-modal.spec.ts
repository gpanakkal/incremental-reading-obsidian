import { ARTICLE_TAG } from '#/lib/constants';
import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { executeCommandById, openFileInActiveLeaf } from './helpers';
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
  vaultPath = await createVaultCopy('leftover-modal');
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
  if (shouldCleanup) {
    await fs.rm(vaultPath, { recursive: true, force: true });
  }
});

// #region HELPERS

/**
 * What the page-side calls below reach on Obsidian and the plugin.
 * `window.app` and `app.plugins` are unofficial Obsidian API: stable in
 * practice, but undocumented.
 */
type PageApp = {
  vault: { getFileByPath(path: string): unknown };
  metadataCache: {
    getFileCache(file: unknown): { frontmatter?: unknown } | null;
  };
  plugins: {
    plugins: Record<
      string,
      {
        reviewManager: {
          repo: {
            mutate(sql: string, params?: unknown[]): Promise<unknown>;
          };
        };
        leftovers?: { manage(): Promise<void> };
      }
    >;
  };
};

/** Run `sql` against the running plugin's database. */
const mutate = (sql: string, params: unknown[] = []) =>
  window.evaluate(
    async ([sql, params]) => {
      const { app } = window as unknown as { app: PageApp };
      const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
      await repo.mutate(sql, params);
    },
    [sql, params] as const
  );

/**
 * Write a note into the vault and wait for Obsidian to index it, frontmatter
 * included: the leftover scan reads tags and ids off the metadata cache, which
 * parses a note some time after the vault first lists it.
 */
async function writeVaultFile(at: string, content: string) {
  await fs.mkdir(path.dirname(path.join(vaultPath, at)), { recursive: true });
  await fs.writeFile(path.join(vaultPath, at), content);
  await expect
    .poll(() =>
      window.evaluate((p) => {
        const { app } = window as unknown as { app: PageApp };
        const file = app.vault.getFileByPath(p);
        return (
          file !== null &&
          app.metadataCache.getFileCache(file)?.frontmatter !== undefined
        );
      }, at)
    )
    .toBe(true);
}

/** A note tagged as an article, holding `id`, which no row may hold. */
const articleNote = (id: string, body: string) =>
  `---\nir-id: ${id}\ntags: ${ARTICLE_TAG}\n---\n${body}\n`;

/** The leftover modal's line for the note named `name`. */
const lineOf = (name: string) =>
  window.locator('.ir-leftover-modal .setting-item').filter({ hasText: name });

// #endregion

test('saves only the leftover notes left checked on Confirm', async () => {
  // Leftovers are asked about only while the database holds an item
  await writeVaultFile('articles/Held.md', articleNote('held', 'Held'));
  await mutate(
    `INSERT INTO article (id, reference, due, interval, priority)
     VALUES ('held', 'articles/Held.md', $1, 86400000, 25)`,
    [Date.now() + 1e9]
  );
  await writeVaultFile('notes/Keep me.md', articleNote('keep', 'Keep me'));
  await writeVaultFile('notes/Leave me.md', articleNote('leave', 'Leave me'));
  // What the review home screen's Manage button does; the startup scan ran
  // before these notes were written, so the button isn't there yet
  await window.evaluate(() => {
    const { app } = window as unknown as { app: PageApp };
    void app.plugins.plugins['incremental-reading'].leftovers?.manage();
  });

  // Obsidian's slider toggles, on while `is-enabled`
  const keep = lineOf('Keep me').locator('.checkbox-container');
  const leave = lineOf('Leave me').locator('.checkbox-container');
  // Both recognized by their tag, so both start on
  await expect(keep).toHaveClass(/\bis-enabled\b/);
  await expect(leave).toHaveClass(/\bis-enabled\b/);
  // Its label's text flips it too
  await lineOf('Leave me').locator('.ir-leftover-keep-text').click();
  await expect(leave).not.toHaveClass(/\bis-enabled\b/);
  await window
    .locator('.ir-leftover-modal .modal-button-container .mod-cta')
    .click();

  // Done once the note saved is: the one turned off never holds it open
  await expect(window.locator('.ir-leftover-modal')).toHaveCount(0);

  await executeCommandById(window, 'incremental-reading:learn');
  const rows = window.locator('.ir-queue-row');
  await expect(rows.filter({ hasText: 'Keep me' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'Leave me' })).toHaveCount(0);
  // Still a leftover, to be asked about again
  await expect(
    window.locator('#manage-leftovers-button .ir-leftover-count')
  ).toHaveText('1');
});

test.describe("A leftover at another item's path", () => {
  /** The question asked about the row holding the leftover's path. */
  const question = () => window.locator('.modal-container.mod-confirmation');

  /**
   * Click `button` in the open question until it goes away, with the question
   * it is in: Obsidian can take a click before a modal's button is wired. A
   * question asked next, once more, has buttons of its own.
   */
  async function answer(button: string) {
    const target = question().locator(`.modal-button-container ${button}`);
    await expect(async () => {
      if (await target.isVisible()) await target.click();
      await expect(target).toHaveCount(0, { timeout: 2_000 });
    }).toPass();
  }

  /**
   * Put the snippet `id` at `at`, deleted or not, due `due`, reviewed once,
   * and a leftover note there holding another id; then open the leftover
   * modal, save the note as an article, and wait for the question about the
   * snippet.
   */
  async function adoptOverSnippet(
    at: string,
    { id, deleted, due }: { id: string; deleted: boolean; due: number }
  ) {
    await mutate(
      `INSERT INTO snippet (id, reference, due, interval, priority, deleted)
       VALUES ($1, $2, $3, 86400000, 25, $4)`,
      [id, at, due, Number(deleted)]
    );
    await mutate(
      `INSERT INTO snippet_review (id, snippet_id, review_time)
       VALUES ('review-1', $1, $2)`,
      [id, due - 86_400_000]
    );
    await writeVaultFile(at, articleNote('fictitious', 'Left over'));
    await window.evaluate(() => {
      const { app } = window as unknown as { app: PageApp };
      void app.plugins.plugins['incremental-reading'].leftovers?.manage();
    });
    const name = path.basename(at, '.md');
    await expect(lineOf(name).locator('.checkbox-container')).toHaveClass(
      /\bis-enabled\b/
    );
    await window
      .locator('.ir-leftover-modal .modal-button-container .mod-cta')
      .click();
    await expect(question().last()).toBeVisible();
  }

  /** The item's action bar in the active tab, which a plain note has none of. */
  const actionBar = () =>
    window
      .locator('.workspace-leaf.mod-active .ir-action-bar-panel')
      .filter({ visible: true });

  test("Re-associate makes the note the deleted snippet's note, with its schedule, and the leftover is gone", async () => {
    // Ten days ago, at noon, so the day shown is the same in any zone
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() - 10);
    dueDate.setHours(12, 0, 0, 0);
    const day = `${dueDate.getFullYear()}/${dueDate.getMonth() + 1}/${dueDate.getDate()}`;
    await adoptOverSnippet('notes/Leftover.md', {
      id: 'held-snippet',
      deleted: true,
      due: dueDate.getTime(),
    });

    await answer('.mod-cta');

    await expect(window.locator('.ir-leftover-modal')).toHaveCount(0);
    await openFileInActiveLeaf(window, 'notes/Leftover.md');
    await expect(actionBar()).toBeVisible();
    await executeCommandById(window, 'incremental-reading:learn');
    const rows = window.locator('.ir-queue-row');
    const snippet = rows.filter({ hasText: 'Leftover' });
    await expect(snippet).toHaveAttribute('data-type', 'snippet');
    await expect(snippet).toContainText(day);
    await expect(
      window.locator('#manage-leftovers-button .ir-leftover-count')
    ).toHaveCount(0);
  });

  test('Erase and import fresh, once confirmed, saves the note as a new article in place of the snippet', async () => {
    await adoptOverSnippet('notes/Missing.md', {
      id: 'live-snippet',
      deleted: false,
      due: Date.now() - 1_000,
    });

    await answer('button.mod-destructive:not(.mod-cta)');
    // Asked once more, as it can't be undone
    await expect(question().last()).toBeVisible();
    await answer('.mod-cta');

    await expect(window.locator('.ir-leftover-modal')).toHaveCount(0);
    await executeCommandById(window, 'incremental-reading:learn');
    const rows = window.locator('.ir-queue-row').filter({ hasText: 'Missing' });
    await expect(rows).toHaveCount(1);
    await expect(rows).toHaveAttribute('data-type', 'article');
  });

  test('Cancel writes nothing, shows no error, and the leftover stays listed', async () => {
    await adoptOverSnippet('notes/Kept.md', {
      id: 'held-snippet',
      deleted: true,
      due: Date.now() - 1_000,
    });

    await answer('.mod-cancel');

    // The line stays as it was, with no error: backing out is no failure
    await expect(
      window.locator('.ir-leftover-modal .modal-button-container .mod-cta')
    ).toBeEnabled();
    await expect(lineOf('Kept')).toBeVisible();
    await expect(lineOf('Kept').locator('.ir-leftover-error')).toHaveCount(0);
    await window
      .locator('.ir-leftover-modal .modal-button-container .mod-cancel')
      .click();
    await expect(window.locator('.ir-leftover-modal')).toHaveCount(0);
    // Neither the snippet back nor an article made
    await executeCommandById(window, 'incremental-reading:learn');
    await expect(
      window.locator('.ir-queue-row').filter({ hasText: 'Kept' })
    ).toHaveCount(0);
    // Still a leftover, to be asked about again
    await expect(
      window.locator('#manage-leftovers-button .ir-leftover-count')
    ).toHaveText('1');
  });
});

test.describe('A note moved outside Obsidian while it runs', () => {
  /** The question asked about the row the note may be re-associated with. */
  const question = () => window.locator('.modal-container.mod-confirmation');

  /** The item's action bar in the active tab, which a plain note has none of. */
  const actionBar = () =>
    window
      .locator('.workspace-leaf.mod-active .ir-action-bar-panel')
      .filter({ visible: true });

  /** Whether the `table` row `id` is deleted, as the plugin's database has it. */
  const isDeleted = (table: string, id: string) =>
    window.evaluate(
      async ([table, id]) => {
        const { app } = window as unknown as {
          app: {
            plugins: {
              plugins: Record<
                string,
                {
                  reviewManager: {
                    repo: {
                      query(sql: string, params: unknown[]): Promise<unknown[]>;
                    };
                  };
                }
              >;
            };
          };
        };
        const { repo } =
          app.plugins.plugins['incremental-reading'].reviewManager;
        const [row] = (await repo.query(
          `SELECT deleted FROM ${table} WHERE id = $1`,
          [id]
        )) as { deleted: number }[];
        return row ? Boolean(row.deleted) : null;
      },
      [table, id] as const
    );

  /**
   * Put the `table` row `id` at `notes/Moved.md`, due ten days ago at noon
   * and reviewed once, with its note there, tagged with the type's tag or
   * not; then move the note's file to `Moved.md` in `folder` behind Obsidian's
   * back, as Explorer or git would, and wait for the plugin to delete the
   * row, as it does for the delete Obsidian sees. `viaOutside` moves it out
   * of the vault first and back in once the row is deleted, as a cut and a
   * later paste would, so Obsidian sees the delete before the create. Returns
   * the due day as the queue writes it.
   */
  async function moveBehindObsidian(
    table: 'article' | 'snippet',
    id: string,
    tag: string | null,
    viaOutside: boolean,
    folder: string
  ) {
    const due = new Date();
    due.setDate(due.getDate() - 10);
    due.setHours(12, 0, 0, 0);
    await mutate(
      `INSERT INTO ${table} (id, reference, due, interval, priority)
       VALUES ($1, 'notes/Moved.md', $2, 86400000, 25)`,
      [id, due.getTime()]
    );
    const log = table === 'article' ? 'article_review' : 'snippet_review';
    await mutate(
      `INSERT INTO ${log} (id, ${table}_id, review_time) VALUES ('review-1', $1, $2)`,
      [id, due.getTime() - 86_400_000]
    );
    const tags = tag ? `tags: ${tag}\n` : '';
    await writeVaultFile(
      'notes/Moved.md',
      `---\nir-id: ${id}\n${tags}---\nMoved\n`
    );
    await fs.mkdir(path.join(vaultPath, folder), { recursive: true });
    const from = path.join(vaultPath, 'notes/Moved.md');
    const to = path.join(vaultPath, `${folder}/Moved.md`);
    if (viaOutside) {
      const outside = `${vaultPath}-${id}.md`;
      await fs.rename(from, outside);
      await expect.poll(() => isDeleted(table, id)).toBe(true);
      await fs.rename(outside, to);
    } else {
      await fs.rename(from, to);
    }
    await expect
      .poll(() =>
        window.evaluate((moved) => {
          const { app } = window as unknown as { app: PageApp };
          const file = app.vault.getFileByPath(moved);
          return (
            app.vault.getFileByPath('notes/Moved.md') === null &&
            file !== null &&
            app.metadataCache.getFileCache(file)?.frontmatter !== undefined
          );
        }, `${folder}/Moved.md`)
      )
      .toBe(true);
    await expect.poll(() => isDeleted(table, id)).toBe(true);
    return `${due.getFullYear()}/${due.getMonth() + 1}/${due.getDate()}`;
  }

  // A tagged note is no more taken back on its own than an untagged one,
  // even when Obsidian sees the row deleted before the note turns up; one
  // brought to a path that breaks links is told of, as one arriving there is
  for (const [table, tag, viaOutside, folder] of [
    ['article', ARTICLE_TAG, true, 'moved'],
    ['snippet', null, false, 'moved [x]'],
  ] as const) {
    test(`Re-associate brings the ${tag ? 'tagged' : 'untagged'} ${table} back to review at the note's new path, with its schedule, and the leftover is gone`, async () => {
      const day = await moveBehindObsidian(
        table,
        `moved-${table}`,
        tag,
        viaOutside,
        folder
      );
      await window.evaluate(() => {
        const { app } = window as unknown as { app: PageApp };
        void app.plugins.plugins['incremental-reading'].leftovers?.manage();
      });

      // Listed, saying which row it was, and set to be kept as that type
      await expect(lineOf('Moved').locator('.ir-leftover-match')).toBeVisible();
      await expect(lineOf('Moved').locator('.checkbox-container')).toHaveClass(
        /\bis-enabled\b/
      );
      // Its type is the row's, never another
      await expect(
        lineOf('Moved').locator('select.dropdown:not(.is-measuring)')
      ).toHaveValue(table);
      await expect(
        lineOf('Moved').locator('select.dropdown:not(.is-measuring)')
      ).toBeDisabled();
      await window
        .locator('.ir-leftover-modal .modal-button-container .mod-cta')
        .click();
      const reassociate = question().locator(
        '.modal-button-container .mod-cta'
      );
      await expect(async () => {
        if (await reassociate.isVisible()) await reassociate.click();
        await expect(reassociate).toHaveCount(0, { timeout: 2_000 });
      }).toPass();

      await expect(window.locator('.ir-leftover-modal')).toHaveCount(0);
      if (folder.includes('[')) {
        await expect(
          window.locator('.notice', { hasText: `"${folder}/Moved.md"` })
        ).toBeVisible();
      }
      await openFileInActiveLeaf(window, `${folder}/Moved.md`);
      await expect(actionBar()).toBeVisible();
      await executeCommandById(window, 'incremental-reading:learn');
      const row = window.locator('.ir-queue-row').filter({ hasText: 'Moved' });
      await expect(row).toHaveAttribute('data-type', table);
      await expect(row).toContainText(day);
      await expect(
        window.locator('#manage-leftovers-button .ir-leftover-count')
      ).toHaveCount(0);
    });
  }
});
