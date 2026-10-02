import { PDF_PAGE_STRIDE } from '#/lib/pdf/position';
import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  emulateMobile,
  executeCommandById,
  finalizeArticleImport,
  openFileInActiveLeaf,
  REVIEW_VIEW_TYPE,
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

/** Import the fixture in place, from its own PDF tab. */
async function importFixture(page: Page) {
  await openFileInActiveLeaf(page, PDF_PATH);
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
      }, PDF_PATH)
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

    // Snippets and cards aren't there yet, and say so, from the buttons and
    // from their commands alike
    const notices = await watchNotices(window);
    await window.getByRole('button', { name: 'Create snippet' }).click();
    await window.getByRole('button', { name: 'Create card' }).click();
    await executeCommandById(window, 'incremental-reading:extract-selection');
    await executeCommandById(window, 'incremental-reading:create-card');
    await expect
      .poll(notices)
      .toEqual([
        "Snippets from PDFs aren't supported yet",
        "Cards from PDFs aren't supported yet",
        "Snippets from PDFs aren't supported yet",
        "Cards from PDFs aren't supported yet",
      ]);

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

  /** Expect the view at `expected`, give or take a sliver of a page. */
  async function expectAt(
    page: Page,
    expected: { page: number; fraction: number }
  ) {
    await expect
      .poll(async () => {
        const at = await readingPosition(page);
        return (
          at !== null &&
          at.page === expected.page &&
          Math.abs(at.fraction - expected.fraction) < 0.02
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
    await window.setViewportSize({ width: 1280, height: 800 });

    await showItem(window, pdfId);
    await expectAt(window, stopped);
  });
});
