// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  _comment:
    "This config was generated using 'stryker init'. Please take a look at: https://stryker-mutator.io/docs/stryker-js/configuration/ for more information.",
  packageManager: 'pnpm',
  // Resolved from here, not by name: Stryker imports bare plugin names from its
  // own package dir, which can't see our devDeps under pnpm's global virtual store
  plugins: [
    import.meta.resolve('@stryker-mutator/vitest-runner'),
    import.meta.resolve('@stryker-mutator/typescript-checker'),
    import.meta.resolve('./stryker-ui-string-ignorer.mjs'),
  ],
  ignorers: ['ui-strings'],
  reporters: ['html', 'clear-text', 'progress'],
  testRunner: 'vitest',
  testRunner_comment:
    'Take a look at https://stryker-mutator.io/docs/stryker-js/vitest-runner for information about the vitest plugin.',
  mutate: ['src/**/*.ts', '!src/**/*.test.ts', '!src/test/**'],
  ignorePatterns: [
    'e2e-tests/',
    'coverage/',
    'docs/',
    'reports/',
    '**/.*',
    '/*.*',
    '!vitest.config.ts',
    // AnswerRevealExtension.test.ts reads the stylesheet to check that the fade
    // it schedules lasts as long as the animation it is waiting on.
    '!styles.css',
  ],
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.stryker.json',
  coverageAnalysis: 'perTest',
  // Reruns only re-test mutants whose code or covering tests changed since the
  // last run (reports/stryker-incremental.json, per worktree). --force ignores it
  incremental: true,
  concurrency: 4,
  // Static mutants (module-level code) rerun the whole suite per mutant
  ignoreStatic: true,
};
export default config;
