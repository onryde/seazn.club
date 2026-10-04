// F3 ultrareview finding 12 — the demo seeder carries its OWN copy of the
// division-builder's stage templates (it is a standalone node script and
// cannot import through the app's `@/` aliases). Copies drift: this one still
// emitted `timing: "on_complete"` and a hand-rolled pools-A/B `picks`
// interleave months after format-templates.ts stopped, so the demo org — the
// one a prospective organiser actually clicks through — showed a knockout
// stuck on TBD while the shipped product draws it on day one.
//
// This is the gate. It compares the copy against the source of record rather
// than against a snapshot of itself, so the next divergence reds here instead
// of shipping quietly into the demo.
import { describe, expect, it } from "vitest";
import { TEMPLATES } from "../seed-demo-templates.ts";
import { buildTemplateStages } from "../../apps/web/src/lib/format-templates.ts";

describe("seed-demo stage templates track the shipped builder templates", () => {
  it("every progression the demo seeds is day-one (timing:'setup'), like every shipped template", () => {
    for (const [key, build] of Object.entries(TEMPLATES)) {
      for (const stage of build(4)) {
        if (!stage.progression) continue;
        expect(`${key}:${stage.progression.timing as string}`).toBe(`${key}:setup`);
      }
    }
  });

  it("groups_ko seeds the cross-pool draw, never the pools-A/B picks interleave", () => {
    const [, ko] = TEMPLATES.groups_ko!(4);
    const take = (ko!.progression as { sources: { take: { kind: string }[] }[] }).sources[0]!.take;
    expect(take.map((t) => t.kind)).not.toContain("picks");
    // 4 qualifiers over 2 pools divides evenly: top 2 from each, no remainder.
    expect(take).toEqual([{ kind: "topNPerGroup", n: 2 }]);
  });

  it("groups_ko's arithmetic matches buildTemplateStages' at the same knobs, remainder included", () => {
    // 5 qualifiers over 2 pools: top 2 from each + one best-3rd. The case the
    // old `picks` interleave got wrong in shape as well as in pool coverage.
    const [, demoKo] = TEMPLATES.groups_ko!(5);
    const shipped = buildTemplateStages("groups_ko", { qualified: 5, poolCount: 2 });
    const shippedKo = shipped.find((s) => s.kind === "knockout");
    const takeOf = (stage: unknown) =>
      (stage as { progression: { sources: { take: unknown[] }[] } }).progression.sources[0]!.take;
    expect(takeOf(demoKo)).toEqual(takeOf(shippedKo));
    expect(takeOf(demoKo)).toEqual([
      { kind: "topNPerGroup", n: 2 },
      { kind: "bestNth", nth: 3, count: 1, normaliseUnequalPools: true },
    ]);
  });
});
