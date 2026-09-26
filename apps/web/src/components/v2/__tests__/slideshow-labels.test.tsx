// R10e u1: the public /present kiosk speaks the org's language.
//
// <Slideshow> hardcoded its chrome in English ("Scheduled", "Live", "Back",
// the standings columns, the bracket lane names, ...), so an es org's kiosk
// showed es slides (N1c) inside an English board. Every string now comes from
// `slideshowLabels(locale)`, resolved on the server; the public present pages
// pass the org's `default_locale`.
//
// Expectations are DERIVED from the dictionaries (getDictionary + t), never
// typed in. The positive half reads the es catalog. The negative half reads
// the en catalog and asserts none of its values render, skipping any en value
// es spells identically ("vs", "Final", "Pts"): those cannot witness a leak.
// Each negative has its positive pair: the same board in an en org DOES show
// the en value, so the probe can see English when it is there.
import { describe, expect, it, vi } from "vitest";
import { cloneElement, createElement, type CSSProperties, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { getPublicDivision, getPublicCompetition } = vi.hoisted(() => ({
  getPublicDivision: vi.fn(),
  getPublicCompetition: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("@/server/public-site/data", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPublicDivision,
  getPublicCompetition,
}));

import PresentDivisionPage from "@/app/(public)/shared/(kiosk)/[orgSlug]/[competitionSlug]/[divisionSlug]/present/page";
import PresentCompetitionPage from "@/app/(public)/shared/(kiosk)/[orgSlug]/[competitionSlug]/present/page";
import { Slideshow } from "@/components/v2/slideshow";
import type { BracketSlideFixture, FixtureSlideItem, Slide } from "@/server/slideshow-data";
import { slideshowLabels, type SlideshowLabels } from "@/server/slideshow-labels";
import { getDictionary } from "@/lib/i18n";
import { t } from "@/lib/i18n-runtime";
import { LOCALES } from "@/lib/i18n-constants";
import { ratioText } from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";

/** Every plain `ui` key the board renders. */
const PLAIN_KEYS = [
  "slideshow.exit",
  "slideshow.back",
  "chip.live",
  "slideshow.empty.title",
  "slideshow.empty.body",
  "slideshow.col.entrant",
  "slideshow.col.played",
  "slideshow.col.won",
  "slideshow.col.drawn",
  "slideshow.col.lost",
  "slideshow.col.points",
  // Shown only on a standings slide whose division ranks on point_ratio (the
  // EVERY_BRANCH standings row below carries one, so the es board renders it).
  "slideshow.col.pointRatio",
  "schedule.vs",
  "bracket.tbd",
  "sponsors.title",
  "bracket.round.final",
  "bracket.winners",
  "bracket.losers",
  "bracket.grandFinal",
  "bracket.reset",
  "bracket.round.qualifier1",
  "bracket.round.eliminator",
  "bracket.round.qualifier2",
  "slideshow.status.scheduled",
  "slideshow.status.ended",
  "slideshow.status.forfeit",
  "slideshow.status.abandoned",
  "slideshow.status.cancelled",
  // C1: the phone card is in the board's markup at every width (CSS hides it
  // from lg up), so its copy is board copy too.
  "slideshow.phoneCard.title",
  "slideshow.phoneCard.openLive",
  "slideshow.phoneCard.showBoard",
] as const;

/** Numbers the boards below render into the templated keys. */
const ROUNDS = [1, 2, 3];
const SLIDE_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const RUNGS = [1, 2];

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
/** Rendered as a whole text node, or as a whole value of an attribute a person
 *  reads or hears. Not any attribute: the bracket's `data-side="L"` is
 *  geometry, and would read as the English "L" (lost) column. */
const shows = (html: string, text: string) =>
  html.includes(`>${esc(text)}<`) ||
  ["aria-label", "title", "alt"].some((attr) => html.includes(`${attr}="${esc(text)}"`));

async function catalogs() {
  const en = await getDictionary("en", "ui");
  const es = await getDictionary("es", "ui");
  const pairs: [string, string][] = [
    ...PLAIN_KEYS.map((k): [string, string] => [t(en, k), t(es, k)]),
    ...ROUNDS.map((round): [string, string] => [t(en, "slideshow.round", { round }), t(es, "slideshow.round", { round })]),
    ...SLIDE_NUMBERS.map((n): [string, string] => [t(en, "slideshow.slideN", { n }), t(es, "slideshow.slideN", { n })]),
    ...RUNGS.map((n): [string, string] => [t(en, "slideshow.rung", { n }), t(es, "slideshow.rung", { n })]),
  ];
  // A missing key renders as its dotted key: refuse that before trusting a value.
  for (const [e, s] of pairs) {
    expect(e.startsWith("slideshow.") || e.startsWith("bracket.")).toBe(false);
    expect(s.startsWith("slideshow.") || s.startsWith("bracket.")).toBe(false);
  }
  const esValues = new Set(pairs.map(([, s]) => s));
  const englishProbes = pairs.map(([e]) => e).filter((e) => !esValues.has(e));
  return { en, es, englishProbes };
}

const leaks = (markups: string[], probes: string[]) => probes.filter((p) => markups.some((h) => shows(h, p)));

/** A board shows one slide at a time: one markup per slide, plus the whole
 *  deck (footer dots, header live chip). */
function renderEachSlide(board: ReactElement<{ slides: Slide[] }>): string[] {
  const slides = board.props.slides;
  return [
    renderToStaticMarkup(board),
    ...slides.map((s) => renderToStaticMarkup(cloneElement(board, { slides: [s] }))),
  ];
}

// --- the public present pages, through the real slide builder ---------------

const DIVISION = {
  division: { id: "d1", name: "Open" },
  stages: [
    { id: "sg", kind: "group", name: "Groups" },
    { id: "sk", kind: "knockout", name: "Knockout" },
  ],
  pools: [{ id: "pA", stage_id: "sg", name: "Pool A" }],
  fixtures: [
    { id: "k1", stage_id: "sk", round_no: 0, seq_in_round: 1, home_entrant_id: "e1", away_entrant_id: "e2", status: "in_play", summary: { headline: "1–0" } },
    { id: "k2", stage_id: "sk", round_no: 0, seq_in_round: 2, home_entrant_id: "e3", away_entrant_id: "e4", status: "scheduled", summary: null },
    { id: "kf", stage_id: "sk", round_no: 1, seq_in_round: 1, home_entrant_id: null, away_entrant_id: null, status: "scheduled", summary: null },
  ],
  standings: [
    {
      stage_id: "sg",
      pool_id: "pA",
      rows: [
        { entrantId: "e1", played: 3, won: 3, drawn: 0, lost: 0, points: 9, rank: 1 },
        { entrantId: "e2", played: 3, won: 0, drawn: 0, lost: 3, points: 0, rank: 2 },
      ],
    },
  ],
  entrants: [
    { id: "e1", display_name: "Mexico" },
    { id: "e2", display_name: "Canada" },
    { id: "e3", display_name: "Japan" },
    { id: "e4", display_name: "Ghana" },
  ],
  competition: { name: "Copa", branding: null },
};

const orgData = (default_locale: string) => ({ ...DIVISION, org: { default_locale } });
const params = <P,>(p: P) => ({ params: Promise.resolve(p) });

describe("public /present kiosk: chrome in the org's locale (R10e u1)", () => {
  it("division kiosk, es org: status, live chip, exit and columns are the es dictionary values; no English", async () => {
    const { es, englishProbes } = await catalogs();
    getPublicDivision.mockResolvedValue(orgData("es"));
    const board = (await PresentDivisionPage(
      params({ orgSlug: "o", competitionSlug: "c", divisionSlug: "d" }),
    )) as ReactElement<{ slides: Slide[] }>;
    const markups = renderEachSlide(board);

    expect(markups.some((h) => shows(h, t(es, "slideshow.status.scheduled")))).toBe(true);
    expect(markups.some((h) => shows(h, t(es, "chip.live")))).toBe(true);
    expect(markups.some((h) => shows(h, t(es, "slideshow.exit")))).toBe(true);
    expect(markups.some((h) => shows(h, t(es, "slideshow.col.entrant")))).toBe(true);
    expect(markups.some((h) => shows(h, t(es, "slideshow.slideN", { n: 1 })))).toBe(true);
    expect(leaks(markups, englishProbes)).toEqual([]);
  });

  it("division kiosk, en org (positive pair): the same probes DO see English", async () => {
    const { en, englishProbes } = await catalogs();
    getPublicDivision.mockResolvedValue(orgData("en"));
    const board = (await PresentDivisionPage(
      params({ orgSlug: "o", competitionSlug: "c", divisionSlug: "d" }),
    )) as ReactElement<{ slides: Slide[] }>;
    const markups = renderEachSlide(board);

    expect(markups.some((h) => shows(h, t(en, "slideshow.status.scheduled")))).toBe(true);
    expect(leaks(markups, englishProbes)).toEqual(
      expect.arrayContaining([t(en, "slideshow.status.scheduled"), t(en, "chip.live"), t(en, "slideshow.exit")]),
    );
  });

  it("competition kiosk, es org: the shell's org locale reaches the board chrome", async () => {
    const { es, englishProbes } = await catalogs();
    getPublicCompetition.mockResolvedValue({
      org: { default_locale: "es" },
      competition: { name: "Copa", branding: null },
      divisions: [{ slug: "open" }],
    });
    getPublicDivision.mockResolvedValue(orgData("es"));
    const board = (await PresentCompetitionPage(
      params({ orgSlug: "o", competitionSlug: "c" }),
    )) as ReactElement<{ slides: Slide[] }>;
    const markups = renderEachSlide(board);

    expect(markups.some((h) => shows(h, t(es, "slideshow.status.scheduled")))).toBe(true);
    expect(markups.some((h) => shows(h, t(es, "slideshow.back")))).toBe(true);
    expect(leaks(markups, englishProbes)).toEqual([]);
  });
});

// --- the Pts ratio column, through the REAL page -> builder -> board ------------
//
// The seam witness for the slideshow's "Pts ratio" column. `slideshow-point-
// ratio.test.ts` drives the builders and `slideshow-tv-rows.test.tsx` the board
// from hand-built slides; what neither shows is the two meeting through the
// page a screen actually loads: `getPublicDivision`'s division (module version,
// cascade) and snapshot rows (with their `metrics`) spread into
// `buildPublicDivisionSlides`, whose slides reach `<Slideshow>`. A page that
// stopped passing the division through, or a builder type that dropped a field
// the page still sends, would leave every one of those suites green.
//
// Expected values are DERIVED: the label from each locale's own catalog, the
// cell from the engine's `ratioText`, and the sport that must NOT get the column
// is the first shipped module whose default cascade lacks `point_ratio` (the
// very same rows, ledger included — only the division's module differs).
const RATIO_SPORT = builtinModules.find((m) => m.key === "badminton")!;
const NO_RATIO_SPORT = builtinModules.find((m) => !m.defaultTiebreakers.includes("point_ratio"))!;
const LEDGER_WON = 63;
const LEDGER_LOST = 42;

/** The public division with real sport pins and snapshot rows that carry a points ledger. */
const sportData = (
  default_locale: string,
  sport: { key: string; version: string },
  tiebreakers: string[] | null = null,
) => ({
  ...orgData(default_locale),
  division: { id: "d1", name: "Open", sport_key: sport.key, module_version: sport.version, tiebreakers },
  standings: [
    {
      stage_id: "sg",
      pool_id: "pA",
      rows: [
        { entrantId: "e1", played: 3, won: 3, drawn: 0, lost: 0, points: 9, rank: 1, metrics: { points_won: LEDGER_WON, points_lost: LEDGER_LOST } },
        { entrantId: "e2", played: 3, won: 0, drawn: 0, lost: 3, points: 0, rank: 2, metrics: { points_won: LEDGER_LOST, points_lost: LEDGER_WON } },
      ],
    },
  ],
});

async function divisionKioskMarkups(data: object): Promise<string[]> {
  getPublicDivision.mockResolvedValue(data);
  const board = (await PresentDivisionPage(
    params({ orgSlug: "o", competitionSlug: "c", divisionSlug: "d" }),
  )) as ReactElement<{ slides: Slide[] }>;
  return renderEachSlide(board);
}

describe("public /present kiosk: the Pts ratio column, through the real page and builder", () => {
  it("the sports this test names really do split on point_ratio (else the pair below proves nothing)", () => {
    expect(RATIO_SPORT.defaultTiebreakers).toContain("point_ratio");
    expect(NO_RATIO_SPORT.defaultTiebreakers).not.toContain("point_ratio");
  });

  it.each([...LOCALES])("division kiosk, badminton, %s org: the standings slide carries the ratio header in the org's language and both rows' ratios", async (locale) => {
    const dict = await getDictionary(locale, "ui");
    const label = t(dict, "slideshow.col.pointRatio");
    expect(label.startsWith("slideshow."), `${locale} resolves the key`).toBe(false);
    const markups = await divisionKioskMarkups(sportData(locale, RATIO_SPORT));

    expect(markups.some((h) => shows(h, label)), `header "${label}"`).toBe(true);
    // Each row's ratio is over ITS OWN pair: the second row's ledger is the first's reversed.
    expect(markups.some((h) => shows(h, ratioText(LEDGER_WON, LEDGER_LOST, 2))), "row 1").toBe(true);
    expect(markups.some((h) => shows(h, ratioText(LEDGER_LOST, LEDGER_WON, 2))), "row 2").toBe(true);
  });

  it("division kiosk, the SAME rows for a sport that does not rank on point_ratio: no header, no ratio cell (the negative pair)", async () => {
    const en = await getDictionary("en", "ui");
    const markups = await divisionKioskMarkups(sportData("en", NO_RATIO_SPORT));

    expect(markups.some((h) => shows(h, t(en, "slideshow.col.pointRatio")))).toBe(false);
    expect(markups.some((h) => shows(h, ratioText(LEDGER_WON, LEDGER_LOST, 2)))).toBe(false);
    // ...while the board itself rendered its table, so the absence is the cascade's, not an empty board.
    expect(markups.some((h) => shows(h, t(en, "slideshow.col.points")))).toBe(true);
  });

  it("division kiosk: the division's own cascade override is honoured (drop it from badminton: no column)", async () => {
    const en = await getDictionary("en", "ui");
    const dropped = RATIO_SPORT.defaultTiebreakers.filter((k) => k !== "point_ratio");
    const markups = await divisionKioskMarkups(sportData("en", RATIO_SPORT, dropped));
    expect(markups.some((h) => shows(h, t(en, "slideshow.col.pointRatio")))).toBe(false);
    expect(markups.some((h) => shows(h, t(en, "slideshow.col.points")))).toBe(true);
  });

  it("competition kiosk, badminton, es org: the competition board's own spread reaches the builder too", async () => {
    const es = await getDictionary("es", "ui");
    getPublicCompetition.mockResolvedValue({
      org: { default_locale: "es" },
      competition: { name: "Copa", branding: null },
      divisions: [{ slug: "open" }],
    });
    getPublicDivision.mockResolvedValue(sportData("es", RATIO_SPORT));
    const board = (await PresentCompetitionPage(
      params({ orgSlug: "o", competitionSlug: "c" }),
    )) as ReactElement<{ slides: Slide[] }>;
    const markups = renderEachSlide(board);

    expect(markups.some((h) => shows(h, t(es, "slideshow.col.pointRatio")))).toBe(true);
    expect(markups.some((h) => shows(h, ratioText(LEDGER_WON, LEDGER_LOST, 2)))).toBe(true);
  });
});

// --- every branch of the component, es ---------------------------------------

const item = (status: string, round: number, line: string | null = null): FixtureSlideItem => ({
  home: "Mexico",
  away: "Canada",
  homeLogo: null,
  awayLogo: null,
  line,
  status,
  round,
});

const bf = (id: string, round_no: number, seq_in_round: number, home: string | null = "Mexico"): BracketSlideFixture => ({
  id,
  round_no,
  seq_in_round,
  home,
  away: home === null ? null : "Canada",
  home_slot_label: null,
  away_slot_label: null,
  line: null,
  status: "scheduled",
});

const bracket = (stageKind: "knockout" | "double_elim" | "stepladder" | "page_playoff", fixtures: BracketSlideFixture[]): Slide => ({
  kind: "bracket",
  division: "Open",
  title: "Finals",
  stageKind,
  fixtures,
});

const EVERY_BRANCH: Slide[] = [
  {
    kind: "standings",
    division: "Open",
    caption: "Groups — Pool A",
    rows: [{ rank: 1, name: "Mexico", played: 3, won: 3, drawn: 0, lost: 0, points: 9, pointRatio: "1.50" }],
  },
  {
    kind: "fixtures",
    division: "Open",
    title: "Board",
    items: [
      item("in_play", 1, "1–0"),
      item("scheduled", 1),
      item("decided", 2, "2–1"),
      item("finalized", 2, "0–3"),
      item("forfeited", 3),
      item("abandoned", 3),
      item("cancelled", 3),
    ],
  },
  bracket("knockout", [bf("s1", 0, 1), bf("s2", 0, 2), bf("f", 1, 1, null)]),
  bracket("stepladder", [bf("r1", 0, 1), bf("r2", 1, 1), bf("r3", 2, 1)]),
  bracket("double_elim", [
    bf("w1", 0, 1), bf("w2", 0, 2), bf("wf", 1, 1),
    bf("l1", 4, 1), bf("l2", 5, 1),
    bf("gf", 8, 1), bf("gr", 9, 1),
  ]),
  bracket("page_playoff", [bf("q1", 0, 1), bf("el", 0, 2), bf("q2", 1, 1), bf("fin", 2, 1)]),
];

describe("<Slideshow> renders every string from its labels (R10e u1)", () => {
  it("es: every branch shows the es dictionary value and no English", async () => {
    const { es, englishProbes } = await catalogs();
    const board = createElement(Slideshow, {
      title: "Copa",
      slides: EVERY_BRANCH,
      backHref: "/shared/o/c",
      liveHref: "/shared/o/c",
      sponsors: [{ name: "Acme" }],
      labels: slideshowLabels("es"),
    }) as ReactElement<{ slides: Slide[] }>;
    const markups = renderEachSlide(board);
    const empty = renderToStaticMarkup(cloneElement(board, { slides: [] }));
    const all = [...markups, empty];

    const expected = [
      ...PLAIN_KEYS.map((k) => t(es, k)),
      ...ROUNDS.map((round) => t(es, "slideshow.round", { round })),
      ...[1, 2, 3, 4, 5, 6].map((n) => t(es, "slideshow.slideN", { n })),
      ...RUNGS.map((n) => t(es, "slideshow.rung", { n })),
    ];
    const missing = expected.filter((text) => !all.some((h) => shows(h, text)));
    expect(missing).toEqual([]);
    expect(leaks(all, englishProbes)).toEqual([]);
  });

  it("the status column maps each status to its own label (decided and finalized both read 'ended')", async () => {
    const { es } = await catalogs();
    const cell = (status: string) =>
      renderToStaticMarkup(
        createElement(Slideshow, {
          title: "Copa",
          slides: [{ kind: "fixtures", division: "Open", title: "Board", items: [item(status, 1)] }],
          backHref: "/",
          liveHref: "/shared/o/c",
          labels: slideshowLabels("es"),
        }),
      );
    const byStatus: Record<string, string> = {
      scheduled: "slideshow.status.scheduled",
      decided: "slideshow.status.ended",
      finalized: "slideshow.status.ended",
      forfeited: "slideshow.status.forfeit",
      abandoned: "slideshow.status.abandoned",
      cancelled: "slideshow.status.cancelled",
    };
    for (const [status, key] of Object.entries(byStatus)) {
      const html = cell(status);
      expect({ status, shown: shows(html, t(es, key)) }).toEqual({ status, shown: true });
      // No other status's label on this row.
      for (const other of Object.values(byStatus).filter((k) => k !== key && t(es, k) !== t(es, key))) {
        expect({ status, other, shown: shows(html, t(es, other)) }).toEqual({ status, other, shown: false });
      }
    }
    expect(shows(cell("in_play"), t(es, "chip.live"))).toBe(true);
  });

  // review-r10e m3 — the es case above cannot see four of the moved strings,
  // because es spells them exactly as en does: hardcoding "R{round}", "vs",
  // "Pts" or "Final" back into the component would still render the es value.
  // So each is checked in a locale that spells it DIFFERENTLY from en, picked
  // per key out of the fr and nl dictionaries rather than named here.
  it("R{round}, vs, Pts and Final each render from labels, in a locale whose value differs from en", async () => {
    const en = await getDictionary("en", "ui");
    const others = { fr: await getDictionary("fr", "ui"), nl: await getDictionary("nl", "ui") };
    const cases: { key: string; vars?: Record<string, number> }[] = [
      { key: "slideshow.round", vars: { round: 1 } },
      { key: "schedule.vs" },
      { key: "slideshow.col.points" },
      { key: "bracket.round.final" },
    ];
    for (const { key, vars } of cases) {
      const english = t(en, key, vars);
      const locale = (["fr", "nl"] as const).find((l) => t(others[l], key, vars) !== english);
      expect(locale, `${key}: fr or nl must spell "${english}" differently`).toBeDefined();
      const local = t(others[locale!], key, vars);
      const board = createElement(Slideshow, {
        title: "Copa",
        slides: EVERY_BRANCH,
        backHref: "/shared/o/c",
        liveHref: "/shared/o/c",
        labels: slideshowLabels(locale!),
      }) as ReactElement<{ slides: Slide[] }>;
      const all = renderEachSlide(board);
      expect({ key, locale, local, shown: all.some((h) => shows(h, local)) }).toEqual({ key, locale, local, shown: true });
      expect({ key, locale, english, shown: all.some((h) => shows(h, english)) }).toEqual({
        key,
        locale,
        english,
        shown: false,
      });
    }
  });
});

// --- N1d d4: a kiosk fixtures row names its ROUND, never the organiser code ---
//
// The public /present fixtures rows printed `slideshow.round` ("R{round}") over
// the raw round_no, so a double-elimination losers' round read "R3" on a venue
// TV, right beside sides the namer already called "Loser of Semi-finals, match
// 1". The public builder now hands every row its round NAME from the one
// public round namer, and the board renders it. Expected names are read from
// the `bracket.round.*` keys `roundRoleLabel` resolves, never from the namer,
// so a builder that stopped naming cannot move its own expectation.

const DOUBLE_ELIM = {
  division: { id: "d2", name: "Open" },
  stages: [{ id: "de", kind: "double_elim", name: "Double elimination" }],
  pools: [],
  fixtures: [
    { id: "w1", stage_id: "de", lane: "WB", round_no: 1, seq_in_round: 1, home_entrant_id: "e1", away_entrant_id: "e2", status: "decided", summary: { headline: "2–1" } },
    { id: "w2", stage_id: "de", lane: "WB", round_no: 1, seq_in_round: 2, home_entrant_id: "e3", away_entrant_id: "e4", status: "decided", summary: { headline: "3–0" } },
    { id: "wf", stage_id: "de", lane: "WB", round_no: 2, seq_in_round: 1, home_entrant_id: "e1", away_entrant_id: "e3", status: "scheduled", summary: null },
    { id: "l1", stage_id: "de", lane: "LB", round_no: 3, seq_in_round: 1, home_entrant_id: "e2", away_entrant_id: "e4", status: "scheduled", summary: null },
    { id: "lf", stage_id: "de", lane: "LB", round_no: 4, seq_in_round: 1, home_entrant_id: null, away_entrant_id: null, status: "scheduled", summary: null },
    { id: "gf", stage_id: "de", lane: "GF", round_no: 5, seq_in_round: 1, home_entrant_id: null, away_entrant_id: null, status: "scheduled", summary: null },
  ],
  standings: [],
  entrants: DIVISION.entrants,
  competition: { name: "Copa", branding: null },
};

/** Every round the double-elimination board above plays, as its dictionary key:
 *  WB round 1 is the semi-finals, then the winners' final; the losers' lane
 *  runs round 1 then its final; the grand final closes it. */
const DE_ROUND_KEYS: [string, Record<string, number>?][] = [
  ["bracket.round.semi"],
  ["bracket.round.winnersFinal"],
  ["bracket.round.losersRound", { n: 1 }],
  ["bracket.round.losersFinal"],
  ["bracket.round.grandFinal"],
];

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A whole text node shaped like the organiser round code, from the locale's
 *  own `slideshow.round` template ("R{round}" → />R\d+</). */
function roundCode(template: string): RegExp {
  expect(template, "slideshow.round keeps its {round} placeholder").toContain("{round}");
  const [before, after] = template.split("{round}") as [string, string];
  return new RegExp(`>${reEscape(esc(before))}\\d+${reEscape(esc(after))}<`);
}

async function presentDoubleElim(locale: string): Promise<string[]> {
  getPublicDivision.mockResolvedValue({ ...DOUBLE_ELIM, org: { default_locale: locale } });
  const board = (await PresentDivisionPage(
    params({ orgSlug: "o", competitionSlug: "c", divisionSlug: "d" }),
  )) as ReactElement<{ slides: Slide[] }>;
  return renderEachSlide(board);
}

describe("public /present kiosk: fixtures rows name the round, not the organiser code (N1d d4)", () => {
  it("en org: the losers' round row reads 'Losers' round 1', every round is named, and no row prints R{n}", async () => {
    const en = await getDictionary("en", "ui");
    const markups = await presentDoubleElim("en");

    const names = DE_ROUND_KEYS.map(([k, v]) => t(en, k, v));
    expect(names.filter((name) => !markups.some((h) => shows(h, name)))).toEqual([]);
    const code = roundCode(t(en, "slideshow.round"));
    expect(markups.filter((h) => code.test(h))).toEqual([]);

    // Positive pair: the same probe DOES see the code on a board whose rows
    // carry no round name, the organiser board's shape.
    const organiser = renderToStaticMarkup(
      createElement(Slideshow, {
        title: "Copa",
        slides: [{ kind: "fixtures", division: "Open", title: "Board", items: [item("scheduled", 3)] }],
        backHref: "/",
        liveHref: "/shared/o/c",
        labels: slideshowLabels("en"),
      }),
    );
    expect(code.test(organiser)).toBe(true);
  });

  it("es org: every round name is the es dictionary's, with no English round name, chrome or R{n} left", async () => {
    const { en, es, englishProbes } = await catalogs();
    const markups = await presentDoubleElim("es");

    const esNames = DE_ROUND_KEYS.map(([k, v]) => t(es, k, v));
    expect(esNames.filter((name) => !markups.some((h) => shows(h, name)))).toEqual([]);
    const englishNames = DE_ROUND_KEYS.map(([k, v]) => t(en, k, v)).filter((name) => !esNames.includes(name));
    expect(englishNames.length, "some en round name must differ from es to witness a leak").toBeGreaterThan(0);
    expect(leaks(markups, [...englishProbes, ...englishNames])).toEqual([]);
    const code = roundCode(t(es, "slideshow.round"));
    expect(markups.filter((h) => code.test(h))).toEqual([]);
  });
});

// --- C1 (OWNER RULING 2026-09-15): the phone card, on both kiosk pages -------
//
// Below the TV cut-off a board shows a card instead of itself: "This board is
// made for a TV", Open the live page, and Show the board anyway. It replaced
// the "made for a TV" banner (N1d d6). The pages hand the board WHERE the live
// page is; the card's copy rides in the board's own labels, in the org's
// locale. Whether the card or the board shows (CSS classes, the remembered
// choice) is the gate's own logic: kiosk-phone-card.test.tsx and
// e2e/kiosk-phone-card.spec.ts.

/** Where each field of the card's copy comes from. */
const PHONE_CARD_KEYS = {
  title: "slideshow.phoneCard.title",
  openLive: "slideshow.phoneCard.openLive",
  showBoard: "slideshow.phoneCard.showBoard",
} as const;
type PhoneCardField = keyof typeof PHONE_CARD_KEYS;
const PHONE_CARD_FIELDS = Object.keys(PHONE_CARD_KEYS) as PhoneCardField[];

async function phoneCardCopy(locale: Parameters<typeof getDictionary>[0]): Promise<Record<PhoneCardField, string>> {
  const dict = await getDictionary(locale, "ui");
  return Object.fromEntries(PHONE_CARD_FIELDS.map((f) => [f, t(dict, PHONE_CARD_KEYS[f])])) as Record<PhoneCardField, string>;
}

type Board = ReactElement<{ liveHref?: string; labels: SlideshowLabels }>;

/** The rendered card's Open the live page: its opening tag, or a stand-in that no assertion accepts. */
const openLiveTag = (html: string) =>
  /<a\b[^>]*\bdata-testid="kiosk-phone-card-open-live"[^>]*>/.exec(html)?.[0] ?? "(no Open the live page rendered)";

describe("public /present kiosk: the phone card (C1)", () => {
  it("the premise: every field of the card's copy is in each locale's dictionary, and es/fr/nl each spell it differently from en", async () => {
    const en = await phoneCardCopy("en");
    for (const f of PHONE_CARD_FIELDS) expect(en[f], `en ${PHONE_CARD_KEYS[f]} is in the dictionary`).not.toBe(PHONE_CARD_KEYS[f]);
    for (const locale of LOCALES.filter((l) => l !== "en")) {
      const copy = await phoneCardCopy(locale);
      for (const f of PHONE_CARD_FIELDS) {
        expect(copy[f], `${locale} ${PHONE_CARD_KEYS[f]} is in the dictionary`).not.toBe(PHONE_CARD_KEYS[f]);
        expect(copy[f], `${locale} ${PHONE_CARD_KEYS[f]} differs from en`).not.toBe(en[f]);
      }
    }
  });

  it("en is the owner's words, verbatim", async () => {
    expect(await phoneCardCopy("en")).toEqual({
      title: "This board is made for a TV",
      openLive: "Open the live page",
      showBoard: "Show the board anyway",
    });
  });

  it("division kiosk, es org: Open the live page goes to the hub filtered to this division, the card speaks es, and the rendered card links there", async () => {
    const es = await phoneCardCopy("es");
    getPublicDivision.mockResolvedValue(orgData("es"));
    const board = (await PresentDivisionPage(
      params({ orgSlug: "o", competitionSlug: "c", divisionSlug: "d" }),
    )) as Board;

    expect(board.props.liveHref).toBe("/shared/o/c?division=d");
    expect(board.props.labels.phoneCard).toEqual(es);
    expect(board.props, "the retired banner is not handed over").not.toHaveProperty("notice");
    const html = renderToStaticMarkup(board);
    expect(openLiveTag(html)).toContain('href="/shared/o/c?division=d"');
    expect(html).not.toContain("kiosk-tv-hint");
  });

  it("competition kiosk, es org: Open the live page goes to the competition's hub, with no division filter", async () => {
    const es = await phoneCardCopy("es");
    getPublicCompetition.mockResolvedValue({
      org: { default_locale: "es" },
      competition: { name: "Copa", branding: null },
      divisions: [{ slug: "open" }],
    });
    getPublicDivision.mockResolvedValue(orgData("es"));
    const board = (await PresentCompetitionPage(params({ orgSlug: "o", competitionSlug: "c" }))) as Board;

    expect(board.props.liveHref).toBe("/shared/o/c");
    expect(board.props.labels.phoneCard).toEqual(es);
    expect(board.props).not.toHaveProperty("notice");
    expect(openLiveTag(renderToStaticMarkup(board))).toContain('href="/shared/o/c"');
  });

  it("the board's card links the liveHref it is handed, not its back link", () => {
    const html = renderToStaticMarkup(
      createElement(Slideshow, { title: "Copa", slides: [], backHref: "/probe/back", liveHref: "/probe/live", labels: slideshowLabels("en") }),
    );
    expect(openLiveTag(html)).toContain('href="/probe/live"');
    expect(openLiveTag(html)).not.toContain('href="/probe/back"');
  });

  it("the board hands its own palette to the card, so a branded board's card is branded too", () => {
    const palette = { "--ps-accent": "#123456", "--ps-court": "#0a0b0c" } as CSSProperties;
    const html = renderToStaticMarkup(
      createElement(Slideshow, {
        title: "Copa",
        slides: [],
        backHref: "/probe/back",
        liveHref: "/probe/live",
        themeStyle: palette,
        labels: slideshowLabels("en"),
      }),
    );
    const card = /<section\b[^>]*\bdata-testid="kiosk-phone-card"[^>]*>/.exec(html)?.[0] ?? "";
    expect(card, "the card is rendered").not.toBe("");
    expect(card).toContain("--ps-accent:#123456");
    expect(card).toContain("--ps-court:#0a0b0c");
  });
});
