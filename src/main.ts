import './style.css';
import { renderSVG } from 'uqr';
import type { Proof } from '@cashu/cashu-ts';
import {
  bury,
  cacheProofs,
  cacheToken,
  checkState,
  claim,
  decodeCache,
  encodeCache,
  newRefundKey,
  reclaim,
  tryAnswer,
  unseal,
  type Cache,
  type CacheState,
} from './core/cache';
import { anonymousSigner, cacheEvent, extensionSigner, fetchBoard, fetchByHash, publish, type Signer } from './core/board';
import { EcashWallet, type Store } from './core/wallet';
import { invoiceFor } from './core/lnurl';

// ---------- small helpers ----------
const app = document.querySelector<HTMLElement>('#app')!;
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = app) => root.querySelector<T>(sel)!;
const sum = (ps: Proof[]) => ps.reduce((s, p) => s + Number(p.amount.toString()), 0);
const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
const date = (sec: number) => new Date(sec * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const base = () => location.origin + location.pathname;
const fullLink = async (c: Cache) => `${base()}#/c/${await encodeCache(c)}`;
const shortLink = (c: Cache) => `${base()}#/x/${c.hash}`;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const MINTS = [
  { url: 'https://testnut.cashu.space', label: 'Test sats (testnut, free, not real money)', test: true },
  { url: 'https://mint.minibits.cash/Bitcoin', label: 'Real sats (Minibits)', test: false },
];
const isTest = (mint: string) => /testnut/i.test(mint);

const store: Store = { get: (k) => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v) };
const wallets = new Map<string, EcashWallet>();
const walletFor = (mint: string) => {
  const m = mint.replace(/\/+$/, '');
  let w = wallets.get(m);
  if (!w) wallets.set(m, (w = new EcashWallet(m, store)));
  return w;
};
const knownMints = (): string[] => {
  const s = new Set(MINTS.map((m) => m.url));
  for (const m of JSON.parse(localStorage.getItem('nutcache:mints') ?? '[]')) s.add(m);
  return [...s];
};
const rememberMint = (m: string) => {
  const list: string[] = JSON.parse(localStorage.getItem('nutcache:mints') ?? '[]');
  if (!list.includes(m)) localStorage.setItem('nutcache:mints', JSON.stringify([...list, m]));
};

// Caches I buried, with the refund key. Losing this means waiting for nobody: the sats stay locked.
interface Mine {
  cache: Cache;
  refundSk: string;
  posted?: string; // note id
  reclaimed?: boolean;
}
const mine = (): Mine[] => JSON.parse(localStorage.getItem('nutcache:mine') ?? '[]');
const saveMine = (m: Mine[]) => localStorage.setItem('nutcache:mine', JSON.stringify(m));

function qr(text: string): string {
  // uqr draws paths only; the text is ours (a link or a token we built)
  try {
    return renderSVG(text, { border: 2, ecc: 'L' });
  } catch {
    return '<p class="fine">Too long for a QR code. Put it on the map: the short link fits.</p>';
  }
}

function statusBadge(s?: CacheState | 'loading' | 'error'): string {
  if (!s) return '';
  if (s === 'loading') return '<span class="badge">checking…</span>';
  if (s === 'error') return '<span class="badge">mint unreachable</span>';
  const map = { open: ['open', 'still buried'], claimed: ['claimed', 'dug up'], expired: ['expired', 'taken back / expired'], mixed: ['claimed', 'partly dug up'] } as const;
  const [cls, text] = map[s.status];
  return `<span class="badge ${cls}">${text}</span>`;
}

// ---------- router ----------
function nav() {
  const h = location.hash || '#/';
  document.querySelectorAll<HTMLAnchorElement>('[data-nav]').forEach((a) => a.classList.toggle('on', h === a.getAttribute('href') || (a.dataset.nav === 'board' && (h === '#/' || h === ''))));
  window.scrollTo(0, 0);
  if (h.startsWith('#/c/')) return viewCacheFromLink(h.slice(4));
  if (h.startsWith('#/x/')) return viewCacheFromHash(h.slice(4));
  if (h === '#/bury') return viewBury();
  if (h === '#/my') return viewMy();
  return viewBoard();
}
window.addEventListener('hashchange', nav);

// ---------- board ----------
async function viewBoard() {
  app.innerHTML = `
    <section class="hero">
      <h1>Somebody buried sats here.</h1>
      <p>Each nutcache is ecash locked to the answer of a riddle. Solve it and the sats are yours, straight from the mint.
      Nobody holds the answer key: not this page, not a server.</p>
      <div class="row"><a class="btn big" href="#/bury">Bury a nut</a>
      <form id="open" class="row grow"><input id="link" type="text" placeholder="Paste a nutcache link (…#/c/nc1…)" /><button>Open</button></form></div>
    </section>
    <h2 class="map-title">On the map</h2>
    <div id="list" class="caches"><p class="muted">Reading the map from Nostr relays…</p></div>`;
  $('#open').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $<HTMLInputElement>('#link').value.trim();
    const m = v.match(/#\/(c|x)\/(\S+)/);
    if (m) location.hash = `#/${m[1]}/${m[2]}`;
    else if (v.startsWith('nc1')) location.hash = `#/c/${v}`;
  });
  let posted;
  try {
    posted = await fetchBoard();
  } catch (e) {
    $('#list').innerHTML = `<p class="bad">Could not read the relays: ${esc(errMsg(e))}</p>`;
    return;
  }
  if (!location.hash.match(/^#\/?$/) && location.hash !== '') return; // navigated away meanwhile
  if (!posted.length) {
    $('#list').innerHTML = `<p class="muted">The map is empty. <a href="#/bury">Bury the first nut.</a></p>`;
    return;
  }
  $('#list').innerHTML = posted
    .map(
      ({ cache }, i) => `
      <a class="cache-card" href="#/x/${esc(cache.hash)}" data-i="${i}">
        <div class="cc-top"><span class="amt">${cache.amount} <small>sats</small></span>${isTest(cache.mint) ? '<span class="badge test">test sats</span>' : ''}<span class="st"></span></div>
        <div class="cc-title">${esc(cache.title)}${cache.stage ? ` <small>· stage ${cache.stage}</small>` : ''}</div>
        <div class="cc-riddle">${esc(cache.riddle.length > 160 ? cache.riddle.slice(0, 160) + '…' : cache.riddle)}</div>
        <div class="cc-foot">buried ${date(cache.created)} · ${esc(host(cache.mint))}</div>
      </a>`,
    )
    .join('');
  // statuses, a few at a time
  const cards = [...app.querySelectorAll<HTMLElement>('.cache-card')];
  let next = 0;
  const worker = async () => {
    while (next < cards.length) {
      const i = next++;
      const st = cards[i].querySelector('.st')!;
      st.innerHTML = statusBadge('loading');
      try {
        const s = await checkState(walletFor(posted[i].cache.mint).raw, posted[i].cache);
        st.innerHTML = statusBadge(s);
        cards[i].classList.toggle('done', s.status !== 'open');
      } catch {
        st.innerHTML = statusBadge('error');
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

// ---------- one cache ----------
async function viewCacheFromLink(code: string) {
  try {
    viewCache(await decodeCache(code));
  } catch (e) {
    app.innerHTML = `<section class="card"><h2>That link does not open a nutcache</h2><p class="bad">${esc(errMsg(e))}</p></section>`;
  }
}

async function viewCacheFromHash(hash: string) {
  app.innerHTML = `<section class="card"><p class="muted">Looking for this nut on Nostr…</p></section>`;
  try {
    const p = await fetchByHash(hash);
    if (!p) throw new Error('No relay knows a nutcache with this lock. Ask whoever sent it for the full link.');
    viewCache(p.cache);
  } catch (e) {
    app.innerHTML = `<section class="card"><h2>Not found</h2><p class="bad">${esc(errMsg(e))}</p></section>`;
  }
}

function viewCache(cache: Cache) {
  const expired = Date.now() / 1000 >= cache.locktime;
  app.innerHTML = `
    <article class="scroll">
      <div class="scroll-head">
        ${cache.stage ? `<span class="stage">Stage ${cache.stage}</span>` : ''}
        <h1>${esc(cache.title)}</h1>
        <div class="row center"><span class="amt big">${cache.amount} <small>sats</small></span>${isTest(cache.mint) ? '<span class="badge test">test sats</span>' : ''}<span id="st">${statusBadge('loading')}</span></div>
      </div>
      <blockquote class="riddle">${esc(cache.riddle)}</blockquote>
      ${cache.hint ? `<details class="hint"><summary>Need a hint?</summary><p>${esc(cache.hint)}</p></details>` : ''}
      <form id="dig" class="dig">
        <input id="answer" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Your answer" required />
        <button class="btn big" id="dig-btn">Dig</button>
      </form>
      <p id="dig-msg" class="msg" aria-live="polite"></p>
      <div id="won"></div>
      <p class="fine">Case, spaces and punctuation don't matter. Answers are checked here in your browser first (scrypt, about a second),
      then the mint pays out to whoever brings the right one.
      ${expired ? 'The burier may take these sats back now.' : `Can be dug until ${date(cache.locktime)}; after that the burier may take the sats back.`}
      Mint: ${esc(host(cache.mint))}.</p>
      <details class="fine"><summary>Share or inspect</summary>
        <div class="row"><button type="button" id="copy-link">Copy link</button><button type="button" id="copy-token">Copy as Cashu token (HTLC)</button></div>
        <p>Lock: <code>${esc(cache.hash)}</code></p>
      </details>
    </article>`;
  const w = walletFor(cache.mint);
  checkState(w.raw, cache)
    .then((s) => {
      $('#st').innerHTML = statusBadge(s);
      if (s.status !== 'open') {
        $('#dig-msg').innerHTML =
          s.status === 'claimed'
            ? `Someone already dug this one up.${cache.next ? ' The right answer still opens the next stage of the hunt.' : ''}`
            : `This nut was taken back by its burier.${cache.next ? ' The right answer still opens the next stage.' : ''}`;
      }
    })
    .catch(() => ($('#st').innerHTML = statusBadge('error')));

  $('#copy-link').addEventListener('click', async () => copy(await fullLink(cache), $('#copy-link')));
  $('#copy-token').addEventListener('click', () => copy(cacheToken(cache), $('#copy-token')));

  let tries = 0;
  $('#dig').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $<HTMLButtonElement>('#dig-btn');
    const msg = $('#dig-msg');
    const answer = $<HTMLInputElement>('#answer').value;
    btn.disabled = true;
    btn.textContent = 'Digging…';
    msg.className = 'msg';
    msg.textContent = '';
    try {
      const d = await tryAnswer(cache, answer);
      if (!d) {
        tries++;
        msg.className = 'msg bad';
        msg.textContent = ['Just dirt.', 'Only roots here.', 'A pebble. Not this one.', 'Nope, keep thinking.'][tries % 4];
        const s = $('.scroll');
        s.classList.remove('shake');
        void s.offsetWidth;
        s.classList.add('shake');
        return;
      }
      msg.className = 'msg good';
      msg.textContent = 'That is the answer! Asking the mint…';
      let won: Proof[] = [];
      try {
        won = await claim(w.raw, cache, d.preimage);
        w.add(won);
        rememberMint(cache.mint);
        const found = JSON.parse(localStorage.getItem('nutcache:found') ?? '[]');
        found.push({ hash: cache.hash, title: cache.title, amount: sum(won), mint: cache.mint, at: Date.now() });
        localStorage.setItem('nutcache:found', JSON.stringify(found));
        msg.textContent = '';
        showWon(won, cache);
      } catch (err) {
        const m = errMsg(err);
        msg.className = 'msg';
        msg.textContent = /spent|already/i.test(m) ? 'Right answer, but someone got here first: these sats are already dug up.' : `Right answer, but the mint said: ${m}`;
      }
      if (cache.next) {
        const next = await unseal(d.stageKey, cache.next);
        const link = await fullLink(next);
        $('#won').insertAdjacentHTML(
          'beforeend',
          `<div class="next"><p>🗺️ The answer opened <b>stage ${next.stage ?? '?'}</b> of the hunt: “${esc(next.title)}”.</p><a class="btn big" href="${esc(link)}">Go to the next stage</a></div>`,
        );
      }
    } catch (err) {
      msg.className = 'msg bad';
      msg.textContent = errMsg(err);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Dig';
    }
  });
}

function showWon(won: Proof[], cache: Cache) {
  const w = walletFor(cache.mint);
  const amount = sum(won);
  $('#won').innerHTML = `
    <div class="won">
      <div class="burst">🥜</div>
      <h2>You dug up ${amount} sats!</h2>
      ${isTest(cache.mint) ? '<p class="muted">(test sats from testnut — practice money)</p>' : ''}
      <p>They're in this browser for now. Take them to your own wallet:</p>
      <div class="row center"><button id="take" class="btn">Take as a Cashu token</button></div>
      <form id="ln" class="row center"><input id="ln-addr" type="text" placeholder="you@your-wallet.com" /><button>Send to Lightning address</button></form>
      <div id="out"></div>
      <p id="ln-msg" class="msg"></p>
    </div>`;
  $('#take').addEventListener('click', async () => {
    try {
      const token = await w.takeOut(won, `Nutcache: ${cache.title}`);
      $('#out').innerHTML = `<p>Paste this into any Cashu wallet (cashu.me, Minibits, …):</p><div class="qr">${qr(token)}</div><textarea rows="3" readonly>${esc(token)}</textarea><div class="row center"><button id="copy-won">Copy token</button></div>`;
      $('#copy-won').addEventListener('click', () => copy(token, $('#copy-won')));
      $('#take').remove();
      $('#ln').remove();
    } catch (err) {
      $('#ln-msg').textContent = errMsg(err);
    }
  });
  $('#ln').addEventListener('submit', async (e) => {
    e.preventDefault();
    const m = $('#ln-msg');
    try {
      m.className = 'msg';
      m.textContent = 'Paying…';
      const r = await payToAddress(w, $<HTMLInputElement>('#ln-addr').value.trim(), amount);
      m.className = 'msg good';
      m.textContent = `Sent ${r.sent} sats (Lightning fee ${r.fee}).`;
      $('#take')?.remove();
    } catch (err) {
      m.className = 'msg bad';
      m.textContent = `${errMsg(err)} The sats stay in My nuts.`;
    }
  });
}

/** Pay as much of `max` as fits after the mint's fee reserve to a Lightning address. */
async function payToAddress(w: EcashWallet, address: string, max: number): Promise<{ sent: number; fee: number }> {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new Error('That is not a Lightning address.');
  let amount = Math.min(max, w.balance());
  for (let i = 0; i < 4 && amount > 0; i++) {
    const inv = await invoiceFor(address, amount, 'Dug up with Nutcache');
    const q = await w.meltQuote(inv);
    if (q.amount + q.feeReserve <= w.balance()) {
      const r = await w.payInvoice(inv);
      return { sent: r.amount, fee: r.feePaid };
    }
    amount = w.balance() - q.feeReserve - 1;
  }
  throw new Error('Too few sats to cover the Lightning fee reserve.');
}

async function copy(text: string, btn: HTMLElement) {
  try {
    await navigator.clipboard.writeText(text);
    const t = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = t), 1200);
  } catch {
    prompt('Copy this:', text);
  }
}

// ---------- bury ----------
interface StageForm {
  title: string;
  riddle: string;
  answer: string;
  hint: string;
  amount: number;
}

function stageHtml(i: number, s: Partial<StageForm> = {}) {
  return `
    <fieldset class="stage-form" data-i="${i}">
      <legend>${i === 0 ? 'The nut' : `Stage ${i + 1}`}</legend>
      <label>Title <input name="title" type="text" maxlength="80" value="${esc(s.title ?? '')}" placeholder="${i === 0 ? 'Under the old oak' : 'Deeper still'}" /></label>
      <label>Riddle <textarea name="riddle" rows="3" maxlength="1000" placeholder="I have roots nobody sees, I'm taller than trees… what am I?">${esc(s.riddle ?? '')}</textarea></label>
      <div class="two">
        <label>Answer <input name="answer" type="text" autocomplete="off" value="${esc(s.answer ?? '')}" placeholder="a mountain" /></label>
        <label>Sats <input name="amount" type="number" min="1" value="${s.amount ?? 21}" /></label>
      </div>
      <label>Hint (optional) <input name="hint" type="text" maxlength="200" value="${esc(s.hint ?? '')}" /></label>
      ${i > 0 ? '<button type="button" class="link remove">remove this stage</button>' : ''}
    </fieldset>`;
}

async function viewBury() {
  const lastMint = localStorage.getItem('nutcache:mint') ?? MINTS[0].url;
  app.innerHTML = `
    <section class="grid">
      <div class="card">
        <h2>1 · Sats to bury</h2>
        <label>Mint <select id="mint">${knownMints()
          .map((m) => `<option value="${esc(m)}" ${m === lastMint ? 'selected' : ''}>${esc(MINTS.find((x) => x.url === m)?.label ?? host(m))}</option>`)
          .join('')}<option value="custom">Another mint…</option></select></label>
        <p>In this browser: <b id="bal">…</b> sats</p>
        <form id="topup" class="row"><input id="top-amt" type="number" min="1" value="100" /><button>Top up over Lightning</button></form>
        <div id="invoice"></div>
        <form id="paste" class="row"><input id="tok" type="text" placeholder="…or paste a Cashu token (cashuB…)" /><button>Add</button></form>
        <p id="w-msg" class="msg"></p>
      </div>
      <form id="bury" class="card">
        <h2>2 · The riddle</h2>
        <div id="stages">${stageHtml(0)}</div>
        <button type="button" id="add-stage" class="link">+ add a stage (make it a hunt: each answer unlocks the next riddle)</button>
        <label>Digging time <select id="days"><option value="1">1 day</option><option value="7">1 week</option><option value="30" selected>30 days</option><option value="90">90 days</option></select></label>
        <p class="fine">Until then only the right answer opens it; after that you can take back whatever is still buried (keep this browser, or the backup from My nuts).</p>
        <button class="btn big" id="bury-btn">Bury it</button>
        <p id="bury-msg" class="msg"></p>
      </form>
    </section>
    <div id="result"></div>`;

  const mintSel = $<HTMLSelectElement>('#mint');
  const cur = () => walletFor(mintSel.value);
  const refresh = () => ($('#bal').textContent = String(cur().balance()));
  refresh();
  mintSel.addEventListener('change', () => {
    if (mintSel.value === 'custom') {
      const u = prompt('Mint URL (it must support NUT-14):', 'https://');
      if (!u || !/^https?:\/\//.test(u)) {
        mintSel.value = lastMint;
        return;
      }
      rememberMint(u.replace(/\/+$/, ''));
      return viewBury();
    }
    localStorage.setItem('nutcache:mint', mintSel.value);
    refresh();
  });

  let polling = 0;
  $('#topup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const m = $('#w-msg');
    try {
      const w = cur();
      const t = await w.createTopUp(Number($<HTMLInputElement>('#top-amt').value));
      $('#invoice').innerHTML = `<div class="qr">${qr(t.invoice.toUpperCase())}</div><p class="row center"><button type="button" id="copy-inv">Copy invoice</button></p>`;
      $('#copy-inv').addEventListener('click', () => copy(t.invoice, $('#copy-inv')));
      m.textContent = isTest(w.mintUrl) ? 'testnut pays its own invoices: the sats arrive in a few seconds.' : 'Waiting for payment…';
      const id = ++polling;
      for (let i = 0; i < 200 && id === polling; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const got = await w.claimTopUp(t).catch(() => 0);
        if (got) {
          m.className = 'msg good';
          m.textContent = `+${got} sats`;
          $('#invoice').innerHTML = '';
          rememberMint(w.mintUrl);
          refresh();
          break;
        }
      }
    } catch (err) {
      m.className = 'msg bad';
      m.textContent = errMsg(err);
    }
  });

  $('#paste').addEventListener('submit', async (e) => {
    e.preventDefault();
    const m = $('#w-msg');
    try {
      const got = await cur().receive($<HTMLInputElement>('#tok').value);
      m.className = 'msg good';
      m.textContent = `+${got} sats`;
      $<HTMLInputElement>('#tok').value = '';
      refresh();
    } catch (err) {
      m.className = 'msg bad';
      m.textContent = errMsg(err);
    }
  });

  const stages = $('#stages');
  $('#add-stage').addEventListener('click', () => {
    stages.insertAdjacentHTML('beforeend', stageHtml(stages.children.length, { amount: 10 }));
  });
  stages.addEventListener('click', (e) => {
    const b = e.target as HTMLElement;
    if (b.classList.contains('remove')) {
      b.closest('fieldset')!.remove();
      [...stages.children].forEach((f, i) => (f.querySelector('legend')!.textContent = i === 0 ? 'The nut' : `Stage ${i + 1}`));
    }
  });

  $('#bury').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#bury-msg');
    const btn = $<HTMLButtonElement>('#bury-btn');
    const forms: StageForm[] = [...stages.querySelectorAll('fieldset')].map((f) => ({
      title: (f.querySelector('[name=title]') as HTMLInputElement).value,
      riddle: (f.querySelector('[name=riddle]') as HTMLTextAreaElement).value,
      answer: (f.querySelector('[name=answer]') as HTMLInputElement).value,
      hint: (f.querySelector('[name=hint]') as HTMLInputElement).value,
      amount: Number((f.querySelector('[name=amount]') as HTMLInputElement).value),
    }));
    msg.className = 'msg';
    const bad = forms.findIndex((f) => !f.riddle.trim() || !f.answer.trim() || !(f.amount >= 1));
    if (bad >= 0) {
      msg.className = 'msg bad';
      msg.textContent = `${bad === 0 ? 'The nut' : `Stage ${bad + 1}`} needs a riddle, an answer and at least 1 sat.`;
      return;
    }
    const w = cur();
    const total = forms.reduce((s, f) => s + f.amount, 0);
    if (w.balance() < total) {
      msg.className = 'msg bad';
      msg.textContent = `You need ${total} sats in this wallet (plus a sat or two of mint fees); you have ${w.balance()}. Top up first.`;
      return;
    }
    btn.disabled = true;
    const days = Number($<HTMLSelectElement>('#days').value);
    const key = newRefundKey();
    const made: Cache[] = [];
    try {
      // Build a hunt from its last stage: each stage carries the next one, sealed with its own answer.
      let next: Cache | undefined;
      for (let i = forms.length - 1; i >= 0; i--) {
        msg.textContent = forms.length > 1 ? `Burying stage ${i + 1}…` : 'Burying…';
        const f = forms[i];
        const cache: Cache = await w.use(async (raw, proofs) => {
          const r = await bury(raw, proofs, { ...f, days, refundPk: key.pk, stage: forms.length > 1 ? i + 1 : undefined, nextCache: next });
          return { proofs: r.keep, result: r.cache };
        });
        made.unshift(cache);
        // Save at once: the refund key is the only way back if the page closes now.
        saveMine([...mine(), { cache, refundSk: key.sk }]);
        next = cache;
      }
      rememberMint(w.mintUrl);
      refresh();
      msg.className = 'msg good';
      msg.textContent = forms.length > 1 ? `Buried a ${forms.length}-stage hunt.` : 'Buried.';
      await showBuried(made[0]);
    } catch (err) {
      msg.className = 'msg bad';
      msg.textContent = `${errMsg(err)}${made.length ? ' (stages buried so far are in My nuts)' : ''}`;
    } finally {
      btn.disabled = false;
    }
  });
}

async function showBuried(cache: Cache) {
  const full = await fullLink(cache);
  $('#result').innerHTML = `
    <section class="card result">
      <h2>🥜 Buried: “${esc(cache.title)}”</h2>
      <p>Share the link or the card. Whoever solves the riddle takes the ${cache.amount} sats${cache.next ? ' and the way to the next stage' : ''}.</p>
      <div class="grid">
        <div>
          <label>Link (the whole nut is inside it, works without any server)<textarea id="full" rows="4" readonly>${esc(full)}</textarea></label>
          <div class="row"><button id="copy-full">Copy link</button><a class="btn" href="${esc(full)}">Open it</a><button id="print">Print a card</button></div>
          <h3>Put it on the map</h3>
          <p class="fine">Posts a normal Nostr note with #nutcache (riddle, amount, link) so it shows up on the map here and in Nostr clients.
          The short link and QR then only need the lock hash.</p>
          <div class="row"><button id="post-anon">Post anonymously</button><button id="post-ext">Post with my Nostr key (extension)</button></div>
          <p id="post-msg" class="msg"></p>
        </div>
        <div class="print-card">
          <div class="pc-title">🥜 ${esc(cache.title)}</div>
          <div class="pc-riddle">${esc(cache.riddle)}</div>
          <div class="qr" id="card-qr">${qr(full)}</div>
          <div class="pc-foot">${cache.amount} sats buried behind the answer${isTest(cache.mint) ? ' (test sats)' : ''}. Scan, solve, dig.</div>
        </div>
      </div>
    </section>`;
  $('#copy-full').addEventListener('click', () => copy(full, $('#copy-full')));
  $('#print').addEventListener('click', () => window.print());
  const post = async (signer: () => Signer) => {
    const m = $('#post-msg');
    try {
      m.className = 'msg';
      m.textContent = 'Posting…';
      const ev = await signer().signEvent(await cacheEvent(cache, shortLink(cache)));
      const ok = await publish(ev);
      const list = mine();
      const me = list.find((x) => x.cache.hash === cache.hash);
      if (me) me.posted = ev.id;
      saveMine(list);
      m.className = 'msg good';
      m.innerHTML = `On the map (${ok.length} relays). Short link: <a href="${esc(shortLink(cache))}">${esc(shortLink(cache))}</a>`;
      $('#card-qr').innerHTML = qr(shortLink(cache));
    } catch (err) {
      m.className = 'msg bad';
      m.textContent = errMsg(err);
    }
  };
  $('#post-anon').addEventListener('click', () => post(anonymousSigner));
  $('#post-ext').addEventListener('click', () => post(() => extensionSigner((window as unknown as { nostr?: Parameters<typeof extensionSigner>[0] }).nostr)));
  $('#result').scrollIntoView({ behavior: 'smooth' });
}

// ---------- my nuts ----------
async function viewMy() {
  const list = mine();
  const mints = knownMints().filter((m) => walletFor(m).balance() > 0 || list.some((x) => x.cache.mint === m));
  app.innerHTML = `
    <section class="grid">
      <div class="card">
        <h2>Wallet</h2>
        ${
          mints.length
            ? mints
                .map(
                  (m, i) => `
          <div class="wallet-row" data-i="${i}">
            <div><b>${walletFor(m).balance()}</b> sats · ${esc(MINTS.find((x) => x.url === m)?.label ?? host(m))}</div>
            <div class="row"><button class="take" data-m="${esc(m)}">Take out as token</button>
            <form class="row lnpay" data-m="${esc(m)}"><input type="text" placeholder="Lightning address" /><button>Send</button></form></div>
            <p class="msg"></p>
          </div>`,
                )
                .join('')
            : '<p class="muted">Nothing here yet. Dig up a nut, or top up on the Bury page.</p>'
        }
      </div>
      <div class="card">
        <h2>Nuts I buried</h2>
        ${list.length ? '<div id="mine"></div>' : '<p class="muted">None yet. <a href="#/bury">Bury one.</a></p>'}
        ${list.length ? '<p class="fine">The refund keys live only in this browser. <button id="backup" class="link">Download a backup</button> · <label class="link">restore<input id="restore" type="file" accept=".json" hidden /></label></p>' : '<p class="fine"><label class="link">Restore a backup<input id="restore" type="file" accept=".json" hidden /></label></p>'}
      </div>
    </section>`;

  app.querySelectorAll<HTMLButtonElement>('.take').forEach((b) =>
    b.addEventListener('click', async () => {
      const row = b.closest('.wallet-row')!;
      const m = row.querySelector('.msg')!;
      try {
        const t = await walletFor(b.dataset.m!).exportAll('Nutcache');
        m.innerHTML = `<textarea rows="3" readonly>${esc(t)}</textarea>`;
        navigator.clipboard?.writeText(t).catch(() => undefined);
        row.querySelector('b')!.textContent = '0';
      } catch (err) {
        m.textContent = errMsg(err);
      }
    }),
  );
  app.querySelectorAll<HTMLFormElement>('.lnpay').forEach((f) =>
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const row = f.closest('.wallet-row')!;
      const m = row.querySelector('.msg')!;
      const w = walletFor(f.dataset.m!);
      try {
        m.textContent = 'Paying…';
        const r = await payToAddress(w, f.querySelector('input')!.value.trim(), w.balance());
        m.textContent = `Sent ${r.sent} sats (fee ${r.fee}).`;
        row.querySelector('b')!.textContent = String(w.balance());
      } catch (err) {
        m.textContent = errMsg(err);
      }
    }),
  );

  $('#backup')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ nutcache: 1, mine: mine() }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `nutcache-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  });
  $<HTMLInputElement>('#restore')?.addEventListener('change', async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const have = new Set(mine().map((x) => x.cache.hash));
      const add = (data.mine as Mine[]).filter((x) => x.cache?.hash && x.refundSk && !have.has(x.cache.hash));
      saveMine([...mine(), ...add]);
      viewMy();
    } catch (err) {
      alert(`Not a Nutcache backup: ${errMsg(err)}`);
    }
  });

  if (!list.length) return;
  const box = $('#mine');
  box.innerHTML = list
    .slice()
    .reverse()
    .map(
      (x) => `
      <div class="mine-row" data-h="${esc(x.cache.hash)}">
        <div><a href="${esc(shortLink(x.cache))}" class="open-mine">${esc(x.cache.title)}</a>${x.cache.stage ? ` <small>· stage ${x.cache.stage}</small>` : ''} · ${x.cache.amount} sats ${isTest(x.cache.mint) ? '<span class="badge test">test</span>' : ''} <span class="st">${statusBadge('loading')}</span></div>
        <div class="fine">buried ${date(x.cache.created)} · can take back from ${date(x.cache.locktime)}</div>
        <div class="act"></div>
      </div>`,
    )
    .join('');
  box.querySelectorAll<HTMLAnchorElement>('.open-mine').forEach((a) =>
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      const x = mine().find((y) => y.cache.hash === a.closest<HTMLElement>('.mine-row')!.dataset.h)!;
      location.hash = x.posted ? `#/x/${x.cache.hash}` : `#/c/${await encodeCache(x.cache)}`;
    }),
  );
  for (const row of box.querySelectorAll<HTMLElement>('.mine-row')) {
    const x = list.find((y) => y.cache.hash === row.dataset.h)!;
    const w = walletFor(x.cache.mint);
    checkState(w.raw, x.cache)
      .then((s) => {
        row.querySelector('.st')!.innerHTML = statusBadge(s);
        if (s.status === 'expired' && !x.reclaimed) {
          // expired and every proof still unspent: ours to take back
          checkUnspent(w, x).then((can) => {
            if (!can) return;
            row.querySelector('.act')!.innerHTML = '<button class="btn">Take it back</button>';
            row.querySelector('.act button')!.addEventListener('click', async () => {
              try {
                const back = await reclaim(w.raw, x.cache, x.refundSk);
                w.add(back);
                const l = mine();
                l.find((y) => y.cache.hash === x.cache.hash)!.reclaimed = true;
                saveMine(l);
                viewMy();
              } catch (err) {
                row.querySelector('.act')!.textContent = errMsg(err);
              }
            });
          });
        }
      })
      .catch(() => (row.querySelector('.st')!.innerHTML = statusBadge('error')));
  }
}

async function checkUnspent(w: EcashWallet, x: Mine): Promise<boolean> {
  const st = await w.raw.checkProofsStates(cacheProofs(x.cache));
  return st.every((s) => String(s.state).toUpperCase() === 'UNSPENT');
}

nav();
