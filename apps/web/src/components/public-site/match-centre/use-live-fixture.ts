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
 *  `fetcher` does NOT have to be referentially stable: it is held in a ref and
 *  re-pointed every render, so `refresh` keeps one identity for the life of the
 *  hook. It used to be a `useCallback` dependency of `refresh`, which is itself
 *  a dependency of the poll effect — a caller minting an inline arrow therefore
 *  cleared and re-armed the POLL_MS interval on EVERY render, and a component
 *  that re-renders faster than POLL_MS would never poll at all. Silent, and
 *  invisible to a props-stable test harness. */
export interface UseLiveFixtureOptions<T extends LiveFixtureData> {
  fetcher?: (fixtureId: string) => Promise<T>;
  /** Present snapshots no sooner than `delayMs` after they were received —
   *  `initial` included (I1, 2026-09-10), which is why a delayed hook presents
   *  nothing at all for its first `delayMs`. See `awaitingDelay`. */
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
  /**
   * True while a DELAYED hook has not yet presented anything — i.e. `initial`
   * was received less than `delayMs` ago and no buffered snapshot is due.
   * Always `false` when `delayMs` is 0 or absent, so a three-argument caller
   * never sees it turn true and needs no branch for it.
   *
   * **A delayed consumer MUST gate its render on this.** While it is true,
   * `data` is still the un-presented seed: non-null so the type stays
   * `T` for every existing caller, but not a snapshot this hook is willing to
   * vouch for as "how things were `delayMs` ago". Painting it anyway is
   * exactly the I1 defect (below).
   */
  awaitingDelay: boolean;
}

export function useLiveFixture<T extends LiveFixtureData = LiveFixtureData>(
  fixtureId: string,
  initial: T,
  realtime: boolean,
  options: UseLiveFixtureOptions<T> = {},
): UseLiveFixtureResult<T> {
  const fetcher = options.fetcher ?? (fetchLiveFixture as (id: string) => Promise<T>);
  // Held in a ref so `refresh` — and therefore the poll effect that depends on
  // it — keeps ONE identity however often the caller re-mints its fetcher.
  //
  // Re-pointed in an effect, not in the render body: a render-phase ref write
  // is exactly what `react-hooks/refs` refuses (it is unsound under concurrent
  // rendering), and it buys nothing here. `useRef`'s initial value already
  // covers the first render, and an effect commits immediately after its
  // render — so the only window in which a poll would see the PREVIOUS
  // render's fetcher is between a re-render and its own commit, which a
  // POLL_MS tick would have to land inside.
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });
  const delayMs = options.delayMs ?? 0;
  const [data, setData] = useState<T>(initial);
  // The delay buffer: snapshots RECEIVED, waiting to be PRESENTED. Empty and
  // unused when delayMs is 0.
  const bufferRef = useRef<{ receivedAt: number; snapshot: T }[]>([]);
  // `initial` as of mount. A ref, so the seeding effect below reads the
  // mount-time document without listing a prop object in its dependencies —
  // this hook has always seeded ONCE and a changed `initial` has always needed
  // a `key` change (fixture-stream-panel.tsx does exactly that).
  const initialRef = useRef(initial);
  // I1 (review-unreviewed-range.md, 2026-09-10). `initial` used to be
  // presented at once even under a delay, because only POLLED snapshots went
  // through the buffer. `?delay=30000` therefore delayed the CLOCK and not the
  // SCORE for the first delayMs after every load, and OBS reloads a browser
  // source on every scene change — so a delayed overlay announced a goal up to
  // 30 s before the picture reached it, which is the one thing the parameter
  // exists to prevent.
  //
  // `initial` is now the buffer's FIRST entry, received at mount and matured
  // by the same drain as every polled one. One rule, no exceptions: with
  // `?delay=N`, nothing is presented that was not in hand N ms ago. The trade
  // is a cold start — a delayed overlay presents nothing for its first
  // delayMs, and its consumer must render nothing meanwhile (`awaitingDelay`).
  // That is deliberate and it is the smaller harm: a scorebug that is missing
  // reads as "graphics not up yet", a scorebug that is EARLY is a broadcast
  // failure. It is also paid only by an operator who explicitly typed
  // `?delay=`; without it this hook is byte-identical to the pre-fix version.
  //
  // Seeding through the buffer rather than a separate timer is what bounds
  // that cold start at exactly delayMs. Starting it at the first poll instead
  // would have made it delayMs + POLL_MS.
  const seededRef = useRef(false);
  const [awaitingDelay, setAwaitingDelay] = useState(delayMs > 0);
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
      const next = await fetcherRef.current(fixtureId);
      if (!mountedRef.current) return;
      if (delayMs <= 0) {
        setData(next);
        return;
      }
      bufferRef.current.push({ receivedAt: Date.now(), snapshot: next });
    } catch {
      // transient — keep the last known data (never throw to the UI)
    }
  }, [fixtureId, delayMs]);

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
    // I1: `initial` is the first thing in the buffer, received at mount. Once
    // only — a `delayMs` that changed mid-life would otherwise re-seed a
    // document that is by then long stale.
    if (!seededRef.current) {
      seededRef.current = true;
      bufferRef.current = [{ receivedAt: Date.now(), snapshot: initialRef.current }, ...bufferRef.current];
    }
    const id = setInterval(() => {
      const due = Date.now() - delayMs;
      const buf = bufferRef.current;
      let idx = -1;
      for (let i = 0; i < buf.length; i++) if (buf[i]!.receivedAt <= due) idx = i;
      if (idx >= 0 && mountedRef.current) {
        setData(buf[idx]!.snapshot);
        bufferRef.current = buf.slice(idx + 1);
        setAwaitingDelay(false);
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

  return {
    data,
    transport: subscribed ? "realtime" : "poll",
    presentationNowOffsetMs: delayMs,
    awaitingDelay,
  };
}
