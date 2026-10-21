/**
 * Where a reader is in an item, kept in two tiers so that reading writes
 * nothing to the database:
 *
 * - **Device tier** (localStorage, through {@link PositionStorage}): every
 *   move, kept in memory at once and written out at most once per
 *   {@link STORAGE_WRITE_INTERVAL_MS}. Every tab on the device reads the same
 *   entry, so a tab opened right after another one scrolled opens where that
 *   one is; and it survives the app being killed.
 * - **Database tier** (the item's row, through {@link PositionRows}): written
 *   once, when the last tab holding the item lets go of it, or when the whole
 *   tier is flushed (the document hidden, the app quitting, leftovers at load).
 *
 * A position is a number: a document character offset for a note, a packed
 * page and top for a PDF (`#/lib/pdf/position`). The store never looks inside.
 */

/** A position as the device tier keeps it. */
export interface StoredPosition {
  position: number;
  /** When it was set, by the store's clock (ms). */
  at: number;
  /**
   * The row's position as this device last read or wrote it before `at`;
   * absent when it had not seen the row. A row still holding it has had its
   * position moved by no one since, so this one is the newer.
   */
  base?: number;
}

/** The device tier's backing store: every entry under one key. */
export interface PositionStorage {
  /** Every entry, as {@link save} last wrote them; anything else for none. */
  load(): unknown;
  /** Replace every entry; `null` when none are left. */
  save(entries: Record<string, StoredPosition> | null): void;
}

/** What an item's row says about its position. */
export interface PositionRow {
  /** `0` when nothing is stored. */
  position: number;
  /** The row's change stamp (ms): the last write that changed any column. */
  updatedAt: number;
  /** The device that made that write. */
  updatedBy: string;
}

/** The database tier, read and written by item id. */
export interface PositionRows<R extends PositionRow = PositionRow> {
  /** The item's row, or `null` when it has none that holds a position. */
  read(id: string): Promise<R | null>;
  /** Store `position` in the row {@link read} returned. */
  write(id: string, position: number, row: R): Promise<void>;
}

/** One tab's hold on an item's position, from {@link PositionStore.open}. */
export interface PositionHandle {
  /**
   * Where the tab should open: the device tier's position if it has one, else
   * the row's; `null` when neither holds one.
   */
  restore(): Promise<number | null>;
  /** The reader moved to `position`. Ignored once closed. */
  set(position: number): void;
  /** The tab let go of the item. Only the first call counts. */
  close(): void;
}

/** The longest a move waits in memory before it is written to localStorage. */
export const STORAGE_WRITE_INTERVAL_MS = 100;

function isStoredPosition(value: unknown): value is StoredPosition {
  const { position, at } = (value ?? {}) as Record<string, unknown>;
  return Number.isFinite(position) && Number.isFinite(at);
}

/** `position` set at `at`, with `base` when it is known. */
function storedPosition(
  position: number,
  at: number,
  base: unknown
): StoredPosition {
  return Number.isFinite(base)
    ? { position, at, base: base as number }
    : { position, at };
}

/** The entries in `value`, leaving out any that aren't a position. */
function parseEntries(value: unknown): Map<string, StoredPosition> {
  const entries = new Map<string, StoredPosition>();
  for (const [id, entry] of Object.entries((value ?? {}) as object)) {
    if (isStoredPosition(entry)) {
      entries.set(id, storedPosition(entry.position, entry.at, entry.base));
    }
  }
  return entries;
}

export class PositionStore<R extends PositionRow = PositionRow> {
  readonly #storage: PositionStorage;
  readonly #rows: PositionRows<R>;
  readonly #deviceId: () => string;
  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;

  /**
   * The device tier, read from storage once and written through from then
   * on. The plugin is the only writer of its key, and every window of the
   * app runs this one instance, so nothing can change storage under it.
   */
  #entries: Map<string, StoredPosition> | null = null;
  #writeTimer: number | undefined;
  /** How many open handles hold each item. */
  readonly #holders = new Map<string, number>();
  /**
   * Each item's row position as this device last read or wrote it: the
   * {@link StoredPosition.base} of the next move.
   */
  readonly #seen = new Map<string, number>();
  /** Flushes, run one after another: they are few, and never overlap. */
  #flushes: Promise<void> = Promise.resolve();

  constructor(options: {
    storage: PositionStorage;
    rows: PositionRows<R>;
    /** This device's id, as the rows' `updatedBy` names it. */
    deviceId: () => string;
    now?: () => number;
    /** Told of a storage or database failure, which costs no state. */
    onError?: (error: unknown) => void;
  }) {
    this.#storage = options.storage;
    this.#rows = options.rows;
    this.#deviceId = options.deviceId;
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? (() => {});
  }

  /** A tab opened item `id`; hold it until {@link PositionHandle.close}. */
  open(id: string): PositionHandle {
    this.#holders.set(id, (this.#holders.get(id) ?? 0) + 1);
    let closed = false;
    /** The row's position this handle restored, when that is where it opened. */
    let restoredFromRow: number | null = null;

    return {
      restore: async () => {
        const local = this.#load().get(id);
        if (local) return local.position;
        let row: R | null = null;
        try {
          row = await this.#rows.read(id);
        } catch (error) {
          this.#onError(error);
        }
        if (!row) return null;
        this.#seen.set(id, row.position);
        if (row.position <= 0) return null;
        restoredFromRow = row.position;
        return row.position;
      },
      set: (position) => {
        if (closed) return;
        const entries = this.#load();
        // Opening at a position reports it straight back: no move
        const current = entries.get(id)?.position ?? restoredFromRow;
        if (position === current) return;
        const base = this.#seen.get(id) ?? entries.get(id)?.base;
        entries.set(id, storedPosition(position, this.#now(), base));
        this.#scheduleWrite();
      },
      close: () => {
        if (closed) return;
        closed = true;
        const left = (this.#holders.get(id) ?? 1) - 1;
        if (left > 0) {
          this.#holders.set(id, left);
          return;
        }
        this.#holders.delete(id);
        void this.#flush(id);
      },
    };
  }

  /**
   * Write every item's device-tier position to its row, and drop the entries
   * of items no tab holds: for the document going hidden, the app quitting,
   * and at load, where every entry is one a killed app left behind.
   */
  flushAll(): Promise<void> {
    this.persist();
    const ids = [...this.#load().keys()];
    return Promise.all(ids.map((id) => this.#flush(id))).then(() => {});
  }

  /** Write any move still waiting in memory to storage now. */
  persist(): void {
    if (this.#writeTimer !== undefined) this.#saveNow();
  }

  #load(): Map<string, StoredPosition> {
    if (this.#entries) return this.#entries;
    let stored: unknown = null;
    try {
      stored = this.#storage.load();
    } catch (error) {
      this.#onError(error);
    }
    this.#entries = parseEntries(stored);
    return this.#entries;
  }

  /** Write every entry to storage now, in place of any write scheduled. */
  #saveNow(): void {
    window.clearTimeout(this.#writeTimer);
    this.#writeTimer = undefined;
    const entries = this.#load();
    try {
      this.#storage.save(
        entries.size === 0 ? null : Object.fromEntries(entries)
      );
    } catch (error) {
      // Kept in memory: the database tier still gets it
      this.#onError(error);
    }
  }

  #scheduleWrite(): void {
    if (this.#writeTimer !== undefined) return;
    this.#writeTimer = window.setTimeout(
      () => this.#saveNow(),
      STORAGE_WRITE_INTERVAL_MS
    );
  }

  #flush(id: string): Promise<void> {
    this.#flushes = this.#flushes.then(() => this.#flushNow(id));
    return this.#flushes;
  }

  async #flushNow(id: string): Promise<void> {
    const entries = this.#load();
    const entry = entries.get(id);
    if (!entry) return;
    // On disk before the database is asked, so a kill mid-flush loses nothing
    this.persist();

    try {
      const row = await this.#rows.read(id);
      if (row && this.#isNewer(entry, row)) {
        await this.#rows.write(id, entry.position, row);
        this.#seen.set(id, entry.position);
      } else if (row) {
        this.#seen.set(id, row.position);
      }
    } catch (error) {
      // Kept: the next flush, at the latest the one at load, tries again
      this.#onError(error);
      return;
    }

    // Dropped once no tab holds the item, so that a position another device
    // stores later is not shadowed by this one; kept if a tab moved since
    if (!this.#holders.has(id) && entries.get(id) === entry) {
      entries.delete(id);
      this.#saveNow();
    }
  }

  /**
   * Whether `entry` should replace the position in `row`: it differs, and
   * nobody has moved the row's position since `entry` was set.
   *
   * The row's stamp is the row's, not its position's: reviewing the item, or
   * changing its priority, stamps it too. So a row stamped after `entry` was
   * set is still `entry`'s to write when its position is the one this device
   * saw before `entry` was set ({@link StoredPosition.base}): what changed was
   * another column. A position another device stored since then wins, even
   * when this device has stamped the row after it. When the base is unknown,
   * a row this device stamped last is taken for one whose position it knows.
   */
  #isNewer(entry: StoredPosition, row: R): boolean {
    if (entry.position === row.position) return false;
    if (entry.at > row.updatedAt) return true;
    return entry.base === undefined
      ? row.updatedBy === this.#deviceId()
      : row.position === entry.base;
  }
}
