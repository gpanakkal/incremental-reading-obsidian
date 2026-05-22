// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  _comment:
    "This config was generated using 'stryker init'. Please take a look at: https://stryker-mutator.io/docs/stryker-js/configuration/ for more information.",
  packageManager: 'pnpm',
  plugins: [
    '@stryker-mutator/vitest-runner',
    '@stryker-mutator/typescript-checker',
  ],
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
  ],
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.stryker.json',
  coverageAnalysis: 'perTest',
};
export default config;
