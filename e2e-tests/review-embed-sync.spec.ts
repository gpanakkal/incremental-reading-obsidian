import {
  CURRENT_ITEM_REFETCH_TIME,
  TRANSCLUSION_HIDE_TITLE_ALIAS,
} from '#/lib/constants';
import { EMBED_SHAPE_CLASSES } from '#/lib/extensions/CardEmbedShape';
import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { executeCommandById, importArticle, reviewTitle } from './helpers';
import { test } from './setup/fixtures';
import {
  closeElectron,
  createVaultCopy,
  launchElectron,
  openVault,
} from './setup/helpers';

// A card embed whose note reaches the vault after the embed does, or reaches it
// in pieces, the way Sync delivers a card made on another device: the note the
// embed is in changes under the review editor, and the card's note is still
// missing or has its properties and no text yet. The embed has to catch up
// with its note without the item being left and reopened.

let app: ElectronApplication;
let window: Page;

test.beforeEach(async () => {
  const vaultPath = await createVaultCopy('core');
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
});

const CARD_PATH = 'Synced card.md';
const PROPERTIES = '---\ncreated: 2026-11-09\n---\n';
const CARD_TEXT = 'The text of the synced card';
/** Two paragraphs, which give the embed a different shape from no text. */
const CARD_PARAGRAPHS = 'The first paragraph\n\nThe second paragraph';
const SEVERAL_PARAGRAPHS = new RegExp(
  `\\b${EMBED_SHAPE_CLASSES.paragraphs}\\b`
);

// Bounded inside `CURRENT_ITEM_REFETCH_TIME`: the embed has to follow its note
// by itself, not wait for review to look at the item again.
const CATCH_UP = { timeout: CURRENT_ITEM_REFETCH_TIME - 2_000 };

/** The review editor's embeds of the card. */
const cardEmbed = (page: Page) =>
  page.locator(
    `.workspace-leaf.mod-active .ir-editor .internal-embed[alt*="${TRANSCLUSION_HIDE_TITLE_ALIAS}"]`
  );

async function reviewArticle(page: Page) {
  await importArticle(page, 'sources/Security Principles');
  await executeCommandById(page, 'incremental-reading:learn');
  await page.locator('css=#begin-review-button').click();
  await expect(reviewTitle(page, 'Security Principles')).toBeVisible();
}

/** Put an embed of the card after the reviewed note's first paragraph. */
const embedCardInReviewedNote = (page: Page) =>
  page.evaluate(async (alias) => {
    // Unofficial: `app` on the window, `workspace.activeEditor` naming the
    // review editor's note.
    const { app } = window as unknown as {
      app: {
        workspace: { activeEditor: { file: unknown } };
        vault: {
          process(file: unknown, fn: (text: string) => string): Promise<string>;
        };
      };
    };
    await app.vault.process(app.workspace.activeEditor.file, (text) =>
      text.replace(/\n\n/, `\n\n![[Synced card|${alias}]]\n\n`)
    );
  }, TRANSCLUSION_HIDE_TITLE_ALIAS);

/** Create the card's note, or write it over, with `text`. */
const writeCard = (page: Page, text: string) =>
  page.evaluate(
    async ({ path, text }) => {
      const { app } = window as unknown as {
        app: {
          vault: {
            getAbstractFileByPath(path: string): unknown;
            create(path: string, text: string): Promise<unknown>;
            modify(file: unknown, text: string): Promise<void>;
          };
        };
      };
      const file = app.vault.getAbstractFileByPath(path);
      if (file) await app.vault.modify(file, text);
      else await app.vault.create(path, text);
    },
    { path: CARD_PATH, text }
  );

test('a card embed in the review editor fills in when its note gets its text after the embed was drawn', async () => {
  await reviewArticle(window);
  await writeCard(window, PROPERTIES);
  await embedCardInReviewedNote(window);

  // Drawn from the note as it was: its properties, no text.
  const embed = cardEmbed(window);
  await expect(embed.locator('.markdown-embed-link')).toBeAttached({
    timeout: 15_000,
  });
  await expect(embed.locator('.frontmatter')).toBeAttached();
  await expect(embed).not.toContainText(/second paragraph/);
  await expect(embed).not.toHaveClass(SEVERAL_PARAGRAPHS);

  await writeCard(window, PROPERTIES + CARD_PARAGRAPHS);

  await expect(embed).toContainText(/second paragraph/, CATCH_UP);
  // Shaped for the text that came in, not for the text it was drawn with
  await expect(embed).toHaveClass(SEVERAL_PARAGRAPHS);
});

test('a card embed in the review editor shows its note when the note arrives after the embed', async () => {
  await reviewArticle(window);
  await embedCardInReviewedNote(window);

  // Drawn while the note was missing.
  const embed = cardEmbed(window);
  await expect(embed).toHaveClass(/\bmod-empty\b/, { timeout: 15_000 });

  await writeCard(window, PROPERTIES + CARD_TEXT);

  await expect(embed).toContainText(CARD_TEXT, CATCH_UP);
  await expect(embed).not.toHaveClass(/\bmod-empty\b/);
});
