"use client";
// The seat 429 wait (spec §6.1 (3), owner decision C5): when the seat door refuses a claim for asking too often, the room shows
// a countdown from `Retry-After` and brings the button back when it reaches zero - never before. Until then the room sends no
// seat request at all, from anywhere (the button, a visibility change, the `camera_starting` back-off): the guard is the one
// place that knows, so the wait does not spend the asks it is waiting out.
//
// The clock is MONOTONIC (`performance.now()`): a phone whose system clock is changed mid-wait neither shortens nor stretches it.
import { useCallback, useEffect, useRef, useState } from "react";
import { SEAT_ASK_WINDOW_S } from "./room-snapshot";

/** `Retry-After` as the wait in whole seconds: a whole number clamped to 1..SEAT_ASK_WINDOW_S; missing, zero, negative, fractional
 *  garbage or not a number counts as the longest the limiter can hold, SEAT_ASK_WINDOW_S. (The server sends whole seconds.) */
export function parseRetryAfterS(raw: string | null | undefined): number {
  if (raw === null || raw === undefined) return SEAT_ASK_WINDOW_S;
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return SEAT_ASK_WINDOW_S;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1) return SEAT_ASK_WINDOW_S;
  return Math.min(n, SEAT_ASK_WINDOW_S);
}

/** Whole seconds left of a wait ending at `endsAtMs` (monotonic), rounded UP so the face never reads 0 while the button is still
 *  shut; 0 once the wait is over. */
export function seatWaitRemainingS(endsAtMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((endsAtMs - nowMs) / 1_000));
}

/** How often the face is refreshed while a wait runs. The END is its own timer (exact), not a tick of this. */
const FACE_TICK_MS = 250;

export type SeatWait = {
  /** Whole seconds left, or null when no wait is running. */
  remainingS: number | null;
  /** Start (or restart, from a newer header) the wait. */
  start: (retryAfter: string | null | undefined) => void;
  /** The guard: true while a wait is running, judged on the monotonic clock at the moment of asking - not on the face. */
  blocked: () => boolean;
};

export function useSeatWait(): SeatWait {
  const endsAt = useRef<number | null>(null);
  const [remainingS, setRemainingS] = useState<number | null>(null);
  const [runId, setRunId] = useState(0);

  const blocked = useCallback(() => endsAt.current !== null && performance.now() < endsAt.current, []);
  const start = useCallback((retryAfter: string | null | undefined) => {
    const s = parseRetryAfterS(retryAfter);
    endsAt.current = performance.now() + s * 1_000;
    setRemainingS(s);
    setRunId((n) => n + 1);
  }, []);

  useEffect(() => {
    const end = endsAt.current;
    if (end === null) return;
    const face = setInterval(() => {
      const left = seatWaitRemainingS(end, performance.now());
      setRemainingS((was) => (was === null ? was : left > 0 ? left : was));
    }, FACE_TICK_MS);
    // The end: exactly when the monotonic clock reaches it. A timer that fires a hair early re-arms for the remainder,
    // so the button never comes back before the time.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      const left = end - performance.now();
      if (left > 0) {
        timer = setTimeout(arm, left);
        return;
      }
      if (endsAt.current === end) {
        endsAt.current = null;
        setRemainingS(null);
      }
    };
    arm();
    return () => {
      clearInterval(face);
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  return { remainingS, start, blocked };
}
