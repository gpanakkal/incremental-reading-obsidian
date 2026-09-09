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

describe('stripLinks', () => {
  describe('inline links', () => {
    it('keeps the label and drops the target', () => {
      expect(Markdown.stripLinks('See [my site](www.example.com) now')).toBe(
        'See my site now'
      );
    });

    it('keeps the alt text of an image', () => {
      expect(Markdown.stripLinks('![a diagram](diagram.png)')).toBe(
        'a diagram'
      );
    });

    it('keeps the alt text of an image given by reference', () => {
      expect(Markdown.stripLinks('a ![a diagram][ref] b')).toBe(
        'a a diagram b'
      );
    });

    it('strips a link whose target contains spaces and punctuation', () => {
      expect(
        Markdown.stripLinks('[label](https://example.com/a,b (x)')
      ).not.toContain('https');
    });

    it('leaves nothing behind for an empty label', () => {
      expect(Markdown.stripLinks('a[](url)b')).toBe('ab');
    });

    it('strips every link in a string, not only the first', () => {
      // Kills the missing-/g mutant
      expect(Markdown.stripLinks('[one](a) and [two](b)')).toBe('one and two');
    });

    it('unwraps an image nested inside a link', () => {
      // The only nesting Markdown permits; needs more than one pass
      expect(Markdown.stripLinks('[![alt](img.png)](www.example.com)')).toBe(
        'alt'
      );
    });
  });

  describe('wikilinks', () => {
    it('keeps the target of a plain wikilink', () => {
      expect(Markdown.stripLinks('About [[Some Note]] here')).toBe(
        'About Some Note here'
      );
    });

    it('keeps the alias and drops the target when one is present', () => {
      expect(Markdown.stripLinks('About [[Some Note|the alias]]')).toBe(
        'About the alias'
      );
    });

    it('keeps an empty alias rather than falling back to the target', () => {
      // Kills the `alias ?? target` → `alias || target` mutant
      expect(Markdown.stripLinks('a[[Some Note|]]b')).toBe('ab');
    });

    it('strips the embed prefix of an embedded note', () => {
      expect(Markdown.stripLinks('![[Some Note]]')).toBe('Some Note');
    });

    it('keeps the alias of an embedded note', () => {
      expect(Markdown.stripLinks('![[Some Note|the alias]]')).toBe('the alias');
    });

    it('keeps a heading reference as part of the target', () => {
      expect(Markdown.stripLinks('[[Some Note#A Heading]]')).toBe(
        'Some Note#A Heading'
      );
    });

    it('strips every wikilink in a string', () => {
      expect(Markdown.stripLinks('[[one]] and [[two|2]]')).toBe('one and 2');
    });
  });

  describe('reference links', () => {
    it('keeps the label and drops the reference', () => {
      expect(Markdown.stripLinks('See [my site][ref] now')).toBe(
        'See my site now'
      );
    });
  });

  describe('footnote references', () => {
    it('removes a footnote reference outright, label and all', () => {
      expect(Markdown.stripLinks('a claim[^1] and another[^note]')).toBe(
        'a claim and another'
      );
    });

    it('removes an adjacent pair rather than reading it as a reference link', () => {
      // Without the footnote pass, `[^1][^2]` matches the reference-link shape
      expect(Markdown.stripLinks('a claim[^1][^2] here')).toBe(
        'a claim here'
      );
    });

    it('leaves a footnote definition alone', () => {
      // A definition is `[^1]:`; only references are stripped
      expect(Markdown.stripLinks('[^1]: the footnote text')).toBe(
        '[^1]: the footnote text'
      );
    });
  });

  describe('non-links', () => {
    it('returns a string containing no brackets unchanged', () => {
      fc.assert(
        fc.property(
          fc.string().filter((s) => !/[[\]]/.test(s)),
          (text) => {
            expect(Markdown.stripLinks(text)).toBe(text);
          }
        )
      );
    });

    it('leaves a checkbox alone', () => {
      expect(Markdown.stripLinks('- [x] done item')).toBe('- [x] done item');
    });

    it('leaves an unclosed bracket alone', () => {
      expect(Markdown.stripLinks('a [not a link b')).toBe('a [not a link b');
    });

    it('leaves bracketed text with no target alone', () => {
      expect(Markdown.stripLinks('an [aside] mid-sentence')).toBe(
        'an [aside] mid-sentence'
      );
    });
  });
});
