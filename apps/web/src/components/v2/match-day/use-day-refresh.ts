"use client";
// The Match Day desk's one read of the day (`/api/v1/competitions/{id}/match-day`), shared by the poll, the "Refresh" button and a
// court's tail countdown reaching 0. One request at a time: a call while one is in flight (a double click, or the countdown of the
// list row and of the focused court reaching 0 together) is the one already running. A failed read, or an answer that is not a view
// (a cut-off 200), keeps the last view and says so (`failed`) until the next read succeeds.
import { useCallback, useRef, useState } from "react";
import { apiV1 } from "@/lib/client-v1";
import { isMatchDayView } from "@/lib/match-day/view";
import type { MatchDayView } from "@/lib/match-day/types";

export interface DayRefresh {
  refresh: () => Promise<void>;
  /** A read is in flight. */
  busy: boolean;
  /** The last read failed (cleared by the next success). */
  failed: boolean;
  /** When the last read succeeded (ms, the browser's clock); null until one has since the page loaded. */
  lastOkAt: number | null;
}

export function useDayRefresh(competitionId: string, onView: (v: MatchDayView) => void, clock: () => number = Date.now): DayRefresh {
  const inflight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    try {
      const next = await apiV1<unknown>(`/api/v1/competitions/${competitionId}/match-day`);
      if (!isMatchDayView(next)) throw new Error("not a view");
      onView(next);
      setLastOkAt(clock());
      setFailed(false);
    } catch {
      // Keep the last view; the next read tries again.
      setFailed(true);
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }, [competitionId, onView, clock]);
  return { refresh, busy, failed, lastOkAt };
}
