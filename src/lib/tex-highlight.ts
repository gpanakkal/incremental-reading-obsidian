/**
 * Marking a stretch of TeX so the math MathJax renders from it carries a
 * class there: the part of a rendered formula a snippet was cut from.
 *
 * MathJax's output keeps no offsets into its source, so the TeX itself is
 * rewritten: each stretch is wrapped in `\class{…}{…}` (the `html` TeX
 * package, which Obsidian loads) in the copy handed to the renderer, never in
 * the note. A wrap that would change how the formula renders is never made;
 * such a stretch shows on the whole formula instead.
 */

/** How a range of TeX shows once the TeX is rendered. */
export type TexHighlightStatus =
  /** On the elements with its class, see {@link texHighlightClass} */
  | 'wrapped'
  /** On the whole rendered formula */
  | 'whole'
  /** Nowhere: it holds nothing that renders as anything */
  | 'none';

/** A stretch of TeX, by offsets into it. */
export interface TexRange {
  start: number;
  end: number;
}

export interface WrappedTex {
  /** The TeX to render, its ranges wrapped */
  tex: string;
  /** For each range, by its index, how it shows */
  status: TexHighlightStatus[];
}

/**
 * The class range `index`'s wrapped stretches render with. Obsidian runs
 * MathJax's `ui/safe` extension, which drops any class not matching
 * `^mjx-[-a-zA-Z0-9_.]+$`.
 */
export const texHighlightClass = (index: number) => `mjx-ir-snippet-${index}`;

type Kind =
  | 'space'
  | 'comment'
  | 'open'
  | 'close'
  /** `\middle`, which belongs to the `\left`…`\right` around it */
  | 'middle'
  /** Ends a row or cell: `&`, `\\`, `\cr`, … */
  | 'separator'
  /** `\over` and its kin, which split the whole group they are in */
  | 'infix'
  /** A style, font or size switch, which holds for the rest of its group */
  | 'switch'
  | 'script'
  /** What binds to the atom before it as a script does: `'`, `\limits` */
  | 'postfix'
  | 'atom';

interface Token {
  start: number;
  end: number;
  kind: Kind;
  /** For an opener, closer or `\middle`, what it pairs with */
  name?: string;
  /** How many groups are open before it */
  depth: number;
  /** For an atom, whether it is an operator, see {@link OPERATOR_WORDS} */
  operator?: boolean;
}

const WORD_KINDS = new Map<string, Kind>([
  ...['cr', 'newline', 'hline', 'hdashline'].map(
    (w) => [w, 'separator'] as const
  ),
  ...[
    'over',
    'atop',
    'above',
    'choose',
    'brace',
    'brack',
    'overwithdelims',
    'atopwithdelims',
    'abovewithdelims',
  ].map((w) => [w, 'infix'] as const),
  ...['limits', 'nolimits', 'displaylimits'].map(
    (w) => [w, 'postfix'] as const
  ),
  ...[
    'displaystyle',
    'textstyle',
    'scriptstyle',
    'scriptscriptstyle',
    'rm',
    'bf',
    'it',
    'sf',
    'tt',
    'cal',
    'mit',
    'oldstyle',
    'scr',
    'frak',
    'tiny',
    'Tiny',
    'scriptsize',
    'small',
    'normalsize',
    'large',
    'Large',
    'LARGE',
    'huge',
    'Huge',
    'color',
  ].map((w) => [w, 'switch'] as const),
]);

/**
 * Operators: binary operators, relations and large or named operators, as
 * control words and characters. MathJax spaces them by what is next to them,
 * which a wrap ending in one (or, in an `aligned` cell, starting with one)
 * hides from it: they are wrapped on their own, their spacing kept.
 */
const OPERATOR_WORDS = new Set(
  [
    // Binary operators
    'pm mp times div cdot ast star circ bullet cap cup uplus sqcap sqcup vee',
    'wedge lor land setminus smallsetminus wr diamond bigtriangleup',
    'bigtriangledown triangleleft triangleright lhd rhd unlhd unrhd oplus',
    'ominus otimes oslash odot bigcirc dagger ddagger amalg dotplus centerdot',
    'ltimes rtimes leftthreetimes rightthreetimes curlywedge curlyvee',
    'circleddash circledast circledcirc boxminus boxtimes boxdot boxplus',
    'divideontimes barwedge veebar doublebarwedge Cap Cup intercal gtrdot',
    'lessdot bmod',
    // Relations
    'leq le geq ge neq ne equiv approx approxeq sim simeq cong propto in',
    'notin ni owns subset supset subseteq supseteq subsetneq supsetneq',
    'subseteqq supseteqq subsetneqq supsetneqq sqsubset sqsupset sqsubseteq',
    'sqsupseteq to gets rightarrow leftarrow leftrightarrow Rightarrow',
    'Leftarrow Leftrightarrow mapsto longrightarrow longleftarrow',
    'longleftrightarrow Longrightarrow Longleftarrow Longleftrightarrow',
    'longmapsto implies impliedby iff hookrightarrow hookleftarrow uparrow',
    'downarrow updownarrow Uparrow Downarrow Updownarrow nearrow searrow',
    'swarrow nwarrow rightleftharpoons leftrightharpoons mid nmid parallel',
    'nparallel perp models vdash dashv vDash Vdash ll gg lll ggg prec succ',
    'preceq succeq asymp doteq bowtie smile frown coloneqq eqqcolon coloneq',
    'leqslant geqslant lesssim gtrsim lessgtr gtrless nless ngtr nleq ngeq',
    'ncong nsim lneq gneq triangleq trianglelefteq trianglerighteq',
    // Named and large operators
    'sin cos tan cot sec csc sinh cosh tanh coth arcsin arccos arctan log ln',
    'lg exp lim limsup liminf max min sup inf det gcd Pr arg deg dim hom ker',
    'injlim projlim varlimsup varliminf varinjlim varprojlim sum prod coprod',
    'int iint iiint iiiint oint idotsint bigcup bigcap bigsqcup biguplus',
    'bigvee bigwedge bigodot bigoplus bigotimes operatorname',
  ]
    .join(' ')
    .split(' ')
);
const OPERATOR_CHARS = new Set(
  '+-*=<>:±∓×÷·∗∘∙∩∪⊕⊖⊗⊘⊙∧∨∖≤≥≠≈≡∼≃≅∝∈∉∋⊂⊃⊆⊇→←↔⇒⇐⇔↦∣∥⊥≪≫−∑∏∫∮⋃⋂'
);

/**
 * Control words whose first arguments, this many, are no math: text, a
 * label, a URL, a colour or class name. They are read with the word as one
 * token, so no wrap goes inside them, where it would show as typed.
 */
const OPAQUE_ARGUMENTS = new Map<string, number>([
  ...[
    'text',
    'textrm',
    'textit',
    'textbf',
    'textsf',
    'texttt',
    'textnormal',
    'textup',
    'textmd',
    'textsl',
    'textsc',
    'mbox',
    'hbox',
    'fbox',
    'tag',
    'label',
    'ref',
    'eqref',
    'ce',
    'pu',
    'require',
    'unicode',
    'href',
    'class',
    'style',
    'cssId',
    'data',
    'color',
    'textcolor',
    // MathJax draws a run of letters in these as one, which a wrap would split
    'operatorname',
    'mathrm',
    'mathup',
    'mathit',
    'mathbf',
    'mathsf',
    'mathtt',
    'mathnormal',
    'mathcal',
    'mathscr',
    'mathfrak',
    'mathbb',
    'mathbfup',
    'mathbfit',
    'mathsfup',
    'mathsfit',
    'mathbfsf',
    'mathbfsfup',
    'mathbfsfit',
    'mathbfcal',
    'mathbfscr',
    'mathbffrak',
  ].map((w) => [w, 1] as const),
  ['colorbox', 2],
  ['fcolorbox', 3],
]);

/** Environments that take an argument after `\begin{…}`: a column spec */
const ENVIRONMENT_ARGUMENTS = new Set([
  'array',
  'subarray',
  'alignat',
  'alignat*',
  'alignedat',
  'xalignat',
  'xalignat*',
  'xxalignat',
]);

/** `{name}` after `\begin` or `\end` */
const ENVIRONMENT = /\s*\{([^{}]*)\}/y;
/** A delimiter, after `\left`, `\right`, `\middle`, `\big`… or `\not` */
const DELIMITER = /\s*(?:\\[a-zA-Z]+|\\.|[^\s{}\\])/uy;
/** A size command, which takes a delimiter */
const SIZE = /^[bB]ig{1,2}[lmr]?$/;
/** An optional argument: `[…]` */
const OPTIONAL = /\s*\[[^\]]*\]/y;
/** What `\\` takes after it: a star, then an optional spacing */
const NEWLINE_ARGUMENT = /\*?(?:\s*\[[^\]]*\])?/y;
const CONTROL_WORD = /[a-zA-Z]+/y;
const SPACE = /\s+/y;

/** The end of the match of sticky `pattern` at `at`, or -1. */
function matchEnd(pattern: RegExp, tex: string, at: number): number {
  pattern.lastIndex = at;
  return pattern.test(tex) ? pattern.lastIndex : -1;
}

/** The end of the code point at `at`. */
const codePointEnd = (tex: string, at: number) =>
  at + (tex.codePointAt(at)! > 0xffff ? 2 : 1);

/**
 * The end of the argument at `at`, past spaces: a `{…}` group, its braces
 * counted, or a single token; -1 for none, or one never closed.
 */
function argumentEnd(tex: string, at: number): number {
  const start = Math.max(at, matchEnd(SPACE, tex, at));
  if (start >= tex.length || tex[start] === '}') return -1;
  if (tex[start] !== '{') {
    if (tex[start] !== '\\') return codePointEnd(tex, start);
    const word = matchEnd(CONTROL_WORD, tex, start + 1);
    return word > 0 ? word : Math.min(codePointEnd(tex, start + 1), tex.length);
  }
  let depth = 0;
  for (let k = start; k < tex.length; k += 1) {
    if (tex[k] === '\\') k += 1;
    else if (tex[k] === '{') depth += 1;
    else if (tex[k] === '}' && --depth === 0) return k + 1;
  }
  return -1;
}

/** The end of `count` arguments from `at`, or -1 if any is missing. */
function argumentsEnd(tex: string, at: number, count: number): number {
  let end = at;
  for (let k = 0; k < count && end >= 0; k += 1) end = argumentEnd(tex, end);
  return end;
}

type Read = Omit<Token, 'depth'>;

/** The control word token `\word` from `at`, ending at `wordEnd`. */
function readControlWord(tex: string, at: number, wordEnd: number): Read {
  const word = tex.slice(at + 1, wordEnd);
  const token = (end: number, kind: Kind, name?: string): Read => ({
    start: at,
    end,
    kind,
    name,
  });
  if (word === 'begin' || word === 'end') {
    ENVIRONMENT.lastIndex = wordEnd;
    const env = ENVIRONMENT.exec(tex);
    if (env) {
      const name = `env ${env[1]}`;
      if (word === 'end') return token(ENVIRONMENT.lastIndex, 'close', name);
      // `\begin{array}[t]{cc}`: a position, then the column spec
      let end = Math.max(
        ENVIRONMENT.lastIndex,
        matchEnd(OPTIONAL, tex, ENVIRONMENT.lastIndex)
      );
      if (ENVIRONMENT_ARGUMENTS.has(env[1])) {
        end = Math.max(end, argumentEnd(tex, end));
      }
      return token(Math.max(end, matchEnd(OPTIONAL, tex, end)), 'open', name);
    }
  } else if (
    ['left', 'right', 'middle', 'not'].includes(word) ||
    SIZE.test(word)
  ) {
    const end = matchEnd(DELIMITER, tex, wordEnd);
    if (end > 0) {
      if (word === 'left') return token(end, 'open', 'left');
      if (word === 'right') return token(end, 'close', 'left');
      if (word === 'middle') return token(end, 'middle', 'left');
      return { ...token(end, 'atom'), operator: word === 'not' };
    }
  } else if (word === 'verb' && wordEnd < tex.length) {
    const delimiterEnd = codePointEnd(tex, wordEnd);
    const close = tex.indexOf(tex.slice(wordEnd, delimiterEnd), delimiterEnd);
    if (close >= 0) return token(close + delimiterEnd - wordEnd, 'atom');
  }
  const kind = WORD_KINDS.get(word) ?? 'atom';
  const count = OPAQUE_ARGUMENTS.get(word) ?? 0;
  // `\operatorname*`, whose star is no argument
  const from =
    word === 'operatorname' && tex[wordEnd] === '*' ? wordEnd + 1 : wordEnd;
  const end = argumentsEnd(tex, from, count);
  return {
    ...token(end < 0 ? wordEnd : end, kind),
    operator: OPERATOR_WORDS.has(word),
  };
}

/** The token starting at `at`, less its depth. */
function readToken(tex: string, at: number): Read {
  const c = tex[at];
  const token = (end: number, kind: Kind, name?: string): Read => ({
    start: at,
    end,
    kind,
    name,
  });
  if (c === '%') {
    const newline = tex.indexOf('\n', at);
    return token(newline < 0 ? tex.length : newline, 'comment');
  }
  const space = matchEnd(SPACE, tex, at);
  if (space > 0) return token(space, 'space');
  if (c === '{') return token(at + 1, 'open', '{');
  if (c === '}') return token(at + 1, 'close', '{');
  if (c === '&') return token(at + 1, 'separator');
  if (c === '^' || c === '_') return token(at + 1, 'script');
  if (c === "'") return token(at + 1, 'postfix');
  if (c !== '\\' || at + 1 === tex.length) {
    const end = codePointEnd(tex, at);
    const operator = OPERATOR_CHARS.has(tex.slice(at, end));
    return { ...token(end, 'atom'), operator };
  }
  const wordEnd = matchEnd(CONTROL_WORD, tex, at + 1);
  if (wordEnd > 0) return readControlWord(tex, at, wordEnd);
  if (tex[at + 1] === '\\') {
    return token(matchEnd(NEWLINE_ARGUMENT, tex, at + 2), 'separator');
  }
  return token(codePointEnd(tex, at + 1), 'atom');
}

/**
 * `tex`'s tokens, each with its depth, and whether its groups, environments
 * and delimiter pairs all match; where they don't, no group can be told
 * apart from another.
 */
function tokenize(tex: string): { tokens: Token[]; balanced: boolean } {
  const tokens: Token[] = [];
  const open: string[] = [];
  let balanced = true;
  for (let at = 0; at < tex.length; ) {
    const token = readToken(tex, at);
    tokens.push({ ...token, depth: open.length });
    if (token.kind === 'close' && open.pop() !== token.name) balanced = false;
    if (token.kind === 'middle' && open.at(-1) !== token.name) balanced = false;
    if (token.kind === 'open') open.push(token.name!);
    at = token.end;
  }
  return { tokens, balanced: balanced && open.length === 0 };
}

const isBlank = ({ kind }: Token) => kind === 'space' || kind === 'comment';
const shows = (token: Token) => !isBlank(token) && token.kind !== 'separator';

/** How many groups are open after `token`. */
const depthAfter = ({ depth, kind }: Token) =>
  depth + (kind === 'open' ? 1 : kind === 'close' ? -1 : 0);

/** A run of tokens, `from` up to `to`, by index. */
interface Span {
  from: number;
  to: number;
}

/**
 * Whether the tokens of `span` close every group they open, and none opened
 * before them.
 */
function closed(tokens: Token[], { from, to }: Span): boolean {
  const depth = tokens[from].depth;
  for (let k = from; k < to; k += 1) {
    if (depthAfter(tokens[k]) < depth) return false;
  }
  return depthAfter(tokens[to - 1]) === depth;
}

/** The first token from `k` on, by `step`, that isn't blank, if any. */
function significant(
  tokens: Token[],
  k: number,
  step: 1 | -1
): Token | undefined {
  while (tokens[k] && isBlank(tokens[k])) k += step;
  return tokens[k];
}

/** Whether tokens `first` to `last` are one atom: a token, or one group. */
function oneAtom(tokens: Token[], first: number, last: number): boolean {
  if (first === last) return tokens[first].kind === 'atom';
  if (tokens[first].kind !== 'open') return false;
  const depth = tokens[first].depth;
  for (let k = first + 1; k < last; k += 1) {
    if (tokens[k].depth === depth) return false;
  }
  return true;
}

/**
 * Whether tokens `first` to `last` (closed, neither blank, with no separator
 * at their depth) can be wrapped and render as before.
 *
 * Not if they hold, at their own depth, a `\middle` of delimiters around
 * them, or an infix fraction, which would take in the wrap alone; nor a
 * switch, unless they run to the end of its group. Not if they start with a
 * script, a prime or `\limits`, or end with a script, which bind to the atom
 * next to them; nor if they are a script's base or argument of more than one
 * atom.
 */
function wrappable(tokens: Token[], first: number, last: number): boolean {
  const depth = tokens[first].depth;
  const before = significant(tokens, first - 1, -1);
  const after = significant(tokens, last + 1, 1);
  for (let k = first; k <= last; k += 1) {
    const { kind } = tokens[k];
    if (tokens[k].depth !== depth) continue;
    if (kind === 'middle' || kind === 'infix') return false;
    const ends = !after || after.kind === 'close' || after.kind === 'separator';
    if (kind === 'switch' && !ends) return false;
  }
  const { kind: firstKind } = tokens[first];
  if (firstKind === 'script' || firstKind === 'postfix') return false;
  if (tokens[last].kind === 'script') return false;
  const bound =
    before?.kind === 'script' ||
    after?.kind === 'script' ||
    after?.kind === 'postfix';
  return !bound || oneAtom(tokens, first, last);
}

/**
 * The stretches `span` (closed) is wrapped in: those between the separators
 * at its own depth, less blanks at their edges, each with the operators it
 * starts or ends with apart (see {@link operatorsApart}). Null when one can't
 * be wrapped.
 */
function pieces(tokens: Token[], { from, to }: Span): Span[] | null {
  const depth = tokens[from].depth;
  const found: Span[] = [];
  let start = from;
  for (let k = from; k <= to; k += 1) {
    if (
      k < to &&
      (tokens[k].depth !== depth || tokens[k].kind !== 'separator')
    ) {
      continue;
    }
    const units = atoms(tokens, depth, start, k);
    if (units.length > 0) {
      for (const piece of operatorsApart(tokens, units)) {
        if (!wrappable(tokens, piece.from, piece.to - 1)) return null;
        found.push(piece);
      }
    }
    start = k + 1;
  }
  return found;
}

/**
 * The atoms among tokens `from` up to `to`, at `depth`, less blanks: each
 * token or group with the scripts, primes and `\limits` after it. A script
 * or prime with nothing before it starts one of its own.
 */
function atoms(
  tokens: Token[],
  depth: number,
  from: number,
  to: number
): Span[] {
  const starts: number[] = [];
  let afterScript = false;
  for (let k = from; k < to; k += 1) {
    const { kind } = tokens[k];
    if (tokens[k].depth !== depth || isBlank(tokens[k])) continue;
    const bound = afterScript || kind === 'script' || kind === 'postfix';
    if (!bound || starts.length === 0) starts.push(k);
    afterScript = kind === 'script';
  }
  return starts.map((start, i) => {
    let end = (starts[i + 1] ?? to) - 1;
    while (isBlank(tokens[end])) end -= 1;
    return { from: start, to: end + 1 };
  });
}

/**
 * Atoms `units` (closed, together) as stretches to wrap: the operators they
 * start or end with each alone, the rest together. A wrap of more than one
 * atom renders as an ordinary atom on the outside, so an operator at its end
 * would lose the spacing MathJax gives it from the atom after it (and,
 * starting an `aligned` cell, from the alignment before it).
 */
function operatorsApart(tokens: Token[], units: readonly Span[]): Span[] {
  const isOperator = ({ from }: Span) => tokens[from].operator === true;
  let lo = 0;
  let hi = units.length - 1;
  while (lo < hi && isOperator(units[lo])) lo += 1;
  while (hi > lo && isOperator(units[hi])) hi -= 1;
  return [
    ...units.slice(0, lo),
    { from: units[lo].from, to: units[hi].to },
    ...units.slice(hi + 1),
  ];
}

interface Stretch {
  span: Span;
  /** The ranges it is part of, whose classes wrap it */
  indices: number[];
}

/**
 * The stretches to wrap for the ranges `spans`, or null when one can't be
 * wrapped. Each run between two neighbouring ends of any of the ranges is
 * wrapped on its own, in the classes of every range it is part of, so the
 * wraps of overlapping ranges never cross.
 */
function stretches(
  tokens: Token[],
  spans: Map<number, Span>
): Stretch[] | null {
  const ends = [
    ...new Set([...spans.values()].flatMap(({ from, to }) => [from, to])),
  ].sort((a, b) => a - b);
  const found: Stretch[] = [];
  for (let k = 0; k + 1 < ends.length; k += 1) {
    const span = { from: ends[k], to: ends[k + 1] };
    const indices = [...spans.entries()]
      .filter(([, { from, to }]) => from <= span.from && span.to <= to)
      .map(([index]) => index);
    if (indices.length === 0) continue;
    const split = closed(tokens, span) ? pieces(tokens, span) : null;
    if (!split) return null;
    for (const piece of split) found.push({ span: piece, indices });
  }
  return found;
}

/**
 * `tex` with each of `ranges` wrapped in its class where that changes
 * nothing else about how it renders, and how each range shows.
 *
 * A range takes in every token it touches, less blanks at its ends, and is
 * wrapped stretch by stretch between the row and cell separators in it. One
 * touching every token that shows shows on the whole formula, as does one
 * that cuts a group, an environment or a `\left`…`\right` pair, or can't be
 * wrapped without changing how the formula renders (see {@link wrappable}).
 * Of two ranges whose wraps can't both be made, the earlier is wrapped.
 */
export function wrapTexRanges(
  tex: string,
  ranges: readonly TexRange[]
): WrappedTex {
  const { tokens, balanced } = tokenize(tex);
  const visible = tokens.flatMap((token, k) => (shows(token) ? [k] : []));
  const accepted = new Map<number, Span>();
  let wrapped: Stretch[] = [];
  const status = ranges.map(({ start, end }, index): TexHighlightStatus => {
    const own = visible.filter(
      (k) => tokens[k].start < end && tokens[k].end > start
    );
    if (own.length === 0) return 'none';
    const span = { from: own[0], to: own[own.length - 1] + 1 };
    const whole =
      span.from === visible[0] && span.to === visible[visible.length - 1] + 1;
    if (whole || !balanced) return 'whole';
    const found = stretches(tokens, new Map(accepted).set(index, span));
    if (!found) return 'whole';
    accepted.set(index, span);
    wrapped = found;
    return 'wrapped';
  });

  let out = '';
  let at = 0;
  for (const { span, indices } of wrapped) {
    const start = tokens[span.from].start;
    const end = tokens[span.to - 1].end;
    const opens = indices.map((i) => `\\class{${texHighlightClass(i)}}{`);
    out += tex.slice(at, start) + opens.join('') + tex.slice(start, end);
    out += '}'.repeat(indices.length);
    at = end;
  }
  return { tex: out + tex.slice(at), status };
}
