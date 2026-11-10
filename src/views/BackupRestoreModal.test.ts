// @vitest-environment jsdom
import { migrations, pluginVersionsOfSchema } from '#/db/migrations';
import { BACKUP_DIRECTORY } from '#/lib/constants';
import * as notices from '#/lib/notices';
import type { BackupFile, BackupKind } from '#/lib/repository/retention';
import type { Readiness } from '#/lib/types';
import { Modal, Platform } from '#/test/__mocks__/obsidian';
import fc from 'fast-check';
import type { App } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BackupRestoreModal,
  type BackupSource,
  EMPTY_CLASS,
  FOLDER_CLASS,
  INTRO_CLASS,
  MODAL_CLASS,
  REFUSAL_CLASS,
  restoreChosenBackup,
  ROW_CLASS,
} from './BackupRestoreModal';
import * as confirm from './ConfirmModal';

// #region HELPERS

const APP = {} as App;

/** The version of the plugin the picker is opened from, unless one is given. */
const RUNNING = '0.8.3';

/**
 * An app whose vault has a backups folder or not, whose folder can or can't
 * be made, and that reveals folders (see `App.showInFolder`).
 */
function makeApp({
  folderExists = true,
  mkdirFails = false,
}: { folderExists?: boolean; mkdirFails?: boolean } = {}) {
  const adapter = {
    exists: vi.fn(async () => folderExists),
    mkdir: vi.fn(async () => {
      if (mkdirFails) throw new Error('EACCES');
    }),
  };
  const showInFolder = vi.fn();
  const app = { vault: { adapter }, showInFolder } as unknown as App;
  return { app, adapter, showInFolder };
}

/** Plugin versions as a manifest holds them, and a backup's name may. */
const pluginVersionArb = fc.stringMatching(/^[0-9A-Za-z.+-]+$/);

/** Escape `text` to match it literally in a regular expression. */
const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
  pluginVersion: fc.option(pluginVersionArb, { nil: null }),
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

/**
 * Open the picker over `repo` in `app`, run by version `running` of the
 * plugin, once it has listed the backups.
 */
async function openPicker(
  repo: BackupSource,
  { app = APP, running = RUNNING }: { app?: App; running?: string } = {}
) {
  const modal = new BackupRestoreModal(app, repo, running);
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

/** What a backup's row says of it, before any line on why it can't be restored. */
function descOf(row: HTMLElement): string {
  return row.querySelector('.setting-item-description')!.firstChild!
    .textContent!;
}

function folderRow(modal: BackupRestoreModal): HTMLElement | null {
  return modal.contentEl.querySelector<HTMLElement>(`.${FOLDER_CLASS}`);
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
    Platform.isMobile = false;
    vi.restoreAllMocks();
  });

  it('lists every backup, in order, each by its date, why it was taken and the plugin version that took it, its schema version only in a tooltip', async () => {
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
          const descs = shown.map(descOf);
          /** Whether its row shows the plugin version its name holds. */
          const named = (
            backup: BackupFile
          ): backup is BackupFile & { pluginVersion: string } =>
            backup.pluginVersion !== null && backup.kind !== 'migration';
          /** Which plugin versions a backup comes from, named or derived. */
          const origin = (backup: BackupFile) => {
            if (named(backup)) return backup.pluginVersion;
            const span = pluginVersionsOfSchema(backup.version);
            // A span of one release is that release, as a name gives it
            return span && span.first === span.last ? span.first : span;
          };
          backups.forEach((backup, i) => {
            expect(
              shown[i].querySelector('.setting-item-name')!.textContent
            ).toBe(new Date(backup.time).toLocaleString());
            if (named(backup)) {
              expect(descs[i]).toMatch(
                new RegExp(` ${literally(backup.pluginVersion)}$`)
              );
            }
            expect(shown[i].getAttribute('aria-label')).toMatch(
              new RegExp(`\\b${backup.version}$`)
            );
            backups.forEach((other, j) => {
              expect(descs[i] === descs[j]).toBe(
                backup.kind === other.kind &&
                  JSON.stringify(origin(backup)) ===
                    JSON.stringify(origin(other))
              );
            });
          });
          modal.close();
          expect(modal.contentEl.childElementCount).toBe(0);
        }
      ),
      {
        numRuns: 50,
        // A name's plugin version and a derived single release read alike
        examples: [
          [
            [
              {
                path: 'a',
                version: 1,
                pluginVersion: '0.6.0',
                kind: 'merge',
                time: 0,
              },
              {
                path: 'b',
                version: 5,
                pluginVersion: null,
                kind: 'merge',
                time: 0,
              },
            ],
          ],
        ],
      }
    );
  });

  it.each([
    [0, '0.1.0–0.3.1'],
    [2, '0.4.0–0.4.5'],
    [5, '0.6.0'],
    [14, '0.8.0–0.8.2'],
    [LATEST_VERSION, migrations[migrations.length - 1].pluginVersion],
  ])(
    'names the releases a backup at schema version %i comes from when its name has no plugin version',
    async (version, shown) => {
      const backup: BackupFile = {
        path: 'b',
        version,
        pluginVersion: null,
        kind: 'merge',
        time: 0,
      };
      const modal = await openPicker(makeRepo({ backups: [backup] }));

      expect(descOf(rows(modal)[0])).toMatch(
        new RegExp(` ${literally(shown)}$`)
      );
      modal.close();
    }
  );

  it('property: names the releases of its data for a backup taken before a migration, the version that took it only in its tooltip', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: LATEST_VERSION + 3 }),
        fc.option(pluginVersionArb, { nil: null }),
        async (version, taker) => {
          const backup: BackupFile = {
            path: 'b',
            version,
            pluginVersion: taker,
            kind: 'migration',
            time: 0,
          };
          const unnamed = { ...backup, pluginVersion: null };
          const modal = await openPicker(
            makeRepo({ backups: [backup, unnamed] })
          );

          const [row, unnamedRow] = rows(modal);
          // As if its name had no plugin version
          expect(descOf(row)).toBe(descOf(unnamedRow));
          const label = row.getAttribute('aria-label')!;
          expect(label).toMatch(new RegExp(`\\b${version}$`));
          if (taker !== null) expect(label).toContain(` ${taker} `);
          else expect(label).not.toContain(String(null));
          modal.close();
        }
      ),
      { numRuns: 30 }
    );
  });

  it('names the releases of schema 14 for a migration backup the next release took', async () => {
    const backup: BackupFile = {
      path: 'b',
      version: 14,
      pluginVersion: '0.8.3',
      kind: 'migration',
      time: 0,
    };
    const modal = await openPicker(makeRepo({ backups: [backup] }));

    expect(descOf(rows(modal)[0])).toMatch(/ 0\.8\.0–0\.8\.2$/);
    modal.close();
  });

  it('names no release for a backup from a newer schema whose name has no plugin version', async () => {
    const backup: BackupFile = {
      path: 'b',
      version: LATEST_VERSION + 1,
      pluginVersion: null,
      kind: 'merge',
      time: 0,
    };
    const modal = await openPicker(makeRepo({ backups: [backup] }));

    const desc = descOf(rows(modal)[0]);
    expect(desc).not.toMatch(/\d/);
    expect(desc).not.toContain(String(null));
    modal.close();
  });

  it('property: names the plugin version running', async () => {
    await fc.assert(
      fc.asyncProperty(
        pluginVersionArb,
        fc.array(backupArb, { minLength: 1, maxLength: 3 }),
        async (running, backups) => {
          const modal = await openPicker(makeRepo({ backups }), { running });

          const intro = modal.contentEl.querySelector(`.${INTRO_CLASS}`);
          expect(intro?.textContent).toContain(` ${running} `);
          modal.close();
        }
      ),
      { numRuns: 20 }
    );
  });

  it('property: on desktop, reveals the backups folder, making it first if there is none, with or without backups', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.array(backupArb, { maxLength: 2 }),
        async (folderExists, backups) => {
          const { app, adapter, showInFolder } = makeApp({ folderExists });
          const modal = await openPicker(makeRepo({ backups }), { app });

          expect(folderRow(modal)!.textContent).toContain(BACKUP_DIRECTORY);
          buttonOf(folderRow(modal)!).click();
          await flush();

          expect(adapter.mkdir.mock.calls).toStrictEqual(
            folderExists ? [] : [[BACKUP_DIRECTORY]]
          );
          expect(showInFolder.mock.calls).toStrictEqual([[BACKUP_DIRECTORY]]);
          // Below the text, above the backups
          expect([...modal.contentEl.children].indexOf(folderRow(modal)!)).toBe(
            1
          );
          modal.close();
        }
      ),
      { numRuns: 20 }
    );
  });

  it('reveals nothing, and says so, when the backups folder cannot be made', async () => {
    const { app, showInFolder } = makeApp({
      folderExists: false,
      mkdirFails: true,
    });
    const modal = await openPicker(makeRepo(), { app });

    buttonOf(folderRow(modal)!).click();
    await flush();

    expect(showInFolder).not.toHaveBeenCalled();
    const notify = vi.mocked(notices.notify);
    expect(notify.mock.calls.map(([, options]) => options?.kind)).toStrictEqual(
      ['error']
    );
    expect(notify.mock.calls[0][0]).toContain(BACKUP_DIRECTORY);
    modal.close();
  });

  it('property: offers no backups folder to open on mobile', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(backupArb, { maxLength: 2 }),
        async (backups) => {
          Platform.isMobile = true;
          const modal = await openPicker(makeRepo({ backups }), {
            app: makeApp().app,
          });

          expect(folderRow(modal)).toBeNull();
          expect(rows(modal)).toHaveLength(backups.length);
          modal.close();
        }
      ),
      { numRuns: 10 }
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
