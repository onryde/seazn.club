"use client";
// The Match Day desk's one read of the day (`/api/v1/competitions/{id}/match-day`), shared by the poll, the "Refresh" button and a
// court's tail countdown reaching 0. One request at a time: a call while one is in flight (a double click, or the countdown of the
// list row and of the focused court reaching 0 together) is the one already running. A failed read, or an answer that is not a view
// (a cut-off 200), keeps the last view and says so (`failed`) until the next read succeeds. An answer whose ONLINE read failed
// (`online_failed`) is half a failure: the day is the answer's, the online rounds are the ones the page had (the caller's `onView`
// folds that, `viewAfterPoll`), and `failed` says the page is not wholly fresh.
import { useCallback, useRef, useState } from "react";
import { apiV1 } from "@/lib/client-v1";
import { isMatchDayView } from "@/lib/match-day/view";
import type { MatchDayView } from "@/lib/match-day/types";

export interface DayRefresh {
  /** `manual` is the button's own tap: only that shows busy ("Refreshing…"). The poll and a countdown's end read quietly. */
  refresh: (o?: { manual?: boolean }) => Promise<void>;
  /** A read is in flight. */
  busy: boolean;
  /** The last read failed (cleared by the next success). */
  failed: boolean;
  /** When the last read succeeded (ms, the browser's clock); null until one has since the page loaded. */
  lastOkAt: number | null;
}

/** `startedAt` is the browser's clock when the read was ASKED, not when it answered: the page orders an answer against a 402 it saw by it (B5). */
export function useDayRefresh(competitionId: string, onView: (v: MatchDayView, startedAt: number) => void, clock: () => number = Date.now): DayRefresh {
  const inflight = useRef<Promise<void> | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const read = useCallback(async () => {
    const startedAt = clock();
    try {
      const next = await apiV1<unknown>(`/api/v1/competitions/${competitionId}/match-day`);
      if (!isMatchDayView(next)) throw new Error("not a view");
      onView(next, startedAt);
      setLastOkAt(clock());
      // `=== true`: a server older than the page sends no marker, and an absent one is no failure.
      setFailed(next.online_failed === true);
    } catch {
      // Keep the last view; the next read tries again.
      setFailed(true);
    }
  }, [competitionId, onView, clock]);
  const refresh = useCallback(async (o?: { manual?: boolean }) => {
    const manual = o?.manual === true;
    if (inflight.current !== null) {
      // A manual tap during a running read shows busy on that read until it settles; no second request.
      if (manual) {
        setBusy(true);
        await inflight.current;
        setBusy(false);
      }
      return;
    }
    if (manual) setBusy(true);
    const running = read();
    inflight.current = running;
    try {
      await running;
    } finally {
      inflight.current = null;
      setBusy(false);
    }
  }, [read]);
  return { refresh, busy, failed, lastOkAt };
}
