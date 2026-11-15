import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  carryChecks,
  copyReviewPath,
  nextPatch,
  reportHeading,
  reportRange,
  uncheckedCount,
  unreviewedCount,
} from './copy-review.mjs';

// #region HELPERS
interface Entry {
  section: string;
  done: boolean;
  line: number;
  text: string;
  gone: boolean;
}

/** Text as the copy-diff report writes it: one line, no line break. */
const lineArb = fc.string().map((s) => s.replace(/[\r\n]/g, ' '));

const entryArb = fc.record({
  section: fc.constantFrom('src/a.ts', 'src/b.tsx'),
  done: fc.boolean(),
  line: fc.nat(2000),
  text: lineArb,
  gone: fc.boolean(),
});

/** A worksheet in the report's layout, sections in the order entries name them. */
function worksheet(entries: Entry[], header = '# UI copy changes\n') {
  const out = [header];
  let section = '';
  for (const e of entries) {
    if (e.section !== section) out.push(`### ${(section = e.section)}`, '');
    const at = e.gone
      ? `${e.section}:${e.line} (gone)`
      : `[x.ts:${e.line}](../${e.section}#L${e.line})`;
    out.push(`- [${e.done ? 'x' : ' '}] **added** \`notify\` ${at}`);
    out.push(`  - new: ${e.text}`);
  }
  return out.join('\n') + '\n';
}

const untick = (entries: Entry[]) =>
  entries.map((e) => ({ ...e, done: false }));
// #endregion

describe('copyReviewPath', () => {
  it('names the worksheet after the release in plans/', () => {
    expect(copyReviewPath('0.8.3')).toBe('plans/0.8.3-copy.md');
  });
});

describe('uncheckedCount', () => {
  it('counts the entries not ticked yet', () => {
    fc.assert(
      fc.property(fc.array(entryArb, { maxLength: 12 }), (entries) => {
        expect(uncheckedCount(worksheet(entries))).toBe(
          entries.filter((e) => !e.done).length
        );
      })
    );
  });

  it('takes an upper-case X as ticked and ignores nested bullets', () => {
    expect(uncheckedCount('- [X] a\n  - [ ] b\n- [ ] c\n')).toBe(1);
  });

  it('reads a worksheet that ends inside an entry, with no final newline', () => {
    expect(uncheckedCount('- [ ] a\n  - new: b')).toBe(1);
  });
});

describe('carryChecks', () => {
  it('restores every tick when the same changes come back at other lines', () => {
    fc.assert(
      fc.property(
        // identical entries are interchangeable; the next test covers them
        fc.uniqueArray(entryArb, {
          maxLength: 12,
          selector: (e) => `${e.section}|${e.gone}|${e.text}`,
        }),
        fc.integer({ min: -50, max: 50 }),
        (entries, shift) => {
          const moved = untick(entries).map((e) => ({
            ...e,
            line: Math.max(0, e.line + shift),
          }));
          const expected = moved.map((e, i) => ({
            ...e,
            done: entries[i].done,
          }));
          expect(carryChecks(worksheet(entries), worksheet(moved))).toBe(
            worksheet(expected)
          );
        }
      )
    );
  });

  it('only ever adds ticks, and only to entries the old worksheet ticked', () => {
    fc.assert(
      fc.property(
        fc.array(entryArb, { maxLength: 10 }),
        fc.array(entryArb, { maxLength: 10 }),
        (previous, next) => {
          const result = carryChecks(worksheet(previous), worksheet(next));
          const lines = result.split('\n');
          const nextLines = worksheet(next).split('\n');
          expect(lines).toHaveLength(nextLines.length);
          lines.forEach((line, i) => {
            if (line !== nextLines[i])
              expect(line).toBe(nextLines[i].replace('- [ ] ', '- [x] '));
          });
          // at most as many ticks gained as the old worksheet had
          const gained =
            uncheckedCount(worksheet(next)) - uncheckedCount(result);
          expect(gained).toBeLessThanOrEqual(
            previous.filter((e) => e.done).length
          );
        }
      )
    );
  });

  it('carries one tick per identical entry, and never across sections', () => {
    const entry = (section: string, done: boolean): Entry => ({
      section,
      done,
      line: 1,
      text: 'Open note',
      gone: false,
    });
    const previous = worksheet([
      entry('src/a.ts', true),
      entry('src/a.ts', false),
    ]);
    const next = worksheet([
      entry('src/a.ts', false),
      entry('src/a.ts', false),
      entry('src/b.tsx', false),
    ]);
    expect(uncheckedCount(carryChecks(previous, next))).toBe(2);
    expect(carryChecks(previous, next).indexOf('- [x]')).toBeLessThan(
      carryChecks(previous, next).indexOf('- [ ]')
    );
  });

  it('never carries a tick to the same entry in another file', () => {
    fc.assert(
      fc.property(entryArb, (e) => {
        const other = e.section === 'src/a.ts' ? 'src/b.tsx' : 'src/a.ts';
        const result = carryChecks(
          worksheet([{ ...e, done: true }]),
          worksheet([{ ...e, done: false, section: other }])
        );
        expect(uncheckedCount(result)).toBe(1);
      })
    );
  });

  it('tells an entry from one whose text is split across its lines differently', () => {
    const result = carryChecks(
      '### src/a.ts\n- [x] **added** a  - new: b\n',
      '### src/a.ts\n- [ ] **added** a\n  - new: b\n'
    );
    expect(uncheckedCount(result)).toBe(1);
  });

  it('carries nothing onto an entry whose text changed', () => {
    fc.assert(
      fc.property(entryArb, lineArb, (e, other) => {
        fc.pre(other !== e.text);
        const result = carryChecks(
          worksheet([{ ...e, done: true }]),
          worksheet([{ ...e, done: false, text: other }])
        );
        expect(uncheckedCount(result)).toBe(1);
      })
    );
  });
});

describe('reportRange', () => {
  it('reads back the range the heading names', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => !/[`\r\n]/.test(s)),
        (range) => {
          const sheet = `${reportHeading(range)}\n\nsummary\n`;
          expect(reportRange(sheet)).toBe(range);
        }
      )
    );
  });

  it('finds no range in a worksheet without the heading', () => {
    expect(reportRange('# Notes\n\n- [x] a\n')).toBeUndefined();
    expect(reportRange('')).toBeUndefined();
    // the heading is a line of its own, not a mention inside another one
    expect(
      reportRange('See # UI copy changes: `0.8.2..HEAD`\n')
    ).toBeUndefined();
    expect(
      reportRange('# UI copy changes: `0.8.2..HEAD` and more\n')
    ).toBeUndefined();
  });
});

describe('unreviewedCount', () => {
  it('finds nothing new when the copy only moved since the review', () => {
    fc.assert(
      fc.property(
        fc.array(entryArb, { maxLength: 12 }),
        fc.integer({ min: -50, max: 50 }),
        (entries, shift) => {
          const reviewed = entries.map((e) => ({ ...e, done: true }));
          const fresh = untick(entries).map((e) => ({
            ...e,
            line: Math.max(0, e.line + shift),
          }));
          expect(unreviewedCount(worksheet(reviewed), worksheet(fresh))).toBe(
            0
          );
        }
      )
    );
  });

  it('counts each entry whose text changed or that is new since the review', () => {
    fc.assert(
      fc.property(entryArb, entryArb, lineArb, (e, added, other) => {
        fc.pre(other !== e.text);
        const reviewed = worksheet([{ ...e, done: true }]);
        const fresh = worksheet(
          untick([
            { ...e, text: other },
            { ...added, section: 'src/c.ts' },
          ])
        );
        expect(unreviewedCount(reviewed, fresh)).toBe(2);
      })
    );
  });
});

describe('nextPatch', () => {
  it('bumps the patch number of a plain version', () => {
    fc.assert(
      fc.property(fc.nat(), fc.nat(), fc.nat(), (major, minor, patch) => {
        expect(nextPatch(`${major}.${minor}.${patch}`)).toBe(
          `${major}.${minor}.${patch + 1}`
        );
      })
    );
  });

  it('suggests nothing for a version it cannot read', () => {
    for (const v of ['0.8', 'v0.8.2', '0.8.2-beta.1', ' 0.8.2', ''])
      expect(nextPatch(v)).toBeUndefined();
  });
});
