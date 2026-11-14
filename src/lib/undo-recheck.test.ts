import {
  purgedReference,
  tombstoneRowStatements,
} from '#/lib/items/row-delete';
import type { ItemTable } from '#/lib/moved-note-scan';
import {
  FakeRepository,
  FakeSync,
  FakeVault,
  makeDevice,
  type FakeDevice,
} from '#/lib/simulation/SimulationHarness';
import type { SQLiteRepository } from '#/lib/types';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  changedWhere,
  changesSince,
  describeChanges,
  sameChanges,
  takeFootprint,
  type ChangesElsewhere,
  type ItemEdit,
  type UndoFootprint,
} from './undo-recheck';

// #region HELPERS

const T = 1_790_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

let sync: FakeSync;

async function twoDevices(skew = 0): Promise<[FakeDevice, FakeDevice]> {
  return [
    await makeDevice('a', { now: T }),
    await makeDevice('b', { now: T + skew }),
  ];
}

async function write(device: FakeDevice, query: string, params: unknown[]) {
  device.repo.mutate(query, params as never);
  await device.repo.settle();
}

/**
 * A snippet `id`, under `parent` when given, and taken from `context` when
 * given.
 */
function insertSnippet(
  device: FakeDevice,
  id: string,
  parent?: string,
  context?: string
) {
  return write(
    device,
    `INSERT INTO snippet (id, reference, parent, context, due, interval,
       priority)
     VALUES ($1, $2, $3, $4, $5, $6, 30)`,
    [id, `snippets/${id}.md`, parent ?? null, context ?? null, T, DAY]
  );
}

/**
 * A card `id`, under `parent` when given, and taken from `context` when
 * given.
 */
function insertCard(
  device: FakeDevice,
  id: string,
  parent?: string,
  context?: string
) {
  return write(
    device,
    `INSERT INTO srs_card (id, reference, parent, context, created_at, due,
       stability, difficulty, elapsed_days, scheduled_days, state)
     VALUES ($1, $2, $3, $4, $5, $5, 0, 0, 0, 0, 0)`,
    [id, `cards/${id}.md`, parent ?? null, context ?? null, T]
  );
}

function insertArticle(device: FakeDevice, id: string) {
  return write(
    device,
    `INSERT INTO article (id, reference, due, interval, priority)
     VALUES ($1, $2, $3, $4, 30)`,
    [id, `notes/${id}.md`, T, DAY]
  );
}

function reviewSnippet(device: FakeDevice, id: string, snippetId: string) {
  return write(
    device,
    `INSERT INTO snippet_review (id, snippet_id, review_time)
     VALUES ($1, $2, $3)`,
    [id, snippetId, device.clock.now]
  );
}

function gradeCard(device: FakeDevice, id: string, cardId: string) {
  return write(
    device,
    `INSERT INTO srs_card_review (id, card_id, due, review, stability,
       difficulty, elapsed_days, last_elapsed_days, scheduled_days, rating,
       state)
     VALUES ($1, $2, $3, $3, 1, 1, 0, 0, 1, 3, 1)`,
    [id, cardId, device.clock.now]
  );
}

async function footprintOf(
  device: FakeDevice,
  table: ItemTable,
  id: string
): Promise<UndoFootprint> {
  const footprint = await takeFootprint(device.repo, table, id);
  if (!footprint) throw new Error(`no footprint of ${table} ${id}`);
  return footprint;
}

/** Nothing changed elsewhere, but for the given counts and devices. */
function changes(over: Partial<ChangesElsewhere>): ChangesElsewhere {
  return {
    devices: ['b'],
    edits: [],
    reviews: 0,
    grades: 0,
    relinked: false,
    ...over,
  };
}

// #endregion

describe('changesSince', () => {
  beforeEach(() => {
    sync = new FakeSync();
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The reproduction of the loss: B's file is taken on whole, which reports
  // no row changes, so only the stamps tell. The card B made outlives the
  // undo, moved up to what the snippet sat under: nothing it discards
  it('finds the review another device made of a snippet, taken on in a fast-forward, and not the card it made from it', async () => {
    const [a, b] = await twoDevices();
    await insertSnippet(a, 's');
    const footprint = await footprintOf(a, 'snippet', 's');
    await sync.deliver(a, b);

    b.clock.now += 1000;
    await insertCard(b, 'c', 's');
    await reviewSnippet(b, 'r', 's');
    await sync.deliver(b, a);

    expect(await changesSince(a.repo, [footprint])).toEqual(
      changes({ reviews: 1 })
    );
  });

  // A merge replays the snippet's schedule from both logs and writes it as
  // this device: the row's stamp no longer tells, but the review's own does
  it('finds the review another device made of a snippet through a merge that restamps the snippet as this device', async () => {
    const [a, b] = await twoDevices();
    await insertSnippet(a, 's');
    const footprint = await footprintOf(a, 'snippet', 's');
    await sync.deliver(a, b);

    a.clock.now += 1000;
    b.clock.now += 2000;
    await reviewSnippet(a, 'mine', 's');
    await reviewSnippet(b, 'theirs', 's');
    await sync.deliver(b, a);

    const [snippet] = a.repo.query(
      'SELECT updated_by FROM snippet WHERE id = $1',
      ['s']
    );
    expect(snippet).toMatchObject({ updated_by: 'a' });
    expect(await changesSince(a.repo, [footprint])).toEqual(
      changes({ reviews: 1 })
    );
  });

  it('finds the grades another device gave a card', async () => {
    const [a, b] = await twoDevices();
    await insertCard(a, 'c');
    const footprint = await footprintOf(a, 'srs_card', 'c');
    await sync.deliver(a, b);

    b.clock.now += 1000;
    await gradeCard(b, 'g1', 'c');
    await gradeCard(b, 'g2', 'c');
    await sync.deliver(b, a);

    expect(await changesSince(a.repo, [footprint])).toEqual(
      changes({ grades: 2 })
    );
  });

  it('finds a snippet another device dismissed', async () => {
    const [a, b] = await twoDevices();
    await insertSnippet(a, 's');
    const footprint = await footprintOf(a, 'snippet', 's');
    await sync.deliver(a, b);

    b.clock.now += 1000;
    await write(b, 'UPDATE snippet SET dismissed = TRUE WHERE id = $1', ['s']);
    await sync.deliver(b, a);

    expect(await changesSince(a.repo, [footprint])).toEqual(
      changes({ edits: ['dismissed'] })
    );
  });

  // Undone there, the review is gone already: its discard here loses nothing
  it('ignores reviews undone on another device', async () => {
    const [a, b] = await twoDevices();
    await insertSnippet(a, 's');
    await reviewSnippet(a, 'r', 's');
    const footprint = await footprintOf(a, 'snippet', 's');
    await sync.deliver(a, b);

    b.clock.now += 1000;
    await write(b, 'UPDATE snippet_review SET deleted = TRUE WHERE id = $1', [
      'r',
    ]);
    await sync.deliver(b, a);

    expect(await changesSince(a.repo, [footprint])).toBeNull();
  });

  it('finds an article another device rebound to a moved note', async () => {
    const [a, b] = await twoDevices();
    await insertArticle(a, 'x');
    const footprint = await footprintOf(a, 'article', 'x');
    await sync.deliver(a, b);

    b.clock.now += 1000;
    await write(
      b,
      `INSERT INTO rebind (article_id, old_reference, new_reference, rebound_at)
       VALUES ($1, 'notes/x.md', 'notes/moved.md', $2)`,
      ['x', b.clock.now]
    );
    await sync.deliver(b, a);

    expect(await changesSince(a.repo, [footprint])).toEqual(
      changes({ relinked: true })
    );
  });

  it('ignores a rebind this device made, or had seen', async () => {
    const [a, b] = await twoDevices();
    await insertArticle(b, 'x');
    await write(
      b,
      `INSERT INTO rebind (article_id, old_reference, new_reference, rebound_at)
       VALUES ($1, 'notes/x.md', 'notes/old.md', $2)`,
      ['x', b.clock.now]
    );
    await sync.deliver(b, a);
    const footprint = await footprintOf(a, 'article', 'x');

    a.clock.now += 1000;
    await write(a, 'UPDATE rebind SET deleted = TRUE WHERE article_id = $1', [
      'x',
    ]);

    expect(await changesSince(a.repo, [footprint])).toBeNull();
  });

  it('property: finds a snippet row another device changed exactly when it changed more than where it is, how far it was read, its offsets, its note fingerprint or its schedule', async () => {
    // Each column with a value that differs from the snippet's as made
    const columns = {
      reference: "'snippets/moved.md'",
      scroll_top: '120',
      start_offset: '4',
      end_offset: '9',
      note_mtime: '5',
      due_fuzz: '77',
      priority: '20',
      dismissed: 'TRUE',
      deleted: 'TRUE',
      interval: '2',
      due: '3',
      parent: "'elsewhere'",
    } as const;
    const said: Partial<Record<keyof typeof columns, ItemEdit>> = {
      priority: 'priority changed',
      dismissed: 'dismissed',
      deleted: 'moved to the trash',
      parent: 'edited',
    };
    await fc.assert(
      fc.asyncProperty(
        fc.subarray(Object.keys(columns) as (keyof typeof columns)[], {
          minLength: 1,
        }),
        async (changed) => {
          sync = new FakeSync();
          const [a, b] = await twoDevices();
          await insertSnippet(a, 's');
          const footprint = await footprintOf(a, 'snippet', 's');
          await sync.deliver(a, b);

          b.clock.now += 1000;
          await write(
            b,
            `UPDATE snippet SET ${changed
              .map((column) => `${column} = ${columns[column]}`)
              .join(', ')} WHERE id = $1`,
            ['s']
          );
          await sync.deliver(b, a);

          const edits = [
            ...new Set(changed.flatMap((column) => said[column] ?? [])),
          ].sort();
          expect(await changesSince(a.repo, [footprint])).toEqual(
            edits.length === 0 ? null : changes({ edits })
          );
        }
      ),
      { numRuns: 30 }
    );
  });

  // Its schedule follows from its grades, which are found on their own
  it('property: finds a card row another device changed exactly when it changed more than its schedule', async () => {
    // Each column with a value that differs from the card's as made
    const columns = {
      due: '3',
      last_review: '4',
      stability: '2.5',
      difficulty: '6.5',
      elapsed_days: '1',
      scheduled_days: '2',
      learning_steps: '1',
      reps: '1',
      lapses: '1',
      state: '2',
      dismissed: 'TRUE',
      created_at: '5',
    } as const;
    const said: Partial<Record<keyof typeof columns, ItemEdit>> = {
      dismissed: 'dismissed',
      created_at: 'edited',
    };
    await fc.assert(
      fc.asyncProperty(
        fc.subarray(Object.keys(columns) as (keyof typeof columns)[], {
          minLength: 1,
        }),
        async (changed) => {
          sync = new FakeSync();
          const [a, b] = await twoDevices();
          await insertCard(a, 'c');
          const footprint = await footprintOf(a, 'srs_card', 'c');
          await sync.deliver(a, b);

          b.clock.now += 1000;
          await write(
            b,
            `UPDATE srs_card SET ${changed
              .map((column) => `${column} = ${columns[column]}`)
              .join(', ')} WHERE id = $1`,
            ['c']
          );
          await sync.deliver(b, a);

          const edits = [
            ...new Set(changed.flatMap((column) => said[column] ?? [])),
          ].sort();
          expect(await changesSince(a.repo, [footprint])).toEqual(
            edits.length === 0 ? null : changes({ edits })
          );
        }
      ),
      { numRuns: 30 }
    );
  });

  it('names each change to an item row, both ways', async () => {
    const [a, b] = await twoDevices();
    await write(
      a,
      `INSERT INTO article (id, reference, due, interval, priority,
         fixed_interval_days, dismissed, deleted)
       VALUES ('x', 'notes/x.md', $1, $2, 30, NULL, TRUE, TRUE)`,
      [T, DAY]
    );
    const footprint = await footprintOf(a, 'article', 'x');
    await sync.deliver(a, b);

    b.clock.now += 1000;
    await write(
      b,
      `UPDATE article SET fixed_interval_days = 3, dismissed = FALSE,
         deleted = FALSE WHERE id = $1`,
      ['x']
    );
    await sync.deliver(b, a);

    expect((await changesSince(a.repo, [footprint]))?.edits).toEqual([
      'fixed interval changed',
      'restored from the trash',
      'un-dismissed',
    ]);
  });

  it("ignores this device's own reviews and changes made since", async () => {
    const [a] = await twoDevices();
    await insertSnippet(a, 's');
    const footprint = await footprintOf(a, 'snippet', 's');

    a.clock.now += 1000;
    await reviewSnippet(a, 'r', 's');
    await write(a, 'UPDATE snippet SET priority = 10 WHERE id = $1', ['s']);

    expect(await changesSince(a.repo, [footprint])).toBeNull();
  });

  it('counts a row stamped past the save of its device the footprint saw, and not one stamped at it', async () => {
    const a = await makeDevice('a', { now: T });
    await insertCard(a, 'c');
    const footprint = {
      ...(await footprintOf(a, 'srs_card', 'c')),
      seen: { b: T },
    };
    for (const [id, at] of [
      ['at', T],
      ['past', T + 1],
    ] as const) {
      await write(
        a,
        `INSERT INTO srs_card_review (id, card_id, due, review, stability,
           difficulty, elapsed_days, last_elapsed_days, scheduled_days,
           rating, state, updated_at, updated_by)
         VALUES ($1, 'c', 0, 0, 1, 1, 0, 0, 1, 3, 1, $2, 'b')`,
        [id, at]
      );
    }

    expect(await changesSince(a.repo, [footprint])).toEqual(
      changes({ grades: 1 })
    );
  });

  it("ignores another device's work this device had already seen", async () => {
    const [a, b] = await twoDevices();
    await insertSnippet(a, 's');
    await sync.deliver(a, b);
    b.clock.now += 1000;
    await reviewSnippet(b, 'r', 's');
    await sync.deliver(b, a);

    const footprint = await footprintOf(a, 'snippet', 's');

    expect(await changesSince(a.repo, [footprint])).toBeNull();
  });

  it('finds work done on a device whose clock runs a day behind, after this device saw its earlier saves', async () => {
    const [a, b] = await twoDevices(-DAY);
    await insertArticle(b, 'other');
    await sync.deliver(b, a);
    await insertSnippet(a, 's');
    const footprint = await footprintOf(a, 'snippet', 's');
    expect(footprint.seen.b).toBeDefined();
    await sync.deliver(a, b);

    await reviewSnippet(b, 'r', 's');
    await sync.deliver(b, a);

    expect(await changesSince(a.repo, [footprint])).toEqual(
      changes({ reviews: 1 })
    );
  });

  // An undo leaves what was made from the item in place, moved up to what
  // the item sat under: making one there is nothing the undo discards
  it('ignores the snippets and cards made from the item on another device, under it or only taken from it', async () => {
    const [a, b] = await twoDevices();
    await insertArticle(a, 'x');
    await insertArticle(a, 'y');
    const footprint = await footprintOf(a, 'article', 'x');
    await sync.deliver(a, b);

    b.clock.now += 1000;
    await insertSnippet(b, 'under', 'x');
    await insertCard(b, 'card-under', 'x');
    await insertSnippet(b, 'taken', 'y', 'x');
    await insertCard(b, 'card-taken', 'y', 'x');
    await sync.deliver(b, a);

    expect(await changesSince(a.repo, [footprint])).toBeNull();
  });

  it('adds nothing for an item deleted for good, or gone, since', async () => {
    const [a, b] = await twoDevices();
    await insertSnippet(a, 's');
    const footprint = await footprintOf(a, 'snippet', 's');
    // Rows are never deleted outright: one never made stands for one gone
    const footprints = [footprint, { ...footprint, id: 'gone' }];
    await sync.deliver(a, b);

    b.clock.now += 1000;
    await reviewSnippet(b, 'r', 's');
    await b.repo.transaction(() => {
      for (const { query, params } of tombstoneRowStatements('snippet', 's')) {
        b.repo.mutate(query, params);
      }
    });
    await b.repo.settle();
    await sync.deliver(b, a);

    expect(await changesSince(a.repo, footprints)).toBeNull();
  });

  it('adds up what was done to every item, naming each device once', async () => {
    const [a, b] = await twoDevices();
    const c = await makeDevice('c', { now: T });
    await insertSnippet(a, 'x');
    await insertSnippet(a, 'y');
    const footprints = [
      await footprintOf(a, 'snippet', 'x'),
      await footprintOf(a, 'snippet', 'y'),
    ];
    await sync.deliver(a, b);
    await sync.deliver(a, c);

    b.clock.now += 1000;
    c.clock.now += 1000;
    // Met in the order c, b: named sorted all the same
    await reviewSnippet(c, 'of-x', 'x');
    await reviewSnippet(b, 'of-y', 'y');
    await reviewSnippet(b, 'of-y-again', 'y');
    await sync.deliver(b, a);
    await sync.deliver(c, a);

    expect(await changesSince(a.repo, footprints)).toEqual(
      changes({ devices: ['b', 'c'], reviews: 3 })
    );
  });

  it('property: counts a row as written elsewhere since exactly when its stamp is another device’s, past what the footprint saw of that device', async () => {
    const devices = ['a', 'b', 'c', ''];
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(fc.constantFrom('a', 'b', 'c'), fc.integer({ min: 1 })),
        fc.array(
          fc.record({
            by: fc.constantFrom(...devices),
            at: fc.integer({ min: 1 }),
            undone: fc.boolean(),
          }),
          { maxLength: 5 }
        ),
        async (seen, stamps) => {
          const a = await makeDevice('a', { now: T });
          await insertCard(a, 'c');
          const footprint = {
            ...(await footprintOf(a, 'srs_card', 'c')),
            seen,
          };
          for (const [i, { by, at, undone }] of stamps.entries()) {
            // A statement that sets its own stamp keeps it
            await write(
              a,
              `INSERT INTO srs_card_review (id, card_id, due, review,
                 stability, difficulty, elapsed_days, last_elapsed_days,
                 scheduled_days, rating, state, deleted, updated_at,
                 updated_by)
               VALUES ($1, 'c', 0, 0, 1, 1, 0, 0, 1, 3, 1, $2, $3, $4)`,
              [`g${i}`, undone, at, by]
            );
          }

          const counted = stamps.filter(
            ({ by, at, undone }) =>
              !undone &&
              by !== 'a' &&
              by !== '' &&
              !(by in seen && at <= seen[by])
          );
          expect(await changesSince(a.repo, [footprint])).toEqual(
            counted.length === 0
              ? null
              : changes({
                  devices: [...new Set(counted.map(({ by }) => by))].sort(),
                  grades: counted.length,
                })
          );
        }
      ),
      { numRuns: 40 }
    );
  });
});

describe('takeFootprint', () => {
  it('is null where the repository keeps no write stamps', async () => {
    // A database without the table, as the stub of a fake repository is
    expect(
      await takeFootprint(
        FakeRepository.create(new FakeVault()),
        'snippet',
        's'
      )
    ).toBeNull();
    const a = await makeDevice('a', { now: T });
    await insertSnippet(a, 's');
    const query: SQLiteRepository['query'] = (sql, params) =>
      a.repo.query(sql, params);

    expect(await takeFootprint({ query }, 'snippet', 's')).toBeNull();
    expect(
      await takeFootprint({ query, writeStamp: () => null }, 'snippet', 's')
    ).toBeNull();
  });

  it('is null for an item that is gone or deleted for good', async () => {
    const a = await makeDevice('a', { now: T });
    await insertSnippet(a, 'purged');
    await write(a, 'UPDATE snippet SET reference = $1 WHERE id = $2', [
      purgedReference('purged'),
      'purged',
    ]);

    expect(await takeFootprint(a.repo, 'snippet', 'purged')).toBeNull();
    expect(await takeFootprint(a.repo, 'snippet', 'missing')).toBeNull();
  });

  it('notes this device, what the database had seen and the row as it was', async () => {
    const a = await makeDevice('a', { now: T });
    await insertArticle(a, 'x');

    const footprint = await footprintOf(a, 'article', 'x');

    expect(footprint).toEqual({
      table: 'article',
      id: 'x',
      device: 'a',
      seen: a.repo.writeStamp()!.seen,
      snapshot: {
        priority: 30,
        fixed_interval_days: null,
        dismissed: 0,
        deleted: 0,
      },
    });
    expect(footprint.seen.a).toBeGreaterThan(0);
  });
});

describe('describeChanges and changedWhere', () => {
  it('property: says each kind of change once with its count, in the singular for one, after the item edits', () => {
    const kinds = [
      ['reviews', /\b(\d+) review(s?)\b/],
      ['grades', /\bgrade\w* (\d+) time(s?)\b/],
    ] as const;
    fc.assert(
      fc.property(
        fc.record({
          reviews: fc.nat(5),
          grades: fc.nat(5),
          relinked: fc.boolean(),
          edits: fc.subarray([
            'dismissed',
            'moved to the trash',
            'priority changed',
            'edited',
          ] as const),
        }),
        (counts) => {
          const said = describeChanges(changes(counts));

          const kindsSaid = kinds.filter(([key]) => counts[key] > 0);
          expect(said).toHaveLength(
            counts.edits.length + kindsSaid.length + (counts.relinked ? 1 : 0)
          );
          expect(said.slice(0, counts.edits.length)).toEqual(counts.edits);
          for (const [key, pattern] of kinds) {
            const matches = said.flatMap((phrase) => {
              const match = pattern.exec(phrase);
              return match ? [match] : [];
            });
            if (counts[key] === 0) {
              expect(matches).toEqual([]);
              continue;
            }
            expect(matches).toHaveLength(1);
            const [, count, plural] = matches[0];
            expect(Number(count)).toBe(counts[key]);
            expect(plural).toBe(counts[key] === 1 ? '' : 's');
          }
        }
      )
    );
  });

  it('says one other device, or how many', () => {
    expect(changedWhere(changes({ devices: ['b'] }))).toMatch(/\banother\b/);
    expect(changedWhere(changes({ devices: ['b', 'c', 'd'] }))).toMatch(
      /\b3 other devices\b/
    );
  });
});

describe('sameChanges', () => {
  it('tells apart changes that differ in anything', () => {
    const base = changes({ reviews: 1 });
    expect(sameChanges(base, changes({ reviews: 1 }))).toBe(true);
    expect(sameChanges(null, null)).toBe(true);
    expect(sameChanges(base, null)).toBe(false);
    expect(sameChanges(base, changes({ reviews: 2 }))).toBe(false);
    expect(sameChanges(base, changes({ reviews: 1, devices: ['c'] }))).toBe(
      false
    );
  });
});
