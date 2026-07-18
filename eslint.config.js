import eslint from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const typescriptFiles = ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}', 'vite.config.ts'];

export default tseslint.config(
  {
    ignores: [
      'assets/**',
      'coverage/**',
      'dist/**',
      'node_modules/**',
      'public/assets/**',
      'tools/blender/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  {
    ...importPlugin.flatConfigs.recommended,
    ...importPlugin.flatConfigs.typescript,
    name: 'solar-voyager/typescript-imports',
    files: typescriptFiles,
    languageOptions: {
      ...importPlugin.flatConfigs.recommended.languageOptions,
      ...importPlugin.flatConfigs.typescript.languageOptions,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    settings: {
      ...importPlugin.flatConfigs.typescript.settings,
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: './tsconfig.json',
        },
      },
    },
    rules: {
      ...importPlugin.flatConfigs.recommended.rules,
      ...importPlugin.flatConfigs.typescript.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      'import/no-restricted-paths': [
        'error',
        {
          basePath: import.meta.dirname,
          zones: [
            {
              target: './src/core',
              from: ['./src/sim', './src/game', './src/render', './src/ui'],
              message: 'Core must not import from higher application layers.',
            },
            {
              target: './src/sim',
              from: ['./src/game', './src/render', './src/ui', './src/workers'],
              message: 'Simulation must not import from game, render, UI, or workers.',
            },
            {
              target: './src/game',
              from: ['./src/render', './src/ui'],
              message: 'Game orchestration must not import from render or UI.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ['tests/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['*.config.{js,ts}', 'tools/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
);
