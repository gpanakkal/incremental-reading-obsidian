import { CardManager } from '#/lib/items/CardManager';
import { phaseTiming } from '#/lib/repository/phase-timing';
import {
  initialCard,
  replayCard,
  type LoggedGrade,
} from '#/lib/repository/scheduling-replay';
import { generatorParameters, Rating, type Grade } from 'ts-fsrs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeSync, makeDevice, type FakeDevice } from './SimulationHarness';

/**
 * Benchmark of the incoming-file path (0184): two devices sharing a
 * realistically sized database each grade a different card, and one merges
 * the other's file. Slow and nondeterministic in its numbers, so it runs only
 * when asked for: `IR_BENCH=1 pnpm exec vitest run merge-performance
 * --reporter=verbose`, which prints the median time of each phase. Sized
 * by `IR_BENCH_SCALE`, `IR_BENCH_RUNS` and `IR_BENCH_APART` (see below).
 */

// #region HELPERS

const T = 1_790_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
/** How many times the realistic database to build: `IR_BENCH_SCALE`. */
const SCALE = Number(process.env.IR_BENCH_SCALE ?? 1);
const ARTICLES = 300 * SCALE;
const SNIPPETS = 300 * SCALE;
const CARDS = 500 * SCALE;
const ARTICLE_REVIEWS = 1200 * SCALE;
const SNIPPET_REVIEWS = 800 * SCALE;
const CARD_REVIEWS = 3000 * SCALE;
const PARAMS = generatorParameters();
/** How many merges to take the median of: `IR_BENCH_RUNS`. */
const RUNS = Number(process.env.IR_BENCH_RUNS ?? 5);
/** How many cards each device grades while apart: `IR_BENCH_APART`. */
const APART = Number(process.env.IR_BENCH_APART ?? 100);

const PLUGIN = {
  app: {},
  settings: {
    fuzzTextReviews: false,
    fsrsParams: PARAMS,
    dayRolloverOffset: 4,
  },
} as never;

/** A deterministic stream of numbers in [0, 1), so every run builds alike. */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

/**
 * Fill `device` with the items and review logs of a vault used for a while,
 * each card's schedule the replay of its log.
 */
async function populate(device: FakeDevice) {
  const random = seeded(7);
  const { repo } = device;
  await repo.transaction(() => {
    for (let i = 0; i < ARTICLES; i++) {
      repo.mutate(
        `INSERT INTO article (id, reference, due, interval, priority)
         VALUES ($1, $2, $3, $4, $5)`,
        [`a${i}`, `notes/a${i}.md`, T + i * 1000, DAY, 10 + (i % 41)]
      );
    }
    for (let i = 0; i < SNIPPETS; i++) {
      repo.mutate(
        `INSERT INTO snippet (id, reference, parent, due, interval, priority,
           start_offset, end_offset)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          `s${i}`,
          `snippets/s${i}.md`,
          `a${i % ARTICLES}`,
          T + i * 1000,
          DAY,
          10 + (i % 41),
          i,
          i + 50,
        ]
      );
    }
    for (let i = 0; i < ARTICLE_REVIEWS; i++) {
      repo.mutate(
        `INSERT INTO article_review (id, article_id, review_time)
         VALUES ($1, $2, $3)`,
        [`ar${i}`, `a${Math.floor(random() * ARTICLES)}`, T - i * 60_000]
      );
    }
    for (let i = 0; i < SNIPPET_REVIEWS; i++) {
      repo.mutate(
        `INSERT INTO snippet_review (id, snippet_id, review_time)
         VALUES ($1, $2, $3)`,
        [`sr${i}`, `s${Math.floor(random() * SNIPPETS)}`, T - i * 60_000]
      );
    }
    const logs: LoggedGrade[][] = Array.from({ length: CARDS }, () => []);
    for (let i = 0; i < CARD_REVIEWS; i++) {
      const card = Math.floor(random() * CARDS);
      logs[card].push({
        id: `cr${i}`,
        at: T - 200 * DAY + Math.floor((i * 199 * DAY) / CARD_REVIEWS),
        rating: 1 + Math.floor(random() * 4),
      });
    }
    for (let i = 0; i < CARDS; i++) {
      const createdAt = T - 400 * DAY + i * 1000;
      const schedule = replayCard(logs[i], PARAMS, initialCard(createdAt));
      repo.mutate(
        `INSERT INTO srs_card (id, reference, parent, created_at, due,
           last_review, stability, difficulty, elapsed_days, scheduled_days,
           learning_steps, reps, lapses, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          `c${i}`,
          `cards/c${i}.md`,
          `s${i % SNIPPETS}`,
          createdAt,
          schedule.due,
          schedule.last_review,
          schedule.stability,
          schedule.difficulty,
          schedule.elapsed_days,
          schedule.scheduled_days,
          schedule.learning_steps,
          schedule.reps,
          schedule.lapses,
          schedule.state,
        ]
      );
      for (const review of logs[i]) {
        repo.mutate(
          `INSERT INTO srs_card_review (id, card_id, due, review, stability,
             difficulty, elapsed_days, last_elapsed_days, scheduled_days,
             learning_steps, rating, state)
           VALUES ($1, $2, $3, $4, 1, 5, 1, 1, 1, 0, $5, 2)`,
          [review.id, `c${i}`, review.at, review.at, review.rating]
        );
      }
    }
  });
  await repo.settle();
}

/** Grade card `id` on `device` as the review tab does, at its time. */
async function gradeCard(device: FakeDevice, id: string, grade: Grade) {
  const [row] = device.repo.query('SELECT * FROM srs_card WHERE id = $1', [id]);
  await new CardManager(PLUGIN, device.repo).review(
    CardManager.rowToDisplay(row as never),
    grade,
    new Date(device.clock.now)
  );
  await device.repo.settle();
}

/** Two devices on one realistic database, each holding a save of both. */
async function sharedDevices(): Promise<[FakeDevice, FakeDevice]> {
  const sync = new FakeSync();
  const a = await makeDevice('a', { now: T });
  await populate(a);
  const bytes = a.vault.adapter.diskBytes(sync.dbFilePath)!;
  const b = await makeDevice('b', { now: T + 1000, bytes: bytes.slice(0) });
  b.repo.mutate('UPDATE article SET scroll_top = 5 WHERE id = $1', ['a0']);
  await b.repo.settle();
  await sync.deliver(b, a);
  return [a, b];
}

/**
 * Time `run`, phase by phase as the repository marks them (`phaseTiming`).
 * @returns the milliseconds each phase took, in the order they ended, a
 * phase marked more than once summed
 */
async function timePhases(run: () => Promise<unknown>) {
  const phases = new Map<string, number>();
  let last = performance.now();
  phaseTiming.mark = (phase) => {
    const now = performance.now();
    phases.set(phase, (phases.get(phase) ?? 0) + now - last);
    last = now;
  };
  const started = last;
  try {
    await run();
  } finally {
    phaseTiming.mark = null;
  }
  phases.set('rest', performance.now() - last);
  phases.set('total', performance.now() - started);
  return phases;
}

/** The median of each phase over `runs`, as a table to print. */
function medians(runs: Map<string, number>[]): string {
  const names = [...new Set(runs.flatMap((run) => [...run.keys()]))];
  return names
    .map((name) => {
      const times = runs.map((run) => run.get(name) ?? 0).sort((a, b) => a - b);
      const median = times[Math.floor(times.length / 2)];
      return `${name.padEnd(12)} ${median.toFixed(2).padStart(9)} ms`;
    })
    .join('\n');
}

// #endregion

describe.skipIf(!process.env.IR_BENCH)('merge benchmark', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    // The report: one review each, at the same time
    { scenario: 'one grade each', graded: 1 },
    // A day apart, each device grading cards of its own
    { scenario: 'a day apart', graded: APART },
  ])(
    'merges $scenario over a realistic database',
    async ({ graded }) => {
      const runs: Map<string, number>[] = [];
      for (let run = 0; run < RUNS; run++) {
        const sync = new FakeSync();
        const [a, b] = await sharedDevices();
        a.clock.now = T + 60_000;
        b.clock.now = T + 61_000;
        for (let i = 0; i < graded; i++) {
          await gradeCard(a, `c${i}`, Rating.Good);
          await gradeCard(b, `c${graded + i}`, Rating.Hard);
        }
        const writes = vi.spyOn(b.vault.adapter, 'writeBinary');

        runs.push(await timePhases(() => sync.deliver(a, b)));

        // A merge, not a take-over: every grade is in, saved once
        expect(runs[run].has('apply')).toBe(true);
        expect(writes).toHaveBeenCalledTimes(1);
        const grades = b.repo.query(
          `SELECT count(*) AS n FROM srs_card_review
         WHERE deleted = FALSE AND review > $1`,
          [T]
        ) as unknown as { n: number }[];
        expect(grades[0].n).toBe(2 * graded);
      }
      console.log(
        `${graded} graded each, scale ${SCALE}, median of ${RUNS} runs:\n` +
          medians(runs)
      );
    },
    120_000
  );
});
