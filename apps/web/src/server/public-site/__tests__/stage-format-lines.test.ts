// W2c batch 4 review M4 - `stage-format-lines.ts` says why a stage's decider override does not appear in its line. The
// claim is a premise about reach, not about data: the describer answers for the four stage-rules sports
// (`STAGE_RULES_SPORTS`), and none of them declares a decider key, so there is nothing to name there; the sports that DO
// declare one are not described at all. Ruling M4 wants spectators to read how a tie ends, which is W2c Task 16
// (`describeDeciders`). Until then this pins the premise, so the first described sport to declare a decider (a key with
// `decider: true` in its `ruleKeys`) reds this test instead of silently leaving its override out of the line.
//
// Both halves are read from the engine's own declarations, never a sport list typed here. Counted: zero checked is a failure.
import { describe, expect, it } from "vitest";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { STAGE_RULES_SPORTS } from "@/lib/match-rules";
import { describeMatchRules } from "../describe-rules";

const deciderKeys = (m: AnySportModule): string[] =>
  Object.entries(m.ruleKeys ?? {}).filter(([, f]) => f.decider === true).map(([k]) => k);

describe("stage format line - the premise behind its comment about deciders (batch 4 M4)", () => {
  const modules = builtinModules as readonly AnySportModule[];

  it("no sport the format line describes declares a decider key (counted)", () => {
    const described = modules.filter((m) => STAGE_RULES_SPORTS.has(m.key));
    expect(described.length, "every stage-rules sport is a builtin module").toBe(STAGE_RULES_SPORTS.size);
    for (const m of described) expect(deciderKeys(m), `${m.key} declares a decider the line would have to name`).toEqual([]);
  });

  it("the sports that declare a decider are not described: the describer answers null for each (counted, non-empty)", () => {
    const withDeciders = modules.filter((m) => deciderKeys(m).length > 0);
    expect(withDeciders.length, "anti-vacuity: sports whose stages can switch a decider").toBeGreaterThan(0);
    for (const m of withDeciders) {
      const cfg = m.configSchema.parse(m.variants[Object.keys(m.variants)[0]!] ?? {});
      expect(describeMatchRules(m.key, m, cfg), `${m.key} has deciders and no line`).toBeNull();
    }
  });
});
