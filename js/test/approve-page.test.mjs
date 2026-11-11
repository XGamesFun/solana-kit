// The approval page itself, in a real headless Chrome: the test wallet (Wallet Standard, as Phantom registers)
// connects, and each batch is approved by clicking, exactly as a person would; the server sends to LiteSVM.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { approve, createApproval } from '../approve/server.mjs';
import { fromBase64, toBase64 } from '../chain/bytes.js';
import { metadataAddress } from '../chain/metadata.js';
import { TOKEN_PROGRAM } from '../chain/pda.js';
import { createAccountIx, initializeMint2Ix, MINT_BYTES, setAuthorityIx } from '../chain/token.js';
import { readTransaction, wireTransaction } from '../chain/tx.js';
import { attachWallet, launchBrowser } from '../../evals/live/wallet.mjs';
import { approvalChain, cannotRun, world } from './world.mjs';

const NOW = 1_790_000_000;
const chrome = ['/usr/bin/google-chrome', '/usr/bin/chromium'].some(p => existsSync(p));
const skip = cannotRun() ?? (chrome ? false : 'no Chrome on this machine');

test('the approval page puts an economy live with a browser wallet', { skip }, async () => {
  const w = world({ project: false, seed: 'page' });
  w.chain.warp(NOW);
  const owner = freshKeypair();
  w.chain.airdrop(owner.address, 100_000_000_000n);
  const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-page-'));
  const file = path.join(dir, 'xsolana.json');
  writeFileSync(file, readFileSync(new URL('../../examples/coin-flip-arena.json', import.meta.url)));
  const chain = approvalChain(w);
  const { server, link } = await approve({ file, open: false, chain, log: () => {} });
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext();
    const wallet = await attachWallet(context, { keypair: owner, rpc: null, role: 'owner' });
    const page = await context.newPage();
    await page.goto(link);
    await page.getByRole('button', { name: /connect a wallet/i }).click();
    // A coin flip pays a chance at money and pays stakers from what players spend: the page says so in plain words,
    // whatever the agent said, and Approve waits until the owner ticks that they read it.
    await page.waitForFunction(() => !document.getElementById('legalbox').hidden);
    assert.match(await page.locator('#legal').innerText(), /gambling/);
    assert.match(await page.locator('#legal').innerText(), /security/);
    // above them, always: no audit, no warranty, at the owner's own risk, and the law is theirs
    assert.match(
      await page.locator('#terms').innerText(),
      /not been independently audited[\s\S]*own risk[\s\S]*legal everywhere it is offered/,
    );
    // The wallet is connected and the page asks for the tick: Approve stays disabled until it is given.
    await page.waitForFunction(() => /notice above/.test(document.getElementById('status').textContent));
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#approve').isDisabled(), true, 'not before the flags are read');
    await page.locator('#legalok').check();
    await page.waitForFunction(() => !document.getElementById('approve').disabled);
    for (let i = 0; i < 5; i++) {
      if (/is live/.test(await page.locator('#title').innerText())) break;
      await page.getByRole('button', { name: /approve the next batch/i }).click();
      await page.waitForFunction(
        () =>
          /is live/.test(document.getElementById('title').textContent) || !document.getElementById('approve').disabled,
        null,
        { timeout: 30_000 },
      );
    }
    assert.match(await page.locator('#title').innerText(), /is live/);
    assert.ok(
      wallet.requests.some(r => r.op === 'sign' && r.ok),
      'the wallet signed',
    );
    assert.deepEqual(wallet.findings(), [], 'the setup is what the wallet policy allows');
    assert.ok(JSON.parse(readFileSync(file, 'utf8')).live?.project);
  } finally {
    await browser.close();
    server.close();
  }
});

test(
  'what the chain says of a named token is shown before anything can be approved: a tick given before it is cleared',
  { skip },
  async () => {
    const w = world({ project: false, seed: 'page-powers' });
    w.chain.warp(NOW);
    const owner = freshKeypair();
    w.chain.airdrop(owner.address, 100_000_000_000n);
    const dir = mkdtempSync(path.join(tmpdir(), 'xsolana-page-'));
    const file = path.join(dir, 'xsolana.json');
    // a coin made elsewhere, which its maker can still mint: the spec says nothing of that, so no checker warning
    const spec = {
      version: 2,
      network: 'devnet',
      name: 'Coin shop',
      currency: 'coin',
      collection: false,
      tokens: [{ key: 'coin', symbol: 'COIN', source: 'existing', mint: w.mint, decimals: 6, powers: {} }],
      pools: [{ key: 'house', currency: 'coin' }],
    };
    writeFileSync(file, JSON.stringify(spec));
    const chain = approvalChain(w);
    const { server, link } = await approve({ file, open: false, chain, log: () => {} });
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      await attachWallet(context, { keypair: owner, rpc: null, role: 'owner' });
      const page = await context.newPage();
      await page.goto(link);
      // ticked before a wallet is connected, on a page with nothing of the chain on it yet
      await page.waitForFunction(() => !document.getElementById('legalbox').hidden);
      assert.equal(await page.locator('#legal').innerText(), '');
      await page.locator('#legalok').check();
      await page.getByRole('button', { name: /connect a wallet/i }).click();
      // the wallet's own state brings the line; the tick is cleared, and Approve waits for it again
      await page.waitForFunction(() =>
        /mint more of it whenever they want/.test(document.getElementById('legal').textContent),
      );
      assert.match(await page.locator('#legal').innerText(), /Read from the chain, and not in the spec/);
      assert.equal(
        await page.locator('#legalok').isChecked(),
        false,
        'a tick given before the line was shown does not count',
      );
      assert.equal(await page.locator('#approve').isDisabled(), true);
      await page.locator('#legalok').check();
      await page.waitForFunction(() => !document.getElementById('approve').disabled);
      for (let i = 0; i < 5; i++) {
        if (/is live/.test(await page.locator('#title').innerText())) break;
        await page.getByRole('button', { name: /approve the next batch/i }).click();
        await page.waitForFunction(
          () =>
            /is live/.test(document.getElementById('title').textContent) ||
            !document.getElementById('approve').disabled,
          null,
          { timeout: 30_000 },
        );
      }
      assert.match(await page.locator('#title').innerText(), /is live/);
    } finally {
      await browser.close();
      server.close();
    }
  },
);

test(
  'a change that is only a token’s name the chain can’t take: the page says why, and never that it landed',
  { skip },
  async () => {
    const w = world({ project: false, seed: 'page-unwritten' });
    w.chain.warp(NOW);
    const owner = freshKeypair();
    w.chain.airdrop(owner.address, 100_000_000_000n);
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'xsolana-page-')), 'xsolana.json');
    const spec = {
      version: 2,
      network: 'devnet',
      name: 'Renamed',
      currency: 'sol',
      tokens: [
        { key: 'sol', source: 'sol' },
        { key: 'bubl', source: 'project', name: 'Bubble', symbol: 'BUBL' },
      ],
      collection: false,
    };
    writeFileSync(file, JSON.stringify(spec));
    const chain = approvalChain(w);
    // live, by the session itself
    const session = await createApproval({ file, chain, now: () => NOW });
    for (let i = 0; i < 5 && !session.state().done; i++) {
      const batch = await session.prepare(owner.address);
      const signed = batch.transactions.map(b64 => {
        const t = readTransaction(fromBase64(b64));
        const sigs = [...t.signatures];
        sigs[t.signers.indexOf(owner.address)] = owner.sign(t.message);
        return toBase64(wireTransaction(t.message, sigs));
      });
      await session.complete(owner.address, batch.id, signed);
    }
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    // as a release before setups named tokens left it: a mint of the project's with no name record; then a new name
    const bare = freshKeypair().address;
    w.chain.send(owner.address, [
      createAccountIx({
        from: owner.address,
        address: bare,
        lamports: w.chain.rent(MINT_BYTES),
        space: MINT_BYTES,
        owner: TOKEN_PROGRAM,
      }),
      initializeMint2Ix({ mint: bare, decimals: 0, authority: owner.address }),
      setAuthorityIx({ account: bare, current: owner.address, newAuthority: saved.live.project }),
    ]);
    const next = {
      ...saved,
      tokens: saved.tokens.map(t => (t.key === 'bubl' ? { ...t, name: 'Bubble Day' } : t)),
      live: { ...saved.live, mints: { bubl: bare } },
    };
    writeFileSync(file, JSON.stringify(next, null, 2));
    const { server, link } = await approve({ file, open: false, chain, log: () => {} });
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      const wallet = await attachWallet(context, { keypair: owner, rpc: null, role: 'owner' });
      const page = await context.newPage();
      await page.goto(link);
      // from the file alone, the change is listed: only the chain can say it can't be written
      await page.waitForFunction(() => /Change what the token BUBL/.test(document.getElementById('steps').textContent));
      assert.match(await page.locator('#title').innerText(), /^Approve/);
      await page.getByRole('button', { name: /connect a wallet/i }).click();
      await page.waitForFunction(() => /Nothing to send/.test(document.getElementById('title').textContent));
      assert.doesNotMatch(await page.locator('#title').innerText(), /is live/);
      assert.match(await page.locator('#sub').innerText(), /can’t be written on chain: nothing was sent/);
      assert.doesNotMatch(await page.locator('#sub').innerText(), /landed/);
      assert.equal(await page.locator('#warnbox').isVisible(), true, 'the reason is on the page');
      assert.match(await page.locator('#warnhead').innerText(), /Not written/);
      assert.match(
        await page.locator('#warnings').innerText(),
        /BUBL is called, but it went live before setups named tokens[\s\S]*said at each approve/,
      );
      assert.equal(await page.locator('#steps > li').count(), 0);
      assert.equal(await page.locator('#status').innerText(), 'Nothing to approve.');
      assert.equal(await page.locator('#approve').isDisabled(), true);
      assert.ok(!wallet.requests.some(r => r.op === 'sign'), 'nothing was asked of the wallet');
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), next, 'the file is as it was');
      assert.equal(w.chain.get(metadataAddress(bare)), null);
    } finally {
      await browser.close();
      server.close();
    }
  },
);
