import {
  ARTICLE_DIRECTORY,
  CLOZE_DELIMITERS,
  DATA_DIRECTORY,
} from '#/lib/constants';
import { Markdown } from '#/lib/Markdown';
import { PDF_PAGE_STRIDE } from '#/lib/pdf/position';
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
  expectPlainText,
  finalizeArticleImport,
  openFileInActiveLeaf,
  pendingSaves,
  readMarkdown,
  renameDecliningLinkUpdate,
  REVIEW_VIEW_TYPE,
  setDefaultEditingMode,
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
const PDF_PATH = 'sources/PDF fixture.pdf';
/** Its one-page sibling with no text layer. */
const NO_TEXT_PDF_PATH = 'sources/PDF fixture - no text.pdf';
/** Its sibling whose text is Markdown, Obsidian syntax and a Templater command. */
const HOSTILE_PDF_PATH = 'sources/PDF fixture - hostile.pdf';
/** Its sibling whose one line holds a tab and a right-to-left override. */
const CONTROLS_PDF_PATH = 'sources/PDF fixture - controls.pdf';
/** That line, as the PDF reads. */
const CONTROLS_LINE = 'Tabbed\there report\u202efdp.exe';
/** That line as it shows, without the override: what a note takes of it. */
const CONTROLS_TEXT = 'Tabbed\there reportfdp.exe';
/**
 * The line after it, as the PDF reads. It shows as "Flag Report", and its
 * ToUnicode CMap reads a tag sequence spelling an instruction after the "g",
 * and a variation selector after "p" and after "o". Obsidian's pdf.js (as of
 * 1.13.7) drops a glyph whose text holds a tag character, its "g" with it, so
 * only the selectors come through.
 */
const HIDDEN_LINE = `Fla Rep\ufe00o${String.fromCodePoint(0xe0100)}rt`;
/** The hostile fixture's paragraphs, as the PDF reads. */
const HOSTILE_PARAGRAPHS = [
  '# Heading #ir-card #ir-text-snippet ![[Secret note]] ' +
    '![t](https://e.x/t.png) [[Note|alias]] [link](https://e.x/) ' +
    '<img src=x onerror=alert(1)> &amp; (} cloze {) $x^2$ `code` ' +
    '%%hidden%% ==mark== ~~del~~ *em* _u_ {{legacy}} [^1] ^blockid',
  '> quoted -- a callout? [!note] | table | \\ backslash',
  '--- 1. a list - item + more',
  '<%* app.vault.create("Pwned.md", "") %> a_b_c costs $5, AT&T, C# and x < 5',
];

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
            pendingSaveCount: number;
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

/** The review tab's keymap scope, and whether it is its PDF viewer's. */
const reviewScope = (page: Page) =>
  page.evaluate((viewType) => {
    const { app } = window as unknown as { app: PageApp };
    const { view } = app.workspace.getLeavesOfType(viewType)[0];
    return {
      hasViewer: view.pdfViewer !== null,
      isViewerScope: !!view.pdfViewer && view.scope === view.pdfViewer.scope,
      hasScope: view.scope !== null,
    };
  }, REVIEW_VIEW_TYPE);

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
    expect(await reviewScope(window)).toEqual({
      hasViewer: true,
      isViewerScope: true,
      hasScope: true,
    });

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
    expect(await reviewScope(window)).toEqual({
      hasViewer: false,
      isViewerScope: false,
      hasScope: false,
    });
  });

  test('loads an item that came up while its tab was hidden, once shown', async () => {
    await importFixture(window);
    await executeCommandById(window, 'incremental-reading:learn');
    await expect(window.locator('css=#begin-review-button')).toBeVisible();

    // Another tab in front, then review moves onto the PDF behind it
    await window.evaluate(async (notePath) => {
      const { app } = window as unknown as { app: PageApp };
      await app.workspace
        .getLeaf('tab')
        .openFile(app.vault.getFileByPath(notePath));
      app.plugins.plugins['incremental-reading'].store.dispatch({
        type: 'page/setPage',
        payload: 'review',
      });
    }, 'sources/Security Principles.md');
    await expect(article(window)).toBeAttached();
    await expect(article(window)).toBeHidden();

    await window
      .locator(`.workspace-tab-header[data-type="${REVIEW_VIEW_TYPE}"]`)
      .click();

    await expect(pdfPage(window, 1).locator('.textLayer')).toContainText(
      'Incremental reading turns a long text'
    );
  });

  test('reloads it when the file changes on disk, at its new path too', async () => {
    await importFixture(window);
    await beginReview(window);
    await expect(article(window).locator('.page')).toHaveCount(3);

    // Renamed while on screen: the viewer stays, and keeps following the file
    const renamed = 'sources/Renamed fixture.pdf';
    await window.evaluate(
      async ([from, to]) => {
        const { app } = window as unknown as { app: PageApp };
        await app.fileManager.renameFile(app.vault.getFileByPath(from), to);
      },
      [PDF_PATH, renamed]
    );
    await expect(article(window).locator('.page')).toHaveCount(3);

    await fs.copyFile(
      path.join(vaultPath, NO_TEXT_PDF_PATH),
      path.join(vaultPath, renamed)
    );

    await expect(article(window).locator('.page')).toHaveCount(1);
  });

  test("falls back to opening it in a PDF tab when Obsidian's viewer can't be had", async () => {
    await importFixture(window);
    // Simulates an Obsidian whose PDF internals changed shape
    await window.evaluate(() => {
      const { app } = window as unknown as { app: PageApp };
      app.embedRegistry.embedByExtension.pdf = () => ({});
    });

    await beginReview(window);

    await expect(placeholder(window)).toContainText('PDF fixture.pdf');
    await expect(
      placeholder(window).getByRole('button', { name: 'Open in PDF tab' })
    ).toBeVisible();
    await expect(article(window)).toHaveCount(0);
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
  /** A markdown article to switch to and back from. */
  const NOTE_PATH = 'sources/Security Principles.md';

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

  /** The PDF's saved `scroll_top`, and whether the database is on disk. */
  const saved = (page: Page) =>
    page.evaluate((ref) => {
      const { app } = window as unknown as { app: PageApp };
      const { repo } = app.plugins.plugins['incremental-reading'].reviewManager;
      const [row] = repo.query(
        'SELECT scroll_top FROM article WHERE reference = $1',
        [ref]
      );
      return {
        scrollTop: Number(row?.scroll_top ?? 0),
        pendingSaves: repo.pendingSaveCount,
      };
    }, PDF_PATH);

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

  /**
   * Where the top edge of the review tab's PDF view is: the page there, and
   * how far down that page it is as a fraction of the page's height, which
   * reads the same at every zoom. `null` until a page is laid out.
   */
  const readingPosition = (page: Page) =>
    page.evaluate(() => {
      const container = document.querySelector(
        '.ir-pdf-article .pdf-viewer-container'
      );
      if (!container) return null;
      const edge = container.getBoundingClientRect().top;
      for (const el of container.querySelectorAll<HTMLElement>('.page')) {
        const rect = el.getBoundingClientRect();
        if (rect.height > 0 && rect.bottom > edge) {
          return {
            page: Number(el.dataset.pageNumber),
            fraction: (edge - rect.top) / rect.height,
          };
        }
      }
      return null;
    });

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

  /** Expect the view at `expected`, give or take `within` of a page. */
  async function expectAt(
    page: Page,
    expected: { page: number; fraction: number },
    within = 0.02
  ) {
    await expect
      .poll(async () => {
        const at = await readingPosition(page);
        return (
          at !== null &&
          at.page === expected.page &&
          Math.abs(at.fraction - expected.fraction) < within
        );
      })
      .toBe(true);
  }

  test('reopens where its reader stopped: across items, tabs, reloads and restarts, at any zoom', async () => {
    await importFixture(window);
    await openFileInActiveLeaf(window, NOTE_PATH);
    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    const pdfId = await articleId(window, PDF_PATH);
    const noteId = await articleId(window, NOTE_PATH);

    await showItem(window, pdfId);
    await expect(article(window).locator('.page')).toHaveCount(3);
    await expect(pdfPage(window, 1).locator('.textLayer')).toContainText(
      'Incremental reading turns a long text'
    );
    expect((await saved(window)).scrollTop).toBe(0);

    // Zoomed in, then read a quarter of the way into page 3
    const widthBefore = (await pdfPage(window, 1).boundingBox())!.width;
    await article(window).locator('[aria-label="Zoom in"]').click();
    await expect
      .poll(async () => (await pdfPage(window, 1).boundingBox())!.width)
      .toBeGreaterThan(widthBefore);
    await scrollInto(window, 3, 0.25);
    const stopped = { page: 3, fraction: 0.25 };
    await expectAt(window, stopped);
    await expect
      .poll(async () =>
        Math.floor((await saved(window)).scrollTop / PDF_PAGE_STRIDE)
      )
      .toBe(3);
    const savedAtStop = (await saved(window)).scrollTop;

    // Another item, then back, twice. Coming back is no move: what it saves,
    // if anything, is what was saved, or every visit would creep the position
    for (let visit = 0; visit < 2; visit++) {
      await showItem(window, noteId);
      await expect(article(window)).toHaveCount(0);
      await showItem(window, pdfId);
      await expectAt(window, stopped);
      // Longer than the save delay: anything it was going to save is saved
      await window.waitForTimeout(1000);
      expect((await saved(window)).scrollTop).toBe(savedAtStop);
    }

    // Another tab in front, then back: nothing moves, nothing is saved over
    await window.evaluate(async (notePath) => {
      const { app } = window as unknown as { app: PageApp };
      await app.workspace
        .getLeaf('tab')
        .openFile(app.vault.getFileByPath(notePath));
    }, NOTE_PATH);
    await expect(article(window)).toBeHidden();
    await window
      .locator(`.workspace-tab-header[data-type="${REVIEW_VIEW_TYPE}"]`)
      .click();
    await expect(article(window)).toBeVisible();
    await expectAt(window, stopped);
    await window.waitForTimeout(1000);
    await expectAt(window, stopped);
    expect((await saved(window)).scrollTop).toBe(savedAtStop);

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
    await expectAt(window, stopped);

    // Quit, with the position saved to disk, and start again
    await expect.poll(async () => (await saved(window)).pendingSaves).toBe(0);
    await closeElectron(app);
    app = await launchElectron(vaultPath);
    window = await openVault(app, vaultPath);
    // Obsidian reopens the review tab while it boots, at whatever size the
    // window has (CI's small screens): this resizes it after it has opened
    await window.setViewportSize({ width: 1280, height: 800 });

    await showItem(window, pdfId);
    await expectAt(window, stopped, 0.005);
    await window.waitForTimeout(1000);
    await expectAt(window, stopped, 0.005);
    expect((await saved(window)).scrollTop).toBe(savedAtStop);
  });

  test('holds its place through resizes of the window and the sidebar, at any zoom, saving nothing for them', async () => {
    await importFixture(window);
    await openFileInActiveLeaf(window, NOTE_PATH);
    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    const pdfId = await articleId(window, PDF_PATH);
    const noteId = await articleId(window, NOTE_PATH);
    await window.setViewportSize({ width: 1024, height: 650 });
    await showItem(window, pdfId);
    await expect(article(window).locator('.page')).toHaveCount(3);
    await expect(pdfPage(window, 1).locator('.textLayer')).toContainText(
      'Incremental reading turns a long text'
    );

    await scrollInto(window, 3, 0.25);
    const stopped = { page: 3, fraction: 0.25 };
    await expectAt(window, stopped, 0.005);
    await expect
      .poll(async () =>
        Math.floor((await saved(window)).scrollTop / PDF_PAGE_STRIDE)
      )
      .toBe(3);
    let savedAtStop = (await saved(window)).scrollTop;

    const pageWidth = async () =>
      (await pdfPage(window, 3).boundingBox())!.width;
    /**
     * Do `resize`, which re-fits the page to the view when `refits`, and
     * expect the view where it was once that has settled, with nothing saved.
     */
    async function expectHeldThrough(
      resize: () => Promise<unknown>,
      refits: boolean
    ) {
      const widthBefore = await pageWidth();
      await resize();
      if (refits) {
        await expect.poll(pageWidth).not.toBeCloseTo(widthBefore, 0);
      }
      // Longer than Obsidian takes to re-fit it, and than the save delay
      await window.waitForTimeout(1000);
      if (!refits) expect(await pageWidth()).toBeCloseTo(widthBefore, 0);
      await expectAt(window, stopped, 0.005);
      expect((await saved(window)).scrollTop).toBe(savedAtStop);
    }

    // The window, larger and then smaller
    await expectHeldThrough(
      () => window.setViewportSize({ width: 1280, height: 800 }),
      true
    );
    await expectHeldThrough(
      () => window.setViewportSize({ width: 1920, height: 1080 }),
      true
    );
    await expectHeldThrough(
      () => window.setViewportSize({ width: 1280, height: 800 }),
      true
    );
    // The left sidebar, collapsed and expanded again
    await expectHeldThrough(
      () => executeCommandById(window, 'app:toggle-left-sidebar'),
      true
    );
    await expectHeldThrough(
      () => executeCommandById(window, 'app:toggle-left-sidebar'),
      true
    );

    // Opened afresh where it was saved, at 1024x650 and at 1920x1080, then
    // grown and shrunk
    await window.setViewportSize({ width: 1024, height: 650 });
    await showItem(window, noteId);
    await expect(article(window)).toHaveCount(0);
    await showItem(window, pdfId);
    await expectAt(window, stopped, 0.005);
    await expectHeldThrough(
      () => window.setViewportSize({ width: 1280, height: 800 }),
      true
    );
    await window.setViewportSize({ width: 1920, height: 1080 });
    await showItem(window, noteId);
    await expect(article(window)).toHaveCount(0);
    await showItem(window, pdfId);
    await expectAt(window, stopped, 0.005);
    await expectHeldThrough(
      () => window.setViewportSize({ width: 1280, height: 800 }),
      true
    );

    // Zoomed in by the reader, which is a move to save. A resize re-fits no
    // zoom of the reader's own, so pdf.js moves nothing here: this checks
    // that holding the place keeps that zoom, and saves nothing either
    const widthBefore = await pageWidth();
    await article(window).locator('[aria-label="Zoom in"]').click();
    await expect.poll(pageWidth).toBeGreaterThan(widthBefore);
    await scrollInto(window, 3, 0.25);
    await expectAt(window, stopped, 0.005);
    await window.waitForTimeout(1000);
    savedAtStop = (await saved(window)).scrollTop;
    expect(Math.floor(savedAtStop / PDF_PAGE_STRIDE)).toBe(3);
    await expectHeldThrough(
      () => window.setViewportSize({ width: 1024, height: 650 }),
      false
    );
  });
});

test.describe('Snippets and cards from a PDF article', () => {
  /** The paragraph page 1 carries over onto page 2, past the running heads. */
  const CARRIED_OVER =
    'A paragraph that begins near the foot of one page is common in papers ' +
    'and books alike. Whatever reads the text has to carry the sentence over ' +
    'the page break, past the footer of this page and the header of the ' +
    'next, without mistaking either of them for part of the paragraph ' +
    'itself. It ends here, on the second page,';
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

  /** Whether a note is at `reference` in the vault. */
  const noteExists = (page: Page, reference: string) =>
    page.evaluate((ref) => {
      const { app } = window as unknown as { app: PageApp };
      return app.vault.getFileByPath(ref) !== null;
    }, reference);

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

  test('extracts a paragraph carried over a page break as it reads, linked to where it was, leaving the PDF as it was', async () => {
    const pdfBytes = await fs.readFile(path.join(vaultPath, PDF_PATH));
    await importFixture(window);
    await beginReview(window);
    // Both pages' text layers on hand: pdf.js renders them as they come near
    await pdfPage(window, 2).scrollIntoViewIfNeeded();
    await expect(textItem(window, 2, 3)).toBeAttached();
    await expect(textItem(window, 1, 9)).toBeAttached();
    const notices = await watchNotices(window);

    await selectText(window, [1, 9, 0], [2, 3, 30]);
    await expect.poll(() => viewerSelection(window)).not.toBeNull();
    await window.getByRole('button', { name: 'Create snippet' }).click();

    await expect.poll(() => snippets(window)).toHaveLength(1);
    const [snippet] = await snippets(window);
    expect(snippet).toMatchObject({
      parent: await articleId(window),
      // page * 1e10 + idx * 1e5 + char
      start_offset: 1_00009_00000,
      end_offset: 2_00003_00030,
      body: CARRIED_OVER,
    });
    expect(snippet.body).not.toContain('Journal of Incremental Reading');
    expect(snippet.body).not.toContain('Page 1 of 3');
    expect(snippet.source).toBe(
      '[[PDF fixture.pdf#page=1&selection=9,0,13,11|PDF fixture, page 1]]'
    );
    expect(await notices()).toEqual([
      expect.stringMatching(/^snippet created: /),
    ]);
    // Nothing written to the PDF
    expect(
      (await fs.readFile(path.join(vaultPath, PDF_PATH))).equals(pdfBytes)
    ).toBe(true);

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
      [snippet.source as string, snippet.reference]
    );
    const highlighted = window.locator(
      '.workspace-leaf.mod-active .pdf-container .textLayer .mod-focused'
    );
    await expect(highlighted.first()).toContainText('A paragraph that begins');
  });

  test('enters selection mode with nothing selected, and extracts what is then selected, though the button press moves the selection away', async () => {
    await importFixture(window);
    await beginReview(window);
    await expect(textItem(window, 1, 2)).toBeVisible();

    await window.getByRole('button', { name: 'Create snippet' }).click();
    await expect(confirmButton(window)).toBeVisible();

    // A drag across the first line, as the user selects
    const box = (await textItem(window, 1, 2).boundingBox())!;
    await window.mouse.move(box.x + 1, box.y + box.height / 2);
    await window.mouse.down();
    await window.mouse.move(box.x + box.width - 1, box.y + box.height / 2, {
      steps: 10,
    });
    await window.mouse.up();
    await expect.poll(() => viewerSelection(window)).toContain('Incremental');
    // As tapping a button does on a phone: the selection lands outside
    await window.evaluate(() => {
      const bar = document.querySelector('.ir-action-bar')!;
      document.getSelection()!.collapse(bar, 0);
    });

    await confirmButton(window).click();

    await expect.poll(() => snippets(window)).toHaveLength(1);
    const [snippet] = await snippets(window);
    expect(FIRST_LINE).toContain(snippet.body);
    expect(snippet.body!.length).toBeGreaterThan(FIRST_LINE.length - 5);
    await expect(confirmButton(window)).toHaveCount(0);
    expect(await viewerSelection(window)).toBeNull();
  });

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

  test('forgets the selection once the bare tab around the viewer is clicked', async () => {
    await importFixture(window);
    await beginReview(window);
    await expect(textItem(window, 1, 2)).toBeAttached();
    await selectText(window, [1, 2, 0], [1, 2, FIRST_LINE.length]);
    await expect.poll(() => viewerSelection(window)).toBe(FIRST_LINE);

    // A click on the action bar's background, which unselects the text
    await window.evaluate(() => {
      // The review tab's: the PDF's own tab, still open, has one too
      const bar = document.querySelector(
        '.ir-review-interface .ir-action-bar'
      )!;
      bar.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, composed: true })
      );
      document.getSelection()!.collapse(bar, 0);
    });
    await expect.poll(() => viewerSelection(window)).toBeNull();
    await executeCommandById(window, 'incremental-reading:extract-selection');

    await expect(confirmButton(window)).toBeVisible();
    expect(await snippets(window)).toEqual([]);
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

  test('makes a card of the selection, its answer chosen in the modal, linked to where it was, leaving the PDF as it was; undo deletes it', async () => {
    const pdfBytes = await fs.readFile(path.join(vaultPath, PDF_PATH));
    const unchanged = async () =>
      (await fs.readFile(path.join(vaultPath, PDF_PATH))).equals(pdfBytes);
    await importFixture(window);
    await beginReview(window);
    await expect(textItem(window, 1, 2)).toBeAttached();

    await selectText(window, [1, 2, 0], [1, 2, FIRST_LINE.length]);
    await expect.poll(() => viewerSelection(window)).toBe(FIRST_LINE);
    await actionBar(window)
      .getByRole('button', { name: 'Create card' })
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
    expect(await unchanged()).toBe(true);
    expect(await viewerSelection(window)).toBeNull();

    await actionBar(window).locator('#undo-button').click();

    await expect.poll(() => cards(window)).toEqual([]);
    expect(await noteExists(window, card.reference)).toBe(false);
    expect(await unchanged()).toBe(true);
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

  /** What Obsidian's cache read in the note at `reference` besides its properties. */
  const noteSyntax = (page: Page, reference: string) =>
    page.evaluate(async (reference) => {
      const { app } = window as unknown as {
        app: PageApp & {
          vault: { cachedRead(file: unknown): Promise<string> };
          metadataCache: {
            getFileCache(file: unknown): Record<string, unknown> | null;
          };
        };
      };
      const file = app.vault.getFileByPath(reference);
      const cache = app.metadataCache.getFileCache(file) ?? {};
      const sections = (cache.sections ?? []) as { type: string }[];
      return {
        links: cache.links ?? [],
        embeds: cache.embeds ?? [],
        tags: cache.tags ?? [],
        headings: cache.headings ?? [],
        listItems: cache.listItems ?? [],
        blocks: cache.blocks ?? {},
        footnotes: cache.footnotes ?? [],
        footnoteRefs: cache.footnoteRefs ?? [],
        referenceLinks: cache.referenceLinks ?? [],
        sections: sections.map(({ type }) => type),
        frontmatterTags: (cache.frontmatter as { tags?: unknown } | undefined)
          ?.tags,
        // Templater's opening tag, `<%` (its parser's `ParserConfig("<%",
        // "%>", …)`), anywhere in the note: Templater ignores escapes
        templater: /<%/.test(await app.vault.cachedRead(file)),
      };
    }, reference);

  const CLEAN_NOTE = {
    links: [],
    embeds: [],
    tags: [],
    headings: [],
    listItems: [],
    blocks: {},
    footnotes: [],
    footnoteRefs: [],
    referenceLinks: [],
    templater: false,
  };

  test('makes snippets and cards of a PDF whose text is Markdown and a Templater command that read as that text, and nothing more', async () => {
    await importFixture(window, HOSTILE_PDF_PATH);
    await beginReview(window);
    await expect(textItem(window, 1, 5)).toBeAttached();

    // The card first: the snippet's highlight splits the text it selects in
    const last = HOSTILE_PARAGRAPHS[3];
    await selectText(window, [1, 5, 0], [1, 5, last.length]);
    await expect.poll(() => viewerSelection(window)).toBe(last);
    await actionBar(window)
      .getByRole('button', { name: 'Create card' })
      .click();
    await expect(answerText(window)).toHaveText(last);
    // `_` either side of it: a cloze delimiter beside one is italic in live
    // preview, unless escaped
    await selectAnswer(window, 'b');
    await window.keyboard.press('Enter');
    await expect.poll(() => cards(window)).toHaveLength(1);

    // By character: the card's highlight splits the text it selects in
    await selectChars(window, [1, 0, 0], [1, 5, last.length]);
    await expect.poll(() => viewerSelection(window)).not.toBeNull();
    await window.getByRole('button', { name: 'Create snippet' }).click();
    await expect.poll(() => snippets(window)).toHaveLength(1);

    const [snippet] = await snippets(window);
    const [card] = await cards(window);
    const text = HOSTILE_PARAGRAPHS.join('\n\n');
    expect(snippet.body).toBe(Markdown.escape(text));
    const answer = last.indexOf('a_b_c') + 2;
    const escaped = Markdown.escapeAround(last, [answer, answer + 1]);
    const [from, to] = escaped.range;
    const [left, right] = CLOZE_DELIMITERS;
    expect(card.body).toBe(
      escaped.text.slice(0, from) +
        `${left} ${escaped.text.slice(from, to)} ${right}` +
        escaped.text.slice(to)
    );
    await expect
      .poll(() => noteSyntax(window, snippet.reference))
      .toEqual({
        ...CLEAN_NOTE,
        sections: ['yaml', 'paragraph', 'paragraph', 'paragraph', 'paragraph'],
        frontmatterTags: ['ir-text-snippet'],
      });
    await expect
      .poll(() => noteSyntax(window, card.reference))
      .toEqual({
        ...CLEAN_NOTE,
        sections: ['yaml', 'paragraph'],
        frontmatterTags: ['ir-card'],
      });
    // Read as itself, paragraph by paragraph, in reading view and live preview
    expectPlainText(await readMarkdown(window, snippet.body!), text);
    expectPlainText(
      await readMarkdown(window, card.body!),
      last.slice(0, answer) + `${left} b ${right}` + last.slice(answer + 1)
    );
  });

  test('makes a snippet and a card of text holding a tab and a right-to-left override, named without either and written without the override so they read as the text, linked and highlighted as the PDF holds it', async () => {
    await importFixture(window, CONTROLS_PDF_PATH);
    await beginReview(window);
    await expect(textItem(window, 1, 0)).toBeAttached();
    const notices = await watchNotices(window);

    await selectText(window, [1, 0, 0], [1, 0, CONTROLS_LINE.length]);
    await expect.poll(() => viewerSelection(window)).toBe(CONTROLS_LINE);
    await actionBar(window)
      .getByRole('button', { name: 'Create card' })
      .click();
    // The answer is chosen from the text as a note takes it
    await expect
      .poll(() => answerText(window).evaluate((el) => el.textContent))
      .toBe(CONTROLS_TEXT);
    // After where the override stood: its offsets are in the text as taken
    await selectAnswer(window, 'fdp');
    await window.keyboard.press('Enter');
    await expect.poll(() => cards(window)).toHaveLength(1);

    // By character: the card's highlight splits the text it selects in
    await selectChars(window, [1, 0, 0], [1, 0, CONTROLS_LINE.length]);
    await expect.poll(() => viewerSelection(window)).toBe(CONTROLS_LINE);
    await window.getByRole('button', { name: 'Create snippet' }).click();
    await expect.poll(() => snippets(window)).toHaveLength(1);

    // On Windows a tab in the name fails the create: getting here is the test
    expect(await notices()).not.toContainEqual(expect.stringMatching(/fail/i));
    const [snippet] = await snippets(window);
    const [card] = await cards(window);
    // The note's name, less the id after its last ` - `
    const named = (reference: string) =>
      reference
        .slice(reference.lastIndexOf('/') + 1)
        .replace(/ - \w+\.md$/, '');
    const [left, right] = CLOZE_DELIMITERS;
    expect(named(snippet.reference)).toBe('Tabbed here reportfdp.exe');
    expect(named(card.reference)).toBe(
      `Tabbed here report${left} fdp ${right}.exe`
    );
    // The text keeps the tab, but not the override that would reverse it
    expect(snippet.body).toBe(Markdown.escape(CONTROLS_TEXT));
    const answer = CONTROLS_TEXT.indexOf('fdp');
    const escaped = Markdown.escapeAround(CONTROLS_TEXT, [
      answer,
      answer + 'fdp'.length,
    ]);
    const [from, to] = escaped.range;
    expect(card.body).toBe(
      escaped.text.slice(0, from) +
        `${left} ${escaped.text.slice(from, to)} ${right}` +
        escaped.text.slice(to)
    );
    // Linked to the PDF's own text, override and all: the whole item
    const subpath = `#page=1&selection=0,0,0,${CONTROLS_LINE.length}`;
    expect(snippet.source).toContain(subpath);
    expect(card.source).toContain(subpath);
    // Highlighted over the whole of it
    await expect
      .poll(async () =>
        (await highlightsIn(textItem(window, 1, 0)))
          .filter(([ref]) => ref === snippet.reference)
          .map(([, text]) => text)
          .join('')
      )
      .toBe(CONTROLS_LINE);

    // And its context lights up the same text
    await goToContextFrom(window, snippet.reference);
    await expect
      .poll(() =>
        highlighted(window).evaluateAll((els) =>
          els.map((el) => el.textContent).join('')
        )
      )
      .toBe(CONTROLS_LINE);
  });

  test('names a snippet of text hiding variation selectors without them, and writes it without them', async () => {
    await importFixture(window, CONTROLS_PDF_PATH);
    await beginReview(window);
    await expect(textItem(window, 1, 1)).toBeAttached();
    const notices = await watchNotices(window);

    await selectText(window, [1, 1, 0], [1, 1, HIDDEN_LINE.length]);
    // pdf.js reads the selectors, so a name could carry them
    await expect.poll(() => viewerSelection(window)).toBe(HIDDEN_LINE);
    await window.getByRole('button', { name: 'Create snippet' }).click();
    await expect.poll(() => snippets(window)).toHaveLength(1);

    expect(await notices()).not.toContainEqual(expect.stringMatching(/fail/i));
    const [snippet] = await snippets(window);
    const name = snippet.reference
      .slice(snippet.reference.lastIndexOf('/') + 1)
      .replace(/ - \w+\.md$/, '');
    // `Re`, U+FE00, `port` would look like `Report` and be another name
    expect(name).toBe('Fla Report');
    // Nor does its text carry them
    expect(snippet.body).toBe(Markdown.escape('Fla Report'));
  });

  /**
   * A snippet of all of the hostile fixture's first page, its text escaped:
   * `\#ir-card` and all. Leaves review open on the PDF.
   */
  async function hostileSnippet(page: Page) {
    await importFixture(page, HOSTILE_PDF_PATH);
    await beginReview(page);
    await expect(textItem(page, 1, 5)).toBeAttached();
    const last = HOSTILE_PARAGRAPHS[3];
    await selectText(page, [1, 0, 0], [1, 5, last.length]);
    await expect.poll(() => viewerSelection(page)).not.toBeNull();
    await page.getByRole('button', { name: 'Create snippet' }).click();
    await expect.poll(() => snippets(page)).toHaveLength(1);
    const [snippet] = await snippets(page);
    expect(snippet.body).toContain('\\#ir-card \\#ir-text-snippet');
    return snippet;
  }

  /** The id of the `table` row at `reference`. */
  const rowId = (page: Page, table: string, reference: string) =>
    page.evaluate(
      ([table, ref]) => {
        const { app } = window as unknown as { app: PageApp };
        const { repo } =
          app.plugins.plugins['incremental-reading'].reviewManager;
        return String(
          repo.query(`SELECT id FROM ${table} WHERE reference = $1`, [ref])[0]
            .id
        );
      },
      [table, reference] as const
    );

  /**
   * Make the `table` row `id` due now and show it in the review tab. A new
   * item is due tomorrow at the soonest, and review moves off one that is not
   * due when it next looks.
   */
  async function reviewNow(page: Page, table: string, id: string) {
    await page.evaluate(
      async ([table, itemId, viewType]) => {
        const { app } = window as unknown as {
          app: PageApp & {
            workspace: {
              setActiveLeaf(leaf: unknown, params: { focus: boolean }): void;
            };
          };
        };
        const plugin = app.plugins.plugins['incremental-reading'];
        const { repo } = plugin.reviewManager as unknown as {
          repo: { mutate(sql: string, params: unknown[]): Promise<unknown> };
        };
        await repo.mutate(`UPDATE ${table} SET due = $1 WHERE id = $2`, [
          Date.now() - 60_000,
          itemId,
        ]);
        const [leaf] = app.workspace.getLeavesOfType(viewType);
        app.workspace.setActiveLeaf(leaf, { focus: true });
        plugin.store.dispatch({ type: 'page/setPage', payload: 'review' });
        plugin.store.dispatch({
          type: 'currentItemId/setCurrentItemId',
          payload: itemId,
        });
      },
      [table, id, REVIEW_VIEW_TYPE] as const
    );
  }

  /**
   * The CodeMirror editor of the active tab, or of review's. `editor.cm` is
   * undocumented Obsidian API. Each `page.evaluate` below finds it for itself,
   * since what runs in the page can't share code with the test.
   */
  type EditorPick = 'active' | 'review';
  const editorDoc = (page: Page, editor: EditorPick) =>
    page.evaluate(
      ([editor, viewType]) => {
        type CM = { state: { doc: { toString(): string } } };
        const { app } = window as unknown as {
          app: {
            workspace: {
              activeEditor: { editor?: { cm: CM } } | null;
              getLeavesOfType(type: string): {
                view: { reviewEditor(): { cm: CM } | null };
              }[];
            };
          };
        };
        const cm =
          editor === 'active'
            ? app.workspace.activeEditor?.editor?.cm
            : app.workspace.getLeavesOfType(viewType)[0]?.view.reviewEditor()
                ?.cm;
        return cm?.state.doc.toString() ?? null;
      },
      [editor, REVIEW_VIEW_TYPE] as const
    );

  /**
   * Select from `from` to `to` past the start of `text` in an editor's note,
   * in its state: a drag can't be made to land between a `\` and what it
   * escapes. Fails if the editor moves the selection after: live preview
   * moves a selection a script sets off the hidden `\`, so these tests run in
   * source mode.
   */
  const selectInEditor = (
    page: Page,
    editor: EditorPick,
    text: string,
    [from, to]: [number, number]
  ) =>
    page.evaluate(
      async ([editor, text, from, to, viewType]) => {
        type CM = {
          state: {
            doc: { toString(): string };
            selection: { main: { anchor: number; head: number } };
          };
          dispatch(spec: { selection: { anchor: number; head: number } }): void;
        };
        const { app } = window as unknown as {
          app: {
            workspace: {
              activeEditor: { editor?: { cm: CM } } | null;
              getLeavesOfType(type: string): {
                view: { reviewEditor(): { cm: CM } | null };
              }[];
            };
          };
        };
        const cm =
          editor === 'active'
            ? app.workspace.activeEditor?.editor?.cm
            : app.workspace.getLeavesOfType(viewType)[0]?.view.reviewEditor()
                ?.cm;
        const at = cm?.state.doc.toString().indexOf(text) ?? -1;
        if (!cm || at < 0) throw new Error(`No editor holds ${text}`);
        cm.dispatch({ selection: { anchor: at + from, head: at + to } });
        // Live preview's move comes on a timeout
        await new Promise((resolve) => setTimeout(resolve, 100));
        const { anchor, head } = cm.state.selection.main;
        if (anchor !== at + from || head !== at + to) {
          throw new Error(
            `Selection moved from ${at + from}-${at + to} to ${anchor}-${head}`
          );
        }
      },
      [editor, text, from, to, REVIEW_VIEW_TYPE] as const
    );

  /** The card review is showing, and the placeholder of its hidden answer. */
  const cardViewer = (page: Page) =>
    page.locator('.ir-review-interface .ir-card-viewer');

  test('keeps the escape in a snippet and a card made in a Markdown tab from a selection starting between a `\\` and the `#` it escapes', async () => {
    await setDefaultEditingMode(window, 'source');
    const parent = await hostileSnippet(window);
    await window.evaluate(async (reference) => {
      const { app } = window as unknown as {
        app: PageApp & {
          workspace: {
            setActiveLeaf(leaf: unknown, params: { focus: boolean }): void;
          };
        };
      };
      const leaf = app.workspace.getLeaf('tab');
      await leaf.openFile(app.vault.getFileByPath(reference));
      app.workspace.setActiveLeaf(leaf, { focus: true });
    }, parent.reference);
    const tag = '\\#ir-card';
    await expect.poll(() => editorDoc(window, 'active')).toContain(tag);

    // From the `#`, past the `\` before it, to the end of the tag
    await selectInEditor(window, 'active', tag, [1, tag.length]);
    await executeCommandById(window, 'incremental-reading:extract-selection');

    await expect.poll(() => snippets(window)).toHaveLength(2);
    const child = (await snippets(window)).find(
      (s) => s.reference !== parent.reference
    )!;
    expect(child.body).toBe(tag);
    // The highlight in the parent covers the escape too
    expect(parent.body!.slice(child.start_offset!, child.end_offset!)).toBe(
      tag
    );
    await expect
      .poll(() => noteSyntax(window, child.reference))
      .toEqual({
        ...CLEAN_NOTE,
        sections: ['yaml', 'paragraph'],
        frontmatterTags: ['ir-text-snippet'],
      });

    // The answer, from just after the `\`, on the line the card is made of
    await selectInEditor(window, 'active', tag, [1, tag.length]);
    await executeCommandById(window, 'incremental-reading:create-card');

    await expect.poll(() => cards(window)).toHaveLength(1);
    const [card] = await cards(window);
    const [left, right] = CLOZE_DELIMITERS;
    expect(card.body).toContain(`${left} ${tag} ${right}`);
    expect(card.body).not.toContain(`\\${left}`);

    await reviewNow(
      window,
      'srs_card',
      await rowId(window, 'srs_card', card.reference)
    );
    await expect(
      cardViewer(window).locator('mark.ir-hidden-answer')
    ).toHaveCount(1);
    await expect(cardViewer(window)).not.toContainText('<mark');
  });

  /*
   * The extract command is off in reading view, so nothing in the UI makes a
   * snippet there today. The test drives the action the command runs instead,
   * through the real view, selection and renderer: should the command ever be
   * let through in reading view, this is what it would make.
   */
  test("escapes a snippet of reading view's selection, so what the note escaped stays plain text in it", async () => {
    const parent = await hostileSnippet(window);
    await window.evaluate(async (reference) => {
      const { app } = window as unknown as {
        app: {
          vault: PageApp['vault'];
          workspace: {
            getLeaf(newLeaf: 'tab'): {
              openFile(file: unknown, state: unknown): Promise<void>;
            };
            setActiveLeaf(leaf: unknown, params: { focus: boolean }): void;
          };
        };
      };
      const leaf = app.workspace.getLeaf('tab');
      await leaf.openFile(app.vault.getFileByPath(reference), {
        state: { mode: 'preview' },
      });
      app.workspace.setActiveLeaf(leaf, { focus: true });
    }, parent.reference);
    // The rendered paragraphs of the open note, the properties above them left out
    const paragraphs = window.locator(
      '.workspace-leaf.mod-active .markdown-reading-view .markdown-preview-section > div > p'
    );
    await expect(paragraphs).toHaveCount(HOSTILE_PARAGRAPHS.length);

    // Everything from the first paragraph to the last, as a drag would select it
    const selected = await paragraphs.first().evaluate((first) => {
      const paras = first
        .closest('.markdown-preview-section')!
        .querySelectorAll(':scope > div > p');
      const last = paras[paras.length - 1];
      const range = first.ownerDocument.createRange();
      range.setStart(first, 0);
      range.setEnd(last, last.childNodes.length);
      const selection = first.ownerDocument.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    });
    // What the note escaped reads bare in the selection: what makes the
    // escape needed
    expect(selected).toContain('<%*');
    expect(selected).toContain('[[Note|alias]]');
    expect(selected).toContain(' #ir-card #ir-text-snippet');
    expect(selected).not.toContain('\\#');

    // The command is off here, as the palette asks it. Undocumented:
    // `app.commands.commands`, Obsidian's registry of commands by id
    const available = await window.evaluate(() => {
      const { app } = window as unknown as {
        app: {
          commands: {
            commands: Record<
              string,
              { checkCallback(checking: boolean): boolean | void }
            >;
          };
        };
      };
      return app.commands.commands[
        'incremental-reading:extract-selection'
      ].checkCallback(true);
    });
    expect(available).toBe(false);
    // Undocumented: `app.plugins.plugins`, Obsidian's loaded plugins by id
    await window.evaluate(async (reference) => {
      const { app } = window as unknown as {
        app: {
          workspace: { activeEditor: { file: { path: string } | null } | null };
          plugins: {
            plugins: Record<
              string,
              { actions: { createSnippet(): Promise<unknown> } }
            >;
          };
        };
      };
      // The action snips through the active editor: it must be the note's,
      // not one review left behind
      const active = app.workspace.activeEditor?.file?.path;
      if (active !== reference) throw new Error(`Active editor is ${active}`);
      await app.plugins.plugins['incremental-reading'].actions.createSnippet();
    }, parent.reference);

    await expect.poll(() => snippets(window)).toHaveLength(2);
    const child = (await snippets(window)).find(
      (s) => s.reference !== parent.reference
    )!;
    expect(child.body).toBe(Markdown.escape(selected));
    // Nor offsets from the cursor of the editor hidden behind reading view
    expect([child.start_offset, child.end_offset]).toEqual([null, null]);
    await expect
      .poll(() => noteSyntax(window, child.reference))
      .toEqual({
        ...CLEAN_NOTE,
        sections: ['yaml', ...HOSTILE_PARAGRAPHS.map(() => 'paragraph')],
        frontmatterTags: ['ir-text-snippet'],
      });
    // It reads as the selection did, in reading view and live preview alike
    expectPlainText(await readMarkdown(window, child.body!), selected);
  });

  test('keeps the escape in a card made in selection mode from a span and an answer each starting between a `\\` and the `#` it escapes', async () => {
    await setDefaultEditingMode(window, 'source');
    const parent = await hostileSnippet(window);
    await reviewNow(
      window,
      'snippet',
      await rowId(window, 'snippet', parent.reference)
    );
    const span = '\\#ir-card \\#ir-text-snippet';
    await expect.poll(() => editorDoc(window, 'review')).toContain(span);
    await actionBar(window)
      .getByRole('button', { name: 'Create card' })
      .click();
    await expect(confirmButton(window)).toBeVisible();

    // The span from the `#` of its first tag, past the `\` before it
    await selectInEditor(window, 'review', span, [1, span.length]);
    await confirmButton(window).click();
    await expect(answerText(window)).toHaveText(span.slice(1));
    // The answer from just after the second tag's `\`
    await selectAnswer(window, '#ir-text-snippet');
    await window.keyboard.press('Enter');

    await expect.poll(() => cards(window)).toHaveLength(1);
    const [card] = await cards(window);
    const [left, right] = CLOZE_DELIMITERS;
    expect(card.body).toBe(`\\#ir-card ${left} \\#ir-text-snippet ${right}`);
    await expect
      .poll(() => noteSyntax(window, card.reference))
      .toEqual({
        ...CLEAN_NOTE,
        sections: ['yaml', 'paragraph'],
        frontmatterTags: ['ir-card'],
      });

    await reviewNow(
      window,
      'srs_card',
      await rowId(window, 'srs_card', card.reference)
    );
    await expect(
      cardViewer(window).locator('mark.ir-hidden-answer')
    ).toHaveCount(1);
    await expect(cardViewer(window)).not.toContainText('<mark');
    await expect(cardViewer(window)).toContainText('#ir-card');
  });

  test('escapes the start of a snippet and a card made from mid-line of a PDF snippet, where the PDF formed no heading or list', async () => {
    await setDefaultEditingMode(window, 'source');
    const parent = await hostileSnippet(window);
    await window.evaluate(async (reference) => {
      const { app } = window as unknown as {
        app: PageApp & {
          workspace: {
            setActiveLeaf(leaf: unknown, params: { focus: boolean }): void;
          };
        };
      };
      const leaf = app.workspace.getLeaf('tab');
      await leaf.openFile(app.vault.getFileByPath(reference));
      app.workspace.setActiveLeaf(leaf, { focus: true });
    }, parent.reference);
    // `C#` stays bare in the escaped note: no tag starts after a letter
    const heading = 'C# and x < 5';
    await expect.poll(() => editorDoc(window, 'active')).toContain(heading);

    // From the `#`, which would start a heading
    await selectInEditor(window, 'active', heading, [1, heading.length]);
    await executeCommandById(window, 'incremental-reading:extract-selection');

    await expect.poll(() => snippets(window)).toHaveLength(2);
    const child = (await snippets(window)).find(
      (s) => s.reference !== parent.reference
    )!;
    expect(child.body).toBe(String.raw`\# and x < 5`);
    await expect
      .poll(() => noteSyntax(window, child.reference))
      .toEqual({
        ...CLEAN_NOTE,
        sections: ['yaml', 'paragraph'],
        frontmatterTags: ['ir-text-snippet'],
      });

    // A card in selection mode, its span from the `1` of a mid-line `1.`,
    // which would start a list
    await reviewNow(
      window,
      'snippet',
      await rowId(window, 'snippet', parent.reference)
    );
    const list = '1. a list - item + more';
    await expect.poll(() => editorDoc(window, 'review')).toContain(list);
    await actionBar(window)
      .getByRole('button', { name: 'Create card' })
      .click();
    await expect(confirmButton(window)).toBeVisible();
    await selectInEditor(window, 'review', list, [0, list.length]);
    await confirmButton(window).click();
    await expect(answerText(window)).toHaveText(list);
    await selectAnswer(window, 'item');
    await window.keyboard.press('Enter');

    await expect.poll(() => cards(window)).toHaveLength(1);
    const [card] = await cards(window);
    const [left, right] = CLOZE_DELIMITERS;
    expect(card.body).toBe(
      String.raw`1\. a list - ${left} item ${right} + more`
    );
    await expect
      .poll(() => noteSyntax(window, card.reference))
      .toEqual({
        ...CLEAN_NOTE,
        sections: ['yaml', 'paragraph'],
        frontmatterTags: ['ir-card'],
      });
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
      .toEqual([
        'No selectable text',
        'No selectable text',
        'No selectable text',
        'No selectable text',
      ]);
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

  /**
   * Count, from now on, every read of the file at `path` through the vault:
   * as text, or whole as bytes. The PDF tab loads it by its resource URL.
   */
  const watchVaultReads = (page: Page, filePath: string) =>
    page.evaluate((filePath) => {
      const { app } = window as unknown as {
        app: {
          vault: Record<string, unknown> & { adapter: Record<string, unknown> };
        };
      };
      const diag = { reads: [] as string[] };
      (window as unknown as { __vaultReads: typeof diag }).__vaultReads = diag;
      const wrap = (target: Record<string, unknown>, name: string) => {
        const original = target[name] as (...args: unknown[]) => unknown;
        target[name] = function (this: unknown, ...args: unknown[]) {
          const arg = args[0] as { path?: string } | string;
          const path = typeof arg === 'string' ? arg : arg?.path;
          if (path === filePath) diag.reads.push(name);
          return original.apply(this, args) as unknown;
        };
      };
      for (const name of ['read', 'cachedRead', 'readBinary']) {
        wrap(app.vault, name);
        wrap(app.vault.adapter, name);
      }
    }, filePath);

  const vaultReads = (page: Page) =>
    page.evaluate(
      () =>
        (window as unknown as { __vaultReads: { reads: string[] } })
          .__vaultReads.reads
    );

  /** The PDF tab Go to context opened, and its highlighted text. */
  const contextTab = (page: Page) =>
    page.locator('.workspace-leaf.mod-active .pdf-container');
  const highlighted = (page: Page) =>
    contextTab(page).locator('.textLayer .mod-focused');

  test('goes to the context of a snippet carried over a page break: its PDF, lit up from where it starts to the foot of its first page, read nowhere', async () => {
    await importFixture(window);
    await beginReview(window);
    await pdfPage(window, 2).scrollIntoViewIfNeeded();
    await expect(textItem(window, 2, 3)).toBeAttached();
    await expect(textItem(window, 1, 9)).toBeAttached();
    await selectText(window, [1, 9, 0], [2, 3, 30]);
    await expect.poll(() => viewerSelection(window)).not.toBeNull();
    await window.getByRole('button', { name: 'Create snippet' }).click();
    await expect.poll(() => snippets(window)).toHaveLength(1);
    const [snippet] = await snippets(window);
    await watchVaultReads(window, PDF_PATH);

    await goToContextFrom(window, snippet.reference);

    await expect(highlighted(window).first()).toContainText(
      'A paragraph that begins'
    );
    await expect(highlighted(window).first()).toBeInViewport();
    // To the end of the text on page 1, item 13, and no further
    const page1 = contextTab(window).locator('.page[data-page-number="1"]');
    await expect(
      page1.locator('[data-idx="13"] .mod-focused, [data-idx="13"].mod-focused')
    ).not.toHaveCount(0);
    await expect(
      contextTab(window).locator(
        '.page[data-page-number="2"] .textLayer .mod-focused'
      )
    ).toHaveCount(0);
    expect(
      await window.evaluate(() => {
        const { app } = window as unknown as {
          app: {
            workspace: {
              activeLeaf: {
                view: { getViewType(): string; file: { path: string } };
              };
            };
          };
        };
        const { view } = app.workspace.activeLeaf;
        return [view.getViewType(), view.file.path];
      })
    ).toEqual(['pdf', PDF_PATH]);
    expect(await vaultReads(window)).toEqual([]);
  });

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
    await watchVaultReads(window, PDF_PATH);

    await goToContextFrom(window, snippet.reference);

    const lit = contextTab(window).locator(
      '.page[data-page-number="2"] .textLayer .mod-focused'
    );
    await expect(lit).toHaveCount(1);
    await expect(lit).toHaveText(SECOND_PAGE_TEXT);
    await expect(lit).toBeInViewport();
    expect(await vaultReads(window)).toEqual([]);
  });

  /**
   * The highlights over `scope`, a text item or a whole page, as [reference,
   * text] pairs, bottom of the stack first: the text each box is drawn over.
   * The plugin draws them as boxes in an overlay over the page's canvas,
   * under its text layer, each naming the item and characters it covers.
   */
  const highlightsIn = (scope: Locator, cls = 'ir-snippet-highlight') =>
    scope.evaluate((el, cls) => {
      const page = el.closest('.page')!;
      const { idx } = (el as HTMLElement).dataset;
      return Array.from(
        page.querySelectorAll<HTMLElement>(`.ir-pdf-highlights > .${cls}`)
      )
        .filter((box) => idx === undefined || box.dataset.item === idx)
        .map((box) => {
          const item = page.querySelector(
            `.textLayer [data-idx="${box.dataset.item}"]`
          )!;
          return [
            box.dataset.snippetRef,
            item.textContent.slice(
              Number(box.dataset.start),
              Number(box.dataset.end)
            ),
          ];
        });
    }, cls);

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

  /** The text of item `idx` on page `n` of the PDF in `scope`. */
  const itemText = (scope: Locator, n: number, idx: number) =>
    scope
      .locator(`.page[data-page-number="${n}"] .textLayer [data-idx="${idx}"]`)
      .textContent();

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

  /** The paths of the files every tab shows. */
  const openFiles = (page: Page) =>
    page.evaluate(() => {
      const { app } = window as unknown as {
        app: {
          workspace: {
            iterateAllLeaves(
              cb: (leaf: { view: { file?: { path: string } } }) => void
            ): void;
          };
        };
      };
      const paths: string[] = [];
      app.workspace.iterateAllLeaves((leaf) => {
        if (leaf.view.file) paths.push(leaf.view.file.path);
      });
      return paths;
    });

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

  test('highlights what was extracted on every page it covers, and nothing else, and a click on it opens the snippet', async () => {
    await importFixture(window);
    await beginReview(window);
    const reference = await extractAcrossPages(window);

    // The end of page 1 from item 9, and the start of page 2 up to item 3's
    // 30th character
    const viewer = article(window);
    const page2Item3 = (await itemText(viewer, 2, 3))!;
    await expect
      .poll(() => highlightsIn(textItem(window, 2, 3)))
      .toEqual([[reference, page2Item3.slice(0, 30)]]);
    expect(await highlightsIn(textItem(window, 1, 9))).toEqual([
      [reference, await itemText(viewer, 1, 9)],
    ]);
    expect(await highlightsIn(textItem(window, 1, 8))).toEqual([]);
    expect(await highlightsIn(textItem(window, 2, 4))).toEqual([]);
    // Over the page, under its transparent text: over the part of its item
    // extracted
    const highlight = itemBoxes(article(window), 2, 3);
    const box = await highlight.boundingBox();
    const itemBox = await textItem(window, 2, 3).boundingBox();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.width).toBeLessThan(itemBox!.width);
    expect(Math.abs(box!.x - itemBox!.x)).toBeLessThan(2);
    const middle = box!.y + box!.height / 2;
    expect(middle).toBeGreaterThan(itemBox!.y);
    expect(middle).toBeLessThan(itemBox!.y + itemBox!.height);

    await clickOn(window, highlight);
    await expect.poll(() => openFiles(window)).toContain(reference);
  });

  test('keeps text in a highlight selectable, to extract a snippet of a snippet, highlighted inside it', async () => {
    await importFixture(window);
    await beginReview(window);
    const outer = await extractAcrossPages(window);
    await expect(itemBoxes(article(window), 1, 9)).toHaveCount(1);

    await selectChars(window, [1, 9, 2], [1, 9, 12]);
    await expect.poll(() => viewerSelection(window)).not.toBeNull();
    await window.getByRole('button', { name: 'Create snippet' }).click();

    await expect.poll(() => snippets(window)).toHaveLength(2);
    const inner = (await snippets(window)).find((s) => s.reference !== outer)!;
    expect(inner).toMatchObject({
      start_offset: 1_00009_00002,
      end_offset: 1_00009_00012,
    });
    const text = (await itemText(article(window), 1, 9))!;
    // The inner one over the outer
    await expect
      .poll(() => highlightsIn(textItem(window, 1, 9)))
      .toEqual([
        [outer, text],
        [inner.reference, text.slice(2, 12)],
      ]);
  });

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
    // Obsidian's own highlight rebuilds the item, beside the snippet's over it
    await expect(item9.locator('.mod-focused')).not.toHaveCount(0);
    await expect
      .poll(() => highlightsIn(item9))
      .toEqual([[reference, await itemText(tab, 1, 9)]]);

    // A press on the page clears Obsidian's highlight, rebuilding the item again
    await tab
      .locator('.page[data-page-number="1"] .textLayer [data-idx="0"]')
      .click();
    await expect(item9.locator('.mod-focused')).toHaveCount(0);
    await expect
      .poll(() => highlightsIn(item9))
      .toEqual([[reference, await itemText(tab, 1, 9)]]);
  });

  test("keeps a drag begun beside a partly highlighted line starting at the line, through Obsidian's snap", async () => {
    await importFixture(window);
    await beginReview(window);
    await expect(textItem(window, 1, 9)).toBeAttached();
    // Highlight the middle of item 9, leaving its text in three nodes
    await selectChars(window, [1, 9, 2], [1, 9, 12]);
    await expect.poll(() => viewerSelection(window)).not.toBeNull();
    await window.getByRole('button', { name: 'Create snippet' }).click();
    await expect.poll(() => snippets(window)).toHaveLength(1);

    // The PDF's own tab, opened first, so its text layers hold pdf.js's one
    // snapping listener
    await window
      .locator('.workspace-tab-header', { hasText: 'PDF fixture' })
      .first()
      .click();
    const tab = window.locator('.workspace-leaf.mod-active .pdf-container');
    const item9 = tab.locator(
      '.page[data-page-number="1"] .textLayer [data-idx="9"]'
    );
    await expect(itemBoxes(tab, 1, 9)).toHaveCount(1);
    const text = (await item9.textContent())!;

    // A drag begun in the margin starts beside the item, not in its text,
    // which Obsidian's pdf.js snaps on pointerup
    const selected = await item9.evaluate((item) => {
      const range = document.createRange();
      const parent = item.parentNode!;
      range.setStart(parent, Array.from(parent.childNodes).indexOf(item));
      range.setEnd(item.lastChild!, item.lastChild!.textContent!.length);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      item.dispatchEvent(
        // Its listener reads the selection off the event's `view`
        new PointerEvent('pointerup', {
          bubbles: true,
          composed: true,
          view: item.ownerDocument.defaultView,
        })
      );
      return selection.toString();
    });

    expect(selected).toBe(text);
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

  /**
   * How far each highlight box over page 1 of the review tab's PDF is from
   * the text it covers, at most, in pixels: its edges against those of the
   * characters it names, as the text layer lays them out now.
   */
  const boxOffsets = (page: Page) =>
    page.evaluate(() => {
      const pageEl = document.querySelector(
        '.ir-pdf-article .page[data-page-number="1"]'
      )!;
      const boxes = Array.from(
        pageEl.querySelectorAll<HTMLElement>(
          '.ir-pdf-highlights > .ir-snippet-highlight'
        )
      );
      return boxes.map((box) => {
        const item = pageEl.querySelector(
          `.textLayer [data-idx="${box.dataset.item}"]`
        )!;
        const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        let from = 0;
        const rects: DOMRect[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const { length } = node as Text;
          const first = Math.max(Number(box.dataset.start) - from, 0);
          const last = Math.min(Number(box.dataset.end) - from, length);
          from += length;
          if (first >= last) continue;
          range.setStart(node, first);
          range.setEnd(node, last);
          rects.push(...Array.from(range.getClientRects()));
        }
        const text = {
          left: Math.min(...rects.map((r) => r.left)),
          top: Math.min(...rects.map((r) => r.top)),
          right: Math.max(...rects.map((r) => r.right)),
          bottom: Math.max(...rects.map((r) => r.bottom)),
        };
        const drawn = box.getBoundingClientRect();
        return Math.max(
          Math.abs(drawn.left - text.left),
          Math.abs(drawn.top - text.top),
          Math.abs(drawn.right - text.right),
          Math.abs(drawn.bottom - text.bottom)
        );
      });
    });

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
    expect(toolbar.after).toBeGreaterThan(toolbar.before * 1.05);
    expect(toolbar.frames).toBeGreaterThan(30);
    expect(toolbar.unseen).toBe(0);
    await settled(window);
    for (const offset of await boxOffsets(window)) {
      expect(offset).toBeLessThan(2);
    }

    const page1 = (await pdfPage(window, 1).boundingBox())!;
    await window.mouse.move(page1.x + page1.width / 2, page1.y + 150);
    const wheel = await framesThroughZoom(window, reference, async () => {
      await window.keyboard.down('Control');
      await window.mouse.wheel(0, 100);
      await window.keyboard.up('Control');
    });
    expect(wheel.after).toBeLessThan(wheel.before * 0.95);
    expect(wheel.unseen).toBe(0);
    await settled(window);
    for (const offset of await boxOffsets(window)) {
      expect(offset).toBeLessThan(2);
    }
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
    const item = (await textItem(window, 1, 2).boundingBox())!;
    const y = item.y + item.height / 2;

    await window.mouse.move(item.x + 1, y);
    await window.mouse.down();
    await window.mouse.move(item.x + item.width / 2, y, { steps: 5 });
    await window.mouse.move(item.x + item.width - 1, y, { steps: 5 });
    await window.mouse.up();

    await expect
      .poll(() => viewerSelection(window))
      .toMatch(/^Incremental reading turns a long text/);
    expect(await openFiles(window)).not.toContain(reference);
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
      expect.stringMatching(/^snippet created: /),
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
      .toEqual([
        'Select the text to extract first',
        'Select the text to make a card of first',
      ]);
    expect(await snippets(window)).toEqual([]);
    expect(await cards(window)).toEqual([]);
    await expect(answerText(window)).toHaveCount(0);
  });

  // #endregion

  // #region IN THE TAB OF A PDF THAT IS NO ARTICLE

  /** Where the first line's selection links to, in the PDF at `pdfLink`. */
  const firstLineSource = (pdfLink: string) =>
    `[[${pdfLink}#page=1&selection=2,0,2,${FIRST_LINE.length}` +
    '|PDF fixture, page 1]]';

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

  test('makes a parentless snippet and card in the tab of a PDF that is no article, linked as from an article, the snippet highlighted there', async () => {
    const pdfBytes = await fs.readFile(path.join(vaultPath, PDF_PATH));
    const notices = await watchNotices(window);

    await snipAndCardInPlainTab(window);

    const [snippet] = await snippets(window);
    expect(snippet).toMatchObject({
      parent: null,
      start_offset: 1_00002_00000,
      end_offset: 1_00002_00000 + FIRST_LINE.length,
      body: FIRST_LINE,
      source: firstLineSource('PDF fixture.pdf'),
    });
    const [card] = await cards(window);
    const [left, right] = CLOZE_DELIMITERS;
    expect(card).toMatchObject({
      parent: null,
      body: FIRST_LINE.replace('long text', `${left} long text ${right}`),
      source: firstLineSource('PDF fixture.pdf'),
    });
    expect(await notices()).toContainEqual(
      expect.stringMatching(/^snippet created: /)
    );
    // Found by its source link, the PDF having no row to find it by
    await expect(firstLineHighlights(window)).not.toHaveCount(0);
    expect(await articleRows(window)).toEqual([]);
    expect(
      (await fs.readFile(path.join(vaultPath, PDF_PATH))).equals(pdfBytes)
    ).toBe(true);

    // Undone without Obsidian's offer to delete the PDF too
    await executeCommandById(window, 'incremental-reading:undo');
    await executeCommandById(window, 'incremental-reading:undo');
    await expect.poll(() => snippets(window)).toHaveLength(0);
    await expect.poll(() => cards(window)).toHaveLength(0);
    await expect(firstLineHighlights(window)).toHaveCount(0);
    await expect(window.locator('.modal-container')).toHaveCount(0);
  });

  test('gives the snippet and card to the PDF once it is imported in place, which keeps the highlight', async () => {
    await snipAndCardInPlainTab(window);
    await expect(firstLineHighlights(window)).not.toHaveCount(0);

    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);

    await expect.poll(() => articleRows(window)).toHaveLength(1);
    const id = await articleId(window);
    await expect
      .poll(async () => (await snippets(window)).map((s) => s.parent))
      .toEqual([id]);
    await expect
      .poll(async () => (await cards(window)).map((c) => c.parent))
      .toEqual([id]);
    // Their links still name the PDF where it is
    expect((await snippets(window))[0].source).toBe(
      firstLineSource('PDF fixture.pdf')
    );
    await expect(firstLineHighlights(window)).not.toHaveCount(0);
  });

  test('gives the snippet and card to a copy imported from the PDF, pointing their links at it, and the original loses the highlight', async () => {
    await snipAndCardInPlainTab(window);
    await expect(firstLineHighlights(window)).not.toHaveCount(0);

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
    await executeCommandById(window, 'incremental-reading:import-article-copy');

    const copyPath = `${DATA_DIRECTORY}/${ARTICLE_DIRECTORY}/PDF fixture.pdf`;
    await expect
      .poll(async () => (await articleRows(window)).map((r) => r.reference))
      .toEqual([copyPath]);
    const [{ id }] = await articleRows(window);
    // Two PDFs share the name now, so a link to the copy is by its path
    await expect
      .poll(async () =>
        (await snippets(window)).map(({ parent, source }) => ({
          parent,
          source,
        }))
      )
      .toEqual([{ parent: id, source: firstLineSource(copyPath) }]);
    await expect
      .poll(async () =>
        (await cards(window)).map(({ parent, source }) => ({ parent, source }))
      )
      .toEqual([{ parent: id, source: firstLineSource(copyPath) }]);
    // The original's tab is still the active one
    await expect(firstLineHighlights(window)).toHaveCount(0);
  });

  test('keeps the snippet and card linked to the PDF, highlighted and with their context, when it is renamed and Obsidian is told not to update links', async () => {
    await snipAndCardInPlainTab(window);
    await askBeforeUpdatingLinks(window);
    const renamed = 'sources/Renamed fixture.pdf';

    await renameDecliningLinkUpdate(window, PDF_PATH, renamed);

    // The alias that was its name takes the new one
    const source =
      `[[Renamed fixture.pdf#page=1&selection=2,0,2,${FIRST_LINE.length}` +
      '|Renamed fixture, page 1]]';
    await expect
      .poll(async () => (await snippets(window)).map((s) => s.source))
      .toEqual([source]);
    await expect
      .poll(async () => (await cards(window)).map((c) => c.source))
      .toEqual([source]);
    // Read again, by their links, in a tab opened on it afresh
    await openFileInActiveLeaf(window, 'sources/Security Principles.md');
    await openFileInActiveLeaf(window, renamed);
    await expect(firstLineHighlights(window)).not.toHaveCount(0);

    const [snippet] = await snippets(window);
    await goToContextFrom(window, snippet.reference);
    await expect
      .poll(() =>
        window.evaluate(() => {
          const { app } = window as unknown as {
            app: {
              workspace: {
                activeLeaf: {
                  view: { getViewType(): string; file?: { path: string } };
                };
              };
            };
          };
          const { view } = app.workspace.activeLeaf;
          return [view.getViewType(), view.file?.path];
        })
      )
      .toEqual(['pdf', renamed]);
  });

  // #endregion

  // #region CARD HIGHLIGHTS

  /** The card highlights over `scope`, as [reference, text] pairs. */
  const cardHighlightsIn = (scope: Locator) =>
    highlightsIn(scope, 'ir-card-highlight');

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

  test('highlights a card made in review in orange at once, as its embed is tinted, beside a snippet that stays yellow, and a click on it opens the card', async () => {
    await importFixture(window);
    await beginReview(window);
    await expect(textItem(window, 1, 9)).toBeAttached();
    await selectChars(window, [1, 9, 2], [1, 9, 12]);
    await expect.poll(() => viewerSelection(window)).not.toBeNull();
    await window.getByRole('button', { name: 'Create snippet' }).click();
    await expect.poll(() => snippets(window)).toHaveLength(1);
    const [snippet] = await snippets(window);

    const card = await cardInReview(
      window,
      [1, 2, 0],
      [1, 2, FIRST_LINE.length],
      'long text'
    );

    await expect
      .poll(() => cardHighlightsIn(textItem(window, 1, 2)))
      .toEqual([[card.reference, FIRST_LINE]]);
    // Seen over the page as the card's embed tint and a markdown highlight
    // are seen over a note
    const cardBox = itemBoxes(article(window), 1, 2, 'ir-card-highlight');
    expect(await seenOverWhite(cardBox)).toEqual(
      await seenOverWhite(cardBox, 'var(--ir-transclusion-tint)')
    );
    const snippetBox = itemBoxes(article(window), 1, 9);
    expect(await cardHighlightsIn(textItem(window, 1, 9))).toEqual([]);
    expect(await highlightsIn(textItem(window, 1, 9))).toEqual([
      [
        snippet.reference,
        (await itemText(article(window), 1, 9))!.slice(2, 12),
      ],
    ]);
    expect(await seenOverWhite(snippetBox)).toEqual(
      await seenOverWhite(snippetBox, 'var(--ir-snippet-highlight-color)')
    );
    expect(await seenOverWhite(snippetBox)).not.toEqual(
      await seenOverWhite(cardBox)
    );

    await clickOn(window, cardBox);
    await expect.poll(() => openFiles(window)).toContain(card.reference);
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
    await expect.poll(() => cards(window)).toEqual([]);
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

  test('highlights a card carried over a page break on its first page, to its foot', async () => {
    await importFixture(window);
    await beginReview(window);
    await pdfPage(window, 2).scrollIntoViewIfNeeded();
    await expect(textItem(window, 2, 3)).toBeAttached();
    await expect(textItem(window, 1, 9)).toBeAttached();

    const card = await cardInReview(window, [1, 9, 0], [2, 3, 30], 'paragraph');

    await expect
      .poll(() => cardHighlightsIn(textItem(window, 1, 9)))
      .toEqual([[card.reference, await itemText(article(window), 1, 9)]]);
    expect(await cardHighlightsIn(textItem(window, 1, 8))).toEqual([]);
    expect(await cardHighlightsIn(pdfPage(window, 2))).toEqual([]);
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
    await expect
      .poll(() => cardHighlightsIn(textItem(window, 1, 2)))
      .toEqual([[reference, FIRST_LINE]]);
  });

  test('highlights a card made in the tab of a PDF that is no article, there, and keeps it once the PDF is imported', async () => {
    await snipAndCardInPlainTab(window);
    const [card] = await cards(window);
    const [snippet] = await snippets(window);
    await expect.poll(async () => (await cards(window))[0].source).toBeTruthy();

    // The snippet was made of the very same line: on that tie the card goes
    // over it
    await expect
      .poll(() => cardHighlightsIn(tabItem(window, 1, 2)))
      .toEqual([[card.reference, FIRST_LINE]]);
    expect(await highlightsIn(tabItem(window, 1, 2))).toEqual([
      [snippet.reference, FIRST_LINE],
      [card.reference, FIRST_LINE],
    ]);

    await executeCommandById(window, 'incremental-reading:import-article');
    await finalizeArticleImport(window);
    await expect.poll(() => articleRows(window)).toHaveLength(1);
    const id = await articleId(window);
    await expect
      .poll(async () => (await cards(window)).map((c) => c.parent))
      .toEqual([id]);
    await expect
      .poll(() => cardHighlightsIn(tabItem(window, 1, 2)))
      .toEqual([[card.reference, FIRST_LINE]]);
  });

  // #endregion

  // #region HOVER

  /** The middle of `box` on screen. */
  async function middleOf(box: Locator) {
    const { x, y, width, height } = (await box.boundingBox())!;
    return { x: x + width / 2, y: y + height / 2 };
  }

  /**
   * What the mouse shows at (`x`, `y`): the cursor of what is on top there,
   * and each highlight box marked as hovered, as [reference, ring], its ring
   * the box shadow it has.
   */
  const hoverAt = (page: Page, { x, y }: { x: number; y: number }) =>
    page.evaluate(
      ([x, y]) => ({
        cursor: getComputedStyle(document.elementFromPoint(x, y)!).cursor,
        hovered: Array.from(
          document.querySelectorAll<HTMLElement>('.ir-hovered'),
          (box) => [box.dataset.snippetRef, getComputedStyle(box).boxShadow]
        ),
      }),
      [x, y]
    );

  /** The box shadow a box in the document's body painted with `shadow` has. */
  const shadowOf = (page: Page, shadow: string) =>
    page.evaluate((shadow) => {
      const probe = document.body.appendChild(document.createElement('div'));
      probe.style.boxShadow = shadow;
      const seen = getComputedStyle(probe).boxShadow;
      probe.remove();
      return seen;
    }, shadow);

  /** Every text layer's markup in the document, to tell it was left alone. */
  const textLayers = (page: Page) =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('.textLayer'), (el) => el.outerHTML)
    );

  test("rings the highlight under the mouse with a pointer, a card's in the card colour, in review and in the PDF's tab, and clears both off it, writing nothing into the text layer", async () => {
    await importFixture(window);
    await beginReview(window);
    await expect(textItem(window, 1, 9)).toBeAttached();
    await selectChars(window, [1, 9, 2], [1, 9, 12]);
    await expect.poll(() => viewerSelection(window)).not.toBeNull();
    await window.getByRole('button', { name: 'Create snippet' }).click();
    await expect.poll(() => snippets(window)).toHaveLength(1);
    const [snippet] = await snippets(window);
    const card = await cardInReview(
      window,
      [1, 2, 0],
      [1, 2, FIRST_LINE.length],
      'long text'
    );
    await window.evaluate(() => document.getSelection()!.removeAllRanges());
    const snippetBox = itemBoxes(article(window), 1, 9);
    const cardBox = itemBoxes(article(window), 1, 2, 'ir-card-highlight');
    await expect(cardBox).toHaveCount(1);
    const snippetRing = await shadowOf(
      window,
      '0 0 0 2px var(--ir-snippet-highlight-border-color-hover-pdf)'
    );
    const cardRing = await shadowOf(
      window,
      '0 0 0 2px var(--ir-transclusion-rule-color)'
    );
    // A colour that fails to resolve leaves no ring at all, on the probe and
    // the box alike
    expect(snippetRing).not.toBe('none');
    expect(cardRing).not.toBe(snippetRing);
    const layers = await textLayers(window);

    const onSnippet = await middleOf(snippetBox);
    await window.mouse.move(onSnippet.x, onSnippet.y);
    await expect
      .poll(() => hoverAt(window, onSnippet))
      .toEqual({
        cursor: 'pointer',
        hovered: [[snippet.reference, snippetRing]],
      });

    const onCard = await middleOf(cardBox);
    await window.mouse.move(onCard.x, onCard.y);
    await expect
      .poll(() => hoverAt(window, onCard))
      .toEqual({ cursor: 'pointer', hovered: [[card.reference, cardRing]] });

    // The end of item 9, past the snippet
    const item = (await textItem(window, 1, 9).boundingBox())!;
    const box = (await snippetBox.boundingBox())!;
    const plain = { x: item.x + item.width - 2, y: onSnippet.y };
    expect(plain.x).toBeGreaterThan(box.x + box.width);
    await window.mouse.move(plain.x, plain.y);
    await expect
      .poll(() => hoverAt(window, plain))
      .toEqual({ cursor: 'text', hovered: [] });
    expect(await textLayers(window)).toEqual(layers);

    // The PDF's own tab
    await window
      .locator('.workspace-tab-header', { hasText: 'PDF fixture' })
      .first()
      .click();
    const tab = window.locator('.workspace-leaf.mod-active .pdf-container');
    const tabBox = itemBoxes(tab, 1, 9);
    await expect(tabBox).toHaveCount(1);
    const onTabSnippet = await middleOf(tabBox);
    await window.mouse.move(onTabSnippet.x, onTabSnippet.y);
    await expect
      .poll(() => hoverAt(window, onTabSnippet))
      .toEqual({
        cursor: 'pointer',
        hovered: [[snippet.reference, snippetRing]],
      });
    // Out of the window's content, past the tab's header
    await window.mouse.move(onTabSnippet.x, 5);
    await expect
      .poll(() => hoverAt(window, onTabSnippet))
      .toEqual({ cursor: 'text', hovered: [] });
  });

  /**
   * Record, from now on, every change to a box's hover ring made while a
   * mouse button is down.
   */
  const watchHoverWhilePressed = (page: Page) =>
    page.evaluate(() => {
      const root = document.querySelector('.ir-pdf-article')!;
      const w = window as unknown as { __irHoverChanges: string[] };
      w.__irHoverChanges = [];
      let pressed = false;
      // Before the plugin's own listeners, which are on the container
      document.addEventListener('pointerdown', () => (pressed = true), true);
      document.addEventListener('pointerup', () => (pressed = false), true);
      new MutationObserver((records) => {
        for (const { target, oldValue } of records) {
          const now = (target as Element).className;
          if (pressed && /ir-hovered/.test(`${oldValue} ${now}`)) {
            w.__irHoverChanges.push(`${oldValue} -> ${now}`);
          }
        }
      }).observe(root, {
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
        attributeOldValue: true,
      });
    });
  /** What {@link watchHoverWhilePressed} has recorded since it last read. */
  const hoverChangesWhilePressed = (page: Page) =>
    page.evaluate(() => {
      const w = window as unknown as { __irHoverChanges: string[] };
      return w.__irHoverChanges.splice(0);
    });

  test('keeps the hover as it is through a drag across a highlighted line, from it or from the margin, with the text cursor; selects as before; and follows the mouse again once let go', async () => {
    await reviewWithFirstLineSnippet(window);
    const item = (await textItem(window, 1, 2).boundingBox())!;
    const y = item.y + item.height / 2;
    const start = { x: item.x + 1, y };
    const middle = { x: item.x + item.width / 2, y };
    // Past the line's end, off the highlight
    const past = { x: item.x + item.width + 30, y };
    await window.mouse.move(start.x, start.y);
    await expect
      .poll(async () => (await hoverAt(window, start)).hovered)
      .toHaveLength(1);
    await watchHoverWhilePressed(window);

    // From the highlight
    await window.mouse.down();
    await window.mouse.move(middle.x, middle.y, { steps: 8 });
    // Ringed still, but the text cursor while selecting
    expect(await hoverAt(window, middle)).toMatchObject({
      cursor: 'text',
      hovered: [expect.anything()],
    });
    await window.mouse.move(past.x, past.y, { steps: 8 });
    expect(await hoverChangesWhilePressed(window)).toEqual([]);
    await window.mouse.up();
    await expect
      .poll(() => viewerSelection(window))
      .toMatch(/^Incremental reading turns a long text/);
    // Let go, the mouse at rest off the box: the ring goes
    await expect
      .poll(() => hoverAt(window, past))
      .toEqual({ cursor: expect.not.stringMatching('pointer'), hovered: [] });
    // Back on the box, the selection still standing: ring and pointer
    await window.mouse.move(middle.x, middle.y);
    await expect
      .poll(() => hoverAt(window, middle))
      .toMatchObject({ cursor: 'pointer', hovered: [expect.anything()] });

    // From the margin beside the line, across it and past its end. (The e2e
    // setup's own viewer may select nothing from a margin, plugin or not:
    // task 0046. Only the hover is checked here.)
    const margin = { x: item.x - 12, y };
    await window.mouse.move(margin.x, margin.y);
    await expect
      .poll(async () => (await hoverAt(window, margin)).hovered)
      .toEqual([]);
    await window.mouse.down();
    await window.mouse.move(middle.x, middle.y, { steps: 8 });
    await window.mouse.move(past.x, past.y, { steps: 8 });
    expect(await hoverChangesWhilePressed(window)).toEqual([]);
    await window.mouse.up();
  });

  test('rings the box now under the mouse after a zoom, the mouse at rest or moving', async () => {
    await reviewWithFirstLineSnippet(window);
    const box = itemBoxes(article(window), 1, 2);
    const at = await middleOf(box);
    await window.mouse.move(at.x, at.y);
    await expect
      .poll(async () => (await hoverAt(window, at)).hovered)
      .toHaveLength(1);

    /** Whether `point` is over the box now, as the page lays it out. */
    const overBox = async ({ x, y }: { x: number; y: number }) => {
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
    await expect
      .poll(async () => (await hoverAt(window, end)).hovered)
      .toHaveLength(1);
    await article(window)
      .locator('[aria-label="Zoom out"]')
      .evaluate((button) => (button as HTMLElement).click());
    await settled(window);
    expect(await overBox(end)).toBe(false);
    await expect
      .poll(async () => (await hoverAt(window, end)).hovered)
      .toEqual([]);

    // Moving: from the toolbar, then onto the box where it is now, and past
    // its end
    await article(window).locator('[aria-label="Zoom in"]').click();
    await settled(window);
    const middle = await middleOf(box);
    await window.mouse.move(middle.x, middle.y);
    await expect
      .poll(() => hoverAt(window, middle))
      .toMatchObject({ cursor: 'pointer' });
    const now = (await box.boundingBox())!;
    const past = { x: now.x + now.width + 4, y: middle.y };
    await window.mouse.move(past.x, past.y);
    await expect
      .poll(async () => (await hoverAt(window, past)).hovered)
      .toEqual([]);
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
