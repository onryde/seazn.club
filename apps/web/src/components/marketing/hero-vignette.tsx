"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { usePrefersReducedMotion } from "@/components/ui/use-prefers-reduced-motion";
import { HeroSceneArt } from "./hero-scene-art";
import {
  HERO_AUTO_PLAYS,
  HERO_SPORT_SELECT_ID,
  heroSceneKey,
  heroSceneStyle,
  heroScoreText,
  type HeroSceneKey,
} from "./hero-scenes";

/** Object-relay hero animation (design/v3/12 §4.2). No humans — the ball, shuttle, puck or piece is the protagonist. It
 *  draws the sport picked in the hero's Sport select (owner 2026-11-13), one scene per sport the quick match offers
 *  (hero-scenes.ts). Plays three times on load, then rests on its decided score (manual replay stays); a new sport plays
 *  again. Fixed-height box, so CLS stays 0 and a swap never moves the page; under prefers-reduced-motion it shows the
 *  final frame at once (the object where it lands, the score the plays rest on) and plays nothing. Off-screen (a phone's
 *  hero puts it below the fold) it holds every animation and the play's timers, and resumes where it held in view. */
/** One play's length, the pause included. */
const PLAY_MS = 3300;
/** The object's landing in the CSS choreography (globals.css: the fly's delay plus its duration). */
const LANDING_MS = 2400;

// The hero's Sport select as a store. The select is the server's (the quick match form works with no script), so the
// art reads it rather than owning it: its value is the snapshot, its `change` events the subscription. The server
// snapshot is "nothing picked", so the server's markup (and the hydration that must match it) draws the page's sport; once
// hydrated, a value the browser restored into the select (back navigation) shows at once. No select on the page (the
// quick match offer is empty) reads as nothing picked, and subscribes to nothing.
function selectOnPage(): HTMLSelectElement | null {
  return document.getElementById(HERO_SPORT_SELECT_ID) as HTMLSelectElement | null;
}
function subscribeToSelect(onChange: () => void): () => void {
  const select = selectOnPage();
  if (!select) return () => {};
  select.addEventListener("change", onChange);
  return () => select.removeEventListener("change", onChange);
}
const readSelect = (): string | null => selectOnPage()?.value ?? null;
const readNothingPicked = (): string | null => null;

/** Whether the art is on screen. `true` on the server and through hydration (the markup carries no hold, so the no-JS
 *  page plays as it always did) and wherever there is no IntersectionObserver (fail open, as use-start-on-view.ts does);
 *  after that, what the observer last said. A callback ref, so React hands it the node (and a test can, with no DOM). */
function useOnScreen(): [boolean, (node: Element | null) => (() => void) | undefined] {
  const [onScreen, setOnScreen] = useState(true);
  const watch = useCallback((node: Element | null) => {
    if (!node || typeof IntersectionObserver !== "function") return undefined;
    const io = new IntersectionObserver((entries) => {
      const last = entries.at(-1);
      if (last) setOnScreen(last.isIntersecting);
    });
    io.observe(node);
    return () => io.disconnect();
  }, []);
  return [onScreen, watch];
}

/** A play's timer that holds while `running` is false and resumes with the time it had left, as the CSS resumes the frame
 *  it held. `play` names the play it belongs to: a new one starts it whole; once it has fired it never fires again for
 *  that play. */
function usePlayTimer(play: string, ms: number, running: boolean, fire: () => void): void {
  const left = useRef({ play: "", ms: 0 });
  useEffect(() => {
    if (!running) return;
    if (left.current.play !== play) left.current = { play, ms };
    const box = left.current;
    if (box.ms <= 0) return;
    const started = Date.now();
    const t = setTimeout(() => {
      box.ms = 0;
      fire();
    }, box.ms);
    return () => {
      clearTimeout(t);
      // Held before it fired: keep what is left (at least a tick, so a hold at the last moment still fires on return).
      if (box.ms > 0) box.ms = Math.max(1, box.ms - (Date.now() - started));
    };
  }, [play, ms, running, fire]);
}

export function HeroVignette({
  sport,
  labels,
}: {
  /** The sport the select opens on (the offer's first); the server draws it. None, or one with no scene: badminton. */
  sport?: string | null;
  /** Each scene's accessible name, in the page's language. */
  labels: Readonly<Record<HeroSceneKey, string>>;
}) {
  const picked = useSyncExternalStore(subscribeToSelect, readSelect, readNothingPicked);
  const scene = heroSceneKey(picked ?? sport);
  const reduced = usePrefersReducedMotion();
  const [onScreen, watch] = useOnScreen();
  const [run, setRun] = useState(0);
  // Landings so far, kept per scene: a new sport's score starts from its own first frame.
  const [landed, setLanded] = useState<{ scene: HeroSceneKey; count: number }>({ scene, count: 0 });
  const play = `${scene}:${run}`;
  const moving = !reduced && onScreen;

  const nextPlay = useCallback(() => setRun((n) => n + 1), []);
  const land = useCallback(
    () => setLanded((l) => ({ scene, count: (l.scene === scene ? l.count : 0) + 1 })),
    [scene],
  );
  usePlayTimer(play, PLAY_MS, moving && run < HERO_AUTO_PLAYS - 1, nextPlay);
  usePlayTimer(play, LANDING_MS, moving, land);

  const count = landed.scene === scene ? landed.count : 0;
  // Reduced motion: the final frame, the score the plays rest on (the decided one), never a mid-play frame.
  const score = heroScoreText(scene, reduced ? HERO_AUTO_PLAYS : count);

  return (
    <div
      ref={watch}
      data-sport={scene}
      data-offscreen={onScreen ? undefined : ""}
      className="relative h-64 w-full max-w-md sm:h-96 lg:h-[27rem] lg:max-w-none"
    >
      {/* Keyed on the play (the scene and the run): a new sport or a replay remounts it, which restarts the CSS choreography. */}
      <div
        key={play}
        data-testid="vignette-run"
        className="mk-vignette absolute inset-0"
        style={heroSceneStyle(scene) as CSSProperties}
      >
        <svg
          viewBox="0 0 420 360"
          preserveAspectRatio="xMidYMin meet"
          className="h-full w-full"
          role="img"
          aria-label={labels[scene]}
        >
          <HeroSceneArt scene={scene} />
        </svg>
        {/* scorebug chip: the product end-state */}
        <div
          data-testid="scorebug"
          className="absolute bottom-2 left-2 flex items-center gap-2 rounded-lg border border-[#3b2a6e] bg-[#1a0f3e] px-3 py-2"
        >
          <span className="mk-live-dot h-2.5 w-2.5 rounded-full bg-[var(--mk-live)]" />
          <span className="mk-display text-xs font-semibold tracking-widest text-[var(--mk-lime)]">LIVE</span>
          <span className="mk-display whitespace-nowrap text-sm font-bold tabular-nums text-[var(--mk-cream)]">{score}</span>
        </div>
      </div>
      <button
        type="button"
        aria-label="Replay animation"
        onClick={() => setRun((n) => n + 1)}
        className="absolute right-1 top-1 rounded-md border border-[#3b2a6e] px-2 py-1 text-[10px] text-[#8d7fc0] hover:text-[var(--mk-cream)]"
      >
        ↺ replay
      </button>
    </div>
  );
}
