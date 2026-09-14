// Public Schedule tab (doc 09 §2) — node-env test: renderToStaticMarkup only
// (no jsdom in this repo, same convention as bracket.test.tsx).
//
// P6 fix round 1, finding #2 (CRITICAL): this is a Client Component with no
// safe way to call msgFor() itself (server-only), so it must NEVER resolve a
// slot label on its own — every unfilled slot's text has to arrive already
// resolved via the `slotLabels` prop (built server-side by the caller from
// the org's own default_locale). These tests prove the component actually
// USES that prop (not silently falling back to English msg()) and that a
// truncated name carries a `title` (finding #5).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Schedule, type ScheduleCopy } from "../schedule";
import type { PublicFixture } from "@/server/public-site/data";

const F = (over: Partial<PublicFixture>): PublicFixture => ({
  id: "f1",
  division_id: "d1",
  stage_id: "s1",
  pool_id: null,
  round_no: 1,
  seq_in_round: 1,
  home_entrant_id: null,
  away_entrant_id: null,
  home_slot_label: null,
  away_slot_label: null,
  scheduled_at: "2026-09-25T09:00:00.000Z",
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

const entrantNames = { e1: "Real Team" };
// N1d d5 and N1e e5 made these props required. These cases are about slot
// labels, venue names and stage order, so the round names, phrases and locale
// are neutral pass-throughs; what the callers put in them is pinned by the
// embed and division page tests and schedule-org-locale.test.ts.
const ROUND_LABELS: Record<string, string> = {};
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
const LOCALE = "en";
// N1e e1 made stage order a prop; these cases hold one stage, so it is empty.
const STAGE_ORDER: Record<string, number> = {};

describe("public Schedule — slotLabels prop (P6 finding #2)", () => {
  it("renders the caller's pre-resolved slotLabels text for both unfilled sides, not English msg()", () => {
    const fixtures = [F({ id: "final" })];
    const html = renderToStaticMarkup(
      createElement(Schedule, {
        fixtures,
        entrantNames,
        divisionPath: "/shared/org/comp/div",
        tz: "UTC",
        roundLabels: ROUND_LABELS,
        copy: COPY,
        locale: LOCALE,
        stageOrder: STAGE_ORDER,
        slotLabels: { "final:home": "Ganador del Grupo A", "final:away": "Ganador del Grupo B" },
      }),
    );
    expect(html).toContain("Ganador del Grupo A");
    expect(html).toContain("Ganador del Grupo B");
    // Never falls through to the English default when the map has the key.
    expect(html).not.toContain("Winner of Group");
    expect(html).not.toMatch(/>TBD</);
  });

  it("a real entrant on one side and a slotLabels entry on the other render distinctly", () => {
    const fixtures = [F({ id: "semi", home_entrant_id: "e1", away_entrant_id: null })];
    const html = renderToStaticMarkup(
      createElement(Schedule, {
        fixtures,
        entrantNames,
        divisionPath: "/shared/org/comp/div",
        tz: "UTC",
        roundLabels: ROUND_LABELS,
        copy: COPY,
        locale: LOCALE,
        stageOrder: STAGE_ORDER,
        slotLabels: { "semi:away": "Runner-up of Group C" },
      }),
    );
    expect(html).toContain("Real Team");
    expect(html).toContain("Runner-up of Group C");
  });

  it("falls back to the client-safe English default ONLY when slotLabels has no entry for that key (defensive, should not happen in practice)", () => {
    const fixtures = [F({ id: "mystery" })];
    const html = renderToStaticMarkup(
      createElement(Schedule, {
        fixtures,
        entrantNames,
        divisionPath: "/shared/org/comp/div",
        tz: "UTC",
        roundLabels: ROUND_LABELS,
        copy: COPY,
        locale: LOCALE,
        stageOrder: STAGE_ORDER,
        slotLabels: {},
      }),
    );
    expect(html).toMatch(/>TBD</);
  });

  it("a truncated name carries a title with its own full text (finding #5)", () => {
    const fixtures = [F({ id: "final" })];
    const html = renderToStaticMarkup(
      createElement(Schedule, {
        fixtures,
        entrantNames,
        divisionPath: "/shared/org/comp/div",
        tz: "UTC",
        roundLabels: ROUND_LABELS,
        copy: COPY,
        locale: LOCALE,
        stageOrder: STAGE_ORDER,
        slotLabels: {
          "final:home": "Best 2 of the 3-place teams",
          "final:away": "Winner of Group B",
        },
      }),
    );
    expect(html).toContain('title="Best 2 of the 3-place teams"');
    expect(html).toContain('title="Winner of Group B"');
  });
});

describe("public Schedule — court_name/venue_name, never the frozen court_label/venue (P9 pass 4c)", () => {
  it("renders the resolved court_name and venue_name when they disagree with the frozen court_label/venue", () => {
    const fixtures = [
      F({
        id: "f1",
        scheduled_at: "2026-09-25T09:00:00.000Z",
        venue: "Stale Freetext Venue",
        court_label: "Stale Freetext Court",
        venue_name: "Riverside Sports Hall",
        court_name: "Show Court 3",
      }),
    ];
    const html = renderToStaticMarkup(
      createElement(Schedule, {
        fixtures,
        entrantNames,
        divisionPath: "/shared/org/comp/div",
        tz: "UTC",
        roundLabels: ROUND_LABELS,
        copy: COPY,
        locale: LOCALE,
        stageOrder: STAGE_ORDER,
        slotLabels: {},
      }),
    );
    expect(html).toContain("Show Court 3");
    expect(html).toContain("Riverside Sports Hall");
    expect(html).not.toContain("Stale Freetext Court");
    expect(html).not.toContain("Stale Freetext Venue");
  });
});

// N1e e1 (review-n1d I1) — `round_no` restarts in every stage, and the round
// view used to walk every fixture by (round_no, seq_in_round) across ALL
// stages, so a league-then-knockout division read "Round 1 · Semi-finals ·
// Round 2 · Final · Round 3". Groups now follow the stage's `seq` first, then
// the round, and a round name is grouped per stage.
describe("public Schedule — the round view reads stage by stage, then round (N1e e1)", () => {
  type StageSpec = { id: string; seq: number; rounds: { no: number; name: string; matches: number }[] };

  /** Untimed fixtures (so the round view is the one rendered), fed in the
   *  interleaved order the bug produced: by round_no across stages. */
  function build(stages: StageSpec[]) {
    const fixtures: PublicFixture[] = [];
    const roundLabels: Record<string, string> = {};
    for (const stage of stages) {
      for (const round of stage.rounds) {
        for (let m = 1; m <= round.matches; m += 1) {
          const id = `${stage.id}-r${round.no}-m${m}`;
          fixtures.push(F({ id, stage_id: stage.id, round_no: round.no, seq_in_round: m, scheduled_at: null }));
          roundLabels[id] = round.name;
        }
      }
    }
    fixtures.sort((a, b) => a.round_no - b.round_no || a.seq_in_round - b.seq_in_round);
    const stageOrder = Object.fromEntries(stages.map((st) => [st.id, st.seq]));
    return { fixtures, roundLabels, stageOrder };
  }

  const render = (stages: StageSpec[]) => {
    const { fixtures, roundLabels, stageOrder } = build(stages);
    return renderToStaticMarkup(
      createElement(Schedule, {
        fixtures,
        entrantNames,
        divisionPath: "/shared/org/comp/div",
        tz: "UTC",
        slotLabels: {},
        roundLabels,
        copy: COPY,
        locale: LOCALE,
        stageOrder,
      }),
    );
  };

  /** Each group heading's own text, in document order. */
  const headings = (html: string) => [...html.matchAll(/<h3[^>]*>([^<]+)</g)].map((m) => m[1]);
  /** The expected headings, read off the input: stages by seq, rounds by number. */
  const expected = (stages: StageSpec[]) =>
    [...stages].sort((a, b) => a.seq - b.seq).flatMap((st) => [...st.rounds].sort((a, b) => a.no - b.no).map((r) => r.name));

  it("a league (seq 1) then a knockout (seq 2), handed in the other order: every league round, then the semi-finals, then the final", () => {
    const stages: StageSpec[] = [
      { id: "ko", seq: 2, rounds: [{ no: 1, name: "(semi-finals)", matches: 2 }, { no: 2, name: "(final)", matches: 1 }] },
      {
        id: "league",
        seq: 1,
        rounds: [
          { no: 1, name: "(league round 1)", matches: 2 },
          { no: 2, name: "(league round 2)", matches: 2 },
          { no: 3, name: "(league round 3)", matches: 2 },
        ],
      },
    ];
    expect(expected(stages)).toEqual(["(league round 1)", "(league round 2)", "(league round 3)", "(semi-finals)", "(final)"]);
    expect(headings(render(stages))).toEqual(expected(stages));
  });

  it("two stages whose rounds share a name are two groups, each in its own stage's place", () => {
    const stages: StageSpec[] = [
      { id: "group-b", seq: 2, rounds: [{ no: 1, name: "(round 1)", matches: 1 }, { no: 2, name: "(round 2)", matches: 1 }] },
      { id: "group-a", seq: 1, rounds: [{ no: 1, name: "(round 1)", matches: 1 }, { no: 2, name: "(round 2)", matches: 1 }] },
    ];
    const html = render(stages);
    expect(headings(html)).toEqual(["(round 1)", "(round 2)", "(round 1)", "(round 2)"]);
    // Each group holds only its own stage's match: the first "(round 1)" group
    // links group-a's fixture, and the stage-b fixture appears after it.
    const aAt = html.indexOf("/fixtures/group-a-r1-m1");
    const bAt = html.indexOf("/fixtures/group-b-r1-m1");
    const secondRound1 = html.indexOf(">(round 1)<", html.indexOf(">(round 1)<") + 1);
    expect(aAt).toBeGreaterThan(-1);
    expect(aAt).toBeLessThan(secondRound1);
    expect(bAt).toBeGreaterThan(secondRound1);
  });
});
