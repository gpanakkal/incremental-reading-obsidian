import { ARTICLE_DIRECTORY, DATA_DIRECTORY } from '#/lib/constants';
import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  executeCommandById,
  finalizeArticleImport,
  openNote,
  selectParagraph,
  setNativeMenus,
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

/** The plain note the cards below are made from. */
const NOTE_PATH = 'sources/Security Principles.md';
/** Where a copy of it lands when imported as one. */
const COPY_PATH = `${DATA_DIRECTORY}/${ARTICLE_DIRECTORY}/Security Principles.md`;
/** The list item made into a card, as it reads in the source. */
const BULLET_TEXT =
  'Explain the security functions: Confidentiality, Integrity and Availability (CIA).';

/**
 * What the page-side calls below reach on Obsidian and the plugin. Unofficial:
 * `window.app`, `app.plugins.plugins` and the deprecated
 * `workspace.activeLeaf`.
 */
type PageApp = {
  vault: {
    getFileByPath(path: string): unknown;
    cachedRead(file: unknown): Promise<string>;
  };
  metadataCache: {
    getFileCache(file: unknown): {
      frontmatter?: Record<string, unknown>;
    } | null;
  };
  workspace: {
    getLeaf(newLeaf: 'tab'): { openFile(file: unknown): Promise<void> };
    getActiveFile(): { path: string } | null;
    activeLeaf: { view: object } | null;
  };
  plugins: {
    plugins: Record<
      string,
      {
        toggleAdvancedCommands(enable: boolean): void;
        reviewManager: {
          repo: {
            query(sql: string, params?: unknown[]): Record<string, unknown>[];
          };
        };
      }
    >;
  };
};

/** Every card's note, parent and source link. */
const cards = (page: Page) =>
  page.evaluate(() => {
    const { app } = window as unknown as { app: PageApp };
    const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
    return repo.query('SELECT reference, parent FROM srs_card').map((row) => {
      const file = app.vault.getFileByPath(row.reference as string);
      return {
        reference: row.reference as string,
        parent: row.parent as string | null,
        source: file
          ? app.metadataCache.getFileCache(file)?.frontmatter?.source
          : undefined,
      };
    });
  });

/** Every article row's id and reference. */
const articleRows = (page: Page) =>
  page.evaluate(() => {
    const { app } = window as unknown as { app: PageApp };
    const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
    return repo.query('SELECT id, reference FROM article') as {
      id: string;
      reference: string;
    }[];
  });

const readNote = () => fs.readFile(path.join(vaultPath, NOTE_PATH));

/**
 * Make a card of {@link BULLET_TEXT} in the note, which is no article, and
 * wait until the note on disk holds its embed.
 * @returns the card's note path, and the note's bytes with the embed in them
 */
async function cardFromPlainNote(page: Page) {
  await openNote(page, 'sources/Security Principles');
  await selectParagraph(page, BULLET_TEXT);
  await executeCommandById(page, 'incremental-reading:create-card');
  await expect.poll(() => cards(page)).toHaveLength(1);
  const [card] = await cards(page);
  expect(card.parent).toBeNull();
  const cardName = path.posix.basename(card.reference, '.md');
  const embed = `![[${cardName}|ir-hide-title]]`;
  await expect
    .poll(async () => (await readNote()).toString('utf8'))
    .toContain(embed);
  return { card, embed, noteBytes: await readNote() };
}

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('note-import');
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
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

test.describe('Importing a note cards were made from', () => {
  test('gives the card to the note imported in place, which keeps its embed', async () => {
    const { embed } = await cardFromPlainNote(window);

    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);

    await expect
      .poll(async () => (await articleRows(window)).map((r) => r.reference))
      .toEqual([NOTE_PATH]);
    const [{ id }] = await articleRows(window);
    await expect
      .poll(async () => (await cards(window)).map((c) => c.parent))
      .toEqual([id]);
    expect((await readNote()).toString('utf8')).toContain(embed);
  });

  test('gives the card to a copy, pointing its link at it, leaving the original as it was; its context is the copy, at the embed', async () => {
    const { card, embed, noteBytes } = await cardFromPlainNote(window);

    await window.evaluate(() => {
      const { app } = window as unknown as { app: PageApp };
      app.plugins.plugins['incremental-reading'].toggleAdvancedCommands(true);
    });
    await executeCommandById(window, 'incremental-reading:import-article-copy');

    await expect
      .poll(async () => (await articleRows(window)).map((r) => r.reference))
      .toEqual([COPY_PATH]);
    const [{ id }] = await articleRows(window);
    // Two notes share the name now, so a link to the copy is by its path.
    // The link had no alias, Obsidian dropping one that repeats its name, and
    // is given none.
    await expect
      .poll(async () =>
        (await cards(window)).map(({ parent, source }) => ({ parent, source }))
      )
      .toEqual([
        {
          parent: id,
          source: `[[${COPY_PATH.slice(0, -'.md'.length)}]]`,
        },
      ]);
    // The copy is made from the original's text, embed and all
    const copyText = await fs.readFile(path.join(vaultPath, COPY_PATH), 'utf8');
    expect(copyText).toContain(embed);
    // Re-pointing the card's link, awaited above, is the import's last write
    expect((await readNote()).equals(noteBytes)).toBe(true);

    // Go to context from the card's own tab opens the copy at the embed
    await window.evaluate((cardPath) => {
      const { app } = window as unknown as { app: PageApp };
      return app.workspace
        .getLeaf('tab')
        .openFile(app.vault.getFileByPath(cardPath));
    }, card.reference);
    // The jump flashes its range rather than selecting it, so what the note's
    // view is asked to show is recorded where it is asked. Undocumented: the
    // `{ match: { content, matches } }` eState MarkdownView.setEphemeralState
    // reads, as Obsidian's search and backlinks panes pass it.
    await window.evaluate(() => {
      const { app } = window as unknown as { app: PageApp };
      const proto = Object.getPrototypeOf(app.workspace.activeLeaf!.view) as {
        setEphemeralState: (this: unknown, state: unknown) => unknown;
      };
      const original = proto.setEphemeralState;
      const shown: { path?: string; text: string }[] = [];
      (window as unknown as { __shown: typeof shown }).__shown = shown;
      proto.setEphemeralState = function (
        this: { file?: { path: string } },
        state: unknown
      ) {
        const match = (
          state as {
            match?: { content: string; matches: [number, number][] };
          } | null
        )?.match;
        if (match) {
          const [[start, end]] = match.matches;
          shown.push({
            path: this.file?.path,
            text: match.content.slice(start, end),
          });
        }
        return original.call(this, state);
      };
    });
    await setNativeMenus(window, false);
    await window
      .locator('.workspace-leaf.mod-active .view-header')
      .getByLabel('More options')
      .click();
    await window
      .locator('.menu')
      .getByText('Go to context', { exact: true })
      .click();
    await expect
      .poll(() =>
        window.evaluate(() => {
          const { app } = window as unknown as { app: PageApp };
          return {
            file: app.workspace.getActiveFile()?.path,
            shown: (
              window as unknown as {
                __shown: { path?: string; text: string }[];
              }
            ).__shown,
          };
        })
      )
      .toEqual({ file: COPY_PATH, shown: [{ path: COPY_PATH, text: embed }] });
  });
});
