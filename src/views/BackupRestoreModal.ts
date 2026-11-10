import { migrations, pluginVersionsOfSchema } from '#/db/migrations';
import { BACKUP_DIRECTORY } from '#/lib/constants';
import { notify } from '#/lib/notices';
import { requireReady } from '#/lib/readiness';
import type { BackupFile, BackupKind } from '#/lib/repository/retention';
import type { SQLiteRepository } from '#/lib/types';
import { type App, Modal, normalizePath, Platform, Setting } from 'obsidian';
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
  merge: "Made before another device's changes were merged in",
  stale: 'Made before the database was replaced',
  migration: 'Made before a database upgrade',
};

/** The class of the line the picker shows when there is nothing to pick. */
export const EMPTY_CLASS = 'ir-backup-empty';
/** The class of the picker's modal. */
export const MODAL_CLASS = 'ir-backup-modal';
/** The class of each backup's row in the picker. */
export const ROW_CLASS = 'ir-backup-row';
/** The class of the line saying why a row's backup can't be restored. */
export const REFUSAL_CLASS = 'ir-backup-refusal';
/** The class of the picker's opening paragraph, above its rows. */
export const INTRO_CLASS = 'ir-backup-intro';
/** The class of the row with the button that opens the backups folder. */
export const FOLDER_CLASS = 'ir-backup-folder';

/** The schema version this plugin version migrates databases to. */
const LATEST_VERSION = migrations[migrations.length - 1].version;

/** When `backup` was made, as its row shows it. */
export function backupDate(backup: BackupFile): string {
  return new Date(backup.time).toLocaleString();
}

/**
 * The plugin version whose data `backup` holds, as its row shows it: the one
 * its name holds, or else the releases whose databases were at its schema
 * version ("0.6.0–0.6.5", or one version when they are a single release).
 * Always the latter for a backup made before a migration: the version in
 * its name is the one that migrated the data, not the one that wrote it.
 * Null for a backup from a schema version past this plugin's, its version
 * not taken from its name.
 */
export function backupPluginVersion(backup: BackupFile): string | null {
  if (backup.pluginVersion !== null && backup.kind !== 'migration') {
    return backup.pluginVersion;
  }
  const span = pluginVersionsOfSchema(backup.version);
  if (!span) return null;
  return span.first === span.last ? span.first : `${span.first}–${span.last}`;
}

/**
 * What a backup's row says under its date: why it was taken, and which
 * version of the plugin took it. Not its schema version, which means nothing
 * to a user; the row's tooltip has that (see {@link backupSchemaLabel}).
 */
export function backupDescription(backup: BackupFile): string {
  const version = backupPluginVersion(backup);
  const from = version === null ? 'from a newer version' : `v${version}`;
  return `${KIND_DESCRIPTIONS[backup.kind]} · ${from}`;
}

/**
 * The tooltip of a backup's row, for debugging: the plugin version that took
 * it, when its name holds one, and its schema version.
 */
export function backupSchemaLabel(backup: BackupFile): string {
  const schema = `Schema version ${backup.version}`;
  return backup.pluginVersion === null
    ? schema
    : `Made in v${backup.pluginVersion} · ${schema}`;
}

/**
 * Reveal `BACKUP_DIRECTORY` in the system file manager, creating it first if
 * there is none yet, so the button that asks for it always works.
 * `App.showInFolder` is undocumented (typed by obsidian-typings) and does
 * nothing outside the desktop app; it takes a vault-relative path, as
 * Obsidian's own "Show in system explorer" items pass it.
 */
export async function openBackupsFolder(app: App): Promise<void> {
  const folder = normalizePath(BACKUP_DIRECTORY);
  try {
    if (!(await app.vault.adapter.exists(folder))) {
      await app.vault.adapter.mkdir(folder);
    }
  } catch (error) {
    console.error(
      'Incremental Reading - Failed to create the backups folder:',
      error
    );
    notify(
      `Couldn't create the backups folder, ${folder}. Check the console for details.`,
      { kind: 'error' }
    );
    return;
  }
  // Undocumented: see above
  app.showInFolder(folder);
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
      `The review database will be replaced with this backup from ${backupDate(backup)}. `,
      'The current database will be backed up first.',
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
  notify(`Restored the backup from ${backupDate(backup)}.`, {
    kind: 'success',
    persist: true,
  });
  return true;
}

/**
 * Lists the backups the plugin keeps in the vault (`BACKUP_DIRECTORY`),
 * newest first, each with when it was taken, why, and the plugin version that
 * took it, for the user to restore one in place of the database. Obsidian
 * Sync's version history can't be listed from a plugin, so the in-vault
 * backups are all it offers, as its empty state says. On desktop, it also
 * opens their folder in the system file manager.
 */
export class BackupRestoreModal extends Modal {
  readonly #repo: BackupSource;
  /** The version of the plugin running (its manifest's). */
  readonly #pluginVersion: string;

  constructor(app: App, repo: BackupSource, pluginVersion: string) {
    super(app);
    this.#repo = repo;
    this.#pluginVersion = pluginVersion;
  }

  async onOpen() {
    this.modalEl.classList.add(MODAL_CLASS);
    this.setTitle('Restore a backup');
    const backups = await this.#repo.listBackups();
    if (backups.length === 0) {
      createEl('p', {
        cls: EMPTY_CLASS,
        text:
          `There are no backups in ${BACKUP_DIRECTORY}. Only backups ` +
          'in the vault can be restored here. Plugins have no ' +
          "access to Obsidian Sync's version history.",
        parent: this.contentEl,
      });
      this.#addFolderRow();
      return;
    }
    createEl('p', {
      cls: INTRO_CLASS,
      text:
        'Replace the review database with a backup. The current database will be backed up first. ' +
        `Current plugin version: ${this.#pluginVersion}.`,
      parent: this.contentEl,
    });
    this.#addFolderRow();
    for (const backup of backups) this.#addRow(backup);
  }

  /** The row that opens the backups folder: desktop only, as revealing a
   * folder in a file manager has no meaning on mobile. */
  #addFolderRow() {
    if (Platform.isMobile) return;
    new Setting(this.contentEl)
      .setClass(FOLDER_CLASS)
      .setDesc(`Backups are kept in ${normalizePath(BACKUP_DIRECTORY)}.`)
      .addButton((button) => {
        button.setButtonText('Open backups folder').onClick(() => {
          void openBackupsFolder(this.app);
        });
      });
  }

  #addRow(backup: BackupFile) {
    const restorable = canRestore(backup);
    const row = new Setting(this.contentEl)
      .setClass(ROW_CLASS)
      .setName(backupDate(backup))
      .setDesc(backupDescription(backup));
    // Obsidian shows an `aria-label` as its own tooltip
    row.settingEl.setAttribute('aria-label', backupSchemaLabel(backup));
    if (!restorable) {
      // In the row, not a tooltip: a disabled button shows none, and a phone
      // has no hover
      createDiv({
        cls: `${REFUSAL_CLASS} mod-warning`,
        text: 'Made by a newer version of the plugin. Update to restore this backup.',
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
