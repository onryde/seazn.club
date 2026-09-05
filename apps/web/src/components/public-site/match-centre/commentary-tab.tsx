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
// 1. NEWEST FIRST IS THE WHOLE POINT, ACROSS INNINGS TOO. A spectator opening
//    commentary mid-match wants the ball that just happened, not the toss. The
//    document delivers innings in playing order and overs within them likewise,
//    so this reverses both, here, rather than asking the builder to deliver a
//    reversed array every other consumer would have to undo. The five-over
//    window is therefore anchored at the NEWEST over and grows backwards.
//
// 1b. TESTIDS ARE SCOPED BY THE INNINGS' ARRAY INDEX, NOT ITS `number`. Over
//    numbers restart each innings, so `mc-over-3` named two different overs in
//    a two-innings match — a duplicate id and an e2e selector that silently
//    matched the wrong one. `innings.number` is not a safe scope either: a
//    super over can REUSE a number, which would put the collision straight
//    back. The 1-based array position cannot collide by construction. They are
//    `mc-over-<i>.<over>` and `mc-ball-<i>.<over>.<ball>`, and a separator row
//    announces each innings as the reader scrolls back into it.
//
// 2. THE WINDOW IS FIVE OVERS, ANCHORED AT THE NEWEST ONE, AND GROWS BY FIVE
//    BACKWARDS. Not a paginator: there is no page to be on, the top of the list
//    never moves, and a spectator who wants the whole innings presses the
//    button until it stops appearing. Rendering 20 overs × 6 balls on a phone
//    to show the last one is the thing this avoids.
//
// 3. `lines[i]` IS THE BALL AT `glyphs[i]`. The schema keeps them as two
//    parallel arrays (`glyphs` is the compact over strip, `lines` the prose),
//    so the ball number a testid names is the 1-based index into that pair. A
//    line with no glyph still renders — a missing chip is a gap in the strip,
//    not a reason to drop the commentary.
import { Fragment, useState, type ReactNode } from "react";
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { MatchCentreDocT } from "@/server/public-site/match-centre-schema";
import type { LiveFixtureData } from "../live-score-data";
import { TabPanel } from "./tab-panel";

type CricketViewT = NonNullable<MatchCentreDocT["cricket"]>;
type InningsT = CricketViewT["innings"][number];
type OverT = InningsT["overs"][number];

/** One over, plus the innings it belongs to — over numbers restart, so an over
 *  alone cannot identify itself. */
interface OverInInnings {
  over: OverT;
  innings: InningsT;
  /** 1-based ARRAY position — see note 1b. Unique by construction, which
   *  `innings.number` is not. */
  index: number;
}

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

/**
 * The over's heading, at whichever level the document's own structure puts it.
 *
 * A heading walk must not SKIP a level, and this panel's outline depends on
 * something outside this component: the sr-only `<h2>` names the tab, an
 * innings separator `<h3>` appears only when there is more than one innings,
 * and the over headings sit under whichever of those is last. Hard-coding `h4`
 * was right for a two-innings scorecard and wrong for the commonest case there
 * is — a single innings in progress — where it jumped h2 straight to h4.
 */
function OverHeading({
  level,
  children,
}: {
  level: 3 | 4;
  children: ReactNode;
}): ReactNode {
  const Tag = level === 3 ? "h3" : "h4";
  return (
    <Tag className="border-b border-zinc-200/80 px-3 py-2 text-[13px] font-semibold tabular-nums">
      {children}
    </Tag>
  );
}

function OverGroup({
  over,
  inningsIndex,
  headingLevel,
  dict,
}: {
  over: OverT;
  /** See `overHeadingLevel` — 3 when nothing sits between this and the panel's
   *  own h2, 4 when an innings separator does. */
  headingLevel: 3 | 4;
  inningsIndex: number;
  dict: PublicDict;
}): ReactNode {
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
      data-testid={`mc-over-${inningsIndex}.${over.number}`}
      className="rounded-xl border border-zinc-200/80 bg-surface"
    >
      {/* The level is DERIVED, never fixed — see `overHeadingLevel`. */}
      <OverHeading level={headingLevel}>{header}</OverHeading>
      <ol className="divide-y divide-zinc-200/60">
        {over.lines.map((line, i) => {
          const ball = i + 1;
          const glyph = over.glyphs[i] ?? null;
          return (
            <li
              key={`${inningsIndex}.${over.number}.${ball}`}
              data-testid={`mc-ball-${inningsIndex}.${over.number}.${ball}`}
              className="flex items-start gap-2 px-3 py-1.5 text-[13px]"
            >
              {glyph === null ? null : (
                <span
                  data-testid={`mc-glyph-${inningsIndex}.${over.number}.${ball}`}
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
  const innings = doc.cricket?.innings ?? [];
  // See note 1: playing order in, newest first out — innings AND overs.
  const newestFirst: OverInInnings[] = innings
    .map((entry, i) => ({ entry, index: i + 1 }))
    .reverse()
    .flatMap(({ entry, index }) =>
      [...entry.overs].reverse().map((over) => ({ over, innings: entry, index })),
    );

  const [visible, setVisible] = useState(OVER_WINDOW);
  const shown = newestFirst.slice(0, visible);
  const more = newestFirst.length > shown.length;
  // ONE derivation, from the document's own shape. `multipleInnings` decides
  // BOTH whether a separator renders and how deep the over headings sit, so the
  // two can never disagree — which is exactly how the h2 -> h4 jump got in.
  const multipleInnings = innings.length > 1;
  const overHeadingLevel: 3 | 4 = multipleInnings ? 4 : 3;

  return (
    <TabPanel id="commentary" className="grid gap-2">
      <h2 className="sr-only">{t(dict, "matchCentre.commentary")}</h2>
      {shown.map((entry, i) => {
        // A separator whenever the innings changes as the reader scrolls back,
        // INCLUDING the first group — otherwise the newest innings is the only
        // one that is never named. Suppressed entirely for a one-innings match,
        // where there is nothing to distinguish.
        const previous = shown[i - 1]?.index;
        const showSeparator = multipleInnings && entry.index !== previous;
        return (
          <Fragment key={`${entry.index}.${entry.over.number}-${entry.over.scoreAfter}`}>
            {showSeparator ? (
              <h3
                data-testid={`mc-commentary-innings-${entry.index}`}
                className="flex items-baseline justify-between gap-2 px-1 pt-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted"
              >
                <span className="min-w-0 truncate">{entry.innings.side.name}</span>
                <span className="shrink-0 tabular-nums">
                  {entry.innings.total.runs}/{entry.innings.total.wickets}
                </span>
              </h3>
            ) : null}
            <OverGroup
              over={entry.over}
              inningsIndex={entry.index}
              headingLevel={overHeadingLevel}
              dict={dict}
            />
          </Fragment>
        );
      })}
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
