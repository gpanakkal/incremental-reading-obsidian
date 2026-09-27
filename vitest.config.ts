import { readFileSync } from 'fs';
import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

// TOOD: alias react to preact https://preactjs.com/guide/v10/getting-started#aliasing-in-jest
export default defineConfig({
  plugins: [
    {
      // Mirrors the inline-files plugin in esbuild.config.mjs. Without it, Vite's
      // import analysis parses schema.sql as JS whenever it walks through
      // main.ts, e.g. `vitest related`, which Stryker's runner uses per mutant
      name: 'sql-as-text',
      enforce: 'pre',
      load(id) {
        if (!id.endsWith('.sql')) return null;
        return `export default ${JSON.stringify(readFileSync(id, 'utf8'))}`;
      },
    },
  ],
  resolve: {
    alias: {
      obsidian: resolve(__dirname, 'src/test/__mocks__/obsidian.ts'),
      'sql.js/dist/sql-wasm.wasm': resolve(
        __dirname,
        'src/test/__mocks__/sql-wasm.ts'
      ),
      '#': resolve(__dirname, 'src'),
    },
  },
  test: {
    setupFiles: ['./src/test/obsidian-globals.setup.ts'],
    include: ['./src/**/*.test.{ts,tsx}'],
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
