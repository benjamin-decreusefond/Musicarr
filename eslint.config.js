import js from '@eslint/js';
import globals from 'globals';

// Flat ESLint config for the Node server. The web frontend (web/src) is a
// separate JSX/browser bundle and isn't linted here yet.
export default [
  { ignores: ['web/**', 'node_modules/**'] },
  js.configs.recommended,
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
];
