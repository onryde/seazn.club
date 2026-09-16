// N1d d5 — the embeddable schedule widget is a public surface a club pastes
// into its own site, and the client `Schedule` it renders headed its round
// view "Round {round_no}" (a page playoff's Qualifier 1 and Eliminator shared
// one "Round 1"), named the unscheduled day "Time TBD" and the filter's first
// option "All entrants", in English whatever the org's locale. The page now
// hands it every fixture's round NAME from the one public round namer (the
// hub rail's label) and the two phrases from the org-locale dictionary.
//
// The page is called with its data door and analytics mocked, and the
// `Schedule` element it returns is rendered to static markup in its initial
// state: the day view when any fixture has a time, the round view when none
// does. Expected text is read from the dictionary keys, never from the namer.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const embedDivisionData = vi.fn();
vi.mock("@/server/embed-data", () => ({
  embedDivisionData: (...a: unknown[]) => embedDivisionData(...a),
}));
vi.mock("@/lib/posthog-server", () => ({ captureServer: vi.fn(async () => undefined) }));

import { getDictionary } from "@/lib/i18n";
import { t } from "@/lib/i18n-runtime";
import { Schedule } from "@/components/public-site/schedule";
import type { PublicFixture, PublicEntrant } from "@/server/public-site/data";
import type { EmbedPayload } from "@/server/embed-data";
import EmbedWidgetPage from "../page";

const F = (over: Partial<PublicFixture>): PublicFixture => ({
  id: "f1",
  division_id: "d1",
  stage_id: "st",
  pool_id: null,
  round_no: 1,
  seq_in_round: 1,
  home_entrant_id: null,
  away_entrant_id: null,
  home_slot_label: null,
  away_slot_label: null,
  scheduled_at: null,
  venue: null,
  court_label: null,
  venue_name: null,
  court_name: null,
  status: "scheduled",
  outcome: null,
  summary: null,
  last_seq: null,
  ...over,
});

const entrant = (id: string, name: string, seed: number): PublicEntrant => ({
  id,
  division_id: "d1",
  kind: "individual",
  display_name: name,
  seed,
  status: "active",
  members: [],
  team_display: null,
  badge_url: null,
});

/** The payload's own stage kind. Since N1e e4 it names every generated kind,
 *  `page_playoff` included, so the page-playoff case below needs no cast: a
 *  union that dropped it again fails `tsc` here. */
type StageKind = EmbedPayload["stages"][number]["kind"];

type Stage = EmbedPayload["stages"][number];
const oneStage = (kind: StageKind): Stage[] => [{ id: "st", division_id: "d1", seq: 1, kind, name: "Finals", status: "active" }];

const payload = (locale: string, stages: Stage[], fixtures: PublicFixture[]): EmbedPayload => ({
  org: { id: "o1", slug: "test-org", name: "Test Org", default_locale: locale },
  competition: {
    id: "c1",
    org_id: "o1",
    name: "Test Comp",
    slug: "test-comp",
    description: null,
    starts_on: null,
    ends_on: null,
    branding: {},
    status: "active",
    visibility: "public",
  } as EmbedPayload["competition"],
  division: {
    id: "d1",
    competition_id: "c1",
    name: "Open",
    slug: "open",
    description: null,
    sport_key: "generic",
    variant_key: "score",
    status: "active",
    module_version: "1.0.0",
    tiebreakers: null,
    sport_name: null,
    entrant_count: 4,
  } as EmbedPayload["division"],
  stages,
  pools: [],
  fixtures,
  standings: [],
  entrants: [entrant("e1", "Side 1", 1), entrant("e2", "Side 2", 2), entrant("e3", "Side 3", 3), entrant("e4", "Side 4", 4)],
  sponsors: [],
  tz: "UTC",
});

interface ScheduleProps {
  roundLabels: Record<string, string>;
  stageOrder: Record<string, number>;
  stageNames: Record<string, string>;
  copy: { timeTbd: string; allEntrants: string };
  locale: string;
}

/** The page's `Schedule`, its props, and its initial markup. `stages` is one
 *  stage of `kind` (id "st"), or the stages given. */
async function scheduleOf(locale: string, stages: StageKind | Stage[], fixtures: PublicFixture[]) {
  const list = typeof stages === "string" ? oneStage(stages) : stages;
  embedDivisionData.mockResolvedValue({ ok: true, data: payload(locale, list, fixtures) });
  const root = (await EmbedWidgetPage({
    params: Promise.resolve({ id: "d1", widget: "schedule" }),
  })) as ReactElement<{ children: ReactElement<ScheduleProps> }>;
  const schedule = root.props.children;
  expect(schedule.type).toBe(Schedule);
  return { props: schedule.props, html: renderToStaticMarkup(schedule) };
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
/** How many times `text` is rendered as a whole text node. */
const count = (html: string, text: string) => html.split(`>${esc(text)}<`).length - 1;
const shows = (html: string, text: string) => count(html, text) > 0;

const winnerOf = (round: number, seq: number): PublicFixture["home_slot_label"] => ({
  key: "slot.winner_match",
  params: { round, seq },
});

/** A four-draw knockout: two semi-finals, then a final waiting on both. */
const knockout = (semiAt: string | null, finalAt: string | null) => [
  F({ id: "semi-1", round_no: 1, seq_in_round: 1, home_entrant_id: "e1", away_entrant_id: "e2", scheduled_at: semiAt }),
  F({ id: "semi-2", round_no: 1, seq_in_round: 2, home_entrant_id: "e3", away_entrant_id: "e4", scheduled_at: semiAt }),
  F({
    id: "final",
    round_no: 2,
    seq_in_round: 1,
    home_slot_label: winnerOf(1, 1),
    away_slot_label: winnerOf(1, 2),
    scheduled_at: finalAt,
  }),
];

describe("embed schedule widget — rounds by name, phrases in the org's locale (N1d d5)", () => {
  it("en knockout, nothing timed (round view): headed Semi-finals then Final, never 'Round N'", async () => {
    const { props, html } = await scheduleOf("en", "knockout", knockout(null, null));
    const ui = await getDictionary("en", "ui");
    const pub = await getDictionary("en", "public");
    const semi = t(ui, "bracket.round.semi");
    const final = t(ui, "bracket.round.final");

    expect(props.roundLabels).toEqual({ "semi-1": semi, "semi-2": semi, final });
    expect({ semi: count(html, semi), final: count(html, final) }).toEqual({ semi: 1, final: 1 });
    expect(html.indexOf(`>${esc(semi)}<`)).toBeLessThan(html.indexOf(`>${esc(final)}<`));
    for (const n of [1, 2]) expect(shows(html, t(ui, "schedule.round", { n })), `Round ${n}`).toBe(false);
    expect(shows(html, t(pub, "division.filter.allEntrants"))).toBe(true);
  });

  it("en page playoff, fed in reverse (round view): Qualifier 1 and the Eliminator share round 1 but head their own groups, in play order", async () => {
    const rows = [
      F({ id: "q1", round_no: 1, seq_in_round: 1, ext_key: "pp-q1", home_entrant_id: "e1", away_entrant_id: "e2" }),
      F({ id: "el", round_no: 1, seq_in_round: 2, ext_key: "pp-elim", home_entrant_id: "e3", away_entrant_id: "e4" }),
      F({ id: "q2", round_no: 2, seq_in_round: 1, ext_key: "pp-q2" }),
      F({ id: "fin", round_no: 3, seq_in_round: 1, ext_key: "pp-final" }),
    ];
    const { html } = await scheduleOf("en", "page_playoff", [...rows].reverse());
    const ui = await getDictionary("en", "ui");
    const names = ["bracket.round.qualifier1", "bracket.round.eliminator", "bracket.round.qualifier2", "bracket.round.final"].map(
      (k) => t(ui, k),
    );

    expect(names.map((name) => count(html, name))).toEqual([1, 1, 1, 1]);
    const at = names.map((name) => html.indexOf(`>${esc(name)}<`));
    expect(at, `headings in play order: ${names.join(" < ")}`).toEqual([...at].sort((a, b) => a - b));
  });

  it("en, semi-finals timed and the final not (day view): the untimed group is headed with the dictionary's 'Time TBD'", async () => {
    const { props, html } = await scheduleOf("en", "knockout", knockout("2026-09-25T09:00:00.000Z", null));
    const pub = await getDictionary("en", "public");

    // N1e e5: the rest of `copy`, and what `locale` writes, are pinned by
    // components/public-site/__tests__/schedule-org-locale.test.ts.
    expect(props.copy).toMatchObject({
      timeTbd: t(pub, "matchCentre.status.timeTbd"),
      allEntrants: t(pub, "division.filter.allEntrants"),
    });
    expect(props.locale).toBe("en");
    expect(shows(html, t(pub, "matchCentre.status.timeTbd"))).toBe(true);
  });

  // N1e e6 (review-n1d m5): this case probes the round names and these two
  // phrases only; every other word the Schedule shows or announces, and its
  // dates, are probed in components/public-site/__tests__/schedule-org-locale.test.ts.
  it("es org: the round names (Semi-finals, Final, never 'Round N'), 'Time TBD' and 'All entrants' are the es dictionary's, and none of them is left in English", async () => {
    const [uiEn, uiEs, pubEn, pubEs] = await Promise.all([
      getDictionary("en", "ui"),
      getDictionary("es", "ui"),
      getDictionary("en", "public"),
      getDictionary("es", "public"),
    ]);
    const rounds = await scheduleOf("es", "knockout", knockout(null, null));
    const days = await scheduleOf("es", "knockout", knockout("2026-09-25T09:00:00.000Z", null));
    const html = [rounds.html, days.html];

    const spanish = [
      t(uiEs, "bracket.round.semi"),
      t(uiEs, "bracket.round.final"),
      t(pubEs, "division.filter.allEntrants"),
    ];
    for (const text of spanish) expect({ text, shown: shows(rounds.html, text) }).toEqual({ text, shown: true });
    expect(shows(days.html, t(pubEs, "matchCentre.status.timeTbd"))).toBe(true);

    const english = [
      t(uiEn, "bracket.round.semi"),
      t(uiEn, "bracket.round.final"),
      t(uiEn, "schedule.round", { n: 1 }),
      t(uiEn, "schedule.round", { n: 2 }),
      t(pubEn, "division.filter.allEntrants"),
      t(pubEn, "matchCentre.status.timeTbd"),
    ];
    const spanishAll = new Set([...spanish, t(pubEs, "matchCentre.status.timeTbd")]);
    const probes = english.filter((text) => !spanishAll.has(text));
    expect(probes.length, "some English value must differ from es to witness a leak").toBeGreaterThanOrEqual(4);
    expect(probes.filter((text) => html.some((h) => shows(h, text)))).toEqual([]);
  });

  // N1e e1 (review-n1d I1): round_no restarts in every stage, so walking the
  // fixtures by round_no alone interleaved a league with the knockout it feeds.
  it("en league (seq 1) then knockout (seq 2), nothing timed (round view): every league round, then Semi-finals, then Final (N1e e1)", async () => {
    const stages: Stage[] = [
      { id: "ko", division_id: "d1", seq: 2, kind: "knockout", name: "Knockout", status: "active" },
      { id: "lg", division_id: "d1", seq: 1, kind: "league", name: "League", status: "complete" },
    ];
    const league = [1, 2, 3].flatMap((round) => [
      F({ id: `lg-${round}-1`, stage_id: "lg", round_no: round, seq_in_round: 1, home_entrant_id: "e1", away_entrant_id: "e2" }),
      F({ id: `lg-${round}-2`, stage_id: "lg", round_no: round, seq_in_round: 2, home_entrant_id: "e3", away_entrant_id: "e4" }),
    ]);
    const ko = knockout(null, null).map((f) => ({ ...f, id: `ko-${f.id}`, stage_id: "ko" }));
    // Handed in the order that interleaved them: by round_no across stages.
    const fixtures = [...ko, ...league].sort((a, b) => a.round_no - b.round_no || a.seq_in_round - b.seq_in_round);

    const { props, html } = await scheduleOf("en", stages, fixtures);
    const ui = await getDictionary("en", "ui");
    // Each stage's rounds, named from the dictionary for its kind.
    const namesFor: Record<string, string[]> = {
      league: [1, 2, 3].map((n) => t(ui, "bracket.round.plain", { n })),
      knockout: [t(ui, "bracket.round.semi"), t(ui, "bracket.round.final")],
    };
    const expected = [...stages].sort((a, b) => a.seq - b.seq).flatMap((stage) => namesFor[stage.kind]!);

    expect(props.stageOrder).toEqual(Object.fromEntries(stages.map((st) => [st.id, st.seq])));
    expect(props.stageNames).toEqual(Object.fromEntries(stages.map((st) => [st.id, st.name])));
    const headings = [...html.matchAll(/<h3[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(headings).toEqual(expected.map(esc));
  });

  // N1f f2 (review-n1e m1): a knockout and its plate both end in a "Final", so
  // the round view showed the same two headings twice with nothing telling the
  // brackets apart. Driven through the page's real round namer and the real
  // Schedule, not a fixture on both ends.
  it("en two knockout stages, both ending in a Final: every shared heading names its stage (N1f f2)", async () => {
    const stages: Stage[] = [
      { id: "main", division_id: "d1", seq: 1, kind: "knockout", name: "Main draw", status: "active" },
      { id: "plate", division_id: "d1", seq: 2, kind: "knockout", name: "Plate", status: "active" },
    ];
    const fixtures = [
      ...knockout(null, null).map((f) => ({ ...f, id: `main-${f.id}`, stage_id: "main" })),
      ...knockout(null, null).map((f) => ({ ...f, id: `plate-${f.id}`, stage_id: "plate" })),
    ];
    const { props, html } = await scheduleOf("en", stages, fixtures);
    const ui = await getDictionary("en", "ui");
    const rounds = [t(ui, "bracket.round.semi"), t(ui, "bracket.round.final")];
    // The premise: the namer gives the two stages the SAME round names.
    expect(new Set(rounds).size).toBe(2);
    expect(props.stageNames).toEqual(Object.fromEntries(stages.map((st) => [st.id, st.name])));
    const headings = [...html.matchAll(/<h3[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(headings).toEqual(
      [...stages]
        .sort((a, b) => a.seq - b.seq)
        .flatMap((st) => rounds.map((r) => esc(`${st.name} \u00b7 ${r}`))),
    );
  });
});
