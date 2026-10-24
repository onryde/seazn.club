// D2a's THIRD door (review 2026-09-18). `createFromTemplate` inserts a template stage's config into `stages.config`, and
// `TemplateStage.config` is `z.record(z.string(), z.unknown())` — so a `rules` key declared on a template stage reaches
// the insert. Until W2c Task 12 `effectiveStageConfig` refused it outright (the door was shut); since Task 12 a stage is
// created WITH rules (its kind's preset, X-SR-6) and the insert validates any declared ones exactly as the stage PUT
// validates a save (`stage-defaults.ts` `validatedStageConfig`, against the division's sport, variant and config — which
// this pure builder does not have). So the builder passes `rules` through untouched, and the guard lives at the insert
// (templates.test.ts, "template stage rules").
//
// `catalog.test.ts` still asserts the SHIPPED catalog declares no `rules`, so a catalog author finds out in CI.
//
// Pure — no database.
import { describe, expect, it } from "vitest";
import { effectiveStageConfig } from "../templates";
import type { TemplateStage } from "@/server/templates/schema";

const base = { i18nNameKey: "x", kind: "league" as const, size: 4 };

describe("effectiveStageConfig builds the config; rules are the insert's to validate", () => {
  it("passes a template stage's rules through untouched (the insert validates them against the division)", () => {
    expect(
      effectiveStageConfig({
        ...base,
        config: { rules: { bestOf: 5 } },
      } as unknown as TemplateStage),
    ).toEqual({ rules: { bestOf: 5 } });
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
