# xsolana: the plugin for Anthropic's directory

A toolkit for building game economies on Solana: design, check, simulate and review shops, items, crafting, rewards,
staking, loot boxes and auctions as a JSON spec, with no smart contract to write. This folder is the edition of the
plugin that Anthropic's directory lists. The toolkit itself, its docs and its examples are in
[the repository](https://github.com/XGamesFun/solana-kit).

## Two editions, and how this one differs

- **This one** connects to the hosted tools at `https://xgames.fun/mcp`. It starts nothing on your machine.
- **The full plugin** ([`plugin/`](https://github.com/XGamesFun/solana-kit/tree/main/plugin)) runs the same tools as a
  local process, with two more that work on your files (`xsolana_save`, `xsolana_publish`). Install it from this
  repository's own marketplace: `/plugin install xsolana --marketplace XGamesFun/solana-kit`.

## What it installs

- **A skill**, `xsolana-economy` (`skills/`): written guidance an agent reads when someone asks for an economy. It is
  text only.
- **A connection to one remote MCP server**, `xsolana` (`.mcp.json`): `https://xgames.fun/mcp`, the hosted
  `xsolana_*` tools. All eleven are read-only: they work on what a call passes them and on public Solana accounts.

## What it runs, fetches and sends

- **Runs:** nothing on install. The plugin has no code of its own.
- **Sends:** each tool call goes to `https://xgames.fun/mcp` with what the agent passes: the economy's spec, or the
  address of a public account to read. The server needs no account, sets no cookie and keeps neither; it counts
  requests by network address to limit them. [xgames.fun/privacy](https://xgames.fun/privacy) says so, under "When an
  AI assistant uses our tools".
- **Writes:** nothing itself. The skill has the agent write the economy's spec (`xsolana.json`) in your project.
- **Fetches, only when you go live:** the skill gives the agent the toolkit's own commands, each pinned
  (`npx -y @xgamesfun/solana@0.29.2 …`), which fetch the package
  [`@xgamesfun/solana`](https://www.npmjs.com/package/@xgamesfun/solana) from npm and read or send to a Solana RPC
  (the public devnet RPC, `api.devnet.solana.com`, unless `XSOLANA_RPC_URL` names another).

Two tools the skill names, `xsolana_save` and `xsolana_publish`, are in the local server only. With this edition the
agent writes `xsolana.json` itself, and `npx -y @xgamesfun/solana@0.29.2 publish` prints the steps to go live.

## Going live is a separate step, and it is yours

No tool puts an economy live. The commands are the package's own CLI, run on your machine: `xsolana keygen` makes a key
file for the project and prints its address, never the key; `xsolana approve --keypair <file>` prints every transaction
it would send and sends nothing; run again with the code it printed, it signs with that key file and sends exactly what
it printed. The skill tells an agent to run that last command only after you have read the printout and said yes.
Nothing asks for a seed phrase or for the key of a wallet you already have.

An economy is on devnet, where nothing is real money, unless its file says `"network": "mainnet"`, where everything
is. The program it runs on, loot, has not been independently audited: read
[DISCLAIMER.md](https://github.com/XGamesFun/solana-kit/blob/main/DISCLAIMER.md) first.

## License

Apache-2.0, as the rest of the repository: [LICENSE](https://github.com/XGamesFun/solana-kit/blob/main/LICENSE).
