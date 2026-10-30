// The person approving: runs the approval command the agent gave them, in the project folder, and approves on the
// page with the test wallet as the owner, batch by batch, as a person clicking would. Reports what the page said.
import { spawnGroup, stopGroup } from './procs.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { attachWallet, launchBrowser } from './wallet.mjs';

/** Is this a command a person would run to approve? Only xsolana's own approve. */
export const isApproveCommand = (command) => /^(npx\s+(-y\s+)?(--yes\s+)?@xgamesfun\/solana(@[\w.-]+)?\s+approve|xsolana\s+approve|node\s+\S*bin\/xsolana\.mjs\s+approve)(\s+[\w./-]+)?\s*$/.test(command.trim());

export async function approveRun({ command, cwd, env, keypair, rpc, log, timeoutMs = 300_000 }) {
  const parts = command.trim().split(/\s+/);
  const child = spawnGroup(parts[0], parts.slice(1), { cwd, env: { ...env, XSOLANA_NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const link = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 180_000);
    const seen = (d) => {
      output += d;
      const m = /(http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+)/.exec(output);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stdout.on('data', seen);
    child.stderr.on('data', seen);
    child.on('close', () => resolve(null));
  });
  if (!link) {
    stopGroup(child);
    return { ok: false, said: `The command printed no approval link. It said:\n${output.slice(-1500)}`, findings: [] };
  }
  const browser = await launchBrowser();
  const context = await browser.newContext();
  // A change to a live economy funds grants of the game xsolana.json already names.
  const spec = () => {
    try {
      return JSON.parse(readFileSync(path.join(cwd, 'xsolana.json'), 'utf8'));
    } catch {
      return null;
    }
  };
  const wallet = await attachWallet(context, { keypair, rpc, role: 'owner', log, game: () => spec()?.live?.project ?? spec()?.live?.game ?? null, grants: () => (spec()?.grants ?? []).map((g) => g.id).filter(Number.isInteger) });
  const page = await context.newPage();
  const started = Date.now();
  let said;
  try {
    await page.goto(link);
    await page.getByRole('button', { name: /connect a wallet/i }).click();
    // The notice and the legal flags the page shows, whatever the agent said: read, ticked as a person would, and told
    // to the person.
    // The page has its state once the line under the title is no longer "Loading…".
    await page.waitForFunction(() => !/^Loading/.test(document.getElementById('sub').textContent), null, { timeout: 30_000 }).catch(() => {});
    let legal = '';
    if (await page.locator('#legalbox').isVisible().catch(() => false)) {
      legal = [await page.locator('#terms').innerText(), await page.locator('#legal').innerText()].filter(Boolean).join('\n');
      await page.locator('#legalok').check();
    }
    // Batch by batch, as a person would: click, let the wallet sign, then wait until the page has an answer (the
    // button back for the next batch, the economy live, or an error) before looking again.
    for (let i = 0; i < 20 && Date.now() - started < timeoutMs; i++) {
      const approveButton = page.getByRole('button', { name: /approve the next batch/i });
      await page.waitForFunction(() => /is live/i.test(document.getElementById('title').textContent) || !document.getElementById('approve').disabled, null, { timeout: 30_000 }).catch(() => {});
      if (/is live/i.test(await page.locator('#title').innerText())) break;
      if (!(await approveButton.isEnabled())) break;
      const errors = await page.locator('#log .bad').count();
      await approveButton.click();
      await page.waitForFunction((before) => /is live/i.test(document.getElementById('title').textContent) || !document.getElementById('approve').disabled || document.querySelectorAll('#log .bad').length > before, errors, { timeout: Math.max(1000, timeoutMs - (Date.now() - started)) }).catch(() => {});
      if ((await page.locator('#log .bad').count()) > errors) {
        // A batch the wallet already signed may still be landing: let it finish before the server stops.
        await page.waitForTimeout(20_000);
        break;
      }
    }
    said = `${legal ? `The page asked you to read this first, and you ticked that you had:\n${legal}\n` : ''}${await page.locator('#title').innerText()}\n${await page.locator('#sub').innerText()}\n${await page.locator('#status').innerText().catch(() => '')}\n${await page.locator('#log').innerText()}`;
  } catch (e) {
    said = `The page broke: ${e.message}`;
  } finally {
    await browser.close();
    stopGroup(child);
  }
  const live = /is live/i.test(said);
  if (!live) said += `\n(the approval server printed: ${output.slice(-800)})`;
  return { ok: live, said, findings: wallet.findings(), requests: wallet.requests.length };
}
