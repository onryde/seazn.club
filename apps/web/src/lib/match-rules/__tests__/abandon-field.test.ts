// W2c Task 7 (Q10, D9) - the "If a match is abandoned" select, per sport. The per-sport contract tests judge that every
// option the field can build parses the engine's schema; they cannot see an option MISSING, a field offered to a sport that
// declares no choice, or a builder that writes a key the engine never reads. This file holds those three, swept over the
// engine's own registry: which sports have a choice is the module's own `abandonOptions` declaration, never a typed list.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { SPORT_RULES } from "@/lib/match-rules";
import { ABANDON_LABELS } from "@/lib/match-rules/shared";

const abandonFieldsOf = (sport: string) => (Object.hasOwn(SPORT_RULES, sport) ? SPORT_RULES[sport]! : []).filter((f) => f.key === "abandon");

describe("the abandon select follows the engine's declaration (W2c Q10)", () => {
  it("a sport that declares abandon options has exactly one field, offering exactly its module's abandon options in order, each labelled (counted)", () => {
    let withChoice = 0;
    let options = 0;
    for (const m of builtinModules) {
      if (m.abandonOptions === undefined) continue;
      const fields = abandonFieldsOf(m.key);
      expect(fields.length, `${m.key}: one abandon field`).toBe(1);
      const f = fields[0]!;
      expect([f.kind, f.edits], m.key).toEqual(["select", ["abandonPolicy"]]);
      expect(f.options?.map((o) => o.value), `${m.key} offers exactly its module's abandon options`).toEqual([...m.abandonOptions]);
      for (const o of f.options ?? []) {
        expect(o.label, `${m.key} ${o.value}`).toBe(ABANDON_LABELS[o.value]);
        options++;
      }
      withChoice++;
    }
    expect(withChoice).toBeGreaterThan(0);
    expect(options).toBeGreaterThanOrEqual(withChoice * 2); // a choice is at least two options
  });

  it("a sport that declares none has no abandon field (the negative pair, counted)", () => {
    let without = 0;
    for (const m of builtinModules) {
      if (m.abandonOptions !== undefined) continue;
      expect(abandonFieldsOf(m.key), `${m.key} offers an abandon choice its module does not declare`).toEqual([]);
      without++;
    }
    expect(without).toBeGreaterThan(0);
    expect(without + builtinModules.filter((m) => m.abandonOptions !== undefined).length).toBe(builtinModules.length);
  });

  it("each option builds the policy the engine reads: { abandonPolicy: <option> }, and nothing else", () => {
    let built = 0;
    for (const m of builtinModules) {
      for (const f of abandonFieldsOf(m.key))
        for (const o of f.options ?? []) {
          expect(f.build(o.value, {}), `${m.key} ${o.value}`).toEqual({ abandonPolicy: o.value });
          built++;
        }
    }
    expect(built).toBeGreaterThan(0);
  });
});
