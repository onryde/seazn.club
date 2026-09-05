"use client";
// Spectator surface W1, Task 13 — the cricket Commentary tab: ball-by-ball,
// grouped by over, newest over on top.
//
// `"use client"` for ONE reason: "Load earlier overs" is component state. Every
// over that is rendered is rendered on the server first, so a spectator with no
// JS still gets the five most recent overs — the button is the only thing that
// needs the client, and its absence degrades to "you see the recent overs",
// never to a blank tab.
//
// ---------------------------------------------------------------------------
// Not derivable from reading this file
// ---------------------------------------------------------------------------
//
// 1. NEWEST FIRST IS THE WHOLE POINT. A spectator opening commentary mid-match
//    wants the ball that just happened, not the toss. The document delivers
//    overs in PLAYING order (over 1 first) because that is how they were
//    recorded, so this reverses once, here, rather than asking the builder to
//    deliver a reversed array that every other consumer would have to undo.
//
// 2. THE WINDOW IS FIVE OVERS, AND GROWS BY FIVE. Not a paginator: there is no
//    page to be on, and a spectator who wants the whole innings presses the
//    button until it stops appearing. Rendering 20 overs × 6 balls on a phone
//    to show the last one is the thing this avoids.
//
// 3. `lines[i]` IS THE BALL AT `glyphs[i]`. The schema keeps them as two
//    parallel arrays (`glyphs` is the compact over strip, `lines` the prose),
//    so the ball number a testid names is the 1-based index into that pair. A
//    line with no glyph still renders — a missing chip is a gap in the strip,
//    not a reason to drop the commentary.
import { useState, type ReactNode } from "react";
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { MatchCentreDocT } from "@/server/public-site/match-centre-schema";
import type { LiveFixtureData } from "../live-score-data";
import { TabPanel } from "./tab-panel";

type CricketViewT = NonNullable<MatchCentreDocT["cricket"]>;
type OverT = CricketViewT["innings"][number]["overs"][number];

export interface CommentaryTabProps {
  doc: MatchCentreDocT;
  dict: PublicDict;
  /** Part of the shared panel signature; this panel renders from the built
   *  document alone and deliberately never reads the raw payload. */
  data: LiveFixtureData;
}

/** How many overs are shown before the button is pressed, and how many more
 *  each press reveals. */
export const OVER_WINDOW = 5;

function OverGroup({ over, dict }: { over: OverT; dict: PublicDict }): ReactNode {
  const bowler = over.bowler?.name ?? null;
  // Two templates rather than one with an empty `{bowler}`: an absent value
  // would leave a dangling " · " a reader has to interpret.
  const header =
    bowler === null
      ? t(dict, "matchCentre.endOfOverNoBowler", {
          over: over.number,
          runs: over.runs,
          score: over.scoreAfter,
        })
      : t(dict, "matchCentre.endOfOver", {
          over: over.number,
          runs: over.runs,
          score: over.scoreAfter,
          bowler,
        });
  return (
    <section
      data-testid={`mc-over-${over.number}`}
      className="rounded-xl border border-zinc-200/80 bg-surface"
    >
      <h3 className="border-b border-zinc-200/80 px-3 py-2 text-[13px] font-semibold tabular-nums">
        {header}
      </h3>
      <ol className="divide-y divide-zinc-200/60">
        {over.lines.map((line, i) => {
          const ball = i + 1;
          const glyph = over.glyphs[i] ?? null;
          return (
            <li
              key={`${over.number}.${ball}`}
              data-testid={`mc-ball-${over.number}.${ball}`}
              className="flex items-start gap-2 px-3 py-1.5 text-[13px]"
            >
              {glyph === null ? null : (
                <span
                  data-testid={`mc-glyph-${over.number}.${ball}`}
                  className="mt-px inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 px-1 text-[11px] font-semibold tabular-nums"
                >
                  {glyph}
                </span>
              )}
              <span className="min-w-0">{t(dict, line.key, line.params)}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function CommentaryTab({ doc, dict }: CommentaryTabProps): ReactNode {
  // See note 1: playing order in, newest first out.
  const all: OverT[] = (doc.cricket?.innings ?? []).flatMap((innings) => innings.overs);
  const newestFirst = [...all].reverse();

  const [visible, setVisible] = useState(OVER_WINDOW);
  const shown = newestFirst.slice(0, visible);
  const more = newestFirst.length > shown.length;

  return (
    <TabPanel id="commentary" className="grid gap-2">
      {shown.map((over) => (
        <OverGroup key={`${over.number}-${over.scoreAfter}`} over={over} dict={dict} />
      ))}
      {more ? (
        <button
          type="button"
          data-testid="mc-load-earlier"
          onClick={() => setVisible((n) => n + OVER_WINDOW)}
          className="rounded-xl border border-zinc-200/80 px-3 py-2 text-[13px] font-medium hover:bg-surface"
        >
          {t(dict, "matchCentre.loadEarlier")}
        </button>
      ) : null}
    </TabPanel>
  );
}
