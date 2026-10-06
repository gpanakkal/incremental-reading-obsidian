import { testDoc1 } from '#/test/testData';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LEGACY_ENTITIES, Markdown, URI_SCHEME } from './Markdown';

// #region HELPERS

/** What escaped text reads as once the escapes Markdown honors are read. */
const unescape = (text: string) => text.replace(/\\([!-/:-@[-`{-~])/g, '$1');

/** `text` without the whitespace, other than line breaks, that starts its lines. */
const unindented = (text: string) =>
  text.replace(/(^|\r\n?|\n)[^\S\r\n]+/g, '$1');

/**
 * Whether each character escaped text reads as was escaped, in the order
 * {@link unescape} reads them.
 */
function escapedFlags(escaped: string): boolean[] {
  const flags: boolean[] = [];
  for (let k = 0; k < escaped.length; k++) {
    const escapes =
      escaped[k] === '\\' && /[!-/:-@[-`{-~]/.test(escaped[k + 1] ?? '');
    flags.push(escapes);
    if (escapes) k++;
  }
  return flags;
}

/** Whitespace of every kind JavaScript's `\s` matches, and some it doesn't. */
const SPACES = [
  ' ',
  '\t',
  '\u00a0',
  '\u2003',
  '\u3000',
  '\u000b',
  '\u000c',
  '\u2028',
  '\ufeff',
  '\u200b',
  '\u0085',
];

/** Text rich in what Markdown, Obsidian, Templater and the plugin read as syntax. */
const markdownishArb = fc.string({
  unit: fc.oneof(
    fc.constantFrom(
      ...'\\`*_{}[]#$%&<>^=~!|()-+.:/@;,?"\' \n\r'.split(''),
      ...SPACES,
      '\r\n',
      '![[',
      '[[',
      '](',
      '#tag',
      '#1',
      '#12,',
      '#1st',
      '(}',
      '{)',
      '{{',
      '}}',
      '<%',
      '<%*',
      '%%',
      '==',
      '~~',
      '::',
      '://',
      '[^1]',
      '^[',
      ' ^block',
      '---',
      '1. ',
      '9) ',
      '12.',
      '1.5',
      '-5',
      '> ',
      '<img src=x>',
      '</b>',
      '<!--',
      '&amp;',
      '&#38;',
      '&notit;',
      '&AMP',
      '&Amp',
      '&section',
      '&x;',
      'AT&T',
      '$5',
      '$$',
      ' $',
      'https://',
      'www.',
      'WwW.',
      'a@b.co',
      'a@-b.co',
      'josé@b.co',
      'doi:10',
      'file:/x',
      'Tel:5',
      'javascript:x',
      'urn:%',
      'arxiv.org/a',
      'e.x/',
      'www1.',
      'WWW999.',
      'snake_case',
      'a_é',
      'C#'
    ),
    fc.constantFrom(...LEGACY_ENTITIES.map((name) => `&${name}`)),
    fc.string({ unit: 'grapheme', minLength: 1, maxLength: 1 })
  ),
  maxLength: 40,
});

/** The ranges of text an answer could take in `text`, as offsets into it. */
const textAndRangeArb = markdownishArb.chain((text) =>
  fc.tuple(fc.nat(text.length), fc.nat(text.length)).map(([x, y]) => ({
    text,
    range: [Math.min(x, y), Math.max(x, y)] as [number, number],
  }))
);

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const isLineBreak = (char: string) => char === '\n' || char === '\r';
const isBlank = (char: string) => /\s/.test(char);

/** The rest of the line from `j`, not counting its line break. */
const restOfLine = (text: string, j: number) =>
  /^[^\r\n]*/.exec(text.slice(j))![0];

/**
 * The reasons a character left unescaped at `j` in `plain` (unindented text,
 * as an escaped note reads) could form syntax: one per rule of the table.
 * Empty when it can't. Reading view starts a tag after an escape too, so
 * whether the character before is escaped is `prevEscaped`. An answer's
 * `ends`, offsets in `plain`, could put anything after a number.
 */
function syntaxAt(
  plain: string,
  j: number,
  prevEscaped: boolean,
  ends: ReadonlySet<number> = new Set()
): string[] {
  const char = plain[j];
  const prev = plain[j - 1] ?? '';
  const next = plain[j + 1] ?? '';
  const after = plain.slice(j + 1);
  const atLineStart = j === 0 || isLineBreak(prev);
  const line = restOfLine(plain, j);
  const reasons: string[] = [];
  const endsMarker = (k: number) => k >= plain.length || isBlank(plain[k]);
  if ('`*[|'.includes(char)) reasons.push('always');
  if (
    char === '\\' &&
    (next === '' || isLineBreak(next) || ASCII_PUNCTUATION.test(next))
  )
    reasons.push('escape or hard break');
  if (char === '}' && (prev === '(' || prev === '}')) reasons.push('cloze');
  if ((char === '{' || char === ')') && prev === '{') reasons.push('cloze');
  if (char === '#') {
    const digits = /^\d*/.exec(after)![0].length;
    const endInNumber = [...ends].some(
      (end) => end >= j + 2 && end <= j + 1 + digits
    );
    const number = /^\d+([\s,.)]|$)/.test(after) && !endInNumber;
    if (atLineStart) reasons.push('heading or tag');
    else if (
      (isBlank(prev) || prevEscaped) &&
      next !== '' &&
      !isBlank(next) &&
      !number
    )
      reasons.push('tag');
  }
  if (char === '$' && !(prev === ' ' && next !== '$')) reasons.push('math');
  if (char === '<' && !(next === '' || /[\s\d=-]/.test(next)))
    reasons.push('HTML or autolink');
  if (char === '>' && atLineStart) reasons.push('quote');
  if (char === '^' && (next === '[' || !/\s/.test(line.slice(1))))
    reasons.push('footnote or block id');
  if ('%=~'.includes(char) && (prev === char || next === char))
    reasons.push('doubled');
  if (char === '%' && prev === '<') reasons.push('Templater');
  if (char === '_' && !(/[A-Za-z\d]/.test(prev) && /[A-Za-z\d]/.test(next)))
    reasons.push('emphasis');
  if (
    char === '&' &&
    (next === '#' ||
      /^[A-Za-z][A-Za-z\d]*;/.test(after) ||
      LEGACY_ENTITIES.some((name) => after.startsWith(name)))
  )
    reasons.push('entity');
  if (
    char === '@' &&
    prev !== '' &&
    !/[\s<>()[\]\\,;:@"]/.test(prev) &&
    /[\w.-]/.test(next)
  )
    reasons.push('email');
  if (char === ':' && (prev === ':' || next === ':' || after.startsWith('//')))
    reasons.push('field or scheme');
  if (
    char === ':' &&
    /^[a-z\d%/]/i.test(next) &&
    URI_SCHEME.test(plain.slice(0, j))
  )
    reasons.push('scheme');
  if (char === '.' && /www\d{0,3}$/i.test(plain.slice(0, j)))
    reasons.push('www');
  if (char === '/' && /[a-z\d.-]\.[a-z]{2,4}$/i.test(plain.slice(0, j)))
    reasons.push('domain');
  if (atLineStart) {
    if ('-+'.includes(char) && endsMarker(j + 1)) reasons.push('list');
    if ('-='.includes(char) && /^[-=\s]*$/.test(line))
      reasons.push('setext or rule');
  }
  // The last of `N.` or `N)` that starts a line, before whitespace
  const number = /(?:^|[\r\n])(\d+)$/.exec(plain.slice(0, j));
  if ('.)'.includes(char) && number && endsMarker(j + 1))
    reasons.push('ordered list');
  return reasons;
}

/** The characters some rule escapes, and so escapes beside an answer's ends. */
const CONTEXTUAL = '`*[|\\{})#$<^%=~_&@:./-+';

/**
 * Text thick with backslashes, runs of them included, beside the ASCII
 * punctuation they escape and the characters they don't.
 */
const backslashyArb = fc.string({
  unit: fc.oneof(
    fc.constantFrom('\\', '\\\\', '\\\\\\', '#', '[', '(', '}', 'a', ' ', '\n'),
    fc.string({ unit: 'grapheme', minLength: 1, maxLength: 1 })
  ),
  maxLength: 30,
});

/** A selection in `text`, as offsets that may be equal. */
const backslashyRangeArb = backslashyArb.chain((text) =>
  fc.tuple(fc.nat(text.length), fc.nat(text.length)).map(([x, y]) => ({
    text,
    range: [Math.min(x, y), Math.max(x, y)] as [number, number],
  }))
);

/**
 * Where Markdown reads backslashes in `text`, read left to right as a parser
 * does: the offsets just inside each backslash and the ASCII punctuation it
 * escapes.
 */
function escapePairs(text: string) {
  return readBackslashes(text).pairs;
}

/**
 * {@link escapePairs} as `pairs`, and as `escaping` the offsets just after
 * each backslash that would escape ASCII punctuation put there: those of the
 * pairs, and those of the backslashes before anything else.
 */
function readBackslashes(text: string) {
  const pairs = new Set<number>();
  const escaping = new Set<number>();
  for (let k = 0; k < text.length; k++) {
    if (text[k] !== '\\') continue;
    escaping.add(k + 1);
    if (ASCII_PUNCTUATION.test(text[k + 1] ?? '')) {
      pairs.add(k + 1);
      k++;
    }
  }
  return { pairs, escaping };
}

/** Where each character of `text` is read, by index in {@link unescape}d text: a backslash pair's both at its char's. */
function readOffsets(text: string): number[] {
  const at: number[] = [];
  let read = 0;
  for (let k = 0; k < text.length; k++) {
    at.push(read);
    if (text[k] === '\\' && ASCII_PUNCTUATION.test(text[k + 1] ?? '')) {
      at.push(read);
      k++;
    }
    read++;
  }
  at.push(read);
  return at;
}

/** The offset in `text` where the line holding `j` starts. */
const lineStartOf = (text: string, j: number) =>
  j - /[^\r\n]*$/.exec(text.slice(0, j))![0].length;

/**
 * Whether what stands at `from` in `source` starts a block as the start of a
 * line does: only an indent of up to three spaces, quote markers, list
 * markers before whitespace and a task's checkbox come before it on its line
 * (`- # x` holds a heading, `> - x` a list; `    # x` is code, or a
 * paragraph's lazy continuation).
 */
function startsBlock(source: string, from: number): boolean {
  let rest = source
    .slice(lineStartOf(source, from), from)
    .replace(/^ {0,3}/, '');
  if (/^\s/.test(rest)) return false;
  for (;;) {
    const shorter = rest.replace(
      /^(?:>|(?:[-+*]|\d+[.)])\s(?:\s*\[.\]\s)?)\s*/,
      ''
    );
    if (shorter === rest) return rest === '';
    rest = shorter;
  }
}

/**
 * What the character at `j` of `plain` is as syntax, as {@link syntaxAt}
 * finds it, told apart where a cut's start needs it: a heading from a tag,
 * and the blocks a note that isn't escaped can start, which escaped text
 * never holds bare: a `*` list or rule, a `_` rule, a code fence, a link or
 * footnote definition. A `$` at the very start forms nothing: Obsidian opens
 * math after anything (task 0043's probe), and nothing is there for it to
 * close.
 */
function meaningsAt(text: string, at: number, prevEscaped: boolean): string[] {
  const reasons = syntaxAt(text, at, prevEscaped);
  const line = restOfLine(text, at);
  const atLineStart = at === 0 || isLineBreak(text[at - 1]);
  const meanings = reasons.flatMap((reason) => {
    if (reason === 'heading or tag') {
      // A tag as after whitespace, but for `#1`, which is none. Taken as
      // the rules take it, a `#` that could start one: `##tag` at a line's
      // start forms none in Obsidian 1.13.7, but escaping it is harmless
      const tag = /^#[^\s\d]|^#\d+(?![\s,.)]|\d|$)/.test(line);
      return [
        ...(/^#{1,6}(?:\s|$)/.test(line) ? ['heading'] : []),
        ...(tag ? ['tag'] : []),
      ];
    }
    // Only `$$` opens math that needs no closer
    return reason === 'math' && at === 0 && text[1] !== '$' ? [] : [reason];
  });
  if (atLineStart) {
    if (text[at] === '*' && isBlank(text[at + 1] ?? ' ')) meanings.push('list');
    if (/^([*_])(?:\s*\1){2,}\s*$/.test(line)) meanings.push('rule');
    if (/^\[[^\]\r\n]+\]:/.test(line)) meanings.push('definition');
    // Escaping its first char is enough: Obsidian then reads no fence
    if (/^(?:`{3,}(?![^\r\n]*`)|~{3})/.test(line)) meanings.push('fence');
  }
  return meanings;
}

/**
 * A note's source, rich in syntax both escaped and bare: an ordinary note's
 * Markdown, or a PDF snippet's escaped text, or both.
 */
const cutSourceArb = fc
  .array(
    fc.oneof(
      markdownishArb,
      markdownishArb.map((text) => Markdown.escape(text)),
      fc.constantFrom(
        'word#evil',
        'see #tag',
        'C# and',
        '# ',
        '## ',
        '##tag',
        '>#',
        '> ',
        '* ',
        '***',
        '_ _ _',
        '```',
        '~~~',
        '[a]: x',
        '[^1]: y',
        '- [ ] ',
        '2. ',
        '_b c_',
        '$x$',
        '\\#',
        '\\_',
        '\\'
      )
    ),
    { maxLength: 4 }
  )
  .map((parts) => parts.join(''));

/** Where a cut's text goes: the start of a note, or after a cloze delimiter. */
const intoArb = fc.constantFrom('note' as const, 'answer' as const);

/**
 * A cut of a source, from anywhere to anywhere after, for either place, its
 * ends off escape pairs as the managers snap them.
 */
const cutArb = cutSourceArb.chain((source) =>
  fc
    .tuple(fc.nat(source.length), fc.nat(source.length), intoArb)
    .map(([x, y, into]) => ({
      source,
      range: Markdown.snapOffEscapes(source, [Math.min(x, y), Math.max(x, y)]),
      into,
    }))
);

/** A cut of a source from anywhere to the end of that line, for either place. */
const lineCutArb = cutSourceArb.chain((source) =>
  fc.tuple(fc.nat(source.length), intoArb).map(([from, into]) => ({
    source,
    from,
    to: from + restOfLine(source, from).length,
    into,
  }))
);

/**
 * The text a cut of `source` reads as: whitespace from mid-line that would
 * start a note is dropped, as an indent it would be one.
 */
function cutText(
  source: string,
  [from, to]: readonly [number, number],
  into: 'note' | 'answer'
) {
  const text = source.slice(from, to);
  const midLine = from > 0 && !isLineBreak(source[from - 1]);
  return into === 'note' && midLine ? text.replace(/^[^\S\r\n]+/, '') : text;
}

/** Where the first char of {@link cutText} stands in `source`. */
const firstKept = (
  source: string,
  [from, to]: readonly [number, number],
  into: 'note' | 'answer'
) => to - cutText(source, [from, to], into).length;

/**
 * Each character of the first line of {@link Markdown.escapeCutStart}'s cut
 * of `source`, read where the cut goes, with what it forms there and what
 * it formed in `parentSource`, which holds `source` up to the cut's end at
 * least: none for a character escaped.
 */
function cutMeanings(
  source: string,
  [from, to]: readonly [number, number],
  into: 'note' | 'answer',
  parentSource = source
) {
  const cut = Markdown.escapeCutStart(source, [from, to], into);
  const before = into === 'answer' ? '(} ' : '';
  const child = before + unescape(cut);
  const childFlags = [...before].map(() => false).concat(escapedFlags(cut));
  const start = firstKept(source, [from, to], into);
  const at = readOffsets(parentSource)[start];
  // Where it starts a block after list or quote markers, it reads as at the
  // line's start: the markers, never escaped, are cut from the reading
  const markers = startsBlock(source, start)
    ? at - lineStartOf(unescape(parentSource), at)
    : 0;
  const parent =
    unescape(parentSource).slice(0, at - markers) +
    unescape(parentSource).slice(at);
  const parentFlags = escapedFlags(parentSource);
  parentFlags.splice(at - markers, markers);
  const first = at - markers;
  const firstLine = before.length + restOfLine(unescape(cut), 0).length;
  /**
   * `plain` with each escaped char but the one at `keep` read as a char no
   * rule takes for syntax, for the rules that look beside one: `^\[` is no
   * footnote, `e\.x/` no domain. Braces and parentheses stay: the plugin
   * reads cloze delimiters escaped or not, so `\}}` holds `}}`.
   */
  const masked = (plain: string, flags: boolean[], keep: number) =>
    plain
      .split('')
      .map((char, k) =>
        flags[k] && k !== keep && !'(){}'.includes(char) ? '' : char
      )
      .join('');
  const chars = [];
  for (let c = before.length; c < firstLine; c++) {
    const j = first + c - before.length;
    chars.push({
      char: child[c],
      c,
      escaped: childFlags[c],
      newlyEscaped: childFlags[c] && !parentFlags[j],
      // As it would be, left bare where it stands
      bare: meaningsAt(
        masked(child, childFlags, c),
        c,
        childFlags[c - 1] ?? false
      ),
      parent: parentFlags[j]
        ? []
        : meaningsAt(
            masked(parent, parentFlags, j),
            j,
            parentFlags[j - 1] ?? false
          ),
    });
  }
  return { cut, chars };
}

// #endregion

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
      expect(Markdown.stripLinks('a claim[^1][^2] here')).toBe('a claim here');
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

describe('LEGACY_ENTITIES', () => {
  it("holds the HTML standard's 106 entity names read without their `;`", () => {
    // Each is checked against Chromium's own decoding in e2e-tests/escape.spec.ts
    expect(new Set(LEGACY_ENTITIES).size).toBe(106);
    expect(LEGACY_ENTITIES).toEqual(
      expect.arrayContaining(['AMP', 'amp', 'not', 'sect', 'copy', 'yuml'])
    );
  });
});

describe('escape', () => {
  it('reads as the text it escapes, but for whitespace that starts a line', () => {
    fc.assert(
      fc.property(markdownishArb, (text) => {
        expect(unescape(Markdown.escape(text))).toBe(unindented(text));
      })
    );
  });

  it('leaves unescaped no character that could form syntax, by the rule table', () => {
    fc.assert(
      fc.property(markdownishArb, (text) => {
        const plain = unindented(text);
        const flags = escapedFlags(Markdown.escape(text));
        const unescapedSyntax = plain
          .split('')
          .map((char, j) => ({
            char,
            j,
            reasons: syntaxAt(plain, j, flags[j - 1] ?? false),
          }))
          .filter(({ j, reasons }) => !flags[j] && reasons.length > 0);
        expect(unescapedSyntax).toEqual([]);
      }),
      { numRuns: 500 }
    );
  });

  it('escapes nothing that could not form syntax', () => {
    fc.assert(
      fc.property(markdownishArb, (text) => {
        const plain = unindented(text);
        const flags = escapedFlags(Markdown.escape(text));
        const needless = plain
          .split('')
          .map((char, j) => ({ char, j }))
          .filter(
            ({ j }) =>
              flags[j] && syntaxAt(plain, j, flags[j - 1] ?? false).length === 0
          );
        expect(needless).toEqual([]);
      }),
      { numRuns: 500 }
    );
  });

  it('never holds a Templater tag or a cloze delimiter, which escapes do not hide', () => {
    fc.assert(
      fc.property(markdownishArb, (text) => {
        expect(Markdown.escape(text)).not.toMatch(/<%|\(\}|\{\)|\{\{|\}\}/);
      })
    );
  });

  it('starts no line with whitespace', () => {
    fc.assert(
      fc.property(markdownishArb, (text) => {
        for (const line of Markdown.escape(text).split(/\r\n?|\n/)) {
          expect(line).not.toMatch(/^[^\S\r\n]/);
        }
      })
    );
  });

  it('escapes the syntax a hostile PDF could hide in its text', () => {
    expect(Markdown.escape('![[note]] ![x](https://e.x/t.png) [[a|b]]')).toBe(
      String.raw`!\[\[note]] !\[x](https\://e.x/t.png) \[\[a\|b]]`
    );
    expect(Markdown.escape('#ir-card <b>x</b> &amp; `c` x ^id')).toBe(
      String.raw`\#ir-card \<b>x\</b> \&amp; \`c\` x \^id`
    );
    expect(Markdown.escape('$x$ [^1] x^[n]')).toBe(
      String.raw`\$x\$ \[^1] x\^\[n]`
    );
    expect(Markdown.escape('---\n> q\n  - a\n12. b\n3) c\r+ d\r\n=')).toBe(
      String.raw`\---` +
        '\n' +
        String.raw`\> q` +
        '\n' +
        String.raw`\- a` +
        '\n' +
        String.raw`12\. b` +
        '\n' +
        String.raw`3\) c` +
        '\r' +
        String.raw`\+ d` +
        '\r\n' +
        String.raw`\=`
    );
    expect(Markdown.escape('a (} b {) c {{d}} %%e%% ==f== ~~g~~ *h* _i_')).toBe(
      String.raw`a (\} b {\) c {\{d}\} \%\%e\%\% \=\=f\=\= \~\~g\~\~ \*h\* \_i\_`
    );
    // Code other plugins run once rendered, a DataviewJS line, say, needs code
    expect(Markdown.escape('`$= dv.x` ```dataviewjs ~~~js')).toBe(
      String.raw`\`\$= dv.x\` \`\`\`dataviewjs \~\~\~js`
    );
    expect(Markdown.escape('<%* tp.x %> <%+ y %>')).toBe(
      String.raw`\<\%\* tp.x %> \<\%+ y %>`
    );
    expect(Markdown.escape('(key:: value) a|b &#38; &notit; &section')).toBe(
      String.raw`(key\:\: value) a\|b \&\#38; \&notit; \&section`
    );
    expect(
      Markdown.escape('https://e.x mailto:a@b.co www.e.x WWW.e.x awww.e.x')
    ).toBe(
      String.raw`https\://e.x mailto\:a\@b.co www\.e.x WWW\.e.x awww\.e.x`
    );
    // What live preview links besides: a scheme in its list before anything
    // but a space, `www` with digits, a domain before a `/`, and an address
    // with any character before its `@`
    expect(
      Markdown.escape(
        'see arxiv.org/abs/1 doi:10.1/x tel:555 urn:isbn:1 ' +
          'javascript:alert(1) www1.e.x josé@example.com'
      )
    ).toBe(
      String.raw`see arxiv.org\/abs/1 doi\:10.1/x tel\:555 urn\:isbn:1 ` +
        String.raw`javascript\:alert(1) www1\.e.x josé\@example.com`
    );
    // A `<` before anything but whitespace, a digit, `=` or `-` could start
    // a tag or a link, an escape included
    expect(Markdown.escape('<<https://e.x> <\\x <é a<_ <')).toBe(
      String.raw`\<\<https\://e.x> \<\x \<é a\<\_ <`
    );
    expect(Markdown.escape('x < 5, <5, <-, <=, <\t1')).toBe(
      'x < 5, <5, <-, <=, <\t1'
    );
    expect(Markdown.escape('Note: see Note:see a:b 3:1 x.y/z (a)@b.co')).toBe(
      'Note: see Note:see a:b 3:1 x.y/z (a)@b.co'
    );
    // A scheme before one slash links too; a word that is no scheme does not
    expect(
      Markdown.escape('javascript:/x/ file:/etc/passwd https:/e.x/p Note:/x')
    ).toBe(String.raw`javascript\:/x/ file\:/etc/passwd https\:/e.x/p Note:/x`);
    // Nothing before an `@` at the start makes no address
    expect(Markdown.escape('@b.co')).toBe('@b.co');
    // Schemes from live preview's own list, each before a letter, digit
    // or `%`, and words that aren't
    expect(
      Markdown.escape(
        'geo:1 file:x magnet:x ssh:x skype:x spotify:x z39.50r:x ' +
          'soap.beeps:x DATA:x xmpp:%20 view-source:x chrome-extension:x'
      )
    ).toBe(
      String.raw`geo\:1 file\:x magnet\:x ssh\:x skype\:x spotify\:x z39.50r\:x ` +
        String.raw`soap.beeps\:x DATA\:x xmpp\:%20 view-source\:x chrome-extension\:x`
    );
    expect(Markdown.escape('note:x see:x ratio:x isbn:x Fig:3')).toBe(
      'note:x see:x ratio:x isbn:x Fig:3'
    );
    // A domain at the start of the text, ending in a digit, or after a `!`
    expect(Markdown.escape('a.bc/x 1.ab/x a.bc1/x x!.org/a @b.co')).toBe(
      String.raw`a.bc\/x 1.ab\/x a.bc1/x x!.org/a @b.co`
    );
    // Unicode whitespace indents a line in live preview too
    expect(
      Markdown.escape(
        'a\n\u00a0- b\n\u3000\u30001. c\n\u00a0\u00a0\u00a0\u00a0\u00a0d'
      )
    ).toBe('a\n' + String.raw`\- b` + '\n' + String.raw`1\. c` + '\nd');
    // A marker before whitespace of any kind
    expect(Markdown.escape('-\u00a0a\n+\tb\n1)\u3000c\n-')).toBe(
      String.raw`\-` +
        '\u00a0a\n' +
        String.raw`\+` +
        '\tb\n' +
        String.raw`1\)` +
        '\u3000c\n' +
        String.raw`\-`
    );
  });

  it('leaves alone what reads as itself where it is', () => {
    // Phase-1 cases Obsidian 1.13.7 reads as plain text in all three parsers
    expect(Markdown.escape('C# and #1, #2. #3) x # y')).toBe(
      'C# and #1, #2. #3) x # y'
    );
    expect(Markdown.escape('costs $5 and $10, x < 5, a <- b <= c, x > 5')).toBe(
      'costs $5 and $10, x < 5, a <- b <= c, x > 5'
    );
    expect(Markdown.escape('AT&T R&D Q&A S&P &Amp A & B 50% x = y ~ z')).toBe(
      'AT&T R&D Q&A S&P &Amp A & B 50% x = y ~ z'
    );
    expect(
      Markdown.escape('see [1], [2] and [Smith 2003] x^2 y C:\\Users\\a b')
    ).toBe(String.raw`see \[1], \[2] and \[Smith 2003] x^2 y C:\Users\a b`);
    expect(
      Markdown.escape('-5 degrees\n1.5 million\n+3 more\n= x\n3)x\nsnake_case')
    ).toBe('-5 degrees\n1.5 million\n+3 more\n= x\n3)x\nsnake_case');
    expect(Markdown.escape('f(x) {a, b} ({x}) a//b a:b')).toBe(
      'f(x) {a, b} ({x}) a//b a:b'
    );
  });

  it('escapes what could close math, start a tag or decode as an entity', () => {
    expect(Markdown.escape('US$5 ($5) $5\n$6 x$$y')).toBe(
      String.raw`US\$5 (\$5) $5` + '\n' + String.raw`\$6 x\$\$y`
    );
    expect(Markdown.escape('x #tag x\t#1st x\u00a0#a x #1/2 x #1_')).toBe(
      String.raw`x \#tag x` +
        '\t' +
        String.raw`\#1st x` +
        '\u00a0' +
        String.raw`\#a x \#1/2 x \#1\_`
    );
    expect(Markdown.escape('a<b a</ a<!x a<?x &copy2024 &AMP &x; &#x26')).toBe(
      String.raw`a\<b a\</ a\<!x a\<?x \&copy2024 \&AMP \&x; \&\#x26`
    );
    expect(Markdown.escape('x ^abc\na ^b c\nx^2')).toBe(
      String.raw`x \^abc` + '\na ^b c\n' + String.raw`x\^2`
    );
    expect(Markdown.escape('a\\.b a\\b a\\')).toBe(String.raw`a\\.b a\b a\\`);
  });

  it('draws the line where syntax ends, at the edges of each rule', () => {
    // Display math after a space; an inline footnote with more on its line
    expect(Markdown.escape('a $$ x^[n] y')).toBe(String.raw`a \$\$ x\^\[n] y`);
    // An entity's name runs to its `;` in letters and digits only
    expect(Markdown.escape('A & b; c &xy; &x1; &x-y;')).toBe(
      String.raw`A & b; c \&xy; \&x1; &x-y;`
    );
    // Reading view starts a tag after an escape, as after whitespace
    expect(Markdown.escape('##f [#t \\#u')).toBe(String.raw`\#\#f \[\#t \\\#u`);
    // No tag before the end of the text, nor of a number before it
    expect(Markdown.escape('x #')).toBe('x #');
    expect(Markdown.escape('x #1')).toBe('x #1');
    expect(Markdown.escape('x #12 y')).toBe('x #12 y');
    // A marker before the end of the text
    expect(Markdown.escape('+')).toBe(String.raw`\+`);
    expect(Markdown.escape('a\n1.')).toBe('a\n' + String.raw`1\.`);
    // At the start of the text, nothing comes before
    expect(Markdown.escape('$ x')).toBe(String.raw`\$ x`);
    expect(Markdown.escape('_a')).toBe(String.raw`\_a`);
  });
});

describe('escapeAround', () => {
  it('finds the range in what it escapes to, a character with its escape', () => {
    fc.assert(
      fc.property(textAndRangeArb, ({ text, range: [a, b] }) => {
        const escaped = Markdown.escapeAround(text, [a, b]);

        const [start, end] = escaped.range;
        expect(start).toBeLessThanOrEqual(end);
        expect(unescape(escaped.text)).toBe(unindented(text));
        expect(unescape(escaped.text.slice(0, start))).toBe(
          unindented(text.slice(0, a))
        );
        expect(unescape(escaped.text.slice(0, end))).toBe(
          unindented(text.slice(0, b))
        );
      })
    );
  });

  it('escapes by the rule table, and each character a rule could escape beside either end of the range', () => {
    fc.assert(
      fc.property(textAndRangeArb, ({ text, range: [a, b] }) => {
        const plain = unindented(text);
        const around = escapedFlags(Markdown.escapeAround(text, [a, b]).text);
        const ends = new Set(
          [a, b].map((end) => unindented(text.slice(0, end)).length)
        );
        const wrong = plain
          .split('')
          .map((char, j) => ({
            char,
            j,
            expected:
              syntaxAt(plain, j, around[j - 1] ?? false, ends).length > 0 ||
              ((ends.has(j) || ends.has(j + 1)) && CONTEXTUAL.includes(char)),
          }))
          .filter(({ j, expected }) => around[j] !== expected);
        expect(wrong).toEqual([]);
      }),
      { numRuns: 500 }
    );
  });

  it('escapes at least what escape does', () => {
    fc.assert(
      fc.property(textAndRangeArb, ({ text, range }) => {
        const around = escapedFlags(Markdown.escapeAround(text, range).text);
        const alone = escapedFlags(Markdown.escape(text));
        expect(alone.filter((escaped, j) => escaped && !around[j])).toEqual([]);
      })
    );
  });

  it('escapes beside the range what its delimiters would turn into syntax', () => {
    // `_` beside a cloze delimiter: italic in live preview
    expect(Markdown.escapeAround('a_b_c', [2, 3])).toEqual({
      text: String.raw`a\_b\_c`,
      range: [3, 4],
    });
    // A list marker the closing delimiter's space would complete
    expect(Markdown.escapeAround('a\n-b', [0, 3])).toEqual({
      text: 'a\n' + String.raw`\-b`,
      range: [0, 4],
    });
    // A tag the opening delimiter's space would start
    expect(Markdown.escapeAround('C#x', [1, 3])).toEqual({
      text: String.raw`C\#x`,
      range: [1, 4],
    });
    // An end only reaches the characters beside it
    expect(Markdown.escapeAround('x #1 y', [1, 1]).text).toBe('x #1 y');
    expect(Markdown.escapeAround('.x', [0, 0]).text).toBe(String.raw`\.x`);
    // Leading whitespace dropped from the range, its end beside the next char
    expect(Markdown.escapeAround('a\n  -b', [2, 4])).toEqual({
      text: 'a\n' + String.raw`\-b`,
      range: [2, 2],
    });
  });
});

describe('snapOffEscapes', () => {
  it('widens each end that splits an escape pair to take the pair whole, and leaves the others', () => {
    fc.assert(
      fc.property(backslashyRangeArb, ({ text, range: [from, to] }) => {
        const pairs = escapePairs(text);

        expect(Markdown.snapOffEscapes(text, [from, to])).toEqual([
          pairs.has(from) ? from - 1 : from,
          pairs.has(to) ? to + 1 : to,
        ]);
      }),
      { numRuns: 1000 }
    );
  });

  it('takes an escaped backslash for no escape', () => {
    // From the `#` of `\\#`: the backslash is escaped, the `#` is not
    expect(Markdown.snapOffEscapes(String.raw`\\#tag`, [2, 6])).toEqual([2, 6]);
    // From between the two backslashes of `\\`
    expect(Markdown.snapOffEscapes(String.raw`a\\b`, [2, 4])).toEqual([1, 4]);
    expect(Markdown.snapOffEscapes(String.raw`a\\b`, [0, 2])).toEqual([0, 3]);
    // The third backslash of `\\\#` escapes the `#`
    expect(Markdown.snapOffEscapes(String.raw`\\\#tag`, [3, 7])).toEqual([
      2, 7,
    ]);
  });

  it('snaps a start back before the backslash, and an end past the escaped char', () => {
    expect(Markdown.snapOffEscapes(String.raw`\#tag`, [1, 5])).toEqual([0, 5]);
    expect(Markdown.snapOffEscapes(String.raw`a \[1] b`, [0, 3])).toEqual([
      0, 4,
    ]);
    // A backslash before what is no punctuation escapes nothing
    expect(Markdown.snapOffEscapes(String.raw`C:\Users`, [3, 8])).toEqual([
      3, 8,
    ]);
    expect(Markdown.snapOffEscapes('a\\\nb', [2, 4])).toEqual([2, 4]);
  });

  describe('for an answer a cloze delimiter will open', () => {
    it('also moves its start back off any backslash that would escape the delimiter', () => {
      fc.assert(
        fc.property(backslashyRangeArb, ({ text, range: [from, to] }) => {
          const { pairs, escaping } = readBackslashes(text);

          expect(
            Markdown.snapOffEscapes(text, [from, to], { delimited: true })
          ).toEqual([
            escaping.has(from) ? from - 1 : from,
            pairs.has(to) ? to + 1 : to,
          ]);
        }),
        { numRuns: 1000 }
      );
    });

    it('starts before the backslash of `C:\\Users`, where `(}` would follow it', () => {
      expect(
        Markdown.snapOffEscapes(String.raw`C:\Users`, [3, 8], {
          delimited: true,
        })
      ).toEqual([2, 8]);
      expect(
        Markdown.snapOffEscapes(String.raw`C:\\Users`, [4, 9], {
          delimited: true,
        })
      ).toEqual([4, 9]);
    });
  });
});

describe('escapeCutStart', () => {
  it('reads as the cut, every escape kept, but for mid-line whitespace that would start a note', () => {
    fc.assert(
      fc.property(cutArb, ({ source, range, into }) => {
        const expected = cutText(source, range, into);

        const cut = Markdown.escapeCutStart(source, range, into);

        expect(unescape(cut)).toBe(unescape(expected));
        const kept = escapedFlags(expected);
        expect(escapedFlags(cut).filter((_, j) => kept[j])).toEqual(
          kept.filter(Boolean)
        );
      }),
      { numRuns: 1000 }
    );
  });

  it('changes nothing past the first line of the cut', () => {
    fc.assert(
      fc.property(cutArb, ({ source, range, into }) => {
        const expected = cutText(source, range, into);
        const rest = (text: string) => text.slice(restOfLine(text, 0).length);

        expect(rest(Markdown.escapeCutStart(source, range, into))).toBe(
          rest(expected)
        );
      }),
      { numRuns: 1000 }
    );
  });

  it('changes nothing of a cut from the start of a line', () => {
    fc.assert(
      fc.property(cutArb, ({ source, range, into }) => {
        const [from] = range;
        fc.pre(from === 0 || isLineBreak(source[from - 1]));

        expect(Markdown.escapeCutStart(source, range, into)).toBe(
          source.slice(...range)
        );
      }),
      { numRuns: 300 }
    );
  });

  it('escapes nothing of a cut where a block starts in its source, after list or quote markers', () => {
    fc.assert(
      fc.property(cutArb, ({ source, range, into }) => {
        fc.pre(startsBlock(source, firstKept(source, range, into)));

        expect(Markdown.escapeCutStart(source, range, into)).toBe(
          cutText(source, range, into)
        );
      }),
      { numRuns: 300 }
    );
  });

  it('forms no syntax at the start of the cut that its source, ending where it does, did not form there', () => {
    fc.assert(
      fc.property(cutArb, ({ source, range, into }) => {
        // What the cut's end does is out of scope: the source ends there too
        const { chars } = cutMeanings(
          source,
          range,
          into,
          source.slice(0, range[1])
        );

        const formed = chars.filter(
          ({ escaped, bare, parent }) =>
            !escaped && bare.some((meaning) => !parent.includes(meaning))
        );
        expect(formed).toEqual([]);
      }),
      { numRuns: 3000 }
    );
  });

  it('escapes nothing new that by the rules would form no syntax its source did not form there', () => {
    fc.assert(
      // To its line's end: a cut that ends sooner may escape what its end
      // would make syntax of, as a block id
      fc.property(lineCutArb, ({ source, from, to, into }) => {
        const { chars } = cutMeanings(source, [from, to], into);

        const needless = chars.filter(
          ({ newlyEscaped, bare, parent }) =>
            newlyEscaped && bare.every((meaning) => parent.includes(meaning))
        );
        expect(needless).toEqual([]);
      }),
      { numRuns: 3000 }
    );
  });

  describe('for a note', () => {
    const cut = (source: string, from: number, to = source.length) =>
      Markdown.escapeCutStart(source, [from, to], 'note');

    it('escapes a tag, heading, quote or list its start would form', () => {
      expect(cut('word#evil', 4)).toBe(String.raw`\#evil`);
      expect(cut('see # x', 4)).toBe(String.raw`\# x`);
      expect(cut('C# and x < 5', 1)).toBe(String.raw`\# and x < 5`);
      expect(cut('a > q', 2)).toBe(String.raw`\> q`);
      expect(cut('x - item', 2)).toBe(String.raw`\- item`);
      expect(cut('x + more', 2)).toBe(String.raw`\+ more`);
      expect(cut('a 1. list', 2)).toBe(String.raw`1\. list`);
      expect(cut('a 12) x', 3)).toBe(String.raw`2\) x`);
      expect(cut('x ---', 2)).toBe(String.raw`\---`);
      expect(cut('x ===', 2)).toBe(String.raw`\===`);
      expect(cut('see ## x', 4)).toBe(String.raw`\## x`);
      // A marker at the cut's end, which ends the note as whitespace would
      expect(cut('x +', 2)).toBe(String.raw`\+`);
      expect(cut('a 1.', 2)).toBe(String.raw`1\.`);
    });

    it('escapes the blocks an unescaped note can hold bare: a `*` list, a rule, a fence, a definition', () => {
      expect(cut('5 * 3', 2)).toBe(String.raw`\* 3`);
      expect(cut('x ***', 2)).toBe(String.raw`\***`);
      expect(cut('x * * *', 2)).toBe(String.raw`\* * *`);
      expect(cut('x ___', 2)).toBe(String.raw`\___`);
      expect(cut('x _ _ _', 2)).toBe(String.raw`\_ _ _`);
      expect(cut('x *', 2)).toBe(String.raw`\*`);
      expect(cut('x ~~~ y', 2)).toBe(String.raw`\~~~ y`);
      expect(cut('x ```js', 2)).toBe('\\```js');
      expect(cut('see [a]: https://e.x', 4)).toBe(
        String.raw`\[a]: https://e.x`
      );
      expect(cut('see [^1]: x', 4)).toBe(String.raw`\[^1]: x`);
    });

    it('leaves what forms no block, or what its source formed there too', () => {
      // Inline code, closed on its line
      expect(cut('x ```a``` y', 2)).toBe('```a``` y');
      expect(cut('x **a** y', 2)).toBe('**a** y');
      expect(cut('x ***a', 2)).toBe('***a');
      expect(cut('x ___a', 2)).toBe('___a');
      expect(cut('see [a](b): x', 4)).toBe('[a](b): x');
      // A tag after whitespace was one there, and math opens after anything
      expect(cut('see #tag', 4)).toBe('#tag');
      expect(cut('a\t#tag', 2)).toBe('#tag');
      expect(cut('see ##tag', 4)).toBe('##tag');
      // A backtick later on the line makes the run inline code, no fence
      expect(cut('x ```ab` c', 2)).toBe('```ab` c');
      // A number is no tag, nor a heading without its space
      expect(cut('see #1 x', 4)).toBe('#1 x');
      expect(cut('a#1, b', 1)).toBe('#1, b');
      expect(cut('a $x$ b', 2)).toBe('$x$ b');
      expect(cut('US$5 and 6$', 2)).toBe('$5 and 6$');
      expect(cut('x -5 and 1.5', 2)).toBe('-5 and 1.5');
      expect(cut('a  _b c_', 3)).toBe('_b c_');
    });

    it('escapes what its first escape would turn into a tag', () => {
      expect(cut('a##tag', 1)).toBe(String.raw`\#\#tag`);
      expect(cut('a###tag', 1)).toBe(String.raw`\#\#\#tag`);
      expect(cut('a>#tag', 1)).toBe(String.raw`\>\#tag`);
      expect(cut('x -#tag', 2)).toBe('-#tag');
      expect(cut('x ~~~#tag', 2)).toBe(String.raw`\~~~#tag`);
      expect(cut('a##1 x', 1)).toBe(String.raw`\##1 x`);
    });

    it('escapes a `_` taken from between letters, which could open emphasis', () => {
      expect(cut('a_b c_ d', 1)).toBe(String.raw`\_b c_ d`);
      expect(cut('snake_case', 5)).toBe(String.raw`\_case`);
    });

    it('drops mid-line whitespace that would indent it, and reads what follows as its start', () => {
      expect(cut('a    code', 1)).toBe('code');
      expect(cut('a \t# x', 1)).toBe(String.raw`\# x`);
      expect(cut('see #tag', 3)).toBe('#tag');
      expect(cut('a  \n  b', 1)).toBe('\n  b');
      expect(cut('a  ', 1)).toBe('');
    });

    it('re-escapes a start that splits an escape pair, as its source read it', () => {
      expect(cut(String.raw`a \#tag`, 3)).toBe(String.raw`\#tag`);
      expect(cut(String.raw`\> x`, 1)).toBe(String.raw`\> x`);
      expect(cut(String.raw`a\_#tag`, 2)).toBe(String.raw`\_#tag`);
      // A tag after an escaped char was one there
      expect(cut(String.raw`a\.#tag`, 3)).toBe('#tag');
    });

    it('leaves a start where a block starts in its source, after list or quote markers', () => {
      expect(cut('- # x', 2)).toBe('# x');
      expect(cut('> - x', 2)).toBe('- x');
      expect(cut('>#tag', 1)).toBe('#tag');
      expect(cut('- [ ] # x', 6)).toBe('# x');
      expect(cut('  1. > q', 5)).toBe('> q');
      expect(cut('  # x', 2)).toBe('# x');
      expect(cut('12. # x', 4)).toBe('# x');
      expect(cut('-  [ ] # x', 7)).toBe('# x');
      expect(cut('a\n# x', 2)).toBe('# x');
      expect(cut('a\r# x', 2)).toBe('# x');
      // But for whitespace from mid-line, which would make it code
      expect(cut('-    x', 1)).toBe('x');
    });

    it('leaves a cut from the start of a line, indent and all', () => {
      expect(cut('    # x', 0)).toBe('    # x');
      expect(cut('a\n    - x', 2)).toBe('    - x');
    });

    it('treats as no block start a marker that is no list, or one escaped', () => {
      expect(cut('-# x', 1)).toBe(String.raw`\# x`);
      expect(cut(String.raw`\- # x`, 3)).toBe(String.raw`\# x`);
      expect(cut('1.# x', 2)).toBe(String.raw`\# x`);
      expect(cut('- x[ ] # y', 7)).toBe(String.raw`\# y`);
    });

    it('treats as no block start an indent of four spaces or a tab: code, or a lazy continuation', () => {
      expect(cut('foo\n    # x', 8)).toBe(String.raw`\# x`);
      expect(cut('foo\n    > x', 8)).toBe(String.raw`\> x`);
      expect(cut('\t- # x', 3)).toBe(String.raw`\# x`);
      expect(cut('   \t# x', 4)).toBe(String.raw`\# x`);
      expect(cut('   - # x', 5)).toBe('# x');
    });

    it('takes time linear in the length of its source, its lines and its runs of `#`', () => {
      const timed = (source: string, from: number) => {
        const started = performance.now();
        cut(source, from);
        return performance.now() - started;
      };
      const best = (source: string, from: number) =>
        Math.min(...Array.from({ length: 5 }, () => timed(source, from)));
      // Sixteen times the text takes nowhere near 256 times as long
      for (const make of [
        // Long lines before the one it starts on
        (n: number) => `${'x'.repeat(n)}\n`.repeat(4) + 'a #tag',
        // A run of `#` escaped one by one after the first
        (n: number) => `a${'#'.repeat(n)}x`,
      ]) {
        const short = make(10_000);
        const long = make(160_000);
        const fromShort = short.lastIndexOf('a') + 1;
        const fromLong = long.lastIndexOf('a') + 1;
        expect(best(long, fromLong)).toBeLessThan(
          Math.max(best(short, fromShort), 0.5) * 64
        );
      }
      expect(cut('a###x', 1)).toBe(String.raw`\#\#\#x`);
    });

    it('escapes a block id its first word would make, ending the cut', () => {
      expect(cut('x^2 y', 1, 3)).toBe(String.raw`\^2`);
      expect(cut('x^2 y', 1)).toBe('^2 y');
    });

    it('reads a line break after its first char as the end of its line, not of the line before', () => {
      expect(cut('a #\nb', 2)).toBe(String.raw`\#` + '\nb');
      expect(cut('a #\rb', 2)).toBe(String.raw`\#` + '\rb');
    });

    it('changes only the first line', () => {
      expect(cut('a#b\n# c', 1)).toBe(String.raw`\#b` + '\n# c');
      expect(cut('x - a', 2, 3)).toBe(String.raw`\-`);
      expect(cut('x', 1)).toBe('');
    });
  });

  describe('for an answer, after a cloze delimiter and a space', () => {
    const cut = (source: string, from: number, to = source.length) =>
      Markdown.escapeCutStart(source, [from, to], 'answer');

    it('escapes a tag or emphasis its start would form', () => {
      expect(cut('word#evil', 4)).toBe(String.raw`\#evil`);
      expect(cut('a_b c_', 1)).toBe(String.raw`\_b c_`);
      expect(cut('a##x', 1)).toBe(String.raw`\#\#x`);
    });

    it('leaves what forms no syntax after a space, or what its source formed there too', () => {
      expect(cut('see #tag', 4)).toBe('#tag');
      expect(cut('#tag', 0)).toBe('#tag');
      expect(cut('- #tag', 2)).toBe('#tag');
      expect(cut('>#tag', 1)).toBe('#tag');
      expect(cut('a > q', 2)).toBe('> q');
      expect(cut('x - y', 2)).toBe('- y');
      expect(cut('a 1. b', 2)).toBe('1. b');
      expect(cut('see # x', 4)).toBe('# x');
      expect(cut('a $x$', 2)).toBe('$x$');
      expect(cut('a  b', 1)).toBe('  b');
      expect(cut('a#1 b', 1)).toBe('#1 b');
      expect(cut('_b c_', 0)).toBe('_b c_');
      expect(cut('see #1 x', 4)).toBe('#1 x');
    });
  });
});
