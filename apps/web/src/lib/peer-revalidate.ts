import "server-only";
import { log } from "@/server/logger";

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

/** POST `tags` to every sibling machine, in batches of at most
 *  `PEER_REVALIDATE_MAX_TAGS` (the peer route refuses a longer body whole).
 *  Every batch to every peer is its own request, all in parallel: one failing
 *  — a network error, or a peer refusing it — never stops the others, and a
 *  peer's failures are logged once per broadcast. */
export async function broadcastRevalidate(
  tags: string[],
  mode: "swr" | "expire",
  deps: BroadcastDeps = {},
): Promise<void> {
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
