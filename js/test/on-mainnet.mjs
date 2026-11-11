// Loaded before every test file of a run on mainnet's address (`npm run test:mainnet`). The suite's economies say devnet
// or name no network, and a process on mainnet refuses those, as it should. This makes the kit read every economy of
// this run as mainnet's, so the same tests run every flow against loot's mainnet build and address. Nothing but this
// file sets the switch (client/cluster.js, `networkOf`).
if (process.env.XSOLANA_CLUSTER !== 'mainnet')
  throw new Error('js/test/on-mainnet.mjs is for a test run with XSOLANA_CLUSTER=mainnet (npm run test:mainnet).');
globalThis[Symbol.for('xsolana.test.network')] = 'mainnet';
