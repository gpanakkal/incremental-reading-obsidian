import { expect, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  closeElectron,
  launchElectron,
  openVault,
  userDataDir,
} from './helpers';

/**
 * Two Obsidian installs on one machine, standing in for two devices on Sync.
 *
 * To the plugin a device is an install: its id lives in localStorage (see
 * `src/lib/device-id.ts`), which Electron keeps in the user-data dir, so a
 * second launch with a dir of its own is a second device. Obsidian 1.14 lets
 * two such launches open one vault folder side by side: there is no vault
 * lock, and its single-instance lock is per user-data dir.
 *
 * Two ways to connect them:
 *
 * - **One folder** (`launchSecondDevice`): both open the same vault copy, so
 *   every write reaches the other at once, through its own file watcher, the
 *   same `modify`/`create` events a Sync download raises. Sync that is always
 *   on and always instant. Keep their saves apart (`waitForTakenOn` between
 *   steps): the plugin writes the database through one temporary file beside
 *   it, and two processes saving at the same moment share that file, which no
 *   two real devices ever do.
 * - **Two copies** (`launchDevice` on each, then `mirrorVault`): nothing
 *   reaches the other until a test copies it across, whole files at a time,
 *   in whatever order and as late as it likes. Sync paused on one side, or
 *   offline, or delivering one file before another.
 */
export type Device = { app: ElectronApplication; window: Page };

/** The user-data dir of the second install on a shared vault copy. */
export function secondDeviceDataDir(vaultPath: string) {
  // Inside the copy, as the first install's is: deleting the copy deletes
  // it, and the orphan sweep in ./global-cleanup.ts finds the process by a
  // `--user-data-dir` under `test-vaults`.
  return `${userDataDir(vaultPath)}-b`;
}

/**
 * Launch an install on `vaultPath` with the user-data dir `profile`, and open
 * the vault. Closes the app again if the vault never opens, so a failed boot
 * leaves no Electron behind for the caller to forget.
 */
export async function launchDevice(
  vaultPath: string,
  profile = userDataDir(vaultPath)
): Promise<Device> {
  const app = await launchElectron(vaultPath, profile);
  try {
    return { app, window: await openVault(app, vaultPath) };
  } catch (error) {
    // The boot failure is the one to report; a close that fails as well is
    // left to the orphan sweep
    await closeElectron(app).catch(() => undefined);
    throw error;
  }
}

/** A second device on the vault copy a first is already running on. */
export const launchSecondDevice = (vaultPath: string) =>
  launchDevice(vaultPath, secondDeviceDataDir(vaultPath));

/**
 * Close every device, all of them even when one fails to close, then throw
 * what failed. For `afterEach`: `closeElectron` already bounds each close and
 * kills what will not go. Skips `undefined`, so devices a failed `beforeEach`
 * never launched can be passed as they are.
 */
export async function closeDevices(devices: readonly (Device | undefined)[]) {
  const results = await Promise.allSettled(
    devices.flatMap((device) => (device ? [closeElectron(device.app)] : []))
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : []
  );
  if (failures.length > 0)
    throw new AggregateError(failures, 'A device failed to close');
}

/** What a device's repository says about its own writes and what it has seen. */
type WriteState = {
  device: string;
  seen: Record<string, number>;
  pending: number;
};

/**
 * The write stamp of the device on `page`: its id, the newest save of each
 * device its database holds, and how many saves are still under way.
 * Unofficial: `window.app`, `app.plugins.plugins`.
 */
function writeState(page: Page): Promise<WriteState | null> {
  return page.evaluate(() => {
    const { repo } = (
      window as unknown as {
        app: {
          plugins: {
            plugins: Record<
              string,
              {
                reviewManager?: {
                  repo: {
                    pendingSaveCount: number;
                    writeStamp?(): {
                      device: string;
                      seen: Record<string, number>;
                    } | null;
                  };
                };
              }
            >;
          };
        };
      }
    ).app.plugins.plugins['incremental-reading']?.reviewManager ?? {
      repo: null,
    };
    const stamp = repo?.writeStamp?.();
    if (!repo || !stamp) return null;
    return { ...stamp, pending: repo.pendingSaveCount };
  });
}

/**
 * Wait until `reader` holds every save `writer` has made: the writer has
 * nothing left to save, and the reader's database has seen the writer's
 * newest save. The barrier between one device's step and the other's.
 *
 * Read from the write stamps rather than from any row: it holds for every
 * kind of write, a merge included, and fails only when the reader truly
 * never took the file on.
 *
 * It knows only of saves already begun. A command can return before it
 * writes, so wait for the step's own outcome (its row, its modal) first. On
 * two vault copies, call it after the `mirrorVault` that delivers the
 * database.
 */
export async function waitForTakenOn(writer: Page, reader: Page) {
  let target: { device: string; generation: number } | null = null;
  await expect
    .poll(
      async () => {
        const state = await writeState(writer);
        if (!state || state.pending > 0) return false;
        target = {
          device: state.device,
          generation: state.seen[state.device] ?? 0,
        };
        return true;
      },
      {
        message:
          'writer lagged: its database never opened, or a save never finished',
      }
    )
    .toBe(true);
  const { device, generation } = target!;
  await expect
    .poll(async () => (await writeState(reader))?.seen[device] ?? 0, {
      message: `reader lagged: never took on save ${generation} of ${device}`,
    })
    .toBeGreaterThanOrEqual(generation);
}

/**
 * Any path with a dot-prefixed segment: Obsidian indexes none of them, so
 * Sync carries none (its optional settings sync of `.obsidian` aside, which
 * a test can copy itself). That takes in the install's own folders
 * (`.obsidian`, the user-data dirs) and the plugin's device-local siblings of
 * the database (`.tmp`, `.prev`, `.corrupt-*`): recovery trusts `.prev`
 * only because no other device's copy ever lands there.
 */
const NEVER_MIRRORED = /(^|\/)\./;

/**
 * Copy what `from` holds that `to` lacks or holds differently, as a Sync
 * download would: whole files, each landing at once (written beside the
 * target and renamed into place) with the source's modification time.
 * Two vault copies only; on a shared folder there is nothing to copy.
 *
 * `paths` limits it to those vault paths (files or folders), for a delivery
 * of some files before others. Without it, every file of the vault is
 * compared. Never copies a path with a dot-prefixed segment, as Sync never
 * does. Never deletes: Sync's deletions are a separate step a test can take
 * with `fs.rm`.
 *
 * @returns the vault paths copied, in the order they landed
 */
export async function mirrorVault(
  from: string,
  to: string,
  paths: readonly string[] = ['']
): Promise<string[]> {
  const copied: string[] = [];
  const visit = async (relative: string) => {
    if (relative && NEVER_MIRRORED.test(relative)) return;
    const source = path.join(from, relative);
    const stat = await fs.stat(source).catch(() => null);
    if (!stat) return;
    if (stat.isDirectory()) {
      const entries = await fs.readdir(source);
      for (const entry of entries.sort())
        await visit(relative ? `${relative}/${entry}` : entry);
      return;
    }
    const target = path.join(to, relative);
    const data = await fs.readFile(source);
    const current = await fs.readFile(target).catch(() => null);
    if (current?.equals(data)) return;
    await fs.mkdir(path.dirname(target), { recursive: true });
    // A unique name, out of the way of the plugin's own `.tmp` beside the
    // database, and dot-prefixed so Obsidian indexes no half-copied note
    const staging = path.join(
      path.dirname(target),
      `.mirror-${crypto.randomUUID().slice(0, 8)}`
    );
    await fs.writeFile(staging, data);
    await fs.utimes(staging, stat.atime, stat.mtime);
    await fs.rename(staging, target);
    copied.push(relative);
  };
  for (const start of paths) await visit(start.replace(/\\/g, '/'));
  return copied;
}
