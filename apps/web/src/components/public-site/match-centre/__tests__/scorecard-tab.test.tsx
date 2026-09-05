// Spectator surface W1, Task 12 — ScorecardTab static-markup tests.
//
// This workspace's vitest is `environment: "node"` (no jsdom), so these are
// `renderToStaticMarkup` assertions on real React SSR output, the same shape
// Task 10's `court-card.test.tsx` established. Two conventions carried over:
// assertions anchor on `="` (React serialises an omitted prop as
// `"$undefined"`, so a bare attribute-NAME probe passes in both states), and
// every negative assertion ships with its positive pair.
//
// Fixtures are built as literal `MatchCentreDocT` and parsed through
// `MatchCentreDoc` in `beforeAll`, so a fixture that has drifted from the
// schema fails as a fixture rather than silently proving the component
// renders something the real document could never contain.
//
// ---------------------------------------------------------------------------
// Mutants killed (Task 12)
// ---------------------------------------------------------------------------
// Applied by hand to `../scorecard-tab.tsx`, run, observed red, restored from a
// `cp` backup — never `git checkout`, which on an uncommitted tree restores the
// index and deletes the implementation under test.
//
//  (a) ALWAYS RENDER THE OPTIONAL COLUMNS — `anyNonNull(rows, pick)` in the
//      column-visibility check replaced by `true`, so 4s/6s/M/wd/nb render
//      whatever the band.
//      → RED: "band 2 … the optional columns are ABSENT".
//
//  (b) OPEN THE FIRST INNINGS — `index === innings.length - 1` became
//      `index === 0`.
//      → RED: "two innings … the LAST is open" (both the live and the decided
//        case).
//
//  (c) DROP THE SCROLL-REGION A11Y ATTRIBUTES — `<div className="overflow-x-auto"
//      tabIndex={0} role="region" aria-label={label}>` became
//      `<div className="overflow-x-auto">`. A third mutant because this guard
//      exists to stop an axe `scrollable-region-focusable` red at SERIOUS
//      impact, and nothing else in the suite would notice its absence.
//      → RED: "both tables are reachable overflow regions, not clipped boxes".
//
// All three compile and collect (`numTotalTests` stayed 12 in every run), so
// none is the collection-break shape that reads as a survivor.
import { beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CricketWicket } from "@seazn/engine/sports/cricket";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import type { Dict } from "@/lib/i18n-constants";
import type { LiveFixtureData } from "../../live-score-data";
import {
  MatchCentreDoc,
  type CricketViewT,
  type MatchCentreDocT,
  type PersonT,
  type SideT,
} from "@/server/public-site/match-centre-schema";
import { ScorecardTab } from "../scorecard-tab";

// The schema exports the view but not its row types; index rather than
// hand-copy, so a column added to the schema is a type error here.
type CricketInningsViewT = CricketViewT["innings"][number];

const dict = en as Dict;
const LOCALES = { en, es, fr, nl } as Record<string, Record<string, unknown>>;

const person = (personId: string, name: string): PersonT => ({ personId, name, masked: false });
const side = (entrantId: string, name: string, short: string): SideT => ({
  entrantId,
  name,
  short,
  colour: null,
  badgeUrl: null,
});

const HOME = side("home", "Mumbai Kings", "MUM");
const AWAY = side("away", "Rajasthan Rajvansh", "RAJ");

// A band-3 innings: every optional column has a value somewhere.
const richInnings: CricketInningsViewT = {
  number: 1,
  side: HOME,
  isSuperOver: false,
  total: { runs: 156, wickets: 6, overs: "20.0", runRate: "7.80" },
  extrasLine: "12 (b 2, lb 3, w 6, nb 1)",
  batting: [
    {
      person: person("p-rohit", "R. Sharma"),
      runs: 62,
      balls: 41,
      fours: 7,
      sixes: 2,
      strikeRate: "151.22",
      // Both params, so the assertion can prove BOTH are interpolated.
      dismissal: {
        key: "matchCentre.dismissal.caught",
        params: { fielder: "S. Patel", bowler: "J. Bumrah" },
      },
      notOut: false,
    },
    {
      person: person("p-suryakumar", "S. Yadav"),
      runs: 38,
      balls: 22,
      fours: 3,
      sixes: 3,
      strikeRate: "172.73",
      dismissal: { key: "matchCentre.dismissal.not_out" },
      notOut: true,
    },
  ],
  didNotBat: [person("p-bumrah", "J. Bumrah"), person("p-boult", "T. Boult")],
  bowling: [
    {
      person: person("p-khan", "S. Khan"),
      overs: "4.0",
      maidens: 1,
      runs: 28,
      wickets: 3,
      economy: "7.00",
      wides: 2,
      noBalls: 1,
    },
  ],
  fallOfWickets: [
    { wicket: 1, runs: 24, over: "3.2", batter: person("p-rohit", "R. Sharma") },
    { wicket: 2, runs: 88, over: "11.5", batter: person("p-ishan", "I. Kishan") },
  ],
  partnerships: [],
  overs: [],
};

// A band-2 innings: coarse scoring, so every optional column is null in EVERY
// row. This is the case the column-visibility rule exists for.
const coarseInnings: CricketInningsViewT = {
  number: 2,
  side: AWAY,
  isSuperOver: false,
  total: { runs: 144, wickets: 9, overs: "20.0", runRate: "7.20" },
  extrasLine: null,
  batting: [
    {
      person: person("p-samson", "S. Samson"),
      runs: 45,
      balls: 30,
      fours: null,
      sixes: null,
      strikeRate: null,
      dismissal: { key: "matchCentre.dismissal.bowled", params: { bowler: "S. Khan" } },
      notOut: false,
    },
  ],
  didNotBat: [],
  bowling: [
    {
      person: person("p-boult", "T. Boult"),
      overs: "4.0",
      maidens: null,
      runs: 31,
      wickets: 2,
      economy: null,
      wides: null,
      noBalls: null,
    },
  ],
  fallOfWickets: [],
  partnerships: [],
  overs: [],
};

const superOverInnings: CricketInningsViewT = {
  ...coarseInnings,
  number: 3,
  isSuperOver: true,
  fallOfWickets: [],
};

function doc(over: {
  innings: CricketInningsViewT[];
  live?: boolean;
}): MatchCentreDocT {
  return {
    fixtureId: "fx-1",
    sportKey: "cricket",
    header: {
      live: over.live === true,
      status: over.live === true ? "in_play" : "decided",
      sides: [HOME, AWAY],
      scoreLines: ["156/6", "144/9"],
      subLines: ["(20.0)", "(20.0)"],
      battingIndex: over.live === true ? 1 : null,
      statusLine: null,
      rateLine: null,
      updatedAt: "2026-09-04T12:00:00.000Z",
    },
    tabs: ["summary", "scorecard", "info"],
    cricket: {
      band: 3,
      toss: null,
      innings: over.innings,
      live:
        over.live === true
          ? {
              striker: person("p-samson", "S. Samson"),
              nonStriker: null,
              bowler: null,
              batters: [],
              bowling: [],
              thisOver: [],
              partnership: null,
              lastWicket: null,
            }
          : null,
      topPerformers: [],
    },
    timeline: null,
    sets: null,
    info: { rows: [], calendarHref: null, divisionHref: "/d", competitionHref: "/c" },
  };
}

const EMPTY = doc({ innings: [] });
const DECIDED = doc({ innings: [richInnings, coarseInnings] });
const LIVE = doc({ innings: [richInnings, coarseInnings], live: true });
const COARSE_ONLY = doc({ innings: [coarseInnings] });
const RICH_ONLY = doc({ innings: [richInnings] });
const SUPER_OVER = doc({ innings: [richInnings, coarseInnings, superOverInnings] });

// `data` is the raw live payload; ScorecardTab reads `doc.cricket` only, so the
// panel signature's third argument is satisfied and deliberately never read.
const data = {} as LiveFixtureData;

const render = (d: MatchCentreDocT): string =>
  renderToStaticMarkup(<ScorecardTab doc={d} dict={dict} data={data} />);

/** The opening `<details …>` tag for one innings, order-independent — an
 *  assertion on `data-testid="…" open=""` would be pinning React's attribute
 *  ORDER, which is not the contract. */
function detailsTag(html: string, testid: string): string {
  const match = html.match(new RegExp(`<details[^>]*data-testid="${testid}"[^>]*>`));
  expect(match).not.toBeNull();
  return match![0];
}
const isOpen = (html: string, testid: string): boolean => /\sopen=""/.test(detailsTag(html, testid));

beforeAll(() => {
  // Every fixture is a REAL document or the suite is proving nothing.
  for (const d of [EMPTY, DECIDED, LIVE, COARSE_ONLY, RICH_ONLY, SUPER_OVER]) {
    expect(MatchCentreDoc.safeParse(d).success).toBe(true);
  }
});

describe("ScorecardTab", () => {
  it("EMPTY: no innings renders the panel container and nothing else", () => {
    const html = render(EMPTY);
    expect(html).toContain('data-testid="mc-tab-panel-scorecard"');
    expect(html).not.toContain('data-testid="mc-innings-');
    expect(html).not.toContain('data-testid="mc-bat-');
    expect(html).not.toContain("<table");
    // The positive pair: the same probes DO fire on a populated document.
    const populated = render(DECIDED);
    expect(populated).toContain('data-testid="mc-innings-');
    expect(populated).toContain("<table");
  });

  it("a null cricket view renders the panel container, not a crash", () => {
    const html = renderToStaticMarkup(
      <ScorecardTab doc={{ ...EMPTY, cricket: null }} dict={dict} data={data} />,
    );
    expect(html).toContain('data-testid="mc-tab-panel-scorecard"');
    expect(html).not.toContain('data-testid="mc-innings-');
  });

  it("one section per innings, and the LAST one is open — decided and live alike", () => {
    for (const [label, d] of [
      ["decided", DECIDED],
      ["live", LIVE],
    ] as const) {
      const html = render(d);
      expect(html, label).toContain('data-testid="mc-innings-1"');
      expect(html, label).toContain('data-testid="mc-innings-2"');
      expect(isOpen(html, "mc-innings-2"), label).toBe(true);
      expect(isOpen(html, "mc-innings-1"), label).toBe(false);
    }
    // Three innings: still the last, never merely "not the first".
    const three = render(SUPER_OVER);
    expect(isOpen(three, "mc-innings-3")).toBe(true);
    expect(isOpen(three, "mc-innings-1")).toBe(false);
    expect(isOpen(three, "mc-innings-2")).toBe(false);
  });

  it("the summary row carries the side, the innings number, the total — and 'super over' only when it is one", () => {
    const html = render(SUPER_OVER);
    expect(html).toContain("Mumbai Kings");
    expect(html).toContain("156/6");
    expect(html).toContain("(20.0)");
    expect(html).toContain(en["matchCentre.superOver"]);
    // The positive pair: an innings list with no super over does not say it.
    expect(render(DECIDED)).not.toContain(en["matchCentre.superOver"]);
  });

  it("batting rows carry mc-bat-<personId>, and the dismissal Msg is RESOLVED, both params interpolated", () => {
    const html = render(RICH_ONLY);
    expect(html).toContain('data-testid="mc-bat-p-rohit"');
    expect(html).toContain('data-testid="mc-bat-p-suryakumar"');
    expect(html).toContain("R. Sharma");
    // The whole sentence, not just a fragment: "c {fielder} b {bowler}".
    expect(html).toContain("c S. Patel b J. Bumrah");
    expect(html).toContain(en["matchCentre.dismissal.not_out"]);
    // The dismissal rides on its own second line, marked `dis` — the brief's
    // hook for Task 15's screenshots. Anchored on the class LIST boundary, not
    // on `class="dis"` alone, which would forbid the layout classes beside it.
    expect(html).toMatch(/class="dis[ "]/);
    // Runs and balls are always present.
    expect(html).toContain(">62<");
    expect(html).toContain(">41<");
  });

  it("did-not-bat, extras and total lines", () => {
    const html = render(RICH_ONLY);
    expect(html).toContain('data-testid="mc-dnb-1"');
    expect(html).toContain("J. Bumrah");
    expect(html).toContain("T. Boult");
    expect(html).toContain(en["matchCentre.didNotBat"]);
    expect(html).toContain('data-testid="mc-extras-1"');
    expect(html).toContain("12 (b 2, lb 3, w 6, nb 1)");
    expect(html).toContain(en["matchCentre.extras"]);
    expect(html).toContain('data-testid="mc-total-1"');
    expect(html).toContain(en["matchCentre.total"]);
    expect(html).toContain("7.80");

    // Positive pairs for the two "hidden when absent" lines.
    const coarse = render(COARSE_ONLY);
    expect(coarse).not.toContain('data-testid="mc-extras-2"'); // extrasLine null
    expect(coarse).not.toContain('data-testid="mc-dnb-2"'); // didNotBat empty
    expect(coarse).toContain('data-testid="mc-total-2"'); // …but the total still renders
  });

  it("band 2: the optional columns are ABSENT; band 3: PRESENT", () => {
    const optional = [
      "matchCentre.col.fours",
      "matchCentre.col.sixes",
      "matchCentre.col.maidens",
      "matchCentre.col.wides",
      "matchCentre.col.noBalls",
    ] as const;

    const coarse = render(COARSE_ONLY);
    for (const key of optional) expect(coarse, key).not.toContain(`title="${en[key]}"`);

    const rich = render(RICH_ONLY);
    for (const key of optional) expect(rich, key).toContain(`title="${en[key]}"`);

    // The always-present columns are present in BOTH — otherwise "absent"
    // could just mean the tables did not render at all.
    for (const key of [
      "matchCentre.col.batter",
      "matchCentre.col.runs",
      "matchCentre.col.balls",
      "matchCentre.col.bowler",
      "matchCentre.col.overs",
      "matchCentre.col.wickets",
    ] as const) {
      expect(coarse, key).toContain(`title="${en[key]}"`);
      expect(rich, key).toContain(`title="${en[key]}"`);
    }
    // Band 2 also has no strike rate or economy.
    expect(coarse).not.toContain(`title="${en["matchCentre.col.strikeRate"]}"`);
    expect(rich).toContain(`title="${en["matchCentre.col.strikeRate"]}"`);
  });

  it("fall of wickets joins entries with ' · ' and is omitted when empty", () => {
    const html = render(RICH_ONLY);
    expect(html).toContain('data-testid="mc-fow-line-1"');
    expect(html).toContain(en["matchCentre.fallOfWickets"]);
    expect(html).toContain("1-24 (R. Sharma, 3.2) · 2-88 (I. Kishan, 11.5)");

    const coarse = render(COARSE_ONLY);
    expect(coarse).not.toContain('data-testid="mc-fow-line-2"');
  });

  it("both tables are reachable overflow regions, not clipped boxes", () => {
    // Standing rule from the phone-composition wave: an overflow whose extra
    // content is REACHABLE is a feature, one inside an overflow-hidden box is a
    // defect — and any new scrolling region owes tabindex + role + a name, or
    // axe reds at SERIOUS impact.
    const html = render(RICH_ONLY);
    const regions = html.match(/<div[^>]*class="[^"]*overflow-x-auto[^"]*"[^>]*>/g) ?? [];
    expect(regions.length).toBeGreaterThanOrEqual(2);
    for (const region of regions) {
      expect(region).toContain('tabindex="0"');
      expect(region).toContain('role="region"');
      expect(region).toMatch(/aria-label="[^"]+"/);
    }
  });

  it("no dictionary key leaks into the markup unresolved", () => {
    // `t()` returns the KEY on a miss, so a key spelled one way in the code and
    // another way in the dictionary renders the key itself to a spectator. That
    // is invisible to a testid-only assertion, so it is asserted directly.
    for (const d of [EMPTY, DECIDED, LIVE, COARSE_ONLY, RICH_ONLY, SUPER_OVER]) {
      const html = render(d);
      expect(html).not.toContain("matchCentre.");
      expect(html).not.toContain("public.matchCentre");
    }
  });
});

describe("ScorecardTab dictionary coverage", () => {
  it("every dismissal kind the ENGINE declares has a template in all four locales", () => {
    // Derived from `CricketWicket.shape.kind.options`, never a list typed here:
    // a new mode of dismissal added to the engine must move this test.
    const kinds = CricketWicket.shape.kind.options;
    expect(kinds.length).toBe(10);
    const missing: string[] = [];
    for (const key of [
      ...kinds.map((k) => `matchCentre.dismissal.${k}`),
      "matchCentre.dismissal.not_out",
      "matchCentre.dismissal.out_unknown",
    ]) {
      for (const [locale, d] of Object.entries(LOCALES)) {
        if (typeof d[key] !== "string") missing.push(`${locale}:${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every column label exists in all four locales, and all keys are BARE", () => {
    const keys = [
      "matchCentre.innings",
      "matchCentre.superOver",
      "matchCentre.didNotBat",
      "matchCentre.extras",
      "matchCentre.total",
      "matchCentre.fallOfWickets",
      "matchCentre.col.batter",
      "matchCentre.col.bowler",
      "matchCentre.col.runs",
      "matchCentre.col.balls",
      "matchCentre.col.fours",
      "matchCentre.col.sixes",
      "matchCentre.col.strikeRate",
      "matchCentre.col.overs",
      "matchCentre.col.maidens",
      "matchCentre.col.wickets",
      "matchCentre.col.economy",
      "matchCentre.col.wides",
      "matchCentre.col.noBalls",
    ];
    const missing: string[] = [];
    for (const key of keys) {
      expect(key.startsWith("public.")).toBe(false);
      for (const [locale, d] of Object.entries(LOCALES)) {
        if (typeof d[key] !== "string") missing.push(`${locale}:${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
