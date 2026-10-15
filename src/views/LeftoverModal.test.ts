// @vitest-environment jsdom
import { ARTICLE_TAG, DATA_DIRECTORY, SNIPPET_TAG } from '#/lib/constants';
import type { Leftover } from '#/lib/crash-leftovers';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { Notice } from '#/test/__mocks__/obsidian';
import { makeItemVault, TestRepository } from '#/test/item-vault';
import fc from 'fast-check';
import type { App, TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTION_LABELS, flagLeftovers, LeftoverModal } from './LeftoverModal';

// #region HELPERS

/** Leftovers of either kind, each at a path of its own. */
const leftoversArb = fc
  .uniqueArray(
    fc.record({
      name: fc.string({ minLength: 1, maxLength: 8 }),
      kind: fc.constantFrom<Leftover['kind']>('made', 'in-place'),
    }),
    { minLength: 1, maxLength: 4, selector: ({ name }) => name }
  )
  .map((specs) =>
    specs.map(
      ({ name, kind }, i): Leftover => ({
        file: { basename: name, path: `notes/${i}.md` } as TFile,
        id: `id-${i}`,
        type: 'article',
        kind,
      })
    )
  );

/** Two leftovers, one of each kind, for a case their contents don't bear on. */
const FIXTURE: Leftover[] = [
  {
    file: { basename: 'a', path: 'incremental-reading/a.md' } as TFile,
    id: 'id-a',
    type: 'snippet',
    kind: 'made',
  },
  {
    file: { basename: 'b', path: 'notes/b.md' } as TFile,
    id: 'id-b',
    type: 'article',
    kind: 'in-place',
  },
];

/** Open `leftovers` in a modal as Obsidian would, resolving with `resolve`. */
function openModal(
  leftovers: Leftover[],
  resolve: (leftover: Leftover, action: string) => Promise<boolean>
) {
  const modal = new LeftoverModal({} as App, leftovers, resolve);
  const close = vi.spyOn(modal, 'close').mockImplementation(() => {});
  document.body.appendChild(modal.contentEl);
  modal.onOpen();
  const rows = () => [...modal.contentEl.querySelectorAll('.setting-item')];
  const buttonsOf = (row: Element) => [...row.querySelectorAll('button')];
  return { modal, close, rows, buttonsOf };
}

// #endregion

describe('LeftoverModal', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('lists each leftover by name and path, with what can be done with it', () => {
    fc.assert(
      fc.property(leftoversArb, (leftovers) => {
        document.body.innerHTML = '';
        const { rows, buttonsOf } = openModal(leftovers, async () => true);

        expect(rows()).toHaveLength(leftovers.length);
        for (const [i, row] of rows().entries()) {
          const { file, kind } = leftovers[i];
          expect(row.textContent).toContain(file.basename);
          expect(row.textContent).toContain(file.path);
          // Only trashing is styled as Obsidian styles what deletes
          expect(
            buttonsOf(row).map((b) => b.classList.contains('mod-destructive'))
          ).toEqual([false, kind === 'made']);
          expect(buttonsOf(row).map((b) => b.textContent)).toEqual(
            kind === 'made'
              ? [ACTION_LABELS.adopt, ACTION_LABELS.trash]
              : [ACTION_LABELS.adopt, ACTION_LABELS.strip]
          );
        }
      })
    );
  });

  it("does what a note's button says to it, takes its line away once done, and closes once none are left", async () => {
    await fc.assert(
      fc.asyncProperty(
        leftoversArb,
        fc.array(fc.nat(1)),
        async (leftovers, choices) => {
          document.body.innerHTML = '';
          const resolve = vi.fn(async () => true);
          const { rows, buttonsOf, close } = openModal(leftovers, resolve);

          for (const [i, leftover] of leftovers.entries()) {
            const choice = choices[i] ?? 0;
            buttonsOf(rows()[0])[choice].click();
            await vi.waitFor(() =>
              expect(rows()).toHaveLength(leftovers.length - i - 1)
            );
            expect(resolve).toHaveBeenLastCalledWith(
              leftover,
              choice === 0
                ? 'adopt'
                : leftover.kind === 'made'
                  ? 'trash'
                  : 'strip'
            );
            expect(close).toHaveBeenCalledTimes(
              i === leftovers.length - 1 ? 1 : 0
            );
          }
        }
      ),
      { numRuns: 30 }
    );
  });

  it("keeps a note's line, and lets it be chosen again, when what was chosen was not done", async () => {
    const leftovers = FIXTURE;
    const resolve = vi.fn(async () => false);
    const { rows, buttonsOf, close } = openModal(leftovers, resolve);

    const [adopt] = buttonsOf(rows()[0]);
    adopt.click();
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(adopt.disabled).toBe(false));

    expect(rows()).toHaveLength(leftovers.length);
    expect(close).not.toHaveBeenCalled();
  });

  it('turns its buttons off while what was chosen is being done', async () => {
    const leftovers = FIXTURE;
    let finish!: (done: boolean) => void;
    const { rows, buttonsOf } = openModal(
      leftovers,
      () => new Promise((resolve) => (finish = resolve))
    );

    const buttons = buttonsOf(rows()[0]);
    buttons[0].click();

    expect(buttons.every((b) => b.disabled)).toBe(true);
    finish(true);
  });

  it('empties itself once closed', () => {
    const { modal } = openModal(FIXTURE, async () => true);

    modal.onClose();

    expect(modal.contentEl.childElementCount).toBe(0);
  });
});

describe('flagLeftovers', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  /** Find the leftovers among `notes`, with every note's id rowless. */
  async function flag(
    notes: Record<string, Record<string, unknown>>,
    { failing = false, holdsItems = true } = {}
  ) {
    const vault = makeItemVault(notes);
    const repo = await TestRepository.create();
    if (holdsItems) {
      repo.mutate(
        `INSERT INTO article (id, reference, due, interval, priority) VALUES ('other', 'other.md', 0, 1, 30)`
      );
    }
    if (failing) {
      vi.spyOn(repo, 'query').mockImplementation(() => {
        throw new Error('read failed');
      });
    }
    const containerEl = document.createElement('div');
    const createNotice = vi.fn((_message: string) => ({ containerEl }));
    const opened: LeftoverModal[] = [];
    const open = vi
      .spyOn(LeftoverModal.prototype, 'open')
      .mockImplementation(function (this: LeftoverModal) {
        opened.push(this);
      });
    const error = vi.spyOn(console, 'error').mockReturnValue(undefined);
    const adoptLeftover = vi.fn(async () => undefined);
    const managers = vi.fn(() => ({
      articles: { adoptLeftover },
      snippets: { adoptLeftover },
      cards: { adoptLeftover },
    }));
    const onResolved = vi.fn();
    await flagLeftovers({
      app: vault.app as never,
      repo,
      managers,
      onResolved,
      createNotice,
    });
    return {
      createNotice,
      containerEl,
      open,
      opened,
      error,
      managers,
      onResolved,
      adoptLeftover,
    };
  }

  it('asks about nothing while the database holds no items, as Sync may not have brought it down yet', async () => {
    const { createNotice } = await flag(
      { 'notes/a.md': { 'ir-id': 'x', tags: [ARTICLE_TAG] } },
      { holdsItems: false }
    );

    expect(createNotice).not.toHaveBeenCalled();
  });

  it('says nothing when there are no leftovers', async () => {
    const { createNotice } = await flag({
      'notes/a.md': { title: 'plain' },
    });

    expect(createNotice).not.toHaveBeenCalled();
  });

  it('lists the leftovers in one notice that, once clicked, opens them to choose from', async () => {
    const { createNotice, containerEl, open, managers } = await flag({
      'notes/a.md': { 'ir-id': 'x', tags: [ARTICLE_TAG] },
      [`${DATA_DIRECTORY}/s/b.md`]: { 'ir-id': 'y', tags: [SNIPPET_TAG] },
    });

    expect(createNotice).toHaveBeenCalledOnce();
    expect(createNotice.mock.calls[0][0]).toMatch(/2 notes have/);
    expect(open).not.toHaveBeenCalled();
    expect(managers).not.toHaveBeenCalled();

    containerEl.click();

    expect(open).toHaveBeenCalledOnce();
  });

  it('by default lists the leftovers in a notice that stays until clicked', async () => {
    const vault = makeItemVault({
      'notes/a.md': { 'ir-id': 'x', tags: [ARTICLE_TAG] },
    });
    const repo = await TestRepository.create();
    repo.mutate(
      `INSERT INTO article (id, reference, due, interval, priority) VALUES ('other', 'other.md', 0, 1, 30)`
    );
    Notice.reset();

    await flagLeftovers({
      app: vault.app as never,
      repo,
      managers: vi.fn(),
      onResolved: vi.fn(),
    });

    expect(Notice.instances).toHaveLength(1);
    expect(Notice.instances[0].message).toMatch(/1 note has/);
    expect(Notice.instances[0].duration).toBe(0);
  });

  it('resolves what is chosen in the modal, and says so once done', async () => {
    const wired = await flag({
      'notes/a.md': { 'ir-id': 'x', tags: [ARTICLE_TAG] },
    });
    wired.containerEl.click();
    const [modal] = wired.opened;
    vi.spyOn(modal, 'close').mockImplementation(() => {});
    modal.onOpen();

    modal.contentEl.querySelector('button')!.click();

    await vi.waitFor(() => expect(wired.onResolved).toHaveBeenCalledOnce());
    expect(wired.adoptLeftover).toHaveBeenCalledOnce();
  });

  it('says nothing was resolved when what was chosen was not done', async () => {
    const wired = await flag({
      'notes/a.md': { 'ir-id': 'x', tags: [ARTICLE_TAG] },
    });
    wired.adoptLeftover.mockRejectedValueOnce(new Error('insert failed'));
    vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
    wired.containerEl.click();
    const [modal] = wired.opened;
    vi.spyOn(modal, 'close').mockImplementation(() => {});
    modal.onOpen();

    modal.contentEl.querySelector('button')!.click();

    await vi.waitFor(() => expect(wired.adoptLeftover).toHaveBeenCalledOnce());
    await new Promise((settled) => setTimeout(settled, 10));
    expect(wired.onResolved).not.toHaveBeenCalled();
  });

  it('says nothing, but logs why, when the leftovers cannot be looked for', async () => {
    const { createNotice, error } = await flag(
      { 'notes/a.md': { 'ir-id': 'x', tags: [ARTICLE_TAG] } },
      { failing: true }
    );

    expect(createNotice).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
  });
});
