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
import { restByeExtKey } from "@/lib/fixture-bye";

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
  bye: "(bye {name})",
};
const LOCALE = "en";
// N1e e1 made stage order a prop, and N1f f2 the stage NAMES; these cases
// hold one stage, so both are empty.
const STAGE_ORDER: Record<string, number> = {};
const STAGE_NAMES: Record<string, string> = {};

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
        stageNames: STAGE_NAMES,
        stageKinds: {},
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
        stageNames: STAGE_NAMES,
        stageKinds: {},
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
        stageNames: STAGE_NAMES,
        stageKinds: {},
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
        stageNames: STAGE_NAMES,
        stageKinds: {},
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
        stageNames: STAGE_NAMES,
        stageKinds: {},
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
  type StageSpec = { id: string; seq: number; name: string; rounds: { no: number; name: string; matches: number }[] };

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
    const stageNames = Object.fromEntries(stages.map((st) => [st.id, st.name]));
    return { fixtures, roundLabels, stageOrder, stageNames };
  }

  const render = (stages: StageSpec[], namesOverride?: Record<string, string>) => {
    const { fixtures, roundLabels, stageOrder, stageNames } = build(stages);
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
        stageNames: namesOverride ?? stageNames,
        stageKinds: {},
      }),
    );
  };

  /** Each group heading's own text, in document order. */
  const headings = (html: string) => [...html.matchAll(/<h3[^>]*>([^<]+)</g)].map((m) => m[1]);
  /** The expected headings, read off the input: stages by seq, rounds by number,
   *  with the stage named in front of any round name more than one STAGE
   *  produces (N1f f2). Derived here rather than typed, so a change to the
   *  input moves the expectation with it. */
  const expected = (stages: StageSpec[]) => {
    const stagesPerName = new Map<string, Set<string>>();
    for (const st of stages) {
      for (const r of st.rounds) {
        const seen = stagesPerName.get(r.name) ?? new Set<string>();
        seen.add(st.id);
        stagesPerName.set(r.name, seen);
      }
    }
    return [...stages]
      .sort((a, b) => a.seq - b.seq)
      .flatMap((st) =>
        [...st.rounds]
          .sort((a, b) => a.no - b.no)
          .map((r) => ((stagesPerName.get(r.name)?.size ?? 0) > 1 ? `${st.name} \u00b7 ${r.name}` : r.name)),
      );
  };

  it("a league (seq 1) then a knockout (seq 2), handed in the other order: every league round, then the semi-finals, then the final", () => {
    const stages: StageSpec[] = [
      { id: "ko", seq: 2, name: "(knockout)", rounds: [{ no: 1, name: "(semi-finals)", matches: 2 }, { no: 2, name: "(final)", matches: 1 }] },
      {
        id: "league",
        seq: 1,
        name: "(league)",
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

  it("two stages whose rounds share a name are two groups, each named by its stage (N1f f2)", () => {
    const stages: StageSpec[] = [
      { id: "group-b", seq: 2, name: "(group B)", rounds: [{ no: 1, name: "(round 1)", matches: 1 }, { no: 2, name: "(round 2)", matches: 1 }] },
      { id: "group-a", seq: 1, name: "(group A)", rounds: [{ no: 1, name: "(round 1)", matches: 1 }, { no: 2, name: "(round 2)", matches: 1 }] },
    ];
    const html = render(stages);
    // Both stages open a "(round 1)" and a "(round 2)", so all four headings
    // carry their stage: without it a spectator reads the same two words
    // twice with nothing telling the brackets apart (review-n1e m1).
    expect(expected(stages)).toEqual([
      "(group A) \u00b7 (round 1)",
      "(group A) \u00b7 (round 2)",
      "(group B) \u00b7 (round 1)",
      "(group B) \u00b7 (round 2)",
    ]);
    expect(headings(html)).toEqual(expected(stages));
    // Each group still holds only its own stage's match: group-a's fixture is
    // under the first heading, group-b's after the third.
    const aAt = html.indexOf("/fixtures/group-a-r1-m1");
    const bAt = html.indexOf("/fixtures/group-b-r1-m1");
    const groupBFirst = html.indexOf(">(group B) \u00b7 (round 1)<");
    expect(aAt).toBeGreaterThan(-1);
    expect(groupBFirst).toBeGreaterThan(-1);
    expect(aAt).toBeLessThan(groupBFirst);
    expect(bAt).toBeGreaterThan(groupBFirst);
  });

  it("names the stage ONLY on the round name the two stages share; a unique heading is untouched (N1f f2)", () => {
    const stages: StageSpec[] = [
      {
        id: "main",
        seq: 1,
        name: "(main draw)",
        rounds: [{ no: 1, name: "(semi-finals)", matches: 2 }, { no: 2, name: "(final)", matches: 1 }],
      },
      {
        id: "plate",
        seq: 2,
        name: "(plate)",
        rounds: [{ no: 1, name: "(plate round 1)", matches: 2 }, { no: 2, name: "(final)", matches: 1 }],
      },
    ];
    // "(final)" is produced by both stages; "(semi-finals)" and "(plate round
    // 1)" by one each.
    expect(expected(stages)).toEqual([
      "(semi-finals)",
      "(main draw) \u00b7 (final)",
      "(plate round 1)",
      "(plate) \u00b7 (final)",
    ]);
    expect(headings(render(stages))).toEqual(expected(stages));
  });

  it("falls back to the bare round name when the caller knows no name for the stage", () => {
    const stages: StageSpec[] = [
      { id: "a", seq: 1, name: "(A)", rounds: [{ no: 1, name: "(final)", matches: 1 }] },
      { id: "b", seq: 2, name: "(B)", rounds: [{ no: 1, name: "(final)", matches: 1 }] },
    ];
    // The positive pair: with the names, both headings carry them.
    expect(headings(render(stages))).toEqual(["(A) \u00b7 (final)", "(B) \u00b7 (final)"]);
    // With an empty map there is nothing to name them with, so the heading is
    // the round name alone — never a dangling separator.
    const bare = headings(render(stages, {}));
    expect(bare).toEqual(["(final)", "(final)"]);
    expect(bare.some((h) => h.includes("\u00b7"))).toBe(false);
  });
});

// #850 (owner ruling 2026-09-24, third round) — on a public surface a
// round-robin rest bye is a NOTE in its round, "X has a bye": no time, no TBD,
// no "vs Bye", no link, never a result. A Swiss or bracket bye is unchanged.
// Every case pins WHERE the note sits (the row right before it is a match of
// its own round) and what it SAYS, and the Swiss twin proves the same row
// shape still renders as a fixture where the bye scores.
describe("public Schedule — a round-robin rest bye is a note in its round (#850)", () => {
  const NAMES = { a: "Alder", b: "Birch", c: "Cedar", d: "Damson", e: "Elm" };
  const match = (id: string, round: number, home: string, away: string, at: string | null, stage = "lg") =>
    F({ id, stage_id: stage, round_no: round, seq_in_round: 1, home_entrant_id: home, away_entrant_id: away, scheduled_at: at });
  const restBye = (id: string, round: number, holder: string, stage = "lg") =>
    F({
      id,
      stage_id: stage,
      round_no: round,
      seq_in_round: 3,
      home_entrant_id: holder,
      away_entrant_id: null,
      away_slot_label: { key: "bracket.slot.bye", params: {} },
      scheduled_at: null,
      status: "forfeited",
      outcome: { kind: "award", winner: holder },
      // The rest-bye MARKER, spelled by the generator's own function.
      ext_key: restByeExtKey("", round),
    });
  const roundLabels = (ids: [string, number][]) => Object.fromEntries(ids.map(([id, n]) => [id, `(round ${n})`]));
  const render = (fixtures: PublicFixture[], stageKinds: Record<string, string>) =>
    renderToStaticMarkup(
      createElement(Schedule, {
        fixtures,
        entrantNames: NAMES,
        divisionPath: "/shared/org/comp/div",
        tz: "UTC",
        roundLabels: roundLabels(fixtures.map((f) => [f.id, f.round_no])),
        copy: COPY,
        locale: LOCALE,
        stageOrder: { lg: 1, sw: 1 },
        stageNames: {},
        stageKinds,
        slotLabels: Object.fromEntries(
          fixtures.flatMap((f) => (f.away_entrant_id ? [] : [[`${f.id}:away`, "(bye slot)"]])),
        ),
      }),
    );
  /** Every `<li>` in render order: a match (by its fixture link) or a note. */
  const items = (html: string) =>
    [...html.matchAll(/<li([^>]*)>([\s\S]*?)<\/li>/g)].map((m) =>
      m[1]!.includes('data-testid="schedule-bye"')
        ? `note:${m[2]!.replace(/<!-- -->/g, "").replace(/<[^>]*>/g, "")}`
        : `match:${/fixtures\/([\w-]+)"/.exec(m[2]!)?.[1]}`,
    );

  it("day view: the note sits after its round's LAST match on the day it finishes, names the round, and carries no time", () => {
    const html = render(
      [
        match("r1a", 1, "a", "b", "2026-09-25T09:00:00.000Z"),
        match("r2a", 2, "a", "c", "2026-09-25T10:00:00.000Z"),
        match("r1b", 1, "c", "d", "2026-09-25T11:00:00.000Z"),
        restBye("bye1", 1, "e"),
      ],
      { lg: "league" },
    );
    expect(items(html)).toEqual(["match:r1a", "match:r2a", "match:r1b", "note:(round 1) · (bye Elm)"]);
    const note = /<li[^>]*data-testid="schedule-bye"[^>]*>[\s\S]*?<\/li>/.exec(html)![0];
    expect(note).not.toContain("href");
    expect(note).not.toContain("(tbd)");
    expect(note).not.toContain("(ended)");
    expect(note).not.toContain("(bye slot)");
    // No "Time TBD" group was opened for the untimed bye.
    expect(html).not.toContain("(time tbd)");
  });

  it("round view (nothing timed yet): the note closes its own round's group, without a round prefix", () => {
    const html = render(
      [
        match("r1a", 1, "a", "b", null),
        match("r1b", 1, "c", "d", null),
        restBye("bye1", 1, "e"),
        match("r2a", 2, "a", "e", null),
        restBye("bye2", 2, "d"),
      ],
      { lg: "league" },
    );
    expect(items(html)).toEqual(["match:r1a", "match:r1b", "note:(bye Elm)", "match:r2a", "note:(bye Damson)"]);
    // The round headings are the matches' own; the notes add no group.
    expect([...html.matchAll(/<h3[^>]*>([\s\S]*?)<span/g)].map((m) => m[1]!.replace(/<[^>]*>/g, "").trim())).toEqual([
      "(round 1)",
      "(round 2)",
    ]);
  });

  // Owner ruling 2026-09-24 (fourth round): a fed league's walkover has the
  // rest bye's shape in the SAME league but its match key. It keeps its
  // pre-#850 display — a linked fixture row, never the "has a bye" note.
  it("the walkover twin: the SAME row shape in the SAME league, unmarked, is a fixture row, linked, not a note", () => {
    const walkover = { ...restBye("wo", 1, "e"), ext_key: "rr-r1-c3" };
    const html = render([match("r1a", 1, "a", "b", null), walkover], { lg: "league" });
    expect(html).not.toContain('data-testid="schedule-bye"');
    expect(html).toContain("fixtures/wo");
    expect(html).toContain("(bye slot)");
  });

  it("the Swiss twin: the SAME row shape in a Swiss stage is still a fixture row, linked, not a note", () => {
    const html = render([match("sw1", 1, "a", "b", null, "sw"), restBye("swbye", 1, "e", "sw")], { sw: "swiss" });
    expect(html).not.toContain('data-testid="schedule-bye"');
    expect(html).toContain("fixtures/swbye");
    expect(html).toContain("(bye slot)");
  });

  it("without the stage's kind the row cannot be told apart — the prop is what makes it a note", () => {
    const fixtures = [match("r1a", 1, "a", "b", null), restBye("bye1", 1, "e")];
    expect(render(fixtures, { lg: "league" })).toContain('data-testid="schedule-bye"');
    expect(render(fixtures, {})).not.toContain('data-testid="schedule-bye"');
  });
});
