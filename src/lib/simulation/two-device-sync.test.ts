import { STALE_AFTER_MS } from '#/lib/repository/write-stamp';
import fc from 'fast-check';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { DEFAULT_DB_PATH } from './FakeVault';
import { FakeSync, makeDevice, type FakeDevice } from './SimulationHarness';

// #region HELPERS

const T = 1_790_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

/** Write an article row on `device`, and wait out the save it starts. */
async function write(device: FakeDevice, id: string) {
  device.repo.mutate(
    `INSERT INTO article (id, reference, due, interval, priority)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, `articles/${id}.md`, T, DAY, 30]
  );
  await device.repo.settle();
}

/** Ids of the article rows `device` holds in memory. */
function idsHeld(device: FakeDevice): string[] {
  return (device.repo.query('SELECT id FROM article') as { id: string }[])
    .map((row) => row.id)
    .sort();
}

/** Ids of the article rows in every backup on `device`'s disk. */
function idsBackedUp(device: FakeDevice): string[] {
  return device.vault.adapter
    .paths()
    .filter((path) => path !== DEFAULT_DB_PATH)
    .flatMap((path) => {
      const db = new SQL.Database(
        new Uint8Array(device.vault.adapter.diskBytes(path)!)
      );
      const [rows] = db.exec('SELECT id FROM article');
      db.close();
      return (rows?.values ?? []).map(([id]) => id as string);
    });
}

/** How many times `device` has taken a file on (`reloadDb`). */
function spyReloads(device: FakeDevice) {
  return vi.spyOn(
    device.repo as unknown as { reloadDb: () => Promise<unknown> },
    'reloadDb'
  );
}

/** One thing that can happen between two devices sharing a vault. */
type Step =
  | { kind: 'write'; on: 0 | 1 }
  | { kind: 'deliver'; from: 0 | 1 }
  | { kind: 'echo'; on: 0 | 1 }
  | { kind: 'wait'; on: 0 | 1 | 'both'; ms: number };

const deviceIndexArb = fc.constantFrom<0 | 1>(0, 1);

/**
 * Writes and deliveries weighted up: the rows at risk come from them, and a
 * copy sent back before the other device saves again (the `behind` case)
 * takes several in a row.
 */
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 3,
    arbitrary: deviceIndexArb.map((on) => ({ kind: 'write' as const, on })),
  },
  {
    weight: 3,
    arbitrary: deviceIndexArb.map((from) => ({
      kind: 'deliver' as const,
      from,
    })),
  },
  deviceIndexArb.map((on) => ({ kind: 'echo' as const, on })),
  fc.record({
    kind: fc.constant('wait' as const),
    on: fc.constantFrom<0 | 1 | 'both'>(0, 1, 'both'),
    // Mostly short, sometimes past the point a device counts as stale
    ms: fc.oneof(
      fc.integer({ min: 1, max: DAY }),
      fc.integer({ min: STALE_AFTER_MS - DAY, max: STALE_AFTER_MS + 30 * DAY })
    ),
  })
);

// #endregion

describe('two devices syncing one database file', () => {
  let sync: FakeSync;

  beforeEach(() => {
    sync = new FakeSync();
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('takes on the copy another device saved on top of its own, and leaves its own copy coming back alone', async () => {
    const a = await makeDevice('a', { now: T });
    await write(a, 'a1');
    const b = await makeDevice('b', {
      now: T,
      bytes: a.vault.adapter.diskBytes(),
    });
    await write(b, 'b1');
    const reloads = spyReloads(a);

    await sync.deliver(b, a);
    expect(idsHeld(a)).toEqual(['a1', 'b1']);
    expect(reloads).toHaveBeenCalledOnce();

    await sync.echo(a);
    expect(reloads).toHaveBeenCalledOnce();
    expect(idsBackedUp(a)).toEqual([]);
  });

  it('leaves alone a copy of its own sent back from before its latest save, and the sender takes the latest on', async () => {
    const a = await makeDevice('a', { now: T });
    await write(a, 'a1');
    const b = await makeDevice('b', {
      now: T,
      bytes: a.vault.adapter.diskBytes(),
    });
    await write(a, 'a2');

    await sync.deliver(b, a);
    expect(idsHeld(a)).toEqual(['a1', 'a2']);

    await sync.deliver(a, b);
    expect(idsHeld(b)).toEqual(['a1', 'a2']);
    expect(idsBackedUp(a)).toEqual([]);
    expect(idsBackedUp(b)).toEqual([]);
  });

  it('backs up the saves a device drops when it takes on a copy saved alongside its own', async () => {
    const a = await makeDevice('a', { now: T });
    await write(a, 'a1');
    const b = await makeDevice('b', {
      now: T,
      bytes: a.vault.adapter.diskBytes(),
    });
    await write(b, 'b1');
    await write(a, 'a2');

    await sync.deliver(b, a);

    expect(idsHeld(a)).toEqual(['a1', 'b1']);
    expect(idsBackedUp(a).sort()).toEqual(['a1', 'a2']);
  });

  it('leaves a copy from a device away for more than 180 days alone, and the away device takes this one on', async () => {
    const a = await makeDevice('a', { now: T });
    await write(a, 'a1');
    const b = await makeDevice('b', {
      now: T,
      bytes: a.vault.adapter.diskBytes(),
    });
    await write(b, 'b-old');
    a.clock.now = b.clock.now = T + STALE_AFTER_MS + DAY;
    await write(a, 'a2');

    await sync.deliver(b, a);
    expect(idsHeld(a)).toEqual(['a1', 'a2']);

    await sync.deliver(a, b);
    expect(idsHeld(b)).toEqual(['a1', 'a2']);
    expect(idsBackedUp(b).sort()).toEqual(['a1', 'b-old']);
  });

  it('property: never drops a row without a backup, never reloads its own copy, and agrees after a round trip with no writes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(stepArb, { maxLength: 14 }),
        fc.integer({ min: -DAY, max: DAY }),
        async (steps, skew) => {
          const devices = [
            await makeDevice('a', { now: T }),
            await makeDevice('b', { now: T + skew }),
          ];
          const written: string[] = [];

          for (const [i, step] of steps.entries()) {
            switch (step.kind) {
              case 'write': {
                const id = `row-${i}`;
                await write(devices[step.on], id);
                written.push(id);
                break;
              }
              case 'deliver':
                await sync.deliver(devices[step.from], devices[1 - step.from]);
                break;
              case 'echo': {
                const device = devices[step.on];
                const reloads = spyReloads(device);
                const before = device.vault.adapter.diskBytes();
                await sync.echo(device);
                expect(reloads).not.toHaveBeenCalled();
                // Nor saved again
                expect(device.vault.adapter.diskBytes()).toBe(before);
                reloads.mockRestore();
                break;
              }
              case 'wait':
                for (const [j, device] of devices.entries()) {
                  if (step.on === 'both' || step.on === j) {
                    device.clock.now += step.ms;
                  }
                }
                break;
            }
            const kept = new Set(
              devices.flatMap((d) => [...idsHeld(d), ...idsBackedUp(d)])
            );
            for (const id of written) expect(kept).toContain(id);
          }

          // A round trip with no writes in between leaves both alike
          const [a, b] = devices;
          if (await sync.deliver(a, b)) {
            await sync.deliver(b, a);
            expect(idsHeld(a)).toEqual(idsHeld(b));
          }
        }
      ),
      { numRuns: 150 }
    );
  });
});
