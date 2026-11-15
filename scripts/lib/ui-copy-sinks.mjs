// @ts-check
// Where user-facing copy goes. Shared by the `ui-strings` Stryker ignorer and
// the copy-diff script (`scripts/ui-text-diff.mjs`), so what the mutation score
// ignores as copy and what the release copy review lists never drift apart.

/** Calls whose first argument is user-facing text: `notify('…')`, `el.setText('…')` */
export const COPY_CALLS = new Set([
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
export const COPY_KEYS = new Set([
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

/** Keys that mark an object as an Obsidian command, whose `name` is copy. */
export const COMMAND_CALLBACKS = [
  'callback',
  'checkCallback',
  'editorCallback',
  'editorCheckCallback',
];

/** Keys that mark an object as a setting, whose `name` is copy. */
export const SETTING_KEYS = ['desc', 'control'];
