"use client";
// Live-update transport pair (S10/#419 W8): Supabase realtime where
// entitled, 15s polling fallback otherwise — same entitlement/device-link
// shape as public-site/live-score.tsx (the precedent the S10 brief names) +
// api/v1/public/fixtures/[id]/realtime-token/route.ts (the token door, which
// already implements the device-link bypass this hook exercises, not
// reimplements).
//
// Both transports converge on ONE fetch: the realtime channel carries no
// payload, only a "something changed" broadcast (live-score.tsx's own
// broadcast handler re-fetches rather than trusting the ping's body) — so a
// realtime signal and a polling tick both end up calling the SAME
// `listEventsSince`, just on a different trigger. That is deliberately the
// same shape `ScoringTransport.listEventsSince` already has (transport.ts),
// so a caller passes ITS OWN transport's method straight in rather than this
// file re-implementing a second authed GET.
import { useEffect, useRef, useState } from "react";
import type { LedgerSlotEvent } from "./types";
import { authHeadersFor, readV1Envelope, type PadAuthMode } from "./transport";

const POLL_MS = 15_000;

export interface RealtimeSubscription {
  unsubscribe(): void;
}

/** Minimal shape this hook needs from a realtime connection — narrowed so a
 *  test double never has to construct a real @supabase/supabase-js client
 *  (which throws without NEXT_PUBLIC_SUPABASE_* env vars, unset under
 *  vitest — see `supabaseRealtimeConnector` below for how the real adapter
 *  avoids ever reaching that construction in such an environment). */
export interface RealtimeConnector {
  connect(params: {
    token: string;
    channel: string;
    onSignal: () => void;
    onStatus: (subscribed: boolean) => void;
  }): RealtimeSubscription;
}

/** Real adapter — mirrors components/public-site/live-score.tsx's own
 *  realtime effect exactly: dynamic import (so an environment with no
 *  Supabase env vars never loads the client at all), `setAuth`, a PRIVATE
 *  channel, a broadcast ping that signals "go re-fetch" rather than
 *  carrying data itself. */
export const supabaseRealtimeConnector: RealtimeConnector = {
  connect({ token, channel, onSignal, onStatus }) {
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sbChannel: any = null;
    void (async () => {
      const { supabaseBrowser } = await import("@/lib/supabase-browser");
      const sb = supabaseBrowser();
      await sb.realtime.setAuth(token);
      if (cancelled) return;
      sbChannel = sb
        .channel(channel, { config: { private: true } })
        .on("broadcast", { event: "state_changed" }, onSignal)
        .subscribe((status: string) => onStatus(status === "SUBSCRIBED"));
    })();
    return {
      unsubscribe() {
        cancelled = true;
        sbChannel?.unsubscribe();
      },
    };
  },
};

export type StreamMode = "connecting" | "realtime" | "polling";

export interface UseFixtureStreamParams {
  fixtureId: string;
  auth: PadAuthMode;
  /** Fetch new events after this seq whenever a poll tick or realtime signal
   *  fires. Read fresh on every tick via a ref — update this prop as your
   *  own last-known seq advances; no re-subscribe needed. */
  sinceSeq: number;
  /** Reuse the SAME authed reader a ScoringTransport already exposes
   *  (transport.ts's `listEventsSince`) — pass `transport.listEventsSince`
   *  bound, rather than this hook re-deriving its own fetch/auth-header
   *  logic for a second authed endpoint. */
  listEventsSince: (fixtureId: string, sinceSeq: number) => Promise<LedgerSlotEvent[]>;
  onEvents: (events: LedgerSlotEvent[]) => void;
  pollMs?: number;
  fetchFn?: typeof fetch;
  connector?: RealtimeConnector;
  /** True while some OTHER caller-owned network activity (a write drain) is
   *  in flight — a poll tick due during it is skipped rather than racing it.
   *  Defaults to "never skip". */
  skipPollWhile?: () => boolean;
}

export interface UseFixtureStreamResult {
  mode: StreamMode;
}

export function useFixtureStream(params: UseFixtureStreamParams): UseFixtureStreamResult {
  const { fixtureId, auth, listEventsSince, onEvents, pollMs = POLL_MS, connector = supabaseRealtimeConnector } = params;
  const fetchFn = params.fetchFn ?? fetch;

  const [mode, setMode] = useState<StreamMode>("connecting");

  const sinceRef = useRef(params.sinceSeq);
  useEffect(() => {
    sinceRef.current = params.sinceSeq;
  }, [params.sinceSeq]);

  const onEventsRef = useRef(onEvents);
  useEffect(() => {
    onEventsRef.current = onEvents;
  }, [onEvents]);

  const skipRef = useRef(params.skipPollWhile);
  useEffect(() => {
    skipRef.current = params.skipPollWhile;
  }, [params.skipPollWhile]);

  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Plain closure-scoped bookkeeping (not React state): `attemptRealtime`
    // and its `onStatus` callback share these directly, so a synchronous
    // test double's `onStatus` call is visible to `startPolling()`'s very
    // next line without waiting for a state update + re-render to land —
    // which a React-state read here could never observe in time (`mode`
    // captured at the top of this effect is a snapshot from the PREVIOUS
    // render, not updated by a `setMode` this same effect just issued).
    let realtimeConfirmed = false;
    let subscription: RealtimeSubscription | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;

    async function fetchOnce(): Promise<void> {
      if (skipRef.current?.()) return;
      if (inFlight.current) return; // no self-overlap
      inFlight.current = true;
      try {
        const events = await listEventsSince(fixtureId, sinceRef.current);
        if (!cancelled) onEventsRef.current(events);
      } catch {
        // No user-visible error state — a missed read is corrected by the
        // next tick/signal.
      } finally {
        inFlight.current = false;
      }
    }

    function startPolling(): void {
      if (cancelled || realtimeConfirmed || interval !== null) return;
      setMode("polling");
      interval = setInterval(() => void fetchOnce(), pollMs);
    }

    function stopPolling(): void {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    }

    async function attemptRealtime(): Promise<void> {
      let res: Response;
      try {
        res = await fetchFn(`/api/v1/public/fixtures/${fixtureId}/realtime-token`, {
          headers: authHeadersFor(auth),
        });
      } catch {
        startPolling(); // network failure reaching the token door — quietly.
        return;
      }
      if (cancelled) return;
      let token: { token: string; channel: string };
      try {
        token = await readV1Envelope<{ token: string; channel: string }>(res);
      } catch {
        startPolling(); // 403 (Community plan) or any other failure — quietly.
        return;
      }
      if (cancelled) return;
      subscription = connector.connect({
        token: token.token,
        channel: token.channel,
        onSignal: () => void fetchOnce(),
        onStatus: (subscribed) => {
          if (cancelled) return;
          if (subscribed) {
            realtimeConfirmed = true;
            setMode("realtime");
            stopPolling();
          } else {
            realtimeConfirmed = false;
            startPolling();
          }
        },
      });
      // Safety net: also start polling immediately, in case `onStatus` never
      // fires promptly (a real subscribe is async — startPolling() is a
      // no-op here if `onStatus` already confirmed synchronously, which a
      // test double may do).
      startPolling();
    }

    // Catch-up on subscribe: ONE read, once a transport is chosen (the channel
    // requested, or polling armed), for whatever was written before it was.
    // Neither transport covers that window by itself — a realtime channel only
    // signals FUTURE writes, and the first poll tick is `pollMs` away. And the
    // seed can be older than the page: browser Back/Forward re-uses the
    // router's cached RSC payload, so a console remounts on the ledger it held
    // when the scorer navigated away. The pad used to be rescued from that by
    // its own mount-time report to the chrome, which forced a full re-read;
    // that report greyed Start match under a scorer's tap (v3/pad-host.tsx,
    // `useReportLedgerChanges`), and this read replaces it.
    //
    // On a fresh page it returns nothing new — the cursor is the seed's own
    // count, and a server bootstrap is gapless — and the pad's pipeline treats
    // an empty batch as a no-op, so nothing on screen moves or greys. It is
    // the SAME `fetchOnce` a tick runs, under the same rules: no overlap with
    // a read in flight, and skipped while `skipPollWhile` holds.
    void attemptRealtime().then(() => {
      if (!cancelled) void fetchOnce();
    });

    return () => {
      cancelled = true;
      stopPolling();
      subscription?.unsubscribe();
    };
    // fixtureId/auth/listEventsSince/connector/fetchFn/pollMs are the real
    // identity of "which stream" this is; sinceSeq/onEvents/skipPollWhile
    // are read via the refs above precisely so THEY don't force a
    // resubscribe (a new token + a fresh realtime handshake) on every
    // render — and because they're read only via refs, exhaustive-deps has
    // nothing to flag here, no suppression needed.
  }, [fixtureId, auth, listEventsSince, connector, fetchFn, pollMs]);

  return { mode };
}
