// W2c Task 14 — the two guards that keep a match's own format (`fixtures.rules_override`, written by the one writer
// `writeFixtureRulesOverride`) from being lost or invalidated by a write somewhere else:
//
//  * Task 10 review gap — a rebuild, an Undo of a generation and a pool clear DELETE unplayed fixtures (regenerated
//    from the stage, or restored from a snapshot that does not carry the override). Each refuses by name
//    (`FIXTURE_HAS_OWN_FORMAT`, "Match N has its own format") instead of dropping the override silently.
//  * batch-1 I-A, one layer up — a division save must not make an UNSTARTED match's own format invalid:
//    `division ⊕ stage.rules ⊕ bracketDeciders ⊕ rules_override` must still parse, or the save is refused (422)
//    naming the match.
//
// Every refusal is paired with its positive (the same write without the override goes through), so a guard that
// refuses everything cannot pass. Expected values are the engine's own (`configSchema`, `variants`). Single sport
// (badminton): the guards read only `rules_override` and the sport's own schema, both sport-blind code paths; the
// per-sport sweep of the writer is fixture-rules.test.ts.
import { afterAll, describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { patchDivision } from "../divisions";
import { writeFixtureRulesOverride } from "../fixture-rules";
import { clearPoolEntrants, undoDivision } from "../history";
import { rebuildStageFixtures } from "../stages";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const badminton = builtinModules.find((m) => m.key === "badminton")!;
const SHORT = badminton.configSchema.parse(badminton.variants.short) as { setTo: number; finalSetTo: number; cap: number | null; bestOf: number };
const fixtureNo = async (id: string) => (await sql<{ fixture_no: number }[]>`select fixture_no from fixtures where id = ${id}`)[0]!.fixture_no;
const count = async (stageId: string) => Number((await sql<{ n: string }[]>`select count(*)::text n from fixtures where stage_id = ${stageId}`)[0]!.n);
const ownFormat = (id: string, no: number) => ({ status: 409, code: "FIXTURE_HAS_OWN_FORMAT", extra: { fixture_id: id }, message: expect.stringContaining(`Match ${no} has its own format`) });

describe.skipIf(!HAS_DB)("Task 10 gap: a delete never takes a match's own format with it", () => {
  it("rebuild: refused naming the match while one carries its own format; goes through once it is set back", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 3 });
    const id = b.fixtureIds[1]!;
    await writeFixtureRulesOverride(b.auth, [id], { bestOf: 1 });
    const before = await count(b.stageId);
    await expect(rebuildStageFixtures(b.auth, b.stageId)).rejects.toMatchObject(ownFormat(id, await fixtureNo(id)));
    expect(await count(b.stageId), "nothing deleted").toBe(before);
    expect((await sql`select 1 from fixtures where id = ${id} and rules_override is not null`).length).toBe(1);
    await writeFixtureRulesOverride(b.auth, [id], null);
    await expect(rebuildStageFixtures(b.auth, b.stageId)).resolves.toBeDefined();
  });

  it("Undo of a generation: refused naming the match; goes through once it is set back", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 3 });
    const id = b.fixtureIds[0]!;
    await writeFixtureRulesOverride(b.auth, [id], { bestOf: 1 });
    await expect(undoDivision(b.auth, b.divisionId)).rejects.toMatchObject(ownFormat(id, await fixtureNo(id)));
    expect(await count(b.stageId)).toBe(b.fixtureIds.length);
    await writeFixtureRulesOverride(b.auth, [id], null);
    await undoDivision(b.auth, b.divisionId);
    expect(await count(b.stageId), "the undo really deleted the generation").toBe(0);
  });

  it("pool clear: refused only for the pool whose match carries its own format — the scope is the delete's own", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "group", entrants: 6, stageConfig: { pools: { count: 2 } } });
    const pools = await sql<{ id: string }[]>`select id from pools where stage_id = ${b.stageId} order by key`;
    expect(pools.length).toBe(2);
    const [poolA, poolB] = [pools[0]!.id, pools[1]!.id];
    const [inB] = await sql<{ id: string }[]>`select id from fixtures where pool_id = ${poolB} order by fixture_no limit 1`;
    await writeFixtureRulesOverride(b.auth, [inB!.id], { bestOf: 1 });
    // Pool A's fixtures carry nothing of their own: its clear goes through, though the stage holds an override.
    await expect(clearPoolEntrants(b.auth, poolA, true)).resolves.toMatchObject({ removed: expect.any(Number) });
    await expect(clearPoolEntrants(b.auth, poolB, true)).rejects.toMatchObject(ownFormat(inB!.id, await fixtureNo(inB!.id)));
    await writeFixtureRulesOverride(b.auth, [inB!.id], null);
    await expect(clearPoolEntrants(b.auth, poolB, true)).resolves.toMatchObject({ removed: expect.any(Number) });
  });
});

describe.skipIf(!HAS_DB)("I-A one layer up: a division save never makes an unstarted match's own format invalid", () => {
  // The match caps its sets (a match key) at a value the division then outgrows: setTo above the match's cap is the
  // engine's own refusal ("cap must be ≥ the set target"), read off its schema below.
  const capOwn = (SHORT.cap ?? SHORT.setTo) + 1;
  const outgrown = { ...(badminton.variants.short as object), setTo: capOwn + 1, finalSetTo: capOwn + 1, cap: capOwn + 4 };

  it("premise: the outgrown mix is refused by the engine, and the division's own config is valid", () => {
    expect(badminton.configSchema.safeParse(outgrown).success).toBe(true);
    expect(badminton.configSchema.safeParse({ ...outgrown, cap: capOwn }).success).toBe(false);
  });

  it("refused 422 naming the match; the division config is unchanged", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
    const id = b.fixtureIds[0]!;
    await writeFixtureRulesOverride(b.auth, [id], { cap: capOwn });
    const before = (await sql<{ config: unknown }[]>`select config from divisions where id = ${b.divisionId}`)[0]!.config;
    const err = await patchDivision(b.auth, b.divisionId, { config: outgrown }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422, code: "CONFIG_INVALID", extra: { fixture_id: id } });
    expect(String((err as Error).message)).toContain(`Match ${await fixtureNo(id)} has its own format`);
    expect((await sql<{ config: unknown }[]>`select config from divisions where id = ${b.divisionId}`)[0]!.config).toEqual(before);
  });

  it("positive pair: the same save goes through with no override, and with an override it leaves valid", async () => {
    const plain = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
    await expect(patchDivision(plain.auth, plain.divisionId, { config: outgrown })).resolves.toBeDefined();
    const kept = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
    await writeFixtureRulesOverride(kept.auth, [kept.fixtureIds[0]!], { bestOf: 1 });
    await expect(patchDivision(kept.auth, kept.divisionId, { config: outgrown })).resolves.toBeDefined();
  });
  // No "started match" case: a frozen snapshot locks its stage (rule-locks.ts `lockedStageIdsAmong`), and X-SR-4 then
  // refuses every field that stage inherits before this guard runs — so the guard's `config_snapshot is null` scope is
  // unobservable through a division save (recorded as an equivalent mutant in the task report).
});
