// @vitest-environment jsdom
import * as UiWindow from '#/lib/ui-window';
import * as ConfirmModalModule from '#/views/ConfirmModal';
import fc from 'fast-check';
import type { App, TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  MatchedRow,
  Plan,
  PathHolder as RowAtPath,
} from './crash-leftovers';
import {
  askToReassociate,
  askToResolve,
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

describe('askToResolve', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const file = { path: 'notes/new.md', basename: 'new' } as TFile;
  const app = {} as App;

  /** A row holding a note's id, pointing at the note's path or elsewhere. */
  const matchedArb: fc.Arbitrary<MatchedRow> = fc
    .tuple(
      rowAtPathArb,
      fc.oneof(fc.constant(file.path), fc.string({ minLength: 1 }))
    )
    .map(([row, reference]) => ({ ...row, reference }));

  /**
   * A plan offering no erase: the row holding the note's id, with a deleted
   * row at its path moved aside or not; or the row at its path, while a row
   * holding its id is refused; with any rows refused, either way.
   */
  const planArb: fc.Arbitrary<Plan> = fc.oneof(
    fc.record({
      target: matchedArb.map((row) => ({ by: 'id' as const, row })),
      evicts: fc.option(rowAtPathArb, { nil: null }),
      erase: fc.constant(false),
      refused: fc.array(
        fc.record({
          row: matchedArb,
          why: fc.constantFrom('copy' as const, 'held' as const),
        }),
        { maxLength: 2 }
      ),
    }),
    fc.record({
      target: rowAtPathArb.map((row) => ({ by: 'path' as const, row })),
      evicts: fc.constant(null),
      erase: fc.constant(false),
      refused: fc.array(
        fc.record({
          row: matchedArb,
          why: fc.constantFrom('copy' as const, 'held' as const),
        }),
        { minLength: 1, maxLength: 2 }
      ),
    })
  );

  it("asks once, showing the target row's details and where it is, the row moved aside and each row refused, and answers re-associate or nothing", async () => {
    await fc.assert(
      fc.asyncProperty(planArb, fc.boolean(), async (plan, confirmed) => {
        vi.restoreAllMocks();
        const confirm = vi
          .spyOn(ConfirmModalModule, 'promptForConfirmation')
          .mockResolvedValue(confirmed);
        const choose = vi.spyOn(ConfirmModalModule, 'promptForChoice');

        const answer = await askToResolve(app, file, plan, THIS_DEVICE);

        expect(answer).toBe(confirmed ? 'reassociate' : null);
        expect(choose).not.toHaveBeenCalled();
        expect(confirm).toHaveBeenCalledOnce();
        const [asked, options] = confirm.mock.calls[0];
        expect(asked).toBe(app);
        const text = options.paragraphs.flat().join('\n');
        const { target } = plan;
        expect(text).toContain(target!.row.id);
        expect(options.title).toContain(target!.row.kind);
        if (target!.by === 'id' && target!.row.reference !== file.path) {
          expect(text).toContain(`"${target!.row.reference}"`);
        } else if (target!.by === 'path') {
          expect(text).toContain(`"${file.path}"`);
        }
        const evicted = plan.evicts?.id.slice(0, 8);
        if (evicted) expect(text).toContain(evicted);
        for (const { row } of plan.refused) {
          expect(text).toContain(row.id.slice(0, 8));
          expect(text).toContain(`"${row.reference}"`);
        }
      }),
      { numRuns: 60 }
    );
  });

  it('tells a deleted row from one whose note is missing, a copy from a held path, and the row at the path from the one holding its id', async () => {
    const confirm = vi
      .spyOn(ConfirmModalModule, 'promptForConfirmation')
      .mockResolvedValue(false);
    const row: MatchedRow = {
      kind: 'snippet',
      id: 'row-1234-abcd',
      deleted: true,
      dismissed: false,
      due: null,
      lastReview: null,
      updatedAt: 0,
      updatedBy: '',
      parent: null,
      reference: 'notes/old.md',
    };
    const paragraphsOf = async (plan: Plan) => {
      confirm.mockClear();
      await askToResolve(app, file, plan, THIS_DEVICE);
      return confirm.mock.calls[0][1].paragraphs.map((p) =>
        [p].flat().join('\n')
      );
    };
    const byId = (r: MatchedRow): Plan => ({
      target: { by: 'id', row: r },
      evicts: null,
      erase: false,
      refused: [],
    });
    const refusing = (why: 'copy' | 'held'): Plan => ({
      target: { by: 'path', row: { ...row, kind: 'article', id: 'art-0000' } },
      evicts: null,
      erase: false,
      refused: [{ row, why }],
    });

    const deleted = await paragraphsOf(byId(row));
    const missing = await paragraphsOf(byId({ ...row, deleted: false }));
    const here = await paragraphsOf(byId({ ...row, reference: file.path }));
    for (const paragraphs of [deleted, missing, here]) {
      // Its kind where it is told what the row is, and what Re-associate does
      expect(paragraphs[0]).toContain('snippet');
      expect(paragraphs.at(-1)).toContain('snippet');
    }
    expect(deleted[0]).toContain('"notes/old.md"');
    expect(missing[0]).toContain('"notes/old.md"');
    expect(deleted[0]).not.toBe(missing[0]);
    expect(deleted.at(-1)).not.toBe(missing.at(-1));
    // One recorded at the note's own path names no other
    expect(here[0]).not.toMatch(/"notes\//);
    // A held path is the target's doing, which a copy's refusal never names
    const refusalOf = async (why: 'copy' | 'held') =>
      (await paragraphsOf(refusing(why))).find((p) =>
        p.includes(row.id.slice(0, 8))
      )!;
    expect(await refusalOf('held')).toContain('article');
    expect(await refusalOf('copy')).not.toContain('article');
  });

  it('asks as for the row at the path alone, offering to erase it, where the plan offers erasing', async () => {
    await fc.assert(
      fc.asyncProperty(
        rowAtPathArb,
        answersArb,
        async (row, { choice, sure }) => {
          const { ask } = wireChoice(choice, sure);
          const plan: Plan = {
            target: { by: 'path', row },
            evicts: null,
            erase: true,
            refused: [],
          };

          const answer = await askToResolve(app, file, plan, THIS_DEVICE);
          const asked = structuredClone(ask.mock.calls);
          const held = wireChoice(choice, sure);
          const alone = await askToResolveHeld(app, file, row, THIS_DEVICE);

          expect(answer).toBe(alone);
          expect(asked).toEqual(structuredClone(held.ask.mock.calls));
          expect(asked).toHaveLength(1);
        }
      ),
      { numRuns: 30 }
    );
  });

  it('opens in the window the plugin answers from, not over a settings window behind it', async () => {
    const openModal = vi.spyOn(UiWindow, 'openModal');
    const row: MatchedRow = {
      kind: 'snippet',
      id: 'row-1234-abcd',
      deleted: true,
      dismissed: false,
      due: null,
      lastReview: null,
      updatedAt: 0,
      updatedBy: '',
      parent: null,
      reference: 'notes/old.md',
    };

    const answered = askToResolve(
      app,
      file,
      { target: { by: 'id', row }, evicts: null, erase: false, refused: [] },
      THIS_DEVICE
    );

    expect(openModal).toHaveBeenCalledOnce();
    const [modal] = openModal.mock.calls[0];
    expect(modal).toBeInstanceOf(ConfirmModalModule.ConfirmModal);
    // As Escape or the close button closes it, which ends in `onClose`
    modal.onClose();
    await expect(answered).resolves.toBeNull();
  });

  it('answers nothing, asking nothing, when the plan offers no row', async () => {
    const confirm = vi.spyOn(ConfirmModalModule, 'promptForConfirmation');
    const choose = vi.spyOn(ConfirmModalModule, 'promptForChoice');

    const answer = await askToResolve(
      app,
      file,
      { target: null, evicts: null, erase: false, refused: [] },
      THIS_DEVICE
    );

    expect(answer).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    expect(choose).not.toHaveBeenCalled();
  });
});
