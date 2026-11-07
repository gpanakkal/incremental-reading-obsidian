// @vitest-environment jsdom
import { migrations } from '#/db/migrations';
import * as notices from '#/lib/notices';
import type { BackupFile, BackupKind } from '#/lib/repository/retention';
import type { Readiness } from '#/lib/types';
import { Modal } from '#/test/__mocks__/obsidian';
import fc from 'fast-check';
import type { App } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BackupRestoreModal,
  type BackupSource,
  EMPTY_CLASS,
  MODAL_CLASS,
  REFUSAL_CLASS,
  restoreChosenBackup,
  ROW_CLASS,
} from './BackupRestoreModal';
import * as confirm from './ConfirmModal';

// #region HELPERS

const APP = {} as App;

const LATEST_VERSION = migrations[migrations.length - 1].version;

/** Open and close as Obsidian's do (see `ConfirmModal.test.ts`). */
function wireModalLifecycle() {
  vi.spyOn(Modal.prototype, 'open').mockImplementation(function (this: Modal) {
    this.modalEl.appendChild(this.contentEl);
    this.containerEl.appendChild(this.modalEl);
    document.body.appendChild(this.containerEl);
    void (this as unknown as BackupRestoreModal).onOpen();
  });
  vi.spyOn(Modal.prototype, 'close').mockImplementation(function (this: Modal) {
    this.containerEl.remove();
    (this as unknown as BackupRestoreModal).onClose();
  });
}

const backupArb: fc.Arbitrary<BackupFile> = fc.record({
  path: fc.string(),
  version: fc.nat({ max: LATEST_VERSION + 3 }),
  kind: fc.constantFrom<BackupKind>('merge', 'stale', 'migration'),
  time: fc.integer({ min: -8.64e15, max: 8.64e15 }),
});

const readinessArb = fc.constantFrom<Readiness>('ready', 'merging', 'starting');

/** How a restore the repository is asked for ends. */
const outcomeArb = fc.constantFrom('restores', 'fails');

/** A repository holding `backups`, in a `readiness`, whose restores end so. */
function makeRepo({
  backups = [],
  readiness = 'ready',
  outcome = 'restores',
}: {
  backups?: BackupFile[];
  readiness?: Readiness;
  outcome?: string;
} = {}) {
  return {
    listBackups: vi.fn(async () => backups),
    restoreBackup: vi.fn(async () => {
      if (outcome === 'fails') throw new Error('ENOSPC');
    }),
    readiness,
    onReadinessChange: () => () => {},
    writeRefusal: () => null,
  } satisfies BackupSource;
}

/** Answer every confirmation with `answer`. */
function answerConfirmation(answer: boolean) {
  return vi.spyOn(confirm, 'promptForConfirmation').mockResolvedValue(answer);
}

/** Open the picker over `repo`, once it has listed the backups. */
async function openPicker(repo: BackupSource) {
  const modal = new BackupRestoreModal(APP, repo);
  modal.open();
  await vi.waitFor(() => expect(repo.listBackups).toHaveBeenCalled());
  await Promise.resolve();
  return modal;
}

function rows(modal: BackupRestoreModal): HTMLElement[] {
  return [...modal.contentEl.querySelectorAll<HTMLElement>(`.${ROW_CLASS}`)];
}

function buttonOf(row: HTMLElement): HTMLButtonElement {
  return row.querySelector('button')!;
}

/** Let every pending promise settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// #endregion

describe('BackupRestoreModal', () => {
  beforeEach(() => {
    wireModalLifecycle();
    vi.spyOn(notices, 'notify').mockReturnValue(null);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('lists every backup, in order, each by its date, why it was taken and its schema version', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(backupArb, { maxLength: 8 }),
        async (backups) => {
          const repo = makeRepo({ backups });
          const modal = await openPicker(repo);

          expect(modal.modalEl.classList.contains(MODAL_CLASS)).toBe(true);
          const shown = rows(modal);
          expect(shown).toHaveLength(backups.length);
          expect(
            modal.contentEl.querySelector(`.${EMPTY_CLASS}`) !== null
          ).toBe(backups.length === 0);
          // The description proper, before any line saying why it can't
          // be restored
          const descs = shown.map(
            (row) =>
              row.querySelector('.setting-item-description')!.firstChild!
                .textContent
          );
          backups.forEach((backup, i) => {
            expect(
              shown[i].querySelector('.setting-item-name')!.textContent
            ).toBe(new Date(backup.time).toLocaleString());
            expect(descs[i]).toMatch(new RegExp(`\\b${backup.version}$`));
            backups.forEach((other, j) => {
              expect(descs[i] === descs[j]).toBe(
                backup.kind === other.kind && backup.version === other.version
              );
            });
          });
          modal.close();
          expect(modal.contentEl.childElementCount).toBe(0);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('offers no backup written by a newer version of the plugin', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(backupArb, { minLength: 1, maxLength: 8 }),
        async (backups) => {
          const modal = await openPicker(makeRepo({ backups }));

          rows(modal).forEach((row, i) => {
            const newer = backups[i].version > LATEST_VERSION;
            expect(buttonOf(row).disabled).toBe(newer);
            // Said in the row itself, as a disabled button shows no tooltip
            // and a phone has no hover
            expect(
              row.querySelector(
                `.setting-item-description .${REFUSAL_CLASS}`
              ) !== null
            ).toBe(newer);
          });
          modal.close();
        }
      ),
      { numRuns: 30 }
    );
  });

  it("restores a row's backup once confirmed, closing the picker only when it was restored", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(backupArb, { minLength: 1, maxLength: 5 }),
        fc.nat(),
        fc.boolean(),
        readinessArb,
        outcomeArb,
        async (backups, pick, confirmed, readiness, outcome) => {
          const restorable = backups.map((b) => ({
            ...b,
            version: Math.min(b.version, LATEST_VERSION),
          }));
          const chosen = restorable[pick % restorable.length];
          const repo = makeRepo({ backups: restorable, readiness, outcome });
          answerConfirmation(confirmed);
          const modal = await openPicker(repo);

          buttonOf(rows(modal)[pick % restorable.length]).click();
          await flush();

          const asked = confirmed && readiness === 'ready';
          expect(repo.restoreBackup.mock.calls).toStrictEqual(
            asked ? [[chosen.path]] : []
          );
          expect(modal.containerEl.isConnected).toBe(
            !(asked && outcome === 'restores')
          );
          modal.close();
          vi.mocked(confirm.promptForConfirmation).mockRestore();
        }
      ),
      { numRuns: 40 }
    );
  });
});

describe('restoreChosenBackup', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks first, restores only once confirmed and ready, and says how it went', async () => {
    await fc.assert(
      fc.asyncProperty(
        backupArb,
        fc.boolean(),
        readinessArb,
        outcomeArb,
        async (backup, confirmed, readiness, outcome) => {
          const notify = vi.spyOn(notices, 'notify').mockReturnValue(null);
          const prompt = answerConfirmation(confirmed);
          const repo = makeRepo({ readiness, outcome });

          const restored = await restoreChosenBackup(APP, repo, backup);

          const asked = confirmed && readiness === 'ready';
          expect(prompt).toHaveBeenCalledOnce();
          expect(prompt.mock.calls[0][1].destructive).toBe(true);
          expect(prompt.mock.calls[0][1].paragraphs.join(' ')).toContain(
            new Date(backup.time).toLocaleString()
          );
          expect(repo.restoreBackup.mock.calls).toStrictEqual(
            asked ? [[backup.path]] : []
          );
          expect(restored).toBe(asked && outcome === 'restores');
          const kinds = notify.mock.calls.map(([, options]) => options?.kind);
          if (!confirmed) expect(kinds).toStrictEqual([]);
          else if (!asked || outcome === 'fails') {
            expect(kinds).toStrictEqual(['error']);
          } else {
            expect(kinds).toStrictEqual(['success']);
            expect(notify.mock.calls[0][0]).toContain(
              new Date(backup.time).toLocaleString()
            );
            expect(notify.mock.calls[0][1]?.persist).toBe(true);
          }
          notify.mockRestore();
          prompt.mockRestore();
        }
      ),
      { numRuns: 60 }
    );
  });
});
