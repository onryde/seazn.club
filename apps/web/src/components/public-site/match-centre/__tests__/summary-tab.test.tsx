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
import fr from "@/dictionaries/fr/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { MatchCentreDoc, type MatchCentreDocT } from "@/server/public-site/match-centre-schema";
import type { LiveFixtureData } from "../../live-score-data";
import { MatchCentre } from "../match-centre";
import { SummaryTab } from "../summary-tab";

const dict = en as Dict;
const frDict = fr as Dict;

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
  derivedComplete: true,
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
  derivedComplete: true,
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
  derivedComplete: true,
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
  it("PRE-PLAY cricket (no live block, no performers, no innings) renders the scorebug, not a blank tab, and no mc-* cricket blocks", () => {
    const html = renderToStaticMarkup(<SummaryTab doc={emptyDoc} dict={dict} data={liveFixtureFor(emptyDoc)} />);
    // Positive: the scorebug (LiveScoreBody's fallback headline) is
    // present — round 3: keeps its ORIGINAL copy on its own key,
    // `matchCentre.status.notStarted` ("Not started"), per the product
    // owner's ruling (round 2 briefly routed it through
    // matchCentre.status.scheduled instead, changing the copy a live
    // Playwright spec asserts on the legacy fixture page).
    expect(html).toContain(dict["matchCentre.status.notStarted"] as string);
    // Negative: none of the cricket-specific blocks a "blank tab" would lack anyway.
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

  // Defect round 15b — axe measured the top-performer detail line ("SR …",
  // "Econ …" in the real product; `finalDoc`'s fixture detail strings here)
  // at 3.45:1 on `bg-surface` (walkthrough evidence), short of WCAG AA's
  // 4.5:1 — the `/80` opacity stacked on `text-ink-muted`'s own colour. This
  // workspace has no jsdom, so contrast itself can't be computed here (the
  // e2e `axe: …` test in spectator-public-2.spec.ts measures the real
  // ratio) — this pins the CLASS the fix depends on: no opacity modifier,
  // the same unmodified token used one line above for `p.line` (`text-sm
  // text-ink-muted`, not flagged) and documented at ≈4.6:1 on white
  // (glyphs.tsx:12).
  it("a top performer's detail line uses the unmodified text-ink-muted token — no stacked opacity modifier", () => {
    const html = renderToStaticMarkup(<SummaryTab doc={finalDoc} dict={dict} data={liveFixtureFor(finalDoc)} />);
    const detailMatches = [...html.matchAll(/<p class="([^"]*)">(?:6 fours, 3 sixes|4 overs)<\/p>/g)];
    expect(detailMatches.length).toBe(2); // one per top performer (batter + bowler)
    for (const m of detailMatches) {
      expect(m[1]).toMatch(/(^|\s)text-ink-muted(\s|$)/);
      expect(m[1]).not.toContain("text-ink-muted/");
    }
  });

  it("the fall-of-wickets rail is a focusable, labelled list, with the label's real VALUE from the dictionary", () => {
    const html = renderToStaticMarkup(<SummaryTab doc={cricketDoc} dict={dict} data={liveFixtureFor(cricketDoc)} />);
    expect(html).toContain('data-testid="mc-fow-1"');
    expect(html).toContain('role="list"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain(`aria-label="${dict["matchCentre.fallOfWickets"] as string}"`);
  });

  // Review fix round 2 (IMPORTANT 1, corrected) — the name cell only
  // truncates under `table-fixed` layout with every NUMERIC column claiming
  // an explicit width (only honoured under fixed layout) so the name column
  // — which carries NO width utility itself — takes the remainder. A first
  // attempt gave the name cell `w-full max-w-0`, which gives the inner
  // `block truncate` span a used width of ZERO (clips every name to
  // nothing) — corrected to no width class at all on the name cell/span.
  it("the batters table is table-fixed, every numeric header has an explicit width, and the name span is exactly 'block truncate'", () => {
    const html = renderToStaticMarkup(<SummaryTab doc={cricketDoc} dict={dict} data={liveFixtureFor(cricketDoc)} />);
    expect(html).toMatch(/<table class="[^"]*\btable-fixed\b[^"]*"/);
    // Every numeric <th> (R, B, 4s, 6s, SR for batters) carries a `w-` class.
    const numericHeaderMatches = [...html.matchAll(/<th scope="col" title="[^"]*" class="([^"]*)">(?:R|B|4s|6s|SR)<\/th>/g)];
    expect(numericHeaderMatches.length).toBeGreaterThan(0);
    for (const m of numericHeaderMatches) {
      expect(m[1]).toMatch(/\bw-\d+\b/);
    }
    // The name span's class list is EXACTLY "block truncate" — no max-w-0,
    // no min-w-0, no width utility of any kind.
    const nameSpanMatch = html.match(/data-testid="mc-stat-name-cell"[^>]*><span class="([^"]*)">/);
    expect(nameSpanMatch?.[1]).toBe("block truncate");
  });

  // Review round 2 minor — the NAME column's header needed the SAME
  // scope="col" + sr-only-text treatment as the numeric headers; a `title`
  // attribute alone is not reliably announced by a screen reader.
  it("the NAME column's header also carries scope=col and an sr-only span with real text", () => {
    const html = renderToStaticMarkup(<SummaryTab doc={cricketDoc} dict={dict} data={liveFixtureFor(cricketDoc)} />);
    const nameHeaderMatch = html.match(/<th scope="col" title="([^"]*)" class="[^"]*"><span class="sr-only">([^<]*)<\/span><\/th>/);
    expect(nameHeaderMatch).not.toBeNull();
    expect(nameHeaderMatch?.[1]).toBe(dict["matchCentre.col.batter"] as string);
    expect(nameHeaderMatch?.[2]).toBe(dict["matchCentre.col.batter"] as string);
  });

  // Review round 2 minor — the batting StatTable's `batters.length > 0`
  // guard (matching the pre-existing bowling guard) had no test proving it
  // actually suppresses the table when empty.
  it("an empty batters array renders NO batting table at all (the length>0 guard)", () => {
    // The visible "At the crease" <p> LABEL is unconditional (shared with
    // the StatTable's own sr-only caption text), so counting occurrences of
    // that string can't tell "label only" apart from "label + table" — the
    // StatTable's OWN `<caption>`/`<table>` elements are the unambiguous
    // signal: normally 2 (batting + bowling), 1 with batters empty.
    const fullHtml = renderToStaticMarkup(<SummaryTab doc={cricketDoc} dict={dict} data={liveFixtureFor(cricketDoc)} />);
    expect(fullHtml.match(/<table class="[^"]*"/g)?.length).toBe(2); // positive pair: normally batting + bowling

    const noBattersDoc: MatchCentreDocT = {
      ...cricketDoc,
      cricket: { ...cricketDoc.cricket!, live: { ...cricketDoc.cricket!.live!, batters: [] } },
    };
    const html = renderToStaticMarkup(<SummaryTab doc={noBattersDoc} dict={dict} data={liveFixtureFor(noBattersDoc)} />);
    expect(html).toContain('data-testid="mc-live-block"'); // the block itself still renders (bowling, this-over, etc.)
    expect(html.match(/<table class="[^"]*"/g)?.length).toBe(1); // bowling only — the batting table is gone
    expect(html.match(/data-testid="mc-stat-name-cell"/g)?.length).toBe(1); // one row left: the bowler
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

describe("SummaryTab — the toss line (Task 14, contract notes 8b review gap)", () => {
  const tossDoc: MatchCentreDocT = {
    ...cricketDoc,
    fixtureId: "fx-toss",
    cricket: {
      ...cricketDoc.cricket!,
      toss: { key: "matchCentre.toss", params: { side: "Home XI", elected: "bat" } },
    },
  };

  beforeAll(() => {
    MatchCentreDoc.parse(tossDoc);
  });

  it("a doc WITH a toss renders one line under the live block, in English", () => {
    const html = renderToStaticMarkup(<SummaryTab doc={tossDoc} dict={dict} data={liveFixtureFor(tossDoc)} />);
    expect(html).toContain('data-testid="mc-toss"');
    expect(html).toContain("Home XI won the toss, elected to bat");
  });

  it("a doc WITHOUT a toss (cricketDoc's own toss: null) renders no mc-toss line — the positive pair above", () => {
    const html = renderToStaticMarkup(<SummaryTab doc={cricketDoc} dict={dict} data={liveFixtureFor(cricketDoc)} />);
    expect(html).not.toContain('data-testid="mc-toss"');
  });

  it("rendered with the FRENCH dict: the French toss sentence appears, 'bat' is swapped for the localised term, and no raw {elected}/params ever leaks", () => {
    const html = renderToStaticMarkup(<SummaryTab doc={tossDoc} dict={frDict} data={liveFixtureFor(tossDoc)} />);
    expect(html).toContain('data-testid="mc-toss"');
    // The whole French sentence, `elected` swapped for `term.bat` — proves
    // BOTH the outer Msg (`matchCentre.toss`) and the enum param went
    // through the French dictionary, not the English fallback.
    expect(html).toContain(
      `Home XI a gagné le tirage au sort, a choisi ${frDict["term.bat"] as string}`,
    );
    expect(html).not.toContain("elected to bat"); // no English leak
    expect(html).not.toContain("{elected}"); // no unfilled param leak
  });

  it("'bowl' is swapped for its own localised term, distinct from 'bat' — a positive/negative pair on the enum's OTHER member", () => {
    const bowlDoc: MatchCentreDocT = {
      ...tossDoc,
      cricket: { ...tossDoc.cricket!, toss: { key: "matchCentre.toss", params: { side: "Away XI", elected: "bowl" } } },
    };
    const html = renderToStaticMarkup(<SummaryTab doc={bowlDoc} dict={frDict} data={liveFixtureFor(bowlDoc)} />);
    expect(html).toContain(frDict["term.bowl"] as string);
    expect(html).not.toContain(frDict["term.bat"] as string);
  });
});

describe("SummaryTab — non-cricket", () => {
  it("a non-cricket doc renders LiveScoreBody's own fallback headline and none of the cricket testids", () => {
    const html = renderToStaticMarkup(
      <SummaryTab doc={nonCricketDoc} dict={dict} data={liveFixtureFor(nonCricketDoc)} />,
    );
    // LiveScoreBody's own headline fallback (live-score.tsx) — round 3:
    // its own key, matchCentre.status.notStarted ("Not started"), per the
    // product owner's ruling (see match-centre.test.tsx for the full why).
    expect(html).toContain(dict["matchCentre.status.notStarted"] as string);
    expect(html).not.toContain('data-testid="mc-live-block"');
    expect(html).not.toContain('data-testid="mc-top-performers"');
    expect(html).not.toContain('data-testid="mc-fow-');
    expect(html).not.toContain('data-testid="mc-partnerships-');
  });

  // Review fix round 2 (IMPORTANT 4) — suppressing LiveScoreBody's own
  // decided-line assumes `header.statusLine` is set for a decided fixture, a
  // contract the server-side document builder owes (recorded, not enforced
  // here). This proves the HAPPY path: when the contract holds, the court
  // card carries the sentence and the summary body shows nothing garbled or
  // empty in its place.
  it("a DECIDED non-cricket fixture with a real outcome AND a set statusLine: court card carries the sentence, summary body has no garbled/empty decided line", () => {
    const decidedDoc: MatchCentreDocT = {
      ...nonCricketDoc,
      fixtureId: "fx-decided-noncricket",
      header: {
        ...nonCricketDoc.header,
        status: "decided",
        live: false,
        statusLine: { key: "org.competitionsBy", params: { org: "Home XI won by 20 runs" } },
      },
    };
    const initial: LiveFixtureData = {
      status: "decided",
      summary: null,
      outcome: { kind: "win", winner: "home" },
      match_centre: decidedDoc,
    };
    const html = renderToStaticMarkup(
      <MatchCentre fixtureId={decidedDoc.fixtureId} initial={initial} realtime={false} dict={dict} locale="en" tabParam={null} />,
    );
    expect(html).toContain('data-testid="mc-status-line"');
    expect(html).toContain("Competitions run by Home XI won by 20 runs"); // positive pair — the court card carries it
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("NaN");
  });
});

describe("no raw i18n key leaks into any match-centre component", () => {
  it("MatchCentre's full render (court card + tab rail + summary tab, the RICH cricket doc) contains the real live block AND no raw key anywhere", () => {
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
    // Positive pair — a placeholder (or a blank/failed render) would also
    // satisfy the negative assertions below; this proves the tree actually
    // rendered the rich cricket content, not an empty shell.
    expect(html).toContain('data-testid="mc-live-block"');
    // Negative: neither a stray "public." prefix (the bug this describe
    // block was written to catch) nor a bare "matchCentre.xxx" raw key
    // (the shape a MISSING or renamed key would leak as) appears anywhere.
    expect(html).not.toMatch(/\bpublic\.[a-zA-Z]/);
    expect(html).not.toMatch(/\bmatchCentre\.[a-z]/);
  });
});
