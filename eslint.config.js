import eslint from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        allowDefaultProject: ['eslint.config.js'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { import: importPlugin },
    settings: {
      'import/resolver': {
        typescript: true,
      },
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    rules: {
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            { target: './src/core', from: './src/sim' },
            { target: './src/core', from: './src/game' },
            { target: './src/core', from: './src/render' },
            { target: './src/core', from: './src/ui' },
            { target: './src/sim', from: './src/game' },
            { target: './src/sim', from: './src/render' },
            { target: './src/sim', from: './src/ui' },
            { target: './src/game', from: './src/render' },
            { target: './src/game', from: './src/ui' },
          ],
        },
      ],
    },
  },
  {
    files: ['*.config.{js,ts}', 'eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
);
