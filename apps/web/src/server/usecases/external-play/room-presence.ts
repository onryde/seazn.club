// The match room's opponent-presence answers, rationed (T14 review I8).
//
// Every player polls GET room — every 3 s with no realtime channel, every
// 15 s with one — and the presence pill's answer costs RealtimeKit two calls
// (realtimekit.ts hasLiveVideoPublisher: the active session, then its
// participants). Cloudflare counts RealtimeKit calls toward the account
// token's GLOBAL API limit, 1,200 requests per 5 minutes, and over it EVERY
// API call is refused for the next 5 minutes — seats, meeting creation and
// teardown included (developers.cloudflare.com: fundamentals/api/reference/
// limits; realtime/realtimekit/limits). Unrationed, one 50-board round polled
// flat out would ask ~4,000 calls per 5 minutes per machine.
//
// So, per process:
//   - one answer per key (a meeting and the participant asked about) per
//     PRESENCE_TTL_MS, which is at least the room's slowest poll;
//   - concurrent reads of a key share ONE in-flight call;
//   - a sliding-window budget of PRESENCE_BUDGET.calls per 5 minutes, a hard
//     bound whatever the number of boards, players and reads;
//   - the budget shared out evenly: a key is not re-asked before its fair
//     share of the window comes round, so the first keys to read cannot
//     starve the rest.
// When a key may not ask, an answer younger than PRESENCE_STALE_MS is
// served; an older or absent one is null — "unknown", which renders no pill
// (review I4), never a guess. Every machine keeps its own cache and budget,
// so the fleet's worst case is the budget times the machine ceiling
// (room-presence.test.ts pins it under a quarter of Cloudflare's limit).

export const PRESENCE_TTL_MS = 15_000;
export const PRESENCE_STALE_MS = 60_000;
/** hasLiveVideoPublisher's cost per answer: the active session, then the
 *  participants (one when no session is live — budgeted as two). */
export const PRESENCE_CALLS_PER_ASK = 2;
export const PRESENCE_BUDGET = { calls: 100, windowMs: 5 * 60_000 } as const;

const ASKS_PER_WINDOW = Math.floor(PRESENCE_BUDGET.calls / PRESENCE_CALLS_PER_ASK);
const PRUNE_ABOVE = 512;

type Entry = { value: boolean | null; at: number | null; seen: number };
export type PresenceAsk = () => Promise<boolean | null>;
export type PresenceCache = { get: (key: string, now: number, ask: PresenceAsk) => Promise<boolean | null> };

export function presenceCache(): PresenceCache {
  const entries = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<boolean | null>>();
  // The instants of the asks inside the current window, oldest first.
  const asks: number[] = [];

  /** How long a key waits between asks: the TTL, or longer when the keys
   *  being read between them would spend more than the budget. */
  const fairInterval = (now: number): number => {
    let live = 0;
    for (const e of entries.values()) if (now - e.seen < PRESENCE_STALE_MS) live += 1;
    return Math.max(PRESENCE_TTL_MS, Math.ceil((live * PRESENCE_BUDGET.windowMs) / ASKS_PER_WINDOW));
  };

  const prune = (now: number) => {
    if (entries.size <= PRUNE_ABOVE) return;
    for (const [k, e] of entries) if (now - e.seen >= PRESENCE_STALE_MS && !inFlight.has(k)) entries.delete(k);
  };

  return {
    get(key, now, ask) {
      const e = entries.get(key) ?? { value: null, at: null, seen: now };
      e.seen = now;
      entries.set(key, e);
      const pending = inFlight.get(key);
      if (pending) return pending;
      while (asks.length > 0 && asks[0]! <= now - PRESENCE_BUDGET.windowMs) asks.shift();
      // Never before the TTL (fairInterval's floor); later when the budget
      // is shared between many keys. Until then the held answer serves.
      const due = e.at === null || now - e.at >= fairInterval(now);
      if (!due || asks.length >= ASKS_PER_WINDOW) {
        return Promise.resolve(e.at !== null && now - e.at < PRESENCE_STALE_MS ? e.value : null);
      }
      asks.push(now);
      const p = ask()
        .then((value) => {
          e.value = value;
          e.at = now;
          return value;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, p);
      prune(now);
      return p;
    },
  };
}
