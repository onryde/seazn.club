"use client";
// The viewer's clock for a screen that offers "+5 min" (spec §3.2.2; owner, 2026-10-19: +5 only inside a board's check-in window,
// hidden at its opening and its deadline to the millisecond, not up to a poll late).
//
// `null` on the server and the first client render - nothing reads the clock during render, so there is no hydration mismatch.
// One self-re-arming timer, never an interval: each firing reads the clock, then sleeps until the NEARER of the next window edge
// (`edges`: the openings and deadlines the screen watches) and the cadence, so the screen changes AT an edge rather than up to a
// cadence late. `steady` keeps the cadence between edges (the arbiter panel's player clocks run on it); without it the screen sleeps
// from edge to edge only and stops after the last, a control with nothing left to watch keeps no timer. While `active` is false no
// timer runs at all.
import { useEffect, useState } from "react";
import { nextExtendEdge } from "@/lib/checkin-extend";

/** The longest sleep: a re-read at least this often even with no edge near, so a slept laptop or a corrected clock cannot leave a stale
 *  reading for long. */
export const EXTEND_CLOCK_MAX_SLEEP_MS = 30_000;
/** The cadence of a `steady` clock. */
export const EXTEND_CLOCK_TICK_MS = 500;

export function useExtendClock(active: boolean, edges: readonly number[], steady = false): number | null {
  const [nowMs, setNowMs] = useState<number | null>(null);
  // The edges as a string: an array literal is a new identity every render and would restart the timer every render.
  const key = edges.join(",");
  useEffect(() => {
    if (!active) return;
    const watched = key === "" ? [] : key.split(",").map(Number);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      const now = Date.now();
      setNowMs(now);
      const next = nextExtendEdge(watched, now);
      if (next === null && !steady) return; // nothing left to watch
      const toEdge = next === null ? EXTEND_CLOCK_MAX_SLEEP_MS : next - now;
      timer = setTimeout(arm, Math.max(1, Math.min(toEdge, steady ? EXTEND_CLOCK_TICK_MS : EXTEND_CLOCK_MAX_SLEEP_MS)));
    };
    timer = setTimeout(arm, 0);
    return () => clearTimeout(timer);
  }, [active, key, steady]);
  return nowMs;
}
