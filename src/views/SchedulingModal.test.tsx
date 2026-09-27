// @vitest-environment jsdom
import { DEFAULT_SETTINGS } from '#/lib/settings';
import type { ReviewText } from '#/lib/types';
import type IncrementalReadingPlugin from '#/main';
import fc from 'fast-check';
import type { TFile } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { SchedulingModal } from './SchedulingModal';

// #region HELPERS
function makePlugin() {
  return {
    app: {},
    settings: { ...DEFAULT_SETTINGS },
  } as unknown as IncrementalReadingPlugin;
}

function makeItem(type: 'article' | 'snippet', basename: string): ReviewText {
  return {
    data: {
      id: 'item-id',
      type,
      reference: `folder/${basename}.md`,
      priority: 30,
      ...(type === 'article' ? { fixed_interval_days: null } : {}),
    },
    file: { basename, path: `folder/${basename}.md` } as TFile,
  } as unknown as ReviewText;
}
// #endregion

describe('SchedulingModal', () => {
  it("titles itself with the basename of the item's note", () => {
    fc.assert(
      fc.property(
        fc.constantFrom('article' as const, 'snippet' as const),
        fc.string({ minLength: 1 }),
        (type, basename) => {
          const modal = new SchedulingModal(
            makePlugin(),
            makeItem(type, basename)
          );
          modal.onOpen();
          try {
            expect(modal.titleEl.textContent).toBe(basename);
          } finally {
            modal.onClose();
          }
        }
      ),
      { numRuns: 20 }
    );
  });
});
