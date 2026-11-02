import * as ConfirmModalModule from '#/views/ConfirmModal';
import fc from 'fast-check';
import type { App, TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PathHolder as RowAtPath } from './crash-leftovers';
import {
  askToReassociate,
  askToResolveHeld,
  type PathHolder,
} from './reassociate-prompt';

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

/** This device's id, as `getDeviceId` gives it. */
const THIS_DEVICE = 'this-device-0000';

/** Any moment a row can be stamped or scheduled at, the epoch's own among them. */
const momentArb = fc.integer({ min: 0, max: 8_640_000_000_000 });

/**
 * A row of any item table at a leftover's path, with whatever details it can
 * have: deleted or not, dismissed or not, reviewed or not, stamped by this
 * device, another, or none, and taken from an item or not, whose row has a
 * path or not.
 */
const rowAtPathArb: fc.Arbitrary<RowAtPath> = fc.record({
  kind: fc.constantFrom(
    'article' as const,
    'snippet' as const,
    'card' as const
  ),
  id: fc.uuid(),
  deleted: fc.boolean(),
  dismissed: fc.boolean(),
  due: fc.option(momentArb, { nil: null }),
  lastReview: fc.option(momentArb, { nil: null }),
  updatedAt: fc.oneof(fc.constant(0), momentArb),
  updatedBy: fc.oneof(fc.constant(''), fc.constant(THIS_DEVICE), fc.uuid()),
  parent: fc.option(
    fc.record({
      id: fc.uuid(),
      path: fc.option(fc.string({ minLength: 1 }), { nil: null }),
    }),
    { nil: null }
  ),
});

/** What the user answers the choice, and then the confirmation of an erase. */
const answersArb = fc.record({
  choice: fc.constantFrom(
    'confirm' as const,
    'alternative' as const,
    'cancel' as const
  ),
  sure: fc.boolean(),
});

/** Stub the choice and the confirmation after it; reset per property case. */
function wireChoice(choice: ConfirmModalModule.ConfirmChoice, sure: boolean) {
  vi.restoreAllMocks();
  return {
    ask: vi
      .spyOn(ConfirmModalModule, 'promptForChoice')
      .mockResolvedValue(choice),
    confirm: vi
      .spyOn(ConfirmModalModule, 'promptForConfirmation')
      .mockResolvedValue(sure),
  };
}

/** The text of a prompt's options, lists' lines included. */
const textOf = (options: ConfirmModalModule.ConfirmOptions) =>
  [options.title, ...options.paragraphs.flat()].join('\n');

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
          const file = { path, basename: 'n' } as TFile;

          const answered = await askToReassociate(app, file, holder);

          expect(answered).toBe(answer);
          expect(prompt).toHaveBeenCalledOnce();
          const [askedApp, options] = prompt.mock.calls[0];
          expect(askedApp).toBe(app);
          const text = textOf(options);
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
      await askToReassociate(
        {} as App,
        { path: 'n.md', basename: 'n' } as TFile,
        {
          table: 'snippet',
          id: 'i',
          deleted,
          lastReview: null,
        }
      );
      const [, options] = prompt.mock.calls[0];
      const text = textOf(options);
      expect(text.includes('deleted')).toBe(deleted);
    }
  });
});

describe('askToResolveHeld', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks once, showing the row's details, and answers re-associate, or erase only once that is confirmed, or nothing", async () => {
    await fc.assert(
      fc.asyncProperty(
        rowAtPathArb,
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        answersArb,
        async (holder, path, basename, { choice, sure }) => {
          const { ask, confirm } = wireChoice(choice, sure);
          const app = {} as App;
          const file = { path, basename } as TFile;

          const answered = await askToResolveHeld(
            app,
            file,
            holder,
            THIS_DEVICE
          );

          const expected =
            choice === 'confirm'
              ? 'reassociate'
              : choice === 'alternative' && sure
                ? 'erase'
                : null;
          expect(answered).toBe(expected);
          expect(ask).toHaveBeenCalledOnce();
          const [askedApp, options] = ask.mock.calls[0];
          expect(askedApp).toBe(app);
          expect(options.destructive).toBeFalsy();
          expect(options.alternative.destructive).toBe(true);
          const others = (['article', 'snippet', 'card'] as const).filter(
            (kind) => kind !== holder.kind
          );
          expect(options.title).toContain(`"${basename}"`);
          const title = options.title.replace(`"${basename}"`, '');
          expect(title).toContain(holder.kind);
          for (const other of others) {
            expect(title).not.toContain(other);
          }

          const text = textOf(options);
          expect(text).toContain(`"${path}"`);
          expect(text).toContain(holder.id);
          if (holder.due !== null) expect(text).toContain(dayOf(holder.due));
          expect(text).toContain(
            holder.lastReview === null ? 'never' : dayOf(holder.lastReview)
          );
          if (holder.updatedAt > 0) {
            expect(text).toContain(dayOf(holder.updatedAt));
          }
          // What is said of the same row with a path and ids that can't
          // read as anything else said, as any text can
          wireChoice('cancel', false);
          await askToResolveHeld(
            app,
            { path: 'n.md', basename: 'n' } as TFile,
            {
              ...holder,
              id: 'ID0',
              parent: holder.parent && {
                id: 'PID0',
                path: holder.parent.path && 'P0',
              },
            },
            THIS_DEVICE
          );
          const said = textOf(
            vi.mocked(ConfirmModalModule.promptForChoice).mock.calls[0][1]
          );
          expect(/deleted/.test(said)).toBe(
            holder.deleted || (!!holder.parent && holder.parent.path === null)
          );
          expect(/dismissed/i.test(said)).toBe(holder.dismissed);
          const stampedBy = holder.updatedAt > 0 ? holder.updatedBy : '';
          expect(said.includes('this device')).toBe(stampedBy === THIS_DEVICE);
          expect(said.includes('another device')).toBe(
            stampedBy !== '' && stampedBy !== THIS_DEVICE
          );
          if (stampedBy !== '' && stampedBy !== THIS_DEVICE) {
            // In short, as ids are shown
            expect(said).toContain(stampedBy.slice(0, 8));
            expect(said).not.toContain(stampedBy);
          }
          if (holder.parent) {
            expect(text).toContain(holder.parent.path ?? holder.parent.id);
          }

          if (choice !== 'alternative') {
            expect(confirm).not.toHaveBeenCalled();
            return;
          }
          expect(confirm).toHaveBeenCalledOnce();
          const [confirmedApp, sureOptions] = confirm.mock.calls[0];
          expect(confirmedApp).toBe(app);
          expect(sureOptions.destructive).toBe(true);
          const sureText = textOf(sureOptions);
          expect(sureText).toContain(holder.id);
          expect(sureText).toContain(`"${basename}"`);
          // Only an article or snippet has snippets and cards taken from it to
          // say are kept
          expect(sureOptions.paragraphs).toHaveLength(
            holder.kind === 'card' ? 1 : 2
          );
        }
      )
    );
  });
});
