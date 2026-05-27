import { mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config';

const fcNumRuns = parseInt(process.env.FC_NUM_RUNS ?? '10000', 10);
const testTimeout = 20_000 + fcNumRuns * 20;

// Inline projects do not inherit the outer resolve.alias — spread it into each one.
const sharedResolve = (baseConfig as { resolve?: object }).resolve ?? {};

const sharedProjectConfig = {
  setupFiles: ['./src/test/fuzz.setup.ts'],
  testTimeout: testTimeout,
  hookTimeout: 30_000,
  env: {
    FC_NUM_RUNS: String(fcNumRuns),
    FC_VERBOSE: process.env.FC_VERBOSE ?? 'true',
    FC_END_ON_FAILURE: process.env.FC_END_ON_FAILURE ?? 'true', // set true to avoid climbing memory usage
  },
  fileParallelism: false,
  pool: 'forks',
};

const shardedFiles = [
  'src/lib/utils.test.ts',
  'src/lib/extensions/SnippetHighlightExtension.test.ts',
  'src/lib/items/ReviewManager.test.ts',
  'src/lib/items/SnippetManager.test.ts',
  'src/lib/simulation/race-conditions.test.ts',
];

export default mergeConfig(baseConfig, {
  test: {
    reporters: ['verbose', 'json'],
    outputFile: './reports/vitest/fuzz-results.json',
    projects: [
      {
        resolve: sharedResolve,
        test: {
          ...sharedProjectConfig,
          name: 'main',
          include: ['src/**/*.test.ts'],
          exclude: [
            '**/node_modules/**',
            '**/e2e-tests/**',
            '.stryker-tmp/',
            'src/test/**',
            ...shardedFiles,
          ],
        },
      },
      {
        resolve: sharedResolve,
        test: {
          ...sharedProjectConfig,
          name: 'utils',
          include: ['src/lib/utils.test.ts'],
        },
      },
      {
        resolve: sharedResolve,
        test: {
          ...sharedProjectConfig,
          name: 'SnippetHighlightExtension',
          include: ['src/lib/extensions/SnippetHighlightExtension.test.ts'],
        },
      },
      {
        resolve: sharedResolve,
        test: {
          ...sharedProjectConfig,
          name: 'ReviewManager',
          include: ['src/lib/items/ReviewManager.test.ts'],
        },
      },
      {
        resolve: sharedResolve,
        test: {
          ...sharedProjectConfig,
          name: 'SnippetManager',
          include: ['src/lib/items/SnippetManager.test.ts'],
        },
      },
      {
        resolve: sharedResolve,
        test: {
          ...sharedProjectConfig,
          name: 'race-conditions',
          include: ['src/lib/simulation/race-conditions.test.ts'],
        },
      },
    ],
  },
});
