import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Lifecycle of the vault copies e2e tests run against, kept free of Playwright
 * so the runner's global setup can use it too.
 *
 * Each copy gets an owner marker beside it (`<copy>.owner.json`) naming the
 * worker process that made it. The marker is written before the copy exists,
 * so a sweep running in another process never sees a copy without its owner.
 * A copy is deleted when its test ends (the fixture in ./fixtures.ts), and
 * anything that survives that — a worker killed mid-test, a copy still locked
 * by an Electron that took too long to exit — is swept by the global setup and
 * teardown once its owner is gone.
 */
export const testVaultsDir = path.resolve('./e2e-tests/test-vaults');

type Env = Record<string, string | undefined>;

/**
 * Copies are deleted unless the run asks to keep them with `E2E_CLEANUP=0`.
 * On by default so that a bare `playwright test` cleans up after itself too.
 */
export function cleanupEnabled(env: Env = process.env) {
  return env['E2E_CLEANUP'] !== '0';
}

/**
 * What Windows reports while a process that is exiting, or that was just
 * killed, still holds a handle somewhere in the tree.
 */
const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES']);

const errorCode = (error: unknown) => (error as { code?: unknown }).code;

interface RemoveOptions {
  attempts?: number;
  /** Wait before the nth retry is n times this. */
  delayMs?: number;
  rm?: (target: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

const rmTree = (target: string) =>
  fs.rm(target, { recursive: true, force: true });

const sleepFor = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Delete a directory tree, retrying while something still holds it open.
 *
 * Never throws: a copy that cannot be deleted must not fail the test that used
 * it. Returns whether the tree is gone, so a caller can leave the owner marker
 * in place for a later sweep.
 *
 * The defaults wait about 9s in all, well past the moment an Electron that
 * `closeElectron` just killed lets go of its files. Node's own `maxRetries`
 * gives up after a fraction of a second.
 */
export async function removeWithRetry(
  target: string,
  {
    attempts = 10,
    delayMs = 200,
    rm = rmTree,
    sleep = sleepFor,
  }: RemoveOptions = {}
) {
  for (let attempt = 1; ; attempt++) {
    try {
      await rm(target);
      return true;
    } catch (error) {
      const code = errorCode(error);
      const retryable = typeof code === 'string' && RETRYABLE_CODES.has(code);
      if (!retryable || attempt >= attempts) return false;
      await sleep(delayMs * attempt);
    }
  }
}

export interface OwnerRecord {
  /** The process that made the copy and deletes it when its test ends. */
  pid: number;
  /** Made while `E2E_CLEANUP=0`: never swept. */
  keep: boolean;
}

const OWNER_SUFFIX = '.owner.json';

export const ownerFile = (vaultPath: string) => vaultPath + OWNER_SUFFIX;

interface ClaimIo {
  writeFile?: (file: string, data: string) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
}

/**
 * Write the owner marker for a copy. It is written whole under a temporary
 * name beside it, then renamed into place, so a sweep in another run never
 * reads half a marker, takes the copy for ownerless, and deletes it.
 */
export async function claimCopy(
  vaultPath: string,
  record: OwnerRecord,
  {
    writeFile = (file, data) => fs.writeFile(file, data),
    rename = (from, to) => fs.rename(from, to),
  }: ClaimIo = {}
) {
  const marker = ownerFile(vaultPath);
  const temporary = `${marker}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, JSON.stringify(record));
  await rename(temporary, marker);
}

interface CreateOptions {
  /** Made while `E2E_CLEANUP=0`: never swept. */
  keep: boolean;
  pid?: number;
  tracker?: CopyTracker;
}

/**
 * Make a copy at `vaultPath` with `copy`, owned and tracked from before any of
 * it exists: a sweep in another process never finds it without an owner, and
 * a copy that fails partway is still deleted after its test.
 */
export async function createOwnedCopy(
  vaultPath: string,
  copy: (target: string) => Promise<void>,
  { keep, pid = process.pid, tracker = createdCopies }: CreateOptions
) {
  await fs.mkdir(path.dirname(vaultPath), { recursive: true });
  await claimCopy(vaultPath, { pid, keep });
  tracker.track(vaultPath);
  await copy(vaultPath);
}

/** The copy's owner, or null when the marker is missing or not one of ours. */
export async function readOwner(vaultPath: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(ownerFile(vaultPath), 'utf8'));
  } catch {
    return null;
  }
  const { pid, keep } = (parsed ?? {}) as Partial<OwnerRecord>;
  return typeof pid === 'number' && typeof keep === 'boolean'
    ? { pid, keep }
    : null;
}

/**
 * Whether a process is still running. A recycled PID reads as alive, which
 * only ever keeps a stale copy until a later sweep, never deletes a live one.
 */
export function isProcessAlive(
  pid: number,
  kill: (pid: number, signal: number) => unknown = (p, s) => process.kill(p, s)
) {
  try {
    // Signal 0 tests for existence without delivering anything.
    kill(pid, 0);
    return true;
  } catch (error) {
    // Alive, just not ours to signal.
    return errorCode(error) === 'EPERM';
  }
}

/**
 * The names `createVaultCopy` gives top-level copies: `<prefix>-<8 hex>`.
 * Anything else in the directory (the codegen vault's folder, say) belongs to
 * someone else and is never swept.
 */
const COPY_NAME = /^(?:[a-z0-9-]+-)?[0-9a-f]{8}$/i;

interface SweepDeps {
  isAlive?: (pid: number) => boolean;
  remove?: (target: string) => Promise<boolean>;
}

/**
 * Delete every copy in `dir` whose owner is gone, and owner markers left
 * without a copy.
 *
 * A copy without a readable marker predates markers, or lost its marker to a
 * half-finished delete; either way nobody is coming back for it. A marker
 * whose owner is alive but whose copy is missing is a copy still being made.
 *
 * Returns the names of the copies it deleted.
 */
export async function sweepStaleCopies(
  dir: string,
  { isAlive = isProcessAlive, remove = removeWithRetry }: SweepDeps = {}
) {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const present = new Set(names);
  const isStale = async (vaultPath: string) => {
    const owner = await readOwner(vaultPath);
    return owner === null || (!owner.keep && !isAlive(owner.pid));
  };

  const removed: string[] = [];
  for (const name of names) {
    const vaultPath = path.join(dir, name);
    if (name.endsWith(OWNER_SUFFIX)) {
      const copy = vaultPath.slice(0, -OWNER_SUFFIX.length);
      if (!present.has(path.basename(copy)) && (await isStale(copy)))
        await fs.rm(vaultPath, { force: true });
      continue;
    }
    if (!COPY_NAME.test(name) || !(await isStale(vaultPath))) continue;
    // Marker last, so a copy that stays locked keeps it for the next sweep.
    if (!(await remove(vaultPath))) continue;
    await fs.rm(ownerFile(vaultPath), { force: true });
    removed.push(name);
  }
  return removed;
}

interface DisposeOptions {
  enabled?: boolean;
  remove?: (target: string) => Promise<boolean>;
}

/**
 * Delete one copy at the end of the test that made it, unless the run keeps
 * copies. Returns whether it was deleted.
 */
export async function disposeCopy(
  vaultPath: string,
  { enabled = cleanupEnabled(), remove = removeWithRetry }: DisposeOptions = {}
) {
  if (!enabled || !(await remove(vaultPath))) return false;
  await fs.rm(ownerFile(vaultPath), { force: true });
  return true;
}

/** The copies a worker made, in order, so each test can delete its own. */
export class CopyTracker {
  private paths: string[] = [];

  track(vaultPath: string) {
    this.paths.push(vaultPath);
  }

  /** A position to later take everything tracked after it. */
  mark() {
    return this.paths.length;
  }

  takeSince(mark: number) {
    return this.paths.splice(mark);
  }
}

/** Copies made by this process; see ./fixtures.ts. */
export const createdCopies = new CopyTracker();
