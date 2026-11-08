// ESLint: the recommended rules for every module here. Formatting is Prettier's (.prettierrc.json). `npm run lint` runs
// both checks; `npm run check` and CI run it on every push.
//
// Where each file runs decides its globals. js/chain, js/client, js/play and js/results run in a browser page as they
// are (AGENTS.md): no Node globals or `node:` imports there, so a Buffer or a process.env that would break a page fails
// here first.
import js from '@eslint/js';
import globals from 'globals';

const BROWSER_SAFE = ['js/chain/**', 'js/client/**', 'js/play/**', 'js/results/**'];

export default [
  { ignores: ['node_modules/', 'js/client/idl/', 'evals/results/', 'types/'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
    },
  },
  // runs in a browser page as it is: browser globals only, and nothing of Node's
  {
    files: BROWSER_SAFE,
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['node:*'], message: 'This module runs in a browser page: no Node imports (AGENTS.md).' }] }],
      'no-restricted-globals': [
        'error',
        { name: 'Buffer', message: 'This module runs in a browser page: use Uint8Array (js/chain/bytes.js).' },
        { name: 'process', message: 'This module runs in a browser page: no process.' },
        { name: 'require', message: 'This module runs in a browser page: ES modules only.' },
      ],
    },
  },
  // the approval page's script, served to the owner's browser
  { files: ['js/approve/page.js'], languageOptions: { globals: { ...globals.browser } } },
  // tests and eval drivers hand functions to Chrome (Playwright's evaluate), which run in the page
  { files: ['js/test/**', 'evals/**'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
];
