import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

// TOOD: alias react to preact https://preactjs.com/guide/v10/getting-started#aliasing-in-jest
export default defineConfig({
  resolve: {
    alias: {
      obsidian: resolve(__dirname, 'src/test/__mocks__/obsidian.ts'),
      '#': resolve(__dirname, 'src'),
    },
  },
  test: {
    exclude: [
      '**/node_modules/**',
      '**/e2e-tests/**',
      '.stryker-tmp/',
      'src/test/**',
    ],
    coverage: {
      provider: 'v8',
    },
  },
});
