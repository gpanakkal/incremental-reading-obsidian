import type { RowId } from '#/lib/moved-note-scan';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import { invalidateItemQuery } from '#/lib/query-client';
import {
  readClaims,
  relinkCandidates,
  relinkItem,
  unavailability,
  vaultReader,
} from '#/lib/relink';
import type IncrementalReadingPlugin from '#/main';
import { type App, FuzzySuggestModal, type TFile } from 'obsidian';

/** A fuzzy picker over the files a missing item may be relinked to. */
export class RelinkModal extends FuzzySuggestModal<TFile> {
  readonly #candidates: TFile[];
  readonly #onChoose: (file: TFile) => Promise<void>;

  constructor(
    app: App,
    reference: string,
    candidates: TFile[],
    onChoose: (file: TFile) => Promise<void>
  ) {
    super(app);
    this.#candidates = candidates;
    this.#onChoose = onChoose;
    this.setPlaceholder(`Relink "${reference}" to…`);
  }

  getItems(): TFile[] {
    return this.#candidates;
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    void this.#onChoose(file);
  }
}

/**
 * Offer the files `item` may be relinked to (see `relinkCandidates`), and
 * relink it to the one picked.
 * @returns the open picker, or `null` when no file qualifies, after telling
 * the user so
 */
export async function openRelinkPicker(
  plugin: IncrementalReadingPlugin,
  item: RowId & { reference: string }
): Promise<RelinkModal | null> {
  const { app } = plugin;
  const row: RowId = { table: item.table, id: item.id };
  const claims = await readClaims(plugin.reviewManager.repo, row);
  const vault = vaultReader(app);
  const candidates = relinkCandidates(
    app.vault.getFiles(),
    item.reference,
    (file) => unavailability(row, file, claims, vault) !== null
  );
  if (candidates.length === 0) {
    Obsidian.notify('No unlinked files of this type to relink to');
    return null;
  }

  const modal = new RelinkModal(
    app,
    item.reference,
    candidates,
    async (file) => {
      try {
        const result = await relinkItem(plugin, row, file);
        if (result.ok) await invalidateItemQuery(row.id);
      } catch (error) {
        console.error(error);
        Obsidian.notify(`Failed to relink to "${file.path}"`);
      }
    }
  );
  modal.open();
  return modal;
}
