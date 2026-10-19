"use client";
// The Result card's headline ladder, in the browser (owner ruling 1, 2026-10-19; `result-ladder.ts` holds the rule).
//
// The probes are the measurement, as in the bar's `TeamName`: each rung's text is rendered once, hidden and
// unwrapped, so its natural width is readable whatever is on air, and the choice is made in ONE pass. First paint is
// the FULL rung (the server render, a browser source with JS still starting); the layout effect corrects it before
// the browser paints a client render.
//
// RE-MEASURED by a ResizeObserver on the card (its width is the room) and on every probe (the web font arriving
// changes every natural width without moving a box). Neither depends on the rung on air, so a re-measure after a
// step lands on the same rung and React bails out — no loop.
import { useLayoutEffect, useRef, useState } from "react";
import { availableHeadlineWidth, pickResultRung, probeLayoutWidth, type ResultRung } from "./result-ladder";

export function useResultRung(ladder: readonly [string, string, string] | null): {
  rung: ResultRung;
  settled: boolean;
  cardRef: React.RefObject<HTMLDivElement | null>;
  probeRefs: React.RefObject<(HTMLSpanElement | null)[]>;
} {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const probeRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const [rung, setRung] = useState<ResultRung>(0);
  const [settled, setSettled] = useState(false);
  // The ladder's identity, not the array's: the model is rebuilt every poll. NUL cannot occur in a sentence.
  const key = ladder === null ? null : ladder.join("\u0000");

  useLayoutEffect(() => {
    if (key === null) return;
    const card = cardRef.current;
    if (card === null) return;
    const measure = () => {
      const probes = probeRefs.current.slice(0, 3);
      if (probes.length < 3 || probes.some((p) => p === null || !p.isConnected)) return;
      const available = availableHeadlineWidth(card);
      if (!(available > 0) || card.offsetWidth === 0) return; // not laid out: every rung would read as too wide
      const widths = probes.map((p) => probeLayoutWidth(p!, card)) as [number, number, number];
      setRung(pickResultRung(widths, available));
      setSettled(true);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    for (const probe of probeRefs.current.slice(0, 3)) if (probe !== null) observer.observe(probe);
    return () => observer.disconnect();
  }, [key]);

  return { rung: ladder === null ? 0 : rung, settled: ladder !== null && settled, cardRef, probeRefs };
}
