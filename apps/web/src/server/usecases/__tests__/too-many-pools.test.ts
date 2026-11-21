// W5 stress fix F7: a group stage of more than 26 pools answered Start with a bare `422 CONFIG_INVALID "invalid pool count
// 100"`, and the stages API took the count without a ceiling. The ceiling is the pool-key alphabet (a pool is keyed by one
// capital letter, A to Z: `POOL_KEYS`, usecases/stages/generators.ts). Past it, every door now refuses by NAME
// (RR_TOO_MANY_POOLS, 422, the round-robin refusal table's row), with `max` and the count asked for (`pools`) for the copy: both
// stage writers (create, and the Format dialog's replace - their shared gate) and Start (the generator, for a stage stored
// before the gate). It is a domain refusal, not a schema one: the body is well formed, and the ZodError branch answers 400
// only (the matrix harness pins that), so the schema takes any whole count from 1.
//
// Expected values: 26 is the letters A-Z, counted here from the alphabet, not read from the code under test; the 26-pool
// boundary's line count is the round-robin formula, pools x C(size, 2).
//
// The refusal is decided before any sport work (pool keys are sport-agnostic): one sport, badminton, as the W5 suites use.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { POOL_COUNT_MAX } from "@/lib/format-bounds";
import { CreateStages } from "@/server/api-v1/schemas/stages";
import { v1 } from "@/server/api-v1/http";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { createStages, previewReplaceStages, replaceStages } from "../stages";
import { POOL_KEYS } from "../stages/generators";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** The letters A to Z, counted from the character codes: the alphabet a pool key is one of. */
const LETTERS = Array.from({ length: "Z".charCodeAt(0) - "A".charCodeAt(0) + 1 }, (_, i) => String.fromCharCode("A".charCodeAt(0) + i)).join("");

describe("F7: the ceiling is the pool-key alphabet", () => {
  it("POOL_KEYS is exactly A..Z, and the shared ceiling is its length (26)", () => {
    expect(POOL_KEYS).toBe(LETTERS);
    expect(LETTERS.length).toBe(26);
    expect(POOL_COUNT_MAX).toBe(LETTERS.length);
  });
});

const stage = (count: number, seq = 1) => ({ seq, kind: "group", name: "Groups", config: { legs: 1, pools: { count } }, progression: null });

describe("F7: the ceiling is not a validation answer", () => {
  it("the schema takes any whole count from 1 - the boundary and past it alike - so no ZodError ever carries this refusal", () => {
    for (const n of [1, LETTERS.length, LETTERS.length + 1, 100]) expect(CreateStages.safeParse(stage(n)).success, `${n} pools parse`).toBe(true);
    expect(CreateStages.safeParse([stage(LETTERS.length + 1)]).success, "and in a batch").toBe(true);
  });

  it("a count under 1 is the plain 400 validation refusal (the empty case is not this refusal)", async () => {
    const parsed = CreateStages.safeParse(stage(0));
    expect(parsed.success).toBe(false);
    const res = await v1(async () => {
      throw new ZodError(parsed.error!.issues);
    });
    const json = (await res.json()) as { error: { code: string } };
    expect([res.status, json.error.code]).toEqual([400, "VALIDATION"]);
  });
});

type Refusal = { status: number; code: string; message: string; max?: number; pools?: number; seq?: number };
/** A writer's answer over the wire (`v1`, the routes' own wrapper). */
async function answer(write: () => Promise<unknown>): Promise<Refusal> {
  const res = await v1(write);
  const json = (await res.json()) as { error?: Omit<Refusal, "status"> };
  return { status: res.status, ...(json.error ?? { code: "", message: "" }) };
}
const refusedAt = (r: Refusal, pools: number, seq: number) => {
  expect([r.status, r.code]).toEqual([422, "RR_TOO_MANY_POOLS"]);
  expect({ max: r.max, pools: r.pools, seq: r.seq }).toEqual({ max: LETTERS.length, pools, seq });
  expect(r.message).toContain(String(LETTERS.length));
  expect(r.message, "no unfilled placeholder").not.toMatch(/\{\w+\}/);
};
async function emptyDivision() {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "F7 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, { name: "Open", slug: "f7-" + randomUUID().slice(0, 6), sport_key: "badminton", variant_key: "bwf", config: {} } as never);
  return { auth, divisionId: d.id };
}
const storedPools = async (divisionId: string) =>
  (await sql<{ count: number | null }[]>`select (config -> 'pools' ->> 'count')::int as count from stages where division_id = ${divisionId} order by seq`).map((r) => r.count);

describe.skipIf(!HAS_DB)("F7: both stage writers refuse a 27th pool by name", () => {
  it("create: the empty division first; 27 pools is RR_TOO_MANY_POOLS 422 with the ceiling, the count and the stage, nothing written; 26 is written", async () => {
    const { auth, divisionId } = await emptyDivision();
    expect(await storedPools(divisionId), "the empty case: no stage").toEqual([]);
    refusedAt(await answer(() => createStages(auth, divisionId, stage(LETTERS.length + 1) as never)), LETTERS.length + 1, 1);
    expect(await storedPools(divisionId)).toEqual([]);
    // In a batch, the second stage past the ceiling refuses the whole batch: the first is not written either.
    refusedAt(await answer(() => createStages(auth, divisionId, [stage(2, 1), stage(100, 2)] as never)), 100, 2);
    expect(await storedPools(divisionId)).toEqual([]);
    await createStages(auth, divisionId, stage(LETTERS.length) as never);
    expect(await storedPools(divisionId), "the boundary is a stage").toEqual([LETTERS.length]);
  });

  it("replace (the Format dialog's write) and its preview: the same refusal, the stored stage untouched; a second replace inside the ceiling goes through", async () => {
    const { auth, divisionId } = await emptyDivision();
    await createStages(auth, divisionId, stage(2) as never);
    refusedAt(await answer(() => replaceStages(auth, divisionId, stage(LETTERS.length + 1) as never)), LETTERS.length + 1, 1);
    refusedAt(await answer(() => previewReplaceStages(auth, divisionId, stage(LETTERS.length + 1) as never)), LETTERS.length + 1, 1);
    expect(await storedPools(divisionId), "the stage stands as it was").toEqual([2]);
    await replaceStages(auth, divisionId, stage(LETTERS.length) as never);
    expect(await storedPools(divisionId)).toEqual([LETTERS.length]);
  });
});

async function groupStage(entrants: number, pools: number) {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "F7 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, { name: "Open", slug: "f7-" + randomUUID().slice(0, 6), sport_key: "badminton", variant_key: "bwf", config: {} } as never);
  await createEntrants(auth, d.id, Array.from({ length: entrants }, (_, i) => ({ kind: "individual", display_name: `P${i + 1}`, seed: i + 1, members: [] })) as never);
  // A stage past the ceiling is one stored before the writers' gate (an API client then): the writers refuse it now, so it is
  // written at the ceiling and its count set in the row, as such a stage stands.
  const [st] = await createStages(auth, d.id, stage(Math.min(pools, LETTERS.length)) as never);
  if (pools > LETTERS.length) await sql`update stages set config = jsonb_set(config, '{pools,count}', to_jsonb(${pools}::int)) where id = ${st!.id}`;
  expect((await storedPools(d.id))).toEqual([pools]);
  return { auth, divisionId: d.id, stageId: st!.id };
}

describe.skipIf(!HAS_DB)("F7: Start refuses a stored stage past the alphabet by name", () => {
  it("27 pools: RR_TOO_MANY_POOLS 422 with max 26 and the count asked for; nothing is written", { timeout: 120_000 }, async () => {
    const rig = await groupStage(54, 27);
    const e = await startDivision(rig.auth, rig.divisionId).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(HttpError);
    const err = e as HttpError;
    expect([err.status, err.code]).toEqual([422, "RR_TOO_MANY_POOLS"]);
    expect(err.extra).toMatchObject({ max: LETTERS.length, pools: 27 });
    expect((await sql`select 1 from fixtures where stage_id = ${rig.stageId}`).length).toBe(0);
  });

  it("the boundary: 26 pools of 2 start, 26 x C(2,2) = 26 lines, one per pool key A..Z", { timeout: 120_000 }, async () => {
    const rig = await groupStage(52, 26);
    await startDivision(rig.auth, rig.divisionId);
    const lines = await sql<{ pool_id: string }[]>`select pool_id from fixtures where stage_id = ${rig.stageId}`;
    expect(lines.length).toBe(26 * 1);
    const keys = await sql<{ key: string }[]>`select distinct p.key from pools p join fixtures f on f.pool_id = p.id where f.stage_id = ${rig.stageId} order by p.key`;
    expect(keys.map((k) => k.key).join("")).toBe(LETTERS);
  });
});
