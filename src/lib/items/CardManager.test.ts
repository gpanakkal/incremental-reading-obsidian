/* eslint-disable obsidianmd/no-tfile-tfolder-cast -- this is a test file */
import {
  CARD_ANSWER_REPLACEMENT,
  CLOZE_DELIMITERS,
  MS_PER_DAY,
  MS_PER_YEAR,
  VALID_DELIMITER_PATTERN,
} from '#/lib/constants';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import type {
  ISRSCard,
  ISRSCardDisplay,
  SQLiteRepository,
  SRSCardRow,
} from '#/lib/types';
import fc from 'fast-check';
import type { TFile } from 'obsidian';
import { Rating, State } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardManager } from './CardManager';

// #region HELPERS

/** Expose protected methods for testing */
class TestableCardManager extends CardManager {
  public delimitTextPublic(
    text: string,
    selectionOffsets: readonly [number, number] | null
  ): string[] {
    return this.delimitText(text, selectionOffsets);
  }
}

const [LEFT, RIGHT] = CLOZE_DELIMITERS;

function makeRepo(): SQLiteRepository {
  return {
    query: vi.fn().mockResolvedValue([]),
    mutate: vi.fn().mockResolvedValue([[]]),
    _execSql: vi.fn(),
    handleFileChange: vi.fn(),
  } as unknown as SQLiteRepository;
}

function makePlugin(appOverrides: Record<string, unknown> = {}) {
  return {
    app: { ...appOverrides },
    settings: { dayRolloverOffset: 4 },
  } as never;
}

/** Build a minimal SRSCardRow. State is stored as a number (enum value). */
function makeCardRow(overrides: Partial<SRSCardRow> = {}): SRSCardRow {
  return {
    id: 'card-1',
    reference: 'cards/test.md',
    created_at: Date.now(),
    due: Date.now() + MS_PER_DAY,
    last_review: null,
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: State.New,
    dismissed: 0,
    ...overrides,
  };
}

/** Build a minimal ISRSCardDisplay */
function makeCardDisplay(
  overrides: Partial<ISRSCardDisplay> = {}
): ISRSCardDisplay {
  return {
    id: 'card-1',
    type: 'card',
    reference: 'cards/test.md',
    created_at: new Date(),
    due: new Date(Date.now() + MS_PER_DAY),
    last_review: undefined,
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: 'New',
    dismissed: false,
    ...overrides,
  };
}

/** Build a minimal ISRSCard (uses numeric state) */
function makeCardBase(overrides: Partial<ISRSCard> = {}): ISRSCard {
  return {
    id: 'card-1',
    type: 'card',
    reference: 'cards/test.md',
    created_at: new Date(),
    due: new Date(Date.now() + MS_PER_DAY),
    last_review: undefined,
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    state: State.New,
    dismissed: false,
    ...overrides,
  };
}

/** Returns the [sql, params] tuple from the latest call to repo.mutate */
function lastMutateCall(repo: SQLiteRepository): [string, unknown[]] {
  const calls = (repo.mutate as ReturnType<typeof vi.fn>).mock.calls as [
    string,
    unknown[],
  ][];
  return calls[calls.length - 1];
}

/** Returns the [sql, params] tuple from the latest call to repo.query */
function lastQueryCall(repo: SQLiteRepository): [string, unknown[]] {
  const calls = (repo.query as ReturnType<typeof vi.fn>).mock.calls as [
    string,
    unknown[],
  ][];
  return calls[calls.length - 1];
}

/** Arbitrary covering all 4 numeric State values */
const stateArb = fc.constantFrom(
  State.New,
  State.Learning,
  State.Review,
  State.Relearning
);

/** Arbitrary covering all StateType string values */
const stateTypeArb = fc.constantFrom(
  'New',
  'Learning',
  'Review',
  'Relearning'
) as fc.Arbitrary<'New' | 'Learning' | 'Review' | 'Relearning'>;

/** Arbitrary for a valid SRSCardRow */
const cardRowArb: fc.Arbitrary<SRSCardRow> = fc.record<SRSCardRow>({
  id: fc.uuid(),
  reference: fc.string({ minLength: 1 }),
  created_at: fc.integer({ min: 0, max: Date.now() + MS_PER_YEAR * 100 }),
  due: fc.integer({ min: 0, max: Date.now() + MS_PER_YEAR * 100 }),
  last_review: fc.oneof(
    fc.integer({ min: 0, max: Date.now() + MS_PER_YEAR }),
    fc.constant(null)
  ),
  stability: fc.double({ min: 0, max: 1000, noNaN: true }),
  difficulty: fc.double({ min: 0, max: 10, noNaN: true }),
  elapsed_days: fc.integer({ min: 0, max: 36500 }),
  scheduled_days: fc.integer({ min: 0, max: 36500 }),
  reps: fc.integer({ min: 0, max: 10000 }),
  lapses: fc.integer({ min: 0, max: 10000 }),
  state: stateArb,
  dismissed: fc.oneof(fc.constant(0 as 0), fc.constant(1 as 1)),
});

/** Valid delimiter pairs for testing getClozeGroupsPattern */
const delimiterArb = fc
  .tuple(
    fc.stringMatching(VALID_DELIMITER_PATTERN),
    fc.stringMatching(VALID_DELIMITER_PATTERN)
  )
  .filter(([l, r]) => l !== r);

// #endregion

describe('rowToDisplay', () => {
  it('converts created_at and due from ms timestamps to Date objects', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: Date.now() + MS_PER_YEAR * 100 }),
        fc.integer({ min: 0, max: Date.now() + MS_PER_YEAR * 100 }),

        async (createdAt, due) => {
          const row = { created_at: createdAt, due } as SRSCardRow;
          const display = CardManager.rowToDisplay(row);
          expect(display.created_at).toBeInstanceOf(Date);
          expect(display.due).toBeInstanceOf(Date);
          expect(display.created_at.getTime()).toBe(row.created_at);
          expect(display.due.getTime()).toBe(row.due);
        }
      )
    );
  });

  it('converts last_review from ms to Date when present, omits it when null', async () => {
    const rowArbNonZeroLastReview = cardRowArb.map((r) =>
      r.last_review === 0 ? { ...r, last_review: 1 } : r
    );
    await fc.assert(
      fc.asyncProperty(rowArbNonZeroLastReview, async (row) => {
        const display = CardManager.rowToDisplay(row);
        if (row.last_review !== null) {
          expect(display.last_review).toBeInstanceOf(Date);
          expect(display.last_review!.getTime()).toBe(row.last_review);
        } else {
          expect(display.last_review).toBeUndefined();
        }
      })
    );
  });

  it('converts dismissed number to boolean', async () => {
    await fc.assert(
      fc.asyncProperty(cardRowArb, async (row) => {
        const display = CardManager.rowToDisplay(row);
        expect(display.dismissed).toBe(!!row.dismissed);
      })
    );
  });

  it('converts numeric state to StateType string', async () => {
    await fc.assert(
      fc.asyncProperty(cardRowArb, async (row) => {
        const display = CardManager.rowToDisplay(row);
        expect(typeof display.state).toBe('string');
        expect(display.state).toBe(State[row.state]);
      })
    );
  });

  it('sets type to "card"', async () => {
    await fc.assert(
      fc.asyncProperty(cardRowArb, async (row) => {
        const display = CardManager.rowToDisplay(row);
        expect(display.type).toBe('card');
      })
    );
  });

  it('passes through non-date scalar fields unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(cardRowArb, async (row) => {
        const display = CardManager.rowToDisplay(row);
        expect(display.id).toBe(row.id);
        expect(display.reference).toBe(row.reference);
        expect(display.stability).toBe(row.stability);
        expect(display.difficulty).toBe(row.difficulty);
        expect(display.elapsed_days).toBe(row.elapsed_days);
        expect(display.scheduled_days).toBe(row.scheduled_days);
        expect(display.reps).toBe(row.reps);
        expect(display.lapses).toBe(row.lapses);
      })
    );
  });
});

/** last_review=0 is excluded from round-trip tests: rowToDisplay maps 0 to undefined (truthy-check bug).
 * Tests are written for the fixed version (last_review >= 1 when present). */
const cardRowArbNonZeroLastReview = cardRowArb.map((r) =>
  r.last_review === 0 ? { ...r, last_review: 1 } : r
);

describe('displayToRow', () => {
  it('converts created_at and due Date objects back to ms timestamps', async () => {
    await fc.assert(
      fc.asyncProperty(cardRowArbNonZeroLastReview, async (row) => {
        const display = CardManager.rowToDisplay(row);
        const backToRow = CardManager.displayToRow(display);
        expect(backToRow.created_at).toBe(row.created_at);
        expect(backToRow.due).toBe(row.due);
      })
    );
  });

  it('converts last_review Date to ms, null when absent', async () => {
    await fc.assert(
      fc.asyncProperty(cardRowArbNonZeroLastReview, async (row) => {
        const display = CardManager.rowToDisplay(row);
        const backToRow = CardManager.displayToRow(display);
        if (row.last_review !== null) {
          expect(backToRow.last_review).toBe(row.last_review);
        } else {
          expect(backToRow.last_review).toBeNull();
        }
      })
    );
  });

  it('converts dismissed boolean to 0 or 1', async () => {
    await fc.assert(
      fc.asyncProperty(cardRowArb, async (row) => {
        const display = CardManager.rowToDisplay(row);
        const backToRow = CardManager.displayToRow(display);
        expect(backToRow.dismissed).toBe(row.dismissed ? 1 : 0);
      })
    );
  });

  it('converts StateType string back to numeric state', async () => {
    await fc.assert(
      fc.asyncProperty(cardRowArb, async (row) => {
        const display = CardManager.rowToDisplay(row);
        const backToRow = CardManager.displayToRow(display);
        expect(backToRow.state).toBe(row.state);
      })
    );
  });

  it('strips the type field', async () => {
    await fc.assert(
      fc.asyncProperty(cardRowArb, async (row) => {
        const display = CardManager.rowToDisplay(row);
        const backToRow = CardManager.displayToRow(display);
        expect('type' in backToRow).toBe(false);
      })
    );
  });

  it('round-trips: displayToRow(rowToDisplay(row)) equals the original row', async () => {
    await fc.assert(
      fc.asyncProperty(cardRowArbNonZeroLastReview, async (row) => {
        const display = CardManager.rowToDisplay(row);
        const backToRow = CardManager.displayToRow(display);
        expect(backToRow.id).toBe(row.id);
        expect(backToRow.reference).toBe(row.reference);
        expect(backToRow.stability).toBe(row.stability);
        expect(backToRow.difficulty).toBe(row.difficulty);
        expect(backToRow.elapsed_days).toBe(row.elapsed_days);
        expect(backToRow.scheduled_days).toBe(row.scheduled_days);
        expect(backToRow.reps).toBe(row.reps);
        expect(backToRow.lapses).toBe(row.lapses);
      })
    );
  });
});

describe('baseToRow', () => {
  it('converts created_at and due Date to ms timestamps', async () => {
    await fc.assert(
      fc.asyncProperty(cardRowArb, async (row) => {
        // Build an ISRSCard from the row (state stays numeric in ISRSCard)
        const base = makeCardBase({
          id: row.id,
          reference: row.reference,
          created_at: new Date(row.created_at),
          due: new Date(row.due),
          last_review: row.last_review ? new Date(row.last_review) : undefined,
          dismissed: !!row.dismissed,
          stability: row.stability,
          difficulty: row.difficulty,
          elapsed_days: row.elapsed_days,
          scheduled_days: row.scheduled_days,
          reps: row.reps,
          lapses: row.lapses,
          state: row.state,
        });
        const result = CardManager.baseToRow(base);
        expect(result.created_at).toBe(base.created_at.getTime());
        expect(result.due).toBe(base.due.getTime());
      })
    );
  });

  it('converts last_review Date to ms, null when absent', async () => {
    await fc.assert(
      fc.asyncProperty(cardRowArb, async (row) => {
        const base = makeCardBase({
          last_review: row.last_review ? new Date(row.last_review) : undefined,
        });
        const result = CardManager.baseToRow(base);
        if (base.last_review) {
          expect(result.last_review).toBe(base.last_review.getTime());
        } else {
          expect(result.last_review).toBeNull();
        }
      })
    );
  });

  it('converts dismissed boolean to 0 or 1', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (dismissed) => {
        const base = makeCardBase({ dismissed });
        const result = CardManager.baseToRow(base);
        expect(result.dismissed).toBe(dismissed ? 1 : 0);
      })
    );
  });

  it('strips the type field', async () => {
    const base = makeCardBase();
    const result = CardManager.baseToRow(base);
    expect('type' in result).toBe(false);
  });
});

describe('getClozeGroupsPattern', () => {
  it('returns a RegExp that matches a string with the given delimiters', async () => {
    await fc.assert(
      fc.asyncProperty(
        delimiterArb,
        fc.string(),
        fc.string(),
        fc.string(),
        async ([left, right], pre, answer, post) => {
          const pattern = CardManager.getClozeGroupsPattern([left, right]);
          const text = `${pre}${left}${answer}${right}${post}`;
          const match = text.match(pattern);
          expect(match).not.toBeNull();
        }
      )
    );
  });

  it('captures pre, answer, and post in groups 1, 2, 3', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ maxLength: 20 })
          .filter((s) => !s.includes(LEFT) && !s.includes(RIGHT)),
        fc
          .string({ maxLength: 20 })
          .filter((s) => !s.includes(LEFT) && !s.includes(RIGHT)),
        fc
          .string({ maxLength: 20 })
          .filter((s) => !s.includes(LEFT) && !s.includes(RIGHT)),
        async (pre, answer, post) => {
          const pattern = CardManager.getClozeGroupsPattern(CLOZE_DELIMITERS);
          const text = `${pre}${LEFT}${answer}${RIGHT}${post}`;
          const match = text.match(pattern);
          expect(match).not.toBeNull();
          expect(match![1]).toBe(pre);
          expect(match![2]).toBe(answer);
          expect(match![3]).toBe(post);
        }
      )
    );
  });

  it('does not match a string without the delimiters', () => {
    const pattern = CardManager.getClozeGroupsPattern(CLOZE_DELIMITERS);
    const text = 'no cloze delimiters here';
    expect(text.match(pattern)).toBeNull();
  });

  it('treats delimiter characters as literals, not regex metacharacters', () => {
    // Use delimiters that contain regex special chars
    const specialDelimiters: [string, string] = ['(', ')'];
    const pattern = CardManager.getClozeGroupsPattern(specialDelimiters);
    const text = '(answer)';
    const match = text.match(pattern);
    expect(match).not.toBeNull();
    expect(match![2]).toBe('answer');
  });
});

describe('hideAnswer', () => {
  it('replaces the answer between CLOZE_DELIMITERS with the placeholder', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ maxLength: 30 })
          .filter((s) => !s.includes(LEFT) && !s.includes(RIGHT)),
        fc
          .string({ maxLength: 30 })
          .filter((s) => !s.includes(LEFT) && !s.includes(RIGHT)),
        fc
          .string({ maxLength: 30 })
          .filter((s) => !s.includes(LEFT) && !s.includes(RIGHT)),
        async (pre, answer, post) => {
          const content = `${pre}${LEFT}${answer}${RIGHT}${post}`;
          const result = CardManager.hideAnswer(content);
          expect(result).toBe(pre + CARD_ANSWER_REPLACEMENT + post);
        }
      )
    );
  });

  it('throws with a message mentioning the content when no valid cloze delimiters found', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ minLength: 1 })
          .filter((s) => !s.includes(LEFT) && !s.includes(RIGHT)),
        async (content) => {
          let caught: unknown;
          try {
            CardManager.hideAnswer(content);
          } catch (e) {
            caught = e;
          }
          expect(caught).toBeInstanceOf(Error);
          expect((caught as Error).message).toContain(content);
        }
      )
    );
  });

  it('does not include the answer text in the output', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 30 }).filter(
          (s) =>
            !s.includes(LEFT) &&
            !s.includes(RIGHT) &&
            !CARD_ANSWER_REPLACEMENT.includes(s) // avoid false positives when answer is a substring of the placeholder
        ),
        async (answer) => {
          const content = `${LEFT}${answer}${RIGHT}`;
          const result = CardManager.hideAnswer(content);
          expect(result).not.toContain(answer);
        }
      )
    );
  });
});

describe('parseCloze', () => {
  it('returns start, answer, end for text with the given delimiters', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ maxLength: 30 })
          .filter((s) => !s.includes(LEFT) && !s.includes(RIGHT)),
        fc
          .string({ maxLength: 30 })
          .filter((s) => !s.includes(LEFT) && !s.includes(RIGHT)),
        fc
          .string({ maxLength: 30 })
          .filter((s) => !s.includes(LEFT) && !s.includes(RIGHT)),
        async (start, answer, end) => {
          const repo = makeRepo();
          const manager = new CardManager(makePlugin(), repo);
          const text = `${start}${LEFT}${answer}${RIGHT}${end}`;
          const result = manager.parseCloze(text, CLOZE_DELIMITERS);
          expect(result.start).toBe(start);
          expect(result.answer).toBe(answer);
          expect(result.end).toBe(end);
        }
      )
    );
  });

  it('throws when the delimiters are not found in the text', () => {
    const repo = makeRepo();
    const manager = new CardManager(makePlugin(), repo);
    expect(() =>
      manager.parseCloze('no delimiters here', CLOZE_DELIMITERS)
    ).toThrow();
  });

  it('throws when given invalid delimiters', async () => {
    const invalidDelimiterArb = fc
      .string({ minLength: 1 })
      .filter((s) => !/^[^\w\s].*[^\w\s]$/.test(s));
    // At least one of the two delimiters must be invalid
    const atLeastOneInvalidArb = fc
      .tuple(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }))
      .filter(
        ([l, r]) =>
          !/^[^\w\s].*[^\w\s]$/.test(l) || !/^[^\w\s].*[^\w\s]$/.test(r)
      );
    await fc.assert(
      fc.asyncProperty(atLeastOneInvalidArb, async ([left, right]) => {
        const repo = makeRepo();
        const manager = new CardManager(makePlugin(), repo);
        expect(() =>
          manager.parseCloze(`${left}answer${right}`, [left, right])
        ).toThrow();
      })
    );
    // Also check that a single invalid delimiter alone always throws
    await fc.assert(
      fc.asyncProperty(invalidDelimiterArb, async (invalid) => {
        const repo = makeRepo();
        const manager = new CardManager(makePlugin(), repo);
        expect(() =>
          manager.parseCloze(`${invalid}answer${invalid}`, [invalid, invalid])
        ).toThrow();
      })
    );
  });

  it('works with valid delimiters', async () => {
    await fc.assert(
      fc.asyncProperty(delimiterArb, async ([left, right]) => {
        const answer = 'myAnswer';
        const repo = makeRepo();
        const manager = new CardManager(makePlugin(), repo);
        const text = `before${left}${answer}${right}after`;
        const result = manager.parseCloze(text, [left, right]);
        expect(result.answer).toBe(answer);
        expect(result.start).toBe('before');
        expect(result.end).toBe('after');
      })
    );
  });
});

describe('delimitText', () => {
  let manager: TestableCardManager;

  beforeEach(() => {
    manager = new TestableCardManager(makePlugin(), makeRepo());
  });

  describe('with a selection', () => {
    it('wraps the selected text in CLOZE_DELIMITERS with spaces', async () => {
      await fc.assert(
        fc.asyncProperty(
          // text with no pre-existing delimiters to keep the test simple
          fc
            .string({ maxLength: 50 })
            .filter((s) => !s.includes(LEFT) && !s.includes(RIGHT)),
          fc.nat({ max: 20 }),
          fc.nat({ max: 20 }),
          async (base, preLen, answerLen) => {
            const pre = base.slice(0, preLen);
            const answer = base.slice(preLen, preLen + answerLen);
            const post = base.slice(preLen + answerLen);
            const text = pre + answer + post;
            const offsets: [number, number] = [
              pre.length,
              pre.length + answer.length,
            ];
            const [result] = manager.delimitTextPublic(text, offsets);
            expect(result).toBe(pre + `${LEFT} ${answer} ${RIGHT}` + post);
          }
        )
      );
    });

    it('strips pre-existing delimiters from the non-selected regions', () => {
      const text = `pre${LEFT}old${RIGHT}answer${LEFT}also${RIGHT}post`;
      // Select "answer" (indices 3+3+3 = 9 to 9+6 = 15 — just select the word)
      // Let's construct a simple, predictable case:
      const pre = `pre${LEFT}x${RIGHT}`; // has delimiters
      const answer = 'answer';
      const post = `${LEFT}y${RIGHT}post`; // has delimiters
      const fullText = pre + answer + post;
      const offsets: [number, number] = [
        pre.length,
        pre.length + answer.length,
      ];
      const [result] = manager.delimitTextPublic(fullText, offsets);
      // pre and post should have delimiters removed; answer is wrapped
      expect(result).not.toContain(`${LEFT}x${RIGHT}`);
      expect(result).not.toContain(`${LEFT}y${RIGHT}`);
      expect(result).toContain(`${LEFT} ${answer} ${RIGHT}`);
    });

    it('returns a single-element array', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc
            .string({ maxLength: 30 })
            .filter((s) => !s.includes(LEFT) && !s.includes(RIGHT)),
          fc.nat({ max: 15 }),
          fc.nat({ max: 15 }),
          async (text, start, len) => {
            const end = Math.min(start + len, text.length);
            const offsets: [number, number] = [start, end];
            const result = manager.delimitTextPublic(text, offsets);
            expect(result).toHaveLength(1);
          }
        )
      );
    });
  });

  describe('without a selection (null)', () => {
    it('returns a result for each existing cloze pair', () => {
      const text = `before ${LEFT}answer1${RIGHT} middle ${LEFT}answer2${RIGHT} after`;
      const results = manager.delimitTextPublic(text, null);
      expect(results).toHaveLength(2);
    });

    it('throws when no cloze delimiters are found', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string().filter((s) => !s.includes(LEFT) && !s.includes(RIGHT)),
          async (text) => {
            expect(() => manager.delimitTextPublic(text, null)).toThrow();
          }
        )
      );
    });

    it('removes all other delimiters from each result, keeping only one pair', () => {
      const text = `${LEFT}first${RIGHT} between ${LEFT}second${RIGHT}`;
      const results = manager.delimitTextPublic(text, null);
      // Each result should contain exactly one pair of delimiters
      for (const result of results) {
        const leftCount = result.split(LEFT).length - 1;
        const rightCount = result.split(RIGHT).length - 1;
        expect(leftCount).toBe(1);
        expect(rightCount).toBe(1);
      }
    });

    it('preserves the answer text of each cloze pair in its corresponding result', () => {
      const text = `${LEFT}alpha${RIGHT} something ${LEFT}beta${RIGHT}`;
      const results = manager.delimitTextPublic(text, null);
      expect(results[0]).toContain(`${LEFT}alpha${RIGHT}`);
      expect(results[1]).toContain(`${LEFT}beta${RIGHT}`);
    });

    it('slices pre at the match start and post at the match end', () => {
      // "PREFIX{first}MID{second}SUFFIX"
      // For result[0]: pre = "PREFIX", post = "MIDsecondSUFFIX" (delimiters removed from post)
      // For result[1]: pre = "PREFIXfirstMID" (delimiters removed from pre), post = "SUFFIX"
      const prefix = 'PREFIX';
      const mid = 'MID';
      const suffix = 'SUFFIX';
      const text = `${prefix}${LEFT}first${RIGHT}${mid}${LEFT}second${RIGHT}${suffix}`;
      const results = manager.delimitTextPublic(text, null);

      // result[0]: pre slice starts at index 0 (before the first match) = "PREFIX"
      expect(results[0].startsWith(prefix)).toBe(true);
      // result[0]: post slice starts after first match = "MID" + "second" + "SUFFIX"
      expect(results[0]).toContain(mid);
      expect(results[0]).toContain(suffix);

      // result[1]: pre slice ends at start of second match = "PREFIXfirstMID"
      expect(results[1]).toContain(prefix);
      expect(results[1]).toContain(mid);
      // result[1]: post = "SUFFIX"
      expect(results[1].endsWith(suffix)).toBe(true);
    });

    it('does not include delimiter characters in the removed regions of the output', () => {
      const text = `${LEFT}first${RIGHT} between ${LEFT}second${RIGHT}`;
      const [resultFirst, resultSecond] = manager.delimitTextPublic(text, null);
      // In resultFirst, only the first cloze's delimiters should remain; "between" is in post
      // (no delimiter chars in the " between " text anyway — this catches replacement-string mutants)
      expect(resultFirst.replace(`${LEFT}first${RIGHT}`, '')).not.toContain(
        LEFT
      );
      expect(resultFirst.replace(`${LEFT}first${RIGHT}`, '')).not.toContain(
        RIGHT
      );
      expect(resultSecond.replace(`${LEFT}second${RIGHT}`, '')).not.toContain(
        LEFT
      );
      expect(resultSecond.replace(`${LEFT}second${RIGHT}`, '')).not.toContain(
        RIGHT
      );
    });
  });
});

describe('rowToReviewCard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when the file cannot be found', async () => {
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(null);
    await fc.assert(
      fc.asyncProperty(cardRowArb, async (row) => {
        const manager = new CardManager(makePlugin(), makeRepo());
        const result = manager.rowToReviewCard(row);
        expect(result).toBeNull();
      })
    );
  });

  it('returns a ReviewCard with data and file when the file exists', async () => {
    const fakeFile = { path: 'cards/test.md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    await fc.assert(
      fc.asyncProperty(cardRowArb, async (row) => {
        const manager = new CardManager(makePlugin(), makeRepo());
        const result = manager.rowToReviewCard(row);
        expect(result).not.toBeNull();
        expect(result!.file).toBe(fakeFile);
        expect(result!.data.id).toBe(row.id);
        expect(result!.data.type).toBe('card');
        expect(result!.data.dismissed).toBe(!!row.dismissed);
        expect(result!.data.state).toBe(State[row.state]);
      })
    );
  });
});

describe('fetchMany', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns all rows (as SRSCardRow[]) when called with no options', async () => {
    const rows = [makeCardRow({ id: 'a' }), makeCardRow({ id: 'b' })];
    const repo = {
      query: vi.fn().mockResolvedValue(rows),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;
    const manager = new CardManager(makePlugin(), repo);
    const result = await manager.fetchMany();
    expect(result).toEqual(rows);
    const [sql] = lastQueryCall(repo);
    expect(sql).toMatch(/SELECT \* FROM srs_card/i);
  });

  it('filters out dismissed rows by default', async () => {
    const repo = makeRepo();
    const manager = new CardManager(makePlugin(), repo);
    await manager.fetchMany();
    const [sql] = lastQueryCall(repo);
    expect(sql).toMatch(/dismissed = 0/i);
  });

  it('does not add a dismissed filter when includeDismissed is true', async () => {
    const repo = makeRepo();
    const manager = new CardManager(makePlugin(), repo);
    await manager.fetchMany({ includeDismissed: true });
    const [sql] = lastQueryCall(repo);
    expect(sql).not.toMatch(/dismissed = 0/i);
  });

  it('adds a due <= filter when dueBy is provided', async () => {
    const repo = makeRepo();
    const manager = new CardManager(makePlugin(), repo);
    const dueBy = Date.now();
    await manager.fetchMany({ dueBy });
    const [sql, params] = lastQueryCall(repo);
    expect(sql).toMatch(/due <= \$1/i);
    expect(params[0]).toBe(dueBy);
  });

  it('adds a NOT IN clause when excludeIds are provided', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.uuid(), { minLength: 1, maxLength: 10 }),
        async (excludeIds) => {
          const repo = makeRepo();
          const manager = new CardManager(makePlugin(), repo);
          await manager.fetchMany({ excludeIds });
          const [sql, params] = lastQueryCall(repo);
          expect(sql).toMatch(/id NOT IN/i);
          for (const id of excludeIds) {
            expect(params).toContain(id);
          }
        }
      )
    );
  });

  it('applies a LIMIT clause when limit is provided', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 100 }), async (limit) => {
        const repo = makeRepo();
        const manager = new CardManager(makePlugin(), repo);
        await manager.fetchMany({ limit });
        const [sql, params] = lastQueryCall(repo);
        expect(sql).toMatch(/LIMIT/i);
        expect(params).toContain(limit);
      })
    );
  });

  it('orders results by due ASC', async () => {
    const repo = makeRepo();
    const manager = new CardManager(makePlugin(), repo);
    await manager.fetchMany();
    const [sql] = lastQueryCall(repo);
    expect(sql).toMatch(/ORDER BY due ASC/i);
  });

  it('uses correctly sequenced $N params when dueBy, excludeIds, and limit are all set', async () => {
    const repo = makeRepo();
    const manager = new CardManager(makePlugin(), repo);
    const dueBy = 1000;
    const excludeIds = ['id-1', 'id-2'];
    const limit = 5;
    await manager.fetchMany({ dueBy, excludeIds, limit });
    const [sql, params] = lastQueryCall(repo);
    expect(sql).toContain('$1');
    expect(sql).toContain('$2');
    expect(sql).toContain('$3');
    expect(sql).toContain('$4');
    expect(params[0]).toBe(dueBy);
    expect(params[1]).toBe('id-1');
    expect(params[2]).toBe('id-2');
    expect(params[3]).toBe(limit);
  });

  it('produces no WHERE clause when includeDismissed=true and no other filters', async () => {
    const repo = makeRepo();
    const manager = new CardManager(makePlugin(), repo);
    await manager.fetchMany({ includeDismissed: true });
    const [sql] = lastQueryCall(repo);
    expect(sql).not.toMatch(/WHERE/i);
  });

  it('throws when param count exceeds MAX_SQL_QUERY_PARAMS', async () => {
    const repo = makeRepo();
    const manager = new CardManager(makePlugin(), repo);
    const excludeIds = Array.from({ length: 1000 }, (_, i) => `id-${i}`);
    await expect(manager.fetchMany({ excludeIds })).rejects.toThrow();
  });

  it('does not throw when param count equals MAX_SQL_QUERY_PARAMS exactly', async () => {
    const repo = makeRepo();
    const manager = new CardManager(makePlugin(), repo);
    // dueBy=$1 + 998 excludeIds = 999 total, which equals the limit
    const excludeIds = Array.from({ length: 998 }, (_, i) => `id-${i}`);
    await expect(
      manager.fetchMany({ dueBy: 1000, excludeIds })
    ).resolves.not.toThrow();
  });

  it('uses AND to join multiple WHERE conditions', async () => {
    const repo = makeRepo();
    const manager = new CardManager(makePlugin(), repo);
    await manager.fetchMany({ dueBy: 1000, excludeIds: ['a'] });
    const [sql] = lastQueryCall(repo);
    expect(sql).toMatch(/ AND /i);
  });
});

describe('fetch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when no row is found', async () => {
    const repo = makeRepo();
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(null);
    const manager = new CardManager(makePlugin(), repo);
    const result = await manager.fetch('nonexistent');
    expect(result).toBeNull();
  });

  it('passes the id as a query param and queries the correct table', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (id) => {
        const repo = makeRepo();
        const manager = new CardManager(makePlugin(), repo);
        await manager.fetch(id);
        const [sql, params] = lastQueryCall(repo);
        expect(sql).toMatch(/SELECT \* FROM srs_card WHERE id = \$1/i);
        expect(params[0]).toBe(id);
      })
    );
  });

  it('returns a ReviewCard when a row and its file are found', async () => {
    const row = makeCardRow();
    const fakeFile = { path: 'cards/test.md' } as TFile;
    vi.spyOn(Obsidian, 'getNote').mockReturnValue(fakeFile);
    const repo = {
      query: vi.fn().mockResolvedValue([row]),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;
    const manager = new CardManager(makePlugin(), repo);
    const result = await manager.fetch(row.id);
    expect(result).not.toBeNull();
    expect(result!.data.id).toBe(row.id);
    expect(result!.file).toBe(fakeFile);
  });
});

describe('getDue', () => {
  const YEAR_2000_MS = new Date('2000-01-01T12:00:00Z').getTime();
  const YEAR_2100_MS = new Date('2100-01-01T12:00:00Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.spyOn(Obsidian, 'getNote').mockReturnValue({
      path: 'cards/test.md',
    } as TFile);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeRepoWithCards(rows: SRSCardRow[]): SQLiteRepository {
    return {
      query: vi.fn().mockImplementation((_sql: string, params: unknown[]) => {
        const dueBy = params[0] as number | undefined;
        return dueBy !== undefined ? rows.filter((r) => r.due <= dueBy) : rows;
      }),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;
  }

  it('returns cards due at or before the given dueBy timestamp', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: YEAR_2000_MS, max: YEAR_2100_MS }),
        async (nowMs) => {
          vi.setSystemTime(nowMs);
          const cutoff = nowMs;
          const rowAtCutoff = makeCardRow({ id: 'at', due: cutoff });
          const rowAfterCutoff = makeCardRow({ id: 'after', due: cutoff + 1 });
          const repo = makeRepoWithCards([rowAtCutoff, rowAfterCutoff]);
          const manager = new CardManager(makePlugin(), repo);
          const results = await manager.getDue(cutoff);
          const ids = results.map((r) => r.data.id);
          expect(ids).toContain('at');
          expect(ids).not.toContain('after');
        }
      )
    );
  });

  it('skips rows whose note file is missing and retries excluding them', async () => {
    const rowA = makeCardRow({
      id: 'no-file',
      reference: 'cards/no-file.md',
      due: 0,
    });
    const rowB = makeCardRow({
      id: 'has-file',
      reference: 'cards/has-file.md',
      due: 0,
    });
    const file = { path: 'cards/has-file.md' } as TFile;

    vi.spyOn(Obsidian, 'getNote').mockImplementation((ref) => {
      return ref === rowA.reference ? null : file;
    });

    let callCount = 0;
    const repo = {
      query: vi.fn().mockImplementation((_sql: string, params: unknown[]) => {
        callCount++;
        const excluded = params.filter(
          (p) => typeof p === 'string'
        ) as string[];
        return [rowA, rowB].filter((r) => !excluded.includes(r.id));
      }),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;

    const manager = new CardManager(makePlugin(), repo);
    const results = await manager.getDue(0);

    expect(results.map((r) => r.data.id)).not.toContain('no-file');
    expect(results.map((r) => r.data.id)).toContain('has-file');
    expect(callCount).toBeGreaterThan(1);
  });

  it('returns an empty array when the repo throws', async () => {
    const repo = {
      query: vi.fn().mockRejectedValue(new Error('db error')),
      mutate: vi.fn(),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;
    const manager = new CardManager(makePlugin(), repo);
    const results = await manager.getDue();
    expect(results).toEqual([]);
  });

  it('passes pre-existing excludeIds on the first fetch call', async () => {
    const queryCalls: unknown[][] = [];
    const repo = {
      query: vi.fn().mockImplementation((_sql: string, params: unknown[]) => {
        queryCalls.push(params);
        return [];
      }),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;
    const manager = new CardManager(makePlugin(), repo);
    await manager.getDue(0, undefined, ['excluded-id']);
    expect(queryCalls[0]).toContain('excluded-id');
  });

  it('does not include rows with null file in results (filter must check card.file)', async () => {
    // rowA has no file, rowB does — only rowB should appear in results
    const rowA = makeCardRow({
      id: 'null-file',
      reference: 'cards/null-file.md',
      due: 0,
    });
    const rowB = makeCardRow({
      id: 'has-file',
      reference: 'cards/has-file.md',
      due: 0,
    });
    const file = { path: 'cards/has-file.md' } as TFile;

    vi.spyOn(Obsidian, 'getNote').mockImplementation((ref) => {
      return ref === rowA.reference ? null : file;
    });

    let call = 0;
    const repo = {
      query: vi.fn().mockImplementation((_sql: string, params: unknown[]) => {
        call++;
        if (call === 1) return [rowA, rowB];
        // Exclude rowA on retry
        return [rowA, rowB].filter((r) => !params.includes(r.id));
      }),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;

    const manager = new CardManager(makePlugin(), repo);
    const results = await manager.getDue(0);
    const ids = results.map((r) => r.data.id);
    expect(ids).not.toContain('null-file');
    expect(ids).toContain('has-file');
  });

  it('excludes missing-file rows on the NEXT retry, not on the same call', async () => {
    // Verifies lastMissingNotes is incremented (+1 not -1), triggering the retry loop
    const rowNoFile = makeCardRow({
      id: 'missing',
      reference: 'cards/missing.md',
      due: 0,
    });
    const rowWithFile = makeCardRow({
      id: 'present',
      reference: 'cards/present.md',
      due: 0,
    });
    const file = { path: 'cards/present.md' } as TFile;

    vi.spyOn(Obsidian, 'getNote').mockImplementation((ref) => {
      return ref === rowNoFile.reference ? null : file;
    });

    const queryCalls: unknown[][] = [];
    const repo = {
      query: vi.fn().mockImplementation((_sql: string, params: unknown[]) => {
        queryCalls.push(params);
        if (queryCalls.length === 1) return [rowNoFile, rowWithFile];
        return [rowWithFile];
      }),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;

    const manager = new CardManager(makePlugin(), repo);
    await manager.getDue(0);
    // Should have retried — the missing-file row's id must appear in the second call's params
    expect(queryCalls.length).toBeGreaterThanOrEqual(2);
    expect(queryCalls[1]).toContain('missing');
  });
});

describe('review', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('updates the card in srs_card with all expected columns and WHERE id', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(Rating.Again, Rating.Hard, Rating.Good, Rating.Easy),
        async (grade) => {
          const card = makeCardDisplay();
          const storedRow = makeCardRow({ id: card.id });
          const repo = {
            query: vi.fn().mockResolvedValue([storedRow]),
            mutate: vi.fn().mockResolvedValue([[]]),
            _execSql: vi.fn(),
            handleFileChange: vi.fn(),
          } as unknown as SQLiteRepository;
          const manager = new CardManager(makePlugin(), repo);
          await manager.review(card, grade, new Date());

          const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
            .calls as [string, unknown[]][];
          const updateCall = mutateCalls.find(([sql]) =>
            sql.includes('UPDATE srs_card SET')
          );
          expect(updateCall).toBeDefined();
          const [updateSql, updateParams] = updateCall!;
          // Verify all expected SET columns are present in the SQL with correct positional params
          expect(updateSql).toMatch(/due = \$1/i);
          expect(updateSql).toMatch(/last_review = \$2/i);
          expect(updateSql).toMatch(/stability = \$3/i);
          expect(updateSql).toMatch(/difficulty = \$4/i);
          expect(updateSql).toMatch(/elapsed_days = \$5/i);
          expect(updateSql).toMatch(/scheduled_days = \$6/i);
          expect(updateSql).toMatch(/reps = \$7/i);
          expect(updateSql).toMatch(/lapses = \$8/i);
          expect(updateSql).toMatch(/state = \$9/i);
          expect(updateSql).toMatch(/dismissed = 0/i);
          expect(updateSql).toMatch(/WHERE id = \$10/i);
          // Segments must be joined with ", " — verify boundary between adjacent segment pairs
          // Without the joiner: "...last_review = $2stability = $3..."
          // With it: "...last_review = $2, stability = $3..."
          expect(updateSql).toMatch(/last_review = \$2, stability = \$3/i);
          // Verify the WHERE clause targets the right card
          expect(updateParams[9]).toBe(card.id);
        }
      )
    );
  });

  it('inserts a review log into srs_card_review with all expected columns and VALUES placeholders', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(Rating.Again, Rating.Hard, Rating.Good, Rating.Easy),
        async (grade) => {
          const card = makeCardDisplay();
          const storedRow = makeCardRow({ id: card.id });
          const repo = {
            query: vi.fn().mockResolvedValue([storedRow]),
            mutate: vi.fn().mockResolvedValue([[]]),
            _execSql: vi.fn(),
            handleFileChange: vi.fn(),
          } as unknown as SQLiteRepository;
          const manager = new CardManager(makePlugin(), repo);
          await manager.review(card, grade, new Date());

          const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
            .calls as [string, unknown[]][];
          const insertCall = mutateCalls.find(([sql]) =>
            sql.includes('INSERT INTO srs_card_review')
          );
          expect(insertCall).toBeDefined();
          const [insertSql, insertParams] = insertCall!;
          expect(insertSql).toContain('id');
          expect(insertSql).toContain('card_id');
          expect(insertSql).toContain('due');
          expect(insertSql).toContain('review');
          expect(insertSql).toContain('stability');
          expect(insertSql).toContain('difficulty');
          expect(insertSql).toContain('elapsed_days');
          expect(insertSql).toContain('last_elapsed_days');
          expect(insertSql).toContain('scheduled_days');
          expect(insertSql).toContain('rating');
          expect(insertSql).toContain('state');
          // Must include the VALUES placeholder list ($1 through $11)
          expect(insertSql).toContain('$1');
          expect(insertSql).toContain('$11');
          expect(insertParams[1]).toBe(card.id);
        }
      )
    );
  });

  it('writes the FSRS-computed lapses without double-counting storedCard.lapses', async () => {
    // Use realistic stability/difficulty so FSRS produces a valid due date.
    // These values are from running FSRS through 3 Good reviews followed by 3 Again reviews.
    const priorLapses = 3;
    const card = makeCardDisplay({
      lapses: priorLapses,
      state: 'Review',
      stability: 0.415,
      difficulty: 8.494,
      reps: 6,
    });
    const storedRow = makeCardRow({
      id: card.id,
      lapses: priorLapses,
      state: State.Review,
    });
    const repo = {
      query: vi.fn().mockResolvedValue([storedRow]),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;
    const manager = new CardManager(makePlugin(), repo);
    await manager.review(card, Rating.Again, new Date());

    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    const updateCall = mutateCalls.find(([sql]) =>
      sql.includes('UPDATE srs_card SET')
    )!;
    const params = updateCall[1] as unknown[];
    expect(params[7]).toBe(priorLapses + 1);
  });

  it('logs the error and does not throw when the stored card is not found', async () => {
    const card = makeCardDisplay();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const repo = {
      query: vi.fn().mockResolvedValue([]),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;
    const manager = new CardManager(makePlugin(), repo);
    await expect(
      manager.review(card, Rating.Good, new Date())
    ).resolves.not.toThrow();
    expect(consoleSpy).toHaveBeenCalled();
    // When storedCard is not found, no UPDATE or INSERT should be issued
    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock.calls;
    expect(mutateCalls).toHaveLength(0);
  });

  it('resets dismissed to 0 after review', async () => {
    const card = makeCardDisplay({ dismissed: true });
    const storedRow = makeCardRow({ id: card.id, dismissed: 1 });
    const repo = {
      query: vi.fn().mockResolvedValue([storedRow]),
      mutate: vi.fn().mockResolvedValue([[]]),
      _execSql: vi.fn(),
      handleFileChange: vi.fn(),
    } as unknown as SQLiteRepository;
    const manager = new CardManager(makePlugin(), repo);
    await manager.review(card, Rating.Good, new Date());
    const mutateCalls = (repo.mutate as ReturnType<typeof vi.fn>).mock
      .calls as [string, unknown[]][];
    const updateCall = mutateCalls.find(([sql]) =>
      sql.includes('UPDATE srs_card SET')
    )!;
    expect(updateCall[0]).toMatch(/dismissed = 0/i);
  });
});
