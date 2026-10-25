export interface FakeFile {
  path: string;
  deleted?: boolean;
}

/** The path the database file is read from when a caller names none. */
export const DEFAULT_DB_PATH = 'ir-user-data.sqlite';

/** Whether Obsidian leaves `path` out of its index: a segment starts with `.` */
function isHidden(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.'));
}

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

  /**
   * Lands on disk once resolved, which is when Obsidian reports it. A hidden
   * file (a save's sibling, see `db-file.ts`) lands at once: only the file
   * Obsidian and Sync see waits.
   */
  writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.#lastWrittenBytes = data;
    return this.#land(path, () => this.#files.set(path, data));
  }

  /** Run `put` now, or once resolved if `path` is one Obsidian sees. */
  #land(path: string, put: () => void): Promise<void> {
    if (this.autoResolveWrites || isHidden(path)) {
      put();
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.#pendingWrites.push({
        resolve: () => {
          put();
          resolve();
        },
        reject,
      });
    });
  }

  /** A file's mtime changes whenever its bytes are replaced. */
  #mtimes = new WeakMap<ArrayBuffer, number>();
  #clock = 0;

  stat(
    path: string
  ): Promise<{
    type: 'file';
    ctime: number;
    mtime: number;
    size: number;
  } | null> {
    const data = this.#files.get(path);
    if (!data) return Promise.resolve(null);
    if (!this.#mtimes.has(data)) this.#mtimes.set(data, ++this.#clock);
    return Promise.resolve({
      type: 'file',
      ctime: 0,
      mtime: this.#mtimes.get(data)!,
      size: data.byteLength,
    });
  }

  copy(from: string, to: string): Promise<void> {
    const data = this.#files.get(from);
    if (!data) return Promise.reject(new Error(`ENOENT: ${from}`));
    this.#files.set(to, data.slice(0));
    return Promise.resolve();
  }

  getFullPath(path: string): string {
    return path;
  }

  /** Desktop's replacing rename (undocumented, see `atomicReplace`). */
  readonly fsPromises = {
    rename: (from: string, to: string): Promise<void> => {
      const data = this.#files.get(from);
      if (!data) return Promise.reject(new Error(`ENOENT: ${from}`));
      return this.#land(to, () => {
        this.#files.delete(from);
        this.#files.set(to, data);
      });
    },
  };

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

  /** The files directly in `folder`, as Obsidian lists them (full paths). */
  list(folder: string): Promise<{ files: string[]; folders: string[] }> {
    const files = this.paths().filter(
      (path) =>
        path.startsWith(`${folder}/`) &&
        !path.slice(folder.length + 1).includes('/')
    );
    return Promise.resolve({ files, folders: [] });
  }

  remove(path: string): Promise<void> {
    this.#files.delete(path);
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
