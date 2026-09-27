// @vitest-environment jsdom
import { DEFAULT_SETTINGS } from '#/lib/settings';
import type IncrementalReadingPlugin from '#/main';
import fc from 'fast-check';
import type { TFile } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { ImportModal } from './ImportModal';

// #region HELPERS
function makePlugin() {
  return {
    app: {},
    settings: { ...DEFAULT_SETTINGS },
  } as unknown as IncrementalReadingPlugin;
}

function makeFile(basename: string) {
  return { basename, path: `folder/${basename}.md` } as TFile;
}
// #endregion

describe('ImportModal', () => {
  it('titles itself with the quoted basename of the file being imported', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (basename) => {
        const modal = new ImportModal(makePlugin(), makeFile(basename));
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
});
