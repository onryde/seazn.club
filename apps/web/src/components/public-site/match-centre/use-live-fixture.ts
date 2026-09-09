"use client";
// Spectator surface W1, Task 10 — the live-fixture transport, lifted verbatim
// from `live-score.tsx` (poll every POLL_MS, Supabase Realtime subscribe when
// entitled, 250 ms debounce on a realtime broadcast) so `MatchCentre` and the
// legacy `LiveScore` scoreboard share ONE transport instead of two copies of
// the same wiring. `LiveScore` now delegates here (see `../live-score.tsx`).
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchLiveFixture, fetchPublicRealtimeToken, type LiveFixtureData } from "../live-score-data";

export const POLL_MS = 15_000;

/** Stream overlay W1 (design §3.3): the ONE transport now serves two payloads
 *  — the public fixture JSON (`MatchCentre`, the default) and the overlay
 *  endpoint (`OverlayStage`, via `fetcher`). `delayMs` is R2's presentation
 *  buffer, built here so the seam is real from W1; with it absent the hook is
 *  byte-identical to the spectator-W1 version.
 *
 *  `fetcher` must be STABLE across renders (a module-level function such as
 *  `fetchOverlayFixture`, or a `useCallback`). It is a dependency of `refresh`,
 *  which is a dependency of the poll effect — an inline arrow would re-arm the
 *  interval every render and the poll would never fire. */
export interface UseLiveFixtureOptions<T extends LiveFixtureData> {
  fetcher?: (fixtureId: string) => Promise<T>;
  /** Present snapshots no sooner than `delayMs` after they were received. */
  delayMs?: number;
}

export interface UseLiveFixtureResult<T extends LiveFixtureData = LiveFixtureData> {
  data: T;
  transport: "realtime" | "poll";
  /** How far behind wall time the PRESENTED snapshot is (= `delayMs`, 0 by
   *  default). The overlay clock subtracts it (design §3.6); nothing else
   *  reads it. A FIELD here, never a module export — one authority per hook
   *  instance (design FS17). */
  presentationNowOffsetMs: number;
}

export function useLiveFixture<T extends LiveFixtureData = LiveFixtureData>(
  fixtureId: string,
  initial: T,
  realtime: boolean,
  options: UseLiveFixtureOptions<T> = {},
): UseLiveFixtureResult<T> {
  const fetcher = options.fetcher ?? (fetchLiveFixture as (id: string) => Promise<T>);
  const delayMs = options.delayMs ?? 0;
  const [data, setData] = useState<T>(initial);
  // The delay buffer: snapshots RECEIVED, waiting to be PRESENTED. Empty and
  // unused when delayMs is 0.
  const bufferRef = useRef<{ receivedAt: number; snapshot: T }[]>([]);
  // NO `updatedAt` state here. The freshness line ("Updated 5s ago") derives
  // from `header.updatedAt` — the DOCUMENT's own timestamp, ticked every
  // second by `useNow()` in `court-card.tsx` — never from when this hook last
  // succeeded. A hook-side clock would have said "Updated 0s ago" after a poll
  // that returned an unchanged document, i.e. reported the FETCH as freshness
  // rather than the DATA.

  // Review fix round 1 (MINOR 10) — a poll/debounced refresh in flight when
  // the component unmounts must not call `setState` on its way back; the
  // fetch itself is not cancelled (no AbortController plumbed through
  // `fetchLiveFixture`), only its EFFECT on state.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await fetcher(fixtureId);
      if (!mountedRef.current) return;
      if (delayMs <= 0) {
        setData(next);
        return;
      }
      bufferRef.current.push({ receivedAt: Date.now(), snapshot: next });
    } catch {
      // transient — keep the last known data (never throw to the UI)
    }
  }, [fixtureId, fetcher, delayMs]);

  const live = data.status === "in_play" || data.status === "scheduled";

  // Realtime push (Pro orgs). Any failure — no entitlement (403), env missing,
  // websocket refused — leaves `subscribed` false and polling takes over.
  const [subscribed, setSubscribed] = useState(false);
  useEffect(() => {
    if (!realtime || !live) return;
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return;
    let cancelled = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let channel: any = null;

    (async () => {
      let token: { token: string; channel: string };
      try {
        token = await fetchPublicRealtimeToken(fixtureId);
      } catch {
        return; // not entitled or server error → polling
      }
      if (cancelled) return;
      const { supabaseBrowser } = await import("@/lib/supabase-browser");
      const sb = supabaseBrowser();
      await sb.realtime.setAuth(token.token);
      channel = sb
        .channel(token.channel, { config: { private: true } })
        .on("broadcast", { event: "state_changed" }, () => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(refresh, 250);
        })
        .subscribe((status: string) => {
          if (!cancelled) setSubscribed(status === "SUBSCRIBED");
        });
    })();

    return () => {
      cancelled = true;
      if (debounce) clearTimeout(debounce);
      channel?.unsubscribe();
      setSubscribed(false);
    };
  }, [fixtureId, realtime, live, refresh]);

  // Drain the delay buffer once per second: present the newest snapshot whose
  // receivedAt ≤ now − delayMs, drop everything older. One interval, armed only
  // while delayMs > 0 — the no-option path never creates it.
  useEffect(() => {
    if (delayMs <= 0) return;
    const id = setInterval(() => {
      const due = Date.now() - delayMs;
      const buf = bufferRef.current;
      let idx = -1;
      for (let i = 0; i < buf.length; i++) if (buf[i]!.receivedAt <= due) idx = i;
      if (idx >= 0 && mountedRef.current) {
        setData(buf[idx]!.snapshot);
        bufferRef.current = buf.slice(idx + 1);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [delayMs]);

  // 15 s polling fallback (Community, or realtime not connected).
  useEffect(() => {
    if (!live || subscribed) return;
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [live, subscribed, refresh]);

  return { data, transport: subscribed ? "realtime" : "poll", presentationNowOffsetMs: delayMs };
}
