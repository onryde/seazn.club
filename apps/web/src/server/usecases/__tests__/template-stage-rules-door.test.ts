// D2a's THIRD door (review 2026-09-18). `createFromTemplate` inserts
// `effectiveStageConfig(templateStage)` straight into `stages.config`, and
// `TemplateStage.config` is `z.record(z.string(), z.unknown())` — so a `rules`
// key declared on a template stage would reach the column verbatim: no sport
// gate, no per-sport allowlist, no merged-config parse, for any sport at all.
// That is exactly the bypass D2a closed on `createStages`, in a third file.
//
// Two halves, deliberately, because they answer different questions and
// neither covers the other:
//   - `catalog.test.ts` asserts the SHIPPED catalog declares no `rules`, so a
//     catalog author finds out in CI rather than shipping a template that 400s
//     on every instantiation;
//   - this asserts the GUARD refuses one anyway, because D2a's whole argument
//     is that a door is shut by a guard and not by an assumption about who
//     walks through it. The catalog is the only source today; it need not be
//     the only source tomorrow.
//
// Pure — no database.
import { describe, expect, it } from "vitest";
import { effectiveStageConfig } from "../templates";
import type { TemplateStage } from "@/server/templates/schema";

const base = { i18nNameKey: "x", kind: "league" as const, size: 4 };

describe("effectiveStageConfig refuses per-stage match rules", () => {
  it("throws 400 RULES_NOT_ACCEPTED_HERE for a template stage declaring rules", () => {
    expect(() =>
      effectiveStageConfig({
        ...base,
        config: { rules: { bestOf: 5 } },
      } as unknown as TemplateStage),
    ).toThrow(expect.objectContaining({ status: 400, code: "RULES_NOT_ACCEPTED_HERE" }));
  });

  it("still builds the ordinary config it is there to build", () => {
    // The negative above needs its positive pair, or a guard that threw on
    // everything would pass it. `points` sugar and the `config` escape hatch
    // both still land.
    const cfg = effectiveStageConfig({
      ...base,
      points: { win: 3, draw: 1, loss: 0 },
      config: { rounds: 5 },
    } as unknown as TemplateStage);
    expect(cfg).toEqual({ points: { win: 3, draw: 1, loss: 0 }, rounds: 5 });
  });

  it("applies the group-pools sugar, and a config override still beats it", () => {
    const sugar = effectiveStageConfig({
      ...base,
      kind: "group",
      groups: 4,
    } as unknown as TemplateStage);
    expect(sugar).toEqual({ pools: { count: 4 } });
  });
});
