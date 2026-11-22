// The public board: caches posted to Nostr as ordinary notes (kind 1), so they also show up in any
// Nostr client under #nutcache. The full cache rides in a tag; the hash of the lock is an indexed
// `x` tag, which makes a short link (…#/x/<hash>) enough to find it again.
import { SimplePool, finalizeEvent, generateSecretKey, verifyEvent, type Event, type EventTemplate } from 'nostr-tools';
import { decodeCache, encodeCache, type Cache } from './cache';

export const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];

export interface Signer {
  signEvent(t: EventTemplate): Promise<Event>;
}

interface Nip07 {
  signEvent?(t: EventTemplate): Promise<Event>;
}

/** A throwaway key: the post says nothing about who buried the nut. */
export const anonymousSigner = (): Signer => {
  const sk = generateSecretKey();
  return { signEvent: async (t) => finalizeEvent(t, sk) };
};

export function extensionSigner(ext: Nip07 | undefined): Signer {
  if (!ext?.signEvent) throw new Error('No Nostr extension (NIP-07) found in this browser.');
  return { signEvent: (t) => ext.signEvent!(t) };
}

let pool: SimplePool | undefined;
const getPool = () => (pool ??= new SimplePool());

export function noteText(cache: Cache, link: string): string {
  const stage = cache.stage ? ` (stage ${cache.stage} of a hunt)` : '';
  return `🥜 ${cache.title}${stage}\n\n${cache.riddle}\n\n${cache.amount} sats are buried behind the answer. Dig: ${link}\n\n#nutcache #cashu`;
}

export async function cacheEvent(cache: Cache, link: string): Promise<EventTemplate> {
  return {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    content: noteText(cache, link),
    tags: [
      ['t', 'nutcache'],
      ['t', 'cashu'],
      ['x', cache.hash],
      ['nutcache', await encodeCache(cache)],
      ['amount', String(cache.amount)],
      ['mint', cache.mint],
    ],
  };
}

/** Publish; resolves with the relays that took it (at least one, or it throws). */
export async function publish(ev: Event, relays = RELAYS, timeoutMs = 8000): Promise<string[]> {
  const results = await Promise.allSettled(
    getPool()
      .publish(relays, ev)
      .map((p, i) => Promise.race([p.then(() => relays[i]), new Promise<string>((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))])),
  );
  const ok = results.filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled').map((r) => r.value);
  if (!ok.length) throw new Error('No relay accepted the note.');
  return ok;
}

export interface Posted {
  event: Event;
  cache: Cache;
}

/** Read caches from notes; drops forgeries (bad signature, a tag that does not match the cache). */
export async function readPosted(events: Event[]): Promise<Posted[]> {
  const seen = new Set<string>();
  const out: Posted[] = [];
  for (const ev of events.sort((a, b) => b.created_at - a.created_at)) {
    const tag = ev.tags.find((t) => t[0] === 'nutcache')?.[1];
    const x = ev.tags.find((t) => t[0] === 'x')?.[1];
    if (!tag || !x || seen.has(x)) continue;
    try {
      if (!verifyEvent(ev)) continue;
      const cache = await decodeCache(tag);
      if (cache.hash !== x) continue;
      seen.add(x);
      out.push({ event: ev, cache });
    } catch {
      /* not a cache we can read */
    }
  }
  return out;
}

export async function fetchBoard(relays = RELAYS, limit = 100): Promise<Posted[]> {
  const evs = await getPool().querySync(relays, { kinds: [1], '#t': ['nutcache'], limit }, { maxWait: 6000 });
  return readPosted(evs);
}

export async function fetchByHash(hash: string, relays = RELAYS): Promise<Posted | undefined> {
  const evs = await getPool().querySync(relays, { kinds: [1], '#x': [hash.toLowerCase()], '#t': ['nutcache'] }, { maxWait: 6000 });
  return (await readPosted(evs))[0];
}
