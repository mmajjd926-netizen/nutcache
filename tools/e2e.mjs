// Headless, both sides: a burier tops up on testnut and buries a 2-stage hunt; a digger opens the link in
// another browser, gets a wrong answer refused, digs up stage 1, follows to stage 2, digs that too.
// Usage: node tools/e2e.mjs [url]   (vite preview on 4174)
import { chromium } from 'playwright';
import { Wallet } from '@cashu/cashu-ts';
const url = process.argv[2] ?? 'http://127.0.0.1:4174/';
const b = await chromium.launch();
const logs = [];
async function page(path = '') {
  const ctx = await b.newContext({ viewport: { width: 1200, height: 1000 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
  p.on('console', (m) => m.type() === 'error' && logs.push('console: ' + m.text()));
  p.on('dialog', (d) => d.accept());
  await p.goto(url + path);
  return p;
}
const shot = process.env.SHOTS;
const bur = await page('#/bury');
await bur.fill('#top-amt', '64');
await bur.click('#topup button');
await bur.waitForFunction(() => /\+\d+ sats/.test(document.getElementById('w-msg').textContent), null, { timeout: 40000 });
console.log('top-up:', await bur.textContent('#w-msg'), 'balance', await bur.textContent('#bal'));
const f0 = bur.locator('fieldset').nth(0);
await f0.locator('[name=title]').fill('Under the old oak');
await f0.locator('[name=riddle]').fill('I have a crown but am no king,\nI drop my children every spring… no, every autumn.\nWhat am I?');
await f0.locator('[name=answer]').fill('An Oak Tree');
await f0.locator('[name=hint]').fill('Look up.');
await f0.locator('[name=amount]').fill('21');
await bur.click('#add-stage');
const f1 = bur.locator('fieldset').nth(1);
await f1.locator('[name=title]').fill('Deeper still');
await f1.locator('[name=riddle]').fill('What do squirrels bury and forget?');
await f1.locator('[name=answer]').fill('acorns');
await f1.locator('[name=amount]').fill('10');
await bur.click('#bury-btn');
await bur.waitForFunction(() => /Buried|rror|need/.test(document.getElementById('bury-msg').textContent), null, { timeout: 40000 });
console.log('bury:', await bur.textContent('#bury-msg'), 'balance now', await bur.textContent('#bal'));
const link = await bur.inputValue('#full');
console.log('link length', link.length);
if (shot) await bur.screenshot({ path: shot + '/bury.png', fullPage: true });

const dig = await b.newContext({ viewport: { width: 900, height: 1000 } }).then((c) => c.newPage());
dig.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
dig.on('dialog', (d) => d.accept());
await dig.goto(link);
await dig.waitForSelector('.riddle');
await dig.waitForFunction(() => !/checking/.test(document.getElementById('st').textContent), null, { timeout: 20000 });
console.log('status:', await dig.textContent('#st'));
if (shot) await dig.screenshot({ path: shot + '/dig.png', fullPage: true });
await dig.fill('#answer', 'a maple');
await dig.click('#dig-btn');
await dig.waitForFunction(() => document.getElementById('dig-msg').textContent.length > 0, null, { timeout: 20000 });
console.log('wrong:', await dig.textContent('#dig-msg'));
await dig.fill('#answer', '  oak tree!! ');
await dig.click('#dig-btn');
await dig.waitForSelector('.won h2, .next', { timeout: 30000 }).catch(async (e) => { console.log('FAIL msg:', await dig.textContent('#dig-msg'), logs); throw e; });
console.log('won:', await dig.textContent('.won h2').catch(() => '-'), '| msg:', await dig.textContent('#dig-msg'));
await dig.click('#take');
const tok = await dig.inputValue('#out textarea');
console.log('token out:', tok.slice(0, 12) + '…', tok.length, 'chars');
const other = new Wallet('https://testnut.cashu.space');
await other.loadMint();
const rec = await other.receive(tok);
console.log('another wallet received', rec.reduce((s, p) => s + Number(p.amount.toString()), 0), 'sats from it');
await dig.waitForSelector('.next a', { timeout: 10000 });
console.log('next:', await dig.textContent('.next p'));
if (shot) await dig.screenshot({ path: shot + '/won.png', fullPage: true });
await dig.click('.next a');
await dig.waitForFunction(() => /Deeper/.test(document.querySelector('.scroll h1')?.textContent ?? ''), null, { timeout: 10000 });
await dig.fill('#answer', 'Acorns');
await dig.click('#dig-btn');
await dig.waitForSelector('.won h2', { timeout: 30000 });
console.log('stage 2:', await dig.textContent('.won h2'));

// same link again: already dug
await dig.goto(link);
await dig.waitForFunction(() => !/checking/.test(document.getElementById('st').textContent), null, { timeout: 20000 });
console.log('again:', await dig.textContent('#st'), '|', await dig.textContent('#dig-msg'));
// burier's list
await bur.goto(url + '#/my');
await bur.waitForFunction(() => document.querySelectorAll('.mine-row .st .badge:not(:empty)').length >= 2 && !/checking/.test(document.getElementById('mine').textContent), null, { timeout: 20000 });
console.log('mine:', (await bur.textContent('#mine')).replace(/\s+/g, ' ').trim());
if (shot) await bur.screenshot({ path: shot + '/my.png', fullPage: true });
console.log(logs.length ? logs.join('\n') : 'no page errors');
await b.close();
