// A nutcache: ecash locked (NUT-14 HTLC) to sha256(preimage), where the preimage is derived from the
// answer to a riddle. Whoever knows the answer can swap the proofs at the mint; nobody else can.
// After the locktime the creator takes the sats back with the refund key.
//
// Answer -> scrypt(normalize(answer), salt) -> 64 bytes:
//   bytes  0..31  preimage  (the mint sees it when the cache is claimed, and NUT-07 shows it afterwards)
//   bytes 32..63  stage key (AES-GCM key for the next stage of a hunt; never leaves the solver's browser)
import {
  LockBuilder,
  Wallet,
  createHTLCHash,
  deserializeProofs,
  getEncodedToken,
  signP2PKProofs,
  type Proof,
} from '@cashu/cashu-ts';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { gcm } from '@noble/ciphers/aes.js';
import { schnorr } from '@noble/curves/secp256k1.js';

export interface Kdf {
  alg: 'scrypt';
  N: number;
  r: number;
  p: number;
}

export const DEFAULT_KDF: Kdf = { alg: 'scrypt', N: 2 ** 15, r: 8, p: 1 };

/** Encrypted next stage of a hunt: only someone who solved this stage can read it. */
export interface Sealed {
  iv: string; // base64url, 12 bytes
  ct: string; // base64url
}

export interface Cache {
  v: 1;
  title: string;
  riddle: string;
  hint?: string;
  mint: string;
  amount: number;
  proofs: PlainProof[];
  hash: string; // sha256(preimage), hex
  salt: string; // hex
  kdf: Kdf;
  locktime: number; // unix seconds; after it the refund key can spend
  refund: string; // compressed pubkey of the creator's refund key
  created: number;
  stage?: number; // 1-based position in a hunt
  next?: Sealed; // the next stage, sealed with this stage's key
}

export interface PlainProof {
  id: string;
  amount: number;
  secret: string;
  C: string;
}

export type Status = 'open' | 'claimed' | 'expired' | 'mixed';

/**
 * Answers are compared after this, so "The Moon!", "  moon " and "a moon" open the same cache:
 * case, punctuation, spacing and a leading English article don't count.
 */
export function normalize(answer: string): string {
  const words = answer
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const bare = words.replace(/^(a|an|the) /, '');
  return bare || words;
}

export interface Derived {
  preimage: string; // hex
  stageKey: Uint8Array;
}

export async function derive(answer: string, salt: string, kdf: Kdf = DEFAULT_KDF): Promise<Derived> {
  const norm = normalize(answer);
  if (!norm) throw new Error('The answer is empty.');
  if (kdf.alg !== 'scrypt') throw new Error(`Unknown key derivation ${kdf.alg}.`);
  const out = await scryptAsync(utf8ToBytes(norm), hexToBytes(salt), { N: kdf.N, r: kdf.r, p: kdf.p, dkLen: 64 });
  return { preimage: bytesToHex(out.slice(0, 32)), stageKey: out.slice(32) };
}

export const hashOf = (preimage: string): string => createHTLCHash(preimage).hash;

/** Checks an answer offline. Returns what is needed to claim (and unseal the next stage), or null. */
export async function tryAnswer(cache: Cache, answer: string): Promise<Derived | null> {
  const d = await derive(answer, cache.salt, cache.kdf);
  return hashOf(d.preimage) === cache.hash.toLowerCase() ? d : null;
}

// ---- sealing the next stage of a hunt ----
// The next stage is deflated, then AES-GCM encrypted with this stage's key, and kept as base64url.
export async function seal(key: Uint8Array, cache: Cache): Promise<Sealed> {
  const iv = randomBytes(12);
  const packed = await pipe(utf8ToBytes(JSON.stringify(cache)), new CompressionStream('deflate-raw'));
  return { iv: b64url(iv), ct: b64url(gcm(key, iv).encrypt(packed)) };
}

export async function unseal(key: Uint8Array, s: Sealed): Promise<Cache> {
  const packed = gcm(key, unb64url(s.iv)).decrypt(unb64url(s.ct));
  const raw = await pipe(packed, new DecompressionStream('deflate-raw'));
  return parseCache(JSON.parse(new TextDecoder().decode(raw)));
}

// ---- keys ----
export function newRefundKey(): { sk: string; pk: string } {
  const sk = schnorr.utils.randomSecretKey();
  return { sk: bytesToHex(sk), pk: '02' + bytesToHex(schnorr.getPublicKey(sk)) };
}

export function pubkeyOf(sk: string): string {
  return '02' + bytesToHex(schnorr.getPublicKey(hexToBytes(sk)));
}

// ---- burying ----
export interface BuryInput {
  title: string;
  riddle: string;
  answer: string;
  hint?: string;
  amount: number;
  days: number; // until the creator may take it back
  refundPk: string;
  stage?: number;
  nextCache?: Cache; // the following stage of a hunt, sealed with this stage's answer
  kdf?: Kdf;
}

/**
 * Lock `amount` from `proofs` into a cache. Returns the cache, the change to keep, and the derived
 * secrets (the stage key seals a previous stage of a hunt that points here).
 */
export async function bury(
  wallet: Wallet,
  proofs: Proof[],
  input: BuryInput,
): Promise<{ cache: Cache; keep: Proof[]; derived: Derived }> {
  if (!input.riddle.trim()) throw new Error('Write a riddle.');
  if (!(input.amount > 0)) throw new Error('The amount must be at least 1 sat.');
  const kdf = input.kdf ?? DEFAULT_KDF;
  const salt = bytesToHex(randomBytes(16));
  const derived = await derive(input.answer, salt, kdf);
  const hash = hashOf(derived.preimage);
  const locktime = Math.floor(Date.now() / 1000) + Math.round(input.days * 86400);
  const lock = new LockBuilder().addHashlock(hash).lockUntil(locktime).addRefundPubkey(input.refundPk);
  // includeFees: the solver's swap fee is paid out of the cache, so the full amount reaches them.
  const { keep, send } = await wallet.ops.send(input.amount, proofs).asLocked(lock).includeFees(true).run();
  const cache: Cache = {
    v: 1,
    title: input.title.trim() || 'A nutcache',
    riddle: input.riddle.trim(),
    hint: input.hint?.trim() || undefined,
    mint: wallet.mint.mintUrl.replace(/\/+$/, ''),
    amount: input.amount, // what the solver receives; the locked proofs also carry their swap fee
    proofs: send.map(plain),
    hash,
    salt,
    kdf,
    locktime,
    refund: input.refundPk,
    created: Math.floor(Date.now() / 1000),
    stage: input.stage,
    next: input.nextCache ? await seal(derived.stageKey, input.nextCache) : undefined,
  };
  return { cache, keep, derived };
}

// Only what the mint needs. DLEQ proofs would make the link twice as long; the claimer swaps at the
// mint at once and learns there whether the proofs are good.
const plain = (p: Proof): PlainProof => ({ id: p.id, amount: Number(p.amount.toString()), secret: p.secret, C: p.C });

const ready = new WeakMap<Wallet, Promise<void>>();
/** loadMint once per wallet object (the keysets are needed to recognise the cache's proofs). */
function loaded(w: Wallet): Promise<void> {
  let p = ready.get(w);
  if (!p) ready.set(w, (p = w.loadMint()));
  return p;
}

const sum = (ps: Proof[]) => ps.reduce((s, p) => s + Number(p.amount.toString()), 0);

export const cacheProofs = (c: Cache): Proof[] => deserializeProofs(c.proofs.map((p) => JSON.stringify(p)));

/** The locked proofs as a plain Cashu token, for wallets that can redeem HTLCs themselves. */
export const cacheToken = (c: Cache): string => getEncodedToken({ mint: c.mint, proofs: cacheProofs(c) });

// ---- claiming ----
/** Swap the cache into fresh proofs that only the caller holds. */
export async function claim(wallet: Wallet, cache: Cache, preimage: string): Promise<Proof[]> {
  if (hashOf(preimage) !== cache.hash.toLowerCase()) throw new Error('That preimage does not open this cache.');
  const proofs = cacheProofs(cache).map((p) => ({ ...p, witness: JSON.stringify({ preimage, signatures: [] }) }));
  await loaded(wallet);
  return wallet.ops.receive(proofs).run();
}

/** After the locktime: the creator takes the sats back. */
export async function reclaim(wallet: Wallet, cache: Cache, refundSk: string): Promise<Proof[]> {
  if (Date.now() / 1000 < cache.locktime) throw new Error(`The cache can be taken back after ${new Date(cache.locktime * 1000).toLocaleString()}.`);
  await loaded(wallet);
  const signed = signP2PKProofs(cacheProofs(cache), refundSk);
  try {
    return await wallet.ops.receive(signed).run();
  } catch (e) {
    // cdk mints up to 0.18.x read a witness without "preimage" as P2PK and reject the HTLC refund path
    // ("Secret is not a HTLC secret"; fixed in cdk main by #2641). An empty preimage passes both checks.
    if (!/not a HTLC secret/i.test(String((e as Error).message))) throw e;
    const withEmpty = signed.map((p) => {
      const w = typeof p.witness === 'string' ? JSON.parse(p.witness) : (p.witness ?? {});
      return { ...p, witness: JSON.stringify({ preimage: '', signatures: w.signatures ?? [] }) };
    });
    return wallet.ops.receive(withEmpty).run();
  }
}

// ---- status (NUT-07) ----
export interface CacheState {
  status: Status;
  preimage?: string; // revealed by the claim
}

export async function checkState(wallet: Wallet, cache: Cache): Promise<CacheState> {
  await loaded(wallet);
  const states = await wallet.checkProofsStates(cacheProofs(cache));
  const spent = states.filter((s) => String(s.state).toUpperCase() === 'SPENT');
  if (spent.length === 0) return { status: Date.now() / 1000 >= cache.locktime ? 'expired' : 'open' };
  if (spent.length < states.length) return { status: 'mixed' };
  let preimage: string | undefined;
  for (const s of spent) {
    try {
      const w = JSON.parse(String(s.witness ?? ''));
      if (typeof w.preimage === 'string' && w.preimage.length === 64) preimage = w.preimage;
    } catch {
      /* refund witnesses carry no preimage */
    }
  }
  // A spend with the right preimage was a solve; anything else after the locktime was the creator.
  return { status: preimage && hashOf(preimage) === cache.hash ? 'claimed' : 'expired', preimage };
}

// ---- sharing: the whole cache fits in a link ----
export function parseCache(x: unknown): Cache {
  const c = x as Cache;
  if (!c || c.v !== 1 || typeof c.riddle !== 'string' || typeof c.hash !== 'string' || !/^[0-9a-f]{64}$/i.test(c.hash))
    throw new Error('This is not a nutcache.');
  if (!Array.isArray(c.proofs) || !c.proofs.length) throw new Error('The nutcache holds no ecash.');
  if (typeof c.mint !== 'string' || !/^https?:\/\//.test(c.mint)) throw new Error('The nutcache names no mint.');
  const kdf = c.kdf ?? DEFAULT_KDF;
  // Refuse silly work factors from a hostile link (a phone would hang).
  if (kdf.alg !== 'scrypt' || kdf.N > 2 ** 18 || kdf.r > 16 || kdf.p > 4) throw new Error('Unsupported key derivation settings.');
  return { ...c, kdf };
}

const b64url = (b: Uint8Array) => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** Compact text form of a cache (deflated JSON, base64url), used in links and QR codes. */
export async function encodeCache(c: Cache): Promise<string> {
  return 'nc1' + b64url(await pipe(utf8ToBytes(JSON.stringify(c)), new CompressionStream('deflate-raw')));
}

export async function decodeCache(s: string): Promise<Cache> {
  const t = s.trim().replace(/^.*[#/]c\//, '');
  if (!t.startsWith('nc1')) throw new Error('This is not a nutcache link.');
  const raw = await pipe(unb64url(t.slice(3)), new DecompressionStream('deflate-raw'));
  return parseCache(JSON.parse(new TextDecoder().decode(raw)));
}
