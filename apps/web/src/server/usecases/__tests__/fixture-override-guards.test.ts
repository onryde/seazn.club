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
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { writeFixtureRulesOverride } from "../fixture-rules";
import { clearPoolEntrants, undoDivision } from "../history";
import { createStages, generateStageFixtures, rebuildStageFixtures } from "../stages";
import { createCompetition } from "../competitions";
import { createDivision, patchDivision } from "../divisions";
import { createEntrants, deleteEntrant } from "../entrants";
import { swissBoardsForField } from "@/lib/swiss-shell";
import { seedOrg } from "./_seed";

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

// Fix round 1 — the fourth delete: a Swiss reconcile drops surplus shells when the field shrinks before Start
// (`reconcileSwissRoundShells`). Same guard, same refusal by name, on the round being PAIRED; a later round the eager
// pass only sweeps up is left exactly as found instead (its `skip` policy — every other reconcile guard does the same).
async function swissStage(rounds: number, field: number) {
  const { auth } = await seedOrg();
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Sw own " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: "badminton", variant_key: "bwf", config: {} });
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: field }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds }, progression: null });
  await generateStageFixtures(auth, stage!.id); // mints every round's shells
  return { auth, stageId: stage!.id, entrants: entrants.map((e) => e.id) };
}
const shellsOf = (stageId: string, round: number) =>
  sql<{ id: string; ext_key: string }[]>`select id, ext_key from fixtures where stage_id = ${stageId} and round_no = ${round} order by seq_in_round`;

describe.skipIf(!HAS_DB)("Task 10 gap, fix round 1: a Swiss reshape never deletes a match's own format", () => {
  it("the paired round: refused naming the shell the shrink would delete; goes through once it is set back", async () => {
    const field = 6;
    const sw = await swissStage(3, field);
    const before = await shellsOf(sw.stageId, 1);
    const shrunk = swissBoardsForField(field - 1);
    expect(before.length, "the premise: the shrink deletes a board shell").toBeGreaterThan(shrunk.boards);
    const doomed = before.at(-1)!; // the highest `seq_in_round` goes first (the reconcile's own rule)
    await writeFixtureRulesOverride(sw.auth, [doomed.id], { bestOf: 1 });
    await deleteEntrant(sw.auth, sw.entrants.at(-1)!);
    await expect(generateStageFixtures(sw.auth, sw.stageId)).rejects.toMatchObject(ownFormat(doomed.id, await fixtureNo(doomed.id)));
    expect(await shellsOf(sw.stageId, 1), "nothing deleted, nothing minted").toEqual(before);
    await writeFixtureRulesOverride(sw.auth, [doomed.id], null);
    await generateStageFixtures(sw.auth, sw.stageId);
    expect((await sql`select 1 from fixtures where id = ${doomed.id}`).length, "the reshape really deleted it").toBe(0);
  });

  it("a later round the eager pass sweeps: left exactly as found, its own format kept; the paired round still reshapes", async () => {
    const field = 6;
    const sw = await swissStage(3, field);
    const r2 = await shellsOf(sw.stageId, 2);
    const doomed = r2.at(-1)!;
    await writeFixtureRulesOverride(sw.auth, [doomed.id], { bestOf: 1 });
    await deleteEntrant(sw.auth, sw.entrants.at(-1)!);
    await generateStageFixtures(sw.auth, sw.stageId);
    const { boards, bye } = swissBoardsForField(field - 1);
    expect((await shellsOf(sw.stageId, 1)).length, "round 1 reshaped to the shrunk field").toBe(boards + (bye ? 1 : 0));
    expect(await shellsOf(sw.stageId, 2), "round 2 untouched").toEqual(r2);
    expect((await sql<{ o: unknown }[]>`select rules_override o from fixtures where id = ${doomed.id}`)[0]!.o).toEqual({ bestOf: 1 });
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
    // Batch-3 M2: ONE wire shape for CONFIG_INVALID's issues — `{path, message}`, as v1 forwards the engine's
    // (http.ts `configIssuesOf`); never the raw zod issue with its `input` and `code`. The engine's own issues, read
    // off its schema over the mix the match would resolve.
    const engine = badminton.configSchema.safeParse({ ...outgrown, cap: capOwn });
    expect(engine.success, "the premise: the engine refuses the mix").toBe(false);
    expect((err as { extra: { issues?: unknown } }).extra.issues).toEqual(engine.success ? [] : engine.error.issues.map((i) => ({ path: i.path, message: i.message })));
    expect((await sql<{ config: unknown }[]>`select config from divisions where id = ${b.divisionId}`)[0]!.config).toEqual(before);
  });

  it("positive pair: the same save goes through with no override, and with an override it leaves valid", async () => {
    const plain = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
    await expect(patchDivision(plain.auth, plain.divisionId, { config: outgrown })).resolves.toBeDefined();
    const kept = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
    await writeFixtureRulesOverride(kept.auth, [kept.fixtureIds[0]!], { bestOf: 1 });
    await expect(patchDivision(kept.auth, kept.divisionId, { config: outgrown })).resolves.toBeDefined();
  });
  // Fix round 1 (I1 ruling): a match with an OUTCOME, or in a locked status, is not unstarted whatever its snapshot
  // says, so the guard does not ask it — a decided match's format is a correction's business (the writer's award
  // path), and a finished one's is locked. Raw-seeded: through the real chains a decided match freezes its cfg and
  // X-SR-4 then refuses the save before this guard runs. Paired with the refusal above (same override, same save).
  it("a decided or finished match carrying its own format is not asked: the same save goes through", async () => {
    const shapes: { label: string; seed: (id: string, home: string, away: string) => Promise<unknown> }[] = [
      { label: "cancelled", seed: (id) => sql`update fixtures set status = 'cancelled' where id = ${id}` },
      { label: "finalized", seed: (id) => sql`update fixtures set status = 'finalized' where id = ${id}` },
      {
        label: "an award no event records",
        seed: (id, home, away) =>
          sql`update fixtures set status = 'forfeited',
                outcome = ${sql.json({ kind: "award", winner: home, loser: away, reason: "withdrew" })} where id = ${id}`,
      },
    ];
    let checked = 0;
    for (const s of shapes) {
      const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
      const id = b.fixtureIds[0]!;
      await writeFixtureRulesOverride(b.auth, [id], { cap: capOwn });
      const [f] = await sql<{ home: string; away: string }[]>`select home_entrant_id home, away_entrant_id away from fixtures where id = ${id}`;
      await s.seed(id, f!.home, f!.away);
      await expect(patchDivision(b.auth, b.divisionId, { config: outgrown }), s.label).resolves.toBeDefined();
      checked++;
    }
    expect(checked).toBe(shapes.length);
  });
  // No "started match" case: a frozen snapshot locks its stage (rule-locks.ts `lockedStageIdsAmong`), and X-SR-4 then
  // refuses every field that stage inherits before this guard runs — so the guard's `config_snapshot is null` scope is
  // unobservable through a division save (recorded as an equivalent mutant in the task report).
});
