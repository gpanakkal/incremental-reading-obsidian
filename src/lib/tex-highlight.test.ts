import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  texHighlightClass,
  wrapTexRanges,
  type TexRange,
} from './tex-highlight';

// #region HELPERS

/** One unit of TeX as the oracle reads it. */
interface OracleToken {
  start: number;
  end: number;
  text: string;
  /** Opens or closes a group of this name, which must match */
  open?: string;
  close?: string;
}

/**
 * TeX's tokens, read independently of the module under test: control words
 * and symbols, `\begin{x}`/`\end{x}`, `\left`/`\right` with their delimiter,
 * `\verb`, comments, whitespace runs, and single code points.
 */
function oracleTokens(tex: string): OracleToken[] {
  const tokens: OracleToken[] = [];
  let i = 0;
  const push = (end: number, extra: Partial<OracleToken> = {}) => {
    tokens.push({ start: i, end, text: tex.slice(i, end), ...extra });
    i = end;
  };
  const codePointEnd = (at: number) =>
    at + (tex.codePointAt(at)! > 0xffff ? 2 : 1);
  while (i < tex.length) {
    const rest = tex.slice(i);
    let m: RegExpExecArray | null;
    if (rest[0] === '%') {
      const nl = tex.indexOf('\n', i);
      push(nl < 0 ? tex.length : nl);
    } else if ((m = /^\s+/.exec(rest))) {
      push(i + m[0].length);
    } else if (
      (m = /^\\(begin)\s*\{(array)\}\s*\{[^{}]*\}/.exec(rest)) ??
      (m = /^\\(begin|end)\s*\{([^{}]*)\}/.exec(rest))
    ) {
      const name = `env ${m[2]}`;
      push(
        i + m[0].length,
        m[1] === 'begin' ? { open: name } : { close: name }
      );
    } else if ((m = /^\\(text|mbox|tag|color)\s*\{/.exec(rest))) {
      // Text, a label, a colour: no math in it
      let depth = 0;
      let k = i + m[0].length - 1;
      for (; k < tex.length; k += 1) {
        if (tex[k] === '\\') k += 1;
        else if (tex[k] === '{') depth += 1;
        else if (tex[k] === '}' && --depth === 0) break;
      }
      push(k < tex.length ? k + 1 : i + 1 + m[1].length);
    } else if (
      (m =
        /^\\(?:text|mbox|tag|color)(?![a-zA-Z])\s*(?:\\[a-zA-Z]+|\\.|[^\s{}\\])/u.exec(
          rest
        ))
    ) {
      // …of one token, unbraced
      push(i + m[0].length);
    } else if (
      (m =
        /^\\(left|right|middle|[bB]ig{1,2}[lmr]?|not)\s*(\\[a-zA-Z]+|\\.|[^\s{}\\])/u.exec(
          rest
        ))
    ) {
      const kind = m[1];
      push(
        i + m[0].length,
        kind === 'left'
          ? { open: 'left' }
          : kind === 'right'
            ? { close: 'left' }
            : {}
      );
    } else if ((m = /^\\\\\*?(?:\s*\[[^\]]*\])?/.exec(rest))) {
      push(i + m[0].length);
    } else if ((m = /^\\verb(.)/u.exec(rest))) {
      const close = tex.indexOf(m[1], i + m[0].length);
      push(close < 0 ? i + 5 : close + m[1].length);
    } else if ((m = /^\\[a-zA-Z]+/.exec(rest))) {
      push(i + m[0].length);
    } else if (rest[0] === '\\' && rest.length > 1) {
      push(codePointEnd(i + 1));
    } else if (rest[0] === '{') {
      push(i + 1, { open: '{' });
    } else if (rest[0] === '}') {
      push(i + 1, { close: '{' });
    } else {
      push(codePointEnd(i));
    }
  }
  return tokens;
}

const isBlank = (t: OracleToken) => /^\s/.test(t.text) || t.text[0] === '%';

/** Whether `tex`'s groups, environments and `\left`…`\right` pairs all match. */
function balanced(tex: string): boolean {
  const stack: string[] = [];
  for (const t of oracleTokens(tex)) {
    if (t.open) stack.push(t.open);
    if (t.close && stack.pop() !== t.close) return false;
  }
  return stack.length === 0;
}

const WRAPPER = /\\class\{mjx-ir-snippet-(\d+)\}\{/g;

interface Wrapper {
  index: number;
  /** Offsets in the wrapped TeX of the wrapper's opening and closing text */
  openStart: number;
  contentStart: number;
  contentEnd: number;
}

/** Each wrapper in `wrapped`, with its content's extent, outermost first. */
function wrappersOf(wrapped: string): Wrapper[] {
  const tokens = oracleTokens(wrapped);
  return Array.from(wrapped.matchAll(WRAPPER), (m) => {
    const contentStart = m.index + m[0].length;
    let depth = 1;
    const close = tokens.find((t) => {
      if (t.start < contentStart) return false;
      if (t.text === '{') depth += 1;
      if (t.text === '}') depth -= 1;
      return depth === 0;
    })!;
    return {
      index: Number(m[1]),
      openStart: m.index,
      contentStart,
      contentEnd: close.start,
    };
  });
}

/**
 * `wrapped` with its wrappers taken out, and for each original offset the
 * classes wrapping it.
 */
function unwrap(wrapped: string): { tex: string; classes: Set<number>[] } {
  const wrappers = wrappersOf(wrapped);
  const dropped = new Set<number>();
  for (const w of wrappers) {
    for (let k = w.openStart; k < w.contentStart; k += 1) dropped.add(k);
    dropped.add(w.contentEnd);
  }
  let tex = '';
  const classes: Set<number>[] = [];
  for (let k = 0; k < wrapped.length; k += 1) {
    if (dropped.has(k)) continue;
    tex += wrapped[k];
    classes.push(
      new Set(
        wrappers
          .filter((w) => w.contentStart <= k && k < w.contentEnd)
          .map((w) => w.index)
      )
    );
  }
  return { tex, classes };
}

/** The tokens of `tex` that show: no blank, nor a row or cell separator. */
const shown = (tex: string) =>
  oracleTokens(tex).filter((t) => !isBlank(t) && !SEPARATOR.test(t.text));

/** The tokens of `tex` that show and a range touches. */
const touched = (tex: string, range: TexRange) =>
  shown(tex).filter((t) => t.start < range.end && t.end > range.start);

const SCRIPT = new Set(['^', '_']);
const AFTER_SCRIPT = new Set(['^', '_', "'", '\\limits', '\\nolimits']);

/** Whether `content` is one token, or one `{…}` group, less blanks around it. */
function oneAtom(content: string): boolean {
  const tokens = oracleTokens(content).filter((t) => !isBlank(t));
  if (tokens.length === 1) return !tokens[0].open && !tokens[0].close;
  if (tokens[0]?.text !== '{') return false;
  let depth = 0;
  return tokens.every((t, k) => {
    if (t.open) depth += 1;
    if (t.close) depth -= 1;
    return depth > 0 || k === tokens.length - 1;
  });
}

/** Tokens of `content` at its own top level. */
function topLevel(content: string): OracleToken[] {
  let depth = 0;
  return oracleTokens(content).filter((t) => {
    if (t.close) depth -= 1;
    const top = depth === 0 && !t.close;
    if (t.open) depth += 1;
    return top;
  });
}

const SEPARATOR = /^(&|\\\\|\\cr$|\\newline$|\\hline$|\\hdashline$)/;
const INFIX = new Set([
  '\\over',
  '\\atop',
  '\\above',
  '\\choose',
  '\\brace',
  '\\brack',
  '\\overwithdelims',
  '\\atopwithdelims',
  '\\abovewithdelims',
]);

/** The operators among the generated atoms */
const OPERATORS = new Set(['+', '=', '-', '\\sum', '\\cdot', '\\not=']);

/**
 * The first token of each atom at `content`'s top level: an atom being a
 * token or group with the scripts, primes and limits after it.
 */
function atomBases(content: string): OracleToken[] {
  let afterScript = false;
  return topLevel(content)
    .filter((t) => !isBlank(t))
    .filter((t) => {
      const base = !afterScript && !AFTER_SCRIPT.has(t.text);
      afterScript = SCRIPT.has(t.text);
      return base;
    });
}

/** Ordinary letters and digits: what a math line shows */
const isGlyph = (t: OracleToken) => /^[\p{L}\p{N}]+$/u.test(t.text);

/**
 * Display math as notes hold it: atoms, groups, scripts, fractions,
 * delimiters, environments with rows and cells, infix fractions, text,
 * comments (with stray braces), `\verb`, and the spacing between them.
 */
const texArb = fc
  .letrec<{ seq: string; item: string; atom: string }>((tie) => ({
    atom: fc.constantFrom(
      'a',
      'b',
      'x',
      '2',
      '+',
      '=',
      '-',
      '(',
      ')',
      '|',
      ',',
      '.',
      'é',
      '\u{1d465}',
      '\\alpha',
      '\\,',
      '\\{',
      '\\}',
      '\\%',
      '\\quad',
      '\\sum',
      '\\cdot',
      '\\|',
      "'",
      '\\verb|{|'
    ),
    item: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      tie('atom'),
      tie('atom'),
      tie('seq').map((s) => `{${s}}`),
      fc
        .tuple(tie('atom'), fc.constantFrom('^', '_'), tie('atom'))
        .map(([b, s, a]) => `${b}${s}${a}`),
      fc
        .tuple(tie('atom'), fc.constantFrom('^', '_'), tie('seq'))
        .map(([b, s, a]) => `${b}${s}{${a}}`),
      fc.tuple(tie('seq'), tie('seq')).map(([n, d]) => `\\frac{${n}}{${d}}`),
      fc
        .tuple(tie('seq'), tie('seq'))
        .map(([a, b]) => `\\left( ${a} \\middle| ${b} \\right\\}`),
      tie('seq').map((s) => `\\left.${s}\\right)`),
      fc
        .array(fc.array(tie('seq'), { minLength: 1, maxLength: 3 }), {
          minLength: 1,
          maxLength: 3,
        })
        .chain((rows) =>
          fc
            .tuple(
              fc.constantFrom('aligned', 'matrix', 'array}{cc'),
              fc.constantFrom(' \\\\\n', '\\\\[2pt]', '\\cr ', ' \\\\ \\hline ')
            )
            .map(
              ([env, newline]) =>
                `\\begin{${env}}${rows.map((r) => r.join(' & ')).join(newline)}\\end{${env.replace(/\}.*/, '')}}`
            )
        ),
      fc
        .tuple(
          tie('seq'),
          fc.constantFrom('\\over', '\\atop', '\\choose'),
          tie('seq')
        )
        .map(([a, op, b]) => `{${a} ${op} ${b}}`),
      fc
        .tuple(tie('seq'), tie('seq'))
        .map(([a, b]) => `\\sum\\limits_{${a}}^{${b}}`),
      fc.constantFrom(
        '\\text{and}',
        '\\text{a {b} c}',
        '\\mbox{x y}',
        '\\tag{1}',
        '\\sqrt[3]{x}',
        '\\bigl( a \\bigr)',
        '\\not='
      ),
      tie('seq').map((s) => `{\\displaystyle ${s}}`),
      fc.tuple(tie('seq'), tie('seq')).map(([a, b]) => `${a}\\color{red} ${b}`),
      fc.constantFrom('% note {\n', '%}\n', '\\\\ ', '\\newline ')
    ),
    seq: fc
      .array(
        fc.tuple(tie('item'), fc.constantFrom('', ' ', '\n', '  ', ' \n ')),
        { maxLength: 5 }
      )
      .map((parts) => parts.map(([item, space]) => item + space).join('')),
  }))
  .seq.chain((tex) =>
    // A comment can run to the very end, with no newline after it
    fc.constantFrom('', '% end', '%{').map((comment) => tex + comment)
  );

/** A range anywhere in `tex`, edges included. */
const rangeIn = (tex: string) =>
  fc
    .tuple(fc.nat(tex.length), fc.nat(tex.length))
    .map(([a, b]) => ({ start: Math.min(a, b), end: Math.max(a, b) }));

/** TeX with ranges in it. */
const texWithRanges = (maxRanges: number) =>
  texArb.chain((tex) =>
    fc.tuple(
      fc.constant(tex),
      fc.array(rangeIn(tex), { minLength: 1, maxLength: maxRanges })
    )
  );

// #endregion

describe('texHighlightClass', () => {
  it('names a class MathJax keeps under its safe extension, one per index', () => {
    fc.assert(
      fc.property(fc.nat(), fc.nat(), (a, b) => {
        expect(texHighlightClass(a)).toMatch(/^mjx-[-a-zA-Z0-9_.]+$/);
        expect(texHighlightClass(a) === texHighlightClass(b)).toBe(a === b);
      })
    );
  });
});

describe('wrapTexRanges', () => {
  it('only inserts wrappers, leaving the TeX between them as it was', () => {
    fc.assert(
      fc.property(texWithRanges(3), ([tex, ranges]) => {
        const result = wrapTexRanges(tex, ranges);
        expect(unwrap(result.tex).tex).toBe(tex);
        expect(result.status).toHaveLength(ranges.length);
      })
    );
  });

  it('keeps the TeX balanced wherever the ranges cut it', () => {
    fc.assert(
      fc.property(texWithRanges(3), ([tex, ranges]) => {
        expect(balanced(tex)).toBe(true);
        expect(balanced(wrapTexRanges(tex, ranges).tex)).toBe(true);
      })
    );
  });

  it('wraps a wrapped range’s glyphs, and only text inside the tokens it touches', () => {
    fc.assert(
      fc.property(texWithRanges(3), ([tex, ranges]) => {
        const result = wrapTexRanges(tex, ranges);
        const { classes } = unwrap(result.tex);
        ranges.forEach((range, i) => {
          const tokens = touched(tex, range);
          const wrappedAt = classes.flatMap((set, k) =>
            set.has(i) ? [k] : []
          );
          if (result.status[i] !== 'wrapped') {
            expect(wrappedAt).toEqual([]);
            return;
          }
          const from = tokens[0].start;
          const to = tokens[tokens.length - 1].end;
          for (const k of wrappedAt) {
            expect(k).toBeGreaterThanOrEqual(from);
            expect(k).toBeLessThan(to);
          }
          for (const t of tokens.filter(isGlyph)) {
            expect(classes[t.start].has(i)).toBe(true);
          }
        });
      })
    );
  });

  it('wraps no stretch that renders otherwise once wrapped', () => {
    fc.assert(
      fc.property(texWithRanges(3), ([tex, ranges]) => {
        const wrapped = wrapTexRanges(tex, ranges).tex;
        const all = oracleTokens(wrapped);
        for (const w of wrappersOf(wrapped)) {
          const content = unwrap(
            wrapped.slice(w.contentStart, w.contentEnd)
          ).tex;
          const top = topLevel(content).filter((t) => !isBlank(t));
          // Cut out of no group, nor out of a row or cell, nor out of a
          // fraction's half or a pair of delimiters
          expect(balanced(content)).toBe(true);
          expect(top.some((t) => SEPARATOR.test(t.text))).toBe(false);
          expect(top.some((t) => INFIX.has(t.text))).toBe(false);
          expect(top.some((t) => t.text.startsWith('\\middle'))).toBe(false);
          // Neither starting nor ending as a script, prime, or limits does
          expect(AFTER_SCRIPT.has(top[0].text)).toBe(false);
          expect(SCRIPT.has(top[top.length - 1].text)).toBe(false);
          expect(isBlank(oracleTokens(content)[0])).toBe(false);
          // A script's base or argument only when it is one atom
          const before = all
            .filter((t) => t.end <= w.openStart && !isBlank(t))
            .at(-1);
          const after = all.find((t) => t.start > w.contentEnd && !isBlank(t));
          if (
            (before && SCRIPT.has(before.text)) ||
            (after && AFTER_SCRIPT.has(after.text))
          ) {
            expect(oneAtom(content)).toBe(true);
          }
          // A switch holds to the end of its group, so the wrap must too
          if (top.some((t) => /^\\(displaystyle|color)\b/.test(t.text))) {
            expect(
              after === undefined ||
                after.text === '}' ||
                after.text.startsWith('\\end') ||
                after.text.startsWith('\\right') ||
                SEPARATOR.test(after.text)
            ).toBe(true);
          }
        }
      })
    );
  });

  it('wraps an operator at the edge of a stretch on its own', () => {
    fc.assert(
      fc.property(texWithRanges(3), ([tex, ranges]) => {
        const wrapped = wrapTexRanges(tex, ranges).tex;
        for (const w of wrappersOf(wrapped)) {
          const content = unwrap(
            wrapped.slice(w.contentStart, w.contentEnd)
          ).tex;
          const bases = atomBases(content);
          // A wrap of several atoms is an ordinary atom to MathJax, so an
          // operator at its edge would lose the spacing it has unwrapped
          if (bases.length > 1) {
            expect(OPERATORS.has(bases[0].text)).toBe(false);
            expect(OPERATORS.has(bases[bases.length - 1].text)).toBe(false);
          }
        }
      })
    );
  });

  it('marks a range touching no token that shows as showing nothing', () => {
    fc.assert(
      fc.property(texWithRanges(3), ([tex, ranges]) => {
        const { status } = wrapTexRanges(tex, ranges);
        ranges.forEach((range, i) => {
          if (touched(tex, range).length === 0) expect(status[i]).toBe('none');
          else expect(status[i]).not.toBe('none');
        });
      })
    );
  });

  it('marks a range touching every token that shows as the whole expression', () => {
    fc.assert(
      fc.property(
        texArb.filter((tex) => shown(tex).length > 0),
        fc.nat(),
        fc.nat(),
        (tex, lead, trail) => {
          const visible = shown(tex);
          const start = visible[0].start - (lead % (visible[0].start + 1));
          const last = visible[visible.length - 1].end;
          const end = last + (trail % (tex.length - last + 1));
          const result = wrapTexRanges(tex, [{ start, end }]);
          expect(result).toEqual({ tex, status: ['whole'] });
        }
      )
    );
  });

  it('wraps nothing in TeX whose groups do not match', () => {
    fc.assert(
      fc.property(
        texArb,
        fc.constantFrom(
          '{',
          '}',
          '\\left(',
          '\\right)',
          '\\begin{x}',
          '\\end{x}'
        ),
        fc.nat(),
        (tex, stray, at) => {
          const k = at % (tex.length + 1);
          const broken = tex.slice(0, k) + stray + tex.slice(k);
          fc.pre(!balanced(broken));
          const ranges = [
            { start: 0, end: broken.length },
            { start: k, end: k + 1 },
          ];
          const result = wrapTexRanges(broken, ranges);
          expect(result.tex).toBe(broken);
          expect(result.status).not.toContain('wrapped');
        }
      )
    );
  });

  it('gives each range its own class, nesting them where they overlap', () => {
    const tex = 'a + b + c';
    const result = wrapTexRanges(tex, [
      { start: 0, end: 5 },
      { start: 4, end: 9 },
    ]);
    expect(result.status).toEqual(['wrapped', 'wrapped']);
    expect(result.tex).toBe(
      `\\class{${texHighlightClass(0)}}{a} \\class{${texHighlightClass(0)}}{+} \\class{${texHighlightClass(0)}}{\\class{${texHighlightClass(1)}}{b}} \\class{${texHighlightClass(1)}}{+} \\class{${texHighlightClass(1)}}{c}`
    );
  });

  describe('for one line of a multi-line block', () => {
    const tex =
      '\na^2 + b^2 = c^2\n\\quad\\text{and}\\quad\ne^{i\\pi} + 1 = 0\n';
    const line = 'a^2 + b^2 = c^2';

    it('wraps exactly that line', () => {
      const start = tex.indexOf(line);
      const result = wrapTexRanges(tex, [{ start, end: start + line.length }]);
      expect(result.status).toEqual(['wrapped']);
      expect(result.tex).toBe(
        tex.replace(line, `\\class{${texHighlightClass(0)}}{${line}}`)
      );
    });

    it('wraps it with the newlines around it, less the blanks', () => {
      const start = tex.indexOf(line) - 1;
      const result = wrapTexRanges(tex, [
        { start, end: start + line.length + 2 },
      ]);
      expect(result.tex).toBe(
        tex.replace(line, `\\class{${texHighlightClass(0)}}{${line}}`)
      );
    });
  });

  it.each([
    [
      'a cut inside a control word, taking in all of it',
      '1 + \\alpha + 2',
      5,
      7,
      '1 + \\class{C}{\\alpha} + 2',
    ],
    [
      'a cut inside \\begin{…}, taking in the environment',
      '\\begin{aligned}a\\end{aligned} + 1',
      3,
      31,
      '\\class{C}{\\begin{aligned}a\\end{aligned}} \\class{C}{+} 1',
    ],
    [
      'a script argument of one atom',
      'a^{2} + b',
      2,
      5,
      'a^\\class{C}{{2}} + b',
    ],
    ['a script base of one atom', 'a + b^2', 4, 5, 'a + \\class{C}{b}^2'],
    [
      'the cells of a row, each on its own',
      '\\begin{aligned}a &= b \\\\ c &= d\\end{aligned}',
      15,
      22,
      '\\begin{aligned}\\class{C}{a} &\\class{C}{=} \\class{C}{b} \\\\ c &= d\\end{aligned}',
    ],
    [
      'cells around an empty one, which is left out',
      '\\begin{aligned}a & & b\\end{aligned}',
      15,
      22,
      '\\begin{aligned}\\class{C}{a} & & \\class{C}{b}\\end{aligned}',
    ],
    [
      'rows, the line break left out',
      '\\begin{matrix}a \\\\[2pt] b\\end{matrix}',
      14,
      25,
      '\\begin{matrix}\\class{C}{a} \\\\[2pt] \\class{C}{b}\\end{matrix}',
    ],
    [
      'a line up to a comment, the comment left out',
      'a + b % note\n+ c',
      0,
      12,
      '\\class{C}{a + b} % note\n+ c',
    ],
    [
      'a comment between visible text, in the middle',
      'a % note\n+ b = c',
      0,
      13,
      '\\class{C}{a % note\n+ b} = c',
    ],
    [
      'a whole fraction',
      '1 + \\frac{a}{b} + 2',
      4,
      15,
      '1 + \\class{C}{\\frac{a}{b}} + 2',
    ],
    [
      'an atom beside an infix fraction',
      '{a \\over b}',
      1,
      2,
      '{\\class{C}{a} \\over b}',
    ],
    [
      'a \\verb with a brace in it',
      '1 + \\verb|{| + 2',
      4,
      12,
      '1 + \\class{C}{\\verb|{|} + 2',
    ],
    [
      'a \\left…\\right pair whole',
      'x + \\left( a \\right) + y',
      4,
      20,
      'x + \\class{C}{\\left( a \\right)} + y',
    ],
    [
      'text, with its macro, from inside it',
      '1 + \\text{a {b} c} = 2',
      13,
      14,
      '1 + \\class{C}{\\text{a {b} c}} = 2',
    ],
    [
      'a text argument without braces, with its macro',
      'x + \\text a + b',
      10,
      11,
      'x + \\class{C}{\\text a} + b',
    ],
    [
      'a text argument of a control word, with its macro',
      '1 + \\mbox\\alpha + 2',
      12,
      13,
      '1 + \\class{C}{\\mbox\\alpha} + 2',
    ],
    [
      'a text argument of a control symbol, with its macro',
      '1 + \\mbox\\, + 2',
      10,
      11,
      '1 + \\class{C}{\\mbox\\,} + 2',
    ],
    [
      'a colour box with both its arguments',
      '1 + \\colorbox{red}{a b} + 2',
      20,
      21,
      '1 + \\class{C}{\\colorbox{red}{a b}} + 2',
    ],
    [
      'an array with its column spec',
      '1 + \\begin{array}{cc} a \\end{array}',
      19,
      25,
      '1 + \\class{C}{\\begin{array}{cc} a \\end{array}}',
    ],
    [
      'a sized delimiter with its size',
      '\\bigl( a \\bigr) + 1',
      3,
      9,
      '\\class{C}{\\bigl( a} \\bigr) + 1',
    ],
    [
      'a switch running to the end of its group',
      '{a \\displaystyle b} + 1',
      3,
      18,
      '{a \\class{C}{\\displaystyle b}} + 1',
    ],
    [
      'a switch running to the end of its cell',
      '\\begin{aligned}\\displaystyle a & b\\end{aligned}',
      15,
      30,
      '\\begin{aligned}\\class{C}{\\displaystyle a} & b\\end{aligned}',
    ],
    [
      'a group holding an infix fraction',
      'x + {a \\over b} + y',
      4,
      15,
      'x + \\class{C}{{a \\over b}} + y',
    ],
    [
      'beside a \\left…\\right pair with a \\middle',
      '\\left( a \\middle| b \\right) + c',
      30,
      31,
      '\\left( a \\middle| b \\right) + \\class{C}{c}',
    ],
    [
      'a code point beyond the basic plane whole, from its second half',
      '1 + \u{1d465} + 2',
      5,
      6,
      '1 + \\class{C}{\u{1d465}} + 2',
    ],
    [
      'the character after U+FFFF on its own',
      '\uffff+b',
      1,
      2,
      '\uffff\\class{C}{+}b',
    ],
    [
      'text with an escaped brace in it, whole',
      '1 + \\text{a \\} b} = 2',
      15,
      16,
      '1 + \\class{C}{\\text{a \\} b}} = 2',
    ],
    [
      'beside an \\fcolorbox with no arguments',
      '{\\fcolorbox} + 1',
      13,
      14,
      '{\\fcolorbox} \\class{C}{+} 1',
    ],
    ['a negated relation whole', 'a \\not= b', 6, 7, 'a \\class{C}{\\not=} b'],
    [
      'escaped braces as atoms',
      '1 + \\{ a \\} + 2',
      4,
      11,
      '1 + \\class{C}{\\{ a \\}} + 2',
    ],
  ])('wraps %s', (_name, tex, start, end, expected) => {
    const result = wrapTexRanges(tex, [{ start, end }]);
    expect(result.status).toEqual(['wrapped']);
    expect(result.tex).toBe(
      expected.replaceAll('{C}', `{${texHighlightClass(0)}}`)
    );
  });

  it.each([
    ['cuts a group', 'e^{i\\pi} + 1', 4, 11],
    ['cuts an environment', '\\begin{aligned}a\\end{aligned} + 1', 15, 33],
    ['cuts a \\left…\\right pair', '\\left( a + b \\right) + 1', 9, 24],
    [
      'holds a \\middle of a pair around it',
      '\\left( a \\middle| b \\right)',
      7,
      19,
    ],
    ['holds an infix fraction', '{a + b \\over c}', 1, 12],
    ['starts with a script', 'a^2 + b', 1, 7],
    ['ends with a script', 'a + b^2', 0, 6],
    ['starts with a prime', "f' + g", 1, 6],
    ['starts with \\limits', '\\sum\\limits_{i} + 1', 4, 19],
    ['is a script argument of more than one atom', 'a^2 + b', 2, 7],
    ['is a script base of more than one atom', 'a + b^2', 0, 5],
    ['is a script base of a group and more', '{a} b^2', 0, 5],
    [
      'is a script base of more than one atom, a space before the script',
      'a + b ^2',
      0,
      5,
    ],
    [
      'is a script argument of more than one atom, after a space',
      'a^ 2 + b',
      3,
      8,
    ],
    ['is the base of a prime and more', "a + f' + g", 0, 5],
    ['starts with a subscript', 'a_2 + b', 1, 7],
    ['is a script base of two atoms side by side', 'x + ab^2', 4, 6],
    [
      'is in TeX whose environments do not match',
      '\\begin{aligned} a \\end{matrix} + 1',
      33,
      34,
    ],
    ['is a script base of a group closed early', '{a}{b}^2', 0, 6],
    [
      'holds a switch, but not the rest of its group',
      '{\\displaystyle a + b}',
      1,
      16,
    ],
    ['is in TeX with a text argument never closed', '1 + \\text{a + b', 0, 1],
    ['is in TeX with a \\middle outside any pair', 'a \\middle| b', 0, 1],
  ])(
    'falls back to the whole expression for a range that %s',
    (_name, tex, start, end) => {
      const result = wrapTexRanges(tex, [
        { start, end },
        { start: 0, end: 0 },
      ]);
      expect(result).toEqual({ tex, status: ['whole', 'none'] });
    }
  );

  it.each([
    [
      '\\text with no argument before a closing brace',
      '{\\text} + 1',
      8,
      9,
      '{\\text} \\class{C}{+} 1',
    ],
    [
      '\\mbox with no argument at the end',
      '1 + \\mbox',
      2,
      9,
      '1 \\class{C}{+} \\class{C}{\\mbox}',
    ],
    [
      '\\left with no delimiter',
      '\\left{a} + b',
      6,
      7,
      '\\left{\\class{C}{a}} + b',
    ],
    [
      '\\verb never closed',
      '\\verb!a + b',
      8,
      11,
      '\\verb!a \\class{C}{+} \\class{C}{b}',
    ],
  ])('reads %s as a plain control word', (_name, tex, start, end, expected) => {
    const result = wrapTexRanges(tex, [{ start, end }]);
    expect(result.status).toEqual(['wrapped']);
    expect(result.tex).toBe(
      expected.replaceAll('{C}', `{${texHighlightClass(0)}}`)
    );
  });

  // Each checked against Obsidian's MathJax: wrapped whole, these render
  // with different spacing, or with letters MathJax draws as one split apart
  it.each([
    [
      'a binary operator ending it',
      'a = b + c',
      4,
      7,
      'a = \\class{C}{b} \\class{C}{+} c',
    ],
    [
      'a named operator ending it',
      'x + \\sin y',
      0,
      8,
      '\\class{C}{x} \\class{C}{+} \\class{C}{\\sin} y',
    ],
    [
      'a large operator and its limits starting it',
      '\\sum_{i} x_i + y',
      0,
      12,
      '\\class{C}{\\sum_{i}} \\class{C}{x_i} + y',
    ],
    [
      'a negated relation ending it',
      'a \\not= b',
      0,
      6,
      '\\class{C}{a} \\class{C}{\\not=} b',
    ],
    [
      'a relation as a character ending it',
      'a ≤ b',
      0,
      3,
      '\\class{C}{a} \\class{C}{≤} b',
    ],
    [
      'part of an operator name, taking in all of it',
      '\\operatorname*{arg\\,max}_x f',
      16,
      18,
      '\\class{C}{\\operatorname*{arg\\,max}}_x f',
    ],
    [
      'part of a font command’s letters, taking in all of them',
      '\\mathrm{dy} + 1',
      9,
      10,
      '\\class{C}{\\mathrm{dy}} + 1',
    ],
    [
      'part of an unstarred operator name, taking in all of it',
      '\\operatorname{sin} x',
      15,
      16,
      '\\class{C}{\\operatorname{sin}} x',
    ],
    [
      'a large operator with \\limits starting it',
      '\\sum\\limits_{i} x + y',
      0,
      17,
      '\\class{C}{\\sum\\limits_{i}} \\class{C}{x} + y',
    ],
    [
      'a star after a control word, which is no part of it',
      '\\alpha*b',
      6,
      7,
      '\\alpha\\class{C}{*}b',
    ],
  ])('wraps %s', (_name, tex, start, end, expected) => {
    const result = wrapTexRanges(tex, [{ start, end }]);
    expect(result.status).toEqual(['wrapped']);
    expect(result.tex).toBe(
      expected.replaceAll('{C}', `{${texHighlightClass(0)}}`)
    );
  });

  it('shows a style switch cut off from its group’s end by an operator set apart on the whole formula', () => {
    const tex = '{\\scriptstyle a +} c';
    expect(wrapTexRanges(tex, [{ start: 1, end: 17 }])).toEqual({
      tex,
      status: ['whole'],
    });
  });

  it('shows a cut into an array’s position and column spec on the whole formula', () => {
    const tex = '\\begin{array}[t]{cc} a & b \\end{array} + 1';
    expect(wrapTexRanges(tex, [{ start: 14, end: 15 }])).toEqual({
      tex,
      status: ['whole'],
    });
  });

  it('keeps an earlier range wrapped when a later one would cut it apart', () => {
    const tex = '\\frac{a}{b} + 1';
    const result = wrapTexRanges(tex, [
      { start: 0, end: 11 },
      { start: 9, end: 10 },
    ]);
    expect(result.status).toEqual(['wrapped', 'whole']);
    expect(result.tex).toBe(
      `\\class{${texHighlightClass(0)}}{\\frac{a}{b}} + 1`
    );
  });

  it('wraps ranges in different groups, whatever lies between them', () => {
    const tex = '{a} + {b}';
    const result = wrapTexRanges(tex, [
      { start: 1, end: 2 },
      { start: 7, end: 8 },
    ]);
    expect(result.status).toEqual(['wrapped', 'wrapped']);
    expect(result.tex).toBe(
      `{\\class{${texHighlightClass(0)}}{a}} + {\\class{${texHighlightClass(1)}}{b}}`
    );
  });

  it('shows nothing for a range of only a separator', () => {
    const tex = '\\begin{aligned}a & b\\end{aligned}';
    expect(wrapTexRanges(tex, [{ start: 17, end: 18 }])).toEqual({
      tex,
      status: ['none'],
    });
  });
});
