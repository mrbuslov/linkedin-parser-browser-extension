// ESLint flat config (v9+). Keeps the rule set deliberately small —
// this is a content-script project, not a complex SPA, and noisy lint
// errors would drown out real issues.
import globals from 'globals';

export default [
  {
    files: ['linkedin-tracker/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        chrome: 'readonly',
        // CommonJS `module` reference — core/* files use a dual-mode export
        // pattern so the same source works as a content script AND as a Node
        // CJS module for Vitest. The guard `typeof module !== 'undefined'`
        // keeps it safe at runtime; this tells ESLint about it.
        module: 'readonly',
        // Shared globals our core/ files install onto globalThis so content
        // scripts can reach them without a bundler.
        LITParseDate: 'readonly',
        LITUrl: 'readonly',
        LITDetect: 'readonly',
        LITProfileState: 'readonly',
        LITDiffSent: 'readonly',
        LITMergeConnections: 'readonly',
        LITPopupLogic: 'readonly',
        LITRSC: 'readonly',
        LITActivityParser: 'readonly',
        LITContactsModal: 'readonly',
        LITSearchResults: 'readonly',
        LITStripName: 'writable',
        LITSchema: 'readonly',
        importScripts: 'readonly',
        // db-client.js exposes these
        dbGet: 'readonly',
        dbSet: 'readonly',
        dbDelete: 'readonly',
        dbClear: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-var': 'error',
      'prefer-const': 'warn',
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    files: ['tests/**/*.js', 'scripts/**/*.js', 'vitest.config.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
];
