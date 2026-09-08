"use client";
// Spectator surface W1, Task 10 review fix round 1 (IMPORTANT 4) — a small
// ticking clock so a "updated Xs ago" line actually advances instead of
// reading a value frozen at whatever it was on the last render-causing
// event. `Date.now()` only runs inside `useState`'s lazy initializer (once,
// at mount) and inside the interval callback (an effect, never render), so
// unlike reading `Date.now()` directly in a component body this trips no
// `react-hooks/purity` warning.
import { useEffect, useState } from "react";

/** Current time in ms, re-read every `intervalMs` (default 1s) until unmount. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
