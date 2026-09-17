"use client";
// Spectator surface W2, Task 14 — the player page's live transport: ONE poll
// of the player's match lines, modelled on `useLiveCompetition`
// (`use-live-competition.ts`) and sharing its cadence constants rather than
// restating them, so the whole public surface ticks at one rate.
//
// What it keeps from the hub hook, and why:
//   - the interval is HUB_POLL_MS while any line is live and HUB_IDLE_POLL_MS
//     otherwise, re-armed when that flips; never switched off, because a
//     match the player is in can start between ticks;
//   - a response built BEFORE the document held is dropped (R10 C1), compared
//     on the document's own `generatedAt`. Both sides are SERVER instants: the
//     page seeds the cached read's time (`getPublicPlayer`'s `generatedAt`,
//     not its render time) and the endpoint stamps its build time. The
//     viewer's clock is never consulted, so a fast or slow device cannot
//     refuse a fresh document;
//   - a poll in flight at unmount does not set state on its way back.
//
// What it leaves out: realtime. The hub subscribes one channel per live
// division; this page has no realtime flag on its payload and was briefed as
// "one poll per page". A push would need that flag threaded through
// `getPublicPlayer`, which this task does not own. And there is no
// visibility pause — the hub hook has none to reuse, and inventing one here
// would make this page's cadence differ from the hub's.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicPlayerMatchesT } from "@/server/public-site/player-matches-schema";
import { fetchPlayerMatches } from "./player-matches-data";
import { HUB_IDLE_POLL_MS, HUB_POLL_MS } from "./use-live-competition";

export function useLivePlayerMatches({
  orgSlug,
  competitionSlug,
  personId,
  initial,
}: {
  orgSlug: string;
  competitionSlug: string;
  personId: string;
  initial: PublicPlayerMatchesT;
}): PublicPlayerMatchesT {
  const [doc, setDoc] = useState<PublicPlayerMatchesT>(initial);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The document the page holds, read synchronously — a ref, because a
  // refresh's closure would otherwise read the `doc` of the render that
  // started it.
  const heldRef = useRef<PublicPlayerMatchesT>(initial);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchPlayerMatches(orgSlug, competitionSlug, personId);
      if (!mountedRef.current) return;
      // R10 C1: never put older figures back. An unparseable `generatedAt`
      // cannot prove itself older, so it is applied (the hub's reading).
      if (Date.parse(next.generatedAt) < Date.parse(heldRef.current.generatedAt)) return;
      heldRef.current = next;
      setDoc(next);
    } catch {
      // transient — keep the lines already on the page
    }
  }, [orgSlug, competitionSlug, personId]);

  const hasLive = doc.matches.some((m) => m.result === "live");
  useEffect(() => {
    const id = setInterval(refresh, hasLive ? HUB_POLL_MS : HUB_IDLE_POLL_MS);
    return () => clearInterval(id);
  }, [hasLive, refresh]);

  return doc;
}
