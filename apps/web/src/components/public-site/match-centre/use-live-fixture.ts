"use client";
// Spectator surface W1, Task 10 — the live-fixture transport, lifted verbatim
// from `live-score.tsx` (poll every POLL_MS, Supabase Realtime subscribe when
// entitled, 250 ms debounce on a realtime broadcast) so `MatchCentre` and the
// legacy `LiveScore` scoreboard share ONE transport instead of two copies of
// the same wiring. `LiveScore` now delegates here (see `../live-score.tsx`).
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchLiveFixture, fetchPublicRealtimeToken, type LiveFixtureData } from "../live-score-data";

export const POLL_MS = 15_000;

/** How often the presentation buffer is drained (review MINOR 2). It is a
 *  FIXED tick, not a per-snapshot timer, so a snapshot received at `t` is
 *  presented at the first tick at or after `t + delayMs` — the cold start is
 *  bounded by `[delayMs, delayMs + DRAIN_MS)`, never "exactly delayMs". */
export const DRAIN_MS = 1000;

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
   *  nothing at all for its first `delayMs`. See `awaitingDelay`.
   *
   *  NO SOONER, not "exactly": the drain is a fixed `DRAIN_MS` tick, so the
   *  wait is in `[delayMs, delayMs + DRAIN_MS)` (review MINOR 2). */
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
  // Seeding through the buffer rather than a separate timer is what keeps that
  // cold start to one delay rather than two: starting it at the first poll
  // would have made it delayMs + POLL_MS (15 s more).
  //
  // IT IS NOT "EXACTLY delayMs" (review MINOR 2, 2026-09-10 — an earlier
  // revision of this comment and of `3e450e7d7`'s message both claimed it
  // was). The drain is a FIXED DRAIN_MS tick, so the seed is presented at the
  // first tick at or after delayMs: the bound is [delayMs, delayMs + DRAIN_MS)
  // and only a delayMs that is a whole multiple of DRAIN_MS hits its own
  // number. `resolveDelayMs` (`lib/overlay-delay.ts`) accepts any whole
  // millisecond value in 0..300 000, so `?delay=250` really does hold for a
  // full second — four times what the operator typed.
  //
  // Left as is rather than rounded or refused: an OBS operator plans scene
  // timing against the number, and quietly rewriting 250 to 1 000 would be a
  // second, invisible discrepancy on top of this one. A sub-second delay is
  // also not a use case anyone has — every real `?delay=` is seconds of
  // broadcast latency. If it ever becomes one, the fix is a shorter DRAIN_MS
  // (the buffer is a list scan, not a cost), not a rounded delayMs.
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
  //
  // Public channel on purpose for this spectator path (2026-09-12): the minted
  // public JWT fails Realtime auth here (`JwtSignatureError` on private
  // subscribe), so private-first left the overlay on the 15 s poll while the
  // division slideshow (public, no JWT) stayed live. Entitlement is still
  // enforced by the token route; the topic is an unguessable fixture UUID.
  // `publishFixtureUpdate` fans out a public twin alongside the private one
  // for scorepad. Fixing `SUPABASE_JWT_SECRET` to match the project is the
  // follow-up that restores private for this surface.
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
      channel = sb
        .channel(token.channel)
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

  // Drain the delay buffer every DRAIN_MS: present the newest snapshot whose
  // receivedAt ≤ now − delayMs, drop everything older. One interval, armed only
  // while delayMs > 0 — the no-option path never creates it.
  useEffect(() => {
    if (delayMs <= 0) {
      // Review MINOR 2026-09-10 (MINOR 1) — AN UNDELAYED PASS COUNTS AS
      // SEEDED. This early return used to sit above the once-guard, so a hook
      // that mounted with no delay and later received a non-zero `delayMs`
      // seeded the MOUNT-TIME document and presented it `delayMs` later,
      // winding the overlay back to the page-load score: exactly the defect
      // the guard below names, through the one transition it did not cover.
      // While `delayMs` was 0 every snapshot — `initial` first — was presented
      // the instant it arrived, so there is nothing left to mature.
      seededRef.current = true;
      return;
    }
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
    }, DRAIN_MS);
    return () => clearInterval(id);
  }, [delayMs]);

  // 15 s polling — primary on Community / when push is not connected; slower
  // safety net once SUBSCRIBED (slideshow pattern). NEVER stop polling entirely
  // while live: a SUBSCRIBED private channel that receives no broadcasts (e.g.
  // public HTTP publish vs private subscribe mismatch, fixed 2026-09-12) would
  // otherwise freeze the overlay on first paint.
  //
  // Refresh ONCE immediately when the effect arms — otherwise the first update
  // waits a full POLL_MS after mount, which on a live demo is most of an over.
  useEffect(() => {
    if (!live) return;
    void refresh();
    const ms = subscribed ? 60_000 : POLL_MS;
    const id = setInterval(refresh, ms);
    return () => clearInterval(id);
  }, [live, subscribed, refresh]);

  return {
    data,
    transport: subscribed ? "realtime" : "poll",
    presentationNowOffsetMs: delayMs,
    awaitingDelay,
  };
}
