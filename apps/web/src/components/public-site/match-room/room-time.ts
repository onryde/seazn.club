"use client";
// Time on the room's screens. Every time-of-day and countdown renders only
// after mount: the server's timezone is not the player's, and a server-
// rendered "19:20" that the browser corrects is a hydration mismatch.
import { useEffect, useState } from "react";

/** A countdown face, m:ss, seconds rounded UP (0:00 means no time left). */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** "19:20" — a 24-hour clock in the viewer's own timezone (the canvas's
 *  face; `2-digit` alone renders a 12-hour clock in en). */
export function formatTimeOfDay(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

/** T17B fix 2, D13: whether the server's clock has reached `flagAt` (clock-math
 *  moverFlagAt) on this client — one timer to that instant, never a tick, so
 *  the room does not re-render the board ten times a second to learn it. A new
 *  instant (a new ply, a correction) starts afresh; false until mounted. */
export function useFlagFallen(flagAt: number | null, skewMs: number): boolean {
  const [fallenAt, setFallenAt] = useState<number | null>(null);
  useEffect(() => {
    if (flagAt === null) return;
    const id = setTimeout(() => setFallenAt(flagAt), Math.max(0, flagAt - (Date.now() + skewMs)));
    return () => clearTimeout(id);
  }, [flagAt, skewMs]);
  return flagAt !== null && fallenAt === flagAt;
}

/** The server's "now" on this client (wall clock + the snapshot's skew),
 *  ticking every `tickMs`; null until mounted. */
export function useServerNow(skewMs: number, tickMs: number | null): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const read = () => setNow(Date.now() + skewMs);
    // First reading on the next task, not synchronously in the effect.
    const first = setTimeout(read, 0);
    const id = tickMs === null ? null : setInterval(read, tickMs);
    return () => {
      clearTimeout(first);
      if (id !== null) clearInterval(id);
    };
  }, [skewMs, tickMs]);
  return now;
}
