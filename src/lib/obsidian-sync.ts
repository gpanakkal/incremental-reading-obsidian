/**
 * What this plugin reads of Obsidian Sync, the core plugin that copies the
 * vault between devices. Sync has no public API: everything here is
 * undocumented internals, read from Obsidian's own bundle (`app.js` in
 * obsidian.asar; 1.13.7 and 1.14.4 agree on all of it).
 * obsidian-typings types the instance as `{ app, plugin }` only, so it is read
 * through {@link SyncInstance} and checked at runtime, and anything that does
 * not match reads as `'unavailable'`: the plugin then behaves as it does
 * without Sync.
 */

import type { App } from 'obsidian';
import type { NoticeFactory, NoticeTarget } from './ir-id-warning-notice';
import type { NotifyOptions } from './notices';

/**
 * The parts of Sync's plugin instance read here (undocumented).
 *
 * - `getStatus()`: `'uninitialized'` until Sync has read its saved state
 *   (which is when `pause`, `filter` and the settings below are loaded),
 *   `'disconnected'` when the vault is not set up for Sync, then `'error'`,
 *   `'paused'`, `'syncing'` or `'synced'`. `'synced'` alone means little: it
 *   shows before the server has said what changed, and while offline.
 * - `ready`: set once the server has sent every change since the last
 *   session, and cleared before each reconnect.
 * - `newServerFiles`: remote changes not yet applied. An entry leaves only
 *   after its file has been written to disk.
 * - `filter.allowSyncFile(path, isFolder)`: selective sync. Nothing under
 *   one of the "Excluded folders" (`filter.ignoreFolders`, vault paths; a
 *   file is under one when its path starts with the folder plus `/`) syncs.
 *   Anything else not a note, image, audio, video or PDF syncs only with
 *   "Sync all other types" (`filter.allowTypes` holding `'unsupported'`),
 *   which is off by default.
 * - `on`/`offref`: Obsidian's `Events`; Sync raises `'status-change'`.
 */
interface SyncInstance {
  getStatus(): unknown;
  pause: boolean;
  ready: boolean;
  newServerFiles: unknown[];
  filter: {
    allowSyncFile(path: string, isFolder: boolean): unknown;
    allowTypes?: unknown;
    ignoreFolders?: unknown;
  };
  on(name: string, callback: () => void): unknown;
  offref(ref: unknown): void;
}

/**
 * Where Sync stands on one file.
 *
 * - `no-sync`: Sync is off.
 * - `unavailable`: Sync is on, but not in a shape this plugin knows.
 * - `starting`: Sync has not read its saved state yet.
 * - `disconnected`: the vault is not set up for Sync.
 * - `excluded`: selective sync leaves the file out.
 * - `paused`: the user paused Sync.
 * - `pending`: the server has not said what changed yet, or has and a newer
 *   copy of the file is still to be downloaded.
 * - `settled`: nothing newer of the file is on its way.
 */
export type SyncState =
  | 'no-sync'
  | 'unavailable'
  | 'starting'
  | 'disconnected'
  | 'excluded'
  | 'paused'
  | 'pending'
  | 'settled';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function isSyncInstance(value: unknown): value is SyncInstance {
  return (
    isObject(value) &&
    typeof value.getStatus === 'function' &&
    typeof value.on === 'function' &&
    typeof value.offref === 'function' &&
    typeof value.pause === 'boolean' &&
    typeof value.ready === 'boolean' &&
    Array.isArray(value.newServerFiles) &&
    isObject(value.filter) &&
    typeof value.filter.allowSyncFile === 'function'
  );
}

/**
 * Where Sync stands on the file at vault path `path`.
 * @param sync Sync's plugin instance, or nullish when Sync is off
 */
export function readSyncState(sync: unknown, path: string): SyncState {
  if (sync === null || sync === undefined) return 'no-sync';
  if (!isSyncInstance(sync)) return 'unavailable';
  try {
    const status = sync.getStatus();
    const known = [
      'uninitialized',
      'disconnected',
      'error',
      'paused',
      'syncing',
      'synced',
    ];
    if (!known.includes(status as string)) return 'unavailable';
    // Until then the filter and `pause` hold their defaults, not the user's
    if (status === 'uninitialized') return 'starting';
    if (status === 'disconnected') return 'disconnected';
    const allowed = sync.filter.allowSyncFile(path, false);
    if (typeof allowed !== 'boolean') return 'unavailable';
    if (!allowed) return 'excluded';
    if (sync.pause) return 'paused';
    if (!sync.ready) return 'pending';
    const queued = sync.newServerFiles.some(
      (entry) => isObject(entry) && entry.path === path && !entry.folder
    );
    return queued ? 'pending' : 'settled';
  } catch {
    return 'unavailable';
  }
}

/**
 * How a {@link waitForSyncedFile} ended: the state that ended it, or
 *
 * - `timeout`: it ran out of time first;
 * - `offline`: the device went offline while the file was still to come;
 * - `cancelled`: its signal was aborted.
 */
export type SyncWaitOutcome =
  | Exclude<SyncState, 'starting' | 'pending'>
  | 'timeout'
  | 'offline'
  | 'cancelled';

/**
 * Wait until Sync has nothing newer of the file at `path` on its way, or
 * there is no point waiting: Sync is off, unknown, not set up, paused, or
 * leaves the file out.
 *
 * Re-checks on each `'status-change'` Sync raises and every `pollMs`, since
 * `ready` turns true without an event of its own. Sync is looked up afresh
 * each time, so turning it off or on meanwhile counts.
 * @param params.getSync Sync's plugin instance as it is now, or nullish
 * @param params.isOffline whether the device is offline; Sync cannot deliver
 * anything then, so a file still to come stops the wait
 */
export function waitForSyncedFile(params: {
  getSync: () => unknown;
  path: string;
  timeoutMs: number;
  pollMs: number;
  isOffline: () => boolean;
  signal?: AbortSignal;
}): Promise<SyncWaitOutcome> {
  const { path, isOffline } = params;
  return watchSync({
    ...params,
    decide: (sync) => {
      const state = readSyncState(sync, path);
      if (state === 'pending' && isOffline()) return 'offline';
      if (state === 'pending' || state === 'starting') return undefined;
      return state;
    },
  });
}

/**
 * Ask `decide` about Sync until it answers, it times out, or `signal` aborts.
 * `decide` is asked at once, on each `'status-change'`, and every `pollMs`;
 * `undefined` means ask again later.
 */
function watchSync<T>(params: {
  getSync: () => unknown;
  decide: (sync: unknown) => T | undefined;
  timeoutMs: number;
  pollMs: number;
  signal?: AbortSignal;
}): Promise<T | 'timeout' | 'cancelled'> {
  const { getSync, decide, timeoutMs, pollMs, signal } = params;
  return new Promise((resolve) => {
    let subscribed: { sync: SyncInstance; ref: unknown } | null = null;
    let poll: number | undefined;
    let timeout: number | undefined;
    let done = false;

    const finish = (outcome: T | 'timeout' | 'cancelled') => {
      if (done) return;
      done = true;
      window.clearInterval(poll);
      window.clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
      unsubscribe();
      resolve(outcome);
    };
    const cancel = () => finish('cancelled');
    const unsubscribe = () => {
      if (!subscribed) return;
      try {
        subscribed.sync.offref(subscribed.ref);
      } catch (error) {
        console.debug('Incremental Reading - Sync offref failed', error);
      }
      subscribed = null;
    };
    /** Listen to the instance Sync is now, and to no other. */
    const follow = (sync: SyncInstance) => {
      if (subscribed?.sync === sync) return;
      unsubscribe();
      try {
        subscribed = { sync, ref: sync.on('status-change', check) };
      } catch (error) {
        console.debug('Incremental Reading - Sync on failed', error);
      }
    };
    function check() {
      if (done) return;
      const sync = getSync();
      const verdict = decide(sync);
      if (verdict !== undefined) return finish(verdict);
      if (isSyncInstance(sync)) follow(sync);
    }

    if (signal?.aborted) return finish('cancelled');
    signal?.addEventListener('abort', cancel);
    check();
    if (done) return;
    poll = window.setInterval(check, pollMs);
    timeout = window.setTimeout(() => finish('timeout'), timeoutMs);
  });
}

/** How long a startup waits on Sync before going ahead without it. */
export const SYNC_WAIT_TIMEOUT_MS = 60_000;
/** How long a startup waits on Sync before saying it is waiting. */
export const SYNC_WAIT_NOTICE_DELAY_MS = 1_500;
/**
 * How often a wait re-checks Sync between its status changes. `ready` turns
 * true without one.
 */
export const SYNC_POLL_MS = 500;

/**
 * What a startup is about to do that Sync could make wrong: migrate the
 * database file this device has, or start a new one because it has none.
 */
export type SyncHoldReason = 'migrate' | 'create';

export const SYNC_HOLD_MESSAGES = {
  waiting:
    'Incremental reading: waiting for Sync to deliver the review database…',
  paused: {
    migrate:
      'Incremental reading: Sync is paused; migrating the local database. ' +
      'If another device has newer data, resume Sync first.',
    create:
      'Incremental reading: Sync is paused; starting a new database. ' +
      'If another device has data, resume Sync first.',
  },
  timeout: {
    migrate:
      "Incremental reading: Sync didn't finish delivering the review " +
      "database, so this device's copy was migrated. If another device has " +
      'newer data, its copy may conflict with this one.',
    create:
      "Incremental reading: Sync didn't finish delivering the review " +
      'database, so a new one was started. If another device has data, its ' +
      'copy may conflict with this one.',
  },
} as const;

/**
 * Hold a startup that is about to write the database file at `path` until
 * Sync has delivered any newer copy of it.
 *
 * Sync keeps whichever copy of a binary file changed locally, so a device
 * that migrates its stale copy before the newer one arrives would overwrite
 * the newer one everywhere. Waiting lets the newer copy land first.
 *
 * Says so with a notice once the wait has lasted
 * {@link SYNC_WAIT_NOTICE_DELAY_MS}, and warns when it goes ahead without
 * Sync: paused, offline, or out of time.
 * @param params.timeoutMs defaults to {@link SYNC_WAIT_TIMEOUT_MS}
 * @param params.isOffline defaults to `navigator.onLine` reading false
 * @param params.notify a passing notice, or a lasting one with `persist`
 * @returns `'cancelled'` when `signal` aborted, so as not to go ahead;
 * otherwise `'waited'` when there was anything to wait for, as the file may
 * have changed meanwhile, or `'at-once'` when there was not
 */
export async function holdForSync(params: {
  getSync: () => unknown;
  path: string;
  reason: SyncHoldReason;
  createNotice: NoticeFactory;
  notify: (message: string, options?: NotifyOptions) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  isOffline?: () => boolean;
}): Promise<'waited' | 'at-once' | 'cancelled'> {
  const { reason, createNotice, notify } = params;
  const initial = readSyncState(params.getSync(), params.path);
  const waits = initial === 'pending' || initial === 'starting';
  let waitingNotice = null as NoticeTarget | null;
  const noticeTimer = waits
    ? window.setTimeout(() => {
        waitingNotice = createNotice(SYNC_HOLD_MESSAGES.waiting);
      }, SYNC_WAIT_NOTICE_DELAY_MS)
    : undefined;
  let outcome: SyncWaitOutcome;
  try {
    outcome = await waitForSyncedFile({
      getSync: params.getSync,
      path: params.path,
      signal: params.signal,
      timeoutMs: params.timeoutMs ?? SYNC_WAIT_TIMEOUT_MS,
      pollMs: SYNC_POLL_MS,
      isOffline: params.isOffline ?? (() => navigator.onLine === false),
    });
  } finally {
    window.clearTimeout(noticeTimer);
    waitingNotice?.hide();
  }
  switch (outcome) {
    case 'cancelled':
      return 'cancelled';
    case 'paused':
      notify(SYNC_HOLD_MESSAGES.paused[reason]);
      break;
    case 'timeout':
    case 'offline':
      console.warn(
        `Incremental Reading - Sync had not delivered ${params.path} (${outcome}); going ahead`
      );
      notify(SYNC_HOLD_MESSAGES.timeout[reason], { persist: true });
      break;
  }
  return waits ? 'waited' : 'at-once';
}

/**
 * A Sync setting that leaves a file out of selective sync.
 *
 * - `folder`: the file is under `folder`, one of Sync's "Excluded folders".
 * - `type`: the file is of no type Sync syncs, and "Sync all other types" is
 *   off, as it is by default.
 */
export type SyncExclusion =
  | { cause: 'folder'; folder: string }
  | { cause: 'type' };

/**
 * The first of Sync's "Excluded folders" that `path`, a file, is under.
 * Sync's own rule (`_allowSyncFile`): the path starts with the folder plus
 * `/`, compared as written.
 */
function excludingFolder(
  ignoreFolders: unknown,
  path: string
): string | undefined {
  if (!Array.isArray(ignoreFolders)) return undefined;
  return (ignoreFolders as unknown[]).find(
    (folder): folder is string =>
      typeof folder === 'string' && path.startsWith(`${folder}/`)
  );
}

/**
 * Why Sync, set up for this vault, leaves the file at `path` out, as far as
 * its settings say: an excluded folder over it, "Sync all other types" off,
 * or both. Empty when Sync would sync the file, when it is off, not set up,
 * or in an unknown shape, and when it leaves the file out for a reason this
 * plugin does not know. Waits for Sync to read its settings, which until then
 * hold the defaults; answers empty if it never does.
 */
export async function findSyncExclusions(params: {
  getSync: () => unknown;
  path: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<SyncExclusion[]> {
  const verdict = await watchSync({
    getSync: params.getSync,
    signal: params.signal,
    timeoutMs: params.timeoutMs ?? SYNC_WAIT_TIMEOUT_MS,
    pollMs: SYNC_POLL_MS,
    decide: (sync): SyncExclusion[] | undefined => {
      const state = readSyncState(sync, params.path);
      if (state === 'starting') return undefined;
      if (state !== 'excluded') return [];
      const { filter } = sync as SyncInstance;
      const exclusions: SyncExclusion[] = [];
      // Each setting is read on its own, so one that throws on reading
      // leaves the other to be named
      try {
        const folder = excludingFolder(filter.ignoreFolders, params.path);
        if (folder !== undefined) exclusions.push({ cause: 'folder', folder });
      } catch {
        // Unreadable: no folder is named
      }
      try {
        const types = filter.allowTypes;
        if (types instanceof Set && !types.has('unsupported')) {
          exclusions.push({ cause: 'type' });
        }
      } catch {
        // Unreadable: the type setting is not named
      }
      return exclusions;
    },
  });
  return Array.isArray(verdict) ? verdict : [];
}

/**
 * A warning that `exclusion` keeps the database out of Sync, naming the
 * setting to change and where to find it.
 */
export function syncExclusionMessage(exclusion: SyncExclusion): string {
  const because =
    'Incremental reading: Sync leaves the review database out because ';
  switch (exclusion.cause) {
    case 'folder':
      return (
        because +
        `"${exclusion.folder}" is one of its excluded folders. Remove it ` +
        'under Settings → Sync → Excluded folders before using the plugin.'
      );
    case 'type':
      return (
        because +
        '"Sync all other types" is off. Turn it on under Settings → Sync ' +
        'before using the plugin.'
      );
  }
}

/**
 * Sync's plugin instance, or undefined when Sync is off. Through
 * `app.internalPlugins` (undocumented), which hands back the instance only
 * while the plugin is enabled.
 */
export function getSyncPlugin(app: App): unknown {
  try {
    return app.internalPlugins.getEnabledPluginById('sync') ?? undefined;
  } catch {
    return undefined;
  }
}
