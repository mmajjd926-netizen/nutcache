// Records the two halves of the walkthrough video on the test mint (fake Lightning, no real sats):
//   A: the burier tops up, writes a 2-stage hunt and buries it   -> shots/video/bury/*.webm
//   B: a digger opens the link, guesses wrong, digs stage 1, opens stage 2 and digs it  -> shots/video/dig/*.webm
// Usage: node tools/demo-video.mjs [url]   (vite preview on 4174). Then tools/video/walkthrough.sh.
import { chromium } from 'playwright';
import { rmSync, mkdirSync } from 'fs';
const url = process.argv[2] ?? 'http://127.0.0.1:4174/';
const W = 1100, H = 760;
for (const d of ['shots/video/bury', 'shots/video/dig']) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); }
const b = await chromium.launch();
const logs = [];
const t0 = Date.now();
const mark = (s) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(5), s);
async function ctx(dir) {
  const c = await b.newContext({ viewport: { width: W, height: H }, recordVideo: { dir, size: { width: W, height: H } } });
  const p = await c.newPage();
  p.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
  p.on('dialog', (d) => d.accept());
  return [c, p];
}
const wait = (p, ms) => p.waitForTimeout(ms);
const scrollTo = (p, sel) => p.locator(sel).first().scrollIntoViewIfNeeded();

// ---- A: bury
const [ca, a] = await ctx('shots/video/bury');
await a.goto(url + '#/bury');
await a.waitForSelector('#top-amt');
mark('A start');
await wait(a, 1500);
await a.fill('#top-amt', '');
await a.type('#top-amt', '64', { delay: 120 });
await a.click('#topup button');
await a.waitForFunction(() => /\+\d+ sats/.test(document.getElementById('w-msg').textContent), null, { timeout: 40000 });
mark('A topped up');
await wait(a, 1800);
const f0 = a.locator('fieldset').nth(0);
await scrollTo(a, 'fieldset');
await f0.locator('[name=title]').type('Under the old oak', { delay: 35 });
await f0.locator('[name=riddle]').type('I have a crown but am no king;\nmy children fall each autumn\nand the squirrels carry them off.\nWhat am I?', { delay: 18 });
await f0.locator('[name=answer]').type('an oak tree', { delay: 60 });
await f0.locator('[name=hint]').type('Look up.', { delay: 50 });
await f0.locator('[name=amount]').fill('');
await f0.locator('[name=amount]').type('21', { delay: 120 });
mark('A stage 1 written');
await wait(a, 800);
await a.click('#add-stage');
const f1 = a.locator('fieldset').nth(1);
await f1.scrollIntoViewIfNeeded();
await f1.locator('[name=title]').type('Deeper still', { delay: 35 });
await f1.locator('[name=riddle]').type('What do squirrels bury\nand then forget where?', { delay: 18 });
await f1.locator('[name=answer]').type('acorns', { delay: 60 });
await f1.locator('[name=amount]').fill('');
await f1.locator('[name=amount]').type('10', { delay: 120 });
mark('A stage 2 written');
await wait(a, 900);
await scrollTo(a, '#bury-btn');
await a.click('#bury-btn');
await a.waitForFunction(() => /Buried|rror|need/.test(document.getElementById('bury-msg').textContent), null, { timeout: 60000 });
mark('A buried: ' + (await a.textContent('#bury-msg')).slice(0, 80));
const link = await a.inputValue('#full');
await scrollTo(a, '#bury-msg');
await wait(a, 3500);
mark('A end');
await ca.close();

// ---- B: dig
const [cb, d] = await ctx('shots/video/dig');
await d.goto(link);
await d.waitForSelector('.riddle');
await d.waitForFunction(() => !/checking/.test(document.getElementById('st').textContent), null, { timeout: 20000 });
mark('B start: ' + (await d.textContent('#st')));
await wait(d, 2500);
await d.type('#answer', 'a maple', { delay: 90 });
await d.click('#dig-btn');
await d.waitForFunction(() => document.getElementById('dig-msg').textContent.length > 0, null, { timeout: 20000 });
mark('B wrong: ' + (await d.textContent('#dig-msg')));
await wait(d, 2600);
await d.fill('#answer', '');
await d.type('#answer', 'Oak tree!', { delay: 90 });
await d.click('#dig-btn');
await d.waitForSelector('.won h2', { timeout: 40000 });
mark('B won: ' + (await d.textContent('.won h2')));
await wait(d, 2500);
await d.click('#take');
await d.waitForSelector('#out textarea');
await scrollTo(d, '.next a');
mark('B token out, next stage shown');
await wait(d, 3000);
await d.click('.next a');
await d.waitForFunction(() => /Deeper/.test(document.querySelector('.scroll h1')?.textContent ?? ''), null, { timeout: 10000 });
mark('B stage 2 open');
await wait(d, 2200);
await d.type('#answer', 'acorns', { delay: 90 });
await d.click('#dig-btn');
await d.waitForSelector('.won h2', { timeout: 40000 });
mark('B stage 2 won');
await wait(d, 2500);
await d.goto(link);
await d.waitForFunction(() => !/checking/.test(document.getElementById('st').textContent), null, { timeout: 20000 });
mark('B again: ' + (await d.textContent('#st')));
await wait(d, 3000);
mark('B end');
await cb.close();
console.log(logs.length ? logs.join('\n') : 'no page errors');
await b.close();
