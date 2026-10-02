// @vitest-environment jsdom
import { DEFAULT_SETTINGS } from '#/lib/settings';
import type IncrementalReadingPlugin from '#/main';
import fc from 'fast-check';
import type { TFile } from 'obsidian';
import { act } from 'preact/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { ImportModal } from './ImportModal';

// #region HELPERS
function makePlugin(copyOnImport = DEFAULT_SETTINGS.copyOnImport) {
  const importArticle = vi.fn(() => Promise.resolve(null));
  const plugin = {
    app: {},
    settings: { ...DEFAULT_SETTINGS, copyOnImport },
    reviewManager: { importArticle },
  } as unknown as IncrementalReadingPlugin;
  return { plugin, importArticle };
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

function confirm(modal: ImportModal) {
  const button = [...modal.contentEl.querySelectorAll('button')].find(
    (el) => el.textContent === 'Confirm'
  );
  if (!button) throw new Error('no Confirm button');
  button.click();
}
// #endregion

describe('ImportModal', () => {
  it('titles itself with the quoted basename of the file being imported', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (basename) => {
        const modal = new ImportModal(makePlugin().plugin, makeFile(basename));
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
          const modal = new ImportModal(plugin, file, defaultCopy);
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
        const modal = new ImportModal(plugin, file, initial);
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
          const modal = new ImportModal(plugin, file, defaultCopy);
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
});
