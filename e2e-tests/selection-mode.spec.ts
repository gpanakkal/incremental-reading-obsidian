import test, {
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import * as fs from 'node:fs/promises';
import {
  emulateMobile,
  executeCommandById,
  importArticle,
  reviewTitle,
  selectParagraph,
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

test.beforeEach(async () => {
  vaultPath = await createVaultCopy('core');
  app = await launchElectron(vaultPath);
  window = await openVault(app, vaultPath);

  // Renderer dialogs are answered by `launchElectron`, for every window rather
  // than just this one. Re-registering here would answer each dialog twice —
  // and answer `beforeunload` with "stay open", which is the opposite of what
  // teardown needs.
});

test.afterEach(async () => {
  if (app) await closeElectron(app);
  if (shouldCleanup) {
    // Best-effort. On Windows a surviving Electron child can still hold a
    // handle inside the vault, and an EBUSY here would fail an otherwise
    // passing test during cleanup. The vault dir is disposable — the next run
    // makes a fresh copy — so a leftover is not worth failing over.
    await fs
      .rm(vaultPath, { recursive: true, force: true, maxRetries: 3 })
      .catch(() => {});
  }
});

test.describe('Selection mode', () => {
  /** The title the article below is imported under. */
  const TITLE = 'Security Principles';
  /** The start of the paragraph these tests extract, whole, from it. */
  const PARAGRAPH =
    'Before we start discussing the different security principles, it is ' +
    'vital to know the adversary against whom we are protecting our assets.';
  /** The word inside it the card tests hide as the answer. */
  const ANSWER = 'adversary';

  /** Import the article and put review on it. */
  async function reviewArticle() {
    await importArticle(window, 'sources/Security Principles');
    await executeCommandById(window, 'incremental-reading:learn');
    await window.locator('css=#begin-review-button').click();
    await expect(reviewTitle(window, TITLE)).toBeVisible();
  }

  const confirmButton = () => window.locator('#confirm-selection-button');
  const cancelButton = () => window.locator('#cancel-selection-button');
  const reviewContent = () =>
    window.locator(`.workspace-leaf.mod-active .ir-editor .cm-content`);

  /**
   * Wait for the review editor to take typing or not, as its content DOM says.
   * Polled: the editor is reconfigured from an effect, after the bar repaints.
   */
  const expectEditable = (editable: boolean) =>
    expect(reviewContent()).toHaveAttribute('contenteditable', `${editable}`);

  /** The text of every note under the data directory's `folder`. */
  const notesIn = (folder: string) =>
    window.evaluate(async (folder) => {
      const { vault } = (
        window as unknown as {
          app: {
            vault: {
              getMarkdownFiles(): { path: string }[];
              cachedRead(file: { path: string }): Promise<string>;
            };
          };
        }
      ).app;
      const files = vault
        .getMarkdownFiles()
        .filter((file) =>
          file.path.startsWith(`incremental-reading/${folder}/`)
        );
      return Promise.all(files.map((file) => vault.cachedRead(file)));
    }, folder);

  /** The note the review tab is showing, as it is on disk. */
  const reviewedNote = () =>
    window.evaluate(async () => {
      const { app } = window as unknown as {
        app: {
          workspace: {
            getLeavesOfType(type: string): { view: { file: unknown } }[];
          };
          vault: { read(file: unknown): Promise<string> };
        };
      };
      const [leaf] = app.workspace.getLeavesOfType(
        'incremental-reading-review'
      );
      return app.vault.read(leaf.view.file);
    });

  test('makes a snippet at once of text selected before the button is pressed', async () => {
    await reviewArticle();
    await selectParagraph(window, PARAGRAPH);

    await window.getByRole('button', { name: 'Create snippet' }).click();

    await expect(confirmButton()).toHaveCount(0);
    await expect.poll(() => notesIn('snippets')).toHaveLength(1);
  });

  for (const command of ['extract-selection', 'create-card'] as const) {
    test(`enters the mode from the ${command} command with nothing selected`, async () => {
      await reviewArticle();

      await executeCommandById(window, `incremental-reading:${command}`);

      await expect(confirmButton()).toBeVisible();
      await expectEditable(false);
      expect(await notesIn('snippets')).toEqual([]);
      expect(await notesIn('cards')).toEqual([]);
    });
  }

  test('makes a snippet at once from the command with text selected', async () => {
    await reviewArticle();
    await selectParagraph(window, PARAGRAPH);

    await executeCommandById(window, 'incremental-reading:extract-selection');

    await expect
      .poll(() => notesIn('snippets'))
      .toEqual([expect.stringContaining(PARAGRAPH)]);
    await expect(confirmButton()).toHaveCount(0);
  });

  test('extracts the text selected in the mode to a snippet', async () => {
    await reviewArticle();

    await window.getByRole('button', { name: 'Create snippet' }).click();

    await expect(confirmButton()).toBeVisible();
    await expect(cancelButton()).toBeVisible();
    await expect(
      window.getByRole('button', { name: 'Mark reviewed' })
    ).toHaveCount(0);
    await expectEditable(false);

    await selectParagraph(window, PARAGRAPH);
    await confirmButton().click();

    await expect
      .poll(() => notesIn('snippets'))
      .toEqual([expect.stringContaining(PARAGRAPH)]);
    await expect(
      window.getByRole('button', { name: 'Mark reviewed' })
    ).toBeVisible();
    await expect(confirmButton()).toHaveCount(0);
    await expectEditable(true);
  });

  test('leaves nothing selected after extracting a snippet in the mode', async () => {
    /** What is selected on screen, and whether the review editor's is empty. */
    const selectionLeft = () =>
      window.evaluate(() => {
        const { app } = window as unknown as {
          app: {
            workspace: {
              getLeavesOfType(type: string): {
                view: {
                  reviewEditor(): {
                    cm: { state: { selection: { main: { empty: boolean } } } };
                  } | null;
                };
              }[];
            };
          };
        };
        const [leaf] = app.workspace.getLeavesOfType(
          'incremental-reading-review'
        );
        return {
          onScreen: document.getSelection()?.toString() ?? '',
          editorEmpty:
            leaf.view.reviewEditor()?.cm.state.selection.main.empty ?? null,
        };
      });

    await reviewArticle();
    await window.getByRole('button', { name: 'Create snippet' }).click();
    await selectParagraph(window, PARAGRAPH);
    await confirmButton().click();

    await expect.poll(() => notesIn('snippets')).toHaveLength(1);
    await expectEditable(true);
    // Editing comes back from an effect, after the snippet is made; the
    // selection must stay gone past that re-render, not just until it.
    await window.waitForTimeout(500);
    expect(await selectionLeft()).toEqual({ onScreen: '', editorEmpty: true });

    // A selection left in the editor's state is drawn again once it has focus,
    // even where the click on the button already cleared the browser's.
    await reviewContent().focus();
    await window.waitForTimeout(100);
    expect(await selectionLeft()).toEqual({ onScreen: '', editorEmpty: true });
  });

  /**
   * How much of the editor line holding `text` is painted as selected, from 0
   * to 1: the share of points sampled across the line that lie under a
   * visible highlight — either CodeMirror's drawn selection background or the
   * browser's own selection, when the text is selectable and its `::selection`
   * color is not transparent. Sampled rather than summed so overlapping highlight boxes don't count
   * twice.
   */
  const highlightedShare = (text: string) =>
    reviewContent().evaluate((content, text) => {
      const alpha = (color: string) => {
        if (color === 'transparent') return 0;
        const slash = /\/\s*([\d.]+%?)\s*\)$/.exec(color);
        if (slash) return parseFloat(slash[1]);
        if (color.startsWith('rgba(')) {
          return parseFloat(color.slice(color.lastIndexOf(',') + 1));
        }
        return 1;
      };
      const line = Array.from(content.querySelectorAll('.cm-line')).find((el) =>
        el.textContent?.includes(text)
      );
      if (!line) throw new Error(`no editor line holds "${text}"`);

      const highlights: DOMRect[] = [];
      const editor = content.closest('.cm-editor')!;
      for (const el of editor.querySelectorAll<HTMLElement>(
        '.cm-selectionLayer .cm-selectionBackground'
      )) {
        if (alpha(getComputedStyle(el).backgroundColor) > 0) {
          highlights.push(el.getBoundingClientRect());
        }
      }
      // The browser paints its own selection only over selectable text, with
      // the `::selection` color. The range is there even when it paints
      // nothing, so it can't be taken as a highlight on its own.
      const selection = document.getSelection();
      const lineStyle = getComputedStyle(line);
      const nativeColor = getComputedStyle(line, '::selection').backgroundColor;
      if (
        selection &&
        !selection.isCollapsed &&
        selection.rangeCount > 0 &&
        lineStyle.userSelect !== 'none' &&
        alpha(nativeColor) > 0
      ) {
        highlights.push(...selection.getRangeAt(0).getClientRects());
      }

      const box = line.getBoundingClientRect();
      const steps = 20;
      let covered = 0;
      let total = 0;
      for (let i = 0; i < steps; i++) {
        for (let j = 0; j < steps; j++) {
          const x = box.left + ((i + 0.5) / steps) * box.width;
          const y = box.top + ((j + 0.5) / steps) * box.height;
          total++;
          if (
            highlights.some(
              (r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
            )
          ) {
            covered++;
          }
        }
      }
      return covered / total;
    }, text);

  for (const platform of ['desktop', 'mobile'] as const) {
    test(`shows the text selected in the mode as selected (${platform})`, async () => {
      if (platform === 'mobile') await emulateMobile(window, true);
      await reviewArticle();
      await window.getByRole('button', { name: 'Create snippet' }).click();
      await expectEditable(false);

      await selectParagraph(window, PARAGRAPH);

      // Most of the paragraph: its last wrapped row stops short of the line's
      // right edge, so full coverage is out of reach.
      await expect.poll(() => highlightedShare(PARAGRAPH)).toBeGreaterThan(0.5);
    });
  }

  test('asks for text and stays in the mode when confirmed with nothing selected', async () => {
    await reviewArticle();
    const notices = await watchNotices(window);
    await window.getByRole('button', { name: 'Create snippet' }).click();

    await confirmButton().click();

    await expect.poll(notices).toEqual(['Select the text to extract first']);
    await expect(confirmButton()).toBeVisible();
    expect(await notesIn('snippets')).toEqual([]);
  });

  test('cancelling leaves the mode, unselects the text, and makes nothing', async () => {
    await reviewArticle();
    await window.getByRole('button', { name: 'Create snippet' }).click();
    await selectParagraph(window, PARAGRAPH);

    await cancelButton().click();

    await expect(
      window.getByRole('button', { name: 'Mark reviewed' })
    ).toBeVisible();
    await expectEditable(true);
    expect(
      await window.evaluate(() => document.getSelection()?.toString() ?? '')
    ).toBe('');
    expect(await notesIn('snippets')).toEqual([]);
  });

  test('Escape cancels the mode as the Cancel button does', async () => {
    await reviewArticle();
    await window.getByRole('button', { name: 'Create snippet' }).click();
    await expectEditable(false);
    await selectParagraph(window, PARAGRAPH);

    await window.keyboard.press('Escape');

    await expect(
      window.getByRole('button', { name: 'Mark reviewed' })
    ).toBeVisible();
    await expect(confirmButton()).toHaveCount(0);
    await expectEditable(true);
    expect(
      await window.evaluate(() => document.getSelection()?.toString() ?? '')
    ).toBe('');
    expect(await notesIn('snippets')).toEqual([]);
  });

  test('Escape closes the command palette over the mode, not the mode as well', async () => {
    await reviewArticle();
    await window.getByRole('button', { name: 'Create card' }).click();
    await expectEditable(false);
    await executeCommandById(window, 'command-palette:open');
    const palette = window.locator('.modal-container .prompt');
    await expect(palette).toBeVisible();

    await window.keyboard.press('Escape');

    await expect(palette).toHaveCount(0);
    await expect(confirmButton()).toBeVisible();
    await expectEditable(false);

    // With nothing open over it, the next Escape is the mode's.
    await window.keyboard.press('Escape');
    await expect(confirmButton()).toHaveCount(0);
    await expectEditable(true);
  });

  test('makes a card of the text selected in the mode, with the answer chosen in the modal', async () => {
    await reviewArticle();
    await window.getByRole('button', { name: 'Create card' }).click();
    await selectParagraph(window, PARAGRAPH);
    await confirmButton().click();

    const answerText = window.locator('.modal .ir-card-answer-text');
    await expect(answerText).toContainText(PARAGRAPH);
    // Standard mode is back behind the modal: the mode ended on confirming.
    await expect(confirmButton()).toHaveCount(0);

    await answerText.evaluate((el, answer) => {
      const node = el.firstChild as Text;
      const start = node.data.indexOf(answer);
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + answer.length);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, ANSWER);
    // `selectionchange` is dispatched as a task, not synchronously.
    await window.waitForTimeout(100);
    await window.keyboard.press('Enter');

    await expect(answerText).toHaveCount(0);
    await expect
      .poll(() => notesIn('cards'))
      .toEqual([expect.stringContaining(`(} ${ANSWER} {)`)]);
    await expect.poll(reviewedNote).toContain('![[');
    expect(await reviewedNote()).not.toContain(PARAGRAPH);
  });

  test('makes no card when the answer is not chosen', async () => {
    await reviewArticle();
    await window.getByRole('button', { name: 'Create card' }).click();
    await selectParagraph(window, PARAGRAPH);
    await confirmButton().click();
    const answerText = window.locator('.modal .ir-card-answer-text');
    await expect(answerText).toBeVisible();

    await window.keyboard.press('Escape');

    await expect(answerText).toHaveCount(0);
    expect(await notesIn('cards')).toEqual([]);
    expect(await reviewedNote()).toContain(PARAGRAPH);
    // The Escape was the modal's alone: review is back in the standard mode,
    // not sent anywhere else by the same key.
    await expect(
      window.getByRole('button', { name: 'Mark reviewed' })
    ).toBeVisible();
    await expect(confirmButton()).toHaveCount(0);
    await expectEditable(true);
  });

  test('confirms a snippet from its command in the mode', async () => {
    await reviewArticle();
    await window.getByRole('button', { name: 'Create snippet' }).click();
    await expectEditable(false);
    await selectParagraph(window, PARAGRAPH);

    await executeCommandById(window, 'incremental-reading:extract-selection');

    await expect
      .poll(() => notesIn('snippets'))
      .toEqual([expect.stringContaining(PARAGRAPH)]);
    await expect(confirmButton()).toHaveCount(0);
    await expectEditable(true);
  });

  test('stays in the mode when confirmed from the command with nothing selected', async () => {
    await reviewArticle();
    const notices = await watchNotices(window);
    await executeCommandById(window, 'incremental-reading:extract-selection');
    await expect(confirmButton()).toBeVisible();

    await executeCommandById(window, 'incremental-reading:extract-selection');

    await expect.poll(notices).toEqual(['Select the text to extract first']);
    await expect(confirmButton()).toBeVisible();
    expect(await notesIn('snippets')).toEqual([]);
  });

  test('confirms a card from its hotkey in the mode, asking for the answer', async () => {
    // Bound for this run only: the plugin ships the command without a hotkey.
    // `hotkeyManager` is undocumented Obsidian API.
    await window.evaluate(() => {
      const { app } = window as unknown as {
        app: {
          hotkeyManager: {
            addDefaultHotkeys(
              command: string,
              keys: { modifiers: string[]; key: string }[]
            ): void;
          };
        };
      };
      app.hotkeyManager.addDefaultHotkeys('incremental-reading:create-card', [
        { modifiers: ['Alt'], key: 'Z' },
      ]);
    });
    await reviewArticle();
    const notices = await watchNotices(window);
    await window.getByRole('button', { name: 'Create card' }).click();
    await expectEditable(false);
    await selectParagraph(window, PARAGRAPH);

    await window.keyboard.press('Alt+Z');

    const answerText = window.locator('.modal .ir-card-answer-text');
    await expect(answerText).toContainText(PARAGRAPH);
    await expect(confirmButton()).toHaveCount(0);
    // The key press that opened the modal is not also taken as its answer.
    await window.waitForTimeout(300);
    await expect(answerText).toBeVisible();
    expect(await notices()).toEqual([]);

    await answerText.evaluate((el, answer) => {
      const node = el.firstChild as Text;
      const start = node.data.indexOf(answer);
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + answer.length);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, ANSWER);
    // `selectionchange` is dispatched as a task, not synchronously.
    await window.waitForTimeout(100);
    await window.keyboard.press('Enter');

    await expect(answerText).toHaveCount(0);
    await expect
      .poll(() => notesIn('cards'))
      .toEqual([expect.stringContaining(`(} ${ANSWER} {)`)]);
  });

  for (const [mode, other] of [
    ['snippet', 'create-card'],
    ['card', 'extract-selection'],
  ] as const) {
    test(`refuses the ${other} command while selecting for a ${mode}`, async () => {
      await reviewArticle();
      await window
        .getByRole('button', {
          name: mode === 'snippet' ? 'Create snippet' : 'Create card',
        })
        .click();
      await expectEditable(false);
      await selectParagraph(window, PARAGRAPH);
      const notices = await watchNotices(window);

      await executeCommandById(window, `incremental-reading:${other}`);

      await expect
        .poll(notices)
        .toEqual([`Finish or cancel the ${mode} selection first`]);
      await expect(confirmButton()).toBeVisible();
      await expect(window.locator('.modal .ir-card-answer-text')).toHaveCount(
        0
      );
      expect(
        await window.evaluate(() => document.getSelection()?.toString() ?? '')
      ).toContain(PARAGRAPH);
      expect(await notesIn('snippets')).toEqual([]);
      expect(await notesIn('cards')).toEqual([]);
    });
  }

  test('is over when review comes back to the item through history', async () => {
    await reviewArticle();
    await window.getByRole('button', { name: 'Create card' }).click();
    await expect(confirmButton()).toBeVisible();

    await window.getByRole('button', { name: 'Go to home screen' }).click();
    await executeCommandById(window, 'app:go-back');

    await expect(reviewTitle(window, TITLE)).toBeVisible();
    await expect(
      window.getByRole('button', { name: 'Mark reviewed' })
    ).toBeVisible();
    await expect(confirmButton()).toHaveCount(0);
    await expectEditable(true);
  });
});
