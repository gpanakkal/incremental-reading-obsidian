/**
 * @see https://prettier.io/docs/configuration
 * @type {import("prettier").Config}
 */
const config = {
  trailingComma: 'es5',
  tabWidth: 2,
  semi: true,
  singleQuote: true,
  printWidth: 80,
  plugins: ['prettier-plugin-organize-imports'],
  // Only sort imports. The default also deletes unused ones, which strips
  // imports used solely inside a still-unresolved merge conflict whenever
  // the merge editor's result autosaves.
  organizeImportsSkipDestructiveCodeActions: true,
};

export default config;
