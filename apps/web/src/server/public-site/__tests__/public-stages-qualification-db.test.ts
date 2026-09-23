// V414 — the qualification cut-off, derived ONCE in SQL
// (`stage_qualification_meta`) and read by both the public view and, later,
// the organiser console (plan Task 4 / spec §4). Real Postgres; skipped
// without DATABASE_URL (same convention as public-entrants-departed.test.ts).
//
// "Status must never be wrong" (R3): anything that is not ONE clean cut comes
// back with no cut at all (`qualify_count: null`). Each guard in the SQL has a
// case below that goes red when that guard is deleted — the mutation record is
// in the Task 4 report. Every scene seeds its own org, so no plan cap (public
// competitions, active competitions, stages per division) can quietly turn a
// "no cut" into a pass for the wrong reason, and every assertion pins the
// division's WHOLE stage list, so a missing row is a red, never a vacuous null.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// `unstable_cache` is a Next server-runtime API with no incrementalCache
// outside a real request — passthrough, never a memoising double.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { embedDivisionData } from "@/server/embed-data";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, overrideStandings } from "@/server/usecases/stages";
import { GENERIC_CONFIG, seedOrg } from "@/server/usecases/__tests__/_seed";
import { getPublicDivision } from "../data";

const HAS_DB = !!process.env.DATABASE_URL;

type ViewRow = {
  name: string;
  qualify_count: number | null;
  qualify_per_group: boolean;
  next_stage_name: string | null;
  swiss_rounds: number | null;
  points_rule: unknown;
  has_rank_overrides: boolean;
};

interface Scene {
  auth: AuthCtx;
  divisionId: string;
  orgSlug: string;
  compSlug: string;
  divSlug: string;
}

async function division(visibility: "public" | "private" = "public"): Promise<Scene> {
  const { auth } = await seedOrg("pro");
  const suffix = randomUUID().slice(0, 8);
  // Created private and then moved: `createCompetition` does not refuse a
  // public competition over the plan's public cap, it silently writes it
  // PRIVATE, and a private division publishes no stages at all.
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Qual ${suffix}`,
    visibility: "private",
    branding: {},
  });
  await sql`update competitions set visibility = ${visibility} where id = ${comp.id}`;
  const div = await createDivision(auth, comp.id, {
    name: "Open",
    slug: `open-${suffix}`,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`
    select slug from organizations where id = ${auth.orgId}`;
  return { auth, divisionId: div.id, orgSlug, compSlug: comp.slug, divSlug: `open-${suffix}` };
}

const prog = (take: unknown[], stage: unknown = "previous") => ({
  sources: [{ stage, take }],
  placement: "rank_order",
  timing: "on_complete",
});

const view = async (divisionId: string) =>
  sql<ViewRow[]>`
    select name, qualify_count, qualify_per_group, next_stage_name, swiss_rounds, points_rule,
           has_rank_overrides
    from public_stages_v where division_id = ${divisionId} order by seq`;

/** Every stage of the division, in seq order, as [name, count, perGroup, next]. */
const cuts = async (divisionId: string) =>
  (await view(divisionId)).map((r) => [r.name, r.qualify_count, r.qualify_per_group, r.next_stage_name]);

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("public_stages_v — qualification columns (V414)", () => {
  it("empty case first: a lone stage with no destination carries no cut and no extras", async () => {
    const d = await division();
    await createStages(d.auth, d.divisionId, [{ seq: 1, kind: "league", name: "League", config: {} }]);
    expect(await view(d.divisionId)).toEqual([
      {
        name: "League",
        qualify_count: null,
        qualify_per_group: false,
        next_stage_name: null,
        swiss_rounds: null,
        points_rule: null,
        has_rank_overrides: false,
      },
    ]);
  });

  it("league → KO rankRange 1..4: count 4, overall, next stage named; the KO itself has none", async () => {
    const d = await division();
    await createStages(d.auth, d.divisionId, [
      { seq: 1, kind: "league", name: "League", config: {} },
      { seq: 2, kind: "knockout", name: "Finals", config: {}, progression: prog([{ kind: "rankRange", from: 1, to: 4 }]) },
    ] as never);
    expect(await cuts(d.divisionId)).toEqual([
      ["League", 4, false, "Finals"],
      ["Finals", null, false, null],
    ]);
  });

  // "previous" is the stage IMMEDIATELY before the destination, not any
  // earlier one: the Final's "previous" is the KO, so the league must not
  // pick up the Final's 1..2 as a second cut.
  it("a chain League → KO (previous 1..4) → Final (previous 1..2): each stage cuts into its own next stage", async () => {
    const d = await division();
    await createStages(d.auth, d.divisionId, [
      { seq: 1, kind: "league", name: "League", config: {} },
      { seq: 2, kind: "league", name: "Super 4", config: {}, progression: prog([{ kind: "rankRange", from: 1, to: 4 }]) },
      { seq: 3, kind: "knockout", name: "Final", config: {}, progression: prog([{ kind: "rankRange", from: 1, to: 2 }]) },
    ] as never);
    expect(await cuts(d.divisionId)).toEqual([
      ["League", 4, false, "Super 4"],
      ["Super 4", 2, false, "Final"],
      ["Final", null, false, null],
    ]);
  });

  it("groups → KO topNPerGroup 2: count 2 per group", async () => {
    const d = await division();
    await createStages(d.auth, d.divisionId, [
      { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } } },
      { seq: 2, kind: "knockout", name: "KO", config: {}, progression: prog([{ kind: "topNPerGroup", n: 2 }]) },
    ] as never);
    expect(await cuts(d.divisionId)).toEqual([
      ["Groups", 2, true, "KO"],
      ["KO", null, false, null],
    ]);
  });

  // Review Focus 5 (plan-owed): an OVERALL rankRange out of a POOLED stage is
  // a cut across pools, not per pool. The column must say so (`false`), so
  // the builder (Task 5), which refuses an overall cut on a pooled stage,
  // shows no status. Read `true` here and each pool's table would draw its
  // own top-4 line, which is not who goes through.
  it("groups (2 pools) → KO rankRange 1..4: an overall cut on a pooled stage is NOT per group", async () => {
    const d = await division();
    await createStages(d.auth, d.divisionId, [
      { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 2 } } },
      { seq: 2, kind: "knockout", name: "KO", config: {}, progression: prog([{ kind: "rankRange", from: 1, to: 4 }]) },
    ] as never);
    expect(await cuts(d.divisionId)).toEqual([
      ["Groups", 4, false, "KO"],
      ["KO", null, false, null],
    ]);
  });

  it("a bestNth beside the cut in the same take → no cut (unforecastable)", async () => {
    const d = await division();
    await createStages(d.auth, d.divisionId, [
      { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 3 } } },
      {
        seq: 2,
        kind: "knockout",
        name: "KO",
        config: {},
        progression: prog([
          { kind: "topNPerGroup", n: 1 },
          { kind: "bestNth", nth: 2, count: 1 },
        ]),
      },
    ] as never);
    expect(await cuts(d.divisionId)).toEqual([
      ["Groups", null, false, null],
      ["KO", null, false, null],
    ]);
  });

  // M6: the case above is also nulled by the one-rule-per-destination guard,
  // so it cannot witness the bestNth guard on its own. Here the cut is its
  // destination's only rule and the ONLY from-1 rule, so the bestNth into a
  // SECOND destination is the one thing standing between it and a count of 1.
  it("a bestNth into a different destination still blocks the cut", async () => {
    const d = await division();
    const [groups] = await createStages(d.auth, d.divisionId, [
      { seq: 1, kind: "group", name: "Groups", config: { pools: { count: 4 } } },
    ] as never);
    await createStages(d.auth, d.divisionId, [
      { seq: 2, kind: "knockout", name: "KO", config: {}, progression: prog([{ kind: "topNPerGroup", n: 1 }]) },
      {
        seq: 3,
        kind: "knockout",
        name: "Plate",
        config: {},
        progression: prog([{ kind: "bestNth", nth: 2, count: 2 }], { stageId: groups!.id }),
      },
    ] as never);
    expect(await cuts(d.divisionId)).toEqual([
      ["Groups", null, false, null],
      ["KO", null, false, null],
      ["Plate", null, false, null],
    ]);
  });

  it("a plate (rankRange from 3) is not a cut and does not block one: cup 1..2 + plate 3..4 → the cup; a plate alone → none", async () => {
    const cupAndPlate = await division();
    const [league] = await createStages(cupAndPlate.auth, cupAndPlate.divisionId, [
      { seq: 1, kind: "league", name: "League", config: {} },
    ]);
    await createStages(cupAndPlate.auth, cupAndPlate.divisionId, [
      {
        seq: 2,
        kind: "knockout",
        name: "Cup",
        config: {},
        progression: prog([{ kind: "rankRange", from: 1, to: 2 }], { stageId: league!.id }),
      },
      {
        seq: 3,
        kind: "knockout",
        name: "Plate",
        config: {},
        progression: prog([{ kind: "rankRange", from: 3, to: 4 }], { stageId: league!.id }),
      },
    ] as never);
    expect(await cuts(cupAndPlate.divisionId)).toEqual([
      ["League", 2, false, "Cup"],
      ["Cup", null, false, null],
      ["Plate", null, false, null],
    ]);

    const plateOnly = await division();
    await createStages(plateOnly.auth, plateOnly.divisionId, [
      { seq: 1, kind: "league", name: "League", config: {} },
      { seq: 2, kind: "knockout", name: "Plate", config: {}, progression: prog([{ kind: "rankRange", from: 3, to: 4 }]) },
    ] as never);
    expect(await cuts(plateOnly.divisionId)).toEqual([
      ["League", null, false, null],
      ["Plate", null, false, null],
    ]);
  });

  // Step 7(c): a source that takes 1..2 AND 3..4 into the same stage sends the
  // top FOUR through, so a cut at 2 would print "out" beside two entrants who
  // are going through.
  it("one KO taking rankRange 1..2 and 3..4 from the same source → no cut (it is really top 4)", async () => {
    const d = await division();
    await createStages(d.auth, d.divisionId, [
      { seq: 1, kind: "league", name: "League", config: {} },
      {
        seq: 2,
        kind: "knockout",
        name: "KO",
        config: {},
        progression: prog([
          { kind: "rankRange", from: 1, to: 2 },
          { kind: "rankRange", from: 3, to: 4 },
        ]),
      },
    ] as never);
    expect(await cuts(d.divisionId)).toEqual([
      ["League", null, false, null],
      ["KO", null, false, null],
    ]);
  });

  // The same trap one level up: two SOURCES of one destination that both name
  // this stage ("previous" and its id). Nothing refuses that at write time, and
  // the top four still all go to the KO.
  it("one KO naming the same stage in two sources (1..2 and 3..4) → no cut", async () => {
    const d = await division();
    const [league] = await createStages(d.auth, d.divisionId, [{ seq: 1, kind: "league", name: "League", config: {} }]);
    await createStages(d.auth, d.divisionId, [
      {
        seq: 2,
        kind: "knockout",
        name: "KO",
        config: {},
        progression: {
          sources: [
            { stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] },
            { stage: { stageId: league!.id }, take: [{ kind: "rankRange", from: 3, to: 4 }] },
          ],
          placement: "rank_order",
          timing: "on_complete",
        },
      },
    ] as never);
    expect(await cuts(d.divisionId)).toEqual([
      ["League", null, false, null],
      ["KO", null, false, null],
    ]);
  });

  it("two cuts from one stage into two destinations (Cup 1..4, Showcase 1..2) → no single cut → none", async () => {
    const d = await division();
    const [league] = await createStages(d.auth, d.divisionId, [{ seq: 1, kind: "league", name: "League", config: {} }]);
    await createStages(d.auth, d.divisionId, [
      {
        seq: 2,
        kind: "knockout",
        name: "Cup",
        config: {},
        progression: prog([{ kind: "rankRange", from: 1, to: 4 }], { stageId: league!.id }),
      },
      {
        seq: 3,
        kind: "knockout",
        name: "Showcase",
        config: {},
        progression: prog([{ kind: "rankRange", from: 1, to: 2 }], { stageId: league!.id }),
      },
    ] as never);
    expect(await cuts(d.divisionId)).toEqual([
      ["League", null, false, null],
      ["Cup", null, false, null],
      ["Showcase", null, false, null],
    ]);
  });

  it("swiss rounds and the stage points rule are published; rounds only for a swiss stage", async () => {
    const d = await division();
    const points = {
      base: { win: 3, draw: 1, loss: 0 },
      bonuses: [
        { when: "win_margin_gte", param: 3, points: 1 },
        { when: "draw", points: 0.5 },
      ],
      forfeit: { winnerPoints: 3, loserPoints: -1, awardScore: [3, 0] },
    };
    await createStages(d.auth, d.divisionId, [
      { seq: 1, kind: "league", name: "League", config: { rounds: 2 } },
      { seq: 2, kind: "swiss", name: "Swiss", config: { rounds: 5, points } },
    ] as never);
    const [league, swiss] = await view(d.divisionId);
    expect(league).toMatchObject({ name: "League", swiss_rounds: null, points_rule: null });
    expect(swiss).toMatchObject({ name: "Swiss", swiss_rounds: 5 });
    // toEqual, not toMatchObject: an extra key must fail here. The bonus with
    // no `param` stays without one (PointsRule rejects `param: null`).
    expect(swiss!.points_rule).toEqual(points);
  });

  // `PointsRule` is a non-strict z.object at every level and createStages
  // stores the RAW config it was given (it parses only to validate), so an
  // organiser's stray keys sit in `config.points`. Only what PointsRule reads
  // may reach a public page.
  it("points_rule publishes only the keys PointsRule reads, at every level", async () => {
    const d = await division();
    const clean = {
      base: { win: 3, draw: 1, loss: 0 },
      bonuses: [{ when: "win_margin_gte", param: 3, points: 1 }],
      forfeit: { winnerPoints: 3, loserPoints: 0 },
    };
    const withJunk = {
      base: { ...clean.base, note: "base junk" },
      bonuses: [{ ...clean.bonuses[0], memo: "bonus junk" }],
      forfeit: { ...clean.forfeit, secret: "forfeit junk" },
      internal: { owner: "top-level junk" },
    };
    await createStages(d.auth, d.divisionId, [
      { seq: 1, kind: "league", name: "League", config: { points: withJunk } },
    ] as never);
    const [stored] = await sql<{ points: unknown }[]>`
      select config -> 'points' as points from stages where division_id = ${d.divisionId}`;
    expect(stored!.points, "premise: the raw junk is stored").toEqual(withJunk);
    expect((await view(d.divisionId))[0]!.points_rule).toEqual(clean);
  });

  // Cross-stage feeds (Jul3/08 §9) wire a FIXTURE's winner or loser into a
  // destination slot by result, whatever the table says. StageConfig accepts
  // `cross_feeds` on any kind, and the shared generator gives every fixture an
  // ext_key that wireCrossFeeds matches on, so a table stage can carry them.
  // Two guards, one per side, each with its own killer:
  //
  // SOURCE side: the league itself sends entrants on by result. Its feed here
  // targets a PLATE (seq 3), not the cut's destination, so the destination
  // guard below cannot stand in for this one.
  it("a source stage with cross_feeds has no cut; an empty cross_feeds list changes nothing", async () => {
    const feed = { from_ext_key: "r1-m1", side: "winner", to_stage_seq: 3, to_ext_key: "r1-m1", slot: 1 };
    for (const [feeds, expected] of [
      [[feed], ["League", null, false, null]],
      [[], ["League", 4, false, "KO"]],
    ] as const) {
      const d = await division();
      await createStages(d.auth, d.divisionId, [
        { seq: 1, kind: "league", name: "League", config: { cross_feeds: feeds } },
        { seq: 2, kind: "knockout", name: "KO", config: {}, progression: prog([{ kind: "rankRange", from: 1, to: 4 }]) },
        { seq: 3, kind: "knockout", name: "Plate", config: {} },
      ] as never);
      expect(await cuts(d.divisionId), `source cross_feeds ${JSON.stringify(feeds)}`).toEqual([
        expected,
        ["KO", null, false, null],
        ["Plate", null, false, null],
      ]);
    }
  });

  // DESTINATION side (controller ruling, R3 "when in doubt, null"): the KO
  // takes the league's top 4 by rank AND a seat from another stage's fixture
  // result. A fed seat can take a place the ranking would have filled, so the
  // league's cut is not a forecast. The league itself carries no feed here, so
  // the source guard above cannot stand in for this one.
  it("a destination that another stage also feeds by cross_feeds takes the cut away; without the feed the cut stands", async () => {
    const feed = { from_ext_key: "r1-m1", side: "winner", to_stage_seq: 3, to_ext_key: "r1-m1", slot: 1 };
    for (const [feeds, expected] of [
      [[feed], ["League", null, false, null]],
      [[], ["League", 4, false, "KO"]],
    ] as const) {
      const d = await division();
      const [league] = await createStages(d.auth, d.divisionId, [
        { seq: 1, kind: "league", name: "League", config: {} },
        { seq: 2, kind: "knockout", name: "Qualifier", config: { cross_feeds: feeds } },
      ] as never);
      await createStages(d.auth, d.divisionId, [
        {
          seq: 3,
          kind: "knockout",
          name: "KO",
          config: {},
          progression: prog([{ kind: "rankRange", from: 1, to: 4 }], { stageId: league!.id }),
        },
      ] as never);
      expect(await cuts(d.divisionId), `destination fed by cross_feeds ${JSON.stringify(feeds)}`).toEqual([
        expected,
        ["Qualifier", null, false, null],
        ["KO", null, false, null],
      ]);
    }
  });

  it("a private competition publishes nothing (the visibility gate is untouched)", async () => {
    const d = await division("private");
    await createStages(d.auth, d.divisionId, [{ seq: 1, kind: "league", name: "League", config: {} }]);
    expect(await view(d.divisionId)).toEqual([]);
  });

  // M1: `rankLocked` is set on EVERY lots-decided tie (tiebreakers.ts), so the
  // status guard must read the organiser's own overrides, which live on
  // `stages.config.rank_overrides` (engine-db/competition.ts toTableStage).
  // Written here by the real writer, before/after on the SAME stage.
  it("has_rank_overrides: false without an organiser override, true once one is written, false for an empty list", async () => {
    const d = await division();
    const entrants = await createEntrants(
      d.auth,
      d.divisionId,
      ["A", "B", "C"].map((n, i) => ({ kind: "individual" as const, display_name: n, seed: i + 1, members: [] })),
    );
    const [stage] = await createStages(d.auth, d.divisionId, [{ seq: 1, kind: "league", name: "League", config: {} }]);
    expect((await view(d.divisionId)).map((r) => r.has_rank_overrides)).toEqual([false]);

    await overrideStandings(d.auth, stage!.id, {
      rows: [{ entrant_id: entrants[2]!.id, rank: 1, reason: "placement game" }],
    });
    expect((await view(d.divisionId)).map((r) => r.has_rank_overrides)).toEqual([true]);

    // The engine reads an EMPTY array as no locks at all (`rankLocks: []`).
    await sql`update stages set config = config || '{"rank_overrides": []}'::jsonb where id = ${stage!.id}`;
    expect((await view(d.divisionId)).map((r) => r.has_rank_overrides)).toEqual([false]);
  });

  // Spec-review F4: the view feeds the division page, the hub and the embed.
  // One malformed jsonb value must cost that stage its cut, never 500 all
  // three pages. Written straight to the table: nothing in the app writes
  // these shapes, but only the zod edge (not the CHECK) refuses them.
  it("malformed progression/config values → no cut, never an error", async () => {
    const d = await division();
    await createStages(d.auth, d.divisionId, [
      { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3 } },
      { seq: 2, kind: "knockout", name: "KO", config: {}, progression: prog([{ kind: "rankRange", from: 1, to: 4 }]) },
    ] as never);
    // Positive control: the same scene, well-formed, has a cut and a round count.
    expect(await view(d.divisionId)).toMatchObject([
      { name: "Swiss", qualify_count: 4, next_stage_name: "KO", swiss_rounds: 3 },
      { name: "KO", qualify_count: null },
    ]);

    const badTakes: [string, unknown][] = [
      ["a fractional from", [{ kind: "rankRange", from: 1.5, to: 4 }]],
      ["a fractional to", [{ kind: "rankRange", from: 1, to: 2.5 }]],
      ["a number written as a string", [{ kind: "rankRange", from: 1, to: "4" }]],
      ["to below from", [{ kind: "rankRange", from: 1, to: 0 }]],
      ["topNPerGroup n 0", [{ kind: "topNPerGroup", n: 0 }]],
      ["topNPerGroup n not a number", [{ kind: "topNPerGroup", n: "two" }]],
      ["take an object, not an array", { kind: "rankRange", from: 1, to: 4 }],
    ];
    for (const [why, take] of badTakes) {
      await sql`update stages set progression = jsonb_set(progression, '{sources,0,take}', ${sql.json(take as never)})
                where division_id = ${d.divisionId} and seq = 2`;
      // Premise: the value landed as written. A double-encoded jsonb STRING
      // would read as "not an array" and pass every row for the wrong reason.
      const [stored] = await sql<{ t: string; first: string | null }[]>`
        select jsonb_typeof(progression #> '{sources,0,take}') as t,
               progression #>> '{sources,0,take,0,kind}' as first
        from stages where division_id = ${d.divisionId} and seq = 2`;
      expect(stored, why).toEqual(
        Array.isArray(take)
          ? { t: "array", first: (take[0] as { kind: string }).kind }
          : { t: "object", first: null },
      );
      expect(await cuts(d.divisionId), why).toEqual([
        ["Swiss", null, false, null],
        ["KO", null, false, null],
      ]);
    }

    for (const rounds of ["five", 2.5]) {
      await sql`update stages set config = config || ${sql.json({ rounds } as never)}
                where division_id = ${d.divisionId} and seq = 1`;
      const [stored] = await sql<{ t: string }[]>`
        select jsonb_typeof(config -> 'rounds') as t from stages where division_id = ${d.divisionId} and seq = 1`;
      expect(stored!.t, "premise: rounds landed as written").toBe(typeof rounds);
      expect((await view(d.divisionId))[0], `rounds ${JSON.stringify(rounds)}`).toMatchObject({
        name: "Swiss",
        swiss_rounds: null,
      });
    }
  });

  // A take that is not an array is doubt, not "takes nobody": the engine
  // would throw on it, so it must not quietly leave a neighbour's clean cut
  // standing as the only rule.
  it("a malformed take into ANOTHER destination blocks an otherwise clean cut", async () => {
    const d = await division();
    const [league] = await createStages(d.auth, d.divisionId, [{ seq: 1, kind: "league", name: "League", config: {} }]);
    await createStages(d.auth, d.divisionId, [
      { seq: 2, kind: "knockout", name: "KO", config: {}, progression: prog([{ kind: "rankRange", from: 1, to: 4 }]) },
      {
        seq: 3,
        kind: "knockout",
        name: "Plate",
        config: {},
        progression: prog([{ kind: "rankRange", from: 5, to: 8 }], { stageId: league!.id }),
      },
    ] as never);
    expect((await cuts(d.divisionId))[0], "positive control").toEqual(["League", 4, false, "KO"]);

    await sql`update stages set progression = jsonb_set(progression, '{sources,0,take}',
                ${sql.json({ kind: "rankRange", from: 5, to: 8 } as never)})
              where division_id = ${d.divisionId} and seq = 3`;
    const [stored] = await sql<{ t: string }[]>`
      select jsonb_typeof(progression #> '{sources,0,take}') as t
      from stages where division_id = ${d.divisionId} and seq = 3`;
    expect(stored!.t, "premise: the plate's take is an object").toBe("object");
    expect(await cuts(d.divisionId)).toEqual([
      ["League", null, false, null],
      ["KO", null, false, null],
      ["Plate", null, false, null],
    ]);
  });

  // The public pages read through the pooled `sql` client, which connects as
  // the owning role (lib/db.ts), so they are not what this proves. An
  // `app_user` caller is: a withTenant transaction (the Task 9 console) reads
  // under FORCE row-level security on `stages`, and a caller-rights function
  // sees only that tenant's rows (none with no tenant set) and reports "no cut"
  // instead of failing. SECURITY DEFINER makes the cut independent of the
  // caller's RLS context, and EXECUTE is granted so app_user may call it.
  it("reads the same cut as app_user with no tenant context (definer + grant)", async () => {
    const d = await division();
    await createStages(d.auth, d.divisionId, [
      { seq: 1, kind: "league", name: "League", config: {} },
      { seq: 2, kind: "knockout", name: "Finals", config: {}, progression: prog([{ kind: "rankRange", from: 1, to: 4 }]) },
    ] as never);
    const rows = await sql.begin(async (tx) => {
      await tx`set local role app_user`;
      return tx<{ name: string; qualify_count: number | null; next_stage_name: string | null }[]>`
        select name, qualify_count, next_stage_name
        from public_stages_v where division_id = ${d.divisionId} order by seq`;
    });
    expect(rows.map((r) => [r.name, r.qualify_count, r.next_stage_name])).toEqual([
      ["League", 4, "Finals"],
      ["Finals", null, null],
    ]);

    // A definer function answers for any stage id, private competitions
    // included, so EXECUTE is app_user's (and its owner's) only — never
    // PUBLIC, which every role inherits. Grantee oid 0 is PUBLIC.
    const grantees = await sql<{ grantee: string }[]>`
      select coalesce(r.rolname, 'PUBLIC') as grantee
      from pg_proc p
      cross join lateral aclexplode(p.proacl) a
      left join pg_roles r on r.oid = a.grantee
      where p.proname = 'stage_qualification_meta' and a.privilege_type = 'EXECUTE'`;
    const names = grantees.map((g) => g.grantee);
    expect(names).toContain("app_user");
    expect(names).not.toContain("PUBLIC");
  });

  // The seam: the columns exist in the view, and BOTH public readers select
  // them (a reader that forgets one hands the builder `undefined`).
  it("getPublicDivision and embedDivisionData both carry the columns (and the embed the division config)", async () => {
    const d = await division();
    const points = { base: { win: 2, draw: 1, loss: 0 } };
    await createStages(d.auth, d.divisionId, [
      { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 4, points } },
      { seq: 2, kind: "knockout", name: "Finals", config: {}, progression: prog([{ kind: "rankRange", from: 1, to: 2 }]) },
    ] as never);
    const expected = {
      name: "Swiss",
      qualify_count: 2,
      qualify_per_group: false,
      next_stage_name: "Finals",
      swiss_rounds: 4,
      points_rule: points,
      has_rank_overrides: false,
    };

    const page = await getPublicDivision(d.orgSlug, d.compSlug, d.divSlug);
    expect(page, "premise: the division page resolves").not.toBeNull();
    expect(page!.stages[0]).toMatchObject(expected);

    const embed = await embedDivisionData(d.divisionId);
    expect(embed.ok, "premise: the embed resolves on Pro").toBe(true);
    if (!embed.ok) return;
    expect(embed.data.stages[0]).toMatchObject(expected);
    expect(embed.data.division.config).toMatchObject({ resultMode: "score", allowDraws: true });
  });
});
