// L3/#414 pass 3: two new one-click stage-graph templates — KO+Plate
// (losersOfRound) and Qualifying+Main (topN over placements) — and their
// detectTemplate round-trip. Pure, no DB.
//
// F2 (unified progression field): every `qualification:` literal below was
// rewritten onto `progression:` in lockstep with format-templates.ts's own
// StageDraft/STAGE_TEMPLATES conversion — losersOfRound -> roundLosers,
// topN:n -> rankRange{from:1,to:n}, both wrapped in {sources,placement,
// timing}.
//
// F3 (day-one fixtures, owner ruling R1): `timing` is now "setup" on every
// progression-bearing template below, including ko_plate and
// qualifying_main — the propose/confirm flow this file's F2 comment said
// it never used. `buildTemplateStages` now passes the whole `TemplateKnobs`
// object into `build()` (owner ruling R5: groups_ko needs `poolCount`
// alongside `qualified` to draw from every pool, not just A/B), not the
// bare qualified count.
import { describe, expect, it } from "vitest";
import {
  STAGE_TEMPLATES,
  applyStandingsCarry,
  buildTemplateStages,
  clampKnob,
  detectTemplate,
} from "../format-templates";
import { FORMAT_FAMILIES } from "@/config/format-gallery";
import { ProgressionSchema } from "@/server/api-v1/schemas";
import {
  descriptorKey,
  expandSources,
  expandTake,
  placeDescriptors,
  resolveProgression,
  type SourceTables,
  type StandingsRow,
} from "@seazn/engine/competition";
import { generateSingleElim } from "@seazn/engine/scheduling";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";

describe("ko_plate template", () => {
  it("builds a main knockout + a plate seeded by roundLosers, count = the qualified knob", () => {
    const stages = buildTemplateStages("ko_plate", {
      qualified: 4,
      swissRounds: 5,
      poolCount: 2,
      legs: 1,
    });
    expect(stages).toHaveLength(2);
    expect(stages[0]).toMatchObject({ kind: "knockout", progression: null });
    expect(stages[1]).toMatchObject({
      kind: "knockout",
      progression: {
        sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 1, count: 4 }] }],
        placement: "rank_order",
        timing: "setup",
      },
    });
  });

  it("round-trips through detectTemplate", () => {
    const stages = buildTemplateStages("ko_plate", {
      qualified: 4,
      swissRounds: 5,
      poolCount: 2,
      legs: 1,
    });
    expect(detectTemplate(stages)).toBe("ko_plate");
  });
});

describe("qualifying_main template", () => {
  it("builds a qualifying knockout + a main draw seeded by rankRange, count = the qualified knob", () => {
    const stages = buildTemplateStages("qualifying_main", {
      qualified: 8,
      swissRounds: 5,
      poolCount: 2,
      legs: 1,
    });
    expect(stages).toHaveLength(2);
    expect(stages[0]).toMatchObject({ kind: "knockout", progression: null });
    expect(stages[1]).toMatchObject({
      kind: "knockout",
      progression: {
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 8 }] }],
        placement: "rank_order",
        timing: "setup",
      },
    });
  });

  it("round-trips through detectTemplate", () => {
    const stages = buildTemplateStages("qualifying_main", {
      qualified: 8,
      swissRounds: 5,
      poolCount: 2,
      legs: 1,
    });
    expect(detectTemplate(stages)).toBe("qualifying_main");
  });

  it("is distinguishable from ko_plate — same kind sequence, different progression take-rule kind", () => {
    const plate = buildTemplateStages("ko_plate", { qualified: 3, swissRounds: 5, poolCount: 2, legs: 1 });
    const main = buildTemplateStages("qualifying_main", {
      qualified: 3,
      swissRounds: 5,
      poolCount: 2,
      legs: 1,
    });
    expect(plate.map((s) => s.kind)).toEqual(main.map((s) => s.kind)); // both knockout+knockout
    expect(detectTemplate(plate)).toBe("ko_plate");
    expect(detectTemplate(main)).toBe("qualifying_main");
  });
});

describe("detectTemplate — existing templates still round-trip (regression)", () => {
  it("league, league_ko, groups_ko, knockout, americano, ladder", () => {
    expect(detectTemplate([{ kind: "league", config: { legs: 1 } }])).toBe("league");
    expect(
      detectTemplate([
        { kind: "league", config: { legs: 1 } },
        { kind: "knockout", config: {} },
      ]),
    ).toBe("league_ko");
    expect(
      detectTemplate([
        { kind: "group", config: { pools: { count: 2 } } },
        { kind: "knockout", config: {} },
      ]),
    ).toBe("groups_ko");
    expect(detectTemplate([{ kind: "knockout", config: {} }])).toBe("knockout");
    expect(detectTemplate([{ kind: "americano", config: { mode: "americano" } }])).toBe("americano");
    expect(detectTemplate([{ kind: "ladder", config: {} }])).toBe("ladder");
  });

  it("an unrecognised graph returns null (custom) — same kinds, neither roundLosers nor rankRange", () => {
    expect(
      detectTemplate([
        { kind: "knockout", config: {} },
        {
          kind: "knockout",
          config: {},
          progression: {
            sources: [{ stage: "previous", take: [{ kind: "picks", picks: [{ pool: "A", rank: 1 }] }] }],
            placement: "rank_order",
            timing: "setup",
          },
        },
      ]),
    ).toBeNull();
  });
});

// F2 plan Task 5 Step 1 — every template now emits `progression`, never
// `qualification`; `rankRange` is the collapsed survivor for what used to be
// `topN` (owner ruling 4 / Decision 2).
describe("format-templates emit progression, not qualification", () => {
  it("league_ko emits rankRange, setup — the topN replacement, unchanged take shape", () => {
    const stages = buildTemplateStages("league_ko", { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 });
    const finals = stages[1]!;
    expect(finals.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
      placement: "rank_order",
      timing: "setup",
    });
  });

  it("ko_plate still emits roundLosers, now setup — take shape unchanged, only timing flipped (F3)", () => {
    const stages = buildTemplateStages("ko_plate", { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 });
    expect(stages[1]!.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 1, count: 4 }] }],
      placement: "rank_order",
      timing: "setup",
    });
  });

  it("detectTemplate reads rankRange, not topN — round-trips through the new field", () => {
    const stages = buildTemplateStages("qualifying_main", { qualified: 8, swissRounds: 5, poolCount: 2, legs: 1 });
    expect(detectTemplate(stages)).toBe("qualifying_main");
  });

  it("groups_ko emits topNPerGroup, rank_order, setup — the cross-pool draw (F3, owner ruling 11)", () => {
    const stages = buildTemplateStages("groups_ko", { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 });
    expect(stages[1]!.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }],
      placement: "rank_order",
      timing: "setup",
    });
  });

  it("group_playoffs emits a FIXED rankRange(1,4) — not driven by the qualified knob", () => {
    const stages = buildTemplateStages("group_playoffs", { qualified: 8, swissRounds: 5, poolCount: 2, legs: 1 });
    expect(stages[1]!.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
      placement: "rank_order",
      timing: "setup",
    });
  });

  it("every stage's progression is either null or a schema-valid ProgressionSpec (mechanical rename)", () => {
    for (const t of STAGE_TEMPLATES) {
      const stages = t.build({ qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 });
      for (const stage of stages) {
        expect(stage).not.toHaveProperty("qualification");
        if (stage.progression === null) continue;
        const parsed = ProgressionSchema.safeParse(stage.progression);
        expect(parsed.success, JSON.stringify(parsed.success ? undefined : parsed.error.issues)).toBe(true);
      }
    }
  });
});

// F3 (day-one fixtures, owner ruling R5): groups_ko's knockout stage used to
// draw from a hand-rolled `picks` interleave hardcoded to pools "A"/"B" —
// with poolCount > 2 (the builder's own pools knob goes up to 8), groups C
// onward produced zero qualifiers. Replaced with the engine's own
// topNPerGroup (+ a bestNth remainder) take. Placement is `rank_order`, NOT
// `snake` (owner ruling 13, found by review before it shipped): `snake` is
// chosen by the TARGET stage's kind, not the source's — t20-super8's `snake`
// is legitimate because its target is a GROUP stage, where reversing
// alternate wave-major pots distributes strength across pools, but a
// KNOCKOUT target must not reverse. generateSingleElim's seedPositions fold
// (scheduling/bracket.ts:52-63, used at :156-163) pairs seed i against seed
// N+1-i, so a reversed pot puts every pool's winner back against its own
// runner-up in round 1 — see the "round 1 never pairs a group against
// itself" describe block below for the draw this used to produce.
describe("groups_ko — cross-pool draw (F3 owner ruling R5, placement per ruling 13)", () => {
  it("qualified:8, poolCount:4 -> topNPerGroup(2) only (evenly divisible), rank_order", () => {
    const stages = buildTemplateStages("groups_ko", { qualified: 8, swissRounds: 5, poolCount: 4, legs: 1 });
    expect(stages[1]!.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }],
      placement: "rank_order",
      timing: "setup",
    });
  });

  it("qualified:16, poolCount:6 -> topNPerGroup(2) + bestNth(nth:3, count:4) remainder", () => {
    const stages = buildTemplateStages("groups_ko", { qualified: 16, swissRounds: 5, poolCount: 6, legs: 1 });
    expect(stages[1]!.progression).toEqual({
      sources: [
        {
          stage: "previous",
          take: [
            { kind: "topNPerGroup", n: 2 },
            // A1 (round-4 review, MAJOR): normaliseUnequalPools MUST be set
            // — snakeDistribute (stages.ts) puts unequal entrant counts into
            // unequal-sized pools whenever entrants don't divide evenly by
            // poolCount (the common case), and bestNth's cross-pool compare
            // throws SEEDING_BESTNTH_UNEQUAL_POOLS without it (progression.ts)
            // — silently, at SEEDING time on real rows, long after the
            // day-one preview looked healthy (previewDivisionFixtures runs
            // on SHAPES, never hits this). See progression.test.ts's
            // "groups_ko's real bestNth remainder resolves against unequal
            // pools" for the end-to-end proof.
            { kind: "bestNth", nth: 3, count: 4, normaliseUnequalPools: true },
          ],
        },
      ],
      placement: "rank_order",
      timing: "setup",
    });
  });

  it("qualified:3, poolCount:2 -> topNPerGroup(1) + bestNth(nth:2, count:1) remainder", () => {
    const stages = buildTemplateStages("groups_ko", { qualified: 3, swissRounds: 5, poolCount: 2, legs: 1 });
    expect(stages[1]!.progression).toEqual({
      sources: [
        {
          stage: "previous",
          take: [
            { kind: "topNPerGroup", n: 1 },
            { kind: "bestNth", nth: 2, count: 1, normaliseUnequalPools: true },
          ],
        },
      ],
      placement: "rank_order",
      timing: "setup",
    });
  });

  it("qualified:2, poolCount:8 (n===0, fewer qualifiers than pools) -> bestNth(nth:1, count:2) only", () => {
    // Reachable from EITHER the Settings tab's free 2-32 qualified input
    // (division-settings.tsx) OR the builder's own dropdown (qualified 2,
    // pools >= 3, division-builder.tsx) — n = floor(2/8) = 0, so
    // topNPerGroup would be a no-op (the engine's expandOne loops
    // `wave <= rule.n`, zero iterations at n=0) and is omitted entirely; the
    // whole take collapses to bestNth(nth:1, count:2) — the best 2
    // pool-winners by cross-pool rank, i.e. "every pool's winner"
    // (topNPerGroup 1) truncated to the qualified count.
    const stages = buildTemplateStages("groups_ko", { qualified: 2, swissRounds: 5, poolCount: 8, legs: 1 });
    expect(stages[1]!.progression).toEqual({
      sources: [{ stage: "previous", take: [{ kind: "bestNth", nth: 1, count: 2, normaliseUnequalPools: true }] }],
      placement: "rank_order",
      timing: "setup",
    });
  });

  it("regression: with poolCount 4, the knockout draws qualifiers from every pool, not just A and B", () => {
    const stages = buildTemplateStages("groups_ko", { qualified: 8, swissRounds: 5, poolCount: 4, legs: 1 });
    const take = stages[1]!.progression!.sources[0]!.take;
    // Before this fix, `take` was `{kind:"picks", picks:[...]}` hardcoded to
    // alternate pools "A"/"B" regardless of poolCount, so with poolCount:4
    // pools C and D never appeared and produced zero qualifiers. Expand the
    // REAL take rule the template now emits against a real 4-pool shape,
    // through the engine's own expandTake, and prove all four pools appear.
    const pots = expandTake(take, { poolKeys: ["A", "B", "C", "D"] });
    const pools = new Set(pots.flat().flatMap((d) => (d.kind === "group_rank" ? [d.pool] : [])));
    expect(pools).toEqual(new Set(["A", "B", "C", "D"]));
  });

  it("A1 fix: the emitted bestNth remainder actually resolves against unequal pools, not just an unequal-membership shape check", () => {
    // The shape-check tests above only prove the JSON now carries
    // normaliseUnequalPools:true. This pipes groups_ko's REAL output through
    // the real engine resolver against pool sizes snakeDistribute (stages.ts)
    // actually produces for an entrant count that doesn't divide evenly by
    // poolCount (10 entrants / 4 pools -> [3,3,2,2], sizes.size > 1) — before
    // A1's fix, the missing flag makes this throw SEEDING_BESTNTH_UNEQUAL_
    // POOLS: the organiser-facing bug ("sees a full bracket on day one, runs
    // the whole group stage, and the knockout silently never fills"). See
    // progression.test.ts's resolveProgression tests for the isolated
    // engine-level proof (including the sibling hazard this does NOT fix).
    const stages = buildTemplateStages("groups_ko", { qualified: 7, swissRounds: 5, poolCount: 4, legs: 1 });
    const progression = stages[1]!.progression!;
    const pool = (key: string, size: number) => ({
      pool: key,
      rows: Array.from({ length: size }, (_, i) => ({ entrantId: `${key}${i + 1}`, rank: i + 1 }) as StandingsRow),
    });
    const tables: SourceTables = { pools: [pool("A", 3), pool("B", 3), pool("C", 2), pool("D", 2)] };
    const shape = { poolKeys: ["A", "B", "C", "D"] };
    expect(() => resolveProgression(progression, [shape], [tables])).not.toThrow();
    const { qualifiers } = resolveProgression(progression, [shape], [tables]);
    expect(qualifiers).toHaveLength(7);
  });
});

// Owner ruling 13 (F3 programme index, found by review before it shipped):
// the tests above only check pool MEMBERSHIP of the expanded pots as a Set,
// which is exactly what a draw that pairs every pool against itself in round
// 1 would still pass — snake placement over a knockout target does exactly
// that (snakeMerge reverses alternate wave-major pots, and
// generateSingleElim's seedPositions fold pairs seed i against seed N+1-i,
// bracket.ts:52-63,156-163, so the reversal lands every group against
// itself). Resolve the take through the real placement AND the real
// single-elimination generator instead of re-checking membership.
describe("round 1 never pairs a group against itself", () => {
  // groups_ko's real template output, run through the real engine pipeline:
  // expandSources (take -> pots), placeDescriptors (pots -> seed order,
  // using the template's OWN placement), generateSingleElim (seed order ->
  // round-0 fixtures) — never a hand-rolled reimplementation of the fold.
  function resolveRound1Pools(qualified: number, poolCount: number): [string, string][] {
    const poolKeys = Array.from({ length: poolCount }, (_, i) => String.fromCharCode(65 + i));
    const stages = buildTemplateStages("groups_ko", { qualified, swissRounds: 5, poolCount, legs: 1 });
    const progression = stages[1]!.progression!;
    const pots = expandSources(progression.sources, () => ({ poolKeys }));
    const placed = placeDescriptors(pots, progression.placement, progression.map);
    const poolOf = new Map(
      placed.map((s) => [descriptorKey(s.descriptor), s.descriptor.kind === "group_rank" ? s.descriptor.pool : "?"]),
    );
    const entrants = placed.map((s) => descriptorKey(s.descriptor));
    const { fixtures } = generateSingleElim({ entrants });
    return fixtures
      .filter((f) => f.round === 0)
      .map((f): [string, string] => {
        expect(f.home, "round-1 fixture has no home entrant — pick a qualified count that is a power of two").toBeDefined();
        expect(f.away, "round-1 fixture has no away entrant — pick a qualified count that is a power of two").toBeDefined();
        return [poolOf.get(f.home as string)!, poolOf.get(f.away as string)!];
      });
  }

  it("qualified:8, poolCount:4 — round 1 draws across pools, never within one", () => {
    const pairs = resolveRound1Pools(8, 4);
    expect(pairs).toHaveLength(4);
    for (const [homePool, awayPool] of pairs) expect(homePool).not.toBe(awayPool);
  });

  it("qualified:4, poolCount:2 (the picker's own default) — round 1 draws across pools, never within one", () => {
    const pairs = resolveRound1Pools(4, 2);
    expect(pairs).toHaveLength(2);
    for (const [homePool, awayPool] of pairs) expect(homePool).not.toBe(awayPool);
  });

  it("qualified:16, poolCount:4 — round 1 draws across pools, never within one", () => {
    const pairs = resolveRound1Pools(16, 4);
    expect(pairs).toHaveLength(8);
    for (const [homePool, awayPool] of pairs) expect(homePool).not.toBe(awayPool);
  });

  // Not hypothetical: forcing the same pots through "snake" (what this
  // template emitted before the fix) DOES pair a group against itself —
  // proof the assertions above actually discriminate the bug rather than
  // passing vacuously. A1..D1 stay put, A2..D2 get reversed to D2..A2 by
  // snakeMerge; generateSingleElim then folds seed i against seed N+1-i
  // (bracket.ts:52-63): seed1..4 = A1,B1,C1,D1, seed5..8 = D2,C2,B2,A2, so
  // pair(1,8) = (A1,A2) — a group replaying its own final.
  it("proves the harness actually catches the bug: placement snake DOES pair a group against itself", () => {
    const poolKeys = ["A", "B", "C", "D"];
    const pots = expandSources([{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }], () => ({ poolKeys }));
    const placed = placeDescriptors(pots, "snake");
    const poolOf = new Map(
      placed.map((s) => [descriptorKey(s.descriptor), s.descriptor.kind === "group_rank" ? s.descriptor.pool : "?"]),
    );
    const entrants = placed.map((s) => descriptorKey(s.descriptor));
    const { fixtures } = generateSingleElim({ entrants });
    const round1 = fixtures.filter((f) => f.round === 0);
    const samePoolPairing = round1.some((f) => poolOf.get(f.home as string) === poolOf.get(f.away as string));
    expect(samePoolPairing).toBe(true);
  });
});

// F3 (day-one fixtures, owner ruling R1): every progression-bearing writer
// — the picker's STAGE_TEMPLATES AND the marketing gallery's cannedStages —
// now generates its whole draw (final included) at division setup, never
// waiting on its source stage to complete. A stray "on_complete" here would
// silently reintroduce the "final only appears once group play ends" gap
// this task exists to close.
describe("F3 — every progression-bearing template/family emits timing: setup", () => {
  it("every STAGE_TEMPLATES entry's non-null progression.timing is setup", () => {
    const failures: string[] = [];
    for (const t of STAGE_TEMPLATES) {
      for (const stage of t.build({ qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 })) {
        if (stage.progression && stage.progression.timing !== "setup") {
          failures.push(`${t.key}/${stage.kind}: timing=${stage.progression.timing}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("every gallery family's non-null cannedStages progression.timing is setup", () => {
    const failures: string[] = [];
    for (const f of FORMAT_FAMILIES) {
      for (const stage of f.cannedStages) {
        const progression = stage.progression as { timing?: string } | null;
        if (progression && progression.timing !== "setup") {
          failures.push(`${f.slug}/${stage.kind}: timing=${progression.timing}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

// B (round-4 review): division-builder.tsx and division-settings.tsx both
// read poolCount/qualified off a free `<input type="number">` with an HTML
// `min` — which does NOT block a CLEARED field from reading as
// Number("") === 0. groups_ko's Math.floor(q/poolCount) with poolCount:0
// mints n:Infinity, which JSON.stringify serialises as n:null over the
// wire (Infinity has no JSON representation), and r becomes q-Infinity*0 =
// q-NaN = NaN, so `r > 0` is false and the bestNth remainder is silently
// dropped too — the organiser gets a raw schema 422 instead of a knob
// validation message. clampKnob is called at both call sites, right before
// buildTemplateStages, rather than on every keystroke (which would fight
// the organiser mid-edit) — same "pure extraction sidesteps needing to open
// the Format group" testability reasoning as currentQualifiedFromStages
// (division-settings-progression.test.tsx's own header comment).
describe("clampKnob — guards poolCount/qualified before buildTemplateStages (B fix)", () => {
  it("a cleared field (0) clamps to the minimum, not Infinity/NaN downstream", () => {
    expect(clampKnob(0, 2, 8)).toBe(2);
  });

  it("NaN (a non-numeric read) clamps to the minimum too", () => {
    expect(clampKnob(NaN, 2, 8)).toBe(2);
  });

  it("a negative value clamps to the minimum", () => {
    expect(clampKnob(-5, 2, 8)).toBe(2);
  });

  it("a value above the max clamps down to the max", () => {
    expect(clampKnob(100, 2, 8)).toBe(8);
  });

  it("a value already inside the range passes through unchanged", () => {
    expect(clampKnob(5, 2, 8)).toBe(5);
  });

  it("end to end: a cleared poolCount (0) no longer mints an Infinity/null topNPerGroup — groups_ko stays a valid, wire-safe shape", () => {
    const stages = buildTemplateStages("groups_ko", {
      qualified: 8,
      swissRounds: 5,
      poolCount: clampKnob(0, 2, 8), // simulates the cleared-field value flowing through the same guard the two UI call sites now apply
      legs: 1,
    });
    const take = stages[1]!.progression!.sources[0]!.take;
    for (const rule of take) {
      for (const [key, value] of Object.entries(rule)) {
        if (key === "kind") continue;
        expect(Number.isFinite(value), `${key} must be a finite number, got ${value}`).toBe(true);
      }
    }
  });
});

// F3 Task 6 (i18n): STAGE_TEMPLATES no longer carries its own English
// `label`/`help` — both render to organisers (division-builder.tsx's picker
// cards, division-settings.tsx's format <select>), so they were REMOVED from
// this array and now live as `format.template.<key>.label` / `.help` in the
// dictionaries, read via useMsg() at both call sites (division-builder.tsx,
// division-settings.tsx — see their own "F3 Task 6" comments at the render
// sites for the MessageKey-cast rationale).
//
// This replaces the old per-object "is listed with a label and help text"
// test, which only ever probed ko_plate's two fields directly on the array
// entry. That check is now IMPOSSIBLE (the fields don't exist), and would
// have been the wrong shape anyway once the dictionary became the source of
// truth: this loop is the regression net that actually matches the new
// contract — every template key resolves BOTH keys, in ALL FOUR locales,
// non-empty, and es/fr/nl are real translations rather than English left in
// place under a different key.
describe("F6 — standings carry on progression stages", () => {
  it("applyStandingsCarry with points sets carry on the finals stage only", () => {
    const stages = buildTemplateStages("league_ko", { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 });
    const withCarry = applyStandingsCarry(stages, "points");
    expect(withCarry[0]!.progression).toBeNull();
    expect(withCarry[1]!.progression).toMatchObject({
      carry: "points",
      timing: "setup",
    });
  });

  it("applyStandingsCarry with none omits carry from progression stages", () => {
    const stages = buildTemplateStages("league_ko", { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 });
    const withCarry = applyStandingsCarry(stages, "none");
    expect(withCarry[1]!.progression).not.toHaveProperty("carry");
  });
});

describe("STAGE_TEMPLATES — every key has dictionary-backed label/help copy (F3 Task 6)", () => {
  const DICTS: [string, Record<string, unknown>][] = [
    ["en", enUi as Record<string, unknown>],
    ["es", esUi as Record<string, unknown>],
    ["fr", frUi as Record<string, unknown>],
    ["nl", nlUi as Record<string, unknown>],
  ];

  // A regression net on the loops below: if STAGE_TEMPLATES ever collapsed
  // to empty, every `for` loop in this describe block would pass vacuously
  // (zero iterations, zero assertions) instead of proving anything.
  it("STAGE_TEMPLATES is non-empty", () => {
    expect(STAGE_TEMPLATES.length).toBeGreaterThanOrEqual(14);
  });

  for (const [locale, dict] of DICTS) {
    it(`every STAGE_TEMPLATES key resolves format.template.<key>.label/.help to a non-empty string in ${locale}`, () => {
      for (const t of STAGE_TEMPLATES) {
        const label = dict[`format.template.${t.key}.label`];
        const help = dict[`format.template.${t.key}.help`];
        expect(typeof label, `${locale} is missing format.template.${t.key}.label`).toBe("string");
        expect((label as string).length, `${locale}/format.template.${t.key}.label is empty`).toBeGreaterThan(0);
        expect(typeof help, `${locale} is missing format.template.${t.key}.help`).toBe("string");
        expect((help as string).length, `${locale}/format.template.${t.key}.help is empty`).toBeGreaterThan(0);
      }
    });
  }

  it("es/fr/nl are real translations, not English left in place (label OR help differs from en per key — a couple of short proper nouns/cognates, e.g. \"Ladder\"/\"Americano (padel)\", are legitimately identical in one field, so this only requires at least one of the two to differ)", () => {
    const en = enUi as Record<string, string>;
    for (const t of STAGE_TEMPLATES) {
      const enLabel = en[`format.template.${t.key}.label`];
      const enHelp = en[`format.template.${t.key}.help`];
      for (const [locale, dict] of DICTS) {
        if (locale === "en") continue;
        const label = dict[`format.template.${t.key}.label`];
        const help = dict[`format.template.${t.key}.help`];
        expect(
          label !== enLabel || help !== enHelp,
          `${locale}/${t.key}: label AND help are both byte-identical to en — looks like an English copy, not a translation`,
        ).toBe(true);
      }
    }
  });
});
