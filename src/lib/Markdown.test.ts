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
          fc.string(),
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
});
