# xsolana: the plugin

A toolkit for building game economies on Solana: design, check, simulate and review shops, items, crafting, rewards,
staking, loot boxes and auctions as a JSON spec, with no smart contract to write. This folder is the plugin for Claude
Code and Codex. The toolkit itself, its docs and its examples are in [the repository](https://github.com/XGamesFun/solana-kit).

## What it installs

- **A skill**, `xsolana-economy` (`skills/`): written guidance an agent reads when someone asks for an economy. It is
  text only.
- **An MCP server**, `xsolana` (`.mcp.json` for Claude Code, `mcp.json` for Codex): the `xsolana_*` tools, started on
  your machine with `npx -y --package=@xgamesfun/solana@<version> xsolana mcp`. The version is pinned in those two
  files.

## What it runs, fetches and sends

- **Runs:** the npm package [`@xgamesfun/solana`](https://www.npmjs.com/package/@xgamesfun/solana) at the pinned
  version, as a local process that talks to the agent over stdio. It has no dependencies of its own.
- **Fetches:** that package from the npm registry, the first time it runs. Two tools, `xsolana_status` and
  `xsolana_token`, read public accounts from a Solana RPC: the public devnet RPC unless `XSOLANA_RPC_URL` names
  another.
- **Sends:** nothing else. There is no telemetry and no account, and no tool signs or sends a transaction.
- **Writes:** `xsolana_save` writes the economy's spec (`xsolana.json`) in your project folder, only when the spec
  passes its check.

## Going live is a separate step, and it is yours

No tool puts an economy live. `xsolana_publish` returns the steps and the commands, and sends nothing. The commands are
the package's own CLI, run on your machine: `xsolana keygen` makes a key file for the project and prints its address,
never the key; `xsolana approve --keypair <file>` prints every transaction it would send and sends nothing; run again
with the code it printed, it signs with that key file and sends exactly what it printed to the Solana RPC. The skill
tells an agent to run that last command only after you have read the printout and said yes. Nothing asks for a seed
phrase or for the key of a wallet you already have.

An economy is on devnet, where nothing is real money, unless its file says `"network": "mainnet"`, where everything
is. The program it runs on, loot, has not been independently audited: read
[DISCLAIMER.md](https://github.com/XGamesFun/solana-kit/blob/main/DISCLAIMER.md) first.

## License

Apache-2.0, as the rest of the repository: [LICENSE](https://github.com/XGamesFun/solana-kit/blob/main/LICENSE).
