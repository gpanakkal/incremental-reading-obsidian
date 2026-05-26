import { testDoc1 } from '#/test/testData';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

describe('getListItemText', () => {
  describe('non-bullet lines', () => {
    it('returns any non-list line unchanged', () => {
      // Lines that don't start with optional spaces + (- | N.) followed by a space
      const nonListArb = fc
        .string()
        .filter((s) => !/^\s*(?:-|\d+\.)\s/.test(s));
      fc.assert(
        fc.property(nonListArb, (line) => {
          expect(Markdown.getListItemText(line)).toBe(line);
        })
      );
    });
  });

  describe('number list items', () => {
    it('strips the number from a numbered list item', () => {
      expect(Markdown.getListItemText('1. item')).toBe('item');
    });

    it('strips multi-digit numbers from a numbered list item', () => {
      expect(Markdown.getListItemText('10. item')).toBe('item');
    });

    it('strips the number from an indented numbered list item', () => {
      expect(Markdown.getListItemText('  3. nested item')).toBe('nested item');
    });
  });

  describe('plain bullet items', () => {
    it('strips a simple bullet prefix', () => {
      expect(Markdown.getListItemText('- item text')).toBe('item text');
    });

    it('strips an indented bullet prefix', () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 1000 }), (leadingSpaces) => {
          expect(
            Markdown.getListItemText(
              ' '.repeat(leadingSpaces) + '- nested item'
            )
          ).toBe('nested item');
        })
      );
    });

    it('returns empty string for a bullet with no text', () => {
      expect(Markdown.getListItemText('- ')).toBe('');
    });

    it('preserves trailing spaces in item text', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 1000 }),
          fc.string().filter((str) => !/^\s*\[.\]/.test(str)),
          (trailingSpaces, text) => {
            const target = text + ' '.repeat(trailingSpaces);
            expect(Markdown.getListItemText('- ' + target)).toBe(target);
          }
        )
      );
    });
  });

  describe('checkbox bullet items', () => {
    it('strips bullet and unchecked checkbox', () => {
      expect(Markdown.getListItemText('- [ ] todo item')).toBe('todo item');
    });

    it('strips bullet and checked checkbox', () => {
      expect(Markdown.getListItemText('- [x] done item')).toBe('done item');
    });

    it('strips bullet and checkbox with arbitrary character', () => {
      expect(Markdown.getListItemText('- [/] in progress')).toBe('in progress');
    });

    it('strips indented bullet and checkbox', () => {
      expect(Markdown.getListItemText('  - [x] nested done')).toBe(
        'nested done'
      );
    });

    it('strips bullet and checkbox with no trailing text', () => {
      expect(Markdown.getListItemText('- [x] ')).toBe('');
    });
  });

  describe('anchor behavior', () => {
    it('does not strip a bullet that is not at the start of the string', () => {
      // Kills the ^-anchor regex mutant: without ^, "text - item" would match
      expect(Markdown.getListItemText('text - item')).toBe('text - item');
      expect(Markdown.getListItemText('prefix 1. item')).toBe('prefix 1. item');
    });

    it('handles a bullet with only whitespace as item text', () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 20 }), (n) => {
          const spaces = ' '.repeat(n);
          expect(Markdown.getListItemText('- ' + spaces)).toBe(spaces);
        })
      );
    });

    it('strips numbered items with arbitrary leading indentation', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 20 }),
          fc.integer({ min: 1, max: 999 }),
          fc.string(),
          (indent, num, text) => {
            const line = ' '.repeat(indent) + `${num}. ` + text;
            expect(Markdown.getListItemText(line)).toBe(text);
          }
        )
      );
    });

    it('strips checkbox with any single character in brackets', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 1 }),
          fc.string(),
          (ch, text) => {
            const line = `- [${ch}] ${text}`;
            expect(Markdown.getListItemText(line)).toBe(text);
          }
        )
      );
    });
  });
});

describe('countFootnoteRefs', () => {
  it('identifies footnotes correctly', () => {
    const result = Markdown.countFootnoteRefs(testDoc1);
    expect(result).toEqual(
      expect.arrayContaining([
        { name: '1', count: 1 },
        { name: '5', count: 2 },
        { name: '15', count: 4 },
        { name: '24', count: 2 },
        { name: '26', count: 2 },
      ])
    );
  });

  it('returns an empty array for a string with no footnote references', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !/\[\^[\w\d]+\](?!:)/.test(s)),
        (text) => {
          expect(Markdown.countFootnoteRefs(text)).toEqual([]);
        }
      )
    );
  });

  it('returns an empty array for the empty string', () => {
    expect(Markdown.countFootnoteRefs('')).toEqual([]);
  });

  it('counts a single footnote reference once', () => {
    expect(Markdown.countFootnoteRefs('See [^abc] for details.')).toEqual([
      { name: 'abc', count: 1 },
    ]);
  });

  it('counts a footnote referenced multiple times', () => {
    const text = 'See [^x] and also [^x] again and [^x] once more.';
    expect(Markdown.countFootnoteRefs(text)).toEqual([{ name: 'x', count: 3 }]);
  });

  it('preserves first-appearance order across multiple footnotes', () => {
    const text = 'First [^b] then [^a] then [^b] again.';
    const result = Markdown.countFootnoteRefs(text);
    expect(result[0]).toEqual({ name: 'b', count: 2 });
    expect(result[1]).toEqual({ name: 'a', count: 1 });
  });

  it('does not count footnote definitions (lines with [^name]:)', () => {
    // A footnote definition like \n[^1]: text should NOT be counted as a reference
    const text = '\n[^1]: This is the footnote definition.';
    expect(Markdown.countFootnoteRefs(text)).toEqual([]);
  });

  it('counts multi-digit and multi-char footnote names', () => {
    // Bug: names that are Object.prototype properties (e.g. "valueOf") are
    // skipped by the `name in counts` check — filter them out to test safe cases.
    const protoProps = new Set(Object.getOwnPropertyNames(Object.prototype));
    fc.assert(
      fc.property(
        fc.stringMatching(/^[\w\d]{2,10}$/).filter((s) => !protoProps.has(s)),
        fc.integer({ min: 1, max: 5 }),
        (name, times) => {
          const text = Array(times).fill(`[^${name}]`).join(' ');
          const result = Markdown.countFootnoteRefs(text);
          expect(result).toEqual([{ name, count: times }]);
        }
      )
    );
  });

  it('Correctly counts prototype-named footnotes', () => {
    const result = Markdown.countFootnoteRefs('[^valueOf] and [^valueOf]');
    expect(result).toEqual([{ name: 'valueOf', count: 2 }]);
  });

  it('returns counts that sum to total number of footnote reference tokens', () => {
    const protoProps = new Set(Object.getOwnPropertyNames(Object.prototype));
    fc.assert(
      fc.property(
        fc.array(
          fc.stringMatching(/^[\w\d]{1,8}$/).filter((s) => !protoProps.has(s)),
          { minLength: 1, maxLength: 10 }
        ),
        (names) => {
          const text = names.map((n) => `[^${n}]`).join(' ');
          const result = Markdown.countFootnoteRefs(text);
          const total = result.reduce((sum, r) => sum + r.count, 0);
          expect(total).toBe(names.length);
        }
      )
    );
  });
});
