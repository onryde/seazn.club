// TakeRuleSchema (the edge's zod parse) against every take rule the product
// itself ships (ruling 55, controller ruling CL-R2).
//
// The SHAPE tie is compile-time and lives beside the schema in schemas.ts:
// z.infer<typeof TakeRuleSchema> and the engine's TakeRule must be assignable
// both ways, or tsc fails. What tsc cannot see is the value level — min/max,
// .int(), .strict(), the rankRange refine. This file holds that half: every
// take rule a shipped template emits must parse, and must come back
// unchanged (a schema that stripped or coerced a field would hand the
// usecase something other than what the builder sent).
//
// Three template sources, each counted on its own so one going empty is a
// red rather than hidden by the others (anti-vacuity):
//   - the builder's one-click templates (lib/format-templates.ts), built over
//     the builder's own knob bounds (division-builder.tsx clamps qualified to
//     2..32 and poolCount to 2..8 before buildTemplateStages);
//   - the format gallery's canned preview graphs (config/format-gallery.tsx);
//   - the curated competition catalog (server/templates/catalog/*.json), read
//     from disk so a new catalog file is covered without editing this test.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STAGE_TEMPLATES, buildTemplateStages, type TemplateKnobs } from "@/lib/format-templates";
import { FORMAT_FAMILIES } from "@/config/format-gallery";
import { TakeRuleSchema } from "@/server/api-v1/schemas";

const CATALOG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates", "catalog");

/** Every `take` array anywhere under `node` — the three sources nest their
 *  stage graphs differently, so walk rather than hard-code each path. */
function takeRulesIn(node: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const v of node) takeRulesIn(v, out);
  } else if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "take" && Array.isArray(v)) out.push(...(v as unknown[]));
      else takeRulesIn(v, out);
    }
  }
  return out;
}

// The builder's knob space: qualified and poolCount at the clamp bounds and
// between them (including a pool count that does not divide the qualified
// count, which is what makes groups_ko emit a bestNth remainder), both swiss
// round budgets the tests elsewhere use, and both leg counts.
const KNOB_GRID: TemplateKnobs[] = [];
for (const qualified of [2, 3, 4, 8, 16, 32])
  for (const poolCount of [2, 3, 4, 8])
    for (const swissRounds of [3, 5])
      for (const legs of [1, 2]) KNOB_GRID.push({ qualified, poolCount, swissRounds, legs });

const SOURCES: { name: string; rules: () => unknown[] }[] = [
  {
    name: "builder templates (lib/format-templates.ts)",
    rules: () => STAGE_TEMPLATES.flatMap((t) => KNOB_GRID.flatMap((k) => takeRulesIn(buildTemplateStages(t.key, k)))),
  },
  {
    name: "format gallery canned stages (config/format-gallery.tsx)",
    rules: () => takeRulesIn(FORMAT_FAMILIES.map((f) => f.cannedStages)),
  },
  {
    name: "competition catalog (server/templates/catalog/*.json)",
    rules: () =>
      takeRulesIn(
        readdirSync(CATALOG_DIR)
          .filter((f) => f.endsWith(".json"))
          .sort()
          .map((f) => JSON.parse(readFileSync(join(CATALOG_DIR, f), "utf8")) as unknown),
      ),
  },
];

describe("TakeRuleSchema accepts, unchanged, every take rule a shipped template emits", () => {
  it.each(SOURCES.map((s) => [s.name, s] as const))("%s", (_name, source) => {
    const rules = source.rules();
    // Anti-vacuity: a source that yields nothing proves nothing.
    expect(rules.length, `${source.name}: zero take rules found`).toBeGreaterThan(0);
    const kinds = new Set<string>();
    let parsed = 0;
    for (const rule of rules) {
      const r = TakeRuleSchema.safeParse(rule);
      expect(r.success, `${JSON.stringify(rule)}: ${r.success ? "" : JSON.stringify(r.error.issues)}`).toBe(true);
      if (!r.success) continue;
      // Round trip: nothing stripped, nothing coerced, nothing defaulted in.
      expect(r.data, JSON.stringify(rule)).toStrictEqual(rule);
      kinds.add(r.data.kind);
      parsed++;
    }
    expect(parsed).toBe(rules.length);
    console.info(`${source.name}: ${parsed} take rules parsed; kinds ${[...kinds].sort().join(", ")}`);
  });

  it("the builder's templates reach every take-rule kind they claim to (the knob grid is not degenerate)", () => {
    // Grid coverage, from the template tests (format-templates.test.ts):
    // league_ko / qualifying_main / group_playoffs emit rankRange, groups_ko
    // emits topNPerGroup plus a bestNth remainder when the pools do not
    // divide the qualifiers, ko_plate emits roundLosers. No template emits
    // `picks` (template-gallery.tsx's header records the same). A grid that
    // misses a kind would leave that kind's value bounds unchecked here.
    const kinds = new Set(SOURCES[0]!.rules().map((r) => (r as { kind: string }).kind));
    expect([...kinds].sort()).toEqual(["bestNth", "rankRange", "roundLosers", "topNPerGroup"]);
  });
});
