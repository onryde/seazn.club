"use client";
// Spectator surface W1, Task 10 — the live-fixture transport, lifted verbatim
// from `live-score.tsx` (poll every POLL_MS, Supabase Realtime subscribe when
// entitled, 250 ms debounce on a realtime broadcast) so `MatchCentre` and the
// legacy `LiveScore` scoreboard share ONE transport instead of two copies of
// the same wiring. `LiveScore` now delegates here (see `../live-score.tsx`).
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchLiveFixture, fetchPublicRealtimeToken, type LiveFixtureData } from "../live-score-data";

export const POLL_MS = 15_000;

export interface UseLiveFixtureResult {
  data: LiveFixtureData;
  transport: "realtime" | "poll";
}

export function useLiveFixture(
  fixtureId: string,
  initial: LiveFixtureData,
  realtime: boolean,
): UseLiveFixtureResult {
  const [data, setData] = useState<LiveFixtureData>(initial);
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
      const next = await fetchLiveFixture(fixtureId);
      if (!mountedRef.current) return;
      setData(next);
    } catch {
      // transient — keep the last known data (never throw to the UI)
    }
  }, [fixtureId]);

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

  // 15 s polling fallback (Community, or realtime not connected).
  useEffect(() => {
    if (!live || subscribed) return;
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [live, subscribed, refresh]);

  return { data, transport: subscribed ? "realtime" : "poll" };
}
