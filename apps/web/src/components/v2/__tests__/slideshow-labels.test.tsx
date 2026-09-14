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
import { cloneElement, createElement, type ReactElement } from "react";
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

import PresentDivisionPage from "@/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/present/page";
import PresentCompetitionPage from "@/app/(public)/shared/[orgSlug]/[competitionSlug]/present/page";
import { Slideshow } from "@/components/v2/slideshow";
import type { BracketSlideFixture, FixtureSlideItem, Slide } from "@/server/slideshow-data";
import { slideshowLabels } from "@/server/slideshow-labels";
import { getDictionary } from "@/lib/i18n";
import { t } from "@/lib/i18n-runtime";

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
    rows: [{ rank: 1, name: "Mexico", played: 3, won: 3, drawn: 0, lost: 0, points: 9 }],
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
});
