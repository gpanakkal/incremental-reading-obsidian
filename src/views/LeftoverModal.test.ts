// @vitest-environment jsdom
import { ARTICLE_TAG, DATA_DIRECTORY, SNIPPET_TAG } from '#/lib/constants';
import { actionsFor, type Leftover } from '#/lib/crash-leftovers';
import * as Notices from '#/lib/notices';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { Notice } from '#/test/__mocks__/obsidian';
import { makeItemVault, TestRepository } from '#/test/item-vault';
import fc from 'fast-check';
import type { App, TFile } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type LeftoverChoice,
  LeftoverModal,
  LeftoverWatch,
  type SaveType,
} from './LeftoverModal';

// #region HELPERS

/** Folders a leftover may be in, the vault root (`''`) among them. */
const FOLDERS = ['', 'notes', 'a/b/c', `${DATA_DIRECTORY}/snippets`];

/** A leftover's note, `name` in `folder`, as Obsidian's `TFile` holds it. */
function fileAt(folder: string, name: string): TFile {
  const path = folder ? `${folder}/${name}.md` : `${name}.md`;
  return { basename: name, name: `${name}.md`, path } as TFile;
}

/** Leftovers of any kind and type, each with a name and path of its own. */
const leftoversArb = fc
  .uniqueArray(
    fc.record({
      name: fc.stringMatching(/^[a-z]{1,6}$/),
      folder: fc.constantFrom(...FOLDERS),
      kind: fc.constantFrom<Leftover['kind']>('made', 'in-place'),
      type: fc.constantFrom<Leftover['type']>(
        'article',
        'snippet',
        'card',
        null
      ),
    }),
    { minLength: 1, maxLength: 4, selector: ({ name }) => name }
  )
  .map((specs) =>
    specs.map(
      ({ name, folder, kind, type }, i): Leftover => ({
        file: fileAt(folder, name),
        id: `id-${i}`,
        type,
        kind,
      })
    )
  );

/** A leftover the plugin made, offered a type and the trash. */
const MADE: Leftover = {
  file: fileAt(`${DATA_DIRECTORY}/snippets`, 'a'),
  id: 'id-a',
  type: 'snippet',
  kind: 'made',
};
/** One of the user's notes, offered a type and stripping. */
const IN_PLACE: Leftover = {
  file: fileAt('notes', 'b'),
  id: 'id-b',
  type: 'article',
  kind: 'in-place',
};

/**
 * What `leftover`'s "Save as…" dropdown shows before anything is picked: the
 * type it was made as, if one it can be saved as, else the placeholder (`''`).
 */
const shownType = ({ type }: Leftover): SaveType | '' =>
  type === 'article' || type === 'snippet' ? type : '';

/** What is chosen for `leftover` until the user changes it: the type shown. */
function defaultChoice(leftover: Leftover): LeftoverChoice | null {
  const as = shownType(leftover);
  return as ? { action: 'adopt', as } : null;
}

/** Everything that can be chosen for `leftover` in the modal. */
function choicesFor(leftover: Leftover): LeftoverChoice[] {
  return actionsFor(leftover).flatMap((action): LeftoverChoice[] =>
    action === 'adopt'
      ? [
          { action, as: 'article' },
          { action, as: 'snippet' },
        ]
      : [{ action }]
  );
}

/** Open `leftovers` in a modal as Obsidian would, resolving with `resolve`. */
function openModal(
  leftovers: readonly Leftover[],
  resolve: (leftover: Leftover, choice: LeftoverChoice) => Promise<boolean>
) {
  const modal = new LeftoverModal({} as App, leftovers, resolve);
  const close = vi.spyOn(modal, 'close').mockImplementation(() => {});
  document.body.append(modal.modalEl, modal.contentEl);
  modal.onOpen();
  const rows = () => [
    ...modal.contentEl.querySelectorAll<HTMLElement>('.setting-item'),
  ];
  const rowOf = (leftover: Leftover) =>
    rows()[leftovers.indexOf(leftover)] ?? null;
  const footer = () =>
    modal.modalEl.querySelector<HTMLElement>('.modal-button-container');
  const footerButton = (text: string) =>
    [...(footer()?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === text
    )!;
  return {
    modal,
    close,
    rows,
    rowOf,
    footer,
    confirmButton: () => footerButton('Confirm'),
    cancelButton: () => footerButton('Cancel'),
  };
}

/** The "Save as…" dropdown on `row`, or `null`. */
const dropdownOf = (row: Element) =>
  row.querySelector<HTMLSelectElement>(
    '.setting-item-control select.dropdown:not(.is-measuring)'
  );
/** The trash button on `row`, or `null`. */
const trashOf = (row: Element) =>
  row.querySelector<HTMLButtonElement>(
    '.setting-item-control button[aria-label="Move to trash"]'
  );
/** The "Remove IR properties" button on `row`, or `null`. */
const stripOf = (row: Element) =>
  [
    ...row.querySelectorAll<HTMLButtonElement>('.setting-item-control button'),
  ].find((b) => b.textContent === 'Remove IR properties') ?? null;

/**
 * Pick `value` from `select` as the user would: picking what it shows already
 * fires no `change`, as in a browser.
 */
function pickFrom(select: HTMLSelectElement, value: string) {
  if (select.value === value) return;
  select.value = value;
  select.dispatchEvent(new Event('change'));
}

/** Choose `choice` on `row`, as the user would. */
function choose(row: Element, choice: LeftoverChoice) {
  if (choice.action === 'adopt') {
    // Already chosen if shown, as picking it again fires nothing
    pickFrom(dropdownOf(row)!, choice.as);
  } else if (choice.action === 'trash') trashOf(row)!.click();
  else stripOf(row)!.click();
}

/** A promise and what settles it, for a resolver to wait on. */
function deferred<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (settle = resolve));
  return { promise, settle };
}

/**
 * Let a click's handler finish, its resolver settling at once. Not
 * `vi.waitFor`: its first retry waits a timer tick, which takes ~15ms on
 * Windows, so a property clicking dozens of times outlasts the test timeout.
 */
const settle = () => new Promise<void>((done) => setImmediate(done));

/** A vault holding one leftover, `notes/a.md`, with no type tag. */
const ONE_LEFTOVER = { 'notes/a.md': { 'ir-id': 'x' } };

/** A database holding an item, shared by the cases of a property. */
let holdingRepo: Promise<TestRepository> | undefined;

/** Insert an item into `repo`, so that it holds one. */
function insertItem(repo: TestRepository) {
  repo.mutate(
    `INSERT INTO article (id, reference, due, interval, priority) VALUES ('other', 'other.md', 0, 1, 30)`
  );
}

/**
 * A watch over the leftovers among `notes`, with every note's id rowless, and
 * a review tab that can be opened and closed. The modals it opens are kept in
 * `opened` rather than shown.
 */
async function wireWatch(
  notes: Record<string, Record<string, unknown>>,
  { failing = false, holdsItems = true, sharedRepo = false } = {}
) {
  const vault = makeItemVault(notes);
  let repo: TestRepository;
  if (sharedRepo) {
    holdingRepo ??= TestRepository.create().then((created) => {
      insertItem(created);
      return created;
    });
    repo = await holdingRepo;
  } else {
    repo = await TestRepository.create();
    if (holdsItems) insertItem(repo);
  }
  if (failing) {
    vi.spyOn(repo, 'query').mockImplementation(() => {
      throw new Error('read failed');
    });
  }
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
  let reviewOpen = false;
  const watch = new LeftoverWatch({
    app: vault.app as never,
    repo,
    managers,
    onResolved,
    isReviewOpen: () => reviewOpen,
  });
  return {
    vault,
    repo,
    watch,
    open,
    opened,
    error,
    managers,
    onResolved,
    adoptLeftover,
    /** Open a review tab, as its view's `onOpen` tells the watch. */
    openReview: () => {
      reviewOpen = true;
      watch.reviewOpened();
    },
    closeReview: () => {
      reviewOpen = false;
    },
  };
}

/** The buttons on `notice`. */
function noticeButtons(notice: Notice): HTMLElement[] {
  return [...notice.containerEl.querySelectorAll<HTMLElement>('.notice-cta')];
}

/** Show `modal` as Obsidian would, closing it doing nothing. */
function showModal(modal: LeftoverModal): LeftoverModal {
  vi.spyOn(modal, 'close').mockImplementation(() => {});
  document.body.append(modal.modalEl, modal.contentEl);
  modal.onOpen();
  return modal;
}

/** The Confirm button of a shown `modal`. */
function confirmOf(modal: LeftoverModal): HTMLButtonElement {
  return modal.modalEl.querySelector<HTMLButtonElement>(
    '.modal-button-container button.mod-cta'
  )!;
}

/** The names of the notes `modal` lists, shown. */
function listed(modal: LeftoverModal): string[] {
  showModal(modal);
  return [...modal.contentEl.querySelectorAll('.setting-item-name')].map(
    (el) => el.textContent ?? ''
  );
}

// #endregion

describe('LeftoverModal', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it("lists each leftover by its name, under its folder's path, with no intro", () => {
    fc.assert(
      fc.property(leftoversArb, (leftovers) => {
        document.body.innerHTML = '';
        const { modal, rows } = openModal(leftovers, async () => true);

        expect(modal.titleEl.textContent).toBe(
          'Notes not found in the database'
        );
        expect(modal.contentEl.querySelector('p')).toBeNull();
        expect(rows()).toHaveLength(leftovers.length);
        for (const [i, row] of rows().entries()) {
          const { file } = leftovers[i];
          const folder = file.path.slice(0, -`/${file.name}`.length);
          const info = row.querySelector('.setting-item-info')!;
          // The vault root has no path to show
          expect(
            [...info.children].map((el) => [el.className, el.textContent])
          ).toEqual([
            ...(file.path === file.name
              ? []
              : [['setting-item-description', folder]]),
            ['setting-item-name', file.basename],
          ]);
          expect(row.textContent).not.toContain(file.path);
        }
      })
    );
  });

  it('offers each note the choices it has: a type to save it as, the trash, or stripping', () => {
    fc.assert(
      fc.property(leftoversArb, (leftovers) => {
        document.body.innerHTML = '';
        const { rows } = openModal(leftovers, async () => true);

        for (const [i, row] of rows().entries()) {
          const actions = actionsFor(leftovers[i]);
          const dropdown = dropdownOf(row);
          expect(dropdown !== null).toBe(actions.includes('adopt'));
          if (dropdown) {
            // No card: a card needs more than a note to be one
            expect(
              [...dropdown.options].map((o) => [o.value, o.text, o.disabled])
            ).toEqual([
              ['', 'Save as…', true],
              ['article', 'Article', false],
              ['snippet', 'Snippet', false],
            ]);
            expect(dropdown.value).toBe(shownType(leftovers[i]));
          }
          const trash = trashOf(row);
          expect(trash !== null).toBe(actions.includes('trash'));
          if (trash) {
            // Labelled on the button: an SVG's aria-label crashes
            // Obsidian's tooltip handler
            expect(trash.querySelector('svg.lucide-trash-2')).not.toBeNull();
            expect(trash.querySelector('[aria-label]')).toBeNull();
            expect(trash.getAttribute('aria-pressed')).toBe('false');
            expect(trash.classList.contains('mod-destructive')).toBe(true);
          }
          const strip = stripOf(row);
          expect(strip !== null).toBe(actions.includes('strip'));
          expect(strip?.getAttribute('aria-pressed') ?? 'false').toBe('false');
        }
      })
    );
  });

  it.each<[string, Leftover, LeftoverChoice]>([
    ['saving as an article', MADE, { action: 'adopt', as: 'article' }],
    ['saving as a snippet', IN_PLACE, { action: 'adopt', as: 'snippet' }],
    ['the trash', MADE, { action: 'trash' }],
    ['stripping', IN_PLACE, { action: 'strip' }],
  ])(
    'shows %s as chosen on the row, doing nothing yet',
    (_, leftover, choice) => {
      const resolve = vi.fn(async () => true);
      const { rowOf, confirmButton, close } = openModal([leftover], resolve);
      const row = rowOf(leftover);

      choose(row, choice);

      expect(dropdownOf(row)!.value).toBe(
        choice.action === 'adopt' ? choice.as : ''
      );
      if (choice.action !== 'adopt') {
        const pressed = choice.action === 'trash' ? trashOf(row) : stripOf(row);
        expect(pressed!.getAttribute('aria-pressed')).toBe('true');
        expect(pressed!.classList.contains('mod-cta')).toBe(true);
      }
      expect(confirmButton().disabled).toBe(false);
      expect(resolve).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    }
  );

  it.each<[string, Leftover, 'trash' | 'strip']>([
    ['the trash', MADE, 'trash'],
    ['stripping', IN_PLACE, 'strip'],
  ])(
    'lets a note have one choice at a time: a type or %s, either taken back',
    async (_, leftover, other) => {
      const resolve = vi.fn(async () => true);
      const { rowOf, confirmButton } = openModal([leftover], resolve);
      const row = rowOf(leftover);
      const button = () => (other === 'trash' ? trashOf(row) : stripOf(row))!;

      pickFrom(dropdownOf(row)!, 'article');
      button().click();
      expect(dropdownOf(row)!.value).toBe('');
      // The placeholder shows again, not a blank
      expect(dropdownOf(row)!.selectedOptions[0]?.text).toBe('Save as…');
      expect(button().getAttribute('aria-pressed')).toBe('true');

      pickFrom(dropdownOf(row)!, 'snippet');
      expect(button().getAttribute('aria-pressed')).toBe('false');
      expect(button().classList.contains('mod-cta')).toBe(false);

      // Pressing it twice takes it back, the note's own type shown, and
      // chosen, again
      button().click();
      button().click();
      expect(button().getAttribute('aria-pressed')).toBe('false');
      expect(dropdownOf(row)!.value).toBe(leftover.type);
      expect(confirmButton().disabled).toBe(false);

      // The placeholder is no choice, should a change ever land on it
      choose(row, { action: 'adopt', as: 'article' });
      pickFrom(dropdownOf(row)!, '');
      expect(confirmButton().disabled).toBe(true);
      confirmButton().click();
      await settle();
      expect(resolve).not.toHaveBeenCalled();
    }
  );

  it.each<[string, Leftover]>([
    ['a snippet', MADE],
    ['an article', IN_PLACE],
    ['a card', { ...MADE, type: 'card' }],
    ['nothing', { ...IN_PLACE, type: null }],
  ])(
    'starts a note made as %s chosen as the type it was made as, if one to save as, else with nothing chosen',
    async (_, leftover) => {
      const resolve = vi.fn(async () => true);
      const { rowOf, confirmButton } = openModal([leftover], resolve);
      const dropdown = dropdownOf(rowOf(leftover))!;
      const shown = shownType(leftover);

      expect(dropdown.value).toBe(shown);
      expect(dropdown.selectedOptions[0]?.text).toBe(
        { article: 'Article', snippet: 'Snippet', '': 'Save as…' }[shown]
      );
      expect(confirmButton().disabled).toBe(!shown);
      if (!shown) {
        confirmButton().click();
        await settle();
        expect(resolve).not.toHaveBeenCalled();
        choose(rowOf(leftover), { action: 'adopt', as: 'article' });
        expect(confirmButton().disabled).toBe(false);
      }

      confirmButton().click();
      await settle();

      expect(resolve.mock.calls).toEqual([
        [leftover, { action: 'adopt', as: shown || 'article' }],
      ]);
    }
  );

  it('does what was chosen for each note on Confirm, one at a time, takes its line away, and closes once none are left', async () => {
    await fc.assert(
      fc.asyncProperty(
        leftoversArb,
        fc.array(fc.nat(), { minLength: 4, maxLength: 4 }),
        async (leftovers, picks) => {
          document.body.innerHTML = '';
          let running = 0;
          let overlapped = false;
          const resolve = vi.fn(async () => {
            running += 1;
            if (running > 1) overlapped = true;
            await settle();
            running -= 1;
            return true;
          });
          const { rows, rowOf, confirmButton, close } = openModal(
            leftovers,
            resolve
          );
          // Index 0 of each note's options is leaving it as it starts
          const chosen = leftovers.map((leftover, i) => {
            const options = [null, ...choicesFor(leftover)];
            return (
              options[picks[i] % options.length] ?? defaultChoice(leftover)
            );
          });
          for (const [i, choice] of chosen.entries()) {
            if (choice) choose(rowOf(leftovers[i]), choice);
          }
          const expected = leftovers.flatMap((leftover, i) =>
            chosen[i] ? [[leftover, chosen[i]]] : []
          );

          confirmButton().click();
          for (let i = 0; i <= expected.length; i++) await settle();

          expect(overlapped).toBe(false);
          expect(resolve.mock.calls).toEqual(expected);
          expect(rows()).toHaveLength(leftovers.length - expected.length);
          expect(close).toHaveBeenCalledTimes(chosen.every(Boolean) ? 1 : 0);
        }
      ),
      { numRuns: 40 }
    );
  });

  it("keeps a note's line, with what went wrong, when what was chosen for it was not done", async () => {
    const resolve = vi.fn(async (leftover: Leftover) => leftover !== MADE);
    const { rows, confirmButton, rowOf, close } = openModal(
      [MADE, IN_PLACE],
      resolve
    );
    choose(rowOf(MADE), { action: 'trash' });
    choose(rowOf(IN_PLACE), { action: 'strip' });

    confirmButton().click();
    await vi.waitFor(() => expect(rows()).toHaveLength(1));

    const [row] = rows();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(row.querySelector('.setting-item-name')!.textContent).toBe('a');
    expect(row.querySelector('.ir-leftover-error')!.textContent).toBe(
      "Couldn't move this note to the trash."
    );
    // Still chosen, to try again
    expect(trashOf(row)!.getAttribute('aria-pressed')).toBe('true');
    expect(confirmButton().disabled).toBe(false);
    expect(close).not.toHaveBeenCalled();

    resolve.mockResolvedValue(true);
    confirmButton().click();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(resolve).toHaveBeenLastCalledWith(MADE, { action: 'trash' });
  });

  it("keeps a note's line, saying so, when doing what was chosen for it throws, and goes on to the next", async () => {
    const error = vi.spyOn(console, 'error').mockReturnValue(undefined);
    const resolve = vi.fn(async (leftover: Leftover) => {
      if (leftover === MADE) throw new Error('failed');
      return true;
    });
    const { rows, rowOf, confirmButton } = openModal([MADE, IN_PLACE], resolve);
    choose(rowOf(MADE), { action: 'trash' });
    choose(rowOf(IN_PLACE), { action: 'strip' });

    confirmButton().click();
    await vi.waitFor(() => expect(rows()).toHaveLength(1));

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(rowOf(MADE).querySelector('.ir-leftover-error')?.textContent).toBe(
      "Couldn't move this note to the trash."
    );
    expect(trashOf(rowOf(MADE))!.disabled).toBe(false);
    expect(confirmButton().disabled).toBe(false);
    expect(error).toHaveBeenCalled();
  });

  it.each<[string, LeftoverChoice, string]>([
    [
      'saving it as an article',
      { action: 'adopt', as: 'article' },
      "Couldn't save this note as an article.",
    ],
    [
      'saving it as a snippet',
      { action: 'adopt', as: 'snippet' },
      "Couldn't save this note as a snippet.",
    ],
    [
      'stripping it',
      { action: 'strip' },
      "Couldn't remove this note's IR properties.",
    ],
  ])('says what went wrong %s', async (_, choice, error) => {
    const { rowOf, confirmButton } = openModal([IN_PLACE], async () => false);
    choose(rowOf(IN_PLACE), choice);

    confirmButton().click();

    await vi.waitFor(() =>
      expect(
        rowOf(IN_PLACE).querySelector('.ir-leftover-error')?.textContent
      ).toBe(error)
    );
  });

  it('clears what went wrong once a note is tried again', async () => {
    const run = deferred<boolean>();
    const resolve = vi.fn(async () => false);
    const { rowOf, confirmButton } = openModal([MADE], resolve);
    choose(rowOf(MADE), { action: 'trash' });
    confirmButton().click();
    await vi.waitFor(() =>
      expect(rowOf(MADE).querySelector('.ir-leftover-error')).not.toBeNull()
    );

    resolve.mockReturnValue(run.promise);
    confirmButton().click();

    expect(rowOf(MADE).querySelector('.ir-leftover-error')).toBeNull();
    run.settle(true);
  });

  it('turns every choice off while what was chosen is being done', async () => {
    const run = deferred<boolean>();
    const { rowOf, confirmButton, cancelButton } = openModal(
      [MADE, IN_PLACE],
      () => run.promise
    );
    choose(rowOf(MADE), { action: 'trash' });

    confirmButton().click();

    const controls = [rowOf(MADE), rowOf(IN_PLACE)].flatMap((row) => [
      // Not Obsidian's hidden copy it measures the dropdown's width with
      ...row.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(
        'button, select:not(.is-measuring)'
      ),
    ]);
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.every((c) => c.disabled)).toBe(true);
    expect(confirmButton().disabled).toBe(true);
    // Cancel stays on: closing stops what is not yet under way
    expect(cancelButton().disabled).toBe(false);
    run.settle(false);
    await vi.waitFor(() =>
      expect(dropdownOf(rowOf(IN_PLACE))!.disabled).toBe(false)
    );
    expect(trashOf(rowOf(MADE))!.disabled).toBe(false);
  });

  it('does nothing chosen, and closes, on Cancel', async () => {
    const resolve = vi.fn(async () => true);
    const { modal, rowOf, cancelButton, close } = openModal(
      [MADE, IN_PLACE],
      resolve
    );
    choose(rowOf(MADE), { action: 'trash' });
    choose(rowOf(IN_PLACE), { action: 'adopt', as: 'snippet' });

    cancelButton().click();
    modal.onClose();
    await settle();

    expect(close).toHaveBeenCalledOnce();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('stops before the next choice once closed while one is being done', async () => {
    const run = deferred<boolean>();
    const resolve = vi.fn(() => run.promise);
    const { modal, rowOf, confirmButton, close } = openModal(
      [MADE, IN_PLACE],
      resolve
    );
    choose(rowOf(MADE), { action: 'trash' });
    choose(rowOf(IN_PLACE), { action: 'strip' });

    confirmButton().click();
    modal.onClose();
    run.settle(true);
    await settle();
    await settle();

    expect(resolve).toHaveBeenCalledOnce();
    // Closed already: not again
    expect(close).not.toHaveBeenCalled();
  });

  it('empties itself, its buttons with it, once closed', () => {
    const { modal, footer } = openModal([MADE, IN_PLACE], async () => true);
    expect(footer()).not.toBeNull();

    modal.onClose();

    expect(modal.contentEl.childElementCount).toBe(0);
    expect(footer()).toBeNull();
  });
});

describe('LeftoverWatch', () => {
  beforeEach(() => {
    Notice.reset();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('shows no notice at the end of the startup scan while no review tab is open', async () => {
    const { watch } = await wireWatch(ONE_LEFTOVER);

    await watch.startupScan();

    expect(Notice.instances).toEqual([]);
  });

  it('shows the notice when a review tab opens after the startup scan, once per load', async () => {
    const wired = await wireWatch(ONE_LEFTOVER);
    await wired.watch.startupScan();

    wired.openReview();
    wired.closeReview();
    wired.openReview();

    expect(Notice.messages).toEqual([
      'Incremental reading: 1 note was not found in the database.',
    ]);
  });

  it('shows the notice at the end of the startup scan when a review tab is open by then', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('open', 'close'), { maxLength: 6 }),
        fc.array(fc.constantFrom('open', 'close'), { maxLength: 6 }),
        async (before, after) => {
          Notice.reset();
          const wired = await wireWatch(ONE_LEFTOVER, { sharedRepo: true });
          const run = (event: 'open' | 'close') =>
            event === 'open' ? wired.openReview() : wired.closeReview();

          before.forEach(run);
          const openAtScan =
            before.lastIndexOf('open') > before.lastIndexOf('close');
          await wired.watch.startupScan();
          after.forEach(run);

          // A tab opened and closed again before the scan ends never shows it
          expect(Notice.instances).toHaveLength(
            openAtScan || after.includes('open') ? 1 : 0
          );
        }
      ),
      { numRuns: 60 }
    );
  });

  it('keeps the notice up, with a Manage button, and names no note', async () => {
    const { watch, openReview } = await wireWatch({
      'notes/secret.md': { 'ir-id': 'x' },
      [`${DATA_DIRECTORY}/s/hidden.md`]: { 'ir-id': 'y', tags: [SNIPPET_TAG] },
    });
    await watch.startupScan();

    openReview();

    const [notice] = Notice.instances;
    expect(notice.message).toBe(
      'Incremental reading: 2 notes were not found in the database.'
    );
    expect(notice.duration).toBe(0);
    expect(noticeButtons(notice).map((b) => b.textContent)).toEqual(['Manage']);
  });

  it("opens the leftovers to choose from from the notice's Manage button, as they are by then", async () => {
    const wired = await wireWatch(ONE_LEFTOVER);
    await wired.watch.startupScan();
    wired.openReview();
    wired.vault.add('notes/later.md', { 'ir-id': 'later' });

    noticeButtons(Notice.instances[0])[0].click();

    await vi.waitFor(() => expect(wired.opened).toHaveLength(1));
    expect(listed(wired.opened[0])).toEqual(['a', 'later']);
    expect(Notice.instances[0].hides).toBeGreaterThan(0);
  });

  it('only hides the notice when its body is clicked', async () => {
    const wired = await wireWatch(ONE_LEFTOVER);
    await wired.watch.startupScan();
    wired.openReview();
    const [notice] = Notice.instances;

    notice.messageEl.click();
    await settle();

    expect(notice.hides).toBeGreaterThan(0);
    expect(wired.open).not.toHaveBeenCalled();
  });

  it('asks about nothing while the database holds no items, as Sync may not have brought it down yet', async () => {
    const { watch, openReview } = await wireWatch(ONE_LEFTOVER, {
      holdsItems: false,
    });

    await watch.startupScan();
    openReview();

    expect(Notice.instances).toEqual([]);
    expect(watch.current).toEqual([]);
  });

  it('says nothing when there are no leftovers', async () => {
    const { watch, openReview } = await wireWatch({
      'notes/a.md': { title: 'plain' },
    });

    await watch.startupScan();
    openReview();

    expect(Notice.instances).toEqual([]);
  });

  it('says nothing, but logs why, when the leftovers cannot be looked for', async () => {
    const { watch, openReview, error } = await wireWatch(ONE_LEFTOVER, {
      failing: true,
    });

    await watch.startupScan();
    openReview();

    expect(Notice.instances).toEqual([]);
    expect(watch.current).toEqual([]);
    expect(error).toHaveBeenCalledExactlyOnceWith(
      'Incremental Reading - failed to look for notes left without review data:',
      expect.any(Error)
    );
  });

  it('holds the leftovers the last look found, and tells its listeners each time it looks', async () => {
    const wired = await wireWatch(ONE_LEFTOVER);
    const listener = vi.fn();
    const unsubscribe = wired.watch.subscribe(listener);

    await wired.watch.startupScan();
    expect(wired.watch.current.map(({ id }) => id)).toEqual(['x']);
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    wired.vault.add('notes/b.md', { 'ir-id': 'y' });
    await wired.watch.manage();
    expect(wired.watch.current.map(({ id }) => id)).toEqual(['x', 'y']);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('looks again when asked to manage the leftovers, and says so, opening nothing, once none are left', async () => {
    const wired = await wireWatch(ONE_LEFTOVER);
    await wired.watch.startupScan();
    wired.vault.files.delete('notes/a.md');

    await wired.watch.manage();

    expect(wired.open).not.toHaveBeenCalled();
    expect(wired.watch.current).toEqual([]);
    expect(Notice.messages).toEqual([
      'Incremental reading: no notes are missing from the database.',
    ]);
  });

  it('opens the leftovers once when asked to manage them again before the first look ends', async () => {
    const wired = await wireWatch(ONE_LEFTOVER);
    await wired.watch.startupScan();

    // A double tap on the home button, or the notice's button and then it
    await Promise.all([wired.watch.manage(), wired.watch.manage()]);
    await wired.watch.manage();

    expect(wired.opened).toHaveLength(2);
  });

  it('says so, opening nothing, when the leftovers cannot be looked for again', async () => {
    const wired = await wireWatch(ONE_LEFTOVER);
    await wired.watch.startupScan();
    vi.spyOn(wired.repo, 'query').mockImplementation(() => {
      throw new Error('read failed');
    });
    const notify = vi.spyOn(Notices, 'notify');

    await wired.watch.manage();

    expect(wired.open).not.toHaveBeenCalled();
    expect(wired.watch.current.map(({ id }) => id)).toEqual(['x']);
    // An error, which no notice after it hides before it is read
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Incremental reading: couldn't look for notes missing from the database.",
      { kind: 'error' }
    );
    expect(wired.error).toHaveBeenCalledOnce();
  });

  it('resolves what is chosen in the modal, as the type chosen, lets go of it, and says so once done', async () => {
    const wired = await wireWatch({
      ...ONE_LEFTOVER,
      'notes/b.md': { 'ir-id': 'y', tags: [ARTICLE_TAG] },
    });
    await wired.watch.manage();
    const listener = vi.fn();
    wired.watch.subscribe(listener);
    const modal = showModal(wired.opened[0]);

    // The second note, tagged as an article, saved as a snippet
    const row = modal.contentEl.querySelectorAll('.setting-item')[1];
    pickFrom(dropdownOf(row)!, 'snippet');
    confirmOf(modal).click();

    await vi.waitFor(() => expect(wired.onResolved).toHaveBeenCalledOnce());
    expect(wired.adoptLeftover).toHaveBeenCalledOnce();
    expect(wired.vault.frontmatterOf('notes/b.md')?.tags).toEqual([
      SNIPPET_TAG,
    ]);
    expect(wired.watch.current.map(({ id }) => id)).toEqual(['x']);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('holds on to a leftover, and says nothing was resolved, when what was chosen was not done', async () => {
    const wired = await wireWatch({
      'notes/a.md': { 'ir-id': 'x', tags: [ARTICLE_TAG] },
    });
    wired.adoptLeftover.mockRejectedValueOnce(new Error('insert failed'));
    vi.spyOn(Obsidian, 'notify').mockReturnValue(undefined);
    await wired.watch.manage();
    const modal = showModal(wired.opened[0]);

    choose(modal.contentEl, { action: 'adopt', as: 'article' });
    confirmOf(modal).click();

    await vi.waitFor(() => expect(wired.adoptLeftover).toHaveBeenCalledOnce());
    await new Promise((settled) => setTimeout(settled, 10));
    expect(wired.onResolved).not.toHaveBeenCalled();
    expect(wired.watch.current.map(({ id }) => id)).toEqual(['x']);
  });
});
