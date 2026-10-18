import { CLOZE_DELIMITERS } from '#/lib/constants';
import test, {
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  askBeforeUpdatingLinks,
  emulateMobile,
  executeCommandById,
  finalizeArticleImport,
  openFileInActiveLeaf,
  PDF_FIXTURE_FOLDER,
  PDF_FIXTURE_PATH,
  pendingSaves,
  renameDecliningLinkUpdate,
  REVIEW_VIEW_TYPE,
  setNativeMenus,
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

/** The three-page fixture `scripts/make-pdf-fixtures.mjs` writes. */
const PDF_PATH = PDF_FIXTURE_PATH;
/** Its one-page sibling with no text layer. */
const NO_TEXT_PDF_PATH = `${PDF_FIXTURE_FOLDER}/PDF fixture - no text.pdf`;

/** What the page-side calls below reach on Obsidian and the plugin. */
type PageApp = {
  vault: { getFileByPath(path: string): unknown };
  fileManager: { renameFile(file: unknown, newPath: string): Promise<void> };
  workspace: {
    getLeaf(newLeaf: 'tab'): { openFile(file: unknown): Promise<void> };
    getLeavesOfType(type: string): {
      view: { scope: unknown; pdfViewer: { scope: unknown } | null };
    }[];
  };
  embedRegistry: { embedByExtension: Record<string, unknown> };
  plugins: {
    plugins: Record<
      string,
      {
        store: { dispatch(action: { type: string; payload: unknown }): void };
        reviewManager: {
          repo: {
            query(sql: string, params?: unknown[]): Record<string, unknown>[];
          };
        };
      }
    >;
  };
};

const article = (page: Page) => page.locator('.ir-pdf-article');
const placeholder = (page: Page) => page.locator('.ir-binary-item');
const pdfPage = (page: Page, n: number) =>
  article(page).locator(`.page[data-page-number="${n}"]`);

/** Import a fixture in place, from its own PDF tab. */
async function importFixture(page: Page, pdfPath = PDF_PATH) {
  await openFileInActiveLeaf(page, pdfPath);
  await executeCommandById(page, 'incremental-reading:import-article');
  await finalizeArticleImport(page);
  await expect
    .poll(() =>
      page.evaluate((ref) => {
        const { app } = window as unknown as { app: PageApp };
        const { repo } =
          app.plugins.plugins['incremental-reading'].reviewManager;
        return repo.query('SELECT id FROM article WHERE reference = $1', [ref])
          .length;
      }, pdfPath)
    )
    .toBe(1);
}

async function beginReview(page: Page) {
  await executeCommandById(page, 'incremental-reading:learn');
  await page.locator('css=#begin-review-button').click();
}

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('pdf-review');
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);
  // CI runs headed at about 1024px wide; pin it so the layout checks agree
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

test.describe('Reviewing a PDF article', () => {
  test("shows it in Obsidian's viewer, with zoom, find and the action bar", async () => {
    await importFixture(window);
    await beginReview(window);

    await expect(pdfPage(window, 1).locator('.textLayer')).toContainText(
      'Incremental reading turns a long text'
    );
    await expect(
      article(window).locator('.ir-pdf-viewer > .pdf-toolbar')
    ).toBeVisible();
    await expect(placeholder(window)).toHaveCount(0);

    // Full height below the action bar, never under it
    const bar = await window
      .locator('.ir-review-interface .ir-action-bar')
      .boundingBox();
    const viewer = await article(window).boundingBox();
    const content = await window.locator('.ir-review-interface').boundingBox();
    expect(bar && viewer && content).toBeTruthy();
    expect(viewer!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height - 1);
    expect(viewer!.y + viewer!.height).toBeCloseTo(
      content!.y + content!.height,
      0
    );
    expect(viewer!.height).toBeGreaterThan(400);

    // Zoom, from the viewer's own toolbar
    const widthBefore = (await pdfPage(window, 1).boundingBox())!.width;
    await article(window).locator('[aria-label="Zoom in"]').click();
    await expect
      .poll(async () => (await pdfPage(window, 1).boundingBox())!.width)
      .toBeGreaterThan(widthBefore);

    // Find, from Obsidian's own search command, closed by the viewer's Escape
    await executeCommandById(window, 'editor:open-search');
    const findBar = article(window).locator('.pdf-findbar');
    await expect(findBar).toBeVisible();
    await window.keyboard.type('snippet');
    await window.keyboard.press('Enter');
    await expect(
      article(window).locator('.textLayer .highlight').first()
    ).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(findBar).toBeHidden();

    // Finishing the item takes the viewer, and its keys, with it
    await window.getByRole('button', { name: 'Mark reviewed' }).click();
    await expect(article(window)).toHaveCount(0);
    await executeCommandById(window, 'editor:open-search');
    await expect(
      window.locator('.pdf-findbar').filter({ visible: true })
    ).toHaveCount(0);
  });

  test('fits between the header and the action bar on a phone', async () => {
    await importFixture(window);
    // Emulating reloads the app, and a reload mid-write empties the database
    await expect.poll(() => pendingSaves(window)).toBe(0);
    await emulateMobile(window, true);
    await window.setViewportSize({ width: 420, height: 900 });
    await expect(window.locator('body')).toHaveClass(/\bis-phone\b/);

    await beginReview(window);

    await expect(pdfPage(window, 1).locator('.textLayer')).toContainText(
      'Incremental reading turns a long text'
    );
    const leaf = `.workspace-leaf.mod-active [data-type="${REVIEW_VIEW_TYPE}"]`;
    const header = await window.locator(`${leaf} > .view-header`).boundingBox();
    const toolbar = await article(window)
      .locator('.ir-pdf-viewer > .pdf-toolbar')
      .boundingBox();
    const viewer = await article(window).boundingBox();
    const bar = await window.locator(`${leaf} .ir-action-bar`).boundingBox();
    expect(header && toolbar && viewer && bar).toBeTruthy();
    // Below the floating header, and the action bar below it, uncovered
    expect(toolbar!.y).toBeGreaterThanOrEqual(header!.y + header!.height - 1);
    expect(viewer!.y + viewer!.height).toBeLessThanOrEqual(bar!.y + 1);
    expect(bar!.y + bar!.height).toBeLessThanOrEqual(900);
    expect(viewer!.height).toBeGreaterThan(400);
  });

  test("looks like a PDF tab on a phone: the item's name in the header, the toolbar as high", async () => {
    /** Each fixture's name, by its page count: what tells them apart on screen. */
    const nameByPages = new Map([
      [3, path.basename(PDF_PATH, '.pdf')],
      [1, path.basename(NO_TEXT_PDF_PATH, '.pdf')],
    ]);
    for (const pdfPath of [PDF_PATH, NO_TEXT_PDF_PATH]) {
      await importFixture(window, pdfPath);
    }
    // Emulating reloads the app, and a reload mid-write empties the database
    await expect.poll(() => pendingSaves(window)).toBe(0);
    await emulateMobile(window, true);
    await window.setViewportSize({ width: 420, height: 900 });
    const body = window.locator('body');
    await expect(body).toHaveClass(/\bis-phone\b/);
    // The setting under which Obsidian hides a note's header title on phones
    await expect(body).toHaveClass(/\bshow-inline-title\b/);
    // The floating header, which is what gives a PDF tab its top spacing
    await expect(body).toHaveClass(/\bis-floating-nav\b/);

    // Obsidian's own PDF tab, for reference
    await openFileInActiveLeaf(window, PDF_PATH);
    const pdfTab = window.locator(
      '.workspace-leaf.mod-active .workspace-leaf-content[data-type="pdf"]'
    );
    await expect(pdfTab.locator('.view-header-title')).toBeVisible();
    const pdfTabToolbar = pdfTab.locator('.view-content > .pdf-toolbar');
    await expect(pdfTabToolbar).toBeVisible();
    const expectedTop = (await pdfTabToolbar.boundingBox())?.y;
    expect(expectedTop).toBeDefined();

    const leaf = window.locator(
      `.workspace-leaf.mod-active [data-type="${REVIEW_VIEW_TYPE}"]`
    );
    const title = leaf.locator('> .view-header .view-header-title');
    // The home screen keeps its header title hidden, as a note does
    await executeCommandById(window, 'incremental-reading:learn');
    await expect(window.locator('css=#begin-review-button')).toBeVisible();
    await expect(title).toBeHidden();
    await window.locator('css=#begin-review-button').click();

    const toolbar = article(window).locator('.ir-pdf-viewer > .pdf-toolbar');
    let pages = 0;
    for (let i = 0; i < nameByPages.size; i++) {
      if (i > 0) {
        await window.getByRole('button', { name: 'Mark reviewed' }).click();
      }
      // The next fixture's pages, once its viewer has laid them out
      const previous = pages;
      await expect
        .poll(async () => {
          pages = await article(window).locator('.page').count();
          return nameByPages.has(pages) && pages !== previous;
        })
        .toBe(true);
      const name = nameByPages.get(pages);
      await expect(toolbar).toBeVisible();
      await expect(title).toBeVisible();
      await expect(title).toHaveText(name!);
      const box = await toolbar.boundingBox();
      expect(box).toBeTruthy();
      expect(Math.abs(box!.y - expectedTop!)).toBeLessThanOrEqual(1);
    }
    // Past the last PDF, no item: the header title hides again
    await window.getByRole('button', { name: 'Mark reviewed' }).click();
    await expect(article(window)).toHaveCount(0);
    await expect(title).toBeHidden();
  });
});

test.describe('Reading position in a PDF article', () => {
  /** The id of the article at `reference`, once there is one. */
  async function articleId(page: Page, reference: string): Promise<string> {
    let id = '';
    await expect
      .poll(async () => {
        id = await page.evaluate((ref) => {
          const { app } = window as unknown as { app: PageApp };
          const { repo } =
            app.plugins.plugins['incremental-reading'].reviewManager;
          const rows = repo.query(
            'SELECT id FROM article WHERE reference = $1',
            [ref]
          );
          return rows.length ? String(rows[0].id) : '';
        }, reference);
        return id;
      })
      .not.toBe('');
    return id;
  }

  /** Show item `id` in the review tab, opening one if there is none. */
  async function showItem(page: Page, id: string) {
    const hasReviewTab = await page.evaluate(
      (viewType) =>
        (window as unknown as { app: PageApp }).app.workspace.getLeavesOfType(
          viewType
        ).length > 0,
      REVIEW_VIEW_TYPE
    );
    if (!hasReviewTab) {
      await executeCommandById(page, 'incremental-reading:learn');
    }
    await page.evaluate((itemId) => {
      const { store } = (window as unknown as { app: PageApp }).app.plugins
        .plugins['incremental-reading'];
      store.dispatch({ type: 'page/setPage', payload: 'review' });
      store.dispatch({
        type: 'currentItemId/setCurrentItemId',
        payload: itemId,
      });
    }, id);
  }

  /** The review tab's action bar. */
  const actionBar = (page: Page) =>
    page.locator('.ir-review-interface .ir-action-bar');

  /** Scroll the review tab's PDF so `fraction` of page `n` is above its top. */
  const scrollInto = (page: Page, n: number, fraction: number) =>
    page.evaluate(
      ([pageNumber, into]) => {
        const container = document.querySelector(
          '.ir-pdf-article .pdf-viewer-container'
        )!;
        const target = container.querySelector(
          `.page[data-page-number="${pageNumber}"]`
        )!;
        const pageRect = target.getBoundingClientRect();
        const edge = container.getBoundingClientRect().top;
        container.scrollTop += pageRect.top - edge + into * pageRect.height;
      },
      [n, fraction] as const
    );

  /**
   * Expect the review tab's PDF where its reader stopped: page 3's text on
   * screen, and page 1's first line, where it opens unsaved, off it.
   */
  async function expectStopped(page: Page) {
    await expect(
      pdfPage(page, 3).getByText('The third page closes the fixture.')
    ).toBeInViewport();
    await expect(
      pdfPage(page, 1).getByText('Incremental reading turns a long text')
    ).not.toBeInViewport();
  }

  test('reopens where its reader stopped: after its file changes on disk, and after a restart, at any zoom', async () => {
    await importFixture(window);
    const pdfId = await articleId(window, PDF_PATH);

    await showItem(window, pdfId);
    await expect(article(window).locator('.page')).toHaveCount(3);
    await expect(pdfPage(window, 1).locator('.textLayer')).toContainText(
      'Incremental reading turns a long text'
    );

    // Zoomed in, then read to just above page 3's text
    const widthBefore = (await pdfPage(window, 1).boundingBox())!.width;
    await article(window).locator('[aria-label="Zoom in"]').click();
    await expect
      .poll(async () => (await pdfPage(window, 1).boundingBox())!.width)
      .toBeGreaterThan(widthBefore);
    await scrollInto(window, 3, 0.05);
    await expectStopped(window);

    // The file rewritten on disk: Obsidian reloads it, where it was
    await window.evaluate(() => {
      for (const el of document.querySelectorAll('.ir-pdf-article .page')) {
        el.setAttribute('data-before-reload', '');
      }
    });
    const bytes = await fs.readFile(path.join(vaultPath, PDF_PATH));
    await fs.writeFile(path.join(vaultPath, PDF_PATH), bytes);
    await expect(pdfPage(window, 3)).not.toHaveAttribute(
      'data-before-reload',
      ''
    );
    await expect(pdfPage(window, 3)).toHaveAttribute('data-loaded', 'true');
    await expectStopped(window);

    // Leaving it for the home screen saves where it rests at once, with
    // nothing on screen to wait on for the save a rest makes; then quit, with
    // the database on disk, and start again
    await actionBar(window)
      .getByRole('button', { name: 'Go to home screen' })
      .click();
    await expect(window.locator('css=#begin-review-button')).toBeVisible();
    await expect(article(window)).toHaveCount(0);
    await expect.poll(() => pendingSaves(window)).toBe(0);
    await closeElectron(app);
    app = await launchElectron(vaultPath);
    window = await openVault(app, vaultPath);
    // Obsidian reopens the review tab while it boots, at whatever size the
    // window has (CI's small screens): this resizes it after it has opened
    await window.setViewportSize({ width: 1280, height: 800 });
    await expect(window.locator('css=#begin-review-button')).toBeVisible();

    await showItem(window, pdfId);
    await expect(pdfPage(window, 3)).toHaveAttribute('data-loaded', 'true');
    await expectStopped(window);
  });
});

test.describe('Snippets and cards from a PDF article', () => {
  const FIRST_LINE =
    'Incremental reading turns a long text into a series of short reviews.';

  const confirmButton = (page: Page) =>
    page.locator('#confirm-selection-button');
  /** The review tab's action bar: the PDF's own tab, still open, has one too. */
  const actionBar = (page: Page) =>
    page.locator('.ir-review-interface .ir-action-bar');
  const answerText = (page: Page) =>
    page.locator('.modal .ir-card-answer-text');
  const textItem = (page: Page, n: number, idx: number) =>
    pdfPage(page, n).locator(`.textLayer [data-idx="${idx}"]`);

  /** Every snippet row, with its note's body. */
  const snippets = (page: Page) =>
    page.evaluate(async () => {
      const { app } = window as unknown as {
        app: PageApp & {
          vault: {
            getFileByPath(path: string): unknown;
            cachedRead(file: unknown): Promise<string>;
          };
          metadataCache: {
            getFileCache(file: unknown): {
              frontmatter?: Record<string, unknown>;
            } | null;
          };
        };
      };
      const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
      const rows = repo.query(
        'SELECT reference, parent, start_offset, end_offset FROM snippet'
      );
      return Promise.all(
        rows.map(async (row) => {
          const file = app.vault.getFileByPath(row.reference as string);
          const note = file ? await app.vault.cachedRead(file) : null;
          return {
            reference: row.reference as string,
            parent: row.parent as string | null,
            start_offset: row.start_offset as number | null,
            end_offset: row.end_offset as number | null,
            body: note?.replace(/^---\n[\s\S]*?\n---\n/, '').trim(),
            source: file
              ? app.metadataCache.getFileCache(file)?.frontmatter?.source
              : undefined,
          };
        })
      );
    });

  /** Every card row, with its note's body. */
  const cards = (page: Page) =>
    page.evaluate(async () => {
      const { app } = window as unknown as {
        app: PageApp & {
          vault: {
            getFileByPath(path: string): unknown;
            cachedRead(file: unknown): Promise<string>;
          };
          metadataCache: {
            getFileCache(file: unknown): {
              frontmatter?: Record<string, unknown>;
            } | null;
          };
        };
      };
      const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
      const rows = repo.query('SELECT reference, parent FROM srs_card');
      return Promise.all(
        rows.map(async (row) => {
          const file = app.vault.getFileByPath(row.reference as string);
          const note = file ? await app.vault.cachedRead(file) : null;
          return {
            reference: row.reference as string,
            parent: row.parent as string | null,
            body: note?.replace(/^---\n[\s\S]*?\n---\n/, '').trim(),
            source: file
              ? app.metadataCache.getFileCache(file)?.frontmatter?.source
              : undefined,
          };
        })
      );
    });

  /** Select `answer` in the answer modal's text, as the user would. */
  const selectAnswer = async (page: Page, answer: string) => {
    await answerText(page).evaluate((el, answer) => {
      const node = el.firstChild as Text;
      const start = node.data.indexOf(answer);
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + answer.length);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, answer);
    // `selectionchange` is dispatched as a task, not synchronously
    await page.waitForTimeout(100);
  };

  const articleId = (page: Page) =>
    page.evaluate((ref) => {
      const { app } = window as unknown as { app: PageApp };
      const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
      return repo.query('SELECT id FROM article WHERE reference = $1', [ref])[0]
        .id;
    }, PDF_PATH);

  /**
   * Select from `[page, idx, offset]` to another such point in the review
   * tab's PDF, as a script would: Obsidian snaps only pointer selections.
   */
  const selectText = (
    page: Page,
    from: [number, number, number],
    to: [number, number, number]
  ) =>
    page.evaluate(
      ([from, to]) => {
        const point = ([n, idx, offset]: number[]) => {
          const span = document.querySelector(
            `.ir-pdf-article .page[data-page-number="${n}"] [data-idx="${idx}"]`
          );
          if (!span?.firstChild) throw new Error(`No item ${n}/${idx}`);
          return [span.firstChild, offset] as const;
        };
        const range = document.createRange();
        range.setStart(...point(from));
        range.setEnd(...point(to));
        const selection = document.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      },
      [from, to]
    );

  /** Whether the review tab's selection change has reached the viewer yet. */
  const viewerSelection = (page: Page) =>
    page.evaluate((viewType) => {
      const { app } = window as unknown as { app: PageApp };
      const { view } = app.workspace.getLeavesOfType(viewType)[0];
      const viewer = view.pdfViewer as unknown as {
        selection(): Range | null;
      } | null;
      return viewer?.selection()?.toString() ?? null;
    }, REVIEW_VIEW_TYPE);

  test('extracts from the command as from the button', async () => {
    await importFixture(window);
    await beginReview(window);
    await expect(textItem(window, 1, 2)).toBeAttached();

    await selectText(window, [1, 2, 0], [1, 2, FIRST_LINE.length]);
    await expect.poll(() => viewerSelection(window)).toBe(FIRST_LINE);
    await executeCommandById(window, 'incremental-reading:extract-selection');

    await expect.poll(() => snippets(window)).toHaveLength(1);
    expect((await snippets(window))[0].body).toBe(FIRST_LINE);
  });

  test('extracts from the command picked in the palette by a click', async () => {
    await importFixture(window);
    await beginReview(window);
    await expect(textItem(window, 1, 2)).toBeAttached();

    await selectText(window, [1, 2, 0], [1, 2, FIRST_LINE.length]);
    await expect.poll(() => viewerSelection(window)).toBe(FIRST_LINE);
    await executeCommandById(window, 'command-palette:open');
    const palette = window.locator('.modal-container .prompt');
    await expect(palette).toBeVisible();
    await window.keyboard.type('Extract selection to snippet');
    await palette
      .locator('.suggestion-item', { hasText: 'Extract selection to snippet' })
      .first()
      .click();

    await expect.poll(() => snippets(window)).toHaveLength(1);
    expect((await snippets(window))[0].body).toBe(FIRST_LINE);
    await expect(confirmButton(window)).toHaveCount(0);
  });

  test('enters selection mode from the command with nothing selected, and makes no card when its answer is not chosen', async () => {
    await importFixture(window);
    await beginReview(window);
    await expect(textItem(window, 1, 2)).toBeAttached();

    await executeCommandById(window, 'incremental-reading:create-card');
    await expect(confirmButton(window)).toBeVisible();
    await selectText(window, [1, 2, 0], [1, 2, FIRST_LINE.length]);
    await expect.poll(() => viewerSelection(window)).toBe(FIRST_LINE);
    // The command for the mode's kind confirms it, as its button does
    await executeCommandById(window, 'incremental-reading:create-card');
    await expect(answerText(window)).toHaveText(FIRST_LINE);
    await expect(confirmButton(window)).toHaveCount(0);

    await window.keyboard.press('Escape');

    await expect(answerText(window)).toHaveCount(0);
    expect(await cards(window)).toEqual([]);
    expect(await viewerSelection(window)).toBeNull();
    // Heard again once the answer is no longer being asked for
    await executeCommandById(window, 'incremental-reading:create-card');
    await expect(confirmButton(window)).toBeVisible();
  });

  test('says a scanned page has no selectable text, and makes nothing', async () => {
    await importFixture(window, NO_TEXT_PDF_PATH);
    await beginReview(window);
    await expect(pdfPage(window, 1)).toBeVisible();
    const notices = await watchNotices(window);

    // A drag across the page, which selects nothing: there is no text
    const box = (await pdfPage(window, 1).boundingBox())!;
    await window.mouse.move(box.x + 50, box.y + 50);
    await window.mouse.down();
    await window.mouse.move(box.x + box.width - 50, box.y + 300, { steps: 10 });
    await window.mouse.up();
    await window.getByRole('button', { name: 'Create snippet' }).click();
    await executeCommandById(window, 'incremental-reading:extract-selection');
    await actionBar(window)
      .getByRole('button', { name: 'Create card' })
      .click();
    await executeCommandById(window, 'incremental-reading:create-card');

    await expect
      .poll(notices)
      .toHaveLength(4);
    expect(await snippets(window)).toEqual([]);
    expect(await cards(window)).toEqual([]);
    await expect(confirmButton(window)).toHaveCount(0);
  });

  /**
   * Open the snippet's note in a tab of its own, and pick Go to context from
   * that tab's ⋮ menu.
   */
  async function goToContextFrom(page: Page, snippetPath: string) {
    await page.evaluate((path) => {
      const { app } = window as unknown as { app: PageApp };
      return app.workspace
        .getLeaf('tab')
        .openFile(app.vault.getFileByPath(path));
    }, snippetPath);
    await setNativeMenus(page, false);
    await page
      .locator('.workspace-leaf.mod-active .view-header')
      .getByLabel('More options')
      .click();
    await page
      .locator('.menu')
      .getByText('Go to context', { exact: true })
      .click();
  }

  /** The PDF tab Go to context opened, and its highlighted text. */
  const contextTab = (page: Page) =>
    page.locator('.workspace-leaf.mod-active .pdf-container');

  test('goes to the context of a snippet on a later page: the PDF on that page, with the snippet lit up', async () => {
    const SECOND_PAGE_TEXT = 'ends here, on the second page,';
    await importFixture(window);
    await beginReview(window);
    await pdfPage(window, 2).scrollIntoViewIfNeeded();
    await expect(textItem(window, 2, 3)).toBeAttached();
    await selectText(window, [2, 3, 0], [2, 3, SECOND_PAGE_TEXT.length]);
    await expect.poll(() => viewerSelection(window)).not.toBeNull();
    await window.getByRole('button', { name: 'Create snippet' }).click();
    await expect.poll(() => snippets(window)).toHaveLength(1);
    const [snippet] = await snippets(window);

    await goToContextFrom(window, snippet.reference);

    const lit = contextTab(window).locator(
      '.page[data-page-number="2"] .textLayer .mod-focused'
    );
    await expect(lit).toHaveCount(1);
    await expect(lit).toHaveText(SECOND_PAGE_TEXT);
    await expect(lit).toBeInViewport();
  });

  /** The highlight boxes over item `idx` of page `n` of the PDF in `root`. */
  const itemBoxes = (
    root: Locator,
    n: number,
    idx: number,
    cls = 'ir-snippet-highlight'
  ) =>
    root.locator(
      `.page[data-page-number="${n}"] .ir-pdf-highlights > .${cls}[data-item="${idx}"]`
    );

  /**
   * Click the middle of `box`, as a reader does: on the text over it, since
   * the box itself takes no pointer events.
   */
  async function clickOn(page: Page, box: Locator) {
    await box.scrollIntoViewIfNeeded();
    const { x, y, width, height } = (await box.boundingBox())!;
    await page.mouse.click(x + width / 2, y + height / 2);
  }

  /**
   * The color `scope`'s element shows over a white page, as [r, g, b]: its
   * background, composited through its own and its ancestors' opacity. With
   * `probe`, that of a box in the document's body painted `probe`, which may
   * name the plugin's variables, as a markdown highlight is painted.
   */
  const seenOverWhite = (scope: Locator, probe?: string) =>
    scope.evaluate((el, probe) => {
      let target = el;
      if (probe) {
        target = el.ownerDocument.body.appendChild(
          el.ownerDocument.createElement('div')
        );
        target.style.backgroundColor = probe;
      }
      const [r, g, b, a = 1] = (
        /rgba?\(([^)]*)\)/.exec(
          getComputedStyle(target).backgroundColor
        )?.[1] ?? ''
      )
        .split(/[,\s/]+/)
        .map(Number);
      let alpha = a;
      for (let up: Element | null = target; up; up = up.parentElement) {
        alpha *= Number(getComputedStyle(up).opacity);
      }
      if (probe) target.remove();
      return [r, g, b].map((c) => Math.round(alpha * c + (1 - alpha) * 255));
    }, probe);

  /**
   * Select by character offsets, as {@link selectText} does, in item spans
   * whose text highlights have split into several nodes.
   */
  const selectChars = (
    page: Page,
    from: [number, number, number],
    to: [number, number, number]
  ) =>
    page.evaluate(
      ([from, to]) => {
        const point = ([n, idx, char]: number[]) => {
          const span = document.querySelector(
            `.ir-pdf-article .page[data-page-number="${n}"] [data-idx="${idx}"]`
          );
          if (!span) throw new Error(`No item ${n}/${idx}`);
          const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
          let left = char;
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const { length } = node as Text;
            if (left <= length) return [node, left] as const;
            left -= length;
          }
          throw new Error(`No character ${char} in item ${n}/${idx}`);
        };
        const range = document.createRange();
        range.setStart(...point(from));
        range.setEnd(...point(to));
        const selection = document.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      },
      [from, to]
    );

  /** The name a tab shows for the note at `notePath`. */
  const noteTitle = (notePath: string) => path.basename(notePath, '.md');

  /** A pattern matching `text` whole, and nothing else. */
  const exactly = (text: string) =>
    new RegExp(`^${text.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&')}$`);

  /** Every tab header named `title`. */
  const tabHeader = (page: Page, title: string) =>
    page.locator('.workspace-tab-header').filter({
      has: page.locator('.workspace-tab-header-inner-title', {
        hasText: exactly(title),
      }),
    });

  /** The title of the active tab's header. */
  const activeTabTitle = (page: Page) =>
    page.locator(
      '.workspace-tabs.mod-active .workspace-tab-header.is-active .workspace-tab-header-inner-title'
    );

  /** Extract the paragraph carried over the page break, and its snippet's note. */
  async function extractAcrossPages(page: Page) {
    await pdfPage(page, 2).scrollIntoViewIfNeeded();
    await expect(textItem(page, 2, 3)).toBeAttached();
    await expect(textItem(page, 1, 9)).toBeAttached();
    await selectText(page, [1, 9, 0], [2, 3, 30]);
    await expect.poll(() => viewerSelection(page)).not.toBeNull();
    await page.getByRole('button', { name: 'Create snippet' }).click();
    await expect.poll(() => snippets(page)).toHaveLength(1);
    return (await snippets(page))[0].reference;
  }

  test('takes the highlight off when the snippet is undone', async () => {
    await importFixture(window);
    await beginReview(window);
    await extractAcrossPages(window);
    await expect(
      article(window).locator('.ir-snippet-highlight').first()
    ).toBeAttached();

    await executeCommandById(window, 'incremental-reading:undo');

    await expect.poll(() => snippets(window)).toHaveLength(0);
    await expect(article(window).locator('.ir-snippet-highlight')).toHaveCount(
      0
    );
    // Undone without Obsidian's offer to delete the PDF too
    await expect(window.locator('.modal-container')).toHaveCount(0);
  });

  test("highlights it in the PDF's own tab too, alongside the selection a link to it lights up, and after that is cleared", async () => {
    await importFixture(window);
    await beginReview(window);
    const reference = await extractAcrossPages(window);
    const [snippet] = await snippets(window);

    // Its source link opens the PDF on its page, with the selection lit up
    await window.evaluate(
      ([source, from]) => {
        const { app } = window as unknown as {
          app: {
            workspace: {
              openLinkText(
                link: string,
                from: string,
                newLeaf: 'tab'
              ): Promise<void>;
            };
          };
        };
        const link = source.slice(2, source.indexOf('|'));
        return app.workspace.openLinkText(link, from, 'tab');
      },
      [snippet.source as string, reference]
    );
    const tab = window.locator('.workspace-leaf.mod-active .pdf-container');
    const item9 = tab.locator(
      '.page[data-page-number="1"] .textLayer [data-idx="9"]'
    );
    const box = itemBoxes(tab, 1, 9).first();
    // Obsidian's own highlight rebuilds the item, beside the snippet's over it
    await expect(item9.locator('.mod-focused')).not.toHaveCount(0);
    await expect(box).toBeVisible();

    // A press on the page clears Obsidian's highlight, rebuilding the item again
    await tab
      .locator('.page[data-page-number="1"] .textLayer [data-idx="0"]')
      .click();
    await expect(item9.locator('.mod-focused')).toHaveCount(0);
    await expect(box).toBeVisible();
  });

  test("shows highlights in a PDF in a markdown highlight's color, unfaded by its text layer", async () => {
    await importFixture(window);
    await beginReview(window);
    await extractAcrossPages(window);
    const box = itemBoxes(article(window), 2, 3);
    await expect(box).toHaveCount(1);

    expect(await seenOverWhite(box)).toEqual(
      await seenOverWhite(box, 'var(--ir-snippet-highlight-color)')
    );
    // Not the white page, nor faded to nearly that
    expect(await seenOverWhite(box)).not.toEqual([255, 255, 255]);
    const alpha = await box.evaluate((el) => {
      let shown = Number(
        /,\s*([\d.]+)\)$/.exec(getComputedStyle(el).backgroundColor)?.[1] ?? 1
      );
      for (let up: Element | null = el; up; up = up.parentElement) {
        shown *= Number(getComputedStyle(up).opacity);
      }
      return shown;
    });
    expect(alpha).toBeGreaterThanOrEqual(0.15);
  });

  // #region THROUGH A ZOOM

  /**
   * Count, from now on, what the plugin's own code does in the page: each
   * run of a `MutationObserver` it makes (made from now on), and each text
   * range it measures. Told apart by the stack: Obsidian loads a plugin as
   * `plugin:<id>`.
   */
  const watchPluginWork = (page: Page) =>
    page.evaluate(() => {
      const w = window as unknown as {
        __irWork: { observerRuns: number; measures: number };
      };
      w.__irWork = { observerRuns: 0, measures: 0 };
      const ours = () =>
        /plugin:incremental-reading/.test(new Error().stack ?? '');
      // `window` here is the page's: the spec's own is shadowed only at run time
      const page = globalThis as unknown as {
        MutationObserver: typeof MutationObserver;
      };
      const Observer = page.MutationObserver;
      page.MutationObserver = class extends Observer {
        constructor(callback: MutationCallback) {
          super(
            ours()
              ? (records: MutationRecord[], observer: MutationObserver) => {
                  w.__irWork.observerRuns++;
                  callback(records, observer);
                }
              : callback
          );
        }
      };
      const { prototype } = Range;
      const measure = Object.getOwnPropertyDescriptor(
        prototype,
        'getClientRects'
      )!.value as (this: Range) => DOMRectList;
      prototype.getClientRects = function (this: Range) {
        if (ours()) w.__irWork.measures++;
        return measure.call(this) as DOMRectList;
      };
    });
  /** What {@link watchPluginWork} has counted since it last read. */
  const pluginWork = (page: Page) =>
    page.evaluate(() => {
      const w = window as unknown as {
        __irWork: { observerRuns: number; measures: number };
      };
      const work = { ...w.__irWork };
      w.__irWork.observerRuns = 0;
      w.__irWork.measures = 0;
      return work;
    });

  /**
   * Wait until every page of the review tab's PDF on screen is drawn at its
   * zoom: loaded, and its text layer shown again.
   */
  const settled = (page: Page) =>
    page.waitForFunction(() => {
      const root = document.querySelector('.ir-pdf-article')!;
      const view = root
        .querySelector('.pdf-viewer-container')!
        .getBoundingClientRect();
      const shown = Array.from(
        root.querySelectorAll<HTMLElement>('.page')
      ).filter((pageEl) => {
        const { top, bottom } = pageEl.getBoundingClientRect();
        return bottom > view.top && top < view.bottom;
      });
      return (
        shown.length > 0 &&
        shown.every(
          (pageEl) =>
            pageEl.dataset.loaded === 'true' &&
            pageEl.querySelector<HTMLElement>('.textLayer')?.hidden === false
        )
      );
    });

  /**
   * Run `zoom` and watch, every animation frame for 2s from just before it,
   * whether the highlight of `ref` in the review tab's PDF is on screen.
   * Returns how many frames it was not, of how many, and how wide page 1 was
   * before and after.
   */
  async function framesThroughZoom(
    page: Page,
    ref: string,
    zoom: () => Promise<void>
  ) {
    await page.evaluate((ref) => {
      const w = window as unknown as {
        __irFrames: Promise<{ frames: number; unseen: number }>;
      };
      const root = document.querySelector('.ir-pdf-article')!;
      const seen = () =>
        Array.from(
          root.querySelectorAll<HTMLElement>(
            `.ir-snippet-highlight[data-snippet-ref="${CSS.escape(ref)}"]`
          )
        ).some((box) => {
          const { width, height } = box.getBoundingClientRect();
          return (
            width > 0 &&
            height > 0 &&
            box.checkVisibility({
              opacityProperty: true,
              visibilityProperty: true,
            })
          );
        });
      w.__irFrames = (async () => {
        let frames = 0;
        let unseen = 0;
        const start = performance.now();
        while (performance.now() - start < 2000) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          frames++;
          if (!seen()) unseen++;
        }
        return { frames, unseen };
      })();
    }, ref);
    const before = (await pdfPage(page, 1).boundingBox())!.width;
    await zoom();
    const watched = await page.evaluate(
      () =>
        (
          window as unknown as {
            __irFrames: Promise<{ frames: number; unseen: number }>;
          }
        ).__irFrames
    );
    return {
      ...watched,
      before,
      after: (await pdfPage(page, 1).boundingBox())!.width,
    };
  }

  /** Expect `box` over the text of `item`: its middle inside the item's box. */
  async function expectOver(box: Locator, item: Locator) {
    const drawn = (await box.boundingBox())!;
    const line = (await item.boundingBox())!;
    const x = drawn.x + drawn.width / 2;
    const y = drawn.y + drawn.height / 2;
    expect(x).toBeGreaterThan(line.x);
    expect(x).toBeLessThan(line.x + line.width);
    expect(y).toBeGreaterThan(line.y);
    expect(y).toBeLessThan(line.y + line.height);
  }

  /** Import the fixture and review it, with a snippet over the first line. */
  async function reviewWithFirstLineSnippet(page: Page) {
    await importFixture(page);
    await beginReview(page);
    await expect(textItem(page, 1, 2)).toBeAttached();
    await selectText(page, [1, 2, 0], [1, 2, FIRST_LINE.length]);
    await expect.poll(() => viewerSelection(page)).not.toBeNull();
    await page.getByRole('button', { name: 'Create snippet' }).click();
    await expect.poll(() => snippets(page)).toHaveLength(1);
    const [snippet] = await snippets(page);
    await expect(itemBoxes(article(page), 1, 2)).toHaveCount(1);
    await page.evaluate(() => document.getSelection()!.removeAllRanges());
    await settled(page);
    return snippet.reference;
  }

  test('keeps a highlight on screen and over its text on every frame of a zoom from the toolbar, and of one with Ctrl and the wheel', async () => {
    const reference = await reviewWithFirstLineSnippet(window);

    const toolbar = await framesThroughZoom(window, reference, () =>
      article(window).locator('[aria-label="Zoom in"]').click()
    );
    expect(toolbar.after).toBeGreaterThan(toolbar.before);
    expect(toolbar.frames).toBeGreaterThan(0);
    expect(toolbar.unseen).toBe(0);
    await settled(window);
    await expectOver(itemBoxes(article(window), 1, 2), textItem(window, 1, 2));

    const page1 = (await pdfPage(window, 1).boundingBox())!;
    await window.mouse.move(page1.x + page1.width / 2, page1.y + 150);
    const wheel = await framesThroughZoom(window, reference, async () => {
      await window.keyboard.down('Control');
      await window.mouse.wheel(0, 100);
      await window.keyboard.up('Control');
    });
    expect(wheel.after).toBeLessThan(wheel.before);
    expect(wheel.frames).toBeGreaterThan(0);
    expect(wheel.unseen).toBe(0);
    await settled(window);
    await expectOver(itemBoxes(article(window), 1, 2), textItem(window, 1, 2));
  });

  test('does no work of its own on a zoom: runs nothing for a PDF with no highlights, and measures nothing for one with some', async () => {
    await importFixture(window);
    await watchPluginWork(window);
    await beginReview(window);
    await expect(textItem(window, 1, 2)).toBeAttached();
    await settled(window);
    await pluginWork(window);

    await article(window).locator('[aria-label="Zoom in"]').click();
    await settled(window);
    expect(await pluginWork(window)).toEqual({ observerRuns: 0, measures: 0 });

    // With a highlight, the boxes are measured once drawn, and not again
    await selectText(window, [1, 2, 0], [1, 2, FIRST_LINE.length]);
    await expect.poll(() => viewerSelection(window)).not.toBeNull();
    await window.getByRole('button', { name: 'Create snippet' }).click();
    await expect(itemBoxes(article(window), 1, 2)).toHaveCount(1);
    await window.evaluate(() => document.getSelection()!.removeAllRanges());
    await settled(window);
    expect((await pluginWork(window)).measures).toBeGreaterThan(0);

    await article(window).locator('[aria-label="Zoom out"]').click();
    await settled(window);
    const work = await pluginWork(window);
    // Its observer still sees the zoom's changes, as the instrument shows
    expect(work.observerRuns).toBeGreaterThan(0);
    expect(work.measures).toBe(0);
  });

  test('lets a drag with the mouse select through a highlighted line, opening nothing', async () => {
    const reference = await reviewWithFirstLineSnippet(window);
    const headers = window.locator('.workspace-tab-header');
    const tabs = await headers.count();
    const item = (await textItem(window, 1, 2).boundingBox())!;
    const y = item.y + item.height / 2;

    await window.mouse.move(item.x + 1, y);
    await window.mouse.down();
    await window.mouse.move(item.x + item.width / 2, y, { steps: 5 });
    await window.mouse.move(item.x + item.width - 1, y, { steps: 5 });
    await window.mouse.up();

    await expect
      .poll(() => window.evaluate(() => getSelection()?.toString() ?? ''))
      .toMatch(/^Incremental reading turns a long text/);
    // No tab for the snippet, nor any other
    await expect(tabHeader(window, noteTitle(reference))).toHaveCount(0);
    await expect(headers).toHaveCount(tabs);
  });

  // #endregion

  // #region IN THE PDF'S OWN TAB

  /** The PDF's own tab, active, as importing it from there leaves it. */
  const pdfTab = (page: Page) =>
    page.locator(
      '.workspace-leaf.mod-active .workspace-leaf-content[data-type="pdf"]'
    );
  const tabItem = (page: Page, n: number, idx: number) =>
    pdfTab(page).locator(
      `.page[data-page-number="${n}"] .textLayer [data-idx="${idx}"]`
    );

  /**
   * Select from `[page, idx, char]` to another such point in the active PDF
   * tab, as a script would: Obsidian snaps only pointer selections. By
   * character, in item spans whose text highlights may have split into
   * several nodes.
   */
  const selectInTab = (
    page: Page,
    from: [number, number, number],
    to: [number, number, number]
  ) =>
    page.evaluate(
      ([from, to]) => {
        const point = ([n, idx, char]: number[]) => {
          const span = document.querySelector(
            '.workspace-leaf.mod-active .workspace-leaf-content[data-type="pdf"] ' +
              `.page[data-page-number="${n}"] .textLayer [data-idx="${idx}"]`
          );
          if (!span) throw new Error(`No item ${n}/${idx}`);
          const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
          let left = char;
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const { length } = node as Text;
            if (left <= length) return [node, left] as const;
            left -= length;
          }
          throw new Error(`No character ${char} in item ${n}/${idx}`);
        };
        const range = document.createRange();
        range.setStart(...point(from));
        range.setEnd(...point(to));
        const selection = document.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      },
      [from, to]
    );

  /** Import the fixture from its own tab, and wait for the tab's action bar. */
  async function importInTab(page: Page) {
    await importFixture(page);
    await expect(pdfTab(page).locator('.ir-pdf-leaf-bar')).toBeVisible();
    await expect(tabItem(page, 1, 2)).toBeAttached();
  }

  test("extracts a snippet in the PDF's own tab from the command, as in review, leaving the PDF as it was", async () => {
    const pdfBytes = await fs.readFile(path.join(vaultPath, PDF_PATH));
    await importInTab(window);
    const notices = await watchNotices(window);

    await selectInTab(window, [1, 2, 0], [1, 2, FIRST_LINE.length]);
    // `selectionchange` is dispatched as a task, not synchronously
    await window.waitForTimeout(100);
    await executeCommandById(window, 'incremental-reading:extract-selection');

    await expect.poll(() => snippets(window)).toHaveLength(1);
    const [snippet] = await snippets(window);
    expect(snippet).toMatchObject({
      parent: await articleId(window),
      start_offset: 1_00002_00000,
      end_offset: 1_00002_00000 + FIRST_LINE.length,
      body: FIRST_LINE,
      source:
        `[[PDF fixture.pdf#page=1&selection=2,0,2,${FIRST_LINE.length}` +
        '|PDF fixture, page 1]]',
    });
    expect(await notices()).toEqual([
      expect.stringContaining(path.posix.basename(snippet.reference, '.md')),
    ]);
    // Highlighted in the tab, as one extracted in review is
    await expect(itemBoxes(pdfTab(window), 1, 2)).not.toHaveCount(0);
    expect(
      (await fs.readFile(path.join(vaultPath, PDF_PATH))).equals(pdfBytes)
    ).toBe(true);
    // No review tab was needed
    expect(
      await window.evaluate(
        (viewType) =>
          (window as unknown as { app: PageApp }).app.workspace.getLeavesOfType(
            viewType
          ).length,
        REVIEW_VIEW_TYPE
      )
    ).toBe(0);
  });

  test("makes a card in the PDF's own tab from the command picked in the palette by a click, though that moves the selection away", async () => {
    const pdfBytes = await fs.readFile(path.join(vaultPath, PDF_PATH));
    await importInTab(window);

    await selectInTab(window, [1, 2, 0], [1, 2, FIRST_LINE.length]);
    await window.waitForTimeout(100);
    await executeCommandById(window, 'command-palette:open');
    const palette = window.locator('.modal-container .prompt');
    await expect(palette).toBeVisible();
    await window.keyboard.type('Create spaced repetition card');
    await palette
      .locator('.suggestion-item', { hasText: 'Create spaced repetition card' })
      .first()
      .click();
    await expect(answerText(window)).toHaveText(FIRST_LINE);
    await selectAnswer(window, 'long text');
    await window.keyboard.press('Enter');

    await expect(answerText(window)).toHaveCount(0);
    await expect.poll(() => cards(window)).toHaveLength(1);
    const [card] = await cards(window);
    const [left, right] = CLOZE_DELIMITERS;
    expect(card).toMatchObject({
      parent: await articleId(window),
      body: FIRST_LINE.replace('long text', `${left} long text ${right}`),
      source:
        `[[PDF fixture.pdf#page=1&selection=2,0,2,${FIRST_LINE.length}` +
        '|PDF fixture, page 1]]',
    });
    expect(
      (await fs.readFile(path.join(vaultPath, PDF_PATH))).equals(pdfBytes)
    ).toBe(true);
  });

  test("asks for a selection first in the PDF's own tab with nothing selected, and makes nothing", async () => {
    await importInTab(window);
    const notices = await watchNotices(window);

    await executeCommandById(window, 'incremental-reading:extract-selection');
    await executeCommandById(window, 'incremental-reading:create-card');

    await expect
      .poll(notices)
      .toHaveLength(2);
    expect(await snippets(window)).toEqual([]);
    expect(await cards(window)).toEqual([]);
    await expect(answerText(window)).toHaveCount(0);
  });

  // #endregion

  // #region IN THE TAB OF A PDF THAT IS NO ARTICLE

  /** Highlights over the first line, in the active PDF tab. */
  const firstLineHighlights = (page: Page) => itemBoxes(pdfTab(page), 1, 2);

  /**
   * In the fixture's own tab, open and no article, make a card of the first
   * line from the command picked in the palette by a click, with "long text"
   * its answer, and then a snippet of it by the command's hotkey path.
   */
  async function snipAndCardInPlainTab(page: Page) {
    await openFileInActiveLeaf(page, PDF_PATH);
    await expect(tabItem(page, 1, 2)).toBeAttached();

    await selectInTab(page, [1, 2, 0], [1, 2, FIRST_LINE.length]);
    // `selectionchange` is dispatched as a task, not synchronously
    await page.waitForTimeout(100);
    await executeCommandById(page, 'command-palette:open');
    const palette = page.locator('.modal-container .prompt');
    await expect(palette).toBeVisible();
    await page.keyboard.type('Create spaced repetition card');
    await palette
      .locator('.suggestion-item', { hasText: 'Create spaced repetition card' })
      .first()
      .click();
    await expect(answerText(page)).toHaveText(FIRST_LINE);
    await selectAnswer(page, 'long text');
    await page.keyboard.press('Enter');
    await expect(answerText(page)).toHaveCount(0);
    await expect.poll(() => cards(page)).toHaveLength(1);

    await selectInTab(page, [1, 2, 0], [1, 2, FIRST_LINE.length]);
    await page.waitForTimeout(100);
    await executeCommandById(page, 'incremental-reading:extract-selection');
    await expect.poll(() => snippets(page)).toHaveLength(1);
  }

  /**
   * Follow the `source` link of the note at `notePath` into a new tab, as a
   * click on it does. Read from the note as it is on disk.
   */
  const followSourceLink = (page: Page, notePath: string) =>
    page.evaluate(async (from) => {
      const { app } = window as unknown as {
        app: {
          vault: {
            getFileByPath(path: string): unknown;
            read(file: unknown): Promise<string>;
          };
          workspace: {
            openLinkText(
              link: string,
              from: string,
              newLeaf: 'tab'
            ): Promise<void>;
          };
        };
      };
      const note = await app.vault.read(app.vault.getFileByPath(from));
      const link = /^source: "?\[\[([^|\]]+)/m.exec(note)?.[1];
      if (!link) throw new Error(`No source link in ${from}`);
      return app.workspace.openLinkText(link, from, 'tab');
    }, notePath);

  test('gives the snippet and card to a copy imported from the PDF, pointing their links at it, and the original loses the highlight', async () => {
    await snipAndCardInPlainTab(window);
    await expect(firstLineHighlights(window)).not.toHaveCount(0);
    const [snippet] = await snippets(window);
    const [card] = await cards(window);

    await window.evaluate(() => {
      const { app } = window as unknown as {
        app: {
          plugins: {
            plugins: Record<
              string,
              { toggleAdvancedCommands(enable: boolean): void }
            >;
          };
        };
      };
      app.plugins.plugins['incremental-reading'].toggleAdvancedCommands(true);
    });
    const notices = await watchNotices(window);
    await executeCommandById(window, 'incremental-reading:import-article-copy');

    // Said once both are handed over and their links rewritten
    await expect
      .poll(notices)
      .toContainEqual(expect.stringContaining('"PDF fixture"'));
    // The original's tab is still the active one
    await expect(firstLineHighlights(window)).toHaveCount(0);
    // Each one's link opens the copy, highlighted as the original was
    for (const reference of [snippet.reference, card.reference]) {
      await followSourceLink(window, reference);
      await expect(activeTabTitle(window)).toHaveText('PDF fixture');
      await expect(firstLineHighlights(window)).not.toHaveCount(0);
    }
  });

  test('keeps the snippet and card linked to the PDF, highlighted and with their context, when it is renamed and Obsidian is told not to update links', async () => {
    await snipAndCardInPlainTab(window);
    const [snippet] = await snippets(window);
    await askBeforeUpdatingLinks(window);
    const renamed = 'sources/Renamed fixture.pdf';

    await renameDecliningLinkUpdate(window, PDF_PATH, renamed);

    // Read again, by their links, in a tab opened on it afresh
    await openFileInActiveLeaf(window, 'sources/Security Principles.md');
    await openFileInActiveLeaf(window, renamed);
    await expect(firstLineHighlights(window)).not.toHaveCount(0);

    await goToContextFrom(window, snippet.reference);
    await expect(activeTabTitle(window)).toHaveText('Renamed fixture');
    await expect(pdfTab(window)).toBeVisible();
  });

  // #endregion

  // #region CARD HIGHLIGHTS

  /** The card highlight boxes over item `idx` of page `n` of the PDF in `root`. */
  const cardBoxes = (root: Locator, n: number, idx: number) =>
    itemBoxes(root, n, idx, 'ir-card-highlight');
  /** The snippet highlight boxes there: a card's box is a snippet box too. */
  const snippetBoxes = (root: Locator, n: number, idx: number) =>
    itemBoxes(root, n, idx).and(root.locator(':not(.ir-card-highlight)'));

  /**
   * Make a card in review of the text from `[page, idx, char]` to another
   * such point, with `answer` its answer, and wait until the metadata cache
   * has its `source` link (a race seen at 5 workers). Returns its row.
   */
  async function cardInReview(
    page: Page,
    from: [number, number, number],
    to: [number, number, number],
    answer: string
  ) {
    const before = (await cards(page)).map((card) => card.reference);
    await selectChars(page, from, to);
    await expect.poll(() => viewerSelection(page)).not.toBeNull();
    await actionBar(page).getByRole('button', { name: 'Create card' }).click();
    await expect(answerText(page)).toBeVisible();
    await selectAnswer(page, answer);
    await page.keyboard.press('Enter');
    await expect(answerText(page)).toHaveCount(0);
    await expect
      .poll(async () =>
        (await cards(page)).filter(
          (card) => !before.includes(card.reference) && card.source
        )
      )
      .toHaveLength(1);
    return (await cards(page)).find(
      (card) => !before.includes(card.reference)
    )!;
  }

  test('highlights a card made in review at once, tinted unlike a snippet beside it, and a click on it opens the card', async () => {
    await importFixture(window);
    await beginReview(window);
    await expect(textItem(window, 1, 9)).toBeAttached();
    await selectChars(window, [1, 9, 2], [1, 9, 12]);
    await expect.poll(() => viewerSelection(window)).not.toBeNull();
    await window.getByRole('button', { name: 'Create snippet' }).click();
    const snippetBox = snippetBoxes(article(window), 1, 9);
    await expect(snippetBox).toBeVisible();

    await cardInReview(
      window,
      [1, 2, 0],
      [1, 2, FIRST_LINE.length],
      'long text'
    );

    const cardBox = cardBoxes(article(window), 1, 2);
    await expect(cardBox).toBeVisible();
    await expectOver(cardBox, textItem(window, 1, 2));
    // The snippet's line keeps its own highlight, and no card's
    await expect(snippetBox).toBeVisible();
    await expect(cardBoxes(article(window), 1, 9)).toHaveCount(0);
    expect(await seenOverWhite(cardBox)).not.toEqual([255, 255, 255]);
    expect(await seenOverWhite(snippetBox)).not.toEqual(
      await seenOverWhite(cardBox)
    );

    await clickOn(window, cardBox);
    // The card in review, its answer hidden. Read off the pane, as the tab's
    // title names the plugin over every card
    const cardViewer = window.locator(
      `.workspace-leaf.mod-active [data-type="${REVIEW_VIEW_TYPE}"] .ir-card-viewer`
    );
    await expect(cardViewer).toContainText('Incremental reading turns a');
    await expect(cardViewer).toContainText('into a series of short reviews.');
    await expect(cardViewer.locator('.ir-hidden-answer')).toBeVisible();
    await expect(cardViewer).not.toContainText('long text');
  });

  test("takes a card's highlight off when it is undone, and when its note is deleted", async () => {
    await importFixture(window);
    await beginReview(window);
    await expect(textItem(window, 1, 2)).toBeAttached();
    const line: [[number, number, number], [number, number, number]] = [
      [1, 2, 0],
      [1, 2, FIRST_LINE.length],
    ];

    await cardInReview(window, ...line, 'long text');
    await expect(
      itemBoxes(article(window), 1, 2, 'ir-card-highlight')
    ).not.toHaveCount(0);
    await actionBar(window).locator('#undo-button').click();
    await expect(
      itemBoxes(article(window), 1, 2, 'ir-card-highlight')
    ).toHaveCount(0);

    const card = await cardInReview(window, ...line, 'long text');
    await expect(
      itemBoxes(article(window), 1, 2, 'ir-card-highlight')
    ).not.toHaveCount(0);
    await window.evaluate(async (ref) => {
      const { app } = window as unknown as {
        app: PageApp & {
          fileManager: { trashFile(file: unknown): Promise<void> };
        };
      };
      await app.fileManager.trashFile(app.vault.getFileByPath(ref));
    }, card.reference);
    await expect(
      itemBoxes(article(window), 1, 2, 'ir-card-highlight')
    ).toHaveCount(0);
  });

  test('highlights a card made before cards had highlights, from its note and row alone', async () => {
    await importFixture(window);
    const id = await articleId(window);
    const reference = 'Old card.md';
    await window.evaluate(
      async ({ reference, source }) => {
        const { app } = window as unknown as {
          app: PageApp & {
            vault: { create(path: string, data: string): Promise<unknown> };
          };
        };
        await app.vault.create(
          reference,
          [
            '---',
            'ir-id: old-card',
            'tags: ir-card',
            `source: "${source}"`,
            '---',
            'Incremental reading turns a {{ long text }} into a series of short reviews.',
          ].join('\n')
        );
      },
      {
        reference,
        source: `[[PDF fixture.pdf#page=1&selection=2,0,2,${FIRST_LINE.length}|PDF fixture, page 1]]`,
      }
    );
    await expect
      .poll(() =>
        window.evaluate((ref) => {
          const { app } = window as unknown as {
            app: PageApp & {
              metadataCache: {
                getFileCache(file: unknown): {
                  frontmatter?: Record<string, unknown>;
                } | null;
              };
            };
          };
          const file = app.vault.getFileByPath(ref);
          return file
            ? (app.metadataCache.getFileCache(file)?.frontmatter?.source ??
                null)
            : null;
        }, reference)
      )
      .not.toBeNull();
    await window.evaluate(
      async ({ reference, id }) => {
        const { app } = window as unknown as {
          app: {
            plugins: {
              plugins: Record<
                string,
                {
                  reviewManager: {
                    repo: {
                      mutate(sql: string, params?: unknown[]): Promise<unknown>;
                    };
                  };
                }
              >;
            };
          };
        };
        const { repo } =
          app.plugins.plugins['incremental-reading'].reviewManager;
        await repo.mutate(
          `INSERT INTO srs_card (id, reference, parent, created_at, due,
             stability, difficulty, elapsed_days, scheduled_days, state)
           VALUES ('old-card', $1, $2, 0, $3, 0, 0, 0, 0, 0)`,
          [reference, id, Date.now() + 86_400_000]
        );
      },
      { reference, id }
    );

    await beginReview(window);
    const box = cardBoxes(article(window), 1, 2);
    await expect(box).toBeVisible();
    await expectOver(box, textItem(window, 1, 2));
  });

  test('highlights a card made in the tab of a PDF that is no article, there, and keeps it once the PDF is imported', async () => {
    await snipAndCardInPlainTab(window);
    const bar = pdfTab(window).locator('.ir-pdf-leaf-bar');
    await expect(bar).toHaveCount(0);

    // The snippet was made of the very same line: both are there, the card in
    // its own tint
    const cardBox = cardBoxes(pdfTab(window), 1, 2);
    const snippetBox = snippetBoxes(pdfTab(window), 1, 2);
    await expect(cardBox).toBeVisible();
    await expect(snippetBox).toBeVisible();
    const tint = await seenOverWhite(cardBox);
    expect(tint).not.toEqual(await seenOverWhite(snippetBox));

    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    // An article now: its tab has an article's action bar
    await expect(bar).toBeVisible();
    await expect(cardBox).toBeVisible();
    expect(await seenOverWhite(cardBox)).toEqual(tint);
  });

  // #endregion

  // #region HOVER

  /** The middle of `box` on screen. */
  async function middleOf(box: Locator) {
    const { x, y, width, height } = (await box.boundingBox())!;
    return { x: x + width / 2, y: y + height / 2 };
  }

  type Point = { x: number; y: number };

  /** The cursor the mouse shows at `point`: that of what is on top there. */
  const cursorAt = (page: Page, { x, y }: Point) =>
    page.evaluate(
      ([x, y]) => getComputedStyle(document.elementFromPoint(x, y)!).cursor,
      [x, y]
    );

  /** Every highlight box marked as under the mouse, which rings it. */
  const hovered = (page: Page) => page.locator('.ir-hovered');

  /** The ring `box` shows: its box shadow. */
  const ringOf = (box: Locator) =>
    box.evaluate((el) => getComputedStyle(el).boxShadow);

  /** Expect the mouse at `point` on `box`: a pointer, and that box alone ringed. */
  async function expectHovering(page: Page, box: Locator, point: Point) {
    await expect.poll(() => cursorAt(page, point)).toBe('pointer');
    await expect(hovered(page)).toHaveCount(1);
    await expect(box).toHaveClass(/\bir-hovered\b/);
    // A colour that fails to resolve leaves no ring at all
    await expect(box).not.toHaveCSS('box-shadow', 'none');
  }

  /** Expect the mouse at `point` on plain text: a text cursor, and no ring. */
  async function expectOnText(page: Page, point: Point) {
    await expect(hovered(page)).toHaveCount(0);
    await expect.poll(() => cursorAt(page, point)).toBe('text');
  }

  test("rings the highlight under the mouse with a pointer, a card's in the card colour, in review and in the PDF's tab, and clears both off it", async () => {
    await importFixture(window);
    await beginReview(window);
    await expect(textItem(window, 1, 9)).toBeAttached();
    await selectChars(window, [1, 9, 2], [1, 9, 12]);
    await expect.poll(() => viewerSelection(window)).not.toBeNull();
    await window.getByRole('button', { name: 'Create snippet' }).click();
    const snippetBox = snippetBoxes(article(window), 1, 9);
    await expect(snippetBox).toBeVisible();
    await cardInReview(
      window,
      [1, 2, 0],
      [1, 2, FIRST_LINE.length],
      'long text'
    );
    await window.evaluate(() => document.getSelection()!.removeAllRanges());
    const cardBox = cardBoxes(article(window), 1, 2);
    await expect(cardBox).toBeVisible();

    const onSnippet = await middleOf(snippetBox);
    await window.mouse.move(onSnippet.x, onSnippet.y);
    await expectHovering(window, snippetBox, onSnippet);
    const snippetRing = await ringOf(snippetBox);

    const onCard = await middleOf(cardBox);
    await window.mouse.move(onCard.x, onCard.y);
    await expectHovering(window, cardBox, onCard);
    expect(await ringOf(cardBox)).not.toBe(snippetRing);

    // The end of item 9, past the snippet
    const item = (await textItem(window, 1, 9).boundingBox())!;
    const box = (await snippetBox.boundingBox())!;
    const plain = { x: item.x + item.width - 2, y: onSnippet.y };
    expect(plain.x).toBeGreaterThan(box.x + box.width);
    await window.mouse.move(plain.x, plain.y);
    await expectOnText(window, plain);

    // The PDF's own tab
    await window
      .locator('.workspace-tab-header', { hasText: 'PDF fixture' })
      .first()
      .click();
    const tab = window.locator('.workspace-leaf.mod-active .pdf-container');
    const tabBox = snippetBoxes(tab, 1, 9);
    await expect(tabBox).toBeVisible();
    const onTabSnippet = await middleOf(tabBox);
    await window.mouse.move(onTabSnippet.x, onTabSnippet.y);
    await expectHovering(window, tabBox, onTabSnippet);
    expect(await ringOf(tabBox)).toBe(snippetRing);
    // Out of the window's content, past the tab's header
    await window.mouse.move(onTabSnippet.x, 5);
    await expectOnText(window, onTabSnippet);
  });

  test('rings the box now under the mouse after a zoom, the mouse at rest or moving', async () => {
    await reviewWithFirstLineSnippet(window);
    const box = itemBoxes(article(window), 1, 2);
    const at = await middleOf(box);
    await window.mouse.move(at.x, at.y);
    await expectHovering(window, box, at);

    /** Whether `point` is over the box now, as the page lays it out. */
    const overBox = async ({ x, y }: Point) => {
      const now = (await box.boundingBox())!;
      return (
        x >= now.x &&
        x < now.x + now.width &&
        y >= now.y &&
        y < now.y + now.height
      );
    };

    // At rest at the box's far end: zoomed out by a click the page makes
    // itself, the mouse never moving, the box shrinks out from under it
    const before = (await box.boundingBox())!;
    const end = { x: before.x + before.width - 2, y: at.y };
    await window.mouse.move(end.x, end.y);
    await expectHovering(window, box, end);
    await article(window)
      .locator('[aria-label="Zoom out"]')
      .evaluate((button) => (button as HTMLElement).click());
    await settled(window);
    await expect.poll(() => overBox(end)).toBe(false);
    await expect(hovered(window)).toHaveCount(0);

    // Moving: from the toolbar, then onto the box where it is now, and past
    // its end
    await article(window).locator('[aria-label="Zoom in"]').click();
    await settled(window);
    const middle = await middleOf(box);
    await window.mouse.move(middle.x, middle.y);
    await expectHovering(window, box, middle);
    const now = (await box.boundingBox())!;
    const past = { x: now.x + now.width + 4, y: middle.y };
    await window.mouse.move(past.x, past.y);
    await expect(hovered(window)).toHaveCount(0);
  });

  /**
   * Count and time, from now on, the plugin's own hover work in the page:
   * each `pointermove` listener it adds and each run of one, each frame it
   * asks for, and each `elementFromPoint` it calls; and the frames the page
   * paints (`ticks`). Told apart by the stack: Obsidian loads a plugin as
   * `plugin:<id>`.
   */
  const watchHoverWork = (page: Page) =>
    page.evaluate(() => {
      type Work = {
        listeners: number;
        moves: number;
        moveMs: number;
        frames: number;
        frameMs: number;
        lookups: number;
        ticks: number;
      };
      const w = window as unknown as { __irHover: Work };
      w.__irHover = {
        listeners: 0,
        moves: 0,
        moveMs: 0,
        frames: 0,
        frameMs: 0,
        lookups: 0,
        ticks: 0,
      };
      const ours = () =>
        /plugin:incremental-reading/.test(new Error().stack ?? '');
      const timed = new WeakMap<object, EventListener>();
      type Listen = (
        this: EventTarget,
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions
      ) => void;
      const { prototype } = EventTarget;
      const original = (name: string) =>
        Object.getOwnPropertyDescriptor(prototype, name)!.value as Listen;
      const add = original('addEventListener');
      const remove = original('removeEventListener');
      prototype.addEventListener = function (
        this: EventTarget,
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions
      ) {
        // On a PDF viewer, or what holds one: the review screen's own
        // components listen too
        if (
          typeof listener === 'function' &&
          type === 'pointermove' &&
          this instanceof Element &&
          (this.closest('.pdfViewer') || this.querySelector('.pdfViewer')) &&
          ours()
        ) {
          w.__irHover.listeners++;
          const wrapped: EventListener = (evt) => {
            const start = performance.now();
            listener.call(this, evt);
            w.__irHover.moveMs += performance.now() - start;
            w.__irHover.moves++;
          };
          timed.set(listener, wrapped);
          add.call(this, type, wrapped, options);
          return;
        }
        add.call(this, type, listener, options);
      };
      prototype.removeEventListener = function (
        this: EventTarget,
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions
      ) {
        const wrapped = listener && timed.get(listener);
        remove.call(this, type, wrapped ?? listener, options);
      };
      // `window` here is the page's: the spec's own is shadowed only at run time
      const page = globalThis as unknown as {
        requestAnimationFrame: (cb: FrameRequestCallback) => number;
      };
      const frame = page.requestAnimationFrame;
      const request = (cb: FrameRequestCallback) =>
        frame.call(page, cb) as number;
      const tick = () => {
        w.__irHover.ticks++;
        request(tick);
      };
      request(tick);
      page.requestAnimationFrame = (cb: FrameRequestCallback) =>
        request(
          ours()
            ? (time: number) => {
                const start = performance.now();
                cb(time);
                w.__irHover.frameMs += performance.now() - start;
                w.__irHover.frames++;
              }
            : cb
        );
      const lookup = Object.getOwnPropertyDescriptor(
        Document.prototype,
        'elementFromPoint'
      )!.value as (this: Document, x: number, y: number) => Element | null;
      Document.prototype.elementFromPoint = function (
        this: Document,
        x: number,
        y: number
      ) {
        if (ours()) w.__irHover.lookups++;
        return lookup.call(this, x, y) as Element | null;
      };
    });
  /** What {@link watchHoverWork} has counted since it last read. */
  const hoverWork = (page: Page) =>
    page.evaluate(() => {
      const w = window as unknown as {
        __irHover: Record<string, number>;
      };
      const work = { ...w.__irHover };
      for (const key of Object.keys(w.__irHover)) w.__irHover[key] = 0;
      return work;
    });

  /** Sweep the mouse over page 1 of the review tab's PDF, `steps` moves. */
  async function sweep(page: Page, steps: number) {
    const pageBox = (await pdfPage(page, 1).boundingBox())!;
    const top = Math.max(pageBox.y + 20, 120);
    await page.mouse.move(pageBox.x + 20, top);
    await page.mouse.move(
      pageBox.x + pageBox.width - 20,
      Math.min(pageBox.y + pageBox.height - 20, 700),
      { steps }
    );
  }

  test('does no hover work on a PDF with no highlights, and on one with some looks at most once a frame', async () => {
    await importFixture(window);
    await watchHoverWork(window);
    await beginReview(window);
    await expect(textItem(window, 1, 2)).toBeAttached();
    await settled(window);
    expect((await hoverWork(window)).listeners).toBe(0);

    await sweep(window, 60);
    expect(await hoverWork(window)).toMatchObject({
      listeners: 0,
      moves: 0,
      moveMs: 0,
      frames: 0,
      frameMs: 0,
      lookups: 0,
    });

    await selectText(window, [1, 2, 0], [1, 2, FIRST_LINE.length]);
    await expect.poll(() => viewerSelection(window)).not.toBeNull();
    await window.getByRole('button', { name: 'Create snippet' }).click();
    await expect(itemBoxes(article(window), 1, 2)).toHaveCount(1);
    await window.evaluate(() => document.getSelection()!.removeAllRanges());
    await settled(window);
    expect((await hoverWork(window)).listeners).toBeGreaterThan(0);

    await sweep(window, 60);
    // The last frame asked for
    await window.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(resolve))
    );
    const work = await hoverWork(window);
    expect(work.moves).toBeGreaterThanOrEqual(60);
    expect(work.lookups).toBeGreaterThan(0);
    // At most one look a frame painted, the last maybe still to come
    expect(work.lookups).toBeLessThanOrEqual(work.ticks + 1);
    expect(work.lookups).toBeLessThanOrEqual(work.moves);
    test.info().annotations.push({
      type: 'hover cost',
      description: JSON.stringify({
        ...work,
        msPerMove: work.moveMs / work.moves,
        msPerFrame: work.frameMs / work.frames,
      }),
    });
    console.log('hover cost', JSON.stringify(work));
  });

  // #endregion
});
