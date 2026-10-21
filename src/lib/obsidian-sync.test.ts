// @vitest-environment jsdom
import { DATA_DIRECTORY, DATABASE_FILE_PATH } from '#/lib/constants';
import fc from 'fast-check';
import type { App } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findSyncExclusions,
  getSyncPlugin,
  holdForSync,
  readSyncState,
  SYNC_HOLD_MESSAGES,
  SYNC_POLL_MS,
  SYNC_WAIT_NOTICE_DELAY_MS,
  SYNC_WAIT_TIMEOUT_MS,
  syncExclusionMessage,
  waitForSyncedFile,
  type SyncHoldReason,
} from './obsidian-sync';

// #region HELPERS

/** Every value Obsidian 1.13/1.14's `getStatus()` returns. */
const STATUSES = [
  'uninitialized',
  'disconnected',
  'error',
  'paused',
  'syncing',
  'synced',
] as const;
type Status = (typeof STATUSES)[number];

interface QueueEntry {
  path: unknown;
  folder?: unknown;
}

interface FakeSyncFields {
  status: Status;
  pause: boolean;
  ready: boolean;
  /** What `filter.allowSyncFile` answers for the database file. */
  allowed: boolean;
  /** Entries as Sync queues them, plus anything a change could put there. */
  newServerFiles: unknown[];
  /** `filter.allowTypes`, the file types Sync syncs. */
  allowTypes: string[];
}

/**
 * A stand-in for Obsidian Sync's plugin instance, shaped like the real one
 * (undocumented): fields, `getStatus()`, `filter.allowSyncFile`, and the
 * `Events` methods it inherits. `trigger` raises an event as Sync does.
 */
function makeSync(fields: Partial<FakeSyncFields> = {}) {
  const listeners = new Map<object, () => void>();
  const { allowTypes = ['image', 'audio', 'pdf', 'video'], ...rest } = fields;
  const sync = {
    status: 'synced' as Status,
    pause: false,
    ready: true,
    allowed: true,
    newServerFiles: [] as unknown[],
    ...rest,
    getStatus() {
      return sync.status;
    },
    filter: {
      allowSyncFile: vi.fn((_path: string, _isFolder: boolean) => sync.allowed),
      allowTypes: new Set(allowTypes),
      // Sync's "Excluded folders", as vault paths
      ignoreFolders: [] as unknown,
    },
    on: vi.fn((name: string, callback: () => void) => {
      const ref = { name };
      listeners.set(ref, callback);
      return ref;
    }),
    offref: vi.fn((ref: object) => {
      listeners.delete(ref);
    }),
    trigger() {
      for (const callback of [...listeners.values()]) callback();
    },
    listenerCount: () => listeners.size,
  };
  return sync;
}

const queueEntryArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.record(
    {
      path: fc.oneof(
        fc.constant(DATABASE_FILE_PATH),
        fc.string(),
        fc.constant(`${DATABASE_FILE_PATH}/`),
        fc.anything()
      ),
      folder: fc.oneof(fc.boolean(), fc.constant(undefined), fc.anything()),
    },
    { requiredKeys: ['path'] }
  ),
  fc.anything()
);

const fieldsArb: fc.Arbitrary<FakeSyncFields> = fc.record({
  status: fc.constantFrom(...STATUSES),
  pause: fc.boolean(),
  ready: fc.boolean(),
  allowed: fc.boolean(),
  newServerFiles: fc.array(queueEntryArb, { maxLength: 6 }),
  allowTypes: fc.uniqueArray(
    fc.oneof(
      fc.constantFrom('image', 'audio', 'pdf', 'video', 'unsupported'),
      fc.string()
    )
  ),
});

/** Members of the instance the plugin relies on, each of one type. */
const BREAKABLE_MEMBERS = [
  'getStatus',
  'on',
  'offref',
  'pause',
  'ready',
  'newServerFiles',
  'filter',
  'filter.allowSyncFile',
] as const;
type BreakableMember = (typeof BREAKABLE_MEMBERS)[number];

/** Where `member` lives on `sync`, and what type it has to be. */
function locate(sync: ReturnType<typeof makeSync>, member: BreakableMember) {
  const types: Record<BreakableMember, (value: unknown) => boolean> = {
    getStatus: (v) => typeof v === 'function',
    on: (v) => typeof v === 'function',
    offref: (v) => typeof v === 'function',
    pause: (v) => typeof v === 'boolean',
    ready: (v) => typeof v === 'boolean',
    newServerFiles: Array.isArray,
    filter: (v) =>
      typeof v === 'object' &&
      v !== null &&
      typeof (v as { allowSyncFile?: unknown }).allowSyncFile === 'function',
    'filter.allowSyncFile': (v) => typeof v === 'function',
  };
  const nested = member === 'filter.allowSyncFile';
  return {
    owner: (nested ? sync.filter : sync) as unknown as Record<string, unknown>,
    key: nested ? 'allowSyncFile' : member,
    isRightType: types[member],
  };
}

/** Whether `entries` holds a pending download of the database file. */
const queuesDatabase = (entries: readonly unknown[]) =>
  entries.some(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as QueueEntry).path === DATABASE_FILE_PATH &&
      !(entry as QueueEntry).folder
  );

/** A notice factory whose notices record whether they were hidden. */
function makeNotices() {
  const shown: { message: string; hide: ReturnType<typeof vi.fn> }[] = [];
  const createNotice = vi.fn((message: string) => {
    const notice = {
      message,
      hide: vi.fn(),
      containerEl: {} as HTMLElement,
      setMessage: vi.fn(),
    };
    shown.push(notice);
    return notice;
  });
  return { shown, createNotice };
}

/** A vault path segment: anything but a separator. */
const segmentArb = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((segment) => !segment.includes('/'));

/** A data folder of one or more segments, and a database file in it. */
const dataPathArb = fc
  .array(segmentArb, { minLength: 1, maxLength: 4 })
  .chain((segments) =>
    fc.record({
      segments: fc.constant(segments),
      path: segmentArb.map((file) => `${segments.join('/')}/${file}.sqlite`),
    })
  );

/**
 * Sync's "Excluded folders" for a data folder: the folder itself, folders
 * over it, and look-alikes that leave it in (a partial name, another case,
 * a trailing slash, the file itself) among unrelated ones.
 */
const ignoreFoldersArb = (segments: string[], path: string) => {
  const folder = segments.join('/');
  const ancestors = segments.map((_, i) => segments.slice(0, i + 1).join('/'));
  return fc.array(
    fc.oneof(
      fc.constantFrom(...ancestors),
      fc.constant(`${folder}/`),
      fc.constant(path),
      fc
        .integer({ min: 0, max: folder.length - 1 })
        .map((end) => folder.slice(0, end)),
      fc.constant(folder.toUpperCase()),
      fc.constant(folder.toLowerCase()),
      fc.string()
    ),
    { maxLength: 5 }
  );
};

/**
 * Sync's own answer for a file at `path` that is neither a note, media nor
 * under the config folder (`_allowSyncFile` in Obsidian's bundle).
 */
const syncAllows = (
  path: string,
  ignoreFolders: string[],
  allowTypes: string[]
) =>
  !ignoreFolders.some((folder) => path.startsWith(`${folder}/`)) &&
  allowTypes.includes('unsupported');

// #endregion

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readSyncState', () => {
  it('reads no Sync as no-sync', () => {
    expect(readSyncState(null, DATABASE_FILE_PATH)).toBe('no-sync');
    expect(readSyncState(undefined, DATABASE_FILE_PATH)).toBe('no-sync');
  });

  it('property: classifies a well-formed instance by the decision table', () => {
    fc.assert(
      fc.property(fieldsArb, (fields) => {
        const expected =
          fields.status === 'uninitialized'
            ? 'starting'
            : fields.status === 'disconnected'
              ? 'disconnected'
              : !fields.allowed
                ? 'excluded'
                : fields.pause
                  ? 'paused'
                  : fields.ready && !queuesDatabase(fields.newServerFiles)
                    ? 'settled'
                    : 'pending';

        expect(readSyncState(makeSync(fields), DATABASE_FILE_PATH)).toBe(
          expected
        );
      })
    );
  });

  it('property: reads any value that is not an object as unavailable', () => {
    fc.assert(
      fc.property(
        fc
          .anything()
          .filter(
            (value) =>
              value !== null &&
              value !== undefined &&
              typeof value !== 'object' &&
              typeof value !== 'function'
          ),
        (value) => {
          expect(readSyncState(value, DATABASE_FILE_PATH)).toBe('unavailable');
        }
      )
    );
  });

  it('property: reads an instance missing a member, or holding one of the wrong type, as unavailable', () => {
    fc.assert(
      fc.property(
        fieldsArb,
        fc.constantFrom(...BREAKABLE_MEMBERS),
        fc.option(fc.anything(), { nil: undefined }),
        fc.boolean(),
        (fields, member, replacement, remove) => {
          const sync = makeSync(fields);
          const { owner, key, isRightType } = locate(sync, member);
          fc.pre(remove || !isRightType(replacement));
          if (remove) delete owner[key];
          else owner[key] = replacement;

          expect(readSyncState(sync, DATABASE_FILE_PATH)).toBe('unavailable');
        }
      )
    );
  });

  it('property: reads a status it does not know as unavailable', () => {
    fc.assert(
      fc.property(
        fieldsArb,
        fc.anything().filter((status) => !STATUSES.includes(status as Status)),
        (fields, status) => {
          const sync = makeSync(fields);
          sync.getStatus = () => status as Status;

          expect(readSyncState(sync, DATABASE_FILE_PATH)).toBe('unavailable');
        }
      )
    );
  });

  it('property: reads a filter that answers other than true or false as unavailable', () => {
    fc.assert(
      fc.property(
        fieldsArb.filter(
          ({ status }) =>
            status !== 'uninitialized' && status !== 'disconnected'
        ),
        fc.anything().filter((answer) => typeof answer !== 'boolean'),
        (fields, answer) => {
          const sync = makeSync(fields);
          sync.filter.allowSyncFile.mockReturnValue(answer as boolean);

          expect(readSyncState(sync, DATABASE_FILE_PATH)).toBe('unavailable');
        }
      )
    );
  });

  it('property: reads an instance whose methods throw as unavailable', () => {
    fc.assert(
      fc.property(
        fieldsArb,
        fc.constantFrom('getStatus', 'allowSyncFile'),
        (fields, thrower) => {
          const sync = makeSync(fields);
          const fail = () => {
            throw new Error('renamed internals');
          };
          if (thrower === 'getStatus') sync.getStatus = fail;
          else sync.filter.allowSyncFile.mockImplementation(fail);
          // Only asked once the status is past these two
          fc.pre(
            thrower === 'getStatus' ||
              (fields.status !== 'uninitialized' &&
                fields.status !== 'disconnected')
          );

          expect(readSyncState(sync, DATABASE_FILE_PATH)).toBe('unavailable');
        }
      )
    );
  });

  it('asks the filter about the database as a file, not a folder', () => {
    const sync = makeSync();

    readSyncState(sync, DATABASE_FILE_PATH);

    expect(sync.filter.allowSyncFile).toHaveBeenCalledWith(
      DATABASE_FILE_PATH,
      false
    );
  });
});

describe('waitForSyncedFile', () => {
  const TIMEOUT_MS = 60_000;
  const POLL_MS = 500;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Start a wait on whatever `getSync` hands back. */
  function wait(
    getSync: () => unknown,
    options: { isOffline?: () => boolean; signal?: AbortSignal } = {}
  ) {
    const settled = vi.fn();
    const promise = waitForSyncedFile({
      getSync,
      path: DATABASE_FILE_PATH,
      timeoutMs: TIMEOUT_MS,
      pollMs: POLL_MS,
      isOffline: options.isOffline ?? (() => false),
      signal: options.signal,
    }).then((outcome) => {
      settled(outcome);
      return outcome;
    });
    return { promise, settled };
  }

  /** Flush the microtasks a resolved wait needs to report. */
  const flush = () => vi.advanceTimersByTimeAsync(0);

  it('property: answers at once, without waiting, for any state that does not wait', async () => {
    await fc.assert(
      fc.asyncProperty(fieldsArb, async (fields) => {
        const sync = makeSync(fields);
        const state = readSyncState(sync, DATABASE_FILE_PATH);
        fc.pre(state !== 'pending' && state !== 'starting');

        const { settled } = wait(() => sync);
        await flush();

        expect(settled).toHaveBeenCalledWith(state);
        expect(sync.listenerCount()).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      })
    );
  });

  it('answers no-sync and unavailable at once', async () => {
    const none = wait(() => null);
    const odd = wait(() => ({ getStatus: 'renamed' }));
    await flush();

    expect(none.settled).toHaveBeenCalledWith('no-sync');
    expect(odd.settled).toHaveBeenCalledWith('unavailable');
  });

  it('settles on the status change that delivers the file, before the next poll', async () => {
    const sync = makeSync({
      ready: true,
      status: 'syncing',
      newServerFiles: [{ path: DATABASE_FILE_PATH }],
    });
    const { settled } = wait(() => sync);
    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(settled).not.toHaveBeenCalled();

    sync.newServerFiles = [];
    sync.trigger();
    await flush();

    expect(settled).toHaveBeenCalledWith('settled');
    expect(sync.listenerCount()).toBe(0);
    expect(sync.on).toHaveBeenCalledWith('status-change', expect.any(Function));
  });

  it('settles on the poll after `ready` turns true, which raises no event', async () => {
    const sync = makeSync({ ready: false, status: 'synced' });
    const { settled } = wait(() => sync);
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(settled).not.toHaveBeenCalled();

    sync.ready = true;
    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(settled).toHaveBeenCalledWith('settled');
    // One listener throughout, however many polls ran
    expect(sync.on).toHaveBeenCalledOnce();
  });

  it('waits out Sync reading its saved state, then answers by what it read', async () => {
    const sync = makeSync({ status: 'uninitialized', allowed: false });
    const { settled } = wait(() => sync, { isOffline: () => true });
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    expect(settled).not.toHaveBeenCalled();

    sync.status = 'disconnected';
    sync.trigger();
    await flush();

    expect(settled).toHaveBeenCalledWith('disconnected');
  });

  it('times out when the file never arrives, and not a moment before', async () => {
    const sync = makeSync({ ready: false, status: 'error' });
    const { settled } = wait(() => sync);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(settled).toHaveBeenCalledWith('timeout');
    expect(sync.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out while Sync never finishes starting', async () => {
    const sync = makeSync({ status: 'uninitialized' });
    const { settled } = wait(() => sync);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect(settled).toHaveBeenCalledWith('timeout');
  });

  it('gives up waiting on a device that is offline', async () => {
    let offline = false;
    const sync = makeSync({ ready: false, status: 'synced' });
    const { settled } = wait(() => sync, { isOffline: () => offline });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(settled).not.toHaveBeenCalled();

    offline = true;
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(settled).toHaveBeenCalledWith('offline');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops waiting when Sync is turned off meanwhile', async () => {
    let sync: ReturnType<typeof makeSync> | null = makeSync({ ready: false });
    const first = sync;
    const { settled } = wait(() => sync);
    await flush();

    sync = null;
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(settled).toHaveBeenCalledWith('no-sync');
    expect(first.listenerCount()).toBe(0);
  });

  it('follows Sync to a new instance, leaving the old one', async () => {
    const old = makeSync({ ready: false });
    const replacement = makeSync({ ready: false });
    let sync = old;
    const { settled } = wait(() => sync);
    await flush();

    sync = replacement;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(old.listenerCount()).toBe(0);
    expect(replacement.listenerCount()).toBe(1);

    replacement.ready = true;
    replacement.trigger();
    await flush();

    expect(settled).toHaveBeenCalledWith('settled');
    expect(replacement.listenerCount()).toBe(0);
  });

  it('stops waiting when cancelled', async () => {
    const controller = new AbortController();
    const sync = makeSync({ ready: false });
    const { settled } = wait(() => sync, { signal: controller.signal });
    await flush();

    controller.abort();
    await flush();

    expect(settled).toHaveBeenCalledWith('cancelled');
    expect(sync.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('answers cancelled at once when cancelled before it starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const sync = makeSync({ ready: false });

    const { settled } = wait(() => sync, { signal: controller.signal });
    await flush();

    expect(settled).toHaveBeenCalledWith('cancelled');
    expect(sync.on).not.toHaveBeenCalled();
  });

  it('answers once, whatever arrives after', async () => {
    const sync = makeSync({ ready: false });
    const controller = new AbortController();
    const { settled } = wait(() => sync, { signal: controller.signal });
    await flush();

    sync.ready = true;
    sync.trigger();
    controller.abort();
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect(settled).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledWith('settled');
  });

  it('stops listening for the abort once it has answered', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const sync = makeSync({ ready: false });
    wait(() => sync, { signal: controller.signal });
    await flush();

    sync.ready = true;
    sync.trigger();
    await flush();

    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('keeps waiting by polling when Sync will not take a listener', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const sync = makeSync({ ready: false });
    sync.on.mockImplementation(() => {
      throw new Error('renamed');
    });
    const { settled } = wait(() => sync);
    await flush();

    sync.ready = true;
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(settled).toHaveBeenCalledWith('settled');
    expect(console.debug).toHaveBeenCalledWith(
      'Incremental Reading - Sync on failed',
      expect.any(Error)
    );
  });

  it('answers, and listens no more, even when Sync will not drop its listener', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const sync = makeSync({ ready: false });
    sync.offref.mockImplementation(() => {
      throw new Error('renamed');
    });
    const { settled } = wait(() => sync);
    await flush();

    sync.ready = true;
    sync.trigger();
    await flush();
    expect(settled).toHaveBeenCalledWith('settled');
    expect(console.debug).toHaveBeenCalledWith(
      'Incremental Reading - Sync offref failed',
      expect.any(Error)
    );

    // The listener Sync kept fires on, to no effect
    sync.ready = false;
    sync.trigger();
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(sync.on).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledOnce();
  });
});

describe('holdForSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function hold(
    getSync: () => unknown,
    options: {
      reason?: SyncHoldReason;
      signal?: AbortSignal;
      timeoutMs?: number;
      isOffline?: () => boolean;
    } = {}
  ) {
    const notices = makeNotices();
    const notify = vi.fn();
    const settled = vi.fn();
    const promise = holdForSync({
      getSync,
      path: DATABASE_FILE_PATH,
      reason: options.reason ?? 'migrate',
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      isOffline: options.isOffline ?? (() => false),
      createNotice: notices.createNotice,
      notify,
    }).then((outcome) => {
      settled(outcome);
      return outcome;
    });
    return { promise, settled, notify, ...notices };
  }

  const reasonArb = fc.constantFrom<SyncHoldReason>('migrate');
  const stateOf = (fields: FakeSyncFields) =>
    readSyncState(makeSync(fields), DATABASE_FILE_PATH);
  /** Every Sync that reads as paused. */
  const pausedFieldsArb = fieldsArb.filter((f) => stateOf(f) === 'paused');
  /** Every Sync that, left as it is, keeps a startup waiting. */
  const waitingFieldsArb = fieldsArb.filter((f) =>
    ['pending', 'starting'].includes(stateOf(f))
  );

  it('property: goes ahead at once, silently, without Sync or when it has nothing to wait for', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.constant(null), fieldsArb.map(makeSync)),
        reasonArb,
        async (sync, reason) => {
          const state = readSyncState(sync, DATABASE_FILE_PATH);
          fc.pre(!['pending', 'starting', 'paused'].includes(state));

          const { settled, notify, createNotice } = hold(() => sync, {
            reason,
          });
          await vi.advanceTimersByTimeAsync(0);

          expect(settled).toHaveBeenCalledWith('at-once');
          expect(notify).not.toHaveBeenCalled();
          expect(createNotice).not.toHaveBeenCalled();
        }
      )
    );
  });

  it('property: goes ahead at once when Sync is paused, saying so', async () => {
    await fc.assert(
      fc.asyncProperty(reasonArb, pausedFieldsArb, async (reason, fields) => {
        const sync = makeSync(fields);

        const { settled, notify, createNotice } = hold(() => sync, { reason });
        await vi.advanceTimersByTimeAsync(0);

        expect(settled).toHaveBeenCalledWith('at-once');
        expect(notify).toHaveBeenCalledOnce();
        expect(notify).toHaveBeenCalledWith(SYNC_HOLD_MESSAGES.paused[reason]);
        expect(createNotice).not.toHaveBeenCalled();
      })
    );
  });

  it('sets no timer at all when there is nothing to wait for', async () => {
    const { settled } = hold(() => null);

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledWith('at-once');
  });

  it('shows a waiting notice only once the wait passes 1.5 s, and hides it once Sync delivers', async () => {
    const sync = makeSync({ ready: false });
    const { settled, shown, notify } = hold(() => sync);

    await vi.advanceTimersByTimeAsync(SYNC_WAIT_NOTICE_DELAY_MS - 1);
    expect(shown).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(shown.map(({ message }) => message)).toEqual([
      SYNC_HOLD_MESSAGES.waiting,
    ]);
    expect(shown[0].hide).not.toHaveBeenCalled();

    sync.ready = true;
    sync.trigger();
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toHaveBeenCalledWith('waited');
    expect(shown[0].hide).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows no waiting notice for a wait shorter than 1.5 s', async () => {
    const sync = makeSync({ ready: false });
    const { settled, shown } = hold(() => sync);
    await vi.advanceTimersByTimeAsync(SYNC_WAIT_NOTICE_DELAY_MS - 1);

    sync.ready = true;
    sync.trigger();
    await vi.advanceTimersByTimeAsync(SYNC_WAIT_NOTICE_DELAY_MS);

    expect(settled).toHaveBeenCalledWith('waited');
    expect(shown).toHaveLength(0);
  });

  it('property: goes ahead after 60 s when Sync never delivers, warning the copies may conflict', async () => {
    await fc.assert(
      fc.asyncProperty(reasonArb, waitingFieldsArb, async (reason, fields) => {
        const sync = makeSync(fields);
        const { settled, notify, shown } = hold(() => sync, { reason });

        await vi.advanceTimersByTimeAsync(SYNC_WAIT_TIMEOUT_MS - 1);
        expect(settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        expect(settled).toHaveBeenCalledWith('waited');
        expect(notify).toHaveBeenCalledWith(
          SYNC_HOLD_MESSAGES.timeout[reason],
          { persist: true }
        );
        expect(shown[0].hide).toHaveBeenCalled();
        expect(console.warn).toHaveBeenLastCalledWith(
          `Incremental Reading - Sync had not delivered ${DATABASE_FILE_PATH} (timeout); going ahead`
        );
      })
    );
  });

  it('times out at the given time instead, when one is given', async () => {
    const sync = makeSync({ ready: false });
    const { settled } = hold(() => sync, { timeoutMs: 2000 });

    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(settled).toHaveBeenCalledWith('waited');
  });

  it('goes ahead with the timeout warning when the device is offline', async () => {
    const sync = makeSync({ ready: false });
    const { settled, notify } = hold(() => sync, { isOffline: () => true });

    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toHaveBeenCalledWith('waited');
    expect(notify).toHaveBeenCalledWith(SYNC_HOLD_MESSAGES.timeout.migrate, {
      persist: true,
    });
  });

  it('property: reads the device as offline by navigator.onLine when not told otherwise', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (online) => {
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online);
        const sync = makeSync({ ready: false });
        const notify = vi.fn();
        const settled = vi.fn();
        void holdForSync({
          getSync: () => sync,
          path: DATABASE_FILE_PATH,
          reason: 'migrate',
          createNotice: makeNotices().createNotice,
          notify,
        }).then(settled);

        await vi.advanceTimersByTimeAsync(0);

        if (online) {
          expect(settled).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(SYNC_WAIT_TIMEOUT_MS);
        } else {
          expect(settled).toHaveBeenCalledWith('waited');
          expect(notify).toHaveBeenCalledWith(
            SYNC_HOLD_MESSAGES.timeout.migrate,
            { persist: true }
          );
        }
      })
    );
  });

  it('gives up, telling the caller not to go ahead, when cancelled', async () => {
    const controller = new AbortController();
    const sync = makeSync({ ready: false });
    const { settled, notify, shown } = hold(() => sync, {
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(SYNC_WAIT_NOTICE_DELAY_MS);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toHaveBeenCalledWith('cancelled');
    expect(notify).not.toHaveBeenCalled();
    expect(shown[0].hide).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('findSyncExclusions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function ask(
    getSync: () => unknown,
    path = DATABASE_FILE_PATH,
    signal?: AbortSignal
  ) {
    const settled = vi.fn();
    void findSyncExclusions({ getSync, path, signal }).then(settled);
    return settled;
  }

  it('names the excluded folder that keeps the database file out', async () => {
    const sync = makeSync({ allowed: false, allowTypes: ['unsupported'] });
    sync.filter.ignoreFolders = [DATA_DIRECTORY];

    const settled = ask(() => sync);
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toHaveBeenCalledWith([
      { cause: 'folder', folder: DATA_DIRECTORY },
    ]);
  });

  it('property: names each setting that keeps the database file out, exactly when Sync is set up and would skip it', async () => {
    await fc.assert(
      fc.asyncProperty(
        fieldsArb.filter(({ status }) => status !== 'uninitialized'),
        dataPathArb.chain(({ segments, path }) =>
          fc.record({
            path: fc.constant(path),
            ignoreFolders: ignoreFoldersArb(segments, path),
          })
        ),
        async (fields, { path, ignoreFolders }) => {
          const sync = makeSync(fields);
          sync.filter.ignoreFolders = ignoreFolders;
          sync.filter.allowSyncFile.mockImplementation((file) =>
            syncAllows(file, ignoreFolders, fields.allowTypes)
          );

          const settled = ask(() => sync, path);
          await vi.advanceTimersByTimeAsync(0);

          const folder = ignoreFolders.find((f) => path.startsWith(`${f}/`));
          const expected =
            fields.status === 'disconnected' ||
            syncAllows(path, ignoreFolders, fields.allowTypes)
              ? []
              : [
                  ...(folder === undefined
                    ? []
                    : [{ cause: 'folder', folder }]),
                  ...(fields.allowTypes.includes('unsupported')
                    ? []
                    : [{ cause: 'type' }]),
                ];
          expect(settled).toHaveBeenCalledWith(expected);
          if (fields.status !== 'disconnected') {
            expect(sync.filter.allowSyncFile).toHaveBeenCalledWith(path, false);
          }
        }
      )
    );
  });

  it('property: takes Sync at its word when it would sync the file, whatever its settings look like', async () => {
    await fc.assert(
      fc.asyncProperty(
        fieldsArb.filter(({ status }) => status !== 'uninitialized'),
        dataPathArb.chain(({ segments, path }) =>
          fc.record({
            path: fc.constant(path),
            ignoreFolders: ignoreFoldersArb(segments, path),
          })
        ),
        async (fields, { path, ignoreFolders }) => {
          const sync = makeSync({ ...fields, allowed: true });
          sync.filter.ignoreFolders = ignoreFolders;

          const settled = ask(() => sync, path);
          await vi.advanceTimersByTimeAsync(0);

          expect(settled).toHaveBeenCalledWith([]);
        }
      )
    );
  });

  it('property: names only the settings it can read when Sync skips the file', async () => {
    await fc.assert(
      fc.asyncProperty(
        fieldsArb.filter(
          ({ status }) =>
            status !== 'uninitialized' && status !== 'disconnected'
        ),
        fc.oneof(
          fc.anything().filter((value) => !Array.isArray(value)),
          fc.array(fc.anything().filter((value) => typeof value !== 'string'))
        ),
        fc.anything().filter((value) => !(value instanceof Set)),
        fc.boolean(),
        async (fields, ignoreFolders, allowTypes, typesReadable) => {
          const sync = makeSync({ ...fields, allowed: false });
          sync.filter.ignoreFolders = ignoreFolders;
          if (!typesReadable) {
            (sync.filter as Record<string, unknown>).allowTypes = allowTypes;
          }

          const settled = ask(() => sync);
          await vi.advanceTimersByTimeAsync(0);

          expect(settled).toHaveBeenCalledWith(
            typesReadable && !fields.allowTypes.includes('unsupported')
              ? [{ cause: 'type' }]
              : []
          );
        }
      )
    );
  });

  it('property: names the setting it can still read when reading the other throws', async () => {
    await fc.assert(
      fc.asyncProperty(
        fieldsArb.filter(
          ({ status }) =>
            status !== 'uninitialized' && status !== 'disconnected'
        ),
        fc.constantFrom('ignoreFolders', 'allowTypes'),
        async (fields, unreadable) => {
          const sync = makeSync({ ...fields, allowed: false });
          sync.filter.ignoreFolders = [DATA_DIRECTORY];
          Object.defineProperty(sync.filter, unreadable, {
            get() {
              throw new Error('Sync settings not loaded');
            },
          });

          const settled = ask(() => sync);
          await vi.advanceTimersByTimeAsync(0);

          const typeOff = !fields.allowTypes.includes('unsupported');
          expect(settled).toHaveBeenCalledWith(
            unreadable === 'allowTypes'
              ? [{ cause: 'folder', folder: DATA_DIRECTORY }]
              : typeOff
                ? [{ cause: 'type' }]
                : []
          );
        }
      )
    );
  });

  it('names no excluded folder that is not a path, even one that reads as the data folder', async () => {
    const sync = makeSync({ allowed: false, allowTypes: ['unsupported'] });
    sync.filter.ignoreFolders = [{ toString: () => DATA_DIRECTORY }];

    const settled = ask(() => sync);
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toHaveBeenCalledWith([]);
  });

  it('names no excluded folder from a list that is not an array, even one that finds the data folder', async () => {
    const sync = makeSync({ allowed: false, allowTypes: ['unsupported'] });
    sync.filter.ignoreFolders = { find: () => DATA_DIRECTORY };

    const settled = ask(() => sync);
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toHaveBeenCalledWith([]);
  });

  it('waits for Sync to read its settings before reading them', async () => {
    const sync = makeSync({ status: 'uninitialized', allowed: false });
    const settled = ask(() => sync);
    await vi.advanceTimersByTimeAsync(SYNC_POLL_MS * 4);
    expect(settled).not.toHaveBeenCalled();

    // What Sync's saved state holds replaces the defaults
    sync.filter.allowTypes = new Set(['image', 'unsupported']);
    sync.filter.ignoreFolders = [DATA_DIRECTORY];
    sync.status = 'synced';
    sync.trigger();
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toHaveBeenCalledWith([
      { cause: 'folder', folder: DATA_DIRECTORY },
    ]);
  });

  it('names nothing when Sync never finishes starting', async () => {
    const sync = makeSync({ status: 'uninitialized', allowed: false });
    const settled = ask(() => sync);

    await vi.advanceTimersByTimeAsync(SYNC_WAIT_TIMEOUT_MS);

    expect(settled).toHaveBeenCalledWith([]);
  });

  it('names nothing when cancelled', async () => {
    const controller = new AbortController();
    const sync = makeSync({ status: 'uninitialized', allowed: false });
    const settled = ask(() => sync, DATABASE_FILE_PATH, controller.signal);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toHaveBeenCalledWith([]);
  });

  it('property: names nothing without Sync, or with Sync in a shape it does not know', async () => {
    await fc.assert(
      fc.asyncProperty(
        fieldsArb.filter(({ status }) => status !== 'uninitialized'),
        fc.oneof(
          fc.constant('none'),
          fc.constant('no-filter'),
          fc.constant('status'),
          fc.constant('answer')
        ),
        async (fields, variant) => {
          const sync = makeSync({ ...fields, allowed: false });
          sync.filter.ignoreFolders = [DATA_DIRECTORY];
          const broken = sync as unknown as Record<string, unknown>;
          if (variant === 'no-filter') delete broken.filter;
          if (variant === 'status') sync.status = 'resting' as Status;
          if (variant === 'answer') {
            sync.filter.allowSyncFile.mockReturnValue(
              'no' as unknown as boolean
            );
          }

          const settled = ask(() => (variant === 'none' ? null : sync));
          await vi.advanceTimersByTimeAsync(0);

          expect(settled).toHaveBeenCalledWith([]);
        }
      )
    );
  });
});

describe('syncExclusionMessage', () => {
  it('property: names the excluded folder and where to remove it', () => {
    fc.assert(
      fc.property(fc.string(), (folder) => {
        expect(syncExclusionMessage({ cause: 'folder', folder })).toContain(
          `"${folder}"`
        );
      })
    );
  });

  it('names the "Sync all other types" setting and where to turn it on', () => {
    // Obsidian's own setting name, which only this branch picks
    expect(syncExclusionMessage({ cause: 'type' })).toContain(
      'Sync all other types'
    );
  });
});

describe('getSyncPlugin', () => {
  it('asks Obsidian for the Sync plugin, if enabled', () => {
    const sync = makeSync();
    const getEnabledPluginById = vi.fn(() => sync);
    const app = { internalPlugins: { getEnabledPluginById } } as unknown as App;

    expect(getSyncPlugin(app)).toBe(sync);
    expect(getEnabledPluginById).toHaveBeenCalledWith('sync');
  });

  it('property: answers nothing when Obsidian has no such lookup', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant({}),
          fc.constant({ internalPlugins: null }),
          fc.constant({ internalPlugins: {} }),
          fc.constant({
            internalPlugins: {
              getEnabledPluginById: () => {
                throw new Error('renamed');
              },
            },
          })
        ),
        (app) => {
          expect(getSyncPlugin(app as unknown as App)).toBeUndefined();
        }
      )
    );
  });
});
