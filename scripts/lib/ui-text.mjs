// @ts-check
// Finds the user-facing copy in a TS/TSX source and diffs two versions of it,
// for the release copy review (`scripts/ui-text-diff.mjs`). Syntax-aware: a
// string counts by where it goes (a known sink, JSX), not by how it looks,
// except for the `prose?` kind, a fallback for prose-like strings that reach
// the UI through helpers no sink list can see.
import ts from 'typescript';
import {
  COMMAND_CALLBACKS,
  COPY_CALLS,
  COPY_KEYS,
  SETTING_KEYS,
} from './ui-copy-sinks.mjs';

/** Sinks Stryker leaves to the `prose?` fallback but the review should name. */
const EXTRA_CALLS = new Set(['appendText']);
const ATTR_CALLS = new Set(['setAttribute', 'setAttr', 'attr']);
const COPY_ATTRS = new Set([...COPY_KEYS, 'aria-label', 'title', 'alt']);
/** Strings handed to these are never shown to the user. */
const NOT_COPY_CALLS =
  /^(Error|TypeError|RangeError|require|querySelector(All)?|(add|remove|toggle|has)Class|addEventListener|registerDomEvent|getItem|setItem|startsWith|endsWith|includes|split|replace(All)?|join|indexOf|match|test|prepare|exec|run|get|set|has|on|off|trigger|emit|register|log|debug|withClass)$/;
const NOT_COPY_KEYS = /^(cls|className|class|id|key|type|icon|attr|style)$/;
/** Element properties whose value is shown: `el.textContent = '…'`. */
const TEXT_PROPS = new Set(['textContent', 'innerText']);
/** Two or more words (`import "${name}"` too), or one capitalised word: a button label (`'Re-associate'`). */
const PROSE =
  /[A-Za-z]{2,}[,.:]? +["'(]?[A-Za-z]|^[A-Z][a-z]+(-[a-z]+)?[.!?…]*$/;
/** SQL, markup and CSS selector lists (`'td, th'`) read as prose too. */
const NOT_PROSE =
  /\b(SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|PRAGMA|INTEGER|TEXT|NULL|DEFAULT|AND|OR|NOT|IS|IN|CASE|WHEN|THEN|ELSE|COLLATE|ORDER BY|ASC|DESC|LIMIT|UNION|JOIN|VALUES)\b|^\s*<[a-z]|^[a-z][\w-]*(, [\w\-[\]:()=".]+)+$/;

/**
 * The text with each `${expr}` replaced: what a reader sees around the
 * interpolations, without the code inside them.
 * @param {string} text @param {string} by
 */
function withoutCode(text, by) {
  let out = '';
  let code = false; // the last thing kept was an interpolation
  for (let i = 0; i < text.length; i++) {
    if (!text.startsWith('${', i)) {
      out += text[i];
      code = false;
      continue;
    }
    let depth = 0;
    for (i++; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) break;
    }
    // `${a}${b}` is one value, not a two-letter word
    if (!code) out += by;
    code = true;
  }
  return out;
}

/**
 * @typedef {{ kind: string, text: string, line: number, scope: string }} CopyEntry
 * @typedef {{ change: 'added' | 'removed' | 'changed', kind: string,
 *   old?: CopyEntry, new?: CopyEntry }} CopyChange
 */

/** @param {ts.Node | undefined} n */
const nameOf = (n) =>
  n &&
  (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isPrivateIdentifier(n))
    ? n.text
    : undefined;

/** @param {ts.ObjectLiteralExpression} o @param {string[]} keys */
const hasKey = (o, keys) =>
  o.properties.some((p) => keys.includes(nameOf(p.name) ?? ''));

/** @param {ts.Node} n */
const isPlus = (n) =>
  ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken;

/** A `+` chain with a string in it: `'Deleted ' + n + ' notes'`. @param {ts.Node} n @returns {boolean} */
const isConcat = (n) =>
  isPlus(n) &&
  [
    /** @type {ts.BinaryExpression} */ (n).left,
    /** @type {ts.BinaryExpression} */ (n).right,
  ].some((o) => isStringy(o) || isConcat(o));

/** @param {ts.Node} n */
const isStringy = (n) =>
  ts.isStringLiteral(n) ||
  ts.isNoSubstitutionTemplateLiteral(n) ||
  ts.isTemplateExpression(n);

/** Text with each interpolation kept as `${expr}`. @param {ts.Expression} n @param {ts.SourceFile} sf @returns {string} */
function render(n, sf) {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
    return n.text;
  if (ts.isTemplateExpression(n))
    return (
      n.head.text +
      n.templateSpans
        .map((s) => '${' + s.expression.getText(sf) + '}' + s.literal.text)
        .join('')
    );
  if (isPlus(n)) {
    const b = /** @type {ts.BinaryExpression} */ (n);
    return render(b.left, sf) + render(b.right, sf);
  }
  return '${' + n.getText(sf) + '}';
}

/** A JSX element's own text, child elements as `<tag>`. @param {ts.JsxElement | ts.JsxFragment} el @param {ts.SourceFile} sf */
function jsxText(el, sf) {
  return el.children
    .map((c) => {
      if (ts.isJsxText(c)) return c.text.replace(/\s*\n\s*/g, ' ');
      if (ts.isJsxExpression(c))
        return c.expression && isStringy(c.expression)
          ? render(c.expression, sf)
          : `{${c.expression?.getText(sf) ?? ''}}`;
      if (ts.isJsxElement(c))
        return `<${c.openingElement.tagName.getText(sf)}>`;
      if (ts.isJsxSelfClosingElement(c)) return `<${c.tagName.getText(sf)}/>`;
      return '';
    })
    .join('')
    .trim();
}

/** The declaration a node sits in, to say where a string is. @param {ts.Node} n */
function scopeOf(n) {
  for (let p = n.parent; p; p = p.parent) {
    const name =
      (ts.isFunctionDeclaration(p) ||
        ts.isMethodDeclaration(p) ||
        ts.isClassDeclaration(p) ||
        ts.isVariableDeclaration(p) ||
        ts.isPropertyAssignment(p) ||
        ts.isPropertyDeclaration(p)) &&
      nameOf(p.name);
    if (name) return name;
  }
  return '';
}

/**
 * What a string is, from the expression that consumes it: a sink name, `prose?`
 * for a prose-like string elsewhere, or undefined when it is not copy.
 * @param {ts.Expression} str @param {string} text
 */
function classify(str, text) {
  let child = /** @type {ts.Node} */ (str);
  let p = child.parent;
  // through `c ? 'a' : 'b'`, `x ?? 'a'`, `('a')`, `'a' as const`
  while (
    (ts.isConditionalExpression(p) && p.condition !== child) ||
    (ts.isBinaryExpression(p) &&
      p.right === child &&
      [
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
      ].includes(p.operatorToken.kind)) ||
    ts.isParenthesizedExpression(p) ||
    ts.isAsExpression(p) ||
    ts.isSatisfiesExpression(p)
  ) {
    child = p;
    p = p.parent;
  }
  const literal = withoutCode(text, 'x');
  const prose =
    PROSE.test(literal) && !NOT_PROSE.test(literal) ? 'prose?' : undefined;
  if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
    const callee = ts.isPropertyAccessExpression(p.expression)
      ? p.expression.name.text
      : (nameOf(p.expression) ?? '');
    const arg = p.arguments?.indexOf(/** @type {ts.Expression} */ (child));
    if (ts.isNewExpression(p) && callee === 'Notice') return 'Notice';
    if (
      /^console\./.test(p.expression.getText()) ||
      p.expression.kind === ts.SyntaxKind.SuperKeyword ||
      NOT_COPY_CALLS.test(callee)
    )
      return undefined;
    if (arg === 0 && (COPY_CALLS.has(callee) || EXTRA_CALLS.has(callee)))
      return callee;
    const attr = p.arguments?.[0];
    if (arg === 1 && ATTR_CALLS.has(callee) && attr && ts.isStringLiteral(attr))
      return COPY_ATTRS.has(attr.text) ? attr.text : undefined;
    return prose;
  }
  // data worked on in place: `['sin cos tan', …].join(' ')`, `['Arabic', …].map(…)`
  if (ts.isArrayLiteralExpression(p) && ts.isPropertyAccessExpression(p.parent))
    return undefined;
  if (ts.isPropertyAssignment(p)) {
    if (p.initializer !== child) return undefined; // a quoted key
    const key = nameOf(p.name) ?? '';
    if (COPY_ATTRS.has(key)) return key;
    if (key === 'name' && ts.isObjectLiteralExpression(p.parent)) {
      if (hasKey(p.parent, SETTING_KEYS)) return 'setting name';
      if (hasKey(p.parent, ['id']) && hasKey(p.parent, COMMAND_CALLBACKS))
        return 'command name';
    }
    return NOT_COPY_KEYS.test(key) ? undefined : prose;
  }
  if (ts.isJsxExpression(p) && ts.isJsxAttribute(p.parent)) p = p.parent;
  if (ts.isJsxAttribute(p)) {
    const attr = nameOf(p.name) ?? p.name.getText();
    return COPY_ATTRS.has(attr)
      ? attr
      : NOT_COPY_KEYS.test(attr)
        ? undefined
        : prose;
  }
  // past the attribute case above, an element's or fragment's child
  if (ts.isJsxExpression(p)) return 'jsx';
  // `el.textContent = '…'`, `notice += '…'`
  if (
    ts.isBinaryExpression(p) &&
    (p.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
      p.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)
  ) {
    const target = ts.isPropertyAccessExpression(p.left)
      ? p.left.name.text
      : '';
    if (TEXT_PROPS.has(target)) return target;
    return NOT_COPY_KEYS.test(target) ? undefined : prose;
  }
  if (
    ts.isThrowStatement(p) ||
    ts.isImportDeclaration(p) ||
    ts.isExportDeclaration(p) ||
    ts.isLiteralTypeNode(p) ||
    ts.isCaseClause(p) ||
    ts.isElementAccessExpression(p) ||
    ts.isExternalModuleReference(p) ||
    ts.isTaggedTemplateExpression(p) ||
    ts.isBinaryExpression(p)
  )
    return undefined;
  return prose;
}

/** Every piece of user-facing copy in a TS/TSX source. @param {string} source @param {string} fileName @returns {CopyEntry[]} */
export function extractCopy(source, fileName) {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ES2022,
    true
  );
  // the database layer's strings are SQL, migration notes and log lines
  const proseShown = !/(^|\/)src\/db\//.test(fileName);
  /** @type {CopyEntry[]} */
  const out = [];
  /** @param {ts.Node} at @param {string} kind @param {string} text */
  const add = (at, kind, text) =>
    out.push({
      kind,
      text,
      line: sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1,
      scope: scopeOf(at),
    });
  /** @param {ts.Node} n */
  const visit = (n) => {
    if (
      (ts.isJsxElement(n) || ts.isJsxFragment(n)) &&
      n.children.some((c) => ts.isJsxText(c) && c.text.trim())
    ) {
      const first = n.children.find((c) => ts.isJsxText(c) && c.text.trim());
      add(first ?? n, 'jsx', jsxText(n, sf));
    }
    const top =
      (isStringy(n) || isConcat(n)) &&
      !isPlus(n.parent) &&
      !(
        ts.isJsxExpression(n.parent) &&
        (ts.isJsxElement(n.parent.parent) ||
          ts.isJsxFragment(n.parent.parent)) &&
        n.parent.parent.children.some((c) => ts.isJsxText(c) && c.text.trim())
      );
    if (top) {
      const text = render(/** @type {ts.Expression} */ (n), sf);
      const kind = /[A-Za-z]/.test(text)
        ? classify(/** @type {ts.Expression} */ (n), text)
        : undefined;
      if (kind && (kind !== 'prose?' || proseShown)) add(n, kind, text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Word-overlap score in [0, 1]. @param {string} a @param {string} b */
function similarity(a, b) {
  const words = (/** @type {string} */ s) =>
    new Set(
      withoutCode(s, ' ')
        .toLowerCase()
        .match(/[\p{L}\p{N}$]+/gu) ?? []
    );
  const A = words(a),
    B = words(b);
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return A.size + B.size ? (2 * shared) / (A.size + B.size) : 0;
}

/**
 * What changed between two versions of a file's copy. Identical strings cancel
 * out wherever they moved; the rest pair up by word overlap into `changed`,
 * and what finds no partner is `added` or `removed`.
 * @param {CopyEntry[]} before @param {CopyEntry[]} after @returns {CopyChange[]}
 */
export function diffCopy(before, after) {
  const key = (/** @type {CopyEntry} */ e) => `${e.kind}\u0000${e.text}`;
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const e of before) counts.set(key(e), (counts.get(key(e)) ?? 0) + 1);
  const added = after.filter((e) => {
    const n = counts.get(key(e)) ?? 0;
    if (n) counts.set(key(e), n - 1);
    return !n;
  });
  const removed = before.filter((e) => {
    const n = counts.get(key(e)) ?? 0;
    counts.set(key(e), n - 1);
    return n > 0;
  });
  const pairs = removed
    .flatMap((o, i) =>
      added.map((a, j) => ({
        i,
        j,
        score: similarity(o.text, a.text) + (o.kind === a.kind ? 0.1 : 0),
      }))
    )
    .filter((p) => p.score >= 0.45)
    .sort((x, y) => y.score - x.score);
  const usedOld = new Set(),
    usedNew = new Set();
  /** @type {CopyChange[]} */
  const out = [];
  for (const { i, j } of pairs) {
    if (usedOld.has(i) || usedNew.has(j)) continue;
    usedOld.add(i);
    usedNew.add(j);
    out.push({
      change: 'changed',
      kind: added[j].kind,
      old: removed[i],
      new: added[j],
    });
  }
  removed.forEach(
    (o, i) =>
      usedOld.has(i) || out.push({ change: 'removed', kind: o.kind, old: o })
  );
  added.forEach(
    (a, j) =>
      usedNew.has(j) || out.push({ change: 'added', kind: a.kind, new: a })
  );
  const line = (/** @type {CopyChange} */ c) => (c.new ?? c.old)?.line ?? 0;
  return out.sort((x, y) => line(x) - line(y));
}

/** Text safe to show as Markdown. @param {string} s */
export const escapeMd = (s) => s.replace(/([\\`*_[\]<>|~])/g, '\\$1');

/** Old and new text with the differing words struck and bolded. @param {string} a @param {string} b */
export function wordDiff(a, b) {
  const A = a.split(/(\s+)/),
    B = b.split(/(\s+)/);
  // only words match: a shared space is no common ground, and counting it
  // would let the walk keep the spaces and mark every word around them
  const same = (/** @type {number} */ i, /** @type {number} */ j) =>
    A[i] === B[j] && /\S/.test(A[i]);
  const L = A.map(() => new Array(B.length + 1).fill(0));
  L.push(new Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--)
    for (let j = B.length - 1; j >= 0; j--)
      L[i][j] = same(i, j)
        ? L[i + 1][j + 1] + 1
        : Math.max(L[i + 1][j], L[i][j + 1]);
  const esc = escapeMd;
  let i = 0,
    j = 0,
    oldOut = '',
    newOut = '';
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && same(i, j)) {
      oldOut += esc(A[i]);
      newOut += esc(B[j]);
      (i++, j++);
    } else if (j < B.length && (i >= A.length || L[i][j + 1] >= L[i + 1][j])) {
      newOut += /\S/.test(B[j]) ? `**${esc(B[j])}**` : B[j];
      j++;
    } else {
      oldOut += /\S/.test(A[i]) ? `~~${esc(A[i])}~~` : A[i];
      i++;
    }
  }
  return { old: oldOut, new: newOut };
}
