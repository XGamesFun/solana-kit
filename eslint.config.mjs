// ESLint: the recommended rules for every module here. Formatting is Prettier's (.prettierrc.json). `npm run lint` runs
// both checks; `npm run check` and CI run it on every push.
//
// Where each file runs decides its globals. js/chain, js/client, js/play and js/results run in a browser page as they
// are (AGENTS.md): no Node globals or Node imports there, so a Buffer or a process.env that would break a page fails
// here first.
import { builtinModules } from 'node:module';
import js from '@eslint/js';
import globals from 'globals';

const BROWSER_SAFE = ['js/chain/**', 'js/client/**', 'js/play/**', 'js/results/**'];
// What Node has and a page has not (Buffer, process, require, __dirname…): not defined for a browser-safe module.
const NODE_ONLY = Object.keys(globals.node).filter(name => !(name in globals.browser));
const IN_A_PAGE = 'This module runs in a browser page';

export default [
  { ignores: ['node_modules/', 'js/client/idl/', 'evals/results/', 'types/'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
    },
  },
  // runs in a browser page as it is: browser globals only, and nothing of Node's
  {
    files: BROWSER_SAFE,
    languageOptions: {
      globals: { ...Object.fromEntries(NODE_ONLY.map(name => [name, 'off'])), ...globals.browser },
    },
    rules: {
      // a Node module by either of its names (`node:fs`, `fs`)
      'no-restricted-imports': [
        'error',
        {
          paths: builtinModules.map(name => ({ name, message: `${IN_A_PAGE}: no Node imports (AGENTS.md).` })),
          patterns: [{ group: ['node:*'], message: `${IN_A_PAGE}: no Node imports (AGENTS.md).` }],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Buffer', message: `${IN_A_PAGE}: use Uint8Array (js/chain/bytes.js).` },
        { name: 'process', message: `${IN_A_PAGE}: no process.` },
        { name: 'require', message: `${IN_A_PAGE}: ES modules only.` },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression:not([source.value=/^\\.{1,2}\\//])',
          message: `${IN_A_PAGE}: import() only a module beside this one, by its relative path.`,
        },
        // `globalThis.process?.env` is undefined in a page and read in Node; `globalThis.process.env` throws in a page
        {
          selector: `:not(MemberExpression[optional=true]) > MemberExpression[object.name='globalThis'][property.name=/^(${NODE_ONLY.join('|')})$/]`,
          message: `${IN_A_PAGE}: read a Node global only as \`globalThis.name?.…\`, which a page answers with undefined.`,
        },
      ],
    },
  },
  // the approval page's script, served to the owner's browser
  { files: ['js/approve/page.js'], languageOptions: { globals: { ...globals.browser } } },
  // tests and eval drivers hand functions to Chrome (Playwright's evaluate), which run in the page
  { files: ['js/test/**', 'evals/**'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
];
