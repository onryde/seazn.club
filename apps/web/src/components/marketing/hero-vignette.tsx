"use client";

import { useEffect, useState } from "react";

/** Object-relay hero animation (design/v3/12 §4.2). No humans — the shuttle is
 *  the protagonist. Plays three times on load, then rests (manual replay stays).
 *  Fixed-height container so CLS stays 0; under prefers-reduced-motion the
 *  CSS shows the end state (shuttle on scorebug). */
const AUTO_PLAYS = 3;

/** The sport the art draws (owner 2026-11-13, review m6): it sits beside the hero's quick match Sport select, so it is one
 *  the quick match offers, the one that select opens on (the offer's first), never cricket, which the quick match
 *  excludes (a lineup sport). */
export const HERO_VIGNETTE_SPORT = "badminton";

/** Rally scoring: the game is won at 21 (from 16 the rallies cannot reach deuce), so a replay past it adds nothing. */
const GAME_POINT = 21;

/** The racket head's strings: one line per 6px, clipped to the head. */
const STRINGS_X = [292, 298, 304, 310, 316, 322, 328];
const STRINGS_Y = [114, 121, 128, 135, 142, 149, 156, 163, 170];

export function HeroVignette({ label }: { label: string }) {
  const [run, setRun] = useState(0);
  // Badminton scorebug: each play is one rally — the struck shuttle lands on
  // the chip and Kim takes the point (+1) as the LIVE dot starts pulsing.
  const [points, setPoints] = useState(18);

  useEffect(() => {
    if (run >= AUTO_PLAYS - 1) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setTimeout(() => setRun((n) => n + 1), 3300);
    return () => clearTimeout(t);
  }, [run]);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // 2.4s = the shuttle's landing moment in the CSS choreography (globals.css).
    const t = setTimeout(() => setPoints((p) => Math.min(p + 1, GAME_POINT)), 2400);
    return () => clearTimeout(t);
  }, [run]);

  return (
    <div data-sport={HERO_VIGNETTE_SPORT} className="relative h-64 w-full max-w-md sm:h-72">
      <div key={run} data-testid="vignette-run" className="mk-vignette absolute inset-0">
        <svg viewBox="0 0 420 280" className="h-full w-full" role="img" aria-label={label}>
          <defs>
            <clipPath id="mk-racket-strings">
              <ellipse cx="310" cy="142" rx="21" ry="30" />
            </clipPath>
          </defs>
          {/* court line */}
          <line
            x1="24"
            y1="236"
            x2="396"
            y2="236"
            stroke="var(--mk-lime)"
            strokeWidth="3"
            strokeLinecap="round"
            opacity="0.55"
          />
          {/* the net, side on: a post, its white tape and the mesh below it — the shuttle's flight clears it */}
          <line x1="190" y1="236" x2="190" y2="160" stroke="#8d7fc0" strokeWidth="3" strokeLinecap="round" />
          <rect x="186" y="164" width="8" height="40" fill="none" stroke="#8d7fc0" strokeWidth="1.5" strokeDasharray="3 3" />
          <line x1="186" y1="164" x2="194" y2="164" stroke="var(--mk-cream)" strokeWidth="4" strokeLinecap="round" />
          {/* racket: grip at the bottom pivot, head up — contact lands mid-strings */}
          <g className="mk-bat">
            <rect x="307" y="172" width="6" height="26" rx="3" fill="var(--mk-cream)" stroke="#1e1b2e" strokeWidth="2" />
            <rect x="304" y="194" width="12" height="40" rx="6" fill="var(--mk-lime)" stroke="#1e1b2e" strokeWidth="3" />
            <ellipse cx="310" cy="142" rx="25" ry="34" fill="#1a0f3e" stroke="#1e1b2e" strokeWidth="9" />
            <g clipPath="url(#mk-racket-strings)" stroke="var(--mk-cream)" strokeWidth="1.2" opacity="0.55">
              {STRINGS_X.map((x) => (
                <line key={`x${x}`} x1={x} y1="104" x2={x} y2="180" />
              ))}
              {STRINGS_Y.map((y) => (
                <line key={`y${y}`} x1="282" y1={y} x2="338" y2={y} />
              ))}
            </g>
            <ellipse cx="310" cy="142" rx="25" ry="34" fill="none" stroke="var(--mk-cream)" strokeWidth="4.5" />
          </g>
          {/* impact star — pops at the head's sweet spot */}
          <g className="mk-star">
            <path
              d="M282 152 l10 -22 6 20 20 -8 -14 18 22 6 -24 6 10 20 -20 -12 -6 22 -8 -22z"
              fill="var(--mk-orange)"
              stroke="#1e1b2e"
              strokeWidth="3"
              strokeLinejoin="round"
            />
          </g>
          {/* the shuttle: cork at the origin (where the choreography steers it), feathers trailing up and right —
              toss → hang → struck left over the net → lands on the scorebug */}
          <g className="mk-ball">
            <path
              d="M1 -7.4 L7.4 -1 L26.2 -10.6 L10.6 -26.2 Z"
              fill="#ffffff"
              stroke="#1e1b2e"
              strokeWidth="2.5"
              strokeLinejoin="round"
            />
            <path d="M2.6 -5.8 L14.5 -22.4 M5.8 -2.6 L22.4 -14.5" stroke="#1e1b2e" strokeWidth="1.5" opacity="0.6" />
            <circle r="7.5" fill="#f43f5e" stroke="#1e1b2e" strokeWidth="3" />
          </g>
        </svg>
        {/* scorebug chip: the product end-state */}
        <div
          data-testid="scorebug"
          className="absolute bottom-2 left-2 flex items-center gap-2 rounded-lg border border-[#3b2a6e] bg-[#1a0f3e] px-3 py-2"
        >
          <span className="mk-live-dot h-2.5 w-2.5 rounded-full bg-[var(--mk-live)]" />
          <span className="mk-display text-xs font-semibold tracking-widest text-[var(--mk-lime)]">
            LIVE
          </span>
          <span className="mk-display whitespace-nowrap text-sm font-bold tabular-nums text-[var(--mk-cream)]">
            Kim {points}–16 Park
          </span>
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
