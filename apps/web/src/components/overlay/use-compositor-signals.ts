"use client";
// The compositor host's console signals (R2005 changes 2 and 10), on F-001's channel: `console.info` lines that C11
// reads from CEF's `cefconsole` log category. ONLY with `enabled` (the page's `host=compositor`): an OBS page and every
// preview log nothing.
//
//  - READY, once: the first live-data snapshot has rendered (`contentReady`, read after its commit), the fonts are
//    loaded and the images have settled. Not on mount — the compositor shows the page from this line on.
//  - ALIVE, every OVERLAY_ALIVE_EVERY_MS after ready (Owed 18): the compositor cannot see a JS hang once the page is
//    ready (cefsrc emits a buffer only when the page paints, so frame silence is no signal), so the page beats. A
//    `setInterval` on the MAIN thread on purpose — a hung main thread must stop it; never a worker or a
//    `requestAnimationFrame` loop that could keep beating while the score logic hangs.
//  - SCORE STALE, on change only (compositor spec §6): true once the last successful live-data update is
//    SCORE_STALE_AFTER_MS old, false again on the next. Its first value, at ready, is the change from "unknown".
//
// MOUNT POINT (review G3 of compositor PR #22): this hook belongs to the STAGE's top level, never under the scene or
// card subtree. A beat that unmounted at a scene change would read to the compositor as a hang, and it would hide the
// score at every Reconnecting.
import { useEffect, useRef, useState } from "react";
import {
  changeOnly,
  isScoreStale,
  OVERLAY_ALIVE_EVERY_MS,
  SCORE_STALE_AFTER_MS,
  scoreStaleSignal,
  SIGNAL_ALIVE,
  SIGNAL_READY,
} from "@/lib/overlay-compositor";

/** F-001's "theme assets loaded": the document's fonts, and every image that has not yet loaded or failed. Nothing to
 *  wait for outside a browser. An image that ERRORS still settles — a missing crest must not keep the score off air. */
export async function documentAssetsReady(): Promise<void> {
  if (typeof document === "undefined") return;
  await document.fonts?.ready;
  const pending = [...document.images].filter((img) => !img.complete);
  await Promise.all(
    pending.map(
      (img) =>
        new Promise<void>((resolve) => {
          img.addEventListener("load", () => resolve(), { once: true });
          img.addEventListener("error", () => resolve(), { once: true });
        }),
    ),
  );
}

export function useCompositorSignals({
  enabled,
  contentReady,
  lastSuccessAt,
  assetsReady = documentAssetsReady,
}: {
  enabled: boolean;
  /** The first live-data snapshot is on the page (the stage: no longer `awaitingDelay`). */
  contentReady: boolean;
  /** Wall time of the last successful live-data update (`useLiveFixture().received.at`). */
  lastSuccessAt: number;
  /** Injectable for the node test harness, which has no document. */
  assetsReady?: () => Promise<void>;
}): { ready: boolean } {
  const [ready, setReady] = useState(false);
  const readyLogged = useRef(false);
  const assetsRef = useRef(assetsReady);
  useEffect(() => {
    assetsRef.current = assetsReady;
  });

  useEffect(() => {
    if (!enabled || !contentReady || readyLogged.current) return;
    let cancelled = false;
    void assetsRef.current().then(() => {
      if (cancelled || readyLogged.current) return;
      readyLogged.current = true;
      console.info(SIGNAL_READY);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, contentReady]);

  // The beat: started once, after ready; cleared on unmount, so a remount never doubles it.
  useEffect(() => {
    if (!enabled || !ready) return;
    const id = setInterval(() => console.info(SIGNAL_ALIVE), OVERLAY_ALIVE_EVERY_MS);
    return () => clearInterval(id);
  }, [enabled, ready]);

  // Score stale: re-armed on every success; one timer, to the exact boundary.
  const staleEmit = useRef<((stale: boolean) => void) | null>(null);
  useEffect(() => {
    if (!enabled || !ready) return;
    staleEmit.current ??= changeOnly<boolean>((stale) => console.info(scoreStaleSignal(stale)));
    const emit = staleEmit.current;
    emit(isScoreStale(lastSuccessAt, Date.now()));
    const wait = lastSuccessAt + SCORE_STALE_AFTER_MS - Date.now();
    if (wait <= 0) return;
    const id = setTimeout(() => emit(isScoreStale(lastSuccessAt, Date.now())), wait);
    return () => clearTimeout(id);
  }, [enabled, ready, lastSuccessAt]);

  return { ready };
}
