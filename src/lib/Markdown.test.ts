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
 * `ends`, offsets in `plain`, could put anything after a number. A tag
 * stops at a `\`, so a number before a char escaped there, `escapedAt` an
 * offset, is none.
 */
function syntaxAt(
  plain: string,
  j: number,
  prevEscaped: boolean,
  ends: ReadonlySet<number> = new Set(),
  escapedAt: (k: number) => boolean = () => false
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
    const number =
      digits > 0 &&
      (/^(?:[\s,.)\\]|$)/.test(after.slice(digits)) ||
        escapedAt(j + 1 + digits)) &&
      !endInNumber;
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
 * math after anything (the probe "reads syntax at a note's start…" in
 * e2e-tests/child-start.spec.ts), and nothing is there for it to close.
 */
function meaningsAt(
  text: string,
  at: number,
  prevEscaped: boolean,
  escapedAt: (k: number) => boolean = () => false
): string[] {
  const reasons = syntaxAt(text, at, prevEscaped, new Set(), escapedAt);
  const line = restOfLine(text, at);
  const atLineStart = at === 0 || isLineBreak(text[at - 1]);
  const meanings = reasons.flatMap((reason) => {
    if (reason === 'heading or tag') {
      // A tag as after whitespace, but for `#1`, which is none. Taken as
      // the rules take it, a `#` that could start one: `##tag` at a line's
      // start forms none in Obsidian 1.13.7, but escaping it is harmless
      const digits = /^\d*/.exec(line.slice(1))![0].length;
      const tag =
        /^#[^\s\d]/.test(line) ||
        (digits > 0 &&
          !/^(?:[\s,.)\\]|$)/.test(line.slice(1 + digits)) &&
          !escapedAt(at + 1 + digits));
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
    // Escaping its first char is enough: Obsidian then reads no fence. An
    // escaped backtick is in no run, but no backtick fence's line holds one
    let run = 0;
    while (line[run] === '`' && !escapedAt(at + run)) run++;
    if ((run >= 3 && !line.includes('`', run)) || /^~{3}/.test(line)) {
      meanings.push('fence');
    }
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
        '\\',
        // Spans an ordinary note holds bare: code, math, comments, and a
        // `%%` comment, which holds tags
        '`see #tag`',
        '``x #y``',
        '`a$b$`',
        '$a #b$',
        '$$a #b$$',
        '$x #b$1',
        '%% #c %%',
        '<!-- #c -->',
        '<!--',
        '<div>',
        '</TABLE>',
        '- > ```\n',
        '1.  > ```\n    > ',
        '\t> ',
        '\\`',
        '\n```\n',
        '\n~~~\n',
        // Lines that could underline the one before
        '\n---',
        '\n===',
        '\n-'
      )
    ),
    { maxLength: 4 }
  )
  .map((parts) => parts.join(''));

/**
 * The spans of `line` that hold code, math or an HTML comment, as Obsidian
 * 1.13.7 reads them (the probe "reads tags in spans, and underlines…" in
 * e2e-tests/child-start.spec.ts), each from just inside its opener to its
 * closer: the first to open holds what follows to its closer. A
 * backtick run closes at the next run as long, `$` before what isn't
 * whitespace at the next unescaped `$` after what isn't a space or a tab and
 * before what isn't a digit, `$$` at the next `$$`, `<!--` at the next
 * `-->`. Escaped or never closed, a delimiter is text. A `%%` comment is no
 * span here: the metadata cache reads the tags in one.
 */
function spansOf(line: string): [number, number][] {
  const spans: [number, number][] = [];
  const opener = /\\[!-/:-@[-`{-~]|`+|<!--|\$\$|\$(?=\S)/g;
  for (let m = opener.exec(line); m; m = opener.exec(line)) {
    const [delimiter] = m;
    if (delimiter[0] === '\\') continue;
    const inside = m.index + delimiter.length;
    let close = -1;
    if (delimiter[0] === '`') {
      const run = new RegExp(`(?<!\`)${delimiter}(?!\`)`, 'g');
      run.lastIndex = inside;
      close = run.exec(line)?.index ?? -1;
    } else if (delimiter === '$') {
      for (let c = inside; c < line.length && close < 0; c++) {
        const slashes = /\\*$/.exec(line.slice(0, c))![0].length;
        if (
          line[c] === '$' &&
          slashes % 2 === 0 &&
          !/[ \t]/.test(line[c - 1]) &&
          !/\d/.test(line[c + 1] ?? '')
        ) {
          close = c;
        }
      }
    } else {
      close = line.indexOf(delimiter === '<!--' ? '-->' : delimiter, inside);
    }
    if (close >= 0) {
      spans.push([inside, close]);
      // Past the closer: a comment's is `-->`, the others their opener
      opener.lastIndex = close + (delimiter === '<!--' ? 3 : delimiter.length);
    }
  }
  return spans;
}

/** How many columns `text` takes, a tab reaching the next multiple of four. */
const columnsOf = (text: string) =>
  text
    .split('')
    .reduce(
      (at, char) => (char === '\t' ? (Math.floor(at / 4) + 1) * 4 : at + 1),
      0
    );

/**
 * Where the content of `line` stands past its quote and list markers, in any
 * order and depth: how deep in quotes it is; past the last quote, the column
 * it starts at, how far whitespace indents it, and whether a list marker
 * comes there; whether one comes anywhere (`inList`); the content, and its
 * `offset` in `line`. A `>` indented past three columns at the start is no
 * quote's but in a list item, `inList`, whose lines indent it so.
 */
function partsOf(line: string, inList = false) {
  const lead = /^[ \t]*/.exec(line)![0];
  // Quote and list markers in any order, each after any whitespace, and the
  // whitespace after the last
  const markers =
    !inList && columnsOf(lead) > 3 && line[lead.length] === '>'
      ? lead
      : /^(?:[ \t]*(?:>[ \t]?|(?:[-+*]|\d{1,9}[.)])[ \t]+))*[ \t]*/.exec(
          line
        )![0];
  const quote = markers.lastIndexOf('>');
  const base =
    quote < 0
      ? 0
      : quote + 1 + (/[ \t]/.test(markers[quote + 1] ?? '') ? 1 : 0);
  const past = markers.slice(base);
  return {
    depth: markers.split('>').length - 1,
    column: columnsOf(past),
    indent: columnsOf(/^[ \t]*/.exec(past)![0]),
    listed: /[-+*.)]/.test(past),
    inList: inList || /[-+*.)]/.test(markers),
    content: line.slice(markers.length),
    offset: markers.length,
  };
}

/**
 * Where each line of `lines` stands as to fenced code, as Obsidian 1.13.7
 * reads it (the probe "reads tags in spans, and underlines…" in
 * e2e-tests/child-start.spec.ts): a fence of three or more backticks (none
 * after them) or tildes opens a block, past quote and list markers and
 * indented less than code unless a list holds it. A fence of its char, as
 * long or longer and alone, in as many quotes, with no list marker, at the
 * list item's column or up to three past it, or else indented less than
 * code, closes it. A line out of its quote or list item ends it, and is
 * read again as out of code.
 */
function fenceStates(
  lines: readonly string[]
): ('open' | 'code' | 'close' | undefined)[] {
  let open:
    | {
        run: string;
        depth: number;
        column: number;
        listed: boolean;
        inList: boolean;
      }
    | undefined;
  /** The fence `content` starts with, if any, and what follows it. */
  const fenceIn = (content: string) => {
    const run = /^(?:`{3,}|~{3,})/.exec(content)?.[0];
    return { run, after: run === undefined ? '' : content.slice(run.length) };
  };
  return lines.map((line) => {
    if (open !== undefined) {
      // Read in the list item the block was opened in, if it was
      const { depth, column, indent, listed, content } = partsOf(
        line,
        open.inList
      );
      const { run, after } = fenceIn(content);
      if (
        run !== undefined &&
        !listed &&
        depth === open.depth &&
        run[0] === open.run[0] &&
        run.length >= open.run.length &&
        after.trim() === '' &&
        (open.listed
          ? column >= open.column && column <= open.column + 3
          : column <= 3)
      ) {
        open = undefined;
        return 'close';
      }
      const leaves =
        line.trim() !== '' &&
        (depth < open.depth || (open.listed && indent < open.column));
      if (!leaves) return 'code';
      open = undefined;
    }
    const { depth, column, listed, inList, content } = partsOf(line);
    const { run, after } = fenceIn(content);
    if (
      run !== undefined &&
      (listed || column <= 3) &&
      !(run[0] === '`' && after.includes('`'))
    ) {
      open = { run, depth, column, listed, inList };
      return 'open';
    }
    return undefined;
  });
}

/** The lines of `text` before the one holding `j`, and that one. */
function linesTo(text: string, j: number) {
  const lines = text.slice(0, j).split(/\r\n?|\n/);
  const start = lineStartOf(text, j);
  return {
    above: lines.slice(0, -1),
    line: restOfLine(text, start),
    start,
  };
}

/** Whether the line holding `j` in `source` is in a fenced code block opened above it: not its fence, nor a line out of it. */
function inFenceAt(source: string, j: number): boolean {
  const { above, line } = linesTo(source, j);
  return fenceStates([...above, line]).at(-1) === 'code';
}

/**
 * Whether `j` in `source` lies where nothing shows as syntax: in a fenced
 * code block opened above its line, but for the fence that closes it, or
 * inside a span of {@link spansOf} on its line.
 */
function inCodeAt(source: string, j: number): boolean {
  const { line, start } = linesTo(source, j);
  if (inFenceAt(source, j)) return true;
  // A line that opens with a comment, past quote and list markers, and
  // indented less than code, is an HTML block past its `<!--`
  const { content, offset, listed, column } = partsOf(line);
  if (
    content.startsWith('<!--') &&
    (listed || column < 4) &&
    j - start >= offset + 4
  ) {
    return true;
  }
  return spansOf(line).some(
    ([inside, close]) => j - start >= inside && j - start < close
  );
}

/**
 * What reading view and the metadata cache make of a line, as far as an
 * underline cares: `setext` is a paragraph's one line its next line
 * underlines, `underline` that next line.
 */
type LineKind =
  | 'blank'
  | 'paragraph'
  | 'atx'
  | 'setext'
  | 'underline'
  | 'rule'
  | 'code'
  | 'list or quote'
  | 'definition'
  | 'html'
  | 'html block';

/**
 * The tags that open an HTML block, which interrupts a paragraph and holds
 * the lines after it to a blank one: CommonMark's type 6, but for `search`
 * and `frameset`, which the probe "reads tags in spans, and underlines…"
 * in e2e-tests/child-start.spec.ts didn't find so in Obsidian 1.13.7; of
 * any case there.
 */
const TYPE6_TAGS = new Set(
  (
    'address article aside base basefont blockquote body caption center col ' +
    'colgroup dd details dialog dir div dl dt fieldset figcaption figure ' +
    'footer form frame h1 h2 h3 h4 h5 h6 head header hr html iframe legend ' +
    'li link main menu menuitem nav noframes ol optgroup option p param ' +
    'section summary table tbody td tfoot th thead title tr track ul'
  ).split(' ')
);

/**
 * What reading view and the metadata cache make of each line of `text`,
 * read from the top, as Obsidian 1.13.7 was seen to (the probe "reads tags
 * in spans, and underlines…" in e2e-tests/child-start.spec.ts). A line of
 * only `-` or only `=`, unindented and with nothing after it, underlines a
 * paragraph of one line into a heading; under a longer one it
 * is text, or a list (`-`) or rule (`---`). A rule is three or more `-`,
 * `*` or `_`, with spaces after but no tab (`---\t` is text). A list or a
 * quote holds the lines after it lazily, and nothing underlines them. A
 * line indented four or more, or by a tab, is code where no paragraph is
 * open, and text where one is. A fenced block is code to its closing
 * fence. A model of the lines these tests make, not of all Markdown.
 */
function readLines(text: string): LineKind[] {
  const kinds: LineKind[] = [];
  const lines = linesOf(text);
  const fences = fenceStates(lines);
  /**
   * The open paragraph's lines: 0 for none, -1 for one in a list or quote,
   * -2 for an HTML block.
   */
  let open = 0;
  /** Whether the last line opened an HTML block where no paragraph was open. */
  let opensBlock = false;
  for (const [index, line] of lines.entries()) {
    // A comment alone on its line ends what comes before it, and is still
    // underlined as a paragraph of one line would be
    const underlines = open === 1 || kinds.at(-1) === 'html';
    const blockAfter = opensBlock;
    opensBlock = false;
    if (fences[index] !== undefined) {
      kinds.push('code');
      open = 0;
      continue;
    }
    // A block of HTML holds the lines to a blank one. One opened where no
    // paragraph was is underlined as one, but holds the lines after that
    if (
      line.trim() !== '' &&
      (open === -2 || (blockAfter && !(underlines && /^(?:-+|=+)$/.test(line))))
    ) {
      kinds.push('html block');
      open = -2;
      continue;
    }
    // Of any case, as the probe found
    const tag = /^ {0,3}<\/?([a-z][a-z\d]*)(?=[\s>]|\/>|$)/i.exec(line)?.[1];
    if (tag !== undefined && TYPE6_TAGS.has(tag.toLowerCase())) {
      if (open > 0 || open === -1) {
        kinds.push('html block');
        open = -2;
      } else {
        kinds.push('paragraph');
        open = 1;
        opensBlock = true;
      }
      continue;
    }
    const indent = /^[ \t]*/.exec(line)![0];
    // Odd whitespace starts no block either
    const deep = !/^ {0,3}\S/.test(line);
    const body = line.slice(indent.length);
    let kind: LineKind;
    if (line.trim() === '') {
      kind = 'blank';
    } else if (underlines && /^(?:-+|=+)$/.test(line)) {
      kinds[kinds.length - 1] = 'setext';
      kind = 'underline';
    } else if (deep) {
      kind = open === 0 ? 'code' : open < 0 ? 'list or quote' : 'paragraph';
    } else if (/^#{1,6}(?:[ \t]|$)/.test(body)) {
      kind = 'atx';
    } else if (body.startsWith('<!--') && body.trimEnd().endsWith('-->')) {
      // A comment alone on its line is an HTML block; `<!-- c --> x` is a
      // paragraph's text
      kind = 'html';
    } else if (/^([-*_])(?:[ \t]*\1){2,} *$/.test(body)) {
      kind = 'rule';
    } else if (/^(?:>|[-+*](?:\s|$)|\d{1,9}[.)](?:\s|$))/.test(body)) {
      kind = 'list or quote';
    } else if (open === 0 && /^\[[^\]]+\]:/.test(body)) {
      // Unprobed: what follows a link definition is taken for its
      // paragraph's, which nothing underlines, erring toward escaping
      kind = 'definition';
    } else {
      kind = open < 0 ? 'list or quote' : 'paragraph';
    }
    kinds.push(kind);
    if (kind === 'paragraph') open = open + 1;
    else if (kind === 'list or quote') open = -1;
    else if (kind === 'definition') open = 2;
    else open = 0;
  }
  return kinds;
}

/**
 * A line live preview underlines a paragraph with, of any length: a run of
 * `-` or `=` indented less than code, with spaces or tabs after it, but for
 * a lone `-` under more than one line, which is a list there too (the
 * probe "reads tags in spans, and underlines…" in
 * e2e-tests/child-start.spec.ts: `foo\nbar x\n---` and `milk\n  ---` are
 * headings there, `foo\nbar x\n-` a list).
 */
const livePreviewUnderlines = (line: string, longer: boolean) =>
  /^ {0,3}(?:-+|=+)[ \t]*$/.test(line) &&
  !(longer && /^ {0,3}-[ \t]*$/.test(line));

/**
 * The index of the line live preview underlines the paragraph `lines` start
 * with into a heading by, if it does: `kinds` reads it as one (a comment
 * alone on its line is taken for one too: unprobed there, erring toward
 * escaping), its later lines its text.
 */
function livePreviewUnderline(
  lines: readonly string[],
  kinds: LineKind[]
): number | undefined {
  if (!['paragraph', 'setext', 'html'].includes(kinds[0])) return undefined;
  for (let u = 1; u < lines.length; u++) {
    if (livePreviewUnderlines(lines[u], u > 1)) return u;
    if (kinds[u] !== 'paragraph') return undefined;
  }
  return undefined;
}

/**
 * Whether live preview made the line before line `u` of `lines` a heading
 * by it, `kinds` reading them: a paragraph's line over its underline.
 */
const livePreviewHeadsAt = (
  lines: readonly string[],
  kinds: LineKind[],
  u: number
) =>
  ['paragraph', 'setext', 'html'].includes(kinds[u - 1]) &&
  livePreviewUnderlines(
    lines[u] ?? '',
    kinds[u - 1] === 'paragraph' && kinds[u - 2] === 'paragraph'
  );

/**
 * Whether a cut's second line started a paragraph of its own in its source,
 * which its first line, a paragraph, would join where the cut goes: after a
 * heading, a rule, an underline, code or a comment alone on its line, which
 * end what comes before them. `sourceKinds` read the source from the cut's
 * first line, `startedKinds` the cut.
 */
const ownParagraphAfter = (sourceKinds: LineKind[], startedKinds: LineKind[]) =>
  startedKinds[0] === 'paragraph' &&
  startedKinds[1] === 'paragraph' &&
  ['paragraph', 'setext', 'html'].includes(sourceKinds[1]) &&
  !['paragraph', 'definition'].includes(sourceKinds[0]);

/** The lines of `text`. */
const linesOf = (text: string) => text.split(/\r\n?|\n/);

/** The index of the line holding `j` in `text`. */
const lineIndexOf = (text: string, j: number) =>
  linesOf(text.slice(0, j)).length - 1;

/**
 * A note from mid-line or the start of a line over one that could
 * underline it, under what could make it a paragraph of its own or not,
 * cut from anywhere on that line to anywhere after, its ends off escape
 * pairs as the managers snap them.
 */
const underlineCutArb = fc
  .record({
    above: fc.oneof(
      fc.constantFrom(
        '',
        'text\n',
        'x\n\n',
        '# h\n',
        '***\n',
        '```\nc\n```\n',
        '```\n',
        '~~~\n',
        '- a\n',
        '> a\n',
        '    code\n',
        'a\n===\n',
        'a\n---\n',
        'a\n-\n',
        'a\nb\n===\n',
        'a\n   ===  \n',
        '- a\n\n',
        '[a]: x\n',
        // HTML blocks, and fences in quotes in lists
        '<div>\n',
        'a\n<DIV>\n',
        '<!-- c -->\n',
        '- > ```\n',
        '1.  > ```\n',
        '> - ```\n',
        '- > ```\n  > a\n  > ```\n'
      ),
      markdownishArb.map((text) => `${text}\n`)
    ),
    line: fc.oneof(
      fc.constantFrom(
        '- buy milk',
        '# Title part',
        '> q x',
        'foo bar',
        '    code x',
        '1. a x',
        '12. a',
        '- # x',
        '> - x',
        '  plain x',
        'see #tag x',
        '\tx y',
        '`a #b` c',
        '<!-- a --> b',
        'a  ',
        '***',
        '_ _ _',
        '- - -',
        '===',
        '[a]: b',
        '<div>x y',
        '</table> x',
        '<p x y',
        '<divx> y',
        '  > see #t x',
        '    > q x'
      ),
      markdownishArb.filter((text) => linesOf(text).length === 1)
    ),
    under: fc.oneof(
      fc.constantFrom(
        '---',
        '===',
        '-',
        '--',
        '=',
        '  ---',
        '   ===  ',
        '    ---',
        '---\t',
        '-----  ',
        '- - -',
        '***',
        '---x',
        '--- bar',
        '- item',
        '==hi==',
        '',
        'next',
        '<div>',
        '<!-- c -->'
      ),
      fc
        .tuple(
          fc.constantFrom('', ' ', '   ', '    ', '\t'),
          fc.constantFrom('-', '='),
          fc.integer({ min: 1, max: 5 }),
          fc.constantFrom('', ' ', '\t', 'x', ' -')
        )
        .map(
          ([indent, char, length, after]) =>
            indent + char.repeat(length) + after
        )
    ),
    after: fc.constantFrom(
      '',
      '\nmore',
      '\n---',
      '\n',
      '\nbar\n---',
      '\n===\n---',
      '\n<div>\n---',
      '\n    bar\n===',
      '\n[b]: c\n---'
    ),
    lineBreak: fc.constantFrom('\n', '\r\n', '\r'),
  })
  .chain(({ above, line, under, after, lineBreak }) => {
    const breaks = (text: string) => text.replace(/\r\n?|\n/g, lineBreak);
    const lineStart = breaks(above).length;
    const source = breaks(above) + line + lineBreak + under + breaks(after);
    return fc
      .tuple(
        fc.integer({ min: lineStart, max: lineStart + line.length }),
        fc.oneof(fc.constant(source.length), fc.nat(source.length))
      )
      .map(([from, end]) => ({
        source,
        range: Markdown.snapOffEscapes(source, [from, Math.max(from, end)]),
      }));
  });

/** A cut of `source` made a note: its start escaped, and its second line seen to. */
const noteOf = (source: string, [from, to]: readonly [number, number]) =>
  Markdown.escapeCutUnderline(
    source,
    from,
    Markdown.escapeCutStart(source, [from, to], 'note')
  );

/**
 * A source about `n` long, thick with what a scan for spans, fences, markers
 * or underlines reads, and where a cut from it starts: its last `#`, or its
 * last `x`, or inside a run of backticks over an underline.
 */
const LINEAR_CUTS: ((n: number) => [string, number])[] = [
  // Openers that never close, each `$` after a space
  (n) => fromLast(`${'$a '.repeat(n / 3)}#t`),
  // Backtick runs of every length, few of them closed
  (n) => {
    let line = '';
    for (let length = 1; line.length < n; length++) {
      line += `${'`'.repeat(length % 50)}a`;
    }
    return fromLast(`${line} #t`);
  },
  // Comments never closed, display math and escapes
  (n) => fromLast(`${'<!--a$$b\\'.repeat(n / 9)} #t`),
  (n) => fromLast(`${'\\'.repeat(n)}$a #t$`),
  // Fences, and lines that are almost fences, above it
  (n) => fromLast(`${'```\n'.repeat(n / 4)}a #t`),
  (n) => fromLast(`${'```x`\n'.repeat(n / 6)}a #t`),
  (n) => fromLast(`${'- '.repeat(n / 2)}\n${'> '.repeat(n / 2)}\na #t`),
  // Long lines over its own, and an underline, and underlines above
  (n) => fromLast(`${'y'.repeat(n)}\n- a${'b'.repeat(n)} x\n---`),
  // A fence's backticks, which a lookahead would read again at each length
  (n) => [`q ${'`'.repeat(n)}x\` a\n---`, 2],
  (n) => fromLast(`${'a\n=\n'.repeat(n / 4)}foo x\n---`),
  // A fence's run before a line or paragraph separator, which `.` stops at,
  // in the lines above and on the second
  (n) =>
    fromLast(`${'`'.repeat(n)}${String.fromCharCode(0x2028)}\nab cx\n===\n`),
  (n) => fromLast(`ab cx\n${'~'.repeat(n)}${String.fromCharCode(0x2029)}\n`),
  // Many fences in quotes and lists, opened and left
  (n) => fromLast(`${'> ```\n- ```\n  x\n'.repeat(n / 17)}a #t`),
  // Quote and list markers nested deep, on one line and on many
  (n) => fromLast(`${'- > '.repeat(n / 4)}\`\`\`\na #t`),
  (n) => fromLast(`${'- > ```\n  > a\n'.repeat(n / 14)}a #t`),
  // Underlines down a paragraph, each escaped in turn, and lines above it
  (n) => fromLast(`- x foo\n${'===\n'.repeat(n / 4)}---`),
  (n) => fromLast(`${'a\n'.repeat(n / 2)}x foo\nbar\n---`),
  // Underlines down a fenced code block, each escaped in turn
  (n) => fromLast(`\`\`\`\nx\n${'---\n'.repeat(n / 4)}`),
];

/** `source`, cut from its last `#`, or its last `x` if it has none. */
function fromLast(source: string): [string, number] {
  return [
    source,
    source.includes('#') ? source.lastIndexOf('#') : source.lastIndexOf('x'),
  ];
}

/**
 * How many times longer `run` takes on `make(32_000)` than on
 * `make(2_000)`, the best of five tries each, the shorter taken as 0.1ms at
 * least. Linear, it is about 16; quadratic, about 256. Sizes this small
 * keep it quick under Stryker, whose instrumentation slows both alike.
 */
function timeRatio(
  make: (n: number) => [string, number],
  run: (source: string, from: number) => unknown
): number {
  const best = (n: number) => {
    const [source, from] = make(n);
    return Math.min(
      ...Array.from({ length: 5 }, () => {
        const started = performance.now();
        run(source, from);
        return performance.now() - started;
      })
    );
  };
  return best(32_000) / Math.max(best(2_000), 0.1);
}

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
  // Cut from mid-line in code, math or a comment, its first char was no
  // syntax. What follows it there is a split span's, out of scope as an end
  // is: it is read by the rules, as they read it in the source. Spans are
  // read in the whole source, which an end cut short could close
  const coded =
    from > 0 && !isLineBreak(source[from - 1]) && inCodeAt(source, start);
  // A fenced code block's line starts no block, whatever its rules say
  const fenced = coded && inFenceAt(source, start);
  // Where it starts a block after list or quote markers, it reads as at the
  // line's start: the markers, never escaped, are cut from the reading
  const markers =
    !coded && startsBlock(source, start)
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
   * reads cloze delimiters escaped or not, so `\}}` holds `}}`. So do
   * backticks: a backtick fence's line holds none after its run, escaped or
   * not, so `` ```\` `` opens none.
   */
  const masked = (plain: string, flags: boolean[], keep: number) =>
    plain
      .split('')
      .map((char, k) =>
        flags[k] && k !== keep && !'(){}`'.includes(char) ? '' : char
      )
      .join('');
  const chars = [];
  for (let c = before.length; c < firstLine; c++) {
    const j = first + c - before.length;
    const inCode = coded && c === before.length;
    // An escaped first char is read with what follows it bare: what its
    // escape makes escaped after it (`\&\#38;`) would be bare without it
    const flags =
      c === before.length && childFlags[c]
        ? childFlags.map((flag, k) => flag && k <= c)
        : childFlags;
    const bare = meaningsAt(
      masked(child, flags, c),
      c,
      flags[c - 1] ?? false,
      (k) => k !== c && (flags[k] ?? false)
    );
    // Math opens at a `$` before what isn't whitespace, after anything: where
    // the source held it in code, that is math it didn't show
    if (inCode && child[c] === '$' && /\S/.test(child[c + 1] ?? '')) {
      bare.push('math');
    }
    chars.push({
      char: child[c],
      c,
      escaped: childFlags[c],
      newlyEscaped: childFlags[c] && !parentFlags[j],
      // As it would be, left bare where it stands
      bare,
      parent:
        parentFlags[j] || inCode
          ? []
          : meaningsAt(
              masked(parent, parentFlags, j),
              j,
              parentFlags[j - 1] ?? false,
              (k) => k !== j && (parentFlags[k] ?? false)
            ).filter((meaning) => !(fenced && BLOCKS.has(meaning))),
    });
  }
  return { cut, chars };
}

/** The meanings of {@link meaningsAt} that only a line's start can hold. */
const BLOCKS: ReadonlySet<string> = new Set([
  'heading',
  'quote',
  'list',
  'ordered list',
  'setext or rule',
  'rule',
  'definition',
  'fence',
]);

/** Cuts over a line that could underline the first, and cuts of any note. */
const noteCutArb = fc.oneof(
  underlineCutArb,
  cutArb.map(({ source, range }) => ({ source, range }))
);

/**
 * `text` without the blank lines and comments alone on their lines it starts
 * with, which a note reads past, and how many lines there were.
 */
function pastBlankLines(text: string) {
  let rest = text;
  let lines = 0;
  for (;;) {
    const blank = /^(?:[^\S\r\n]*(?:\r\n?|\n))*/.exec(rest)![0];
    rest = rest.slice(blank.length);
    lines += linesOf(blank).length - 1;
    // A comment alone on its line, which nothing underlines after it, ends
    // what comes before what follows it too: the paragraph after it starts
    // the note as well
    const line = /^[^\r\n]*(?:\r\n?|\n)/.exec(rest)?.[0];
    if (line === undefined || readLines(rest)[0] !== 'html') break;
    rest = rest.slice(line.length);
    lines++;
  }
  return { text: rest, lines };
}

/**
 * What a cut of `source` makes, its start escaped and then its second line
 * seen to, past the blank lines it starts with, and the source's lines its
 * first line after them stands on and after, read whole.
 */
function reading(source: string, range: readonly [number, number]) {
  const whole = Markdown.escapeCutStart(source, range, 'note');
  const started = pastBlankLines(whole);
  const p1 = lineIndexOf(source, range[0]) + started.lines;
  return {
    started: started.text,
    // Past the lines the cut was read past, which the child starts with too
    child: noteOf(source, range).slice(whole.length - started.text.length),
    sourceKinds: readLines(source).slice(p1),
    sourceLines: linesOf(source).slice(p1),
  };
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
    expect(Markdown.escape('x #1\\ y')).toBe('x #1\\ y');
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

  it('escapes nothing of a cut where a block starts in its source, after list or quote markers, out of code', () => {
    fc.assert(
      fc.property(cutArb, ({ source, range, into }) => {
        const start = firstKept(source, range, into);
        const midLine = range[0] > 0 && !isLineBreak(source[range[0] - 1]);
        fc.pre(
          startsBlock(source, start) && !(midLine && inCodeAt(source, start))
        );

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
      expect(cut('x ```\\` c', 2)).toBe('```\\` c');
      expect(cut('x ``\\` c', 2)).toBe('``\\` c');
      // A number is no tag, nor a heading without its space
      expect(cut('see #1 x', 4)).toBe('#1 x');
      expect(cut('a#1, b', 1)).toBe('#1, b');
      // A tag stops at a `\`, as Obsidian's own pattern has it
      expect(cut('a#1\\. b', 1)).toBe('#1\\. b');
      expect(cut('a#1\\a b', 1)).toBe('#1\\a b');
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
      /** `source`, cut from just after its last `a`. */
      const afterLastA = (source: string): [string, number] => [
        source,
        source.lastIndexOf('a') + 1,
      ];
      // Sixteen times the text takes nowhere near 256 times as long
      for (const make of [
        // Long lines before the one it starts on
        (n: number) => afterLastA(`${'x'.repeat(n)}\n`.repeat(4) + 'a #tag'),
        // A run of `#` escaped one by one after the first
        (n: number) => afterLastA(`a${'#'.repeat(n)}x`),
      ]) {
        expect(
          timeRatio(make, (source, from) => cut(source, from))
        ).toBeLessThan(64);
      }
      expect(cut('a###x', 1)).toBe(String.raw`\#\#\#x`);
    });

    it('takes time linear in the length of its source, however full of span delimiters, fences and markers', () => {
      // Sixteen times the text takes nowhere near 256 times as long
      for (const make of LINEAR_CUTS) {
        expect(
          timeRatio(make, (source, from) => cut(source, from))
        ).toBeLessThan(64);
      }
      expect(cut(...LINEAR_CUTS[0](30))).toBe('#t');
      expect(cut(...LINEAR_CUTS[3](4))).toBe(String.raw`\#t$`);
      expect(cut(...LINEAR_CUTS[4](8))).toBe('#t');
      expect(cut(...LINEAR_CUTS[5](12))).toBe('#t');
      expect(cut(...LINEAR_CUTS[6](20))).toBe('#t');
      const [backticks, from] = LINEAR_CUTS[8](12);
      expect(cut(backticks, from)).toBe(backticks.slice(from));
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
      // Over a line that could underline it: see escapeCutUnderline
      expect(cut('- buy milk\n---', 6)).toBe('milk\n---');
    });

    it("leaves a cut from inside a list's number, which starts the list its source held", () => {
      expect(cut('12.', 1)).toBe('2.');
      expect(cut('12. x', 1)).toBe('2. x');
      expect(cut('- 123) x', 3)).toBe('23) x');
      // But for one that holds no list there
      expect(cut('a 12. x', 3)).toBe(String.raw`2\. x`);
      expect(cut('1234567890. x', 1)).toBe(String.raw`234567890\. x`);
      expect(cut('12.x', 1)).toBe('2.x');
    });

    describe('from inside inline code, math or an HTML comment, which shows no syntax', () => {
      it('escapes a tag, or whatever else its start would form', () => {
        expect(cut('`see #tag`', 5)).toBe(String.raw`\#tag` + '`');
        expect(cut('a ``x #y`` b', 6)).toBe('\\#y`` b');
        expect(cut('a ``` #b ``` c', 6)).toBe('\\#b ``` c');
        expect(cut('$a #b c$', 3)).toBe(String.raw`\#b c$`);
        expect(cut('$$a #b$$', 4)).toBe(String.raw`\#b$$`);
        expect(cut('a <!-- #b --> c', 7)).toBe(String.raw`\#b --> c`);
        expect(cut('a <!--#b-->', 6)).toBe(String.raw`\#b-->`);
        expect(cut('`a <b>`', 3)).toBe(String.raw`\<b>` + '`');
        expect(cut('`a ##b`', 3)).toBe(String.raw`\#\#b` + '`');
      });

      it('escapes a `$` that would open math there', () => {
        expect(cut('`a$b$c`', 2)).toBe(String.raw`\$b$c` + '`');
        expect(cut('a <!-- $x$ -->', 7)).toBe(String.raw`\$x$ -->`);
        expect(cut('`a $$b$$`', 3)).toBe(String.raw`\$$b$$` + '`');
        expect(cut('`a $ b`', 3)).toBe('$ b`');
      });

      it('escapes a backslash before what it escapes nothing, at a line end in code', () => {
        expect(cut('<!--\\\n---', 4, 5)).toBe('\\\\');
        expect(cut('`a \\ b`', 3, 4)).toBe('\\\\');
      });

      it('keeps an escape whole, though code shows its backslash', () => {
        expect(cut('`a \\#b`', 3)).toBe('\\#b`');
        expect(cut('`x \\&Ouml`', 3)).toBe('\\&Ouml`');
      });

      it('reads the span opened first, and honors escapes', () => {
        expect(cut('$a `#b` c$', 4)).toBe(String.raw`\#b` + '` c$');
        expect(cut('`a$b #c$`', 5)).toBe(String.raw`\#c$` + '`');
        expect(cut('`<!--` #b -->', 7)).toBe('#b -->');
        expect(cut('$a$$b #c$', 6)).toBe(String.raw`\#c$`);
        expect(cut('\\``a #b``', 5)).toBe('#b``');
        expect(cut('\\```a #b``', 6)).toBe('\\#b``');
        expect(cut('a \\<!-- #b -->', 8)).toBe('#b -->');
      });

      it('leaves a tag outside every span, in one never closed, or in a `%%` comment, whose tags the cache reads', () => {
        expect(cut('`a` #b `c`', 4)).toBe('#b `c`');
        expect(cut('a $b$ #c $d$', 6)).toBe('#c $d$');
        expect(cut('a <!--a--> #c', 11)).toBe('#c');
        expect(cut('a <!-- a <!-- b --> #c', 20)).toBe('#c');
        expect(cut('\\`a #b`', 4)).toBe('#b`');
        expect(cut('\\$a #b$', 4)).toBe('#b$');
        expect(cut('a``b #c`', 5)).toBe('#c`');
        // Math never opens before whitespace, nor closes after it or before a digit
        expect(cut('$ a #b$', 4)).toBe('#b$');
        expect(cut('$a #b $', 3)).toBe('#b $');
        expect(cut('$x #b$1', 3)).toBe('#b$1');
        expect(cut('x$ #b$', 3)).toBe('#b$');
        expect(cut('a $$ #b', 5)).toBe('#b');
        expect(cut('a <!-- #b', 7)).toBe('#b');
        expect(cut('a <!-- a <!-- #b', 14)).toBe('#b');
        expect(cut('%% see #x %%', 7)).toBe('#x %%');
        expect(cut('%%a #b%% #c', 4)).toBe('#b%% #c');
      });

      it('reads escapes before a `$`, `$$` before a space, every comment on its line, and lines past the first', () => {
        // An escaped `$` closes nothing; one after an escaped backslash does
        expect(cut('$a\\$ #b$', 5)).toBe(String.raw`\#b$`);
        expect(cut('$a\\\\$ #b$', 6)).toBe('#b$');
        // Display math opens before a space
        expect(cut('$$ #b $$', 3)).toBe(String.raw`\#b $$`);
        // A closed comment leaves the next to be read
        expect(cut('a <!--x--> <!-- #b -->', 16)).toBe(String.raw`\#b -->`);
        // A delimiter's own char is syntax, not code
        expect(cut('a `` x ``', 3)).toBe('` x ``');
        // On a line past the first
        expect(cut('x\n`a #b`', 5)).toBe(String.raw`\#b` + '`');
        expect(cut('x\n* <!-- #c -->', 4)).toBe('<!-- #c -->');
        // Code holds a `$` at the cut's end, which opens nothing
        expect(cut('`a $ b`', 3, 4)).toBe('$');
      });

      it('reads a line that opens an HTML comment as an HTML block, to its end', () => {
        expect(cut('<!-- a --> #c', 11)).toBe(String.raw`\#c`);
        expect(cut('   <!-- a #c', 10)).toBe(String.raw`\#c`);
        expect(cut('a\n    <!-- a #c', 13)).toBe('#c');
        // Code from just past its `<!--`, closed or not
        expect(cut('<!--#b x', 4)).toBe(String.raw`\#b x`);
        expect(cut('<!--*b x', 4)).toBe(String.raw`\*b x`);
        // Inline code from just past its opener
        expect(cut('`*b` x', 1)).toBe(String.raw`\*b` + '` x');
        // In a list item or a quote too
        expect(cut('- <!-- c --> #tag', 13)).toBe(String.raw`\#tag`);
        expect(cut('> <!-- c --> #tag', 13)).toBe(String.raw`\#tag`);
        // The `<!--` itself was syntax, a comment where it goes too
        expect(cut('* <!-- #c -->', 2)).toBe('<!-- #c -->');
      });

      it('leaves a delimiter, which was syntax, and a `$` that closed math: pair splitting', () => {
        expect(cut('`code` rest', 5)).toBe('` rest');
        expect(cut('$a$b and c$', 2)).toBe('$b and c$');
        expect(cut('a <!-- b --> c', 4)).toBe('-- b --> c');
      });
    });

    describe('from inside a fenced code block', () => {
      it('escapes what its start would form, and reads no block start there', () => {
        expect(cut('```\nsee #tag\n```', 8)).toBe(String.raw`\#tag` + '\n```');
        expect(cut('~~~\nsee #tag\n~~~', 8)).toBe(String.raw`\#tag` + '\n~~~');
        expect(cut('```\n- # x\n```', 6)).toBe(String.raw`\# x` + '\n```');
        expect(cut('- ```\n  a #b', 10)).toBe(String.raw`\#b`);
        // Never closed, it runs to the end
        expect(cut('```js\nsee #t', 10)).toBe(String.raw`\#t`);
        // Only a fence as long, of the same char and alone, closes it
        expect(cut('````\n```\nsee #t', 13)).toBe(String.raw`\#t`);
        expect(cut('```\n~~~\nsee #t', 12)).toBe(String.raw`\#t`);
        expect(cut('```\n``` x\nsee #t', 14)).toBe(String.raw`\#t`);
        // A fence in a quote or list closes only there; one with a line
        // separator after it is still one
        expect(cut('```\n> ```\nx #tag\n```', 12)).toBe(
          String.raw`\#tag` + '\n```'
        );
        expect(cut('```\n    ```\nx #tag\n```', 14)).toBe(
          String.raw`\#tag` + '\n```'
        );
        expect(cut('> ```\n> x #tag\n> ```\ny #t', 10)).toBe(
          String.raw`\#tag` + '\n> ```\ny #t'
        );
        expect(cut('- ```\n  x #t\n```\ny #u', 10)).toBe(
          String.raw`\#t` + '\n```\ny #u'
        );
        expect(cut(`\`\`\`${String.fromCharCode(0x2028)}x\nfoo #t`, 10)).toBe(
          String.raw`\#t`
        );
        // An entity, and the tag its escape would leave after it
        expect(cut('\n```\nx&GT&#38;', 9)).toBe(String.raw`\&\#38;`);
      });

      it('leaves a start after the block closes, or in no block', () => {
        expect(cut('```\nx\n```\nsee #tag', 14)).toBe('#tag');
        expect(cut('```\nx\n`````\nsee #tag', 16)).toBe('#tag');
        expect(cut('```a`\nsee #t', 10)).toBe('#t');
        expect(cut('a ```\nsee #t', 10)).toBe('#t');
        // Closed in its quote or list item, or left with them
        expect(cut('> ```\n> x #tag\n> ```\ny #t', 23)).toBe('#t');
        expect(cut('- ```\n  x #t\n  ```\ny #u', 21)).toBe('#u');
        expect(cut('```\n  ```\ny #u', 12)).toBe('#u');
        expect(cut('> ```\n> x\ny #t', 12)).toBe('#t');
      });

      it('reads quotes, list items and their indents as Obsidian does for each fence', () => {
        // A quote's `>` after up to three spaces, with or without a space
        expect(cut('   > ```\n   > a #b', 16)).toBe(String.raw`\#b`);
        // A `>` past three columns of indent is code's at the top, but a
        // quote's in a list item, whose lines indent it so
        expect(cut('    > ```\n    > a #b', 18)).toBe('#b');
        expect(cut('    > ```\n> x #b', 14)).toBe('#b');
        expect(cut('> ```\n    > x #t', 14)).toBe('#t');
        expect(cut('    > <!-- #b', 11)).toBe('#b');
        expect(cut('1.  > ```\n    > x #t', 18)).toBe(String.raw`\#t`);
        // Quote and list markers in any order and depth
        expect(cut('- > ```\n  > see #tag\n  > ```\ny #u', 16)).toBe(
          String.raw`\#tag` + '\n  > ```\ny #u'
        );
        expect(cut('- > ```\n  > see #tag\n  > ```\ny #u', 31)).toBe('#u');
        expect(cut('> - ```\n>   x #t\n>   ```\ny #u', 14)).toBe(
          String.raw`\#t` + '\n>   ```\ny #u'
        );
        expect(cut('> - ```\n>   x #t\n>   ```\ny #u', 27)).toBe('#u');
        expect(cut('- > - ```\n  >   x #t', 18)).toBe(String.raw`\#t`);
        // A new list item in the quote ends the one the block was in
        expect(cut('> - ```\n> - x #t', 14)).toBe('#t');
        // A tab before a `>`; a list item's indent counts its first non-space
        // char, a tab to the next multiple of four columns
        expect(cut('> \t> ```\n> \t> a #b', 16)).toBe(String.raw`\#b`);
        expect(cut('\t> ```\n\t> a #b', 12)).toBe('#b');
        expect(cut('   > ```\n   > a #b', 16)).toBe(String.raw`\#b`);
        expect(cut('- ```\n- - x #t', 12)).toBe('#t');
        expect(cut('1.  ```\n\tx #t', 11)).toBe(String.raw`\#t`);
        expect(cut('1.   ```\n \tx #t', 13)).toBe('#t');
        expect(cut('>```\n>a #b', 8)).toBe(String.raw`\#b`);
        // Opened indented less than code, or in a list item at any column
        expect(cut('   ```\nx #t', 9)).toBe(String.raw`\#t`);
        expect(cut('    ```\nx #t', 10)).toBe('#t');
        expect(cut('10. ```\n    x #t', 14)).toBe(String.raw`\#t`);
        expect(cut('-  ```\n   x #t', 12)).toBe(String.raw`\#t`);
        // A tilde fence may hold a backtick after it
        expect(cut('~~~ a`b\nx #t', 10)).toBe(String.raw`\#t`);
        // Closed by a fence indented less than code, spaces after it
        expect(cut('```\n   ```\nx #t', 13)).toBe('#t');
        expect(cut('```\n```  \nx #t', 12)).toBe('#t');
        // In a list item, at its column up to three past it; a line out of
        // the item ends the block, and may open another; a blank line doesn't
        expect(cut('- ```\n     ```\n  x #t', 19)).toBe('#t');
        expect(cut('- ```\n      ```\n  x #t', 20)).toBe(String.raw`\#t`);
        expect(cut('- ```\n ```\n  x #t', 15)).toBe(String.raw`\#t`);
        expect(cut('- ```\nx #t', 8)).toBe('#t');
        expect(cut('- ```\n  x #t\n```\ny #u', 19)).toBe(String.raw`\#u`);
        expect(cut('- ```\n\n  x #t', 11)).toBe(String.raw`\#t`);
        expect(cut('- ```\n \n  x #t', 12)).toBe(String.raw`\#t`);
        // A list's number in code is no list
        expect(cut('```\n12. x', 5)).toBe(String.raw`2\. x`);
        // Spaces before a nested quote's `>`; the space or tab after a `>`
        // is its own, and a tab reaches the next multiple of four columns
        expect(cut('>  > ```\n>  > a #b', 15)).toBe(String.raw`\#b`);
        expect(cut('>    ```\n> x #t', 13)).toBe(String.raw`\#t`);
        expect(cut('>\t   ```\n> x #t', 13)).toBe(String.raw`\#t`);
        expect(cut('\t```\nx #t', 7)).toBe('#t');
        expect(cut('  \t```\nx #t', 9)).toBe('#t');
        // A closer at the list item's own column, the item going on
        expect(cut('- ```\n  x\n  ```\n  y #u', 19)).toBe('#u');
      });

      it('leaves a cut from the start of a line in one: a partial code block', () => {
        expect(cut('```\n#tag\n```', 4)).toBe('#tag\n```');
      });
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
      expect(cut('%% see #x %%', 7)).toBe('#x %%');
    });

    it('escapes a tag from inside inline code, math, an HTML comment or a code block', () => {
      expect(cut('`see #tag`', 5)).toBe(String.raw`\#tag` + '`');
      expect(cut('see $a #b$ c', 7)).toBe(String.raw`\#b$ c`);
      expect(cut('a <!-- #x -->', 7)).toBe(String.raw`\#x -->`);
      expect(cut('```\nsee #tag\n```', 8)).toBe(String.raw`\#tag` + '\n```');
    });
  });
});

describe('escapeCutUnderline', () => {
  /** A cut of `source` made a note, from `from` to `to`. */
  const note = (source: string, from: number, to = source.length) =>
    noteOf(source, [from, to]);

  it('sets a rule apart by a blank line, where the source did not underline the line above it', () => {
    expect(note('- buy milk\n---', 6)).toBe('milk\n\n---');
    expect(note('> q x\n---', 4)).toBe('x\n\n---');
    expect(note('# T x\n-----  ', 4)).toBe('x\n\n-----  ');
    expect(note('1. a x\n---', 5)).toBe('x\n\n---');
    expect(note('    code x\n---', 9)).toBe('x\n\n---');
    expect(note('- milk\n  ---', 2)).toBe('milk\n\n  ---');
    expect(note('_ _ _\n---', 1)).toBe('_ _\n\n---');
    // Reading view and the cache underline a paragraph of one line only
    expect(note('foo\nbar x\n---', 8)).toBe('x\n\n---');
    expect(note('- a\nfoo x\n---', 8)).toBe('x\n\n---');
    expect(note('a\n   ===  \nfoo x\n---', 14)).toBe('x\n\n---');
    expect(note('- milk\r\n---', 2)).toBe('milk\r\n\r\n---');
    expect(note('- milk\r---', 2)).toBe('milk\r\r---');
  });

  it('escapes any other underline, which was text there, or a list', () => {
    expect(note('# Title part\n===', 8)).toBe('part\n' + String.raw`\===`);
    expect(note('> q x\n===', 4)).toBe('x\n' + String.raw`\===`);
    expect(note('- milk\n--', 2)).toBe('milk\n' + String.raw`\--`);
    expect(note('- milk\n-', 2)).toBe('milk\n' + String.raw`\-`);
    expect(note('- milk\n=', 2)).toBe('milk\n' + String.raw`\=`);
    expect(note('***\n-', 1)).toBe('**\n' + String.raw`\-`);
    expect(note('- milk\n   ===  ', 2)).toBe('milk\n   ' + String.raw`\===  `);
    // Reading view takes no rule with a tab after it
    expect(note('- milk\n---\t', 2)).toBe('milk\n' + String.raw`\---` + '\t');
    expect(note('foo\nbar x\n===', 8)).toBe('x\n' + String.raw`\===`);
  });

  it('reads the second line whole, though the cut ends in it', () => {
    expect(note('x foo\n- item', 2, 7)).toBe('foo\n' + String.raw`\-`);
    expect(note('x foo\n- item', 2, 8)).toBe('foo\n' + String.raw`\- `);
    expect(note('x foo\n--- bar', 2, 9)).toBe('foo\n' + String.raw`\---`);
    expect(note('> foo\n---x', 2, 9)).toBe('foo\n' + String.raw`\---`);
    expect(note('x foo\n==hi== there', 2, 8)).toBe('foo\n' + String.raw`\==`);
    // A rule cut short of three is escaped, not set apart
    expect(note('- foo\n-----', 2, 7)).toBe('foo\n' + String.raw`\-`);
    // An underline cut short is still one
    expect(note('a foo\n====', 2, 8)).toBe('foo\n==');
  });

  it('reads code where the second line is: a fence opened on the first makes it code', () => {
    expect(note('```\n---\n```', 1, 7)).toBe('``\n' + String.raw`\---`);
    expect(note('```js\n---\n```', 3, 9)).toBe('js\n' + String.raw`\---`);
    expect(note('```\na x\n---\n```', 6)).toBe(
      'x\n' + String.raw`\---` + '\n```'
    );
  });

  it('sees to a cut from the start of a line too, where the line was no paragraph of its own', () => {
    expect(note('foo\nbar\n---', 4)).toBe('bar\n\n---');
    expect(note('- a\nb\n---', 4)).toBe('b\n\n---');
    expect(note('foo\nbar\n===', 4)).toBe('bar\n' + String.raw`\===`);
    expect(note('```\nx\n---\n```', 4)).toBe(
      'x\n' + String.raw`\---` + '\n```'
    );
  });

  it('keeps an underline of a line the source showed as a heading', () => {
    expect(note('foo bar\n---', 4)).toBe('bar\n---');
    expect(note('foo bar\n===', 4)).toBe('bar\n===');
    expect(note('foo bar\n---', 0)).toBe('foo bar\n---');
    expect(note('  foo bar\n-', 6)).toBe('bar\n-');
    expect(note('a\n\nfoo x\n===', 7)).toBe('x\n===');
    expect(note('# h\nfoo x\n---', 8)).toBe('x\n---');
    expect(note('***\nfoo x\n---', 8)).toBe('x\n---');
    expect(note('a\n---\nfoo x\n---', 10)).toBe('x\n---');
    expect(note('a\n===\nfoo x\n---', 10)).toBe('x\n---');
    expect(note('a\n-\nfoo x\n---', 8)).toBe('x\n---');
    expect(note('```\nc\n```\nfoo x\n---', 14)).toBe('x\n---');
    expect(note('a\n\n    code\nfoo x\n---', 15)).toBe('x\n---');
    expect(note('see #tag x\n---', 4)).toBe('#tag x\n---');
  });

  it('reads past the blank lines a cut from a line end starts with, to the line its first is', () => {
    expect(note('bar\nfoo\n---', 3)).toBe('\nfoo\n\n---');
    expect(note('bar   \nfoo\n---', 3)).toBe('\nfoo\n\n---');
    expect(note('bar\r\n\r\nfoo\r\n===', 3)).toBe('\r\n\r\nfoo\r\n===');
    expect(note('- bar\n\n- foo\n---', 5)).toBe('\n\n- foo\n---');
    expect(note('bar\n\n', 3)).toBe('\n\n');
  });

  it('reads a comment alone on its line as ending a paragraph above it, and as a paragraph an underline makes a heading', () => {
    expect(note('<!-- c -->\nfoo x\n---', 15)).toBe('x\n---');
    expect(note('<!-- c -->\n---', 5)).toBe('c -->\n---');
    expect(note('a\n<!-- c -->\nfoo x\n---', 17)).toBe('x\n---');
    expect(note('[a]: x\n<!-->\n===', 7)).toBe('<!-->\n===');
    expect(note('<!-- c --> foo\n---', 11)).toBe('foo\n---');
  });

  it('takes an empty list item above for no underline: the cache reads none', () => {
    expect(note('# h\n-\nfoo\n---', 6)).toBe('foo\n\n---');
    expect(note('a\n\n-\nfoo\n---', 5)).toBe('foo\n\n---');
  });

  it('reads no other heading, rule, comment or definition for a paragraph', () => {
    // A heading by two `#` is one too, and an empty one ends a paragraph
    expect(note('## T x\n===', 5)).toBe('x\n' + String.raw`\===`);
    expect(note('#\nfoo x\n---', 6)).toBe('x\n---');
    // A rule only where its line starts, and a list's number alone is a list
    expect(note('a ***\n---', 2)).toBe(String.raw`\***` + '\n---');
    expect(note('1.\n---', 1)).toBe('.\n\n---');
    // Text before an underline makes it none
    expect(note('a\nb --\nfoo x\n---', 11)).toBe('x\n\n---');
    // A line ending in `-->` is no comment unless it opens one
    expect(note('a -->\nfoo x\n---', 10)).toBe('x\n\n---');
    expect(note('<!-- c -->  \nfoo x\n---', 17)).toBe('x\n---');
    // A definition's label of any length
    expect(note('[ab]: x\n---', 1)).toBe('ab]: x\n\n---');
    // A blank line in code reads past to code
    expect(note('```\n \nfoo\n---\n```', 4)).toBe(
      ' \nfoo\n' + String.raw`\---` + '\n```'
    );
  });

  it('reads the lines above up the note: what an underline ends, and code', () => {
    // `===` under two lines is their text, so no heading ends there
    expect(note('foo\nbar\n===\nx y\n---', 14)).toBe('y\n\n---');
    // An indented line under text is the text's own
    expect(note('a\n    b\nfoo x\n---', 12)).toBe('x\n\n---');
    expect(note('- a\n    b\nfoo x\n---', 14)).toBe('x\n\n---');
    expect(note('    code\nfoo x\n---', 13)).toBe('x\n---');
    // After a link definition, unprobed, it errs toward escaping
    expect(note('[a]: b\nfoo x\n---', 11)).toBe('x\n\n---');
    expect(note('[a]: b\n---', 1)).toBe(String.raw`a]: b` + '\n\n---');
  });

  it('leaves a line that underlines nothing, or a first line that is no paragraph', () => {
    expect(note('- milk\n- - -', 2)).toBe('milk\n- - -');
    expect(note('- milk\n    ---', 2)).toBe('milk\n    ---');
    expect(note('- milk\n\t---', 2)).toBe('milk\n\t---');
    expect(note('- milk\n---x', 2)).toBe('milk\n---x');
    expect(note('- milk\n\n---', 2)).toBe('milk\n\n---');
    expect(note('- # x\n---', 2)).toBe('# x\n---');
    expect(note('> - x\n===', 2)).toBe('- x\n===');
    expect(note('- a  \n---', 3)).toBe('\n---');
    expect(note('- milk\n---', 0)).toBe('- milk\n---');
    expect(note('a\n- milk\n---', 2)).toBe('- milk\n---');
    expect(note('a\n    code\n---', 2)).toBe('    code\n---');
    expect(note('- milk', 2)).toBe('milk');
  });

  it('sees to each line down the paragraph that could underline it in live preview, which underlines one of any length', () => {
    // A rule ends the paragraph; an escaped line is its text, and the next
    // is read in turn
    expect(note('- milk\n---\n---', 2)).toBe('milk\n\n---\n---');
    expect(note('- milk\n===\n===', 2)).toBe(
      'milk\n' + String.raw`\===` + '\n' + String.raw`\===`
    );
    expect(note('- buy milk\n=\n---', 2)).toBe(
      'buy milk\n' + String.raw`\=` + '\n\n---'
    );
    // Down text, indented lines and definitions, which go on with it
    expect(note('- x foo\nbar\n---', 4)).toBe('foo\nbar\n\n---');
    // A second line that started a paragraph of its own is set apart, which
    // keeps it as it was: `bar`, a heading under `# h foo`
    expect(note('# h foo\nbar\n===', 4)).toBe('foo\n\nbar\n===');
    expect(note('# h foo\nbar\n---', 4)).toBe('foo\n\nbar\n---');
    expect(note('# h foo\nbar', 4)).toBe('foo\n\nbar');
    expect(note('    code x\nbar\nbaz', 9)).toBe('x\n\nbar\nbaz');
    expect(note('_ _ _\nnext', 1)).toBe('_ _\n\nnext');
    expect(note('a\n===\nfoo\nbar', 2)).toBe('===\n\nfoo\nbar');
    // Not a line its first was in a paragraph with, nor one in code, a list's
    // or after a definition
    expect(note('x foo\nbar', 2)).toBe('foo\nbar');
    expect(note('- x foo\nbar', 4)).toBe('foo\nbar');
    expect(note('```\nx foo\nbar\n```', 6)).toBe('foo\nbar\n```');
    expect(note('[a]: x\nbar', 1)).toBe('a]: x\nbar');
    expect(note('# h foo\n- bar', 4)).toBe('foo\n- bar');
    expect(note('- x foo\nbar\n===', 4)).toBe('foo\nbar\n' + String.raw`\===`);
    expect(note('- x foo\n    bar\n---', 4)).toBe('foo\n    bar\n\n---');
    expect(note('- x foo\n[a]: b\n---', 4)).toBe('foo\n[a]: b\n\n---');
    expect(note('- x foo\n[ab]: b\n---', 4)).toBe('foo\n[ab]: b\n\n---');
    expect(note('- x foo\nbar <div>\n---', 4)).toBe('foo\nbar <div>\n\n---');
    expect(note('- x foo\n<divx>\n---', 4)).toBe('foo\n<divx>\n\n---');
    // An HTML block's line ends it, a tag alone, closed or with attributes
    for (const tag of ['<div/>', '<div', '<div class="a">', '</div>']) {
      expect(note(`- x foo\n${tag}\n---`, 4)).toBe(`foo\n${tag}\n---`);
    }
    // A heading only where its line starts
    expect(note('- a # b\n===', 2)).toBe('a # b\n' + String.raw`\===`);
    // Not past what ends it, nor a lone `-` under a longer one, a list there
    expect(note('- x foo\n\n---', 4)).toBe('foo\n\n---');
    expect(note('- x foo\n   \n---', 4)).toBe('foo\n   \n---');
    // A rule only where its line starts
    expect(note('- a ---\n===', 2)).toBe('a ---\n' + String.raw`\===`);
    expect(note('- x foo\n# h\n---', 4)).toBe('foo\n# h\n---');
    expect(note('- x foo\n- y\n---', 4)).toBe('foo\n- y\n---');
    expect(note('- x foo\nbar\n-\n---', 4)).toBe('foo\nbar\n-\n---');
    expect(note('- x foo\n<!-- c -->\n---', 4)).toBe('foo\n<!-- c -->\n---');
    expect(note('- x foo\n<div>\n---', 4)).toBe('foo\n<div>\n---');
    expect(note('- x foo\nbar', 4)).toBe('foo\nbar');
    // Kept where the line above was a paragraph's in the source too
    expect(note('x foo\nbar\n---', 2)).toBe('foo\nbar\n---');
    expect(note('a\n\n    code\nx foo\nbar\n---', 14)).toBe('foo\nbar\n---');
    expect(note('x foo\n    bar\n---', 2)).toBe('foo\n    bar\n---');
    expect(note('x foo\n[a]: b\n---', 2)).toBe('foo\n[a]: b\n---');
    // Counting the lines above: an indented or definition line goes on with
    // a paragraph, so the underline under it underlined none of one line
    expect(note('a\n    b\n===\nfoo y\n---', 16)).toBe('y\n\n---');
    expect(note('[a]: x\n===\nfoo y\n---', 15)).toBe('y\n\n---');
    expect(note('x [a]: b\n===\nfoo y\n---', 17)).toBe('y\n---');
    // But for one under a heading's underline, an HTML block's line, or in
    // code
    expect(
      Markdown.escapeCutUnderline('x a\n===\n---', 0, '(} x a\n {)===\n---')
    ).toBe('(} x a\n {)===\n\n---');
    // An underline under a comment underlined it: no paragraph's line
    expect(note('<!-- c -->\n===\n---', 11)).toBe('===\n\n---');
    // and ended its paragraph: the next line starts one
    expect(note('<!-- c -->\n===\nfoo x\n===', 19)).toBe('x\n===');
    // A comment in an HTML block is the block's, as is what follows it
    expect(note('<div>\n<!-- c -->\nfoo\n---', 6)).toBe(
      '<!-- c -->\nfoo\n' + String.raw`\---`
    );
    // A definition in a list item is its text, which nothing underlines
    expect(note('- a\n[b]: c\nx foo\nbar\n---', 13)).toBe('foo\nbar\n\n---');
    // An HTML block holds what follows it, a rule's line as text
    expect(note('<div>a</div>\nx foo\nbar\n---', 15)).toBe(
      'foo\nbar\n' + String.raw`\---`
    );
    expect(note('<h2>a b\nc\n---', 6)).toBe('b\nc\n' + String.raw`\---`);
    // A rule's line cut short under an HTML block's line was its text
    expect(note('<div>a b\n--- -', 7, 12)).toBe('b\n' + String.raw`\---`);
    expect(note('<div>\nbar\n---', 0)).toBe('<div>\nbar\n---');
    expect(note('<!-- c -->\nfoo\n---', 0)).toBe('<!-- c -->\nfoo\n---');
    expect(note('- x\n<!-- c -->\nfoo\n---', 4)).toBe('<!-- c -->\nfoo\n---');
    expect(note('```\nx foo\nbar\n---\n```', 6)).toBe(
      'foo\nbar\n' + String.raw`\---` + '\n```'
    );
  });

  it("sees to a card's second line, its first holding the delimiters", () => {
    const underline = (source: string, from: number, child: string) =>
      Markdown.escapeCutUnderline(source, from, child);
    expect(underline('- buy milk now\n---', 2, 'buy (} milk {) now\n---')).toBe(
      'buy (} milk {) now\n\n---'
    );
    expect(underline('- buy\n===', 2, '(} buy {)\n===')).toBe(
      '(} buy {)\n' + String.raw`\===`
    );
    expect(underline('- buy\n---', 0, '- (} buy {)\n---')).toBe(
      '- (} buy {)\n---'
    );
    expect(underline('a buy\n---', 2, '(} buy {)\n---')).toBe('(} buy {)\n---');
    // A delimiter on the second line keeps it from underlining anything
    expect(underline('- a\n---', 2, '(} a\n--- {)')).toBe('(} a\n--- {)');
  });

  it('takes time linear in the length of its source, however full of underlines, fences and backticks', () => {
    for (const make of LINEAR_CUTS) {
      expect(
        timeRatio(make, (source, from) => noteOf(source, [from, source.length]))
      ).toBeLessThan(64);
    }
    const noteFrom = ([source, from]: [string, number]) =>
      noteOf(source, [from, source.length]);
    expect(noteFrom(LINEAR_CUTS[7](3))).toBe('x\n\n---');
    expect(noteFrom(LINEAR_CUTS[9](8))).toBe('x\n---');
    expect(noteFrom(LINEAR_CUTS[13](16))).toBe('#t');
    expect(noteFrom(LINEAR_CUTS[14](28))).toBe('#t');
    expect(noteFrom(LINEAR_CUTS[15](8))).toBe(
      'x foo\n' + String.raw`\===` + '\n' + String.raw`\===` + '\n\n---'
    );
    expect(noteFrom(LINEAR_CUTS[16](8))).toBe('x foo\nbar\n---');
    expect(noteFrom(LINEAR_CUTS[17](12))).toBe(
      'x\n' +
        String.raw`\---` +
        '\n' +
        String.raw`\---` +
        '\n' +
        String.raw`\---` +
        '\n'
    );
    const [backticks] = LINEAR_CUTS[8](12);
    expect(noteFrom(LINEAR_CUTS[8](12))).toBe(backticks.slice(2));
  });

  describe('as reading view, the metadata cache and live preview read a note', () => {
    it('makes no heading of its first paragraph that the source did not show there', () => {
      fc.assert(
        fc.property(noteCutArb, ({ source, range }) => {
          const { child, sourceKinds, sourceLines } = reading(source, range);
          const childKinds = readLines(child);

          if (childKinds[0] === 'setext') {
            expect(sourceKinds[0]).toBe('setext');
          }
          const u = livePreviewUnderline(linesOf(child), childKinds);
          if (u !== undefined) {
            expect(livePreviewHeadsAt(sourceLines, sourceKinds, u)).toBe(true);
          }
        }),
        { numRuns: 3000 }
      );
    });

    it('changes only lines that could underline it, keeping what each was: a rule a rule, and text text', () => {
      fc.assert(
        fc.property(noteCutArb, ({ source, range }) => {
          const { started, child, sourceKinds } = reading(source, range);
          fc.pre(child !== started);

          const startedLines = linesOf(started);
          const childLines = linesOf(child);
          const own = ownParagraphAfter(sourceKinds, readLines(started));
          let c = 0;
          let blanks = 0;
          for (const [i, line] of startedLines.entries()) {
            const rule =
              sourceKinds[i] === 'rule' && readLines(line)[0] === 'rule';
            if (childLines[c] === '' && line !== '') {
              // A blank line set before a rule the source held, or before a
              // second line that started a paragraph of its own there, once
              expect(rule || (i === 1 && own)).toBe(true);
              blanks++;
              c++;
            }
            if (childLines[c] !== line) {
              // An escape before the first char of what would underline
              // the lines above, which was no rule in the source
              expect(childLines[c]).toBe(line.replace(/[-=]/, '\\$&'));
              expect(livePreviewUnderlines(line, i > 1)).toBe(true);
              expect(rule).toBe(false);
            }
            c++;
          }
          expect(c).toBe(childLines.length);
          expect(blanks).toBeLessThanOrEqual(1);
        }),
        { numRuns: 3000 }
      );
    });

    it('changes nothing where its first paragraph forms no heading, or one the source showed', () => {
      fc.assert(
        fc.property(noteCutArb, ({ source, range }) => {
          const { started, child, sourceKinds, sourceLines } = reading(
            source,
            range
          );
          const startedKinds = readLines(started);
          const u = livePreviewUnderline(linesOf(started), startedKinds);
          fc.pre(
            (u === undefined && startedKinds[0] !== 'setext') ||
              (u === 1 && sourceKinds[0] === 'setext') ||
              (u !== undefined &&
                u > 1 &&
                livePreviewHeadsAt(sourceLines, sourceKinds, u))
          );

          // But for a second line that started a paragraph of its own
          expect(child).toBe(
            ownParagraphAfter(sourceKinds, startedKinds)
              ? started.replace(
                  /\r\n?|\n/,
                  (lineBreak) => lineBreak + lineBreak
                )
              : started
          );
        }),
        { numRuns: 3000 }
      );
    });

    it("keeps a card's first paragraph from being underlined into a heading the source did not show, its delimiters anywhere", () => {
      fc.assert(
        fc.property(
          noteCutArb,
          fc.nat(),
          fc.nat(),
          ({ source, range: [from, to] }, x, y) => {
            // An answer anywhere in the cut, unsnapped: broader than the
            // manager's, but for an end between the two of a CRLF, which the
            // editor's text never holds
            const off = (at: number) =>
              source[at - 1] === '\r' && source[at] === '\n' ? at + 1 : at;
            const [a, b] = [
              off(from + (x % (to - from + 1))),
              off(from + (y % (to - from + 1))),
            ].sort((m, n) => m - n);
            fc.pre(b <= to);
            const pre = Markdown.escapeCutStart(source, [from, a], 'note');
            const hidden = Markdown.escapeCutStart(source, [a, b], 'answer');
            const card = pastBlankLines(
              Markdown.escapeCutUnderline(
                source,
                from,
                `${pre}(} ${hidden} {)${source.slice(b, to)}`
              )
            );
            const p1 = lineIndexOf(source, from) + card.lines;
            const sourceKinds = readLines(source).slice(p1);
            const cardKinds = readLines(card.text);

            if (cardKinds[0] === 'setext') {
              expect(sourceKinds[0]).toBe('setext');
            }
            const u = livePreviewUnderline(linesOf(card.text), cardKinds);
            if (u !== undefined) {
              expect(
                livePreviewHeadsAt(linesOf(source).slice(p1), sourceKinds, u)
              ).toBe(true);
            }
          }
        ),
        { numRuns: 2000 }
      );
    });
  });
});
