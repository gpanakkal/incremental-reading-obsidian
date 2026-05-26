import { mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config';

export default mergeConfig(baseConfig, {
  test: {
    setupFiles: ['./src/test/fuzz.setup.ts'],
    testTimeout: parseInt(process.env.FUZZ_TEST_TIMEOUT ?? '120000', 10),
    hookTimeout: 30_000,
    env: {
      FC_NUM_RUNS: process.env.FC_NUM_RUNS ?? '10000',
      FC_VERBOSE: process.env.FC_VERBOSE ?? 'true',
      FC_END_ON_FAILURE: process.env.FC_END_ON_FAILURE ?? 'false',
    },
    reporters: [['verbose', 'html']],
    threads: {
      singleThread: true,
    },
  },
});
