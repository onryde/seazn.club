// W2c Task 7 (CA-AB-2, GN-AB-2; owner P-5; review I6) - "share the points" on an abandon, at the layers the engine unit
// test cannot see. The engine folds a shared abandon to a draw; whether the SERVER takes it is two separate gates, and each
// is tested where it lives:
//   - the SAVE: `patchDivision` parses the division cfg through the sport's own schema, so a cfg that shares points without
//     allowing draws is refused CONFIG_INVALID with the owner's wording and nothing is written;
//   - the APPEND: a draw the stage's cfg does not support is DRAW_NOT_ALLOWED, so the fold and that gate must agree on a
//     shared draw (and a cfg that got past the save, by a direct write, still cannot record one).
// Real Postgres (callers skip without DATABASE_URL). Expected values are the rule rows (GN-AB-1/2, CA-AB-1/2) and the
// owner's wording, never the code under test.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { appendEvent } from "@/server/engine-db";
import { patchDivision } from "@/server/usecases/divisions";
import { seedBracket } from "./helpers/seed-bracket";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** The owner's wording (P-5), as signed in the rule row GN-AB-2. */
const SHARE_NEEDS_DRAWS = "Sharing the points needs draws to be allowed.";

type Fx = { status: string; outcome: { kind: string } | null; home: string; away: string };
const fx = async (id: string) =>
  (await sql<Fx[]>`select status, outcome, home_entrant_id as home, away_entrant_id as away from fixtures where id = ${id}`)[0]!;
const configOf = async (divisionId: string) => (await sql<{ config: Record<string, unknown> }[]>`select config from divisions where id = ${divisionId}`)[0]!.config;
/** The division's cfg with `extra` merged in by a DIRECT write - the stand-in for a division form save with a value that
 *  save accepts, or (with a value it refuses) for a cfg that got in around the save. Before the first event, so the fixture
 *  freezes it. */
const setConfig = (divisionId: string, extra: Record<string, unknown>) =>
  sql`update divisions set config = config || ${sql.json(extra as never)} where id = ${divisionId}`;

async function liveGeneric(extra: Record<string, unknown>) {
  const b = await seedBracket({ sport: "generic", variant: "score", stageKind: "league", entrants: 2 });
  await setConfig(b.divisionId, extra);
  const id = b.fixtureIds[0]!;
  const f = await fx(id);
  await appendEvent(b.auth.orgId, id, 0, { type: "core.start", payload: {} });
  await appendEvent(b.auth.orgId, id, 1, { type: "generic.score", payload: { by: f.home, points: 2 } });
  await appendEvent(b.auth.orgId, id, 2, { type: "generic.score", payload: { by: f.away, points: 1 } });
  return { b, id, f };
}

async function liveCarrom(extra: Record<string, unknown>) {
  const b = await seedBracket({ sport: "carrom", variant: "icf", stageKind: "league", entrants: 2 });
  await setConfig(b.divisionId, extra);
  const id = b.fixtureIds[0]!;
  await appendEvent(b.auth.orgId, id, 0, { type: "core.start", payload: {} });
  return { b, id };
}

describe.skipIf(!HAS_DB)("GN-AB-2 CA-AB-2 share at append time (review I6)", () => {
  it("empty case first: with no policy an abandon is a replay (GN-AB-1) - abandoned, nobody decided - and voiding it resumes play", async () => {
    const { b, id } = await liveGeneric({});
    await appendEvent(b.auth.orgId, id, 3, { type: "core.abandon", payload: { reason: "weather" } });
    expect(await fx(id)).toMatchObject({ status: "abandoned", outcome: null });
    const [abandon] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${id} and type = 'core.abandon'`;
    await appendEvent(b.auth.orgId, id, 4, { type: "core.void", payload: {}, voids: abandon!.id });
    expect(await fx(id)).toMatchObject({ status: "in_play", outcome: null });
  });

  it("GN-AB-2: allowDraws on - a 2-1 abandon under share is accepted as a draw and decided", async () => {
    const { b, id } = await liveGeneric({ allowDraws: true, abandonPolicy: "share" });
    await appendEvent(b.auth.orgId, id, 3, { type: "core.abandon", payload: { reason: "weather" } });
    expect(await fx(id)).toMatchObject({ status: "decided", outcome: { kind: "draw" } });
  });

  it("GN-AB-2: a cfg that reached the ledger around the save (draws off, share on) still cannot record the draw - DRAW_NOT_ALLOWED, ledger untouched", async () => {
    const { b, id } = await liveGeneric({ allowDraws: false, abandonPolicy: "share" });
    const before = (await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${id}`)[0]!.n;
    await expect(appendEvent(b.auth.orgId, id, 3, { type: "core.abandon", payload: { reason: "weather" } })).rejects.toMatchObject({ code: "DRAW_NOT_ALLOWED" });
    expect((await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${id}`)[0]!.n).toBe(before);
  });

  it("CA-AB-2: carrom with the house draw rule - an abandon under share is accepted as a draw and decided", async () => {
    const { b, id } = await liveCarrom({ tieBoard: "draw", abandonPolicy: "share" });
    await appendEvent(b.auth.orgId, id, 1, { type: "core.abandon", payload: { reason: "weather" } });
    expect(await fx(id)).toMatchObject({ status: "decided", outcome: { kind: "draw" } });
  });

  it("CA-AB-2: carrom under ICF play (tieBoard extra) is the case the save refuses; around the save the draw is DRAW_NOT_ALLOWED", async () => {
    const { b, id } = await liveCarrom({ tieBoard: "extra", abandonPolicy: "share" });
    await expect(appendEvent(b.auth.orgId, id, 1, { type: "core.abandon", payload: { reason: "weather" } })).rejects.toMatchObject({ code: "DRAW_NOT_ALLOWED" });
  });
});

describe.skipIf(!HAS_DB)("P-5 the save refuses share without draws, with the owner's wording, and writes nothing", () => {
  /** `{ code, data.issues }` of the refusal a save of `config` over the division gets, or null when it saved. */
  async function refusalOf(auth: Parameters<typeof patchDivision>[0], divisionId: string, config: Record<string, unknown>) {
    return patchDivision(auth, divisionId, { config } as never).then(
      () => null,
      (e: unknown) => e as { code: string; data: { issues: { message: string; path: string[] }[] } },
    );
  }

  it("P-5 generic: allowDraws off + share is CONFIG_INVALID on the abandonPolicy field, the stored cfg is unchanged; the same save with draws allowed saves", async () => {
    const b = await seedBracket({ sport: "generic", variant: "score", stageKind: "league", entrants: 2 });
    const before = await configOf(b.divisionId);
    const refusal = await refusalOf(b.auth, b.divisionId, { ...before, allowDraws: false, abandonPolicy: "share" });
    expect(refusal, "the save must be refused").not.toBeNull();
    expect(refusal!.code).toBe("CONFIG_INVALID");
    expect(refusal!.data.issues.map((i) => [i.message, i.path])).toEqual([[SHARE_NEEDS_DRAWS, ["abandonPolicy"]]]);
    expect(await configOf(b.divisionId), "nothing was written").toEqual(before);
    // The positive pair: the same write with draws allowed saves, and the policy is stored.
    expect(await refusalOf(b.auth, b.divisionId, { ...before, allowDraws: true, abandonPolicy: "share" })).toBeNull();
    expect(await configOf(b.divisionId)).toMatchObject({ allowDraws: true, abandonPolicy: "share" });
  });

  it("P-5 carrom: share under tieBoard extra is refused the same way; with tieBoard draw it saves", async () => {
    const b = await seedBracket({ sport: "carrom", variant: "icf", stageKind: "league", entrants: 2 });
    const before = await configOf(b.divisionId);
    const refusal = await refusalOf(b.auth, b.divisionId, { ...before, tieBoard: "extra", abandonPolicy: "share" });
    expect(refusal, "the save must be refused").not.toBeNull();
    expect(refusal!.code).toBe("CONFIG_INVALID");
    expect(refusal!.data.issues.map((i) => [i.message, i.path])).toEqual([[SHARE_NEEDS_DRAWS, ["abandonPolicy"]]]);
    expect(await configOf(b.divisionId), "nothing was written").toEqual(before);
    expect(await refusalOf(b.auth, b.divisionId, { ...before, tieBoard: "draw", abandonPolicy: "share" })).toBeNull();
    expect(await configOf(b.divisionId)).toMatchObject({ tieBoard: "draw", abandonPolicy: "share" });
  });
});
