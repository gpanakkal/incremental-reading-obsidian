import { migrations } from '#/db/migrations';
import { BACKUP_DIRECTORY } from '#/lib/constants';
import { notify } from '#/lib/notices';
import { requireReady } from '#/lib/readiness';
import type { BackupFile, BackupKind } from '#/lib/repository/retention';
import type { SQLiteRepository } from '#/lib/types';
import { type App, Modal, Setting } from 'obsidian';
import { promptForConfirmation } from './ConfirmModal';

/** What the picker needs of the repository. */
export type BackupSource = Pick<
  SQLiteRepository,
  | 'listBackups'
  | 'restoreBackup'
  | 'readiness'
  | 'onReadinessChange'
  | 'writeRefusal'
>;

/** What each kind of backup was taken before, as its row says. */
const KIND_DESCRIPTIONS: Readonly<Record<BackupKind, string>> = {
  merge: "Taken before another device's changes were merged in",
  stale: 'Taken before the database was replaced',
  migration: 'Taken before a database upgrade',
};

/** The class of the line the picker shows when there is nothing to pick. */
export const EMPTY_CLASS = 'ir-backup-empty';
/** The class of the picker's modal. */
export const MODAL_CLASS = 'ir-backup-modal';
/** The class of each backup's row in the picker. */
export const ROW_CLASS = 'ir-backup-row';
/** The class of the line saying why a row's backup can't be restored. */
export const REFUSAL_CLASS = 'ir-backup-refusal';

/** The schema version this plugin version migrates databases to. */
const LATEST_VERSION = migrations[migrations.length - 1].version;

/** When `backup` was taken, as its row shows it. */
export function backupDate(backup: BackupFile): string {
  return new Date(backup.time).toLocaleString();
}

/** What a backup's row says under its date. */
export function backupDescription(backup: BackupFile): string {
  return `${KIND_DESCRIPTIONS[backup.kind]} · schema version ${backup.version}`;
}

/**
 * Whether this version of the plugin can restore `backup`: not one written by
 * a newer version, at a schema version past this one's.
 */
export function canRestore(backup: BackupFile): boolean {
  return backup.version <= LATEST_VERSION;
}

/**
 * Ask to confirm, then replace the database with `backup` (see
 * `SQLiteRepository.restoreBackup`), telling the user how it went.
 * @returns whether the database was replaced
 */
export async function restoreChosenBackup(
  app: App,
  repo: BackupSource,
  backup: BackupFile
): Promise<boolean> {
  const confirmed = await promptForConfirmation(app, {
    title: 'Restore this backup?',
    paragraphs: [
      `The review database will be replaced with the backup taken ${backupDate(backup)}. ` +
        'Reviews and changes made since then will be gone from it.',
      'The current database is backed up first, so this can be undone by restoring that backup.',
    ],
    confirmText: 'Restore',
    destructive: true,
  });
  if (!confirmed) return false;
  if (!(await requireReady(repo, 'multi-step', 'restore the backup'))) {
    return false;
  }
  try {
    await repo.restoreBackup(backup.path);
  } catch (error) {
    console.error('Incremental Reading - Failed to restore a backup:', error);
    notify(
      "Couldn't restore the backup. The database was left as it was. " +
        'Check the console for details.',
      { kind: 'error' }
    );
    return false;
  }
  notify(`Restored the backup taken ${backupDate(backup)}.`, {
    kind: 'success',
    persist: true,
  });
  return true;
}

/**
 * Lists the backups the plugin keeps in the vault (`BACKUP_DIRECTORY`),
 * newest first, each with when it was taken, why, and its schema version,
 * for the user to restore one in place of the database. Obsidian Sync's
 * version history can't be listed from a plugin, so the in-vault backups are
 * all it offers, as its empty state says.
 */
export class BackupRestoreModal extends Modal {
  readonly #repo: BackupSource;

  constructor(app: App, repo: BackupSource) {
    super(app);
    this.#repo = repo;
  }

  async onOpen() {
    this.modalEl.classList.add(MODAL_CLASS);
    this.setTitle('Restore a backup');
    const backups = await this.#repo.listBackups();
    if (backups.length === 0) {
      createEl('p', {
        cls: EMPTY_CLASS,
        text:
          `There are no backups in ${BACKUP_DIRECTORY}. Only backups the ` +
          'plugin keeps in the vault can be restored here: plugins have no ' +
          "access to Obsidian Sync's version history.",
        parent: this.contentEl,
      });
      return;
    }
    createEl('p', {
      text:
        'Replace the review database with a backup, as it was when the ' +
        'backup was taken. The current database is backed up first.',
      parent: this.contentEl,
    });
    for (const backup of backups) this.#addRow(backup);
  }

  #addRow(backup: BackupFile) {
    const restorable = canRestore(backup);
    const row = new Setting(this.contentEl)
      .setClass(ROW_CLASS)
      .setName(backupDate(backup))
      .setDesc(backupDescription(backup));
    if (!restorable) {
      // In the row, not a tooltip: a disabled button shows none, and a phone
      // has no hover
      createDiv({
        cls: `${REFUSAL_CLASS} mod-warning`,
        text: 'Made by a newer version of the plugin. Update it to restore this backup.',
        parent: row.descEl,
      });
    }
    row.addButton((button) => {
      button
        .setButtonText('Restore')
        .setDisabled(!restorable)
        .onClick(async () => {
          if (await restoreChosenBackup(this.app, this.#repo, backup)) {
            this.close();
          }
        });
    });
  }

  onClose() {
    this.contentEl.replaceChildren();
  }
}
