# Contributing

Issues and pull requests are welcome. [AGENTS.md](AGENTS.md) has the rules for working in this repository, for
people and coding agents alike; this page is the short version.

## Setting up

Node 22 or later.

```bash
npm ci
npm run fixtures   # once: the loot program and the programs it calls, each checked against its pinned hash
npm run check      # fixtures, skill copies and release.json in step, lint, then the tests
```

Nothing in the tests deploys or spends SOL: they run the real program in LiteSVM.

## Sending a change

- Run `npm run check` before you send it. CI runs the same on Node 22 and 24.
- Add or change a test with the code: a client builder, an example or a checker rule is tested against the real
  program.
- After editing `skills/`, run `npm run sync-skills`.
- Changes to tool texts, the skill or the plugin are best measured with the evals before and after
  ([evals/README.md](evals/README.md)). Write general rules, never a fix that names one scenario or product.
- Plain ES modules, no build step. `js/chain` and `js/client` stay browser-safe.

## Rules that don't bend

- Nothing signs with a person's key, and no tool asks for one.
- Devnet only: nothing sends to mainnet until the program is independently audited.

## Security

Report a vulnerability privately, as [SECURITY.md](SECURITY.md) describes, and never in a public issue.
