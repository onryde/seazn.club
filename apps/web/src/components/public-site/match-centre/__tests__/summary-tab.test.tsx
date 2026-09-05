// Spectator surface W1, Task 11 — SummaryTab static-markup tests. Real React
// SSR (`renderToStaticMarkup`, `environment: "node"`, no jsdom needed);
// assertions anchor on `="` (an omitted prop serialises as `"$undefined"`).
//
// Mutants killed (Task 11):
// 1. Render every batting row `data-striker="true"` (never compare a row's
//    `person.personId` to `live.striker?.personId`) → the live-doc test's
//    "exactly one data-striker=true row" assertion reds (both rows carry it).
// 2. Drop the zero guard in the partnership bar width (`p.runs /
//    innings.total.runs * 100` unconditionally, no `> 0` check) → the
//    0-run-innings assertion reds with `width:NaN%` instead of `width:0%`.
import { beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { MatchCentreDoc, type MatchCentreDocT } from "@/server/public-site/match-centre-schema";
import type { LiveFixtureData } from "../../live-score-data";
import { MatchCentre } from "../match-centre";
import { SummaryTab } from "../summary-tab";

const dict = en as Dict;

function baseHeader(status: MatchCentreDocT["header"]["status"] = "in_play") {
  return {
    live: status === "in_play",
    status,
    sides: [
      { entrantId: "home", name: "Home XI", short: "HOM", colour: null, badgeUrl: null },
      { entrantId: "away", name: "Away XI", short: "AWY", colour: null, badgeUrl: null },
    ] as [MatchCentreDocT["header"]["sides"][0], MatchCentreDocT["header"]["sides"][1]],
    scoreLines: ["156/6", "—"] as [string | null, string | null],
    subLines: [null, null] as [string | null, string | null],
    battingIndex: 0 as const,
    statusLine: null,
    rateLine: null,
    updatedAt: new Date().toISOString(),
  };
}

function baseInfo(): MatchCentreDocT["info"] {
  return { rows: [], calendarHref: null, divisionHref: "/d", competitionHref: "/c" };
}

// A masked person, exactly as the document would already carry it — the
// component must print this name VERBATIM, never re-mask or re-derive it.
const strikerMasked = { personId: "p-striker", name: "A. Striker", masked: true };
const nonStriker = { personId: "p-nonstriker", name: "B. Second", masked: false };
const bowlerPerson = { personId: "p-bowler", name: "C. Bowler", masked: false };

const emptyDoc: MatchCentreDocT = {
  fixtureId: "fx-empty",
  sportKey: "cricket",
  header: baseHeader("scheduled"),
  tabs: ["summary", "info"],
  cricket: { band: 1, toss: null, innings: [], live: null, topPerformers: [] },
  timeline: null,
  sets: null,
  info: baseInfo(),
};

const cricketDoc: MatchCentreDocT = {
  fixtureId: "fx-live",
  sportKey: "cricket",
  header: baseHeader("in_play"),
  tabs: ["summary", "scorecard", "info"],
  cricket: {
    band: 3,
    toss: null,
    innings: [
      {
        number: 1,
        side: { entrantId: "home", name: "Home XI", short: "HOM", colour: null, badgeUrl: null },
        isSuperOver: false,
        total: { runs: 120, wickets: 4, overs: "18.2", runRate: "6.54" },
        extrasLine: null,
        batting: [],
        didNotBat: [],
        bowling: [],
        fallOfWickets: [
          { wicket: 1, runs: 20, over: "3.2", batter: { personId: "p1", name: "D. Opener", masked: false } },
          { wicket: 2, runs: 55, over: "9.4", batter: strikerMasked },
        ],
        partnerships: [
          {
            batters: [
              { personId: "p3", name: "E. Third", masked: false },
              { personId: "p4", name: "F. Fourth", masked: false },
            ],
            runs: 60,
            balls: 40,
            wicket: 3,
          },
        ],
        overs: [],
      },
      {
        // A second innings that has not yet scored a run — `total.runs === 0`
        // is the actual divide-by-zero case the width guard exists for (a
        // 0-run PARTNERSHIP inside a nonzero-total innings would render 0%
        // with or without the guard, since 0/120 is already 0 — this is the
        // one shape that tells the two apart: 0/0 is `NaN` without it).
        number: 2,
        side: { entrantId: "away", name: "Away XI", short: "AWY", colour: null, badgeUrl: null },
        isSuperOver: false,
        total: { runs: 0, wickets: 0, overs: "0.0", runRate: null },
        extrasLine: null,
        batting: [],
        didNotBat: [],
        bowling: [],
        fallOfWickets: [],
        partnerships: [
          {
            batters: [
              { personId: "p5", name: "G. Fifth", masked: false },
              { personId: "p6", name: "H. Sixth", masked: false },
            ],
            runs: 0,
            balls: 0,
            wicket: "unbroken",
          },
        ],
        overs: [],
      },
    ],
    live: {
      striker: strikerMasked,
      nonStriker,
      bowler: bowlerPerson,
      batters: [
        {
          person: strikerMasked,
          runs: 42,
          balls: 30,
          fours: 5,
          sixes: 1,
          strikeRate: "140.00",
          dismissal: { key: "matchCentre.status.live" },
          notOut: true,
        },
        {
          person: nonStriker,
          runs: 18,
          balls: 20,
          fours: 2,
          sixes: 0,
          strikeRate: "90.00",
          dismissal: { key: "matchCentre.status.live" },
          notOut: true,
        },
      ],
      bowling: [
        {
          person: bowlerPerson,
          overs: "4.0",
          maidens: 0,
          runs: 28,
          wickets: 2,
          economy: "7.00",
          wides: 1,
          noBalls: 0,
        },
      ],
      thisOver: ["1", "4", "W", "·", "wd", "6"],
      partnership: "45* (32b)",
      // A real dictionary key + params (not a made-up one) proves the Msg →
      // text pipeline, matching the convention CourtCard's own test uses.
      lastWicket: { key: "org.competitionsBy", params: { org: "D. Opener c Keeper b Bowler 20" } },
    },
    topPerformers: [
      {
        role: "batter",
        person: strikerMasked,
        side: { entrantId: "home", name: "Home XI", short: "HOM", colour: null, badgeUrl: null },
        line: "82 (54)",
        detail: "6 fours, 3 sixes",
      },
      {
        role: "bowler",
        person: bowlerPerson,
        side: { entrantId: "away", name: "Away XI", short: "AWY", colour: null, badgeUrl: null },
        line: "3/24",
        detail: "4 overs",
      },
    ],
  },
  timeline: null,
  sets: null,
  info: baseInfo(),
};

const finalDoc: MatchCentreDocT = {
  ...cricketDoc,
  fixtureId: "fx-final",
  header: baseHeader("decided"),
  cricket: { ...cricketDoc.cricket!, live: null, innings: [] },
};

const nonCricketDoc: MatchCentreDocT = {
  fixtureId: "fx-noncricket",
  sportKey: "football",
  header: baseHeader("scheduled"),
  tabs: ["summary", "info"],
  cricket: null,
  timeline: null,
  sets: null,
  info: baseInfo(),
};

function liveFixtureFor(doc: MatchCentreDocT): LiveFixtureData {
  return { status: doc.header.status, summary: null, outcome: null, match_centre: doc };
}

beforeAll(() => {
  for (const doc of [emptyDoc, cricketDoc, finalDoc, nonCricketDoc]) {
    // Fails loudly (not silently) the moment the schema and these literal
    // fixtures drift apart.
    MatchCentreDoc.parse(doc);
  }
});

describe("SummaryTab — cricket", () => {
  it("a cricket doc with a null live block and no performers renders no live block, no top performers, and no rails (empty case)", () => {
    const html = renderToStaticMarkup(<SummaryTab doc={emptyDoc} dict={dict} data={liveFixtureFor(emptyDoc)} />);
    expect(html).not.toContain('data-testid="mc-live-block"');
    expect(html).not.toContain('data-testid="mc-top-performers"');
    expect(html).not.toContain('data-testid="mc-fow-');
    expect(html).not.toContain('data-testid="mc-partnerships-');
  });

  it("a live doc renders the live block with exactly one striker row (and its positive-pair false row), the striker's MASKED name as given, and a this-over glyph strip sized to thisOver", () => {
    const html = renderToStaticMarkup(<SummaryTab doc={cricketDoc} dict={dict} data={liveFixtureFor(cricketDoc)} />);
    expect(html).toContain('data-testid="mc-live-block"');
    expect(html.match(/data-striker="true"/g)?.length).toBe(1);
    expect(html.match(/data-striker="false"/g)?.length).toBe(1); // positive pair of the negative
    expect(html).toContain("A. Striker"); // masked name, printed VERBATIM — never re-derived
    expect(html).toContain('data-testid="mc-this-over"');
    expect(html.match(/data-testid="mc-glyph"/g)?.length).toBe(cricketDoc.cricket!.live!.thisOver.length);
  });

  it("a final doc (live: null) renders top performers with BOTH roles and no live block", () => {
    const html = renderToStaticMarkup(<SummaryTab doc={finalDoc} dict={dict} data={liveFixtureFor(finalDoc)} />);
    expect(html).toContain('data-testid="mc-top-performers"');
    expect(html).toContain(dict["matchCentre.topBatter"] as string);
    expect(html).toContain(dict["matchCentre.topBowler"] as string);
    expect(html).not.toContain('data-testid="mc-live-block"'); // negative; the live-doc test above is its positive pair
  });

  it("the fall-of-wickets rail is a focusable, labelled list", () => {
    const html = renderToStaticMarkup(<SummaryTab doc={cricketDoc} dict={dict} data={liveFixtureFor(cricketDoc)} />);
    expect(html).toContain('data-testid="mc-fow-1"');
    expect(html).toContain('role="list"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-label="');
  });

  it("a partnership bar's inline width equals Math.round(runs/total*100)%, and a 0-total-runs innings renders 0% (never NaN)", () => {
    const html = renderToStaticMarkup(<SummaryTab doc={cricketDoc} dict={dict} data={liveFixtureFor(cricketDoc)} />);
    const innings1 = cricketDoc.cricket!.innings[0]!;
    const first = innings1.partnerships[0]!; // runs: 60, total: 120 → 50%
    const pct = Math.round((first.runs / innings1.total.runs) * 100);
    expect(pct).toBe(50);
    expect(html).toMatch(new RegExp(`width:\\s*${pct}%`));

    // Innings 2 has total.runs === 0 — the actual divide-by-zero case the
    // guard exists for (0/0 is `NaN` without it, not merely 0/nonzero).
    const innings2 = cricketDoc.cricket!.innings[1]!;
    expect(innings2.total.runs).toBe(0);
    expect(html).toContain('data-testid="mc-partnerships-2"');
    expect(html).not.toContain("NaN");
    // Scope the 0% check to innings 2's own container so it can't be
    // satisfied by coincidence from an unrelated part of the page.
    const p2Start = html.indexOf('data-testid="mc-partnerships-2"');
    expect(html.slice(p2Start)).toMatch(/width:\s*0%/);
  });
});

describe("SummaryTab — non-cricket", () => {
  it("a non-cricket doc renders LiveScoreBody's own fallback headline and none of the cricket testids", () => {
    const html = renderToStaticMarkup(
      <SummaryTab doc={nonCricketDoc} dict={dict} data={liveFixtureFor(nonCricketDoc)} />,
    );
    expect(html).toContain("Not started"); // LiveScoreBody's own headline fallback (live-score.tsx)
    expect(html).not.toContain('data-testid="mc-live-block"');
    expect(html).not.toContain('data-testid="mc-top-performers"');
    expect(html).not.toContain('data-testid="mc-fow-');
    expect(html).not.toContain('data-testid="mc-partnerships-');
  });
});

describe("no raw i18n key with a stray 'public.' prefix leaks into any match-centre component", () => {
  it("MatchCentre's full render (court card + tab rail + summary tab) contains no 'public.'-prefixed text anywhere", () => {
    const html = renderToStaticMarkup(
      <MatchCentre
        fixtureId={cricketDoc.fixtureId}
        initial={liveFixtureFor(cricketDoc)}
        realtime={false}
        dict={dict}
        locale="en"
        tabParam={null}
      />,
    );
    expect(html).not.toMatch(/\bpublic\.[a-zA-Z]/);
  });
});
