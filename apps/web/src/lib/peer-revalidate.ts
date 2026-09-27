import "server-only";
import { log } from "@/server/logger";
import { defaultConfig } from "next/dist/server/config-shared";
import { PUSH_AFTER_DELETE_BOUND_MS } from "@/lib/cache";
import { withRedis } from "../../cache-handler/redis-client.mjs";
import { TAGS_HASH, HSET_IF_NEWER, encodeField, writeState } from "../../cache-handler/tag-state.mjs";

// Fan revalidateTag out to sibling Fly machines (spec 2026-07-12 §3 A-step 5).
// Fly's 6PN DNS: `global.<app>.internal` AAAA-resolves to every machine's
// private IPv6. Fail-open by design: a peer that misses a broadcast keeps
// what it has until its cache entries expire — 30s for competition, division
// and fixture pages (REVALIDATE_FAST), 300s for player cards (REVALIDATE_SLOW).
// This module is the transport seam — a Cloud Run move swaps DNS fan-out for
// Redis pub/sub here, nothing else.

/** The most tags one peer POST may carry. The peer route's body schema
 *  (`api/internal/revalidate`) enforces it, and `broadcastRevalidate` splits
 *  a longer list into batches of at most this many — one constant, so the two
 *  cannot drift. */
export const PEER_REVALIDATE_MAX_TAGS = 20;

export interface BroadcastDeps {
  resolveIps?: () => Promise<string[]>;
  fetchFn?: typeof fetch;
}

async function flyPeerIps(appName: string): Promise<string[]> {
  const { resolve6 } = await import("node:dns/promises");
  return resolve6(`global.${appName}.internal`);
}

/** Writes each tag's state to the shared Redis hash the cache handler reads
 *  (spec 2026-09-24 §6.1). Resolves when the write lands or at the push
 *  bound, whichever is first, and never rejects: the realtime push waits on
 *  this so a refresh landing on any machine sees the invalidation. */
export async function publishTagState(
  tags: string[],
  mode: "swr" | "expire",
  now: number = Date.now(),
): Promise<void> {
  if (tags.length === 0) return;
  const durations = mode === "expire" ? { expire: 0 } : { expire: defaultConfig.cacheLife.max.expire };
  const argv = tags.flatMap((tag) => [tag, encodeField(writeState({}, durations, now))]);
  const write = withRedis((r) => r.eval(HSET_IF_NEWER, 1, TAGS_HASH, ...argv), null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, PUSH_AFTER_DELETE_BOUND_MS);
  });
  await Promise.race([write.then(() => undefined), bound]);
  clearTimeout(timer);
}

/** A broadcast in flight. Awaiting it waits for BOTH transports. `published`
 *  settles once the shared tag write alone has landed or its bound passed,
 *  and at once when NEXT_CACHE_REDIS is off. It is what a realtime push waits
 *  on (review I2): with the flag on every machine reads that hash, so the peer
 *  POSTs add nothing a refresh could see. Neither promise rejects. */
export type Broadcast = Promise<void> & { readonly published: Promise<void> };

/** Dual-run (spec 2026-09-24 §9, PR 1): writes the shared tag state AND POSTs
 *  the peers, each on its own flag (NEXT_CACHE_REDIS, PEER_REVALIDATE), side
 *  by side. Resolves once both have settled; its `published` resolves on the
 *  Redis write alone. One write per call: never call `publishTagState` again
 *  for the same broadcast. Never rejects. */
export function broadcastRevalidate(tags: string[], mode: "swr" | "expire", deps: BroadcastDeps = {}): Broadcast {
  const published = publishTagState(tags, mode);
  const delivered = Promise.all([published, fanOutToPeers(tags, mode, deps)]).then(() => undefined);
  return Object.assign(delivered, { published });
}

/** Dual-run transport, deleted in PR 2 once the shared tag hash has soaked.
 *  POST `tags` to every sibling machine, in batches of at most
 *  `PEER_REVALIDATE_MAX_TAGS` (the peer route refuses a longer body whole).
 *  Every batch to every peer is its own request, all in parallel: one failing
 *  — a network error, or a peer refusing it — never stops the others, and a
 *  peer's failures are logged once per broadcast. */
async function fanOutToPeers(tags: string[], mode: "swr" | "expire", deps: BroadcastDeps): Promise<void> {
  const appName = process.env.FLY_APP_NAME;
  const secret = process.env.CRON_SECRET;
  if (process.env.PEER_REVALIDATE !== "1" || !appName || !secret || tags.length === 0) return;
  const batches: string[][] = [];
  for (let i = 0; i < tags.length; i += PEER_REVALIDATE_MAX_TAGS) {
    batches.push(tags.slice(i, i + PEER_REVALIDATE_MAX_TAGS));
  }
  const fetchFn = deps.fetchFn ?? fetch;
  type Failure = { tags: string[] } & ({ status: number } | { err: unknown });
  const send = async (peer: string, batch: string[]): Promise<Failure | null> => {
    try {
      const res = await fetchFn(`http://[${peer}]:3000/api/internal/revalidate`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-cron-secret": secret },
        body: JSON.stringify({ tags: batch, mode }),
        signal: AbortSignal.timeout(2000),
      });
      return res.ok ? null : { tags: batch, status: res.status };
    } catch (err) {
      return { tags: batch, err };
    }
  };
  // One warning per peer per broadcast, however many of its batches failed:
  // an unreachable peer fails them all, and one line says so.
  const toPeer = async (peer: string) => {
    const failures = (await Promise.all(batches.map((batch) => send(peer, batch)))).filter((f) => f !== null);
    if (failures.length === 0) return;
    const [first] = failures;
    log.warn(
      { peer, mode, failedBatches: failures.length, batches: batches.length, ...first },
      "peer revalidate: tags were not applied on a peer (it converges when its cache entries expire)",
    );
  };
  try {
    const ips = await (deps.resolveIps ?? (() => flyPeerIps(appName)))();
    const self = process.env.FLY_PRIVATE_IP;
    await Promise.all(ips.filter((ip) => ip !== self).map(toPeer));
  } catch {
    // fail open — peers converge when their cache entries expire
  }
}
