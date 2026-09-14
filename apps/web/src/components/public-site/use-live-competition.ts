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
 *  refetch again after 1s, then again 3s after that. Two retries at most; the
 *  safety-net poll (H2) covers anything later. */
export const HUB_PUSH_RETRY_MS = [1_000, 3_000] as const;

/** Rapid pushes collapse into one refetch. */
const PUSH_DEBOUNCE_MS = 250;

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
  useEffect(() => {
    mountedRef.current = true;
    const push = pushRef.current;
    return () => {
      mountedRef.current = false;
      push.generation += 1;
      if (push.timer !== null) clearTimeout(push.timer);
      push.timer = null;
    };
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
      setDoc(next);
      return next;
    } catch {
      // transient — keep the last known document (never throw to the UI)
      return null;
    }
  }, [orgSlug, competitionSlug]);

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

  const hasLive = doc.matches.some((m) => m.bucket === "live");
  // A stable STRING key, not the array itself — `doc.matches` gets a fresh
  // identity on every poll tick even when the live set is unchanged, and
  // keying the realtime effect on the array would tear the channels down
  // and resubscribe them every tick (the same reasoning `slideshow.tsx`'s
  // own `divisionKey` documents).
  const liveDivisionKey = Array.from(
    new Set(doc.matches.filter((m) => m.bucket === "live").map((m) => m.divisionId)),
  )
    .sort()
    .join(",");

  // Realtime push: any failure (env missing, websocket refused) leaves
  // `subscribed` false and polling takes over.
  const [subscribed, setSubscribed] = useState(false);
  useEffect(() => {
    const ids = liveDivisionKey ? liveDivisionKey.split(",") : [];
    if (!realtime || ids.length === 0) return;
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return;
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channels: any[] = [];

    (async () => {
      try {
        const { supabaseBrowser } = await import("@/lib/supabase-browser");
        if (cancelled) return;
        const sb = supabaseBrowser();
        // PER-CHANNEL state, never one shared boolean. Every channel used to
        // write the same `subscribed` flag and the last writer won, so on a
        // hub with live matches in two divisions the hook reported whatever
        // the final callback happened to say. `division:d1` reporting
        // SUBSCRIBED after `division:d2` reported CHANNEL_ERROR left
        // `subscribed` true, which switched the POLL off — and d2 has no
        // channel pushing to it, so its live scores froze on the page until
        // the spectator reloaded. (Since R10 H2 it would only slow the poll to
        // the safety net, which still leaves d2 up to a minute behind.) That
        // is the flagship failure mode of the whole surface, and the inverse
        // order merely lied about the transport instead.
        //
        // Not only a startup race: Supabase re-invokes this callback on a
        // later CHANNEL_ERROR / TIMED_OUT / CLOSED, so one channel dropping
        // mid-match flipped the whole hook, and one recovering flipped it
        // back. Realtime is claimed only when EVERY channel is up; anything
        // less falls back to polling, which covers all of them.
        //
        // The loop's own `if (cancelled) return` is gone with it (review nit
        // 2): everything after the `await` above is synchronous and React
        // runs cleanups synchronously, so `cancelled` cannot flip mid-loop —
        // and had it ever fired it would have LEAKED, because the channels
        // pushed on earlier iterations were pushed after the cleanup already
        // walked the array. The check at the `await` boundary is the real one.
        const up = new Set<string>();
        for (const id of ids) {
          channels.push(
            sb
              .channel(`division:${id}`)
              .on("broadcast", { event: "state_changed" }, onPush)
              .on("broadcast", { event: "schedule_changed" }, onPush)
              .subscribe((status: string) => {
                if (cancelled) return;
                if (status === "SUBSCRIBED") up.add(id);
                else up.delete(id);
                setSubscribed(up.size === ids.length);
              }),
          );
        }
      } catch {
        // env missing / websocket refused → polling
      }
    })();

    // The push sequence is NOT cancelled here. A refetch that changes the live
    // division set re-runs this effect, and the retry for the push that caused
    // it must still run. Unmount ends the sequence (above).
    return () => {
      cancelled = true;
      setSubscribed(false);
      for (const ch of channels) void ch.unsubscribe?.();
    };
  }, [realtime, liveDivisionKey, onPush]);

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
