"use client";

// Hold a replay until its block is actually on screen (#364 follow-up).
//
// The demo's trace reveals one line every REPLAY_MS from the moment the island
// mounts. The section sits well below the fold on /[lang]/scheduling, so an
// organiser who scrolls to it arrives after the run has already played itself
// out to a static end state — the one thing the section exists to show is over
// before it is looked at.
//
// Latching rather than pausing: once a block has been seen the replay owns its
// own clock, and scrolling away mid-run then back must not rewind it or freeze
// it half-drawn. `disconnect()` on the first hit also means no observer stays
// alive for the rest of the page's life.
//
// FAIL OPEN, deliberately. Where `IntersectionObserver` does not exist — SSR,
// the node test harness, an old browser — this returns `true` on the first
// render, so the behaviour is exactly what it was before this hook existed. A
// gate that fails closed would leave the section permanently blank in precisely
// the environments that cannot tell us it did.
import { useEffect, useState } from "react";

/**
 * `true` once any part of `ref`'s element has entered the viewport, and `true`
 * for ever after. Also `true` immediately when the platform has no
 * `IntersectionObserver`.
 *
 * Observe the element that PLAYS, not the whole section, and leave the
 * threshold at 0.
 *
 * A fractional threshold is a fraction of the observed element, so on an
 * element taller than `1 / threshold` viewports it can never be met: at 375px
 * this block stacks to roughly nine screens, and a 0.15 threshold left the gate
 * shut for ever — caught by the mobile e2e hanging on "waiting for the engine".
 * Height-independence is the requirement, so the trigger is the element's top
 * edge arriving, which is what a threshold of 0 means.
 *
 * Takes a ref box rather than a DOM node so a caller can pass `useRef` straight
 * from a JSX `ref=`, and so this is drivable without a DOM.
 */
export function useStartOnView(ref: { current: Element | null }): boolean {
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (started) return;
    // Support check BEFORE the element check: the node test harness renders
    // without a DOM, so its ref never fills in. Reversing these two lines would
    // hang every existing test on a gate that can never open.
    if (typeof IntersectionObserver !== "function") {
      setStarted(true);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      setStarted(true);
      io.disconnect();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, started]);

  return started;
}
