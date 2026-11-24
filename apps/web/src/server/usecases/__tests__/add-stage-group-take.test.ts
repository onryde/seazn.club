// Add stage after a stage of SEVERAL groups (owner Option C, 2026-11-24): the form's one count "Qualify to the knockout: N" saves a
// per-group take (`topNPerGroup`, then `bestNth` for the remainder - the division builder's own split, `groupsKoTake`), timing
// on_complete. Every scene folds the form's OWN body (`addStageGroupProgression`, stages-panel.tsx) through the real doors:
// `createStages` (the usecase behind POST /divisions/{id}/stages), a real draw, real results through `scoreEvent`, the real
// `completeStage` that seeds and generates the knockout - so a seam declared on one end and never read on the other cannot hide.
//
// Shapes the draw refuses for EVERY outcome are refused AT SAVE by its own codes (SEEDING_CROSS_POOL_DRAW_TOO_LARGE,
// SEEDING_PAGE_PLAYOFF_NEEDS_FOUR), by SEEDING_QUALIFY_TOO_FEW and by RR_CUT_EXCEEDS_FIELD, writing nothing - never a save that then
// never generates. A shape the draw only CAN refuse (SEEDING_POOL_SEPARATION_IMPOSSIBLE, when the best runner-up comes from the wrong
// group) is SAVED - owner policy 2026-11-24 - and the draw refuses it by name once the groups are played; the form never offers one. Expected values come from the rulebook / bounds (FORMAT_BOUNDS, the round-robin sizes), never from the code under test.
// Sports: generic and boardgame (the two the scene builders can score through a result event; the take reads only places, so two
// sports with different result events prove it is not generic-shaped). Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { FORMAT_BOUNDS } from "@/lib/format-bounds";
import { snakeSizes } from "@/lib/field-cut-gate";
import { groupsKoTake } from "@/lib/format-templates";
import { groupTakeWorkingCounts } from "@/lib/group-take-refusal";
import type { AuthCtx } from "@/server/api-v1/auth";
import { addStageGroupProgression } from "@/components/v2/stages-panel";
import { completeStage, createStages, deleteStage, generateStageFixtures } from "../stages";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { withdrawEntrantCascade } from "../withdrawal";
import { post } from "./_groups-ko-scene";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type SportKey = "generic" | "boardgame";
interface Groups {
  auth: AuthCtx;
  divId: string;
  srcId: string;
  sport: SportKey;
}

/** A division whose first stage is `pools` groups over `entrants` entrants, drawn and started. */
async function groups(o: { sport: SportKey; entrants: number; pools: number; start?: boolean }): Promise<Groups> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Group take", visibility: "private", branding: {} });
  const [variant] = await sql<{ key: string; config: Record<string, unknown> }[]>`
    select key, config from sport_variants where sport_key = ${o.sport} and is_system order by key limit 1`;
  const div = await createDivision(auth, comp.id, { name: "Open", slug: "open", sport_key: o.sport, variant_key: variant!.key, config: variant!.config } as never);
  await createEntrants(auth, div.id, Array.from({ length: o.entrants }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })));
  const [src] = await createStages(auth, div.id, [{ seq: 1, kind: "group", name: "Groups", config: { legs: 1, pools: { count: o.pools } } }] as never);
  await generateStageFixtures(auth, src!.id);
  if (o.start !== false) await startDivision(auth, div.id);
  return { auth, divId: div.id, srcId: src!.id, sport: o.sport };
}

/** Every line of the groups decided, the lower seed winning; then the stage completed through the real door. */
async function completeGroups(g: Groups, away: readonly string[] = []): Promise<Awaited<ReturnType<typeof completeStage>>> {
  const seedOf = new Map((await sql<{ id: string; seed: number }[]>`select id, seed from entrants where division_id = ${g.divId}`).map((e) => [e.id, e.seed]));
  const fx = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
    select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${g.srcId} and home_entrant_id is not null and away_entrant_id is not null`;
  const lines = fx.filter((f) => !away.includes(f.home_entrant_id) && !away.includes(f.away_entrant_id));
  expect(lines.length, "the premise: the groups have lines to play").toBeGreaterThan(0);
  expect(lines.length, "a withdrawn entrant's lines are the cascade's, never played").toBe(away.length === 0 ? fx.length : lines.length);
  expect(lines.some((f) => away.includes(f.home_entrant_id) || away.includes(f.away_entrant_id))).toBe(false);
  for (const f of lines) {
    await post(g.auth, f.id, "core.start");
    const homeWins = seedOf.get(f.home_entrant_id)! < seedOf.get(f.away_entrant_id)!;
    const winner = homeWins ? f.home_entrant_id : f.away_entrant_id;
    if (g.sport === "boardgame") await post(g.auth, f.id, "boardgame.result", { winner, method: "resign" });
    else await post(g.auth, f.id, "generic.result", homeWins ? { p1Score: 2, p2Score: 0 } : { p1Score: 0, p2Score: 2 });
  }
  const done = await completeStage(g.auth, g.srcId);
  expect(done.completed, "the premise: the groups completed").toBe(true);
  return done;
}

/** The Add-stage form's own POST body for a group source: the count folded by the form's own function. */
const formBody = (count: number, pools: number, kind = "knockout") => ({
  seq: 2,
  kind,
  name: "Finals",
  config: {},
  progression: addStageGroupProgression(count, pools),
});

/** A take of one place: refused at save whatever the groups do (a knockout needs FORMAT_BOUNDS.qualify.min). */
const tooFewBody = () => ({ ...formBody(8, 4), progression: { ...addStageGroupProgression(8, 4), sources: [{ stage: "previous", take: [{ kind: "bestNth", nth: 1, count: 1 }] }] } });

const refusalOf = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as HttpError,
  );
const stagesOf = async (divId: string) => (await sql<{ seq: number }[]>`select seq from stages where division_id = ${divId} order by seq`).map((s) => s.seq);

/** The knockout's seated field after the source completed: how many distinct entrants it seats, and whether any round-one line
 *  with both seats real pairs two members of one group. */
async function knockoutField(g: Groups, koId: string): Promise<{ seated: number; sameGroupPairs: number; realPairs: number }> {
  const poolOf = new Map(
    (await sql<{ e: string; pool_id: string }[]>`
      select distinct x.e, f.pool_id from fixtures f cross join lateral (values (f.home_entrant_id), (f.away_entrant_id)) x(e)
       where f.stage_id = ${g.srcId} and x.e is not null`).map((r) => [r.e, r.pool_id]),
  );
  const lines = await sql<{ round_no: number; home_entrant_id: string | null; away_entrant_id: string | null }[]>`
    select round_no, home_entrant_id, away_entrant_id from fixtures where stage_id = ${koId}`;
  const seated = new Set(lines.flatMap((l) => [l.home_entrant_id, l.away_entrant_id]).filter((e): e is string => e !== null));
  const first = Math.min(...lines.map((l) => l.round_no));
  const pairs = lines.filter((l) => l.round_no === first && l.home_entrant_id !== null && l.away_entrant_id !== null);
  return { seated: seated.size, realPairs: pairs.length, sameGroupPairs: pairs.filter((l) => poolOf.get(l.home_entrant_id!) === poolOf.get(l.away_entrant_id!)).length };
}

/** The knockout stage row the form's save made, once the source completed (its Generate seeds it). */
async function koOf(divId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`select id from stages where division_id = ${divId} and seq = 2`;
  expect(row, "the premise: the knockout was added").toBeDefined();
  return row!.id;
}

describe.skipIf(!HAS_DB)("Add stage after groups: the per-group take saves, and Complete then seeds the knockout it names", () => {
  for (const sport of ["generic", "boardgame"] as const) {
    it(`${sport}: 4 groups of 4, "qualify 8" (top 2 per group) saves before the groups finish; Complete seeds 8 and no round-one line pairs a group against itself`, async () => {
      const g = await groups({ sport, entrants: 16, pools: 4 });
      const body = formBody(8, 4);
      expect(body.progression.sources[0]!.take, "the premise: the form's take is the per-group one").toEqual([{ kind: "topNPerGroup", n: 2 }]);
      const [ko] = await createStages(g.auth, g.divId, body as never);
      expect(ko!.seq).toBe(2);
      // The form's own next step: a Generate while the groups are not finished waits (no refusal that strands the stage).
      const waits = await refusalOf(generateStageFixtures(g.auth, ko!.id));
      expect(waits?.code, "waits for the groups").toBe("STAGE_NOT_READY");
      const done = await completeGroups(g);
      expect(done.next_stage_fixtures, "completing the groups generated the knockout's lines").toBeGreaterThan(0);
      const field = await knockoutField(g, ko!.id);
      expect(field.seated, "the knockout seats the 8 qualifiers").toBe(8);
      expect(field.realPairs, "anti-vacuity: round one has real lines").toBe(4);
      expect(field.sameGroupPairs, "no pool-mates meet in round one").toBe(0);
    });
  }

  it("UNEQUAL groups (5,5,4,4 = 18 entrants): \"qualify 10\" saves top 2 + the 2 best thirds; Complete seats exactly 10, 2 real round-one lines, no group against itself", async () => {
    const g = await groups({ sport: "generic", entrants: 18, pools: 4 });
    const sizes = (await sql<{ n: number }[]>`select count(distinct e)::int as n from fixtures f cross join lateral (values (f.home_entrant_id), (f.away_entrant_id)) x(e) where f.stage_id = ${g.srcId} group by f.pool_id`).map((r) => r.n).sort();
    expect(sizes, "the premise: the snake left unequal groups").toEqual([4, 4, 5, 5]);
    const body = formBody(10, 4);
    expect(body.progression.sources[0]!.take, "the premise: top 2 per group + 2 best 3rd-placed").toEqual(groupsKoTake(10, 4));
    expect(body.progression.sources[0]!.take.map((t) => t.kind)).toEqual(["topNPerGroup", "bestNth"]);
    const [ko] = await createStages(g.auth, g.divId, body as never);
    await completeGroups(g);
    const field = await knockoutField(g, ko!.id);
    expect(field.seated, "the knockout seats the 10 qualifiers").toBe(10);
    // Rule: a bracket of the next power of two (16) seats the top 16 - 10 = 6 seeds on byes, so the 10 qualifiers play 10 - 8 = 2 real round-one lines.
    expect(field.realPairs, "10 qualifiers into a 16 bracket: 2 real round-one lines (7 v 10, 8 v 9)").toBe(2);
    expect(field.sameGroupPairs).toBe(0);
  });

  it("a single-group source keeps today's Top N: the same door saves a rankRange and Complete seats it", async () => {
    const g = await groups({ sport: "generic", entrants: 6, pools: 1 });
    const [ko] = await createStages(g.auth, g.divId, {
      seq: 2, kind: "knockout", name: "Finals", config: {},
      progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }], placement: "rank_order", timing: "on_complete" },
    } as never);
    await completeGroups(g);
    expect((await knockoutField(g, ko!.id)).seated).toBe(4);
  });
});

describe.skipIf(!HAS_DB)("Add stage after groups: sequences", () => {
  it("add, delete it, add again: the second add saves the same and still seeds on Complete; a refused add in between leaves nothing behind", async () => {
    const g = await groups({ sport: "generic", entrants: 16, pools: 4 });
    const [first] = await createStages(g.auth, g.divId, formBody(8, 4) as never);
    await deleteStage(g.auth, first!.id);
    expect(await stagesOf(g.divId), "deleted").toEqual([1]);
    const refused = await refusalOf(createStages(g.auth, g.divId, tooFewBody() as never));
    expect(refused?.code).toBe("SEEDING_QUALIFY_TOO_FEW");
    expect(await stagesOf(g.divId), "the refusal wrote nothing").toEqual([1]);
    const [second] = await createStages(g.auth, g.divId, formBody(8, 4) as never);
    await completeGroups(g);
    expect((await knockoutField(g, second!.id)).seated).toBe(8);
  });

  it("a withdrawal in a group before Complete: the take saves, the groups complete, the knockout still seats the 8 (a group of 3 still has a 2nd)", async () => {
    const g = await groups({ sport: "generic", entrants: 16, pools: 4 });
    const [member] = await sql<{ id: string }[]>`select id from entrants where division_id = ${g.divId} and seed = 16`;
    await withdrawEntrantCascade(g.auth, member!.id);
    const [ko] = await createStages(g.auth, g.divId, formBody(8, 4) as never);
    await completeGroups(g, [member!.id]);
    const field = await knockoutField(g, ko!.id);
    expect(field.seated).toBe(8);
    expect(field.sameGroupPairs).toBe(0);
  });

  it("a withdrawal shrinks the field the cut is judged against: with 15 left, qualify 16 is refused by RR_CUT_EXCEEDS_FIELD naming 15", async () => {
    const g = await groups({ sport: "generic", entrants: 16, pools: 4 });
    const [member] = await sql<{ id: string }[]>`select id from entrants where division_id = ${g.divId} and seed = 16`;
    await withdrawEntrantCascade(g.auth, member!.id);
    const err = await refusalOf(createStages(g.auth, g.divId, formBody(16, 4) as never));
    expect(err?.code).toBe("RR_CUT_EXCEEDS_FIELD");
    expect(err!.extra).toMatchObject({ qualified: 16, max: 15 });
    expect(await stagesOf(g.divId)).toEqual([1]);
  });
});

describe.skipIf(!HAS_DB)("Add stage after groups: what the save door does NOT judge", () => {
  it("a setup-timing stage (the builder's templates) keeps its behaviour: the shape the save door refuses on_complete (more qualifiers than the draw takes) still SAVES - the builder only warns of it", async () => {
    const g = await groups({ sport: "generic", entrants: 40, pools: 4 });
    const body = formBody(FORMAT_BOUNDS.qualify.max + 1, 4);
    expect((await refusalOf(createStages(g.auth, g.divId, body as never)))?.code, "the premise: on_complete refuses it").toBe("SEEDING_CROSS_POOL_DRAW_TOO_LARGE");
    const [saved] = await createStages(g.auth, g.divId, { ...body, progression: { ...body.progression, timing: "setup" } } as never);
    expect(saved!.seq).toBe(2);
  });

  it("a finished source is judged by the tables it finished with, not the roster: a withdrawal AFTER every result leaves her row, so qualify 16 of 16 rows still saves", async () => {
    const g = await groups({ sport: "generic", entrants: 16, pools: 4 });
    await completeGroups(g);
    const [member] = await sql<{ id: string }[]>`select id from entrants where division_id = ${g.divId} and seed = 16`;
    await withdrawEntrantCascade(g.auth, member!.id);
    const [{ n: roster }] = await sql<{ n: number }[]>`select count(*)::int as n from entrants where division_id = ${g.divId} and status in ('registered', 'confirmed')`;
    expect(roster, "the premise: the roster is one short of the table").toBe(15);
    const [saved] = await createStages(g.auth, g.divId, formBody(16, 4) as never);
    expect(saved!.seq, "the table holds 16 rows, so the cut of 16 saves").toBe(2);
  });

  it("a FED group source is not judged against the roster (its field is whatever it was fed): no refusal from the field check", async () => {
    const g = await groups({ sport: "generic", entrants: 16, pools: 4 });
    // A second group stage fed from the first: its own field is the first's qualifiers, 8 of them, not the 16 on the roster.
    const [second] = await createStages(g.auth, g.divId, {
      seq: 2, kind: "group", name: "Second groups", config: { legs: 1, pools: { count: 2 } },
      progression: addStageGroupProgression(8, 4),
    } as never);
    expect(second!.seq).toBe(2);
    // 8 qualifiers into 2 pools of 4: a knockout of 6 (3 per group) is fine against the 8 it holds, and the 16 on the roster is irrelevant.
    const [ko] = await createStages(g.auth, g.divId, { seq: 3, kind: "knockout", name: "Finals", config: {}, progression: addStageGroupProgression(6, 2) } as never);
    expect(ko!.seq).toBe(3);
  });
});

describe.skipIf(!HAS_DB)("Add stage after groups: impossible shapes are refused at SAVE, by name, writing nothing", () => {
  it("separation CAN happen, not always: 4 groups, qualify 5 (top 1 + the best runner-up) SAVES - the draw refuses it by name only if that runner-up is the wrong group's - and the form never offers it", async () => {
    const g = await groups({ sport: "generic", entrants: 16, pools: 4 });
    const [saved] = await createStages(g.auth, g.divId, formBody(5, 4) as never);
    expect(saved!.seq, "saved: only an 'always' refusal is a 422").toBe(2);
    expect(groupTakeWorkingCounts("knockout", 4, 16), "the form's list leaves it out").not.toContain(5);
    expect(groupTakeWorkingCounts("knockout", 4, 16), "anti-vacuity: and still offers counts").toContain(8);
  });

  it("a saved 'can refuse' shape is then DRAWN by the real Complete, and which way it goes is the groups' (the draw's own rule, X-PD-4): seats 5 with no pool-mates, or is refused SEEDING_POOL_SEPARATION_IMPOSSIBLE by name - never a silent stall", async () => {
    const g = await groups({ sport: "generic", entrants: 16, pools: 4 });
    const [saved] = await createStages(g.auth, g.divId, formBody(5, 4) as never);
    const err = await refusalOf(completeGroups(g));
    const lines = async () => (await sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${saved!.id}`)[0]!.n;
    if (err === null) {
      const field = await knockoutField(g, saved!.id);
      expect(field.seated, "the knockout seats the 5 qualifiers").toBe(5);
      // Rule: 5 into a bracket of 8 puts 3 seeds on byes, so round one holds 5 - 4 = 1 real line.
      expect(field.realPairs, "anti-vacuity: round one has its one real line").toBe(1);
      expect(field.sameGroupPairs, "no pool-mates meet in round one").toBe(0);
    } else {
      expect(err.status).toBe(422);
      expect(err.code, "refused by the draw, by name").toBe("SEEDING_POOL_SEPARATION_IMPOSSIBLE");
      expect(await lines(), "nothing was half-seeded").toBe(0);
    }
  });

  it("the tables-w2d rig: 2 groups, take [top 1, best 2nd, best 3rd] into a knockout saves (three of its four outcomes refuse, one does not)", async () => {
    const g = await groups({ sport: "generic", entrants: 6, pools: 2 });
    const [saved] = await createStages(g.auth, g.divId, {
      seq: 2, kind: "knockout", name: "Finals", config: {},
      progression: { sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 1 }, { kind: "bestNth", nth: 2, count: 1 }, { kind: "bestNth", nth: 3, count: 1 }] }], placement: "rank_order", timing: "on_complete" },
    } as never);
    expect(saved!.seq).toBe(2);
  });

  it("past the draw's bounds: qualify 33 of 40 entrants -> SEEDING_CROSS_POOL_DRAW_TOO_LARGE with the bounds from FORMAT_BOUNDS", async () => {
    const g = await groups({ sport: "generic", entrants: 40, pools: 4 });
    const err = await refusalOf(createStages(g.auth, g.divId, formBody(FORMAT_BOUNDS.qualify.max + 1, 4) as never));
    expect(err?.code).toBe("SEEDING_CROSS_POOL_DRAW_TOO_LARGE");
    expect(err!.extra).toMatchObject({ entrants: 33, maxEntrants: FORMAT_BOUNDS.qualify.max, maxPools: FORMAT_BOUNDS.pools.max, phase: "save" });
    expect(await stagesOf(g.divId)).toEqual([1]);
  });

  it("more groups than the draw takes: 9 groups -> SEEDING_CROSS_POOL_DRAW_TOO_LARGE (saveGroups: no count mends it)", async () => {
    const g = await groups({ sport: "generic", entrants: 18, pools: FORMAT_BOUNDS.pools.max + 1 });
    const err = await refusalOf(createStages(g.auth, g.divId, formBody(9, FORMAT_BOUNDS.pools.max + 1) as never));
    expect(err?.code).toBe("SEEDING_CROSS_POOL_DRAW_TOO_LARGE");
    expect(err!.extra).toMatchObject({ pools: 9, phase: "saveGroups" });
  });

  it("a page playoff seats four: qualify 8 -> SEEDING_PAGE_PLAYOFF_NEEDS_FOUR; 4 saves", async () => {
    const g = await groups({ sport: "generic", entrants: 16, pools: 4 });
    const err = await refusalOf(createStages(g.auth, g.divId, formBody(8, 4, "page_playoff") as never));
    expect(err?.code).toBe("SEEDING_PAGE_PLAYOFF_NEEDS_FOUR");
    expect(err!.extra).toMatchObject({ entrants: 8 });
    const [ok] = await createStages(g.auth, g.divId, formBody(4, 4, "page_playoff") as never);
    expect(ok!.seq).toBe(2);
  });

  it("too few: a take of one place -> SEEDING_QUALIFY_TOO_FEW with the minimum", async () => {
    const g = await groups({ sport: "generic", entrants: 16, pools: 4 });
    const body = { ...formBody(8, 4), progression: { ...addStageGroupProgression(8, 4), sources: [{ stage: "previous", take: [{ kind: "bestNth", nth: 1, count: 1 }] }] } };
    const err = await refusalOf(createStages(g.auth, g.divId, body as never));
    expect(err?.code).toBe("SEEDING_QUALIFY_TOO_FEW");
    expect(err!.extra).toMatchObject({ qualified: 1, min: FORMAT_BOUNDS.qualify.min });
    expect(await stagesOf(g.divId)).toEqual([1]);
  });

  it("more than the groups hold: qualify 17 of 16 -> RR_CUT_EXCEEDS_FIELD naming the most they can supply (16 = the field's own size, snakeSizes)", async () => {
    const g = await groups({ sport: "generic", entrants: 16, pools: 4 });
    const field = snakeSizes(16, 4).reduce((a, b) => a + b, 0);
    const err = await refusalOf(createStages(g.auth, g.divId, formBody(17, 4) as never));
    expect(err?.code).toBe("RR_CUT_EXCEEDS_FIELD");
    expect(err!.extra).toMatchObject({ qualified: 17, max: field });
    expect(await stagesOf(g.divId)).toEqual([1]);
  });

  it("before the groups are drawn: the same shape saved with the groups in one batch is refused the same way, the whole batch rolled back", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Batch", visibility: "private", branding: {} });
    const [variant] = await sql<{ key: string; config: Record<string, unknown> }[]>`select key, config from sport_variants where sport_key = 'generic' and is_system order by key limit 1`;
    const div = await createDivision(auth, comp.id, { name: "Open", slug: "open", sport_key: "generic", variant_key: variant!.key, config: variant!.config } as never);
    const err = await refusalOf(createStages(auth, div.id, [{ seq: 1, kind: "group", name: "Groups", config: { legs: 1, pools: { count: 4 } } }, tooFewBody()] as never));
    expect(err?.code).toBe("SEEDING_QUALIFY_TOO_FEW");
    expect(await stagesOf(div.id)).toEqual([]);
  });
});
