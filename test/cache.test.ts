import { describe, expect, it } from 'vitest';
import { MintQuoteState, Wallet, type Proof } from '@cashu/cashu-ts';
import {
  bury,
  checkState,
  claim,
  decodeCache,
  derive,
  encodeCache,
  hashOf,
  newRefundKey,
  normalize,
  parseCache,
  reclaim,
  seal,
  tryAnswer,
  unseal,
  type Cache,
  type Kdf,
} from '../src/core/cache';

const FAST: Kdf = { alg: 'scrypt', N: 2 ** 10, r: 8, p: 1 };
const LIVE = process.env.NUTCACHE_LIVE === '1';
const MINT = 'https://testnut.cashu.space';

describe('answers', () => {
  it('normalizes case, punctuation and spacing', () => {
    expect(normalize('  The Moon!! ')).toBe('moon');
    expect(normalize('the   moon')).toBe('moon');
    expect(normalize('An oak-tree')).toBe('oak tree');
    expect(normalize('a')).toBe('a'); // a lone article is the answer itself
    expect(normalize('Theory')).toBe('theory');
    expect(normalize('Ｓｑｕｉｒｒｅｌ')).toBe('squirrel'); // full-width letters
    expect(normalize('Ёлка')).toBe('ёлка');
    expect(normalize('?!')).toBe('');
  });

  it('derives the same preimage for equivalent answers and a different one for another salt', async () => {
    const a = await derive('The Moon!', '00'.repeat(16), FAST);
    const b = await derive('the moon', '00'.repeat(16), FAST);
    const c = await derive('the moon', '01'.repeat(16), FAST);
    expect(a.preimage).toBe(b.preimage);
    expect(a.preimage).toMatch(/^[0-9a-f]{64}$/);
    expect(c.preimage).not.toBe(a.preimage);
    expect(Buffer.from(a.stageKey).toString('hex')).not.toBe(a.preimage);
    await expect(derive('...', '00'.repeat(16), FAST)).rejects.toThrow(/empty/);
  });

  it('checks an answer against the hash offline', async () => {
    const salt = 'ab'.repeat(16);
    const d = await derive('acorn', salt, FAST);
    const cache = fakeCache({ hash: hashOf(d.preimage), salt, kdf: FAST });
    expect(await tryAnswer(cache, 'Acorn')).not.toBeNull();
    expect(await tryAnswer(cache, 'walnut')).toBeNull();
  });
});

describe('links and stages', () => {
  it('round-trips a cache through the compact link form', async () => {
    const c = fakeCache({});
    const s = await encodeCache(c);
    expect(s.startsWith('nc1')).toBe(true);
    expect(await decodeCache(`https://example.org/nutcache/#/c/${s}`)).toEqual(c);
    await expect(decodeCache('nc1AAAA')).rejects.toThrow();
  });

  it('rejects hostile work factors and junk', () => {
    expect(() => parseCache({ ...fakeCache({}), kdf: { alg: 'scrypt', N: 2 ** 24, r: 8, p: 1 } })).toThrow(/Unsupported/);
    expect(() => parseCache({ v: 1 })).toThrow();
    expect(() => parseCache({ ...fakeCache({}), proofs: [] })).toThrow(/no ecash/);
  });

  it('seals the next stage so only the stage key opens it', async () => {
    const key = (await derive('one', '00'.repeat(16), FAST)).stageKey;
    const other = (await derive('two', '00'.repeat(16), FAST)).stageKey;
    const next = fakeCache({ title: 'Stage 2', stage: 2 });
    const s = await seal(key, next);
    expect(await unseal(key, s)).toEqual(next);
    await expect(unseal(other, s)).rejects.toThrow();
  });
});

describe.skipIf(!LIVE)('live on testnut', () => {
  it('buries, refuses a wrong answer, pays the right one, and shows who solved it', async () => {
    const w = new Wallet(MINT);
    await w.loadMint();
    const funds = await topUp(w, 64);
    const { pk } = newRefundKey();
    const { cache, keep } = await bury(w, funds, { title: 't', riddle: 'What do squirrels bury?', answer: 'Acorns', amount: 21, days: 1, refundPk: pk, kdf: FAST });
    expect(cache.amount).toBeGreaterThanOrEqual(21);
    expect(sum(keep) + cache.amount).toBeLessThanOrEqual(64);
    const link = await encodeCache(cache);
    const got = await decodeCache(link);
    expect((await checkState(w, got)).status).toBe('open');

    const wrong = await derive('walnuts', got.salt, got.kdf);
    await expect(claim(w, got, wrong.preimage)).rejects.toThrow(/does not open/);
    const right = await tryAnswer(got, 'acorns!');
    expect(right).not.toBeNull();
    const won = await claim(new Wallet(MINT), got, right!.preimage);
    expect(sum(won)).toBe(21);
    const st = await checkState(w, got);
    expect(st.status).toBe('claimed');
    expect(st.preimage).toBe(right!.preimage);
    await expect(claim(w, got, right!.preimage)).rejects.toThrow();
  }, 60_000);

  it('gives the sats back to the creator after the locktime, and not before', async () => {
    const w = new Wallet(MINT);
    await w.loadMint();
    const funds = await topUp(w, 16);
    const { sk, pk } = newRefundKey();
    const { cache } = await bury(w, funds, { title: 't', riddle: 'r', answer: 'x', amount: 8, days: 4 / 86400, refundPk: pk, kdf: FAST });
    await expect(reclaim(w, { ...cache, locktime: cache.locktime + 3600 }, sk)).rejects.toThrow(/taken back after/);
    await new Promise((r) => setTimeout(r, 5500));
    const back = await reclaim(w, cache, sk);
    expect(sum(back)).toBe(8);
    expect((await checkState(w, cache)).status).toBe('expired');
  }, 60_000);

  it('a hunt: solving stage 1 unseals stage 2', async () => {
    const w = new Wallet(MINT);
    await w.loadMint();
    let funds = await topUp(w, 32);
    const { pk } = newRefundKey();
    const s2 = await bury(w, funds, { title: 'two', riddle: 'second', answer: 'beta', amount: 4, days: 1, refundPk: pk, stage: 2, kdf: FAST });
    funds = s2.keep;
    const s1 = await bury(w, funds, { title: 'one', riddle: 'first', answer: 'alpha', amount: 4, days: 1, refundPk: pk, stage: 1, nextCache: s2.cache, kdf: FAST });
    const d = await tryAnswer(s1.cache, 'Alpha');
    expect(await unseal(d!.stageKey, s1.cache.next!)).toEqual(s2.cache);
    console.log('hunt link length', (await encodeCache(s1.cache)).length, 'single', (await encodeCache(s2.cache)).length);
  }, 60_000);
});

async function topUp(w: Wallet, amount: number): Promise<Proof[]> {
  const q = await w.createMintQuoteBolt11(amount);
  for (let i = 0; i < 30; i++) {
    const st = await w.checkMintQuoteBolt11(q.quote);
    if (st.state === MintQuoteState.PAID) return w.mintProofsBolt11(amount, st);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('testnut did not pay the top-up');
}

const sum = (ps: Proof[]) => ps.reduce((s, p) => s + Number(p.amount), 0);

function fakeCache(over: Partial<Cache>): Cache {
  return {
    v: 1,
    title: 'Test',
    riddle: 'What has roots nobody sees?',
    mint: MINT,
    amount: 4,
    proofs: [{ id: '00ad268c4d1f5826', amount: 4, secret: '["HTLC",{"nonce":"00","data":"' + 'aa'.repeat(32) + '","tags":[]}]', C: '02' + 'bb'.repeat(32) }],
    hash: 'aa'.repeat(32),
    salt: '00'.repeat(16),
    kdf: FAST,
    locktime: 2_000_000_000,
    refund: '02' + 'cc'.repeat(32),
    created: 1_790_000_000,
    ...over,
  };
}
