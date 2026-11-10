// W4 app B, Task 10 (X-TP-2; X-TP-1; owner pick 1A): the builder SENDS the Third place choice on every knockout stage of the format
// it builds, and the Play-off is offered exactly where the server's PATCH (`thirdPlaceOffered`) would accept it. Expected values are
// the template builder's own knockout drafts and the shared predicate's declared minimum, never a table typed here.
import { describe, expect, it } from "vitest";
import { buildTemplateStages } from "@/lib/format-templates";
import { formatChoiceFromStages, formatKnobsShown, formatStagesFor, thirdPlaceOffer, type FormatKnobValues } from "../format-choice";
import { THIRD_PLACE_MIN } from "@/lib/third-place";

const KNOCKOUT_FORMATS = ["knockout", "league_ko", "groups_ko", "swiss_knockout", "ko_plate", "qualifying_main"] as const;
const NO_KNOCKOUT_FORMATS = ["league", "swiss", "round_robin"] as const;
const BASE = { qualified: 4, swissRounds: 3, poolCount: 2, legs: 1, standingsCarry: "none" as const };
const knobs = (thirdPlace: FormatKnobValues["thirdPlace"]): FormatKnobValues => ({ ...BASE, thirdPlace });
const knockoutsOf = (template: string) => buildTemplateStages(template, { qualified: 4, swissRounds: 3, poolCount: 2, legs: 1 }).filter((d) => d.kind === "knockout");

describe("X-TP-2 the builder sends thirdPlace on every knockout stage of the format", () => {
  it("every knockout format: each knockout stage carries an explicit boolean; Play-off sends true, Shared sends false", () => {
    let stages = 0;
    for (const template of KNOCKOUT_FORMATS) {
      expect(knockoutsOf(template).length, `${template} has a knockout stage`).toBeGreaterThan(0);
      for (const [mode, want] of [["playoff", true], ["shared", false]] as const) {
        const drafts = formatStagesFor(template, knobs(mode), 16);
        for (const d of drafts.filter((x) => x.kind === "knockout")) {
          expect(d.config?.thirdPlace, `${template} ${mode} stage ${d.name}`).toBe(want);
          stages++;
        }
      }
    }
    // ko_plate and qualifying_main build two knockout stages each; the rest one: counted from the builder, twice (two modes).
    const expected = KNOCKOUT_FORMATS.reduce((n, t) => n + knockoutsOf(t).length, 0) * 2;
    expect(stages).toBe(expected);
    expect(expected).toBeGreaterThanOrEqual(2 * (KNOCKOUT_FORMATS.length + 2));
  });

  it("a non-knockout stage never gains a thirdPlace key, and a format with no knockout shows no control", () => {
    let checked = 0;
    for (const template of [...KNOCKOUT_FORMATS, ...NO_KNOCKOUT_FORMATS]) {
      for (const d of formatStagesFor(template, knobs("playoff"), 16)) {
        if (d.kind === "knockout") continue;
        expect(d.config?.thirdPlace, `${template} ${d.kind}`).toBeUndefined();
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
    for (const t of NO_KNOCKOUT_FORMATS) expect(formatKnobsShown(t).thirdPlace, t).toBe(false);
    for (const t of KNOCKOUT_FORMATS) expect(formatKnobsShown(t).thirdPlace, t).toBe(true);
  });

  it("a Play-off the plan cannot play is sent as Shared, never as a stage the server would refuse", () => {
    for (const entrants of [0, 1, 2, THIRD_PLACE_MIN - 1]) {
      const [ko] = formatStagesFor("knockout", knobs("playoff"), entrants);
      expect(ko!.config?.thirdPlace, `${entrants} entrants`).toBe(false);
    }
    expect(formatStagesFor("knockout", knobs("playoff"), THIRD_PLACE_MIN)[0]!.config?.thirdPlace).toBe(true);
  });

  it("round trip: what the builder sends reads back as the same choice", () => {
    for (const mode of ["shared", "playoff"] as const) {
      const saved = formatStagesFor("league_ko", knobs(mode), 16).map((d, i) => ({ kind: d.kind, config: d.config, progression: d.progression, seq: i + 1 }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(formatChoiceFromStages(saved as any).thirdPlace, mode).toBe(mode);
    }
  });
});

describe("X-TP-1 the Play-off is offered where the server accepts it", () => {
  it("the empty case first: a format with no knockout offers nothing to refuse, and counts no field", () => {
    for (const t of NO_KNOCKOUT_FORMATS) expect(thirdPlaceOffer(t, { qualified: 4 }, 0), t).toEqual({ offered: true, entrants: null });
  });

  it("knockout at 0, 3 and the minimum: not offered below it, offered at it", () => {
    expect(thirdPlaceOffer("knockout", { qualified: 4 }, 0)).toEqual({ offered: false, entrants: 0 });
    expect(thirdPlaceOffer("knockout", { qualified: 4 }, THIRD_PLACE_MIN - 1)).toEqual({ offered: false, entrants: THIRD_PLACE_MIN - 1 });
    expect(thirdPlaceOffer("knockout", { qualified: 4 }, THIRD_PLACE_MIN)).toEqual({ offered: true, entrants: THIRD_PLACE_MIN });
  });

  it("a fed bracket is judged on what its cut takes, capped at the plan", () => {
    // league_ko's knockout plays the Top N; the plan caps it.
    expect(thirdPlaceOffer("league_ko", { qualified: 4 }, 16).offered).toBe(true);
    expect(thirdPlaceOffer("league_ko", { qualified: 4 }, 3)).toEqual({ offered: false, entrants: 3 });
  });
});
