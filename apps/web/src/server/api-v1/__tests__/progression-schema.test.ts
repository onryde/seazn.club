// F2 (unified progression field) — one ProgressionSchema replaces
// QualificationSpecSchema and StageSeedingSchema (schemas.ts). Mirrors the
// engine's ProgressionSpec (@seazn/engine/competition/progression.ts)
// field-for-field, plus the apps/web-only `timing` field (Decision 1, F2
// plan) that neither prior vocabulary nor the design doc's own proposed
// shape carried. The schema is the wire/DB contract: it must REJECT what
// the engine cannot resolve (the collapsed topN/bestOfRank shapes, a
// seeded_map with nothing to seed, a missing timing) as much as it must
// accept what the engine can.
import { describe, expect, it } from "vitest";
import { ProgressionSchema } from "@/server/api-v1/schemas";

describe("ProgressionSchema", () => {
  it("accepts the euro24 shape — topNPerGroup + bestNth, one source, seeded_map", () => {
    const result = ProgressionSchema.safeParse({
      sources: [
        {
          stage: "previous",
          take: [
            { kind: "topNPerGroup", n: 2 },
            { kind: "bestNth", nth: 3, count: 4 },
          ],
        },
      ],
      placement: "seeded_map",
      map: [{ slot: "13", source: "best:1" }],
      timing: "setup",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a live {stageId} source (not just \"previous\") — the old auto-seed-on-complete shape", () => {
    const result = ProgressionSchema.safeParse({
      sources: [
        {
          stage: { stageId: "11111111-1111-4111-8111-111111111111" },
          take: [{ kind: "rankRange", from: 1, to: 4 }],
        },
      ],
      placement: "rank_order",
      timing: "on_complete",
    });
    expect(result.success).toBe(true);
  });

  it("rejects topN — the collapsed shape no longer parses (rankRange replaces it, Decision 2)", () => {
    const result = ProgressionSchema.safeParse({
      sources: [{ stage: "previous", take: [{ kind: "topN", n: 4 } as never] }],
      placement: "rank_order",
      timing: "on_complete",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "sources.0.take.0")).toBe(true);
    }
  });

  it("rejects bestOfRank — the collapsed shape no longer parses (bestNth absorbs normaliseUnequalPools instead, Decision 2b)", () => {
    const result = ProgressionSchema.safeParse({
      sources: [
        { stage: "previous", take: [{ kind: "bestOfRank", bestOfRank: { rank: 3, count: 2 } } as never] },
      ],
      placement: "rank_order",
      timing: "on_complete",
    });
    expect(result.success).toBe(false);
  });

  it("bestNth accepts the absorbed normaliseUnequalPools flag (Decision 2b — carried forward, not newly wired)", () => {
    const result = ProgressionSchema.safeParse({
      sources: [
        { stage: "previous", take: [{ kind: "bestNth", nth: 3, count: 2, normaliseUnequalPools: true }] },
      ],
      placement: "rank_order",
      timing: "on_complete",
    });
    expect(result.success).toBe(true);
  });

  it("requires timing — no default (ruling 5: strict constraints from day one)", () => {
    const result = ProgressionSchema.safeParse({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
      placement: "rank_order",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "timing")).toBe(true);
    }
  });

  it("rejects an invalid timing value — a closed enum, not a free string", () => {
    const result = ProgressionSchema.safeParse({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
      placement: "rank_order",
      timing: "midway",
    });
    expect(result.success).toBe(false);
  });

  it("still refuses seeded_map with an absent map (carried verbatim from StageSeedingSchema)", () => {
    const result = ProgressionSchema.safeParse({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
      placement: "seeded_map",
      timing: "setup",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "map")).toBe(true);
    }
  });

  it("still refuses seeded_map with a present but empty map array", () => {
    const result = ProgressionSchema.safeParse({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
      placement: "seeded_map",
      map: [],
      timing: "setup",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a multi-source progression — new capability, dedupe enforced at resolution, not parse (Finding 1)", () => {
    const result = ProgressionSchema.safeParse({
      sources: [
        { stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] },
        {
          stage: { stageId: "00000000-0000-0000-0000-000000000000" },
          take: [{ kind: "picks", picks: [{ pool: "A", rank: 1 }] }],
        },
      ],
      placement: "rank_order",
      timing: "on_complete",
    });
    expect(result.success).toBe(true);
  });

  it("accepts roundLosers with a required count — L3/#414, absorbed unchanged", () => {
    const result = ProgressionSchema.safeParse({
      sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 1, count: 4 }] }],
      placement: "rank_order",
      timing: "on_complete",
    });
    expect(result.success).toBe(true);
  });

  it("rejects roundLosers missing count — must 400 at the edge, never 500 deep inside progressionSize", () => {
    const result = ProgressionSchema.safeParse({
      sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 1 }] }],
      placement: "rank_order",
      timing: "on_complete",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // A missing discriminated-union field surfaces as ONE invalid_union
      // issue at the rule's own path (every branch rejects `{round:1}`,
      // zod does not flatten to a single leaf) — verified against the
      // schema's real safeParse output, not assumed.
      const issue = result.error.issues[0];
      expect(issue?.path.join(".")).toBe("sources.0.take.0");
      expect(issue?.code).toBe("invalid_union");
    }
  });

  it("rejects rankRange with to < from (the refine survives the topN collapse)", () => {
    const result = ProgressionSchema.safeParse({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 5, to: 1 }] }],
      placement: "rank_order",
      timing: "on_complete",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "sources.0.take.0.to")).toBe(true);
    }
  });

  it("rejects an unknown property on a take rule (leaf schemas stay .strict())", () => {
    const result = ProgressionSchema.safeParse({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2, bogus: 1 }] }],
      placement: "rank_order",
      timing: "on_complete",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a picks entry missing rank (PoolRankPickS is .strict(), both fields required)", () => {
    const result = ProgressionSchema.safeParse({
      sources: [{ stage: "previous", take: [{ kind: "picks", picks: [{ pool: "A" }] }] }],
      placement: "rank_order",
      timing: "on_complete",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty sources array", () => {
    const result = ProgressionSchema.safeParse({ sources: [], placement: "rank_order", timing: "on_complete" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown top-level property (ProgressionSchema itself is .strict())", () => {
    const result = ProgressionSchema.safeParse({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
      placement: "rank_order",
      timing: "on_complete",
      bogus: true,
    });
    expect(result.success).toBe(false);
  });

  // F2 full-branch review — product question: `carry` is only ever read
  // inside seedNextStage (usecases/stages.ts), which returns early unless
  // `timing === "on_complete"` — the `setup` fixture generator never looks
  // at it. Before this refine, `{timing: "setup", carry: "points"}` parsed
  // fine, createStages charged the org's `standings.carry_over` Pro
  // entitlement for it (stages.ts's gate reads `progression?.carry`
  // regardless of timing), and the carry then silently never happened.
  // Gating a paid feature on a combination that no-ops is the worst
  // option, so the combination is rejected at the edge instead — the
  // organiser gets a 400 naming the problem, not a silent charge for
  // nothing. Pre-F2 this was inexpressible: `carry` lived only on
  // `.qualification`, which was always `on_complete`; unification newly
  // admits the bad combination, so this refine is what keeps it closed.
  describe("carry requires timing: on_complete (F2 review product question)", () => {
    it("rejects carry: \"points\" when timing is \"setup\" — carry would silently no-op (setup never calls seedNextStage)", () => {
      const result = ProgressionSchema.safeParse({
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
        placement: "rank_order",
        timing: "setup",
        carry: "points",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.join(".") === "carry")).toBe(true);
      }
    });

    it("rejects carry: \"full\" when timing is \"setup\" the same way", () => {
      const result = ProgressionSchema.safeParse({
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
        placement: "rank_order",
        timing: "setup",
        carry: "full",
      });
      expect(result.success).toBe(false);
    });

    it("accepts carry: \"none\" with timing: \"setup\" — equivalent to omitting carry, no entitlement gate fires on it", () => {
      const result = ProgressionSchema.safeParse({
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
        placement: "rank_order",
        timing: "setup",
        carry: "none",
      });
      expect(result.success).toBe(true);
    });

    it("accepts carry: \"points\" when timing is \"on_complete\" — the only path that actually reads it", () => {
      const result = ProgressionSchema.safeParse({
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
        placement: "rank_order",
        timing: "on_complete",
        carry: "points",
      });
      expect(result.success).toBe(true);
    });
  });
});
