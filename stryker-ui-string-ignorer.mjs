// @ts-check
// Stryker ignorer: leaves static UI copy (notices, setting names/descriptions,
// command names, button labels...) out of the mutation score, so tests never
// pin wording just to kill a StringLiteral mutant. Only plain strings are
// ignored; template literals with `${}` stay mutated because the logic inside
// them is worth testing. Ignored mutants are reported as "Ignored".
import { PluginKind, declareValuePlugin } from '@stryker-mutator/api/plugin';

/** Calls whose first argument is user-facing text: `notify('…')`, `el.setText('…')` */
const COPY_CALLS = new Set([
  'notify',
  'setName',
  'setDesc',
  'setPlaceholder',
  'setButtonText',
  'setTooltip',
  'setTitle',
  'setHeading',
  'setText',
]);

/** Object keys whose value is user-facing text: `createEl('p', { text: '…' })` */
const COPY_KEYS = new Set([
  'text',
  'desc',
  'heading',
  'label',
  'placeholder',
  'tooltip',
  'buttonText',
  'confirmText',
  'cancelText',
]);

const COMMAND_CALLBACKS = [
  'callback',
  'checkCallback',
  'editorCallback',
  'editorCheckCallback',
];

/**
 * A string literal, or a template whose only `${}`s are module constants
 * (`${DATA_DIRECTORY}`): no logic inside, so ignoring it hides nothing else.
 * @param {import('@babel/core').NodePath} path
 */
function isPlainString(path) {
  if (path.isStringLiteral()) return true;
  return (
    path.isTemplateLiteral() &&
    path.node.expressions.every(
      (e) => e.type === 'Identifier' && /^[A-Z][A-Z0-9_]*$/.test(e.name)
    )
  );
}

/** @param {any} key */
function keyName(key) {
  if (!key) return undefined;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'StringLiteral') return key.value;
  return undefined;
}

/**
 * Climbs from a string to the expression that consumes it, through
 * `cond ? 'a' : 'b'`, `x ?? 'a'`, `'a' + 'b'` and `'a' as const`, so a
 * branch-picked or wrapped string counts as copy too. Only the string itself is
 * ignored, never the condition or the other operand.
 * @param {import('@babel/core').NodePath} path
 */
function consumer(path) {
  let child = path;
  let parent = path.parentPath;
  while (parent) {
    const isBranch =
      (parent.isConditionalExpression() && parent.node.test !== child.node) ||
      (parent.isLogicalExpression() && parent.node.right === child.node) ||
      (parent.isBinaryExpression() && parent.node.operator === '+') ||
      parent.isTSAsExpression() ||
      parent.isTSSatisfiesExpression();
    if (!isBranch) break;
    child = parent;
    parent = parent.parentPath;
  }
  return { child, parent };
}

/** @param {any} object @param {string[]} keys */
function hasKey(object, keys) {
  return object.properties.some((/** @type {any} */ p) =>
    keys.includes(keyName(p.key) ?? '')
  );
}

/** @param {import('@babel/core').NodePath} path */
function isUiCopy(path) {
  if (!isPlainString(path)) return false;
  const { child, parent } = consumer(path);
  if (!parent) return false;

  if (parent.isNewExpression() || parent.isCallExpression()) {
    const callee = /** @type {any} */ (parent.node).callee;
    if (parent.node.arguments[0] !== child.node) return false;
    if (parent.isNewExpression())
      return callee.type === 'Identifier' && callee.name === 'Notice';
    const name =
      callee.type === 'Identifier'
        ? callee.name
        : callee.type === 'MemberExpression'
          ? keyName(callee.property)
          : undefined;
    return COPY_CALLS.has(name);
  }

  if (parent.isObjectProperty() && parent.node.value === child.node) {
    const key = keyName(parent.node.key);
    if (COPY_KEYS.has(key ?? '')) return true;
    if (key !== 'name') return false;
    // `name` is copy only on a setting ({ name, desc | control }) or a command
    // ({ id, name, callback }); elsewhere it's often a storage key
    const object = /** @type {any} */ (parent.parentPath?.node);
    return (
      hasKey(object, ['desc', 'control']) ||
      (hasKey(object, ['id']) && hasKey(object, COMMAND_CALLBACKS))
    );
  }

  return false;
}

export const strykerPlugins = [
  declareValuePlugin(PluginKind.Ignore, 'ui-strings', {
    shouldIgnore(path) {
      return isUiCopy(path)
        ? 'Static UI copy; tests should not pin wording'
        : undefined;
    },
  }),
];
