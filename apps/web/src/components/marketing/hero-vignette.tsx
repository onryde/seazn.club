"use client";

import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import { usePrefersReducedMotion } from "@/components/ui/use-prefers-reduced-motion";
import { HeroSceneArt } from "./hero-scene-art";
import { HERO_SPORT_SELECT_ID, heroSceneKey, heroSceneStyle, heroScoreText, type HeroSceneKey } from "./hero-scenes";

/** Object-relay hero animation (design/v3/12 §4.2). No humans — the ball, shuttle, puck or piece is the protagonist. It
 *  draws the sport picked in the hero's Sport select (owner 2026-11-13), one scene per sport the quick match offers
 *  (hero-scenes.ts). Plays three times on load, then rests (manual replay stays); a new sport plays again. Fixed-height
 *  box, so CLS stays 0 and a swap never moves the page; under prefers-reduced-motion it shows the final frame at once
 *  (the object where it lands, the score it scored) and plays nothing. */
const AUTO_PLAYS = 3;
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
  const [run, setRun] = useState(0);
  // Landings so far, kept per scene: a new sport's score starts from its own first frame.
  const [landed, setLanded] = useState<{ scene: HeroSceneKey; count: number }>({ scene, count: 0 });

  useEffect(() => {
    if (reduced || run >= AUTO_PLAYS - 1) return;
    const t = setTimeout(() => setRun((n) => n + 1), PLAY_MS);
    return () => clearTimeout(t);
  }, [run, scene, reduced]);

  useEffect(() => {
    if (reduced) return;
    const t = setTimeout(() => setLanded((l) => ({ scene, count: (l.scene === scene ? l.count : 0) + 1 })), LANDING_MS);
    return () => clearTimeout(t);
  }, [run, scene, reduced]);

  const count = landed.scene === scene ? landed.count : 0;
  // Reduced motion: the final frame, so the object has landed and scored.
  const score = heroScoreText(scene, reduced ? Math.max(count, 1) : count);

  return (
    <div data-sport={scene} className="relative h-64 w-full max-w-md sm:h-96 lg:h-[27rem] lg:max-w-none">
      {/* Keyed on the scene and the play: a new sport or a replay remounts it, which restarts the CSS choreography. */}
      <div
        key={`${scene}:${run}`}
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
