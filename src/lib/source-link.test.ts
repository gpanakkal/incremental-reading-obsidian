import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  formatSourceLink,
  linkNamesPath,
  parseSourceLink,
  retargetAlias,
} from './source-link';

// #region HELPERS
/**
 * A file or folder name as Obsidian lets one be linked to: spaces, brackets
 * of the round kind, `%` and the like included; none of the characters a
 * name can't hold or a link can't carry (`\ / : * ? " < > | # ^ [ ]`), and
 * no `%` that reads as an escape, which would make a markdown link ambiguous.
 */
const segmentArb = fc
  .string({
    minLength: 1,
    maxLength: 12,
    unit: fc.oneof(
      fc.constantFrom(' ', '(', ')', '%', '&', '=', ',', '.', '-', "'", '!'),
      fc.string({ minLength: 1, maxLength: 1, unit: 'grapheme' })
    ),
  })
  .filter(
    (s) =>
      !/[\\/:*?"<>|#^[\]\x00-\x1F\x7F]/.test(s) &&
      !/%[0-9A-Fa-f]{2}/.test(s) &&
      s.trim() === s &&
      s !== '.' &&
      s !== '..'
  );

/**
 * A markdown link's target as Obsidian writes it (`YE` in its bundle):
 * only spaces, backslashes and control characters are URL-encoded.
 */
const obsidianEncoded = (target: string) =>
  target.replace(/[\\\x00\x08\x0B\x0C\x0E-\x1F ]/g, (c) =>
    encodeURIComponent(c)
  );

/**
 * Whether the round brackets in `text` balance, as a bare markdown link
 * target's must to be read (see `parseSourceLink`): a name whose don't is
 * read in a wikilink or angle brackets only.
 */
const balanced = (text: string) => {
  let depth = 0;
  for (const char of text) {
    if (char === '(') depth += 1;
    else if (char === ')' && --depth < 0) return false;
  }
  return depth === 0;
};

const pathArb = fc
  .array(segmentArb, { minLength: 1, maxLength: 4 })
  .map((parts) => parts.join('/'));

/** A subpath as Obsidian writes one after `#`, or none. */
const subpathArb = fc.oneof(
  fc.constant(''),
  fc
    .tuple(
      fc.integer({ min: 1, max: 999 }),
      fc.array(fc.nat({ max: 99999 }), { minLength: 4, maxLength: 4 })
    )
    .map(([page, sel]) => `#page=${page}&selection=${sel.join(',')}`),
  segmentArb.map((heading) => `#${heading}`)
);

/** An alias free of the characters that would end it early. */
const aliasArb = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => !/[\]|[\n]/.test(s) && s.trim() === s && s !== '');
// #endregion

describe('parseSourceLink', () => {
  it('reads the path, subpath and alias of a wikilink', () => {
    fc.assert(
      fc.property(
        pathArb,
        subpathArb,
        fc.option(aliasArb, { nil: null }),
        (path, subpath, alias) => {
          const link = `[[${path}${subpath}${alias === null ? '' : `|${alias}`}]]`;
          expect(parseSourceLink(link)).toEqual({
            form: 'wiki',
            path,
            subpath,
            alias,
          });
        }
      )
    );
  });

  it('reads the path, subpath and alias of a markdown link, encoded or in angle brackets', () => {
    fc.assert(
      fc.property(
        pathArb,
        subpathArb,
        aliasArb,
        fc.boolean(),
        (path, subpath, alias, angled) => {
          fc.pre(angled || balanced(path + subpath));
          const target = angled
            ? `<${path}${subpath}>`
            : obsidianEncoded(path + subpath);
          expect(parseSourceLink(`[${alias}](${target})`)).toEqual({
            form: angled ? 'angled' : 'markdown',
            path,
            subpath,
            alias,
          });
        }
      )
    );
  });

  it('reads a path with spaces from an encoded markdown link', () => {
    expect(
      parseSourceLink('[My paper, page 2](My%20papers/My%20paper.pdf#page=2)')
    ).toEqual({
      form: 'markdown',
      path: 'My papers/My paper.pdf',
      subpath: '#page=2',
      alias: 'My paper, page 2',
    });
  });

  it('reads a markdown link to a name with brackets in it to its last bracket', () => {
    expect(
      parseSourceLink('[Paper (2020), page 3](Paper%20(2020).pdf#page=3)')
    ).toEqual({
      form: 'markdown',
      path: 'Paper (2020).pdf',
      subpath: '#page=3',
      alias: 'Paper (2020), page 3',
    });
  });

  it('reads a markdown link to a place in its own note as having no path', () => {
    expect(parseSourceLink('[a](#Heading)')).toEqual({
      form: 'markdown',
      path: '',
      subpath: '#Heading',
      alias: 'a',
    });
  });

  it('keeps escapes that decode to no text as written', () => {
    expect(parseSourceLink('[a](x%E0%A4%20y.pdf)')).toEqual({
      form: 'markdown',
      path: 'x%E0%A4%20y.pdf',
      subpath: '',
      alias: 'a',
    });
  });

  it('keeps a markdown link whose target cannot be decoded as written', () => {
    expect(parseSourceLink('[a](100%.pdf)')).toEqual({
      form: 'markdown',
      path: '100%.pdf',
      subpath: '',
      alias: 'a',
    });
  });

  it('answers null for anything that is no single link', () => {
    for (const text of [
      '',
      'notes/plain.md',
      'https://example.com',
      '[[a]] and [[b]]',
      '[[unclosed',
      'text [[a]]',
      'see [a](b.pdf)',
      '[a](b.pdf) and more',
      // A link followed by more text that happens to end in a bracket
      '[Paper](paper.pdf) (2nd ed)',
      '[a](b.pdf)(c)x)',
      // Brackets that don't balance, as no name's can
      '[a](b(.pdf)',
      '[a](b).pdf)',
      // What Obsidian would have encoded, as written
      '[a](my paper.pdf)',
      '[a](a\tb.pdf)',
      // Not a whole markdown link
      '[a]',
      '[a](',
      '[a])',
      '[a](b.pdf',
      '[a]xy)',
      '[a',
      '[a(b)',
      '[a]x(b.pdf)',
      'a](b.pdf)',
      '!!(b.pdf)',
      '[a(b.pdf)',
      // Angle brackets that aren't a target's
      '[a](<b.pdf)',
      '[a](<)',
      '[a](<b>c>)',
      '[a](< b.pdf> x)',
    ]) {
      expect(parseSourceLink(text)).toBeNull();
    }
  });

  it("reads no bare markdown link to a name whose brackets don't balance, which angle brackets or a wikilink carry", () => {
    expect(parseSourceLink('[a](x(%20y.pdf#page=2)')).toBeNull();
    expect(parseSourceLink('[a](<x( y.pdf#page=2>)')).toEqual({
      form: 'angled',
      path: 'x( y.pdf',
      subpath: '#page=2',
      alias: 'a',
    });
    expect(parseSourceLink('[[x( y.pdf#page=2|a]]')).toEqual({
      form: 'wiki',
      path: 'x( y.pdf',
      subpath: '#page=2',
      alias: 'a',
    });
  });

  it('reads an embed, an empty target, and spaces inside the brackets', () => {
    expect(parseSourceLink('![a](b.pdf)')).toEqual({
      form: 'markdown',
      path: 'b.pdf',
      subpath: '',
      alias: 'a',
    });
    expect(parseSourceLink('[a]()')).toEqual({
      form: 'markdown',
      path: '',
      subpath: '',
      alias: 'a',
    });
    expect(parseSourceLink('[a](  <b c.pdf>  )')).toEqual({
      form: 'angled',
      path: 'b c.pdf',
      subpath: '',
      alias: 'a',
    });
    expect(parseSourceLink('[a](<>)')).toEqual({
      form: 'angled',
      path: '',
      subpath: '',
      alias: 'a',
    });
    expect(parseSourceLink('[](a(1)(2).pdf)')).toEqual({
      form: 'markdown',
      path: 'a(1)(2).pdf',
      subpath: '',
      alias: '',
    });
  });

  // A regex that let a target run to the last `)` took seconds on a few
  // thousand spaces (user-approved security fix, 0026)
  /** The time `parseSourceLink(text)` takes, in milliseconds. */
  const timed = (text: string) => {
    const start = performance.now();
    parseSourceLink(text);
    return performance.now() - start;
  };

  /** Text crafted to make a backtracking parser of either form slow. */
  const hostileArb = fc
    .record({
      prefix: fc.constantFrom('[a](', '![a](', '[a](<', '[[', '[a]', ''),
      unit: fc.constantFrom(
        ' ',
        '\t',
        '(',
        ')',
        '<',
        '>',
        '%',
        '%2',
        ']',
        '[',
        '#',
        '|',
        ' x'
      ),
      count: fc.integer({ min: 50_000, max: 100_000 }),
      suffix: fc.constantFrom('', 'x', ')', ' )', '>)', ']]', 'x y'),
    })
    .map(
      ({ prefix, unit, count, suffix }) => prefix + unit.repeat(count) + suffix
    );

  it('reads a long run of spaces with no closing bracket within its time budget', () => {
    for (const text of [
      `[a](${' '.repeat(100_000)}x`,
      `[a](${' '.repeat(50_000)}x${' '.repeat(50_000)}y`,
      `[a](${' '.repeat(100_000)}`,
      `${' '.repeat(100_000)}[a](x${' '.repeat(100_000)}`,
    ]) {
      expect(timed(text)).toBeLessThan(250);
    }
  });

  it('takes time linear in the length of any text, crafted or not', () => {
    fc.assert(
      fc.property(hostileArb, (text) => {
        // 100k characters: a quadratic parser takes seconds, a linear one a
        // few milliseconds
        expect(timed(text)).toBeLessThan(250);
      }),
      { numRuns: 40 }
    );
    // Sixteen times the text takes nowhere near 256 times as long
    const short = `[a](${' '.repeat(20_000)}x`;
    const long = `[a](${' '.repeat(320_000)}x`;
    const best = (text: string) =>
      Math.min(...Array.from({ length: 5 }, () => timed(text)));
    expect(best(long)).toBeLessThan(Math.max(best(short), 0.5) * 64);
  });

  it('ignores whitespace around the link', () => {
    expect(parseSourceLink('  [[a.pdf#page=1|a, page 1]] ')).toEqual({
      form: 'wiki',
      path: 'a.pdf',
      subpath: '#page=1',
      alias: 'a, page 1',
    });
  });
});

describe('formatSourceLink', () => {
  it('writes a link back as Obsidian wrote it, in each form', () => {
    fc.assert(
      fc.property(
        pathArb,
        subpathArb,
        fc.option(aliasArb, { nil: null }),
        fc.constantFrom('wiki', 'markdown', 'angled'),
        (path, subpath, alias, form) => {
          fc.pre(form !== 'markdown' || balanced(path + subpath));
          const text =
            form === 'wiki'
              ? `[[${path}${subpath}${alias === null ? '' : `|${alias}`}]]`
              : form === 'angled'
                ? `[${alias ?? ''}](<${path}${subpath}>)`
                : `[${alias ?? ''}](${obsidianEncoded(path + subpath)})`;
          const link = parseSourceLink(text)!;
          expect(formatSourceLink(link)).toBe(text);
        }
      )
    );
  });

  it('writes a markdown link with no text when it has no alias', () => {
    expect(
      formatSourceLink({
        form: 'markdown',
        path: 'a.pdf',
        subpath: '',
        alias: null,
      })
    ).toBe('[](a.pdf)');
  });

  it('encodes in a markdown link only what Obsidian encodes', () => {
    expect(
      formatSourceLink({
        form: 'markdown',
        path: 'a b\\c (1)%.pdf',
        subpath: '#page=1&selection=0,1,2,3',
        alias: 'a, page 1',
      })
    ).toBe('[a, page 1](a%20b%5Cc%20(1)%.pdf#page=1&selection=0,1,2,3)');
  });
});

describe('linkNamesPath', () => {
  it('holds for the full path, and for every shorter tail of it', () => {
    fc.assert(
      fc.property(
        fc.array(segmentArb, { minLength: 1, maxLength: 4 }),
        pathArb,
        fc.nat(),
        (parts, notePath, cut) => {
          const path = parts.join('/');
          const tail = parts.slice(cut % parts.length).join('/');
          expect(linkNamesPath(tail, notePath, path)).toBe(true);
          expect(linkNamesPath(`/${path}`, notePath, path)).toBe(true);
        }
      )
    );
  });

  it('ignores case, as Obsidian resolves links', () => {
    expect(linkNamesPath('PAPERS/Paper.PDF', 'n.md', 'papers/paper.pdf')).toBe(
      true
    );
  });

  it('holds for a note named without its .md extension', () => {
    expect(linkNamesPath('notes/a', 's/n.md', 'notes/a.md')).toBe(true);
    expect(linkNamesPath('a', 's/n.md', 'notes/a.md')).toBe(true);
    expect(linkNamesPath('a', 's/n.md', 'notes/a.pdf')).toBe(false);
  });

  it('fails for a tail that only ends a segment, or names another file', () => {
    expect(linkNamesPath('aper.pdf', 'n.md', 'papers/paper.pdf')).toBe(false);
    expect(linkNamesPath('other.pdf', 'n.md', 'papers/paper.pdf')).toBe(false);
    expect(linkNamesPath('x/paper.pdf', 'n.md', 'papers/paper.pdf')).toBe(
      false
    );
    expect(linkNamesPath('', 'n.md', 'papers/paper.pdf')).toBe(false);
  });

  it('resolves a relative link from the folder of the note it is in', () => {
    expect(
      linkNamesPath(
        '../papers/paper.pdf',
        'IR/snippets/s.md',
        'IR/papers/paper.pdf'
      )
    ).toBe(true);
    expect(
      linkNamesPath('./paper.pdf', 'papers/s.md', 'papers/paper.pdf')
    ).toBe(true);
    expect(
      linkNamesPath('../paper.pdf', 'IR/snippets/s.md', 'IR/papers/paper.pdf')
    ).toBe(false);
    expect(linkNamesPath('../../../a.pdf', 's.md', 'a.pdf')).toBe(true);
    // From a note at the root of the vault
    expect(linkNamesPath('./a.pdf', 's.md', 'a.pdf')).toBe(true);
    expect(linkNamesPath('./a.pdf', 's.md', 's/a.pdf')).toBe(false);
    expect(linkNamesPath('.//a.pdf', 'n/s.md', 'n/a.pdf')).toBe(true);
    expect(linkNamesPath('../', 'n/s.md', 'n/a.pdf')).toBe(false);
  });

  it('takes a link from the vault root, with a leading slash, as the whole path only, as Obsidian resolves it', () => {
    fc.assert(
      fc.property(
        fc.array(segmentArb, { minLength: 1, maxLength: 4 }),
        pathArb,
        fc.nat(),
        (parts, notePath, cut) => {
          const path = parts.join('/');
          const tail = parts.slice(cut % parts.length).join('/');
          expect(linkNamesPath(`/${tail}`, notePath, path)).toBe(
            tail.toLowerCase() === path.toLowerCase()
          );
        }
      )
    );
    expect(linkNamesPath('/notes/a', 's.md', 'notes/a.md')).toBe(true);
    expect(linkNamesPath('/a', 's.md', 'notes/a.md')).toBe(false);
  });

  it('reads past spaces around the link path and any number of leading slashes', () => {
    expect(linkNamesPath(' papers/a.pdf ', 's.md', 'papers/a.pdf')).toBe(true);
    expect(linkNamesPath('//papers/a.pdf', 's.md', 'papers/a.pdf')).toBe(true);
    expect(linkNamesPath('/', 's.md', 'papers/a.pdf')).toBe(false);
  });

  it('drops only a note’s .md, never a part of another extension', () => {
    expect(linkNamesPath('a.', 's.md', 'a.pdf')).toBe(false);
    expect(linkNamesPath('a.p', 's.md', 'a.pdf')).toBe(false);
  });
});

describe('retargetAlias', () => {
  it("renames an alias that is the old file's name, or its page label", () => {
    fc.assert(
      fc.property(
        aliasArb,
        aliasArb,
        fc.integer({ min: 1, max: 9999 }),
        (from, to, page) => {
          expect(retargetAlias(from, from, to)).toBe(to);
          expect(retargetAlias(`${from}, page ${page}`, from, to)).toBe(
            `${to}, page ${page}`
          );
        }
      )
    );
  });

  it('keeps any other alias as the user wrote it, and no alias as none', () => {
    fc.assert(
      fc.property(aliasArb, aliasArb, aliasArb, (alias, from, to) => {
        fc.pre(alias !== from && !alias.startsWith(`${from}, page `));
        expect(retargetAlias(alias, from, to)).toBe(alias);
      })
    );
    expect(retargetAlias(null, 'a', 'b')).toBeNull();
  });
});
