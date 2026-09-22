// The Swiss shape legend (owner-approved 2026-09-22, option B):
//
//   3 rounds · 5 matches + 1 bye per round · 11 fixtures
//
// WHY it exists, and why these tests are shaped the way they are. A live
// defect: a Swiss stage's later rounds kept shells minted for an OLD field
// size after the roster moved, so those rounds offered 4 matches when the
// field needed 5 and the new players had nowhere to sit. It was invisible
// until the organiser opened the fixture list and found a `TBD vs <name>` row.
// The legend puts the number that was silently wrong ON THE SCREEN.
//
// So the middle figure MUST come from the CURRENT active field, never from a
// count of the fixture rows that exist — printing the stale row count as if it
// were correct is precisely the failure this feature exists to make visible.
// `swiss-legend-derives-matches-from-field` below is the test that says so,
// and it is deliberately built on a stage whose row count DISAGREES with
// rounds × matches, so a "count the rows" implementation cannot pass it.
//
// TWO LATER GATES (reviewer-raised, owner-approved 2026-09-22), each with its
// own named tests below because a gate nothing kills is decoration:
//  - `swiss-legend-complete-*`: once a stage is FINISHED the per-round clause
//    is a claim about a field that has stopped mattering, and a post-event
//    disqualification makes an entirely correct stage read as mis-sized. The
//    clause is withheld; `rounds` and `fixtures` are true forever and stay.
//  - `swiss-legend-*-field-suppressed`: a stage is created BEFORE any entrant
//    exists, so "0 matches per round" was the FIRST thing an organiser saw on
//    a new stage. Below two entrants there is no shape to state at all.
import { describe, expect, it } from "vitest";
import {
  SWISS_LEGEND_COMPLETE_STATUSES,
  SWISS_LEGEND_MIN_FIELD,
  swissActiveFieldSize,
  swissStageLegend,
  swissLegendText,
} from "@/lib/swiss-legend";
import { swissBoardsForField } from "@/lib/swiss-shell";
import { DEPARTED_STATUSES } from "@/server/usecases/entrants";
import { EntrantStatus, Stage } from "@/server/api-v1/schemas";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { t as tRuntime, plural as pluralRuntime } from "@/lib/i18n-runtime";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `e${i + 1}`);

/** The real English catalog through the real runtime — never a stub. A stub on
 *  both ends would prove the stub. */
const enI18n = {
  t: (key: string, vars?: Record<string, string | number>) => tRuntime(en, key, vars),
  plural: (key: string, count: number, vars?: Record<string, string | number>) =>
    pluralRuntime(en, key, count, "en", vars),
};

describe("swissActiveFieldSize", () => {
  it("counts every active entrant when the stage has no qualified list", () => {
    expect(swissActiveFieldSize({}, ids(11))).toBe(11);
  });

  it("intersects config.qualified with the active field (a departed qualifier is expunged)", () => {
    // Mirrors generateStageFixturesWrite's non-bracket arm:
    //   entrants = qualified.filter((id) => activeIds.has(id))
    expect(swissActiveFieldSize({ qualified: ["e1", "e2", "gone", "e3"] }, ids(3))).toBe(3);
  });

  it("ignores a non-array config.qualified rather than trusting it", () => {
    expect(swissActiveFieldSize({ qualified: "e1,e2" }, ids(6))).toBe(6);
  });
});

describe("swissStageLegend", () => {
  it("renders nothing for a stage that is not swiss", () => {
    expect(
      swissStageLegend({ kind: "league", status: "active", config: { rounds: 3 }, activeEntrantIds: ids(10), fixtureCount: 45 }),
    ).toBeNull();
  });

  it("renders nothing when the stage declares no usable round count", () => {
    expect(
      swissStageLegend({ kind: "swiss", status: "active", config: {}, activeEntrantIds: ids(10), fixtureCount: 0 }),
    ).toBeNull();
    expect(
      swissStageLegend({ kind: "swiss", status: "active", config: { rounds: 0 }, activeEntrantIds: ids(10), fixtureCount: 0 }),
    ).toBeNull();
    expect(
      swissStageLegend({ kind: "swiss", status: "active", config: { rounds: 2.5 }, activeEntrantIds: ids(10), fixtureCount: 0 }),
    ).toBeNull();
  });

  it("renders nothing when the active field is unknown — never a number it cannot stand behind", () => {
    expect(
      swissStageLegend({ kind: "swiss", status: "active", config: { rounds: 3 }, activeEntrantIds: undefined, fixtureCount: 12 }),
    ).toBeNull();
  });

  it("ODD field: floor(n/2) matches plus a bye", () => {
    expect(
      swissStageLegend({ kind: "swiss", status: "active", config: { rounds: 3 }, activeEntrantIds: ids(11), fixtureCount: 18 }),
    ).toEqual({ rounds: 3, matches: 5, bye: true, fixtures: 18 });
  });

  it("EVEN field: n/2 matches and NO bye", () => {
    expect(
      swissStageLegend({ kind: "swiss", status: "active", config: { rounds: 3 }, activeEntrantIds: ids(10), fixtureCount: 15 }),
    ).toEqual({ rounds: 3, matches: 5, bye: false, fixtures: 15 });
  });

  it("swiss-legend-derives-matches-from-field: a stale stage prints the FIELD number, not the row count", () => {
    // The live defect, reproduced: 3 rounds were minted for a field of 8
    // (4 matches × 3 = 12 rows), then the field grew to 11. The rows still
    // say 4 matches a round; the field says 5 + a bye. The legend must print
    // the FIELD's answer, and the fixture total must stay the row count — the
    // disagreement between them IS the signal.
    const legend = swissStageLegend({
      kind: "swiss",
      status: "active",
      config: { rounds: 3 },
      activeEntrantIds: ids(11),
      fixtureCount: 12,
    });
    expect(legend).not.toBeNull();
    expect(legend!.matches).toBe(5);
    expect(legend!.bye).toBe(true);
    expect(legend!.fixtures).toBe(12);
    // rounds × (matches + bye) = 18 ≠ 12 — the legend does NOT reconcile them.
    expect(legend!.rounds * (legend!.matches! + 1)).not.toBe(legend!.fixtures);
  });

  it("agrees with swissBoardsForField across the whole small-field table, not one lucky sample", () => {
    for (let n = 0; n <= 24; n++) {
      const legend = swissStageLegend({
        kind: "swiss",
        status: "active",
        config: { rounds: 4 },
        activeEntrantIds: ids(n),
        fixtureCount: 0,
      });
      if (n < 2) {
        // The fields too small to pair are suppressed outright — see
        // `swiss-legend-empty-field-suppressed` below.
        expect(legend, `field ${n}`).toBeNull();
        continue;
      }
      const { boards, bye } = swissBoardsForField(n);
      expect(legend, `field ${n}`).toEqual({ rounds: 4, matches: boards, bye, fixtures: 0 });
    }
  });
});

describe("swissStageLegend — a COMPLETE stage keeps its history, not a live claim", () => {
  // A STAGE's own status vocabulary is `pending | active | complete` — the
  // check constraint on `stages.status` (V210__stages.sql) and `Stage.status`
  // in api-v1/schemas.ts. It is NOT the DIVISION's `active | completed`
  // (`DIVISION_STARTED_STATUSES`, usecases/stages.ts): a different column with
  // a different spelling, and copying that set here would have matched nothing
  // at all, leaving this gate silently inert.

  it("swiss-legend-complete-status-set: 'complete' is the whole finished set; 'pending' and 'active' are outside it", () => {
    const vocabulary = Stage.shape.status.options;
    // The schema's own enum, so growing it reds HERE rather than dropping a
    // fourth status into the live arm unexamined.
    expect(vocabulary).toEqual(["pending", "active", "complete"]);
    expect([...SWISS_LEGEND_COMPLETE_STATUSES]).toEqual(["complete"]);
    expect(vocabulary.filter((s) => SWISS_LEGEND_COMPLETE_STATUSES.has(s))).toEqual(["complete"]);
    expect(vocabulary.filter((s) => !SWISS_LEGEND_COMPLETE_STATUSES.has(s))).toEqual([
      "pending",
      "active",
    ]);
    // The division's spelling is NOT the stage's — the trap this set exists to
    // avoid. `completed` must not be treated as finished here.
    expect(SWISS_LEGEND_COMPLETE_STATUSES.has("completed")).toBe(false);
  });

  it("swiss-legend-complete-drops-the-match-clause: the per-round figure is withheld, rounds and fixtures survive", () => {
    expect(
      swissStageLegend({
        kind: "swiss",
        status: "complete",
        config: { rounds: 3 },
        activeEntrantIds: ids(11),
        fixtureCount: 18,
      }),
    ).toEqual({ rounds: 3, matches: null, bye: false, fixtures: 18 });
  });

  it("swiss-legend-complete-vs-live: the SAME stage keeps its match clause on 'pending' and on 'active'", () => {
    for (const status of ["pending", "active"]) {
      expect(
        swissStageLegend({
          kind: "swiss",
          status,
          config: { rounds: 3 },
          activeEntrantIds: ids(11),
          fixtureCount: 18,
        }),
        status,
      ).toEqual({ rounds: 3, matches: 5, bye: true, fixtures: 18 });
    }
  });

  it("a post-event disqualification cannot make a finished stage read as mis-sized", () => {
    // The reviewer's case. The stage PLAYED 11 entrants — 5 matches and a bye
    // a round, 18 rows, entirely correct. Two were disqualified afterwards, so
    // the live field is 9, which would need 4 + a bye. On a finished stage
    // that number describes nobody, and printing it accuses a correct stage.
    const live = swissStageLegend({
      kind: "swiss",
      status: "active",
      config: { rounds: 3 },
      activeEntrantIds: ids(9),
      fixtureCount: 18,
    })!;
    expect(live.matches).toBe(4);

    const finished = swissStageLegend({
      kind: "swiss",
      status: "complete",
      config: { rounds: 3 },
      activeEntrantIds: ids(9),
      fixtureCount: 18,
    })!;
    expect(finished.matches).toBeNull();
    expect(finished.bye).toBe(false);
    expect(finished.rounds).toBe(3);
    expect(finished.fixtures).toBe(18);
  });
});

describe("swissStageLegend — a field too small to pair says nothing at all", () => {
  it("swiss-legend-empty-field-suppressed: a brand-new stage, created before any entrant exists, prints nothing", () => {
    expect(
      swissStageLegend({
        kind: "swiss",
        status: "pending",
        config: { rounds: 3 },
        activeEntrantIds: [],
        fixtureCount: 0,
      }),
    ).toBeNull();
  });

  it("swiss-legend-single-entrant-suppressed: one entrant is 0 matches and a bye — as meaningless as none", () => {
    expect(
      swissStageLegend({
        kind: "swiss",
        status: "pending",
        config: { rounds: 3 },
        activeEntrantIds: ids(1),
        fixtureCount: 0,
      }),
    ).toBeNull();
    // The arithmetic being suppressed, stated so this test cannot pass because
    // the threshold quietly moved somewhere harmless: a field of one really
    // does pair nothing and sit itself out.
    expect(swissBoardsForField(1)).toEqual({ boards: 0, bye: true });
  });

  it("swiss-legend-threshold-is-two: TWO entrants — the smallest field swiss can pair — DOES print", () => {
    expect(SWISS_LEGEND_MIN_FIELD).toBe(2);
    expect(
      swissStageLegend({
        kind: "swiss",
        status: "pending",
        config: { rounds: 3 },
        activeEntrantIds: ids(2),
        fixtureCount: 0,
      }),
    ).toEqual({ rounds: 3, matches: 1, bye: false, fixtures: 0 });
  });

  it("the suppression holds at EVERY stage status, and absent and empty never diverge", () => {
    // The reviewer's second worry: `activeEntrantIds` absent already meant no
    // legend, so an EMPTY roster must not start behaving differently. Swept
    // over the schema's own status vocabulary rather than one sample, and over
    // a stage that HAS rows (18), so a "well, it has no fixtures anyway"
    // implementation cannot pass it.
    for (const status of Stage.shape.status.options) {
      for (const n of [0, 1]) {
        expect(
          swissStageLegend({
            kind: "swiss",
            status,
            config: { rounds: 3 },
            activeEntrantIds: ids(n),
            fixtureCount: 18,
          }),
          `${status} / field ${n}`,
        ).toBeNull();
      }
      expect(
        swissStageLegend({
          kind: "swiss",
          status,
          config: { rounds: 3 },
          activeEntrantIds: undefined,
          fixtureCount: 18,
        }),
        `${status} / roster absent`,
      ).toBeNull();
    }
  });

  it("an emptied config.qualified list suppresses it even though the division is full", () => {
    // The threshold reads the stage's OWN field — the intersection — not the
    // division roster. A later swiss stage whose qualifiers have all withdrawn
    // has no field of its own, however many entrants the division holds.
    expect(
      swissStageLegend({
        kind: "swiss",
        status: "active",
        config: { rounds: 2, qualified: ["gone1", "gone2"] },
        activeEntrantIds: ids(20),
        fixtureCount: 8,
      }),
    ).toBeNull();
  });
});

describe("swissLegendText (English catalog, real i18n runtime)", () => {
  it("prints the owner-approved sentence for an odd field", () => {
    const legend = swissStageLegend({
      kind: "swiss",
      status: "active",
      config: { rounds: 3 },
      activeEntrantIds: ids(11),
      fixtureCount: 11,
    })!;
    expect(swissLegendText(legend, enI18n)).toBe("3 rounds · 5 matches + 1 bye per round · 11 fixtures");
  });

  it("DROPS the bye clause entirely on an even field", () => {
    const legend = swissStageLegend({
      kind: "swiss",
      status: "active",
      config: { rounds: 3 },
      activeEntrantIds: ids(10),
      fixtureCount: 15,
    })!;
    const text = swissLegendText(legend, enI18n);
    expect(text).toBe("3 rounds · 5 matches per round · 15 fixtures");
    expect(text).not.toContain("bye");
  });

  it("singularises all three counts", () => {
    const legend = swissStageLegend({
      kind: "swiss",
      status: "active",
      config: { rounds: 1 },
      activeEntrantIds: ids(2),
      fixtureCount: 1,
    })!;
    expect(swissLegendText(legend, enI18n)).toBe("1 round · 1 match per round · 1 fixture");
  });

  it("singularises the match clause while the bye clause is present", () => {
    const legend = swissStageLegend({
      kind: "swiss",
      status: "active",
      config: { rounds: 2 },
      activeEntrantIds: ids(3),
      fixtureCount: 4,
    })!;
    expect(swissLegendText(legend, enI18n)).toBe("2 rounds · 1 match + 1 bye per round · 4 fixtures");
  });

  it("swiss-legend-complete-sentence: a finished stage prints rounds and fixtures and NOTHING per-round", () => {
    const legend = swissStageLegend({
      kind: "swiss",
      status: "complete",
      config: { rounds: 3 },
      activeEntrantIds: ids(11),
      fixtureCount: 18,
    })!;
    const text = swissLegendText(legend, enI18n);
    expect(text).toBe("3 rounds · 18 fixtures");
    // The whole clause is gone, not merely a different number in it. A
    // negative with its positive pair: the live sentence four tests up DOES
    // contain every one of these.
    expect(text).not.toContain("match");
    expect(text).not.toContain("per round");
    expect(text).not.toContain("bye");
    // ...and it is a TRANSLATOR-owned template, not two clauses glued in code:
    // no separator was hand-punctuated, and nothing was left uninterpolated.
    expect(text).not.toContain("{");
  });

  it("singularises both clauses of the finished sentence", () => {
    const legend = swissStageLegend({
      kind: "swiss",
      status: "complete",
      config: { rounds: 1 },
      activeEntrantIds: ids(2),
      fixtureCount: 1,
    })!;
    expect(swissLegendText(legend, enI18n)).toBe("1 round · 1 fixture");
  });

  it("never says 'board' — chess heritage stays in the code, out of the copy", () => {
    for (const status of ["active", "complete"]) {
      for (const n of [3, 10, 11]) {
        const legend = swissStageLegend({
          kind: "swiss",
          status,
          config: { rounds: 3 },
          activeEntrantIds: ids(n),
          fixtureCount: n,
        })!;
        expect(swissLegendText(legend, enI18n).toLowerCase(), `${status} / ${n}`).not.toContain("board");
      }
    }
  });
});

describe("the finished sentence in all four dictionaries", () => {
  // Any changed user-facing string owes en/es/fr/nl. The template is
  // translator-owned, so what is pinned is that each locale HAS one and spends
  // exactly the two variables the finished arm supplies — a locale that kept
  // `{matches}` would print a literal brace on a finished stage.
  const dicts = [
    ["en", en],
    ["es", es],
    ["fr", fr],
    ["nl", nl],
  ] as const;

  it("every locale carries stage.swissLegend.lineComplete and spends both of its variables", () => {
    for (const [locale, dict] of dicts) {
      const raw = (dict as Record<string, unknown>)["stage.swissLegend.lineComplete"];
      expect(raw, locale).toBeTypeOf("string");
      expect(raw as string, locale).toContain("{rounds}");
      expect(raw as string, locale).toContain("{fixtures}");
      expect(raw as string, locale).not.toContain("{matches}");
    }
  });

  it("renders in every locale with no brace and no English leaking in", () => {
    const legend = swissStageLegend({
      kind: "swiss",
      status: "complete",
      config: { rounds: 3 },
      activeEntrantIds: ids(11),
      fixtureCount: 18,
    })!;
    for (const [locale, dict] of dicts) {
      const text = swissLegendText(legend, {
        t: (key, vars) => tRuntime(dict, key, vars),
        plural: (key, count, vars) => pluralRuntime(dict, key, count, locale, vars),
      });
      expect(text, locale).not.toContain("{");
      expect(text, locale).toContain("3");
      expect(text, locale).toContain("18");
      expect(text.toLowerCase(), locale).not.toContain("board");
      // The key itself is what `t` returns on a miss — so this also catches a
      // locale that never got the key at all.
      expect(text, locale).not.toContain("swissLegend");
    }
  });
});

describe("the legend's definition of 'active field'", () => {
  // The page derives the active field as the COMPLEMENT of DEPARTED_STATUSES
  // (the one place that vocabulary is spelled — `departed-entrants-wiring`
  // reds a page that restates it). The generate path the legend must agree
  // with spells the POSITIVE predicate instead:
  //     status in ('registered','confirmed')
  // They are the same set today. This pins that, so the day `EntrantStatus`
  // grows a fifth value the legend's field definition is revisited rather
  // than silently counting a waitlisted entrant into the match count.
  it("the complement of DEPARTED_STATUSES is exactly the server's field predicate", () => {
    expect(EntrantStatus.options.filter((s) => !DEPARTED_STATUSES.has(s))).toEqual([
      "registered",
      "confirmed",
    ]);
  });
});
