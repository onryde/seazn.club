// Spectator surface W1, Task 13 — shared fixture builders for the four tab
// panels' static-markup tests. One file rather than four copies: the four
// panels take the SAME document, and a per-file copy would let two of them
// drift onto different ideas of what a `MatchCentreDocT` looks like.
//
// Everything here is a literal document; each test file parses what it uses
// through `MatchCentreDoc` in `beforeAll`, so a fixture that has drifted from
// the schema fails as a fixture rather than silently proving a panel renders
// something the real document could never contain.
import type {
  InfoViewT,
  MatchCentreDocT,
  MsgT,
  PersonT,
  SetsViewT,
  SideT,
  TimelineLineT,
} from "@/server/public-site/match-centre-schema";

export const person = (personId: string, name: string): PersonT => ({
  personId,
  name,
  masked: false,
});
export const side = (entrantId: string, name: string, short: string): SideT => ({
  entrantId,
  name,
  short,
  colour: null,
  badgeUrl: null,
});

export const HOME = side("home", "Mumbai Kings", "MUM");
export const AWAY = side("away", "Rajasthan Rajvansh", "RAJ");

type CricketViewT = NonNullable<MatchCentreDocT["cricket"]>;
type OverT = CricketViewT["innings"][number]["overs"][number];

/** One over with `n` balls; `lines[i]` is the ball at `glyphs[i]`. */
export function over(number: number, glyphs: string[], bowlerName: string | null): OverT {
  return {
    number,
    bowler: bowlerName === null ? null : person(`p-${bowlerName}`, bowlerName),
    glyphs,
    runs: glyphs.length,
    wickets: glyphs.filter((g) => g === "W").length,
    scoreAfter: `${10 * number}/1`,
    lines: glyphs.map(
      (g, i): MsgT => ({
        key: "matchCentre.commentary",
        params: { over: number, ball: i + 1, glyph: g },
      }),
    ),
  };
}

function inningsWith(number: number, overs: OverT[]): CricketViewT["innings"][number] {
  return {
    number,
    side: number === 1 ? HOME : AWAY,
    isSuperOver: false,
    total: { runs: 156, wickets: 6, overs: "20.0", runRate: "7.80" },
    extrasLine: null,
    batting: [],
    didNotBat: [],
    bowling: [],
    fallOfWickets: [],
    partnerships: [],
    overs,
  };
}

export interface DocOver {
  overs?: OverT[];
  timeline?: TimelineLineT[] | null;
  sets?: SetsViewT | null;
  info?: InfoViewT;
}

export function makeDoc(o: DocOver = {}): MatchCentreDocT {
  return {
    fixtureId: "fx-1",
    sportKey: "cricket",
    header: {
      live: false,
      status: "decided",
      sides: [HOME, AWAY],
      scoreLines: ["156/6", "144/9"],
      subLines: [null, null],
      battingIndex: null,
      statusLine: null,
      rateLine: null,
      updatedAt: "2026-09-04T12:00:00.000Z",
    },
    tabs: ["summary", "info"],
    cricket:
      o.overs === undefined
        ? null
        : {
            band: 3,
            toss: null,
            innings: [inningsWith(1, o.overs)],
            live: null,
            topPerformers: [],
          },
    timeline: o.timeline ?? null,
    sets: o.sets ?? null,
    info: o.info ?? {
      rows: [],
      calendarHref: null,
      divisionHref: "/o/acme/c/summer/d/a",
      competitionHref: "/o/acme/c/summer",
    },
  };
}

export function line(
  seq: number,
  key: string,
  o: Partial<TimelineLineT> = {},
): TimelineLineT {
  return {
    seq,
    at: "2026-09-04T12:00:00.000Z",
    marker: null,
    sideIndex: null,
    text: { key },
    emphasis: "normal",
    ...o,
  };
}
