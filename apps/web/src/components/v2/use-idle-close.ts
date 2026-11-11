"use client";
import { useCallback, useEffect, useRef } from "react";
import { createIdleTimer, type IdleTimer } from "@/lib/fixture-console-panels";

/** Run `onIdle` once `ms` after the last call of the returned `restart` — armed only while `active` and `ms` is set.
 *  The caller spreads `idleActivityHandlers(restart)` on the region whose interaction counts. */
export function useIdleClose(active: boolean, ms: number | null, onIdle: () => void): () => void {
  const onIdleRef = useRef(onIdle);
  useEffect(() => {
    onIdleRef.current = onIdle;
  });
  const timer = useRef<IdleTimer | null>(null);
  useEffect(() => {
    if (!active || ms === null) return;
    const t = createIdleTimer(ms, () => onIdleRef.current());
    timer.current = t;
    t.restart();
    return () => {
      t.stop();
      timer.current = null;
    };
  }, [active, ms]);
  return useCallback(() => timer.current?.restart(), []);
}
