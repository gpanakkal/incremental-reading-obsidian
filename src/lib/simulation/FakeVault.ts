export interface FakeFile {
  path: string;
  deleted?: boolean;
}

/** The path the database file is read from when a caller names none. */
export const DEFAULT_DB_PATH = 'ir-user-data.sqlite';

class FakeAdapter {
  #pendingWrites: Array<{ resolve: () => void; reject: (e: Error) => void }> =
    [];
  #files = new Map<string, ArrayBuffer>();
  #lastWrittenBytes: ArrayBuffer | null = null;

  /**
   * @param autoResolveWrites whether writes land at once, as on a device left
   * to run, rather than waiting on {@link resolvePendingWrite}
   */
  constructor(readonly autoResolveWrites: boolean) {}

  /** Lands on disk once resolved, which is when Obsidian reports it. */
  writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.#lastWrittenBytes = data;
    if (this.autoResolveWrites) {
      this.#files.set(path, data);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.#pendingWrites.push({
        resolve: () => {
          this.#files.set(path, data);
          resolve();
        },
        reject,
      });
    });
  }

  readBinary(path: string): Promise<ArrayBuffer> {
    return Promise.resolve(this.#files.get(path) ?? new ArrayBuffer(0));
  }

  exists(_path: string): Promise<boolean> {
    return Promise.resolve(true);
  }

  mkdir(_path: string): Promise<void> {
    return Promise.resolve();
  }

  write(_path: string, _content: string): Promise<void> {
    return Promise.resolve();
  }

  resolvePendingWrite(): void {
    this.#pendingWrites.shift()?.resolve();
  }

  rejectPendingWrite(e: Error): void {
    this.#pendingWrites.shift()?.reject(e);
  }

  get pendingWriteCount(): number {
    return this.#pendingWrites.length;
  }

  get lastWrittenBytes(): ArrayBuffer | null {
    return this.#lastWrittenBytes;
  }

  setDiskBytes(data: ArrayBuffer, path = DEFAULT_DB_PATH): void {
    this.#files.set(path, data);
  }

  diskBytes(path = DEFAULT_DB_PATH): ArrayBuffer | undefined {
    return this.#files.get(path);
  }

  /** Paths of every file on disk. */
  paths(): string[] {
    return [...this.#files.keys()];
  }
}

export class FakeVault {
  adapter: FakeAdapter;

  constructor(opts: { autoResolveWrites?: boolean } = {}) {
    this.adapter = new FakeAdapter(opts.autoResolveWrites ?? false);
  }

  getFolderByPath(_path: string) {
    return { path: _path };
  }

  getAbstractFileByPath(_path: string) {
    return null;
  }

  createFolder(_path: string): Promise<void> {
    return Promise.resolve();
  }

  /** What localStorage holds for this device (`loadLocalStorage`). */
  localStorage = new Map<string, unknown>();

  get app() {
    return {
      vault: this,
      loadLocalStorage: (key: string): unknown =>
        this.localStorage.get(key) ?? null,
      saveLocalStorage: (key: string, data: unknown) => {
        if (data === null) this.localStorage.delete(key);
        else this.localStorage.set(key, data);
      },
    };
  }

  resolvePendingWrite(): void {
    this.adapter.resolvePendingWrite();
  }

  rejectPendingWrite(e: Error): void {
    this.adapter.rejectPendingWrite(e);
  }

  get pendingWriteCount(): number {
    return this.adapter.pendingWriteCount;
  }

  setDiskBytes(data: ArrayBuffer, path = DEFAULT_DB_PATH): void {
    this.adapter.setDiskBytes(data, path);
  }

  get lastWrittenBytes(): ArrayBuffer | null {
    return this.adapter.lastWrittenBytes;
  }
}
