export interface FakeFile {
  path: string;
  deleted?: boolean;
}

class FakeAdapter {
  #pendingWrites: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  #diskBytes: ArrayBuffer = new ArrayBuffer(0);
  #lastWrittenBytes: ArrayBuffer | null = null;

  writeBinary(_path: string, data: ArrayBuffer): Promise<void> {
    this.#lastWrittenBytes = data;
    return new Promise((resolve, reject) => {
      this.#pendingWrites.push({ resolve, reject });
    });
  }

  readBinary(_path: string): Promise<ArrayBuffer> {
    return Promise.resolve(this.#diskBytes);
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

  setDiskBytes(data: ArrayBuffer): void {
    this.#diskBytes = data;
  }
}

export class FakeVault {
  adapter = new FakeAdapter();

  getFolderByPath(_path: string) {
    return { path: _path };
  }

  getAbstractFileByPath(_path: string) {
    return null;
  }

  createFolder(_path: string): Promise<void> {
    return Promise.resolve();
  }

  get app() {
    return { vault: this };
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

  setDiskBytes(data: ArrayBuffer): void {
    this.adapter.setDiskBytes(data);
  }

  get lastWrittenBytes(): ArrayBuffer | null {
    return this.adapter.lastWrittenBytes;
  }
}
