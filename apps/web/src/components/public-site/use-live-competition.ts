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
//     whenever that flips. Unlike W1's single-fixture hook, this poll is
//     NEVER switched off entirely: an upcoming match can start between
//     ticks, which a decided single fixture never does;
//   - realtime subscribes ONE channel PER DIVISION that currently has a live
//     match — `division:{id}`, no token and no `private` flag — exactly
//     `v2/slideshow.tsx:105-140`'s shape, because the hub is multi-division
//     and W1's PRIVATE, TOKENED per-fixture channel cannot cover it.
//     `lib/realtime.ts`'s `publishDivisionUpdate` is the producer:
//     `state_changed` for a scoring write, `schedule_changed` otherwise.
import { useCallback, useEffect, useRef, useState } from "react";
import type { CompetitionHubDocT } from "@/server/public-site/competition-hub-schema";
import { fetchCompetitionHub } from "./competition-hub-data";

export const HUB_POLL_MS = 15_000;
export const HUB_IDLE_POLL_MS = 60_000;

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

  // Same guard as `use-live-fixture.ts:32-38` — a poll or debounced refresh
  // in flight when the component unmounts must not call `setState` on its
  // way back (the fetch itself is not cancelled, only its effect on state).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchCompetitionHub(orgSlug, competitionSlug);
      if (!mountedRef.current) return;
      setDoc(next);
    } catch {
      // transient — keep the last known document (never throw to the UI)
    }
  }, [orgSlug, competitionSlug]);

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
    let debounce: ReturnType<typeof setTimeout> | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channels: any[] = [];

    (async () => {
      try {
        const { supabaseBrowser } = await import("@/lib/supabase-browser");
        if (cancelled) return;
        const sb = supabaseBrowser();
        const onPush = () => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(refresh, 250);
        };
        // PER-CHANNEL state, never one shared boolean. Every channel used to
        // write the same `subscribed` flag and the last writer won, so on a
        // hub with live matches in two divisions the hook reported whatever
        // the final callback happened to say. `division:d1` reporting
        // SUBSCRIBED after `division:d2` reported CHANNEL_ERROR left
        // `subscribed` true, which switched the POLL off — and d2 has no
        // channel pushing to it, so its live scores froze on the page until
        // the spectator reloaded. That is the flagship failure mode of the
        // whole surface, and the inverse order merely lied about the
        // transport instead.
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

    return () => {
      cancelled = true;
      if (debounce) clearTimeout(debounce);
      setSubscribed(false);
      for (const ch of channels) void ch.unsubscribe?.();
    };
  }, [realtime, liveDivisionKey, refresh]);

  // Whole-document polling. Never switched off (see header note): an idle
  // document can still see a fixture go live between ticks.
  useEffect(() => {
    if (subscribed) return;
    const delay = hasLive ? HUB_POLL_MS : HUB_IDLE_POLL_MS;
    const id = setInterval(refresh, delay);
    return () => clearInterval(id);
  }, [hasLive, subscribed, refresh]);

  return { doc, transport: subscribed ? "realtime" : "poll" };
}
