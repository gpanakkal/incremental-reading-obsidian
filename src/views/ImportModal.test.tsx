// @vitest-environment jsdom
import { DEFAULT_SETTINGS } from '#/lib/settings';
import type { WebPage } from '#/lib/web-viewer';
import type IncrementalReadingPlugin from '#/main';
import fc from 'fast-check';
import type { TFile } from 'obsidian';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImportModal, type ImportSubject } from './ImportModal';

// #region HELPERS
function makePlugin(copyOnImport = DEFAULT_SETTINGS.copyOnImport) {
  const importArticle = vi.fn(() => Promise.resolve(null));
  const importWebPage = vi.fn(() => Promise.resolve(null));
  const plugin = {
    app: {},
    settings: { ...DEFAULT_SETTINGS, copyOnImport },
    reviewManager: { importArticle, importWebPage },
  } as unknown as IncrementalReadingPlugin;
  return { plugin, importArticle, importWebPage };
}

/** The dialog for importing `file`, its copy toggle starting at `defaultCopy`. */
function fileSubject(file: TFile, defaultCopy?: boolean): ImportSubject {
  return { kind: 'file', file, defaultCopyOnImport: defaultCopy };
}

function makePage(title = 'Page'): WebPage {
  return { title, markdown: 'Text', url: 'https://example.com/page' };
}

const pageArb = fc.record({
  title: fc.string(),
  markdown: fc.string(),
  url: fc.option(fc.webUrl(), { nil: null }),
});

/** Whether `promise` has settled by the time pending callbacks have run. */
async function hasSettled(promise: Promise<unknown>) {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true)
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return settled;
}

/** Make `modal.close()` call `onClose`, as Obsidian's does. */
function closeLikeObsidian(modal: ImportModal) {
  vi.spyOn(modal, 'close').mockImplementation(() => modal.onClose());
}

function makeFile(basename: string, extension = 'md') {
  return {
    basename,
    extension,
    path: `folder/${basename}.${extension}`,
  } as TFile;
}

/** The "Make a copy" toggle, if the modal offers one. */
function copyToggle(modal: ImportModal) {
  const label = [...modal.contentEl.querySelectorAll('label')].find((el) =>
    el.textContent?.includes('Make a copy')
  );
  return label?.querySelector('input') ?? null;
}

function clickButton(modal: ImportModal, text: string) {
  const button = [...modal.contentEl.querySelectorAll('button')].find(
    (el) => el.textContent === text
  );
  if (!button) throw new Error(`no ${text} button`);
  button.click();
}

function confirm(modal: ImportModal) {
  clickButton(modal, 'Confirm');
}
// #endregion

describe('ImportModal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('titles itself with the quoted basename of the file being imported', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (basename) => {
        const modal = new ImportModal(
          makePlugin().plugin,
          fileSubject(makeFile(basename))
        );
        modal.onOpen();
        try {
          expect(modal.titleEl.textContent).toBe(`Importing "${basename}"`);
        } finally {
          modal.onClose();
        }
      }),
      { numRuns: 20 }
    );
  });

  it('offers a copy of a note, starting from the setting or the caller', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.option(fc.boolean(), { nil: undefined }),
        (copyOnImport, defaultCopy) => {
          const { plugin, importArticle } = makePlugin(copyOnImport);
          const file = makeFile('note');
          const modal = new ImportModal(plugin, fileSubject(file, defaultCopy));
          modal.onOpen();
          try {
            expect(copyToggle(modal)?.checked).toBe(
              defaultCopy ?? copyOnImport
            );

            confirm(modal);

            expect(importArticle).toHaveBeenCalledExactlyOnceWith(
              file,
              plugin.settings.defaultPriority,
              null,
              defaultCopy ?? copyOnImport
            );
          } finally {
            modal.onClose();
          }
        }
      ),
      { numRuns: 20 }
    );
  });

  it('imports a note the way its toggle was last left', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.nat({ max: 3 }), (initial, flips) => {
        const { plugin, importArticle } = makePlugin();
        const file = makeFile('note');
        const modal = new ImportModal(plugin, fileSubject(file, initial));
        modal.onOpen();
        // jsdom only fires a checkbox's change event while it is in the page
        document.body.append(modal.contentEl);
        try {
          for (let i = 0; i < flips; i += 1) {
            // Each click re-renders before the next reads the toggle
            void act(() => {
              copyToggle(modal)?.click();
            });
          }

          confirm(modal);

          expect(importArticle).toHaveBeenCalledExactlyOnceWith(
            file,
            plugin.settings.defaultPriority,
            null,
            flips % 2 === 0 ? initial : !initial
          );
        } finally {
          modal.onClose();
          modal.contentEl.remove();
        }
      }),
      { numRuns: 20 }
    );
  });

  it('offers a copy of a PDF as of a note, starting from the setting or the caller', () => {
    fc.assert(
      fc.property(
        fc.mixedCase(fc.constant('pdf')),
        fc.boolean(),
        fc.option(fc.boolean(), { nil: undefined }),
        (extension, copyOnImport, defaultCopy) => {
          const { plugin, importArticle } = makePlugin(copyOnImport);
          const file = makeFile('paper', extension);
          const modal = new ImportModal(plugin, fileSubject(file, defaultCopy));
          modal.onOpen();
          try {
            expect(copyToggle(modal)?.checked).toBe(
              defaultCopy ?? copyOnImport
            );

            confirm(modal);

            expect(importArticle).toHaveBeenCalledExactlyOnceWith(
              file,
              plugin.settings.defaultPriority,
              null,
              defaultCopy ?? copyOnImport
            );
          } finally {
            modal.onClose();
          }
        }
      ),
      { numRuns: 20 }
    );
  });

  it('titles itself with the quoted title of the web page being imported', () => {
    fc.assert(
      fc.property(fc.string(), (title) => {
        const modal = new ImportModal(makePlugin().plugin, {
          kind: 'web',
          page: makePage(title),
        });
        modal.onOpen();
        try {
          expect(modal.titleEl.textContent).toBe(`Importing "${title}"`);
        } finally {
          modal.onClose();
        }
      }),
      { numRuns: 20 }
    );
  });

  it('offers no copy of a web page, importing it as a new note', () => {
    fc.assert(
      fc.property(pageArb, fc.boolean(), (page, copyOnImport) => {
        const { plugin, importArticle, importWebPage } =
          makePlugin(copyOnImport);
        const modal = new ImportModal(plugin, { kind: 'web', page });
        modal.onOpen();
        try {
          expect(copyToggle(modal)).toBeNull();

          confirm(modal);

          expect(importWebPage).toHaveBeenCalledExactlyOnceWith(
            page,
            plugin.settings.defaultPriority,
            null
          );
          expect(importArticle).not.toHaveBeenCalled();
        } finally {
          modal.onClose();
        }
      }),
      { numRuns: 20 }
    );
  });

  it('imports at the priority chosen, or at the default priority on the fixed interval chosen', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          pageArb.map((page) => ({ kind: 'web', page }) as const),
          fc.boolean().map((copy) => fileSubject(makeFile('note'), copy))
        ),
        fc.constantFrom('priority' as const, 'fixed-interval' as const),
        fc.integer(),
        fc.boolean(),
        async (subject, strategy, value, makeCopy) => {
          const { plugin, importArticle, importWebPage } = makePlugin();
          const modal = new ImportModal(plugin, subject);

          await modal.handleClose(strategy, value, makeCopy);

          const schedule =
            strategy === 'priority'
              ? [value, null]
              : [plugin.settings.defaultPriority, value];
          if (subject.kind === 'web') {
            expect(importWebPage).toHaveBeenCalledExactlyOnceWith(
              subject.page,
              ...schedule
            );
            expect(importArticle).not.toHaveBeenCalled();
          } else {
            expect(importArticle).toHaveBeenCalledExactlyOnceWith(
              subject.file,
              ...schedule,
              makeCopy
            );
            expect(importWebPage).not.toHaveBeenCalled();
          }
        }
      )
    );
  });

  it('imports nothing when cancelled, and is done once closed', async () => {
    for (const subject of [
      { kind: 'web', page: makePage() } as const,
      fileSubject(makeFile('note')),
    ]) {
      const { plugin, importArticle, importWebPage } = makePlugin();
      const modal = new ImportModal(plugin, subject);
      closeLikeObsidian(modal);
      modal.onOpen();

      expect(await hasSettled(modal.closed)).toBe(false);
      clickButton(modal, 'Cancel');

      expect(await hasSettled(modal.closed)).toBe(true);
      expect(importArticle).not.toHaveBeenCalled();
      expect(importWebPage).not.toHaveBeenCalled();
    }
  });

  it('is done only once closed and the import it started has finished', async () => {
    // Closed by its own confirm, or by Esc while the import runs
    for (const closedEarly of [false, true]) {
      const { plugin, importWebPage } = makePlugin();
      let finishImport = (): void => undefined;
      importWebPage.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishImport = () => resolve(null);
          })
      );
      const modal = new ImportModal(plugin, { kind: 'web', page: makePage() });
      closeLikeObsidian(modal);
      modal.onOpen();

      confirm(modal);
      if (closedEarly) modal.close();

      expect(await hasSettled(modal.closed)).toBe(false);
      finishImport();
      expect(await hasSettled(modal.closed)).toBe(true);
      expect(importWebPage).toHaveBeenCalledOnce();
    }
  });

  it('imports once, however often it is confirmed while the import runs', async () => {
    // Enter held down, or Confirm clicked twice: each would be a second note
    // for a web page
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          pageArb.map((page) => ({ kind: 'web', page }) as const),
          fc.boolean().map((copy) => fileSubject(makeFile('note'), copy))
        ),
        fc.integer({ min: 2, max: 5 }),
        async (subject, confirms) => {
          const { plugin, importArticle, importWebPage } = makePlugin();
          const finishes: (() => void)[] = [];
          const pending = () =>
            new Promise<null>((resolve) => {
              finishes.push(() => resolve(null));
            });
          importArticle.mockImplementation(pending);
          importWebPage.mockImplementation(pending);
          const modal = new ImportModal(plugin, subject);
          closeLikeObsidian(modal);
          modal.onOpen();

          for (let i = 0; i < confirms; i += 1) confirm(modal);
          for (const finish of finishes) finish();

          expect(await hasSettled(modal.closed)).toBe(true);
          expect(
            importArticle.mock.calls.length + importWebPage.mock.calls.length
          ).toBe(1);
        }
      ),
      { numRuns: 20 }
    );
  });
});
