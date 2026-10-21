import type { TAbstractFile } from 'obsidian';
import { FakeRepository } from './FakeRepository';
import { DEFAULT_DB_PATH, FakeVault } from './FakeVault';

/** One install of the plugin: its own disk, localStorage and repository. */
export interface FakeDevice {
  name: string;
  vault: FakeVault;
  repo: FakeRepository;
  /** This device's clock; set `now` to move it. */
  clock: { now: number };
}

/**
 * A device whose writes land at once, started on `bytes` (another device's
 * file, as Sync first brings it down) or on a new database.
 */
export async function makeDevice(
  name: string,
  opts: { now: number; bytes?: ArrayBuffer }
): Promise<FakeDevice> {
  const vault = new FakeVault({ autoResolveWrites: true });
  if (opts.bytes) vault.setDiskBytes(opts.bytes.slice(0));
  const clock = { now: opts.now };
  const repo = await FakeRepository.createReal(vault, {
    deviceId: name,
    clock: () => clock.now,
  });
  return { name, vault, repo, clock };
}

/**
 * Obsidian Sync between fake devices, delivered by hand: each call copies one
 * device's database file onto another's disk and reports the change there,
 * as Obsidian's `modify` event does. Nothing is delivered on its own, so a
 * test decides every interleaving.
 */
export class FakeSync {
  constructor(readonly dbFilePath = DEFAULT_DB_PATH) {}

  /**
   * Bring `from`'s database file down onto `to`'s disk and let `to` answer
   * it, including any save that answer starts.
   * @returns whether `from` had a file to deliver
   */
  async deliver(from: FakeDevice, to: FakeDevice): Promise<boolean> {
    const bytes = from.vault.adapter.diskBytes(this.dbFilePath);
    if (!bytes?.byteLength) return false;
    to.vault.setDiskBytes(bytes.slice(0), this.dbFilePath);
    await this.#report(to);
    return true;
  }

  /**
   * Report `device`'s file back to it unchanged, as Obsidian does after each
   * of its own writes.
   * @returns whether `device` had a file to report
   */
  async echo(device: FakeDevice): Promise<boolean> {
    if (!device.vault.adapter.diskBytes(this.dbFilePath)?.byteLength) {
      return false;
    }
    await this.#report(device);
    return true;
  }

  async #report(device: FakeDevice) {
    await device.repo.settle();
    await device.repo.handleFileChange({
      path: this.dbFilePath,
    } as TAbstractFile);
    await device.repo.settle();
  }
}
