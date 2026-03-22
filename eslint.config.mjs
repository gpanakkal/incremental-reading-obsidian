import { defineConfig, globalIgnores } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';

const LINT_TARGETS = ['**/*.{ts,tsx}'];
const TEST_FILES = ['**/*.test.ts', '**/*.spec.ts', 'e2e-tests/**'];

export default defineConfig([
  { files: LINT_TARGETS, ...js.configs.recommended },
  ...tseslint.configs.recommendedTypeChecked.map((c) => ({
    files: LINT_TARGETS,
    ...c,
  })),
  { files: LINT_TARGETS, ...react.configs.flat.recommended },
  { files: LINT_TARGETS, ...reactHooks.configs.flat.recommended },
  ...obsidianmd.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      // workaround for compatibility with tseslint's type-aware linting
      // until Obsidian plugin can be configured to exclude .js files
      ...Object.fromEntries(
        Object.keys(obsidianmd.rules).map((r) => [`obsidianmd/${r}`, 'off'])
      ),
    },
  },
  {
    files: TEST_FILES,
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'import/no-nodejs-modules': 'off',
    },
  },
  globalIgnores(['**/node_modules/', '**/main.js']),
  {
    files: LINT_TARGETS,
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      sourceType: 'module',
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
      '@typescript-eslint/no-inferrable-types': 'off',
      '@typescript-eslint/no-empty-interface': 'off',
      'prefer-const': ['off'],
      'react/react-in-jsx-scope': ['off'],
    },
  },
]);
