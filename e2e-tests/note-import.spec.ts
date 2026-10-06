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
  setNewLinkFormat,
  watchNotices,
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
    create(path: string, data: string): Promise<unknown>;
    createFolder(path: string): Promise<unknown>;
    process(file: unknown, edit: (text: string) => string): Promise<string>;
  };
  metadataCache: {
    getFileCache(file: unknown): {
      frontmatter?: Record<string, unknown>;
      links?: PageLink[];
      embeds?: PageLink[];
    } | null;
    getFirstLinkpathDest(
      linkpath: string,
      sourcePath: string
    ): { path: string } | null;
  };
  workspace: {
    getLeaf(newLeaf: 'tab'): { openFile(file: unknown): Promise<void> };
    getActiveFile(): { path: string } | null;
    openLinkText(linktext: string, sourcePath: string): Promise<void>;
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

/** A link or embed as the metadata cache gives it. */
type PageLink = {
  link: string;
  original: string;
  position: { start: { offset: number } };
};

/**
 * Each link and embed in the note at `notePath`, in order, as written, and
 * the path of the file it resolves to from there; empty until Obsidian has
 * read the note.
 */
const resolvedLinks = (page: Page, notePath: string) =>
  page.evaluate((from) => {
    const { app } = window as unknown as { app: PageApp };
    const file = app.vault.getFileByPath(from);
    const cache = file ? app.metadataCache.getFileCache(file) : null;
    return [...(cache?.links ?? []), ...(cache?.embeds ?? [])]
      .sort((a, b) => a.position.start.offset - b.position.start.offset)
      .map(({ link, original }) => ({
        original,
        to:
          app.metadataCache.getFirstLinkpathDest(link.split('#')[0], from)
            ?.path ?? null,
      }));
  }, notePath);

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
 * wait until the note on disk holds its embed: by default by the card's name
 * alone, as the shortest link format writes it, else as `embedOf` says from
 * the card's note path.
 * @returns the card's note path, and the note's bytes with the embed in them
 */
async function cardFromPlainNote(
  page: Page,
  embedOf = (cardPath: string) =>
    `![[${path.posix.basename(cardPath, '.md')}|ir-hide-title]]`
) {
  await openNote(page, 'sources/Security Principles');
  await selectParagraph(page, BULLET_TEXT);
  await executeCommandById(page, 'incremental-reading:create-card');
  await expect.poll(() => cards(page)).toHaveLength(1);
  const [card] = await cards(page);
  expect(card.parent).toBeNull();
  const embed = embedOf(card.reference);
  await expect
    .poll(async () => (await readNote()).toString('utf8'))
    .toContain(embed);
  return { card, embed, noteBytes: await readNote() };
}

/**
 * Open the card at `cardPath` in a tab of its own and choose Go to context
 * from its view's menu.
 * @returns what reads, once the jump is made, the note open in the active
 * tab and each range a note's view was asked to show
 */
async function goToContext(window: Page, cardPath: string) {
  await window.evaluate((cardPath) => {
    const { app } = window as unknown as { app: PageApp };
    return app.workspace
      .getLeaf('tab')
      .openFile(app.vault.getFileByPath(cardPath));
  }, cardPath);
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
  return () =>
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
    });
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
    await expect
      .poll(await goToContext(window, card.reference))
      .toEqual({ file: COPY_PATH, shown: [{ path: COPY_PATH, text: embed }] });
  });
});

test.describe('Importing a note as a copy', () => {
  test('names the copy without the bidi override its name holds, and says so', async () => {
    // Shows as "invoiceexe.pdf", as sync, git or a zip can deliver it
    const sourcePath = 'sources/invoice\u202efdp.exe.md';
    const copyPath = `${DATA_DIRECTORY}/${ARTICLE_DIRECTORY}/invoicefdp.exe.md`;
    await window.evaluate(async (notePath) => {
      const { app } = window as unknown as {
        app: PageApp & {
          vault: { create(path: string, data: string): Promise<unknown> };
        };
      };
      const note = await app.vault.create(
        notePath,
        'An invoice, or so it says.'
      );
      await app.workspace.getLeaf('tab').openFile(note);
      app.plugins.plugins['incremental-reading'].toggleAdvancedCommands(true);
    }, sourcePath);
    const notices = await watchNotices(window);

    await executeCommandById(window, 'incremental-reading:import-article-copy');

    await expect
      .poll(async () => (await articleRows(window)).map((r) => r.reference))
      .toEqual([copyPath]);
    expect(await fs.readFile(path.join(vaultPath, copyPath), 'utf8')).toContain(
      'An invoice, or so it says.'
    );
    await expect
      .poll(notices)
      .toContainEqual(
        expect.stringContaining(
          `removed characters a note name can't hold; the copy is named "invoicefdp.exe.md"`
        )
      );
  });
});

test.describe('Importing a note as a copy re-bases its links', () => {
  test('in the relative link format, a relative link and a card embed resolve from the copy as from the original, and Go to context lands on the embed', async () => {
    await setNewLinkFormat(window, 'relative');
    const target = 'other/Target.md';
    await window.evaluate(
      async ({ notePath, targetPath }) => {
        const { app } = window as unknown as { app: PageApp };
        await app.vault.createFolder('other');
        await app.vault.create(targetPath, 'The target.');
        await app.vault.process(
          app.vault.getFileByPath(notePath),
          (text) => `${text}\nSee [[../other/Target]].\n`
        );
      },
      { notePath: NOTE_PATH, targetPath: target }
    );
    // The format writes the embed by its path from the note's folder
    const { card, noteBytes } = await cardFromPlainNote(
      window,
      (cardPath) => `![[../${cardPath.slice(0, -'.md'.length)}|ir-hide-title]]`
    );
    await expect
      .poll(async () =>
        (await resolvedLinks(window, NOTE_PATH)).map((l) => l.to)
      )
      .toEqual(expect.arrayContaining([card.reference, target]));
    const fromOriginal = await resolvedLinks(window, NOTE_PATH);

    await window.evaluate(() => {
      const { app } = window as unknown as { app: PageApp };
      app.plugins.plugins['incremental-reading'].toggleAdvancedCommands(true);
    });
    await executeCommandById(window, 'incremental-reading:import-article-copy');

    await expect
      .poll(async () => (await articleRows(window)).map((r) => r.reference))
      .toEqual([COPY_PATH]);
    // Every link leads where it did, one to the original to the copy
    await expect
      .poll(async () =>
        (await resolvedLinks(window, COPY_PATH)).map((l) => l.to)
      )
      .toEqual(
        fromOriginal.map(({ to }) => (to === NOTE_PATH ? COPY_PATH : to))
      );
    const copyLinks = await resolvedLinks(window, COPY_PATH);
    expect(copyLinks.map((l) => l.original)).toEqual(
      expect.arrayContaining([
        '[[../../other/Target]]',
        `![[${path.posix
          .relative(path.posix.dirname(COPY_PATH), card.reference)
          .slice(0, -'.md'.length)}|ir-hide-title]]`,
      ])
    );
    // Nothing is written to the original
    expect((await readNote()).equals(noteBytes)).toBe(true);

    const embedInCopy = copyLinks.find((l) => l.to === card.reference)!;
    await expect.poll(await goToContext(window, card.reference)).toEqual({
      file: COPY_PATH,
      shown: [{ path: COPY_PATH, text: embedInCopy.original }],
    });
  });

  test('in the shortest link format, a link by name alone keeps leading to the file it did, though a namesake sits beside the copy', async () => {
    await setNewLinkFormat(window, 'shortest');
    const linker = 'sources/Linker.md';
    const linkerCopy = `${DATA_DIRECTORY}/${ARTICLE_DIRECTORY}/Linker.md`;
    const namesake = `${DATA_DIRECTORY}/${ARTICLE_DIRECTORY}/x.md`;
    await window.evaluate(
      async ({ linkerPath, namesakePath }) => {
        const { app } = window as unknown as { app: PageApp };
        await app.vault.create('sources/x.md', 'The x beside the note.');
        const folder = namesakePath.slice(0, namesakePath.lastIndexOf('/'));
        if (!app.vault.getFileByPath(folder)) {
          await app.vault.createFolder(folder).catch(() => undefined);
        }
        await app.vault.create(namesakePath, 'Another x.');
        const note = await app.vault.create(linkerPath, 'See [[x]].\n');
        await app.workspace.getLeaf('tab').openFile(note);
        app.plugins.plugins['incremental-reading'].toggleAdvancedCommands(true);
      },
      { linkerPath: linker, namesakePath: namesake }
    );
    await expect
      .poll(() => resolvedLinks(window, linker))
      .toEqual([{ original: '[[x]]', to: 'sources/x.md' }]);
    const linkerBytes = await fs.readFile(path.join(vaultPath, linker));

    await executeCommandById(window, 'incremental-reading:import-article-copy');

    await expect
      .poll(async () => (await articleRows(window)).map((r) => r.reference))
      .toEqual([linkerCopy]);
    // Two notes are named x now, so the link names its file by its path
    await expect
      .poll(() => resolvedLinks(window, linkerCopy))
      .toEqual([{ original: '[[sources/x]]', to: 'sources/x.md' }]);
    await window.evaluate(async (from) => {
      const { app } = window as unknown as { app: PageApp };
      await app.workspace.openLinkText('sources/x', from);
    }, linkerCopy);
    await expect
      .poll(() =>
        window.evaluate(() => {
          const { app } = window as unknown as { app: PageApp };
          return app.workspace.getActiveFile()?.path;
        })
      )
      .toBe('sources/x.md');
    expect(
      (await fs.readFile(path.join(vaultPath, linker))).equals(linkerBytes)
    ).toBe(true);
  });
});
