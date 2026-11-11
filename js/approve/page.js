// The approval page, in the owner's own browser: the app side of the Wallet Standard (wallets such as Phantom,
// Solflare and Backpack register through two window events), then for each batch the server prepared: show it, have
// the wallet sign it, hand the signed copies back. The page never sees a key; the wallet signs. With more than one
// wallet in the browser, the person picks which; "Switch wallet" picks again. The page starts itself with the
// session's token from its <meta name="xsolana-token"> (the page allows no inline script).
import { fromBase64, toBase64 } from '/js/chain/bytes.js';

const CHAIN = 'solana:devnet';
const $ = id => document.getElementById(id);

function walletRegistry() {
  const wallets = new Set();
  const api = Object.freeze({
    register: (...ws) => {
      for (const w of ws) if (w?.features) wallets.add(w);
      return () => ws.forEach(w => wallets.delete(w));
    },
  });
  window.addEventListener('wallet-standard:register-wallet', ({ detail }) => {
    try {
      detail(api);
    } catch (e) {
      console.error(e);
    }
  });
  window.dispatchEvent(Object.assign(new Event('wallet-standard:app-ready'), { detail: api }));
  return () =>
    [...wallets].filter(
      w =>
        (w.chains ?? []).some(c => String(c).startsWith('solana:')) &&
        w.features['standard:connect'] &&
        w.features['solana:signTransaction'],
    );
}

export function approvalPage(token) {
  const list = walletRegistry();
  let wallet = null;
  let account = null;
  // Stops listening to the connected wallet's account changes.
  let unlisten = null;
  // While a batch is out for signing or sending, nothing re-enables Approve (a state refresh landing mid-way did).
  let busy = false;
  const api = async (path, body) => {
    const r = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-xsolana-token': token, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
    return data;
  };
  const log = (line, cls = '') => {
    const el = document.createElement('div');
    el.textContent = line;
    if (cls) el.className = cls;
    $('log').prepend(el);
  };

  // The last state shown: ticking the legal box shows it again, with Approve enabled or not.
  let last = null;
  // The legal lines the box was last shown with.
  let legalShown = new Set();
  function render(state) {
    last = state;
    // A token's name the spec changes and the chain can't take (`unwritten`): said whether or not anything else was
    // sent. With nothing else to send, the page never calls that a landing.
    const unwritten = state.unwritten ?? [];
    const nothingSent = state.done && unwritten.length > 0 && !state.signatures?.length;
    $('title').textContent = state.done
      ? nothingSent
        ? `Nothing to send for “${state.name}”`
        : `“${state.name}” is live`
      : `Approve “${state.name}”`;
    $('sub').textContent = state.done
      ? nothingSent
        ? `The only change in ${state.file} is a token’s name, and it can’t be written on chain: nothing was sent, and the file is as it was. See below.`
        : `Every step landed on devnet. ${state.file} now holds the project’s addresses: you can close this page.`
      : `${state.mode === 'change' ? 'A change to a live economy' : state.mode === 'resume' ? 'A setup that was cut short goes on' : 'A new economy'} from ${state.file}, on the shared loot program ${state.program.slice(0, 6)}…${state.project ? `, in the project ${state.project}${state.wallet ? `, made from your wallet ${state.wallet}` : ''}` : ''}`;
    $('cost').textContent = state.setupSol !== null && state.mode === 'new' ? `about ${state.setupSol} SOL` : '';
    const steps = $('steps');
    steps.replaceChildren(
      ...[...state.landed.map(l => ({ ...l, done: true })), ...state.steps].map(s => {
        const li = document.createElement('li');
        li.textContent = s.says;
        if (s.done) li.className = 'done';
        if (s.signer === 'authority') {
          const who = document.createElement('span');
          who.className = 'who';
          who.textContent = `the authority signs (${state.authority})`;
          li.append(who);
        }
        // Who it pays and which keys it trusts, read back from the transaction itself, addresses in full.
        if (s.details?.length) {
          const ul = document.createElement('ul');
          ul.className = 'details';
          ul.append(...s.details.map(d => Object.assign(document.createElement('li'), { textContent: d })));
          li.append(ul);
        }
        return li;
      }),
    );
    // Once done, what was to be read before approving is past; what could not be written still stands.
    const warnings = state.done ? unwritten : (state.warnings ?? []);
    $('warnbox').hidden = !warnings.length;
    $('warnhead').textContent = state.done ? 'Not written' : 'Before you approve';
    $('warnings').replaceChildren(
      ...warnings.map(w => Object.assign(document.createElement('li'), { textContent: w })),
    );
    // The notice (no warranty, at the owner's own risk, legal where it runs) and this economy's legal flags, in a
    // block of their own whatever the agent said: Approve waits until the owner ticks that they read them.
    const legal = state.legal ?? [];
    // A line that was not there when the box was ticked (what the chain says of a token, read once a wallet connects)
    // has not been read: the box is cleared, and Approve waits for it again.
    const lines = legal.map(f => f.says);
    if (lines.some(l => !legalShown.has(l))) $('legalok').checked = false;
    legalShown = new Set(lines);
    $('legalbox').hidden = Boolean(state.done);
    $('legal').hidden = !legal.length;
    $('legal').replaceChildren(...legal.map(f => Object.assign(document.createElement('li'), { textContent: f.says })));
    const unread = !$('legalok').checked;
    // The state on the page is the connected wallet's own only once the server has read the chain for it: what it
    // says of the tokens comes with that. Until then (the read is on its way, or failed) nothing can be approved.
    const reading = Boolean(account) && !state.done && !state.refused && state.wallet !== account.address;
    // A live section the chain does not bear out: nothing can be approved.
    $('approve').disabled = state.done || !account || busy || Boolean(state.refused) || unread || reading;
    $('status').textContent = state.done
      ? nothingSent
        ? 'Nothing to approve.'
        : 'Done.'
      : state.refused
        ? 'Nothing can be approved: see above.'
        : !account
          ? 'Connect a wallet first.'
          : reading
            ? 'Reading the chain for your wallet…'
            : unread
              ? 'Read the notice above and tick that you have.'
              : `${state.remaining} transaction${state.remaining === 1 ? '' : 's'} to go.`;
  }

  async function refresh() {
    try {
      // Once a wallet is connected, the steps are read back from what that wallet will sign.
      render(await api(account ? `/api/state?wallet=${encodeURIComponent(account.address)}` : '/api/state'));
    } catch (e) {
      log(e.message, 'bad');
    }
  }

  /** Connects `w` and makes its first account the one that approves; the account the wallet switches to follows. */
  async function connectTo(w) {
    // Never while a batch is out (the picker stays open meanwhile): the wallet asked to sign it hands it back.
    if (busy) return;
    $('wallets').hidden = true;
    try {
      const r = await w.features['standard:connect'].connect();
      const next = r?.accounts?.[0] ?? w.accounts?.[0] ?? null;
      if (!next) throw new Error('The wallet gave no account.');
      unlisten?.();
      unlisten = null;
      wallet = w;
      account = next;
      const events = w.features['standard:events'];
      if (events?.on) {
        unlisten = events.on('change', ({ accounts }) => {
          if (!accounts || wallet !== w || busy) return;
          account = accounts[0] ?? null;
          showWallet();
          refresh();
        });
      }
      showWallet();
      await refresh();
    } catch (e) {
      log(e.message, 'bad');
    }
  }

  function showWallet() {
    $('wallet').textContent = account ? `${wallet.name}: ${account.address}` : `${wallet.name}: no account connected`;
    $('connect').textContent = 'Switch wallet';
    $('connect').className = 'ghost';
  }

  $('legalok').addEventListener('change', () => {
    if (!last) return;
    // The wallet's own state never arrived (its read failed): asked again, so the box is ticked on what it shows.
    if (account && !last.done && last.wallet !== account.address) refresh();
    else render(last);
  });

  // One wallet is connected at once; with several in the browser, the person picks one from a list.
  $('connect').addEventListener('click', () => {
    if (busy) return;
    const found = list();
    if (!found.length) {
      log(
        'No Solana wallet in this browser. Install one (Phantom, Solflare, Backpack), set it to devnet, then reload.',
        'bad',
      );
      return;
    }
    if (found.length === 1) {
      connectTo(found[0]);
      return;
    }
    const box = $('wallets');
    box.replaceChildren(
      Object.assign(document.createElement('span'), { className: 'muted', textContent: 'Pick a wallet:' }),
      ...found.map(w => {
        const button = Object.assign(document.createElement('button'), {
          className: 'ghost',
          textContent: w === wallet ? `${w.name} (connected)` : w.name,
        });
        button.addEventListener('click', () => connectTo(w));
        return button;
      }),
    );
    box.hidden = false;
  });

  $('approve').addEventListener('click', async () => {
    if (busy || !account) return;
    busy = true;
    $('approve').disabled = true;
    // The wallet and account this approval is for, read once: the batch is prepared for, signed by and handed back
    // from the same one, whatever the wallet switches to meanwhile.
    const signer = account;
    const signingWallet = wallet;
    try {
      // `read`: the lines about its tokens this page showed when the box was ticked (the server gives no batch for others)
      const batch = await api('/api/prepare', { wallet: signer.address, read: last?.read ?? null });
      const details = (batch.details ?? []).flat();
      log(
        `Asking your wallet to approve ${batch.transactions.length} transaction${batch.transactions.length === 1 ? '' : 's'} in the project ${batch.project}: ${batch.says.join(' | ')}${details.length ? `. ${details.join('. ')}` : ''}`,
      );
      const sign = signingWallet.features['solana:signTransaction'];
      const inputs = batch.transactions.map(t => ({ account: signer, transaction: fromBase64(t), chain: CHAIN }));
      const outputs = await sign.signTransaction(...inputs);
      const signed = outputs.map(o => toBase64(o.signedTransaction));
      $('status').textContent = 'Sending and confirming…';
      const state = await api('/api/complete', { wallet: signer.address, id: batch.id, transactions: signed });
      log(`Landed: ${state.signatures.slice(-batch.transactions.length).join(', ')}`, 'ok');
      busy = false;
      render(state);
      if (!state.done) await refresh();
    } catch (e) {
      busy = false;
      log(e.message, 'bad');
      await refresh();
    }
  });

  refresh();
}

// The page's own start: the session's token is in the page's <meta name="xsolana-token">.
const token = document.querySelector('meta[name="xsolana-token"]')?.content;
if (token) approvalPage(token);
