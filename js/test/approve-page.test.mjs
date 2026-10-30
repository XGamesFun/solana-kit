// The approval page itself, in a real headless Chrome: the test wallet (Wallet Standard, as Phantom registers)
// connects, and each batch is approved by clicking, exactly as a person would; the server sends to LiteSVM.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { freshKeypair } from '../approve/ed25519.mjs';
import { approve } from '../approve/server.mjs';
import { attachWallet, launchBrowser } from '../../evals/live/wallet.mjs';
import { approvalChain, cannotRun, world } from './world.mjs';

const NOW = 1_790_000_000;
const chrome = ['/usr/bin/google-chrome', '/usr/bin/chromium'].some((p) => existsSync(p));
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
    assert.match(await page.locator('#terms').innerText(), /not been independently audited[\s\S]*own risk[\s\S]*legal everywhere it is offered/);
    // The wallet is connected and the page asks for the tick: Approve stays disabled until it is given.
    await page.waitForFunction(() => /notice above/.test(document.getElementById('status').textContent));
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#approve').isDisabled(), true, 'not before the flags are read');
    await page.locator('#legalok').check();
    await page.waitForFunction(() => !document.getElementById('approve').disabled);
    for (let i = 0; i < 5; i++) {
      if (/is live/.test(await page.locator('#title').innerText())) break;
      await page.getByRole('button', { name: /approve the next batch/i }).click();
      await page.waitForFunction(() => /is live/.test(document.getElementById('title').textContent) || !document.getElementById('approve').disabled, null, { timeout: 30_000 });
    }
    assert.match(await page.locator('#title').innerText(), /is live/);
    assert.ok(wallet.requests.some((r) => r.op === 'sign' && r.ok), 'the wallet signed');
    assert.deepEqual(wallet.findings(), [], 'the setup is what the wallet policy allows');
    assert.ok(JSON.parse(readFileSync(file, 'utf8')).live?.project);
  } finally {
    await browser.close();
    server.close();
  }
});
