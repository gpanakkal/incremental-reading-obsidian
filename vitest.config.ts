import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

// TOOD: alias react to preact https://preactjs.com/guide/v10/getting-started#aliasing-in-jest
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    exclude: ['**/node_modules/**', '**/e2e-tests/**'],
  },
});
