import react from '@eslint-react/eslint-plugin';
import js from '@eslint/js';
import tsparser from '@typescript-eslint/parser';
import { importX } from 'eslint-plugin-import-x';
import obsidianmd from 'eslint-plugin-obsidianmd';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const LINT_TARGETS = ['**/*.{ts,tsx}'];
const TEST_FILES = [
  '**/*.{test,spec}.{ts,tsx}',
  'e2e-tests/**/*.{ts,tsx}',
  // Test-only scaffolding (mocks, fixtures, setup files) — never bundled.
  'src/test/**/*.{ts,tsx}',
];

export default defineConfig([
  // Obsidian's guidelines describe shipped plugin code, so they are scoped to
  // non-test files. This sits ahead of the block below so that block's `rules`
  // keep overriding the preset's, as they did when it was extended inline.
  {
    files: LINT_TARGETS,
    ignores: TEST_FILES,
    extends: [obsidianmd.configs.recommended],
    rules: {
      'obsidianmd/no-nodejs-modules': 'error',
    },
  },
  {
    files: LINT_TARGETS,
    extends: [
      js.configs.recommended,
      importX.flatConfigs.recommended,
      importX.flatConfigs.typescript,
      tseslint.configs.recommendedTypeChecked,
      react.configs.recommended,
      reactHooks.configs.flat.recommended,
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      sourceType: 'module',
      parser: tsparser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
        projectService: true,
      },
    },
    settings: {
      react: {
        version: 'detect',
      },
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: './tsconfig.json',
        },
      },
      'import/internal-regex': '^#/',
    },
    rules: {
      'no-unused-vars': 'off',
      'no-undef': 'off',
      quotes: [
        'error',
        'single',
        {
          allowTemplateLiterals: true,
          avoidEscape: true,
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/ban-ts-comment': 'off',
      'no-prototype-builtins': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
      // Default fixer folds a value import into a sibling `import type` from the
      // same module, dragging runtime bindings under `import type` and erasing
      // them at compile time. `prefer-inline` merges the other direction, into a
      // value import with inline `type` markers.
      'import-x/no-duplicates': ['error', { 'prefer-inline': true }],
      '@typescript-eslint/no-inferrable-types': 'off',
      '@typescript-eslint/no-empty-interface': 'off',
      '@typescript-eslint/no-deprecated': 'warn',
      'prefer-const': ['off'],
    },
  },
  {
    files: TEST_FILES,
    languageOptions: {
      globals: {
        ...globals.node,
      },
      sourceType: 'module',
      parser: tsparser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
        projectService: true,
      },
    },
    rules: {
      'import-x/no-named-as-default-member': 'off',
    },
  },
  globalIgnores(['**/node_modules/', '**/main.js']),
]);
