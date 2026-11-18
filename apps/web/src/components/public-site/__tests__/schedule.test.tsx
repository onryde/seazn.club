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
  held: "(held)",
  filterLabel: "(filter)",
  viewLabel: "(view)",
  viewDay: "(day)",
  viewRound: "(round)",
  calendar: "(calendar)",
  timesIn: "(times in {zone})",
  empty: "(empty)",
  roundOpened: "(opened)",
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
        divisionPath: "/live/org/comp/div",
        tz: "UTC",
        roundLabels: ROUND_LABELS,
        copy: COPY,
        locale: LOCALE,
        stageOrder: STAGE_ORDER,
        stageNames: STAGE_NAMES,
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
        divisionPath: "/live/org/comp/div",
        tz: "UTC",
        roundLabels: ROUND_LABELS,
        copy: COPY,
        locale: LOCALE,
        stageOrder: STAGE_ORDER,
        stageNames: STAGE_NAMES,
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
        divisionPath: "/live/org/comp/div",
        tz: "UTC",
        roundLabels: ROUND_LABELS,
        copy: COPY,
        locale: LOCALE,
        stageOrder: STAGE_ORDER,
        stageNames: STAGE_NAMES,
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
        divisionPath: "/live/org/comp/div",
        tz: "UTC",
        roundLabels: ROUND_LABELS,
        copy: COPY,
        locale: LOCALE,
        stageOrder: STAGE_ORDER,
        stageNames: STAGE_NAMES,
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
        divisionPath: "/live/org/comp/div",
        tz: "UTC",
        roundLabels: ROUND_LABELS,
        copy: COPY,
        locale: LOCALE,
        stageOrder: STAGE_ORDER,
        stageNames: STAGE_NAMES,
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
        divisionPath: "/live/org/comp/div",
        tz: "UTC",
        slotLabels: {},
        roundLabels,
        copy: COPY,
        locale: LOCALE,
        stageOrder,
        stageNames: namesOverride ?? stageNames,
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

// W2a fix round 1 (M5): a HELD bracket match (`needs_decision`) was played — level — and only who advances is owed. The
// row read like an unplayed fixture (its kick-off time, no score); it reads Ended with both score lines, as a decided
// match does, with neither name bolded (nobody won).
describe("public Schedule — a held match reads Ended with its score (W2a fix round 1, M5)", () => {
  const render = (over: Partial<PublicFixture>) =>
    renderToStaticMarkup(
      createElement(Schedule, {
        fixtures: [
          F({
            id: "final",
            home_entrant_id: "e1",
            away_entrant_id: "e2",
            summary: { headline: "1 — 1", perSide: [{ entrantId: "e1", line: "1" }, { entrantId: "e2", line: "1" }] } as never,
            ...over,
          }),
        ],
        entrantNames: { e1: "Riverside", e2: "Summit" },
        divisionPath: "/live/org/comp/div",
        tz: "UTC",
        roundLabels: ROUND_LABELS,
        copy: COPY,
        locale: LOCALE,
        stageOrder: STAGE_ORDER,
        stageNames: STAGE_NAMES,
        slotLabels: {},
      }),
    );
  const scoreCells = (html: string) => (html.match(/font-display text-lg tabular-nums/g) ?? []).length;

  it("needs_decision: the rail says Ended and both score lines show, like a decided match", () => {
    const held = render({ status: "needs_decision" });
    expect(held).toContain("(ended)");
    expect(held).not.toContain("09:00");
    expect(scoreCells(held), "both sides' score lines").toBe(2);
    // The positive pairs: a decided match reads the same; a scheduled one reads its time and no score.
    const decided = render({ status: "decided" });
    expect(decided).toContain("(ended)");
    expect(scoreCells(decided)).toBe(2);
    const scheduled = render({ status: "scheduled", summary: null });
    expect(scheduled).not.toContain("(ended)");
    expect(scheduled).toContain("09:00");
    expect(scoreCells(scheduled)).toBe(0);
  });
});

// B5 owner fix-now (d), RB5-W2: a withdrawal under half EXPUNGES the leaver's lines (stored `abandoned`, an active
// `core.abandon{expunge:true}` - `PublicFixture.expunged`). The public Schedule read them as matches still to play: "TBD" in the
// rail and the summary's 0–0 (or – – –) pill. The organiser's division page presents the same line struck through with its status
// word on the row and no score; the public row now does the same (no time, the word in the score's place), the word being the public dictionary's own
// `matchCentre.status.abandoned` (the match centre the row opens says the same) - no new words.
// differential: today the rail reads the TBD word and the row carries the 0–0 pill.
describe("public Schedule - an expunged leaver's line reads as removed, not to be played (RB5-W2)", () => {
  const COPY_X: ScheduleCopy = { ...COPY, abandoned: "(abandoned)" };
  const render = (rows: Partial<PublicFixture>[], copy: ScheduleCopy = COPY_X) =>
    renderToStaticMarkup(
      createElement(Schedule, {
        fixtures: rows.map((r, i) => F({ id: `f${i}`, seq_in_round: i + 1, home_entrant_id: "e1", away_entrant_id: "e2", scheduled_at: null, ...r })),
        entrantNames: { e1: "Riverside", e2: "Summit" },
        divisionPath: "/live/org/comp/div",
        tz: "UTC",
        roundLabels: ROUND_LABELS,
        copy,
        locale: LOCALE,
        stageOrder: STAGE_ORDER,
        stageNames: STAGE_NAMES,
        slotLabels: {},
      }),
    );
  /** One row's markup: from its link to the next. */
  const rowOf = (html: string, id: string) => {
    const href = html.indexOf(`href="/live/org/comp/div/fixtures/${id}"`);
    expect(href, `premise: row ${id} rendered`).toBeGreaterThanOrEqual(0);
    const at = html.lastIndexOf("<a ", href);
    const end = html.indexOf("</a>", at);
    return html.slice(at, end);
  };
  const ZERO = { headline: "0–0", perSide: [{ entrantId: "e1", line: "0" }, { entrantId: "e2", line: "0" }] };

  it("empty case first: a schedule with no expunged line renders exactly as before (the rail TBD, no struck name)", () => {
    const html = render([{ status: "scheduled", summary: null }]);
    expect(rowOf(html, "f0")).toContain(">(tbd)<");
    expect(html).not.toContain("line-through");
    expect(html).not.toContain("(abandoned)");
    expect(html).not.toContain('data-expunged="true"');
  });

  it("an unplayed expunged line: the status word in the score's place, no TBD, both names struck, no 0–0 - beside an untouched scheduled line", () => {
    const html = render([
      { status: "abandoned", expunged: true, has_active_abandon: true, summary: ZERO },
      { status: "scheduled", summary: null },
    ]);
    const gone = rowOf(html, "f0");
    expect(gone, "the status word where the 0–0 was").toContain(">(abandoned)<");
    expect(gone, "never TBD").not.toContain(">(tbd)<");
    expect(gone, "no 0–0 pill").not.toContain("0–0");
    expect((gone.match(/line-through/g) ?? []).length, "both names struck").toBe(2);
    expect(gone).toContain('data-expunged="true"');
    const live = rowOf(html, "f1");
    expect(live).toContain(">(tbd)<");
    expect(live).not.toContain("line-through");
    expect(live).not.toContain("data-expunged");
  });

  it("a PLAYED line whose result the withdrawal removed: no score lines either (its 3–0 no longer counts)", () => {
    const html = render([
      { status: "abandoned", expunged: true, has_active_abandon: true, outcome: null,
        summary: { headline: "3–0", perSide: [{ entrantId: "e1", line: "3" }, { entrantId: "e2", line: "0" }] } },
    ]);
    const row = rowOf(html, "f0");
    expect(row).toContain(">(abandoned)<");
    expect(row).not.toContain("3–0");
    expect(row).not.toContain('data-testid="schedule-score"');
  });

  it("a held abandon that is NOT an expunge (a scorer's abandon awaiting its settle) is not struck: only the withdrawal's removal is", () => {
    const html = render([{ status: "abandoned", expunged: false, has_active_abandon: true, summary: null }]);
    expect(html).not.toContain("line-through");
    expect(html).not.toContain("(abandoned)");
  });

  it("the word is the public dictionary's own matchCentre.status.abandoned, in all four locales (publicScheduleCopy)", async () => {
    const { getDictionary } = await import("@/lib/i18n");
    const { publicScheduleCopy } = await import("@/server/public-site/schedule-copy");
    let checked = 0;
    for (const locale of ["en", "es", "fr", "nl"] as const) {
      const file = (await import(`@/dictionaries/${locale}/public.json`)).default as Record<string, string>;
      const want = file["matchCentre.status.abandoned"]!;
      expect(want, `${locale}: premise, the word exists`).toBeTruthy();
      const copy = publicScheduleCopy(await getDictionary(locale, "public"), () => "TBD");
      expect(copy.abandoned, locale).toBe(want);
      expect(rowOf(render([{ status: "abandoned", expunged: true, summary: ZERO }], copy), "f0"), locale).toContain(`>${want}<`);
      checked += 1;
    }
    expect(checked, "anti-vacuity: four locales").toBe(4);
  });
});
