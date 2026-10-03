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

    // Cards aren't there yet, and say so, from the button and from the
    // command alike
    const notices = await watchNotices(window);
    await window.getByRole('button', { name: 'Create card' }).click();
    await executeCommandById(window, 'incremental-reading:create-card');
    await expect
      .poll(notices)
      .toEqual([
        "Cards from PDFs aren't supported yet",
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

test.describe('Snippets from a PDF article', () => {
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

    await expect
      .poll(notices)
      .toEqual(['No selectable text', 'No selectable text']);
    expect(await snippets(window)).toEqual([]);
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
});
