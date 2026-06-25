import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

// Flat ESLint config for the Node server and the React web frontend.
export default [
  { ignores: ['web/dist/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    // The web build script and web tests are Node ESM, not browser code.
    files: ['web/build.mjs', 'web/test/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
  },
  {
    files: ['server/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // Allow intentionally-ignored catch blocks (the codebase uses them for
      // best-effort cleanup); flag genuinely empty blocks elsewhere.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Unused args prefixed with _ are deliberate (e.g. Express _req/_next).
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    // Tests use Web globals (Response/fetch) and a temp file or two.
    files: ['server/test/**/*.js'],
    languageOptions: {
      globals: { ...globals.node, Response: 'readonly', fetch: 'readonly' },
    },
  },
  {
    // React frontend: browser globals + JSX. We don't pull in the full react
    // plugin ruleset, just jsx-uses-vars so components referenced only in JSX
    // aren't reported as unused.
    files: ['web/src/**/*.{js,jsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, AudioContext: 'readonly', webkitAudioContext: 'readonly', MediaMetadata: 'readonly' },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'react/jsx-uses-vars': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
