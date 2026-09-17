"use client";
// Spectator surface W2, Task 7 — the competition hub's live transport.
// Lifted from W1's `useLiveFixture` (`match-centre/use-live-fixture.ts`) with
// three deliberate differences (dispatch ruling 4):
//
//   - the poll refresh is `fetchCompetitionHub`, not a single-fixture fetch —
//     one tick replaces the WHOLE document, so a card's score and a table
//     row move together;
//   - the interval cadence depends on whether ANY match on the document is
//     live (HUB_POLL_MS vs the slower HUB_IDLE_POLL_MS) and is re-armed
//     whenever that flips. This poll is NEVER switched off entirely: an
//     upcoming match can start between ticks, which a decided single fixture
//     never does. That holds while realtime is up, too (R10 H2). With every
//     channel SUBSCRIBED the poll slows to HUB_IDLE_POLL_MS as a safety net.
//     It used to stop, so a subscribed channel that missed one push froze
//     the page until the spectator reloaded;
//   - realtime subscribes ONE channel PER DIVISION that currently has a live
//     match — `division:{id}`, no token and no `private` flag — exactly
//     `v2/slideshow.tsx:105-140`'s shape, because the hub is multi-division
//     and W1's PRIVATE, TOKENED per-fixture channel cannot cover it.
//     `lib/realtime.ts`'s `publishDivisionUpdate` is the producer:
//     `state_changed` for a scoring write, `schedule_changed` otherwise.
//     Every broadcast carries `at`, the server's clock at publish, and a push
//     is not satisfied by a document built before it (R10 H3, `onPush`).
import { useCallback, useEffect, useRef, useState } from "react";
import type { CompetitionHubDocT } from "@/server/public-site/competition-hub-schema";
import { fetchCompetitionHub } from "./competition-hub-data";

export const HUB_POLL_MS = 15_000;
export const HUB_IDLE_POLL_MS = 60_000;

/** R10 H3: when a push's refetch returns a document built BEFORE the push,
 *  refetch again after 1s, then 3s after that, then 17s after that. Three
 *  retries at most; the safety-net poll (H2) covers anything later.
 *
 *  R10c m2: the last delay outlives the hub's Redis TTL (`HUB_TTL_SECONDS`,
 *  15s, usecases/public.ts) plus a build's worth of margin. A cache-aside
 *  rebuild that read the database before the write, and finished after its
 *  DEL, puts the pre-write document back for that long, and both earlier
 *  retries land inside it. A literal: public.ts is server-only and this is a
 *  client module. `hub-push-retry-ttl.test.ts` pins it above the TTL. */
export const HUB_PUSH_RETRY_MS = [1_000, 3_000, 17_000] as const;

/** The hub document's Redis TTL, `HUB_TTL_SECONDS` in usecases/public.ts, in
 *  ms. A literal for the reason HUB_PUSH_RETRY_MS is one: public.ts is
 *  server-only and this is a client module. `hub-push-retry-ttl.test.ts` pins
 *  the two equal. */
export const HUB_TTL_MS = 15_000;

/** A document build's worth of time on top of HUB_TTL_MS: a cache-aside write
 *  lands after the read it was built from. The same 2s the last push retry
 *  carries over the TTL (17s). */
export const HUB_BUILD_MARGIN_MS = 2_000;

/** Rapid pushes collapse into one refetch. */
const PUSH_DEBOUNCE_MS = 250;

/** T17: how long a division whose last live match has just ENDED still counts
 *  as live to the transport: its realtime channel stays subscribed and, without
 *  realtime, the poll keeps HUB_POLL_MS.
 *
 *  Measured on a local prod build: the refetch for the ball BEFORE the deciding
 *  one can land after the deciding ball commits and before its standings are
 *  rewritten. That document shows the match finished with the old table. Keyed
 *  on the live set alone, the page then left `division:{id}` 16ms before the
 *  deciding push was published, and the poll had already slowed to
 *  HUB_IDLE_POLL_MS, so the table stayed a result behind for a minute. The
 *  deciding push goes out after the standings and the DEL
 *  (`invalidateAndPush`, usecases/scoring.ts), so a channel still open when it
 *  arrives gets the right table through the ordinary push sequence.
 *
 *  The longer of two needs:
 *   - realtime: one whole push sequence, the debounce and every retry;
 *   - poll only: no push is coming, so a live-cadence TICK has to land after
 *     any Redis copy of the ending document can have expired. That copy was
 *     written no later than a build after the tick that fetched it and lives
 *     HUB_TTL_MS, so the first tick past HUB_TTL_MS + HUB_BUILD_MARGIN_MS must
 *     still be at HUB_POLL_MS, with a margin before the cadence slows. */
const POLL_TICKS_PAST_TTL = Math.floor((HUB_TTL_MS + HUB_BUILD_MARGIN_MS) / HUB_POLL_MS) + 1;
export const HUB_LIVE_LINGER_MS = Math.max(
  PUSH_DEBOUNCE_MS + HUB_PUSH_RETRY_MS.reduce((sum: number, ms) => sum + ms, 0),
  POLL_TICKS_PAST_TTL * HUB_POLL_MS + HUB_BUILD_MARGIN_MS,
);

/** The divisions with a live match on `doc`. */
function liveDivisionIds(doc: CompetitionHubDocT): Set<string> {
  return new Set(doc.matches.filter((m) => m.bucket === "live").map((m) => m.divisionId));
}

/**
 * The server instant a division broadcast was published, read from the message
 * supabase-js hands an `on("broadcast")` callback: `{ type, event, payload }`,
 * where `payload` is what `publishDivisionUpdate` sent, including an ISO `at`.
 * Null when `at` is absent, not a string, or unparseable. That push gets the
 * single refetch every push used to get.
 */
function publishedAt(message: unknown): number | null {
  const at = (message as { payload?: { at?: unknown } } | null | undefined)?.payload?.at;
  if (typeof at !== "string") return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

// NO `updatedAt` here, matching W1's own ruling in
// `match-centre/use-live-fixture.ts:23-28`: the freshness line derives from
// the DOCUMENT's own timestamp (`doc.generatedAt`, and each table's own
// `updatedAt`), never from a hook-side clock. This hook shipped a
// `useState(() => Date.now())` re-stamped on every successful poll, which
// reports the FETCH as freshness — a hub whose scores had not moved for an
// hour would have read "Updated 0s ago" — and, being seeded from `Date.now()`
// during SSR and again on the client, hydration-mismatched for any consumer
// that rendered it. Nothing consumed it yet, so it is gone rather than
// repaired; a consumer that needs freshness reads `doc.generatedAt`.
export interface UseLiveCompetitionResult {
  doc: CompetitionHubDocT;
  transport: "realtime" | "poll";
}

export function useLiveCompetition({
  orgSlug,
  competitionSlug,
  initial,
  realtime,
}: {
  orgSlug: string;
  competitionSlug: string;
  initial: CompetitionHubDocT;
  realtime: boolean;
}): UseLiveCompetitionResult {
  const [doc, setDoc] = useState<CompetitionHubDocT>(initial);

  // The push sequence in flight (R10 H3): one timer slot, shared by the
  // debounce and a pending retry, so they are cancelled as one thing. Every new
  // push bumps `generation`. A refetch still in flight for an older push then
  // sees the change and schedules nothing for a push that has been superseded.
  const pushRef = useRef<{ generation: number; timer: ReturnType<typeof setTimeout> | null }>({
    generation: 0,
    timer: null,
  });

  // Same guard as `use-live-fixture.ts:32-38` — a poll or debounced refresh
  // in flight when the component unmounts must not call `setState` on its
  // way back (the fetch itself is not cancelled, only its effect on state).
  // Unmount also ends the push sequence: no debounce or retry outlives the hook.
  const mountedRef = useRef(true);
  // T17 (HUB_LIVE_LINGER_MS): the divisions whose last live match ended on a
  // document this hook applied, each with its own timer. A division that ends
  // again inside its linger restarts it.
  const lingerTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [lingering, setLingering] = useState<readonly string[]>([]);
  useEffect(() => {
    mountedRef.current = true;
    const push = pushRef.current;
    const timers = lingerTimers.current;
    return () => {
      mountedRef.current = false;
      push.generation += 1;
      if (push.timer !== null) clearTimeout(push.timer);
      push.timer = null;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const linger = useCallback((ended: readonly string[]) => {
    const timers = lingerTimers.current;
    const settle = () => setLingering([...timers.keys()].sort());
    for (const id of ended) {
      const previous = timers.get(id);
      if (previous !== undefined) clearTimeout(previous);
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          if (mountedRef.current) settle();
        }, HUB_LIVE_LINGER_MS),
      );
    }
    settle();
  }, []);

  // R10 C1: the document the page holds, read synchronously. Refetches overlap
  // (the poll, a push's refetch, its H3 retries), and a response built before
  // the one already applied must not put older scores back. A ref, not `doc`:
  // a refetch's closure would read the `doc` of the render that started it.
  const heldRef = useRef<CompetitionHubDocT>(initial);

  // Hands back the document the page holds once this response is dealt with:
  // the response itself, or the newer document that was kept instead of it.
  // A push compares that with the broadcast's `at`. Null when the fetch failed
  // or the hook has unmounted.
  const refresh = useCallback(async (): Promise<CompetitionHubDocT | null> => {
    try {
      const next = await fetchCompetitionHub(orgSlug, competitionSlug);
      if (!mountedRef.current) return null;
      // R10 C1: drop a document built BEFORE the one held. Built at the same
      // instant is applied. An unparseable `generatedAt` cannot prove it older,
      // so it is applied too (the same reading H3 gives it).
      const held = heldRef.current;
      if (Date.parse(next.generatedAt) < Date.parse(held.generatedAt)) return held;
      heldRef.current = next;
      const stillLive = liveDivisionIds(next);
      // Only a division seen live on a document this page held can linger. A
      // page whose FIRST document already shows it ended gets none: the hub
      // doc carries no finish time to measure from. Owner accepted (ruling A,
      // 2026-09-17).
      const ended = [...liveDivisionIds(held)].filter((id) => !stillLive.has(id));
      if (ended.length > 0) linger(ended);
      setDoc(next);
      return next;
    } catch {
      // transient — keep the last known document (never throw to the UI)
      return null;
    }
  }, [orgSlug, competitionSlug, linger]);

  // R10 H3: a push is not satisfied by an OLDER document. Measured on
  // spectw2: the push arrived, its one refetch came back with a `generatedAt`
  // from before the write, and nothing moved. `no-store` (H1) removes the
  // browser's copy. A Redis or CDN copy that outlives the write is an ordering
  // no local test can produce, so the answer is checked here. A newer push
  // restarts the sequence.
  const onPush = useCallback(
    (message?: unknown) => {
      const push = pushRef.current;
      push.generation += 1;
      if (push.timer !== null) clearTimeout(push.timer);
      const generation = push.generation;
      const at = publishedAt(message);

      const attempt = async (retry: number): Promise<void> => {
        push.timer = null;
        const next = await refresh();
        if (push.generation !== generation) return;
        // Answered when there is no instant to compare with, when nothing came
        // back (the poll covers a failed fetch), or when the document is as new
        // as the push. An unreadable `generatedAt` cannot prove it older.
        if (at === null || next === null) return;
        if (!(Date.parse(next.generatedAt) < at)) return;
        const delay = HUB_PUSH_RETRY_MS[retry];
        if (delay === undefined) return;
        push.timer = setTimeout(() => void attempt(retry + 1), delay);
      };

      push.timer = setTimeout(() => void attempt(0), PUSH_DEBOUNCE_MS);
    },
    [refresh],
  );

  // A lingering division (T17) counts as live for both transports.
  const hasLive = doc.matches.some((m) => m.bucket === "live") || lingering.length > 0;
  // A stable STRING key, not the array itself — `doc.matches` gets a fresh
  // identity on every poll tick even when the live set is unchanged, and
  // keying the realtime effect on the array would tear the channels down
  // and resubscribe them every tick (the same reasoning `slideshow.tsx`'s
  // own `divisionKey` documents).
  const liveDivisionKey = Array.from(new Set([...liveDivisionIds(doc), ...lingering]))
    .sort()
    .join(",");

  // Realtime push: any failure (env missing, websocket refused) leaves
  // `subscribed` false and polling takes over.
  //
  // ONE channel PER DIVISION, held across renders and DIFFED when the live
  // set changes (T17 review m3): a division that stays in the set keeps its
  // channel, a new one is subscribed, and only a division that has left the
  // set (after its linger) is let go. Keying one effect run's channel list on
  // the whole set tore every channel down and rejoined it on any change, and a
  // push published in that leave/join gap reached nobody — the T17 race by
  // another route, for a division that ends in the same document another
  // starts.
  //
  // PER-CHANNEL state, never one shared boolean. Every channel used to write
  // the same `subscribed` flag and the last writer won, so on a hub with live
  // matches in two divisions the hook reported whatever the final callback
  // happened to say. `division:d1` reporting SUBSCRIBED after `division:d2`
  // reported CHANNEL_ERROR left `subscribed` true, which slowed the poll to the
  // safety net while d2 had no channel pushing to it. Supabase re-invokes the
  // status callback on a later CHANNEL_ERROR / TIMED_OUT / CLOSED, so one
  // channel dropping mid-match flips the whole hook. Realtime is claimed only
  // when EVERY wanted channel is up; anything less falls back to polling.
  const [subscribed, setSubscribed] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channelsRef = useRef(new Map<string, { channel: any; up: boolean }>());
  const wantedRef = useRef<readonly string[]>([]);
  // A let-go division's leave round trip, until it completes.
  const leavingRef = useRef(new Map<string, Promise<unknown>>());
  // The channels outlive the render that subscribed them, so their handler
  // reads the current `onPush` rather than the one they were created with.
  const onPushRef = useRef(onPush);
  useEffect(() => {
    onPushRef.current = onPush;
  }, [onPush]);

  const report = useCallback(() => {
    if (!mountedRef.current) return;
    const channels = channelsRef.current;
    const wanted = wantedRef.current;
    setSubscribed(wanted.length > 0 && wanted.every((id) => channels.get(id)?.up === true));
  }, []);

  useEffect(() => {
    const ids = realtime && process.env.NEXT_PUBLIC_SUPABASE_URL && liveDivisionKey ? liveDivisionKey.split(",") : [];
    wantedRef.current = ids;
    const channels = channelsRef.current;
    const leaving = leavingRef.current;
    for (const [id, entry] of channels) {
      if (ids.includes(id)) continue;
      channels.delete(id);
      // An earlier leave of this topic may still be in flight; wait on both.
      const left = Promise.all([leaving.get(id), entry.channel?.unsubscribe?.()]).catch(() => undefined);
      leaving.set(id, left);
      void left.then(() => {
        if (leaving.get(id) === left) leaving.delete(id);
      });
    }
    report();
    if (!ids.some((id) => !channels.has(id))) return;
    let cancelled = false;

    (async () => {
      try {
        const { supabaseBrowser } = await import("@/lib/supabase-browser");
        // A later run owns the set now; it subscribes whatever it still wants.
        if (cancelled) return;
        const sb = supabaseBrowser();
        const handler = (message?: unknown) => onPushRef.current(message);
        for (const id of ids) {
          if (channels.has(id)) continue;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const entry: { channel: any; up: boolean } = { channel: null, up: false };
          channels.set(id, entry);
          const join = () => {
            // Let go again (or unmounted) while its old channel was leaving.
            if (channels.get(id) !== entry) return;
            entry.channel = sb
              .channel(`division:${id}`)
              .on("broadcast", { event: "state_changed" }, handler)
              .on("broadcast", { event: "schedule_changed" }, handler)
              .subscribe((status: string) => {
                // A channel already let go writes an entry nothing reads any more.
                entry.up = status === "SUBSCRIBED";
                report();
              });
          };
          // T17 review n4: until a leave completes, realtime-js hands back the
          // same-topic LEAVING channel, whose subscribe() does nothing — the
          // division would silently poll. A leave that fails (`error`) still
          // does, which is the fallback.
          const left = leaving.get(id);
          if (left) void left.then(join);
          else join();
        }
        report();
      } catch {
        // env missing / websocket refused → polling
      }
    })();

    // The push sequence is NOT cancelled here. A refetch that changes the live
    // division set re-runs this effect, and the retry for the push that caused
    // it must still run. Unmount ends the sequence (above).
    return () => {
      cancelled = true;
    };
  }, [realtime, liveDivisionKey, report]);

  // Unmount lets every channel go.
  useEffect(() => {
    const channels = channelsRef.current;
    return () => {
      for (const entry of channels.values()) void entry.channel?.unsubscribe?.();
      channels.clear();
    };
  }, []);

  // Whole-document polling. Never switched off (see the header note). With
  // every channel up it slows to HUB_IDLE_POLL_MS rather than stopping (R10
  // H2). Without realtime the cadence is unchanged: HUB_POLL_MS while anything
  // is live, HUB_IDLE_POLL_MS otherwise.
  useEffect(() => {
    const delay = subscribed || !hasLive ? HUB_IDLE_POLL_MS : HUB_POLL_MS;
    const id = setInterval(refresh, delay);
    return () => clearInterval(id);
  }, [hasLive, subscribed, refresh]);

  return { doc, transport: subscribed ? "realtime" : "poll" };
}
