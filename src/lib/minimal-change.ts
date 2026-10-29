import { ChangeSet, type ChangeSpec, type Text } from '@codemirror/state';

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** A character a backslash escapes in Markdown: any ASCII punctuation. */
const ESCAPABLE = /^[!-/:-@[-`{-~]$/;

/**
 * Whether a backslash escapes the character at `at` in `text`: an escapable
 * one, after an odd run of backslashes (an even one escapes itself).
 */
function isEscaped(text: string, at: number): boolean {
  if (!ESCAPABLE.test(text.charAt(at))) return false;
  let backslashes = 0;
  while (text.charAt(at - 1 - backslashes) === '\\') backslashes++;
  return backslashes % 2 === 1;
}

/**
 * The narrowest replacement that turns `current` into `next`, or `null` when
 * they already match.
 *
 * CodeMirror holds the viewport still across a document change by remembering
 * the line at the top of the screen and re-locating it afterwards: `ViewState`
 * saves `scrollAnchorPos = changes.mapPos(anchor.from, -1)`, then the next
 * measure pass shifts `scrollDOM.scrollTop` by however far that line moved. A
 * `{from: 0, to: doc.length}` replacement deletes the anchor along with the
 * rest of the document, so `mapPos` collapses it to 0 and the measure pass
 * dutifully scrolls line 0 back under the viewport top — the jump to the top of
 * the note. That correction lands on the next animation frame, which is why
 * restoring `scrollTop` by hand right after the dispatch cannot prevent it.
 *
 * Trimming the shared prefix and suffix leaves the anchor outside the changed
 * range, where it maps to itself. It also lets the selection map correctly
 * instead of collapsing, and spares undo history and decorations from a
 * needless rebuild.
 *
 * @param placement where to put the change when it could go in more than one
 *   place — putting `a` into `aa` makes `aaa` wherever it goes: `'latest'`
 *   trims the shared prefix first, `'earliest'` the shared suffix.
 * @param keepEscapes never start the shared tail on a character a backslash
 *   escapes in `current`, at the cost of a change one character wider: its
 *   backslash left in the change, it could match to a bare one in `next`, as
 *   an escaped pipe in a table cell to the pipe a re-pad puts after it. The
 *   shared head needs no such care: each of its characters follows the same
 *   text in both, so is escaped in both or in neither. Nor does an escape
 *   only `next` has, which the change made: a backslash put in before a
 *   character, or one left before a character put in, stays outside the
 *   change, as the highlight it begins or ends does (pulling it in could
 *   match it to some other backslash).
 */
export function computeMinimalChange(
  current: string,
  next: string,
  placement: 'latest' | 'earliest' = 'latest',
  keepEscapes = false
): { from: number; to: number; insert: string } | null {
  if (current === next) return null;

  const shorter = Math.min(current.length, next.length);
  /** How many code units from the start (or end) both texts share, up to `limit`. */
  const shared = (limit: number, fromEnd: boolean) => {
    let n = 0;
    while (
      n < limit &&
      (fromEnd
        ? current.charCodeAt(current.length - 1 - n) ===
          next.charCodeAt(next.length - 1 - n)
        : current.charCodeAt(n) === next.charCodeAt(n))
    ) {
      n++;
    }
    return n;
  };
  /** `n` shared code units at the end, less one `current` escapes they start on. */
  const keepSuffix = (n: number) =>
    keepEscapes && isEscaped(current, current.length - n) ? n - 1 : n;
  let prefix: number;
  let suffix: number;
  if (placement === 'latest') {
    prefix = shared(shorter, false);
    suffix = keepSuffix(shared(shorter - prefix, true));
  } else {
    suffix = keepSuffix(shared(shorter, true));
    prefix = shared(shorter - suffix, false);
  }

  // Both boundaries are code-unit offsets, so either can land between the
  // halves of a surrogate pair and hand CodeMirror a position inside an
  // astral character. Widening the changed range by one unit swallows the pair
  // whole; it can never underflow, since `charCodeAt` off either end is NaN.
  if (isHighSurrogate(current.charCodeAt(prefix - 1))) prefix--;
  if (isLowSurrogate(current.charCodeAt(current.length - suffix))) suffix--;

  return {
    from: prefix,
    to: current.length - suffix,
    insert: next.slice(prefix, next.length - suffix),
  };
}

/** A word, or any other character but whitespace, and where it starts. */
type Token = { text: string; at: number };

/**
 * Words (letters, digits, marks and underscores), runs of dashes, and the
 * single characters between them, whitespace left out: what a re-pad, a
 * re-wrap or a re-indent never changes. A run of dashes is one token, so a
 * table separator row widened by a re-pad is no edit (see {@link keyOf}),
 * not one per dash added (see {@link MAX_EDITS}). A backslash escape is one
 * token too, so an escaped pipe in a cell's text never matches a pipe of the
 * table's own (see {@link TABLE_MARKUP}).
 */
const TOKEN = /\\[!-/:-@[-`{-~]|[\p{L}\p{N}\p{M}_]+|-+|\S/gu;

const tokenize = (text: string): Token[] =>
  Array.from(text.matchAll(TOKEN), (m) => ({ text: m[0], at: m.index ?? 0 }));

/**
 * What `token` is matched by: a run of dashes as any other, as a re-pad widens
 * a separator row's dashes along with their column. Matched, a run anchors
 * where it starts, so a highlight from a header row into the rows below
 * keeps the separator row inside it.
 */
const keyOf = ({ text }: Token) => (text.startsWith('-') ? '-' : text);

/**
 * Most tokens added and removed {@link matchTokens} looks for: a whole-block
 * rewrite that keeps its text changes a handful, while two unrelated texts
 * differ by about as many as they hold.
 */
const MAX_EDITS = 500;
/** Most tokens compared, times edits looked for, in one {@link matchTokens}. */
const MAX_WORK = 4_000_000;

/**
 * The pairs of like tokens a shortest edit script from `a` to `b` keeps, as
 * `[index in a, index in b]` in order; `null` when that script would add and
 * remove more tokens than it is worth looking for (Myers' O((N+M)D) diff).
 * Of like scripts, it keeps the earliest tokens it can, putting each edit as
 * late as it can go.
 */
function matchTokens(a: string[], b: string[]): [number, number][] | null {
  const n = a.length;
  const m = b.length;
  const maxD = Math.min(MAX_EDITS, Math.floor(MAX_WORK / (n + m)));
  // Every edit moves one diagonal: never fewer than the lengths differ by
  if (Math.abs(n - m) > maxD) return null;
  // How far along `a` the furthest path with `d` edits reaches on each
  // diagonal k = x - y, kept at every `d` to walk the path back
  const offset = maxD + 1;
  const v = new Int32Array(2 * maxD + 3);
  const trace: Int32Array[] = [];
  /** Which neighbouring diagonal the furthest path onto `k` comes from. */
  const down = (row: Int32Array, k: number, d: number) =>
    k === -d || (k !== d && row[offset + k - 1] < row[offset + k + 1]);
  for (let d = 0; d <= maxD; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = down(v, k, d) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x < n || y < m) continue;
      // Reached the end: walk back, collecting the tokens kept
      const pairs: [number, number][] = [];
      for (let e = d; e >= 0; e--) {
        const k = x - y;
        // At e = 0, the start: a step from (0, -1) that is no edit
        const prevK = down(trace[e], k, e) ? k + 1 : k - 1;
        const prevX = trace[e][offset + prevK];
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) pairs.push([--x, --y]);
        x = prevX;
        y = prevY;
      }
      return pairs.reverse();
    }
  }
  return null;
}

/**
 * {@link matchTokens} in the placement asked for: `'earliest'` matches the
 * texts backwards, keeping the latest tokens it can.
 */
function placeMatches(
  a: string[],
  b: string[],
  placement: 'latest' | 'earliest'
): [number, number][] | null {
  if (placement === 'latest') return matchTokens(a, b);
  const pairs = matchTokens([...a].reverse(), [...b].reverse());
  return (
    pairs
      ?.map(([i, j]): [number, number] => [a.length - 1 - i, b.length - 1 - j])
      .reverse() ?? null
  );
}

/** A token of a table's markup: a pipe, a colon or a run of dashes. */
const TABLE_MARKUP = /^(?:[|:]|-+)$/;

/** A run of like tokens: from `i` in one text and `j` in the other. */
type Run = { i: number; j: number; length: number };

/**
 * `pairs` as runs, less the runs too short to tell from coincidence: a run no
 * longer, in characters, than the text added or removed on each side of it
 * (diff-match-patch's semantic cleanup), table markup in those edits
 * aside. Two unrelated texts share a scatter of `a`s, `the`s and commas; a
 * run that short between edits that long says nothing of where the text
 * went, so its edits join into one.
 */
function meaningfulRuns(
  pairs: [number, number][],
  a: Token[],
  b: Token[]
): Run[] {
  const runs: Run[] = [];
  for (const [i, j] of pairs) {
    const last = runs.at(-1);
    if (last && last.i + last.length === i && last.j + last.length === j) {
      last.length++;
    } else {
      runs.push({ i, j, length: 1 });
    }
  }
  /** `weigh` summed over the first `k` of `tokens`, at `[k]`. */
  const sums = (tokens: Token[], weigh: (text: string) => number) => {
    const out = [0];
    for (const { text } of tokens) out.push(out[out.length - 1] + weigh(text));
    return out;
  };
  const sumsA = sums(a, (text) => text.length);
  // A table's pipes, dashes and colons, added or taken as a re-pad gives a
  // row the pipes at its sides it lacked, say nothing of where its text went
  const editA = sums(a, (text) => (TABLE_MARKUP.test(text) ? 0 : text.length));
  const editB = sums(b, (text) => (TABLE_MARKUP.test(text) ? 0 : text.length));
  /** Characters edited between the runs before and after, either side. */
  const edited = (before: Run | undefined, after: Run | undefined) => {
    const i = before ? before.i + before.length : 0;
    const j = before ? before.j + before.length : 0;
    return Math.max(
      (after ? editA[after.i] : editA[a.length]) - editA[i],
      (after ? editB[after.j] : editB[b.length]) - editB[j]
    );
  };
  for (let k = 0; k < runs.length; ) {
    const run = runs[k];
    const length = sumsA[run.i + run.length] - sumsA[run.i];
    if (
      length <= edited(runs[k - 1], run) &&
      length <= edited(run, runs[k + 1])
    ) {
      runs.splice(k, 1);
      // Its edits joined the ones around it: the run before may now be short
      k = Math.max(0, k - 1);
    } else {
      k++;
    }
  }
  return runs;
}

/**
 * `a` replaced by `b` as one replacement for each stretch between the tokens
 * the two share (see {@link tokenize}), or as one replacement of the whole
 * where they share none to speak of or are too far apart to tell. Each is
 * narrowed by {@link computeMinimalChange}, offsets relative to `a`.
 *
 * A stretch is narrowed even where that splits a backslash escape: the
 * escapes the two texts share are tokens kept already, and an edit that
 * makes or unmakes one, as a `!` typed after a backslash, stays as narrow as
 * it is.
 */
function alignByTokens(
  a: string,
  b: string,
  placement: 'latest' | 'earliest'
): { from: number; to: number; insert: string }[] {
  const whole = [{ from: 0, to: a.length, insert: b }];
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  const pairs = placeMatches(tokensA.map(keyOf), tokensB.map(keyOf), placement);
  if (!pairs) return whole;

  const pieces: { from: number; to: number; insert: string }[] = [];
  let fromA = 0;
  let fromB = 0;
  /** The stretch from the last run kept to `toA` in `a` and `toB` in `b`. */
  const replace = (toA: number, toB: number) => {
    const change = computeMinimalChange(
      a.slice(fromA, toA),
      b.slice(fromB, toB),
      placement
    );
    if (change) {
      pieces.push({
        ...change,
        from: fromA + change.from,
        to: fromA + change.to,
      });
    }
  };
  for (const { i, j, length } of meaningfulRuns(pairs, tokensA, tokensB)) {
    // Each token kept stays put; only the whitespace around it can differ
    for (let t = 0; t < length; t++) {
      const tokenA = tokensA[i + t];
      const tokenB = tokensB[j + t];
      replace(tokenA.at, tokenB.at);
      // Dashes grown or shrunk start where they did; the ones added or taken
      // go with the stretch after them
      const same = tokenA.text === tokenB.text;
      fromA = tokenA.at + (same ? tokenA.text.length : 0);
      fromB = tokenB.at + (same ? tokenB.text.length : 0);
    }
  }
  replace(a.length, b.length);
  return pieces;
}

/**
 * `changes` with each of its replacements narrowed to the text it really
 * changes. The document it makes of `doc` is the same; only what a position
 * inside a replaced span maps to differs.
 *
 * A position mapped through a replacement can't follow the text it was on:
 * Obsidian's `editor.setValue` replaces the whole document even where it
 * changes a word or nothing at all, and its table editor rewrites a whole
 * table to change one cell, re-padding every row, so every position inside
 * lands at one end. Each replacement is first trimmed to the span that
 * differs ({@link computeMinimalChange}), then split at the words and
 * punctuation the old and new text share, whitespace aside: a position on
 * text the replacement only re-padded, re-wrapped or re-indented stays on
 * it. Where the texts share too little to tell where anything went, or
 * differ too much to diff cheaply, the trimmed span stays whole.
 *
 * @param doc the document `changes` apply to
 * @param placement where to put an edit that could go in more than one place
 *   (see {@link computeMinimalChange})
 */
export function narrowChanges(
  changes: ChangeSet,
  doc: Text,
  placement: 'latest' | 'earliest' = 'latest'
): ChangeSet {
  const narrowed: ChangeSpec[] = [];
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const change = computeMinimalChange(
      doc.sliceString(fromA, toA),
      inserted.toString(),
      placement,
      true
    );
    if (!change) return;
    const removed = doc.sliceString(fromA + change.from, fromA + change.to);
    for (const piece of alignByTokens(removed, change.insert, placement)) {
      narrowed.push({
        from: fromA + change.from + piece.from,
        to: fromA + change.from + piece.to,
        insert: piece.insert,
      });
    }
  });
  return ChangeSet.of(narrowed, changes.length);
}
