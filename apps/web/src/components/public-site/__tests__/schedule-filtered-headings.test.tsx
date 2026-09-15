// N1g g1 (review-n1f I1) — whether a round heading names its stage must not
// depend on the entrant filter.
//
// N1f f2 prefixed the stage ("Plate · Final") on a round name that more than
// one stage produces, but it counted the stages over the fixtures LEFT AFTER
// the entrant filter. In a knockout + plate division, a spectator who filtered
// to a team that dropped into the plate and reached its final saw a bare
// "Final" — telling them their team was in THE final — and the same group read
// "Plate · Final" again the moment the filter was cleared. Duplication is a
// fact about the division, so it is now decided over the division's whole
// fixture list, by `sharedRoundNames`.
//
// Node vitest has no DOM, so nothing here can operate the filter <select>.
// The component's own state is preset instead: `react`'s `useState` is wrapped
// so the entrant filter's state (the one initialised to "") opens at the
// entrant a test names, and every other hook is React's own. The markup then
// proves the preset took (the option is `selected`, the other side's fixtures
// are gone) before any heading is read.
import { describe, expect, it, vi } from "vitest";
import type { PublicFixture } from "@/server/public-site/data";

const { filter } = vi.hoisted(() => ({ filter: { entrant: "" } }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const useState = ((initial: unknown) =>
    initial === "" && filter.entrant !== ""
      ? [filter.entrant, () => undefined]
      : actual.useState(initial)) as typeof actual.useState;
  return { ...actual, useState };
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Schedule, sharedRoundNames, type ScheduleCopy } from "../schedule";

const F = (over: Partial<PublicFixture>): PublicFixture => ({
  id: "f",
  division_id: "d1",
  stage_id: "s",
  pool_id: null,
  round_no: 1,
  seq_in_round: 1,
  home_entrant_id: null,
  away_entrant_id: null,
  home_slot_label: null,
  away_slot_label: null,
  scheduled_at: null, // untimed, so the round view is the one rendered
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

const COPY: ScheduleCopy = {
  timeTbd: "(time tbd)",
  allEntrants: "(all entrants)",
  live: "(live)",
  ended: "(ended)",
  tbd: "(tbd)",
  filterLabel: "(filter)",
  viewLabel: "(view)",
  viewDay: "(day)",
  viewRound: "(round)",
  calendar: "(calendar)",
  timesIn: "(times in {zone})",
  empty: "(empty)",
};

// A main draw and its plate. Both end in a round the namer calls "(final)";
// each has one round no other stage shares. "e6" plays ONLY the plate final.
const STAGE_NAMES = { main: "(main draw)", plate: "(plate)" };
const STAGE_ORDER = { main: 1, plate: 2 };
const FIXTURES: PublicFixture[] = [
  F({ id: "m-sf1", stage_id: "main", round_no: 1, seq_in_round: 1, home_entrant_id: "e1", away_entrant_id: "e2" }),
  F({ id: "m-sf2", stage_id: "main", round_no: 1, seq_in_round: 2, home_entrant_id: "e3", away_entrant_id: "e4" }),
  F({ id: "m-final", stage_id: "main", round_no: 2, seq_in_round: 1, home_entrant_id: "e1", away_entrant_id: "e3" }),
  F({ id: "p-r1", stage_id: "plate", round_no: 1, seq_in_round: 1, home_entrant_id: "e2", away_entrant_id: "e4" }),
  F({ id: "p-final", stage_id: "plate", round_no: 2, seq_in_round: 1, home_entrant_id: "e2", away_entrant_id: "e6" }),
];
const ROUND_LABELS: Record<string, string> = {
  "m-sf1": "(semi-finals)",
  "m-sf2": "(semi-finals)",
  "m-final": "(final)",
  "p-r1": "(plate round 1)",
  "p-final": "(final)",
};
const ENTRANTS = { e1: "One", e2: "Two", e3: "Three", e4: "Four", e6: "Six" };
const SEP = "·";

function render(entrant: string): string {
  filter.entrant = entrant;
  try {
    return renderToStaticMarkup(
      createElement(Schedule, {
        fixtures: FIXTURES,
        entrantNames: ENTRANTS,
        divisionPath: "/shared/org/comp/div",
        tz: "UTC",
        slotLabels: {},
        roundLabels: ROUND_LABELS,
        stageOrder: STAGE_ORDER,
        stageNames: STAGE_NAMES,
        copy: COPY,
        locale: "en",
      }),
    );
  } finally {
    filter.entrant = "";
  }
}

const headings = (html: string) => [...html.matchAll(/<h3[^>]*>([^<]+)</g)].map((m) => m[1]);
const links = (html: string) => [...html.matchAll(/\/fixtures\/([\w-]+)"/g)].map((m) => m[1]);
/** The fixtures an entrant plays in, read off the input. */
const playedBy = (entrant: string) =>
  FIXTURES.filter((f) => f.home_entrant_id === entrant || f.away_entrant_id === entrant).map((f) => f.id);

describe("sharedRoundNames — duplication is a fact about the division (N1g g1)", () => {
  it("names the round two stages both produce, and no round only one stage produces", () => {
    expect([...sharedRoundNames(FIXTURES, ROUND_LABELS)]).toEqual(["(final)"]);
  });

  it("counts STAGES, not fixtures: a name repeated inside one stage is not shared", () => {
    const oneStage = [
      F({ id: "a", stage_id: "only", round_no: 1, seq_in_round: 1 }),
      F({ id: "b", stage_id: "only", round_no: 1, seq_in_round: 2 }),
    ];
    expect(sharedRoundNames(oneStage, { a: "(final)", b: "(final)" }).size).toBe(0);
  });

  it("names a fixture with no label by its round number, as the round view heads it", () => {
    const unlabelled = [F({ id: "x", stage_id: "s1", round_no: 3 }), F({ id: "y", stage_id: "s2", round_no: 3 })];
    expect([...sharedRoundNames(unlabelled, {})]).toEqual(["3"]);
  });
});

describe("public Schedule — a round heading reads the same whoever the filter is on (N1g g1)", () => {
  it("unfiltered: both finals name their stage, the unique rounds do not", () => {
    const html = render("");
    expect(links(html).sort()).toEqual(FIXTURES.map((f) => f.id).sort());
    expect(headings(html)).toEqual([
      "(semi-finals)",
      `(main draw) ${SEP} (final)`,
      "(plate round 1)",
      `(plate) ${SEP} (final)`,
    ]);
  });

  it("filtered to an entrant who plays ONLY the plate final: the heading still reads Plate · Final", () => {
    const html = render("e6");
    // The premise, witnessed in the markup: the filter is on e6, and only e6's
    // fixture is left — the main draw's final is gone.
    expect(html).toContain('<option value="e6" selected="">');
    expect(links(html)).toEqual(playedBy("e6"));
    expect(links(html)).not.toContain("m-final");
    expect(headings(html)).toEqual([`(plate) ${SEP} (final)`]);
  });

  it("filtered to an entrant in both stages: the unique rounds stay unprefixed, the shared one keeps its stage", () => {
    const html = render("e2");
    expect(html).toContain('<option value="e2" selected="">');
    expect(links(html).sort()).toEqual(playedBy("e2").sort());
    expect(headings(html)).toEqual(["(semi-finals)", "(plate round 1)", `(plate) ${SEP} (final)`]);
  });
});
