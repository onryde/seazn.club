// W5 stress fix F7: a group stage of more than 26 pools answered Start with a bare `422 CONFIG_INVALID "invalid pool count
// 100"`, and the stages API took the count without a ceiling. The ceiling is the pool-key alphabet (a pool is keyed by one
// capital letter, A to Z: `POOL_KEYS`, usecases/stages/generators.ts). Past it, both doors now refuse by NAME
// (RR_TOO_MANY_POOLS, the round-robin refusal table's row): the create door (the schema's ceiling, mapped in api-v1/http.ts)
// and Start (the generator), with `max` (and at Start the count asked for) for the copy.
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
import { createStages } from "../stages";
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

describe("F7: the create door refuses a 27th pool by name", () => {
  const stage = (count: number) => ({ seq: 1, kind: "group", name: "Groups", config: { pools: { count } }, progression: null });

  it("26 pools parse; 27 is refused RR_TOO_MANY_POOLS 422 naming the ceiling and the field, never the generic Invalid input", async () => {
    expect(CreateStages.safeParse(stage(26)).success, "the boundary itself is a stage").toBe(true);
    for (const body of [stage(27), [stage(100)]]) {
      const parsed = CreateStages.safeParse(body);
      expect(parsed.success).toBe(false);
      const res = await v1(async () => {
        throw new ZodError(parsed.error!.issues);
      });
      const json = (await res.json()) as { error: { code: string; message: string; max?: number; field?: string } };
      expect(res.status).toBe(422);
      expect(json.error.code).toBe("RR_TOO_MANY_POOLS");
      expect(json.error.max).toBe(LETTERS.length);
      expect(json.error.field).toMatch(/config\.pools\.count$/);
      expect(json.error.message).toContain(String(LETTERS.length));
      expect(json.error.message, "no unfilled placeholder").not.toMatch(/\{\w+\}/);
    }
  });

  it("a count under 1 is still the plain validation refusal (the empty case is not this refusal)", async () => {
    const parsed = CreateStages.safeParse(stage(0));
    expect(parsed.success).toBe(false);
    const res = await v1(async () => {
      throw new ZodError(parsed.error!.issues);
    });
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).not.toBe("RR_TOO_MANY_POOLS");
  });
});

async function groupStage(entrants: number, pools: number) {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "F7 " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, { name: "Open", slug: "f7-" + randomUUID().slice(0, 6), sport_key: "badminton", variant_key: "bwf", config: {} } as never);
  await createEntrants(auth, d.id, Array.from({ length: entrants }, (_, i) => ({ kind: "individual", display_name: `P${i + 1}`, seed: i + 1, members: [] })) as never);
  // The usecase stores what the door let through: an API client before this fix, or a stored stage from then.
  const [st] = await createStages(auth, d.id, { seq: 1, kind: "group", name: "Groups", config: { legs: 1, pools: { count: pools } }, progression: null } as never);
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
