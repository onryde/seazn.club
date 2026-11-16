"use client";

import { useEffect, useRef } from "react";

/**
 * Where "you are here" is read: a line this far down the viewport. A step is current once its top has crossed it.
 * Kept high, with a pixel floor, so a short step that a contents link has just scrolled to the top is the current
 * one: at 0.45 the step after it had already crossed the line.
 */
const MARK = 0.25;
const MARK_FLOOR = 150;
/** The mark's position for a viewport of this height. Exported for the test. */
export function markAt(viewportHeight: number): number {
  return Math.max(MARK_FLOOR, viewportHeight * MARK);
}
/** The peg's own height: the line under it starts filling once the mark has passed the peg. */
const PEG = 40;

/** Which step is current, given each step's top edge (viewport px) and the mark's position. Exported for the test. */
export function currentStep(tops: readonly number[], mark: number): number {
  let cur = 0;
  tops.forEach((top, i) => {
    if (top <= mark) cur = i;
  });
  return cur;
}

/** How far the line under a step has filled, 0..1. */
export function lineFill(top: number, height: number, mark: number): number {
  const span = height - PEG;
  if (span <= 0) return top <= mark ? 1 : 0;
  return Math.max(0, Math.min(1, (mark - top - PEG) / span));
}

/**
 * The scroll state of the competition flow (competition-flow.tsx): marks the current step and the ones passed, fills
 * the line as far as the reader has scrolled, keeps the contents list in step, and drives the phone's pinned bar.
 * The section is complete without it; `data-live` on the root is what lets the CSS dim the steps still ahead.
 */
export function FlowProgress({ rootId, titles, ofLabel }: { rootId: string; titles: string[]; ofLabel: string }) {
  const count = useRef<HTMLElement>(null);
  const title = useRef<HTMLSpanElement>(null);
  const bar = useRef<HTMLElement>(null);

  useEffect(() => {
    const root = document.getElementById(rootId);
    if (!root) return;
    const steps = [...root.querySelectorAll<HTMLElement>("[data-flow-step]")];
    const index = [...root.querySelectorAll<HTMLElement>("[data-flow-idx]")];
    if (steps.length === 0) return;
    root.setAttribute("data-live", "");
    let frame = 0;

    const update = () => {
      frame = 0;
      const mark = markAt(window.innerHeight);
      const rects = steps.map((el) => el.getBoundingClientRect());
      const cur = currentStep(
        rects.map((r) => r.top),
        mark,
      );
      steps.forEach((el, i) => {
        el.style.setProperty("--mkf-fill", lineFill(rects[i]!.top, rects[i]!.height, mark).toFixed(3));
        el.toggleAttribute("data-on", i === cur);
        el.toggleAttribute("data-done", i < cur);
      });
      index.forEach((el, i) => {
        el.toggleAttribute("data-on", i === cur);
        el.toggleAttribute("data-done", i < cur);
      });
      if (count.current) count.current.textContent = ofLabel.replace("{n}", String(cur + 1));
      if (title.current) title.current.textContent = titles[cur] ?? "";
      const first = rects[0]!.top;
      const last = rects[rects.length - 1]!.bottom;
      if (bar.current) bar.current.style.width = `${(Math.max(0, Math.min(1, (mark - first) / (last - first))) * 100).toFixed(1)}%`;
    };
    const request = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    // A contents link glides to its step unless the reader asked for less motion; the href still works without this.
    const jump = (e: MouseEvent) => {
      const link = (e.target as HTMLElement).closest<HTMLAnchorElement>("[data-flow-idx] a");
      const target = link && document.getElementById(link.hash.slice(1));
      if (!target) return;
      e.preventDefault();
      const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      target.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "start" });
      history.replaceState(null, "", link.hash);
    };

    update();
    window.addEventListener("scroll", request, { passive: true });
    window.addEventListener("resize", request);
    root.addEventListener("click", jump);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", request);
      window.removeEventListener("resize", request);
      root.removeEventListener("click", jump);
      root.removeAttribute("data-live");
    };
  }, [rootId, titles, ofLabel]);

  return (
    <div className="mkf-prog" aria-hidden>
      <b ref={count} className="mkf-prog-n">
        {ofLabel.replace("{n}", "1")}
      </b>
      <span ref={title} className="mkf-prog-t">
        {titles[0]}
      </span>
      <i className="mkf-prog-bar">
        <i ref={bar} />
      </i>
    </div>
  );
}
