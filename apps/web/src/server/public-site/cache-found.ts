import "server-only";
// Public pages never cache a NOT-FOUND (owner ruling 2026-10-14).
//
// A public read that finds nothing must not store that answer: the thing it
// looked for may exist a second later (stg, 2026-10-14: a division created a
// moment ago 404'd, and the 404 was cached). `cachedIfFound` caches a FOUND
// answer exactly as `unstable_cache` always has — same key parts, same tags,
// same revalidate — and stores nothing for a miss, so the next read asks
// Postgres again.
//
// Two halves, because Next's `unstable_cache` has two ways to run the loader:
//
//   1. A MISS (no entry, or one whose tags expired) runs the loader and stores
//      what it returns. The loader THROWS a private sentinel when it finds
//      nothing, so there is nothing to store; the sentinel is caught here and
//      read as `null`. Any other error passes through, uncached, as before.
//
//   2. A STALE entry (older than `revalidate`, or a tag fired 'max') is served
//      while the loader refreshes it. If that refresh throws, Next SWALLOWS the
//      error and keeps the stale entry (unstable-cache.js: "Return the stale
//      value on error") — in an ISR render, which awaits the refresh, it hands
//      the stale value straight back. A thrown sentinel alone would therefore
//      keep serving a page that is gone (a deleted fixture: its division tag
//      fires 'max') for as long as the entry lives. So a miss is also recorded
//      in `missed`, and a cached value for a key in it is confirmed against
//      Postgres before it is served.
//
// `missed` is per process, as Next's data cache is per machine. It holds keys,
// never values, and is bounded: an evicted key costs at most the one stale
// serve Next's stale-while-revalidate would have made anyway.
import { unstable_cache } from "next/cache";

/** Thrown inside the cached loader when it finds nothing, so nothing is stored. Never escapes this module. */
class NothingFoundNotCached extends Error {
  constructor() {
    super("public read found nothing; deliberately not cached");
    this.name = "NothingFoundNotCached";
  }
}

/** Keys whose latest load found nothing while a stale found entry may still sit in the cache. */
const missed = new Set<string>();
/** Bound on `missed`; oldest key out first. */
export const MISSED_KEYS_CAP = 10_000;

function markMissed(key: string): void {
  missed.delete(key);
  missed.add(key);
  if (missed.size > MISSED_KEYS_CAP) {
    const oldest = missed.values().next().value;
    if (oldest !== undefined) missed.delete(oldest);
  }
}

/**
 * `unstable_cache(load, keyParts, options)()` for a read whose `null` means
 * NOT FOUND: a found value is cached as before, a `null` is never stored.
 * `load` must return `null` for not-found and nothing else for it.
 */
export async function cachedIfFound<T>(
  load: () => Promise<T | null>,
  keyParts: string[],
  options: { tags: string[]; revalidate: number },
): Promise<T | null> {
  const key = JSON.stringify(keyParts);
  let value: T;
  try {
    value = await unstable_cache(
      async () => {
        const found = await load();
        if (found === null) {
          markMissed(key);
          throw new NothingFoundNotCached();
        }
        missed.delete(key);
        return found;
      },
      keyParts,
      options,
    )();
  } catch (error) {
    if (error instanceof NothingFoundNotCached) return null;
    throw error;
  }
  if (!missed.has(key)) return value;
  // A cached value for a key whose last load found nothing: the stale entry a
  // swallowed refresh left behind. Postgres decides.
  const fresh = await load();
  if (fresh === null) return null;
  missed.delete(key);
  return fresh;
}
