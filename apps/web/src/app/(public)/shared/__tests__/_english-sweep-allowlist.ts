// The zero-English sweep's genuine exceptions (`english-sweep.test.tsx`).
//
// An entry is a PHRASE the sweep treats as accounted for wherever it appears,
// in every locale. Each one says why it is not copy. The sweep fails on an
// entry nothing rendered, so a phrase that stops appearing leaves this list
// rather than lingering as a hole a future literal could hide in.
//
// Not for: anything a translator would translate. A literal that belongs in a
// dictionary is fixed through the dictionary, never listed here.
export interface AllowlistEntry {
  /** A whole-word phrase. */
  text: string;
  reason: string;
  /** The files (paths relative to `app/(public)/shared`, as a scene lists
   *  them) the phrase is accounted for on. Absent: every page. A notation
   *  letter is scoped to where it IS notation — "W" is a wickets column on the
   *  scorecard, and on the hub's table it would be the English "won" this sweep
   *  exists to catch. */
  onlyOn?: readonly string[];
  /** "out-of-lane": a REAL leak whose fix belongs outside the /shared lane,
   *  listed so the sweep stays green while it is owed, and so that fixing it
   *  reds the "still needed" check until this entry goes. */
  kind?: "exception" | "out-of-lane";
}

// No entry for the football table's GF/GA/GD. They were listed here as
// notation until review M2: they are the initials of English words, and a
// Spanish table writes GF/GC/DG. `standings-view.ts` (`METRIC_HEADER_KEYS`) now
// resolves them through `table.abbr.*` / `table.col.*` like P W D L Pts, on
// both standings tables — and every other sport's metric header with them.
//
// No entry for the division page's variant pill ("11-a-side") either. It was
// listed out-of-lane until T16b fix round 3: the variant keys are a closed,
// engine-declared set, so `server/public-site/variant-label.ts` names each one
// through `variant.<sport>.*` in all four locales, on the division page and in
// both match-centre loaders.

const FIXTURE_PAGE = "[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx";
/** The match poster route. The same model draws the fixture's share card, and
 *  the poster scene sweeps both, so scoping to this one file covers the pair. */
const MATCH_POSTER = "[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/poster.png/route.tsx";

/** The cricket scorecard's column headers and figure labels. `stat-table.tsx`
 *  (W1 Task 11) rules them the sport's notation in every locale — "R, B, 4s,
 *  6s, SR, O, M, W, Econ" — with each header's `title` and a screen-reader
 *  word localised beside it. Scoped to the match centre. */
const scorecardNotation = (text: string, alsoOn: readonly string[] = []): AllowlistEntry => ({
  text,
  onlyOn: [FIXTURE_PAGE, ...alsoOn],
  reason:
    "cricket scorecard notation, not copy: stat-table.tsx keeps R/B/4s/6s/SR/O/M/W/Econ (and scorecard-tab's wd/nb) in every locale, localising only the title and sr-only word",
});

export const ENGLISH_SWEEP_ALLOWLIST: readonly AllowlistEntry[] = [
  // The poster's two performer boxes print the match centre's own figure lines
  // ("SR 366.7", "Econ 19.0") under a localised role, as the page does.
  scorecardNotation("SR", [MATCH_POSTER]),
  scorecardNotation("Econ", [MATCH_POSTER]),
  scorecardNotation("O"),
  scorecardNotation("W"),
  scorecardNotation("wd"),
  scorecardNotation("nb"),
];
