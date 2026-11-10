// W4 app B, Task 9 (X-TP-1, X-TP-2): the setting's one reading and its one size predicate. The default is swept over the
// engine's own sport registry and the knockout-bearing templates (never a typed list of sports).
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { generateSingleElim } from "@seazn/engine/scheduling";
import { buildTemplateStages } from "@/lib/format-templates";
import { thirdPlaceFlagOf, thirdPlaceModeOf, thirdPlaceOffered, THIRD_PLACE_MIN } from "@/lib/third-place";

const KNOBS = { qualified: 4, swissRounds: 3, poolCount: 2, legs: 1 };
// The templates that carry at least one knockout stage, with how many.
const KNOCKOUT_TEMPLATES = [
  ["knockout", 1],
  ["league_ko", 1],
  ["groups_ko", 1],
  ["swiss_knockout", 1],
  ["ko_plate", 2],
  ["qualifying_main", 2],
] as const;

describe("thirdPlaceModeOf (X-TP-2)", () => {
  it("empty case first: no config, an empty config and a null config read Shared", () => {
    expect(thirdPlaceModeOf(null)).toBe("shared");
    expect(thirdPlaceModeOf(undefined)).toBe("shared");
    expect(thirdPlaceModeOf({})).toBe("shared");
  });
  it("only true is Play-off; false and every other value is Shared", () => {
    expect(thirdPlaceModeOf({ thirdPlace: true })).toBe("playoff");
    for (const v of [false, 0, 1, "true", "playoff", null, undefined, {}]) expect(thirdPlaceModeOf({ thirdPlace: v }), String(v)).toBe("shared");
  });
  it("the stored flag round-trips the mode", () => {
    expect(thirdPlaceFlagOf("playoff")).toBe(true);
    expect(thirdPlaceFlagOf("shared")).toBe(false);
    expect(thirdPlaceModeOf({ thirdPlace: thirdPlaceFlagOf("playoff") })).toBe("playoff");
    expect(thirdPlaceModeOf({ thirdPlace: thirdPlaceFlagOf("shared") })).toBe("shared");
  });

  it("X-TP-2 every knockout stage reads Shared by default in every sport", () => {
    let counted = 0;
    let expected = 0;
    for (const m of builtinModules) {
      for (const [template, knockouts] of KNOCKOUT_TEMPLATES) {
        const drafts = buildTemplateStages(template, KNOBS);
        const ko = drafts.filter((d) => d.kind === "knockout");
        expect(ko.length, `${template}: its knockout stages`).toBe(knockouts);
        expected += knockouts;
        for (const stage of ko) {
          expect(thirdPlaceModeOf(stage.config as { thirdPlace?: unknown }), `${m.key} ${template} ${stage.name}`).toBe("shared");
          counted++;
        }
      }
    }
    expect(counted, "anti-vacuity: every sport x template knockout stage was read").toBe(expected);
    expect(counted).toBe(builtinModules.length * KNOCKOUT_TEMPLATES.reduce((s, [, k]) => s + k, 0));
    expect(counted).toBeGreaterThan(0);
  });
});

describe("thirdPlaceOffered (X-TP-1)", () => {
  it("empty case first: nobody, one, two and three entrants are not offered", () => {
    for (const n of [0, 1, 2, 3]) expect(thirdPlaceOffered(n), `n=${n}`).toBe(false);
    expect(thirdPlaceOffered(Number.NaN)).toBe(false);
  });
  it("is the engine's own answer: the generator draws a third-place match exactly where it is offered", () => {
    let swept = 0;
    for (let n = 0; n <= 20; n++) {
      const ids = Array.from({ length: n }, (_, i) => `e${i + 1}`);
      let drew = false;
      try {
        const b = generateSingleElim({ entrants: ids, seeds: new Map(), thirdPlace: true });
        drew = b.fixtures.some((f) => f.thirdPlace === true);
      } catch {
        drew = false;
      }
      expect(thirdPlaceOffered(n), `n=${n}`).toBe(drew);
      swept++;
    }
    expect(swept).toBe(21);
    expect(THIRD_PLACE_MIN).toBe(4);
  });
});
