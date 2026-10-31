import * as ConfirmModalModule from '#/views/ConfirmModal';
import fc from 'fast-check';
import type { App, TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { askToReassociate, type PathHolder } from './reassociate-prompt';

// #region HELPERS

/** A snippet or card row at a note's path, reviewed or never. */
const holderArb: fc.Arbitrary<PathHolder> = fc.record({
  table: fc.constantFrom('snippet' as const, 'srs_card' as const),
  id: fc.uuid(),
  deleted: fc.boolean(),
  // Any moment a review can be stamped with, the epoch's own among them
  lastReview: fc.option(fc.integer({ min: 0, max: 8_640_000_000_000 }), {
    nil: null,
  }),
});

/** A day as the queue writes it: `2026/7/10`, local time, no padding. */
const dayOf = (ms: number) => {
  const date = new Date(ms);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
};

/** Stub the confirmation, answering `answer`; reset per property case. */
function wirePrompt(answer: boolean) {
  vi.restoreAllMocks();
  return vi
    .spyOn(ConfirmModalModule, 'promptForConfirmation')
    .mockResolvedValue(answer);
}

// #endregion

describe('askToReassociate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks once, naming the note's path, the item's kind and the day it was last reviewed or that it never was, and answers what the user chose", async () => {
    await fc.assert(
      fc.asyncProperty(
        holderArb,
        fc.string({ minLength: 1 }),
        fc.boolean(),
        async (holder, path, answer) => {
          const prompt = wirePrompt(answer);
          const app = {} as App;
          const file = { path } as TFile;

          const answered = await askToReassociate(app, file, holder);

          expect(answered).toBe(answer);
          expect(prompt).toHaveBeenCalledOnce();
          const [askedApp, options] = prompt.mock.calls[0];
          expect(askedApp).toBe(app);
          const text = [options.title, ...options.paragraphs].join('\n');
          expect(text).toContain(`"${path}"`);
          const kind = holder.table === 'snippet' ? 'snippet' : 'card';
          const other = holder.table === 'snippet' ? 'card' : 'snippet';
          expect(text).toContain(kind);
          expect(text.replace(path, '')).not.toContain(other);
          expect(text).toContain(
            holder.lastReview === null ? 'never' : dayOf(holder.lastReview)
          );
          if (holder.lastReview !== null) {
            expect(text.replace(path, '')).not.toContain('never');
          }
          expect(options.destructive).toBeFalsy();
        }
      )
    );
  });

  it('says a deleted item is deleted, and a live one is not', async () => {
    for (const deleted of [true, false]) {
      const prompt = wirePrompt(true);
      await askToReassociate({} as App, { path: 'n.md' } as TFile, {
        table: 'snippet',
        id: 'i',
        deleted,
        lastReview: null,
      });
      const [, options] = prompt.mock.calls[0];
      const text = [options.title, ...options.paragraphs].join('\n');
      expect(text.includes('deleted')).toBe(deleted);
    }
  });
});
