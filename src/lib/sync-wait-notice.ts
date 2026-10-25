import type { Notice } from 'obsidian';
import { notify } from './notices';

/** What a {@link SyncWaitNotice} reads and does. */
export interface SyncWaitNoticeOptions {
  /** Whether a review tab is open now. */
  reviewOpen: () => boolean;
  /** Import the notes waiting, whatever Sync is doing. */
  importNow: () => void;
}

/**
 * Tells the user, while a review tab is open, how many automatic imports wait
 * for Sync that is paused, offline, failing or stuck, with a button to import
 * them anyway (see `AutoImportWatcher.importDespiteSync`). It stays up until
 * none wait, the button is pressed, the last review tab closes, or the user
 * hides it; a review tab opened while some still wait shows it again. With no
 * review tab open it never shows, whatever the count.
 */
export class SyncWaitNotice {
  readonly #options: SyncWaitNoticeOptions;
  #waiting = 0;
  #notice: Notice | null = null;

  constructor(options: SyncWaitNoticeOptions) {
    this.#options = options;
  }

  /** Hear that `waiting` notes wait for Sync now. */
  setWaiting(waiting: number): void {
    if (waiting === this.#waiting) return;
    this.#waiting = waiting;
    this.#show(this.#options.reviewOpen());
  }

  /** Hear that a review tab opened. */
  reviewOpened(): void {
    this.#show(true);
  }

  /** Hear that a review tab closed: the last one takes the notice down. */
  reviewClosed(): void {
    if (!this.#options.reviewOpen()) this.#hide();
  }

  /** Take the notice down for good, as the plugin unloads. */
  dispose(): void {
    this.#waiting = 0;
    this.#hide();
  }

  #show(reviewOpen: boolean): void {
    this.#hide();
    if (this.#waiting === 0 || !reviewOpen) return;
    const notice = notify(describeSyncWait(this.#waiting), {
      persist: true,
      action: {
        label: 'Import now',
        onClick: () => {
          if (this.#notice === notice) this.#notice = null;
          this.#options.importNow();
        },
      },
    });
    this.#notice = notice;
  }

  #hide(): void {
    this.#notice?.hide();
    this.#notice = null;
  }
}

/** What the notice says for `waiting` notes waiting. */
export function describeSyncWait(waiting: number): string {
  const imports = `${waiting} automatic import${waiting === 1 ? '' : 's'}`;
  return `${imports} waiting for Sync to finish or resume.`;
}
