// W2c Task 13 fix rounds 1 and 2, rulings R-T13-2 and R-T13-3. `replaceStages` (the Format tab's Apply) once deleted the
// division's stage graph in its own committed transaction and then called `createStages`, so every refusal raised from
// its INPUT after that point (the entitlement gates, the stage cap, the feed-graph check, a duplicate seq in the body)
// emptied the division. Now the pooled gates (`assertStageBatchGates`) answer before the transaction opens, and the
// delete and every insert run in ONE transaction (`insertStageBatch`), so any later refusal rolls the delete back. The
// witness for "untouched" is the division's stage ids, in board order: the same count AND the same rows (a refused Apply
// that recreated identical stages would still be a loss of every row's id).
//
// Expected values come from the entitlement table itself (`getLimit`) and the feature keys the gates name, never from a
// typed plan table. Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { stageDefaultsFor, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { getLimit, invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures, replaceStages } from "../stages";
import { makeUser } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

async function seedOrg(plan: "pro" | "community"): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const owner = await makeUser("owner");
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by) values (${"Rg " + suffix}, ${"rg-" + suffix}, ${owner.id})
    returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${owner.id}, 'owner')`;
  await setOrgPlan(orgId, plan);
  await invalidateOrgEntitlements(orgId);
  return { orgId, via: "session", userId: owner.id, role: "owner", keyId: null };
}

/** A DENY override beats the plan: the one lever that withholds a feature a plan grants (custom-points.test.ts). */
async function denyFeature(orgId: string, featureKey: string): Promise<void> {
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
    values (${orgId}, ${featureKey}, false, 'test')
    on conflict (org_id, feature_key) do update set bool_value = false`;
  await invalidateOrgEntitlements(orgId);
}

async function seedDivision(auth: AuthCtx): Promise<{ divisionId: string; competitionId: string }> {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Rg Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "badminton",
    variant_key: "short",
    config: {},
  });
  return { divisionId: division.id, competitionId: comp.id };
}

const league = (seq: number, config: Record<string, unknown> = {}) =>
  ({ seq, kind: "league" as const, name: `L${seq}`, config, progression: null });

const stageIds = async (divisionId: string): Promise<string[]> =>
  (await sql<{ id: string }[]>`select id from stages where division_id = ${divisionId} order by seq`).map((r) => r.id);

/** One stage to lose (its id is the witness): the premise every "untouched" assertion below rests on. */
async function seededGraph(auth: AuthCtx): Promise<{ divisionId: string; competitionId: string; before: string[] }> {
  const d = await seedDivision(auth);
  await createStages(auth, d.divisionId, [league(1)]);
  const before = await stageIds(d.divisionId);
  expect(before.length, "premise: a stage graph to lose").toBe(1);
  return { ...d, before };
}

const withForfeit = { base: { win: 3, draw: 1, loss: 0 }, forfeit: { winnerPoints: 3, loserPoints: 0 } };

describe.skipIf(!HAS_DB)("R-T13-2 replaceStages asks every batch gate BEFORE its delete", () => {
  it("the positive pair first: a clean Apply replaces the graph (new rows)", async () => {
    const auth = await seedOrg("pro");
    const { divisionId, before } = await seededGraph(auth);
    await replaceStages(auth, divisionId, [league(1), league(2)]);
    const after = await stageIds(divisionId);
    expect(after.length).toBe(2);
    expect(after).not.toContain(before[0]);
  });

  it("a custom_points 402 leaves the original stages untouched (count and ids)", async () => {
    const auth = await seedOrg("pro");
    await denyFeature(auth.orgId, "standings.custom_points");
    const { divisionId, before } = await seededGraph(auth);
    await expect(replaceStages(auth, divisionId, [league(1, { points: withForfeit })])).rejects.toMatchObject({
      status: 402,
      featureKey: "standings.custom_points",
    });
    expect(await stageIds(divisionId)).toEqual(before);
  });

  it("a formats.double_elim 402 leaves the original stages untouched (count and ids)", async () => {
    const auth = await seedOrg("pro");
    await denyFeature(auth.orgId, "formats.double_elim");
    const { divisionId, before } = await seededGraph(auth);
    await expect(
      replaceStages(auth, divisionId, [{ seq: 1, kind: "double_elim", name: "DE", config: {}, progression: null }]),
    ).rejects.toMatchObject({ status: 402, featureKey: "formats.double_elim" });
    expect(await stageIds(divisionId)).toEqual(before);
  });

  it("the stage cap's 402, counted against the batch, leaves the original stages untouched", async () => {
    const auth = await seedOrg("community");
    const { divisionId, competitionId, before } = await seededGraph(auth);
    const cap = await getLimit(auth.orgId, "stages.per_division.max", competitionId);
    expect(cap, "premise: Community caps the stages per division").not.toBeNull();
    const body = Array.from({ length: cap! + 1 }, (_, i) => league(i + 1));
    await expect(replaceStages(auth, divisionId, body)).rejects.toMatchObject({
      status: 402,
      featureKey: "stages.per_division.max",
    });
    expect(await stageIds(divisionId)).toEqual(before);
    // The positive pair at the cap itself: exactly `cap` stages lands.
    await replaceStages(auth, divisionId, body.slice(0, cap!));
    expect((await stageIds(divisionId)).length).toBe(cap);
  });

  it("a duplicate seq inside the body is 409 and leaves the original stages untouched", async () => {
    const auth = await seedOrg("pro");
    const { divisionId, before } = await seededGraph(auth);
    await expect(replaceStages(auth, divisionId, [league(1), { ...league(1), name: "Twin" }])).rejects.toMatchObject({
      status: 409,
    });
    expect(await stageIds(divisionId)).toEqual(before);
  });

  it("a nonexistent division, or another org's, is 404 before any gate's 402; the other org's stages untouched", async () => {
    const auth = await seedOrg("pro");
    await denyFeature(auth.orgId, "standings.custom_points");
    await expect(replaceStages(auth, randomUUID(), [league(1, { points: withForfeit })])).rejects.toMatchObject({ status: 404 });
    const other = await seedOrg("pro");
    const theirs = await seededGraph(other);
    await expect(replaceStages(auth, theirs.divisionId, [league(1, { points: withForfeit })])).rejects.toMatchObject({ status: 404 });
    expect(await stageIds(theirs.divisionId)).toEqual(theirs.before);
    // The positive pair: the same body on the denied org's OWN division answers the gate's 402.
    const own = await seededGraph(auth);
    await expect(replaceStages(auth, own.divisionId, [league(1, { points: withForfeit })])).rejects.toMatchObject({ status: 402 });
  });
});

describe.skipIf(!HAS_DB)("R-T13-3 replaceStages deletes and inserts in ONE transaction: any later refusal rolls the delete back", () => {
  // A stage at seq 1 that names "previous" as its source: nothing in the batch gates reads progression sources, so
  // the refusal comes from `validateStageProgression`, AFTER the inserts (stage-seeding.ts, SEEDING_RULES_MISSING).
  const fromPrevious = {
    sources: [{ stage: "previous" as const, take: [{ kind: "rankRange" as const, from: 1, to: 2 }] }],
    placement: "rank_order" as const,
    timing: "on_complete" as const,
  };

  it("a progression refused after the inserts (SEEDING_RULES_MISSING) leaves the original stages untouched", async () => {
    const auth = await seedOrg("pro");
    const { divisionId, before } = await seededGraph(auth);
    await expect(
      replaceStages(auth, divisionId, [{ seq: 1, kind: "league", name: "First", config: {}, progression: fromPrevious }]),
    ).rejects.toMatchObject({ status: 422, code: "SEEDING_RULES_MISSING" });
    expect(await stageIds(divisionId)).toEqual(before);
  });

  it("a refusal from inside the insert loop (the database's progression shape check) leaves the original stages untouched", async () => {
    const auth = await seedOrg("pro");
    const { divisionId, before } = await seededGraph(auth);
    // No schema stands in front of the usecase: a placement the column's CHECK refuses reaches the INSERT itself.
    const badShape = { ...fromPrevious, placement: "not-a-placement" } as unknown as typeof fromPrevious;
    await expect(
      replaceStages(auth, divisionId, [league(1), { seq: 2, kind: "league", name: "Bad", config: {}, progression: badShape }]),
    ).rejects.toMatchObject({ code: "23514" });
    expect(await stageIds(divisionId)).toEqual(before);
  });

  it("the positive pair: a valid graph with a progression from the previous stage commits", async () => {
    const auth = await seedOrg("pro");
    const { divisionId, before } = await seededGraph(auth);
    const out = await replaceStages(auth, divisionId, [league(1), { seq: 2, kind: "knockout", name: "Cup", config: {}, progression: fromPrevious }]);
    expect(out.map((r) => r.seq)).toEqual([1, 2]);
    const after = await stageIds(divisionId);
    expect(after.length).toBe(2);
    expect(after).not.toContain(before[0]);
  });
});

describe.skipIf(!HAS_DB)("fix round 2 (c): Apply on a LOCKED division answers FORMAT_LOCKED before any gate", () => {
  it("fixtures exist + a gated body = 409 FORMAT_LOCKED, never the 402; nothing changes", async () => {
    const auth = await seedOrg("pro");
    await denyFeature(auth.orgId, "standings.custom_points");
    const { divisionId } = await seedDivision(auth);
    await createEntrants(
      auth,
      divisionId,
      ["A", "B"].map((n, i) => ({ kind: "individual" as const, display_name: n, seed: i + 1, members: [] })),
    );
    const [stage] = await createStages(auth, divisionId, [league(1)]);
    await generateStageFixtures(auth, stage!.id);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${stage!.id}`;
    expect(n, "premise: fixtures exist, so the format is locked").toBeGreaterThan(0);
    const before = await stageIds(divisionId);
    await expect(replaceStages(auth, divisionId, [league(1, { points: withForfeit })])).rejects.toMatchObject({
      status: 409,
      code: "FORMAT_LOCKED",
    });
    expect(await stageIds(divisionId)).toEqual(before);
    // The positive pair: the same gated body on an UNLOCKED division of the same org still answers the gate's 402.
    const open = await seededGraph(auth);
    await expect(replaceStages(auth, open.divisionId, [league(1, { points: withForfeit })])).rejects.toMatchObject({ status: 402 });
  });
});

/** Backends waiting on a lock `pid` holds (the departed-seat-stage-lock.test.ts witness). */
async function waitersOn(pid: number): Promise<number[]> {
  const rows = await sql<{ pid: number }[]>`select pid from pg_locks where not granted and ${pid} = any(pg_blocking_pids(pid))`;
  return [...new Set(rows.map((r) => r.pid))];
}

/** A bounded poll on database state — it proves a wait, it never stands in for one. */
async function until(what: string, done: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!HAS_DB)("fix round 3 N1: the FORMAT_LOCKED check UNDER the division lock is the guard, not the pre-read", () => {
  it("a fixture committed while Apply waits on the division lock is read under it: 409 FORMAT_LOCKED, the stages and the fixture intact", async () => {
    const auth = await seedOrg("pro");
    const { divisionId, before } = await seededGraph(auth);
    let apply!: Promise<unknown>;
    let settled = false;
    let fixtureId = "";
    await sql.begin(async (holder) => {
      // The exact key replaceStages takes (and patchDivision, and the generators): hashtext('division:' || id).
      await holder`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
      const [held] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      apply = replaceStages(auth, divisionId, [league(1)]);
      apply.then(
        () => (settled = true),
        () => (settled = true),
      );
      // Its pre-read finds no fixture (none exists yet) and lets it through to the gates; it then parks on this lock.
      await until("Apply parks behind the held division lock", async () => (await waitersOn(held!.pid)).length === 1);
      expect(settled, "Apply is blocked on the lock, not finished").toBe(false);
      // A fixture lands while Apply waits, as a generator holding the same lock writes one.
      const [f] = await holder<{ id: string }[]>`
        insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status)
        values (${before[0]!}, ${divisionId}, ${auth.orgId}, 1, 0, 'race', 'scheduled') returning id`;
      fixtureId = f!.id;
    }); // commits: Apply takes the lock and must read the fixture that exists now
    await expect(apply).rejects.toMatchObject({ status: 409, code: "FORMAT_LOCKED" });
    expect(await stageIds(divisionId), "the stage graph stands").toEqual(before);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixtures where id = ${fixtureId}`;
    expect(n, "the fixture the delete would have cascaded away is still there").toBe(1);
  });
});

// Batch 4 review I1. `createStages` read the division's variant and config on its own and wrote the stage's preset from
// that read, without the division lock `patchDivision` takes to change the variant and re-seed the stages that stand. A
// create that read `t20` just before the change committed stored `superOver: true` on a knockout that now ran under
// `test` (a rules fragment the stage's own save refuses: stageRulesProblem), and slipped past the checks the division
// save asks of the stages that stand. The lock is taken first thing in `insertStageBatch`, and the division is read
// after it. Expected values are the engine's own `stageDefaultsFor`, never a typed rules object.
describe.skipIf(!HAS_DB)("batch 4 I1: createStages reads the division UNDER the division lock", () => {
  const cricket = builtinModules.find((m) => m.key === "cricket") as unknown as AnySportModule;

  it("a variant change committed while the create waits on the lock is the variant its knockout is seeded from (t20 -> test)", async () => {
    const t20 = stageDefaultsFor(cricket, "knockout", "t20");
    const test = stageDefaultsFor(cricket, "knockout", "test");
    // The premise: the two variants disagree, so a stale read is visible in the stored stage.
    expect(Object.keys(t20).length, "premise: a t20 knockout declares a super over").toBeGreaterThan(0);
    expect(test, "premise: a test match declares none").toEqual({});

    const auth = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Cl Cup " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const division = await createDivision(auth, comp.id, {
      name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: "cricket", variant_key: "t20", config: {},
    });
    expect(await stageIds(division.id), "premise: no stage yet").toEqual([]);

    let create!: Promise<Awaited<ReturnType<typeof createStages>>>;
    let settled = false;
    await sql.begin(async (holder) => {
      // The exact key patchDivision takes: hashtext('division:' || id).
      await holder`select pg_advisory_xact_lock(hashtext(${"division:" + division.id}))`;
      const [held] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      create = createStages(auth, division.id, { seq: 1, kind: "knockout", name: "Final", config: {}, progression: null });
      create.then(
        () => (settled = true),
        () => (settled = true),
      );
      // Parked, or finished without waiting: the second is the defect, and it is reported as one rather than as a timeout.
      await until("createStages parks behind the held division lock (or finishes without waiting for it)", async () =>
        settled || (await waitersOn(held!.pid)).length === 1);
      // The variant change commits while the create is (or should be) waiting: what patchDivision's save leaves behind.
      await holder`update divisions set variant_key = 'test', config = ${holder.json(cricket.variants.test as never)} where id = ${division.id}`;
    });
    const [stage] = await create;
    const rules = (await sql<{ r: unknown }[]>`select config -> 'rules' as r from stages where id = ${stage!.id}`)[0]!.r;
    expect(rules, "the knockout is seeded from the variant that stands at commit (test), not the one read before the lock").toBeNull();
    expect(settled, "the create ran to completion after the lock was released").toBe(true);
  });
});

// Batch 4 re-review N1. ONE lock order everywhere: the division advisory lock FIRST, then any row lock on `divisions`.
// `insertStageBatch` takes the advisory lock and then reopens a completed division (an `update divisions` row lock);
// `patchDivision` used to read the row `for no key update` (a body naming youth / player_name_display / age_max /
// show_seeds) and only THEN take the advisory lock for a format field, so on a completed division the two held one
// lock each and wanted the other's: Postgres broke it with 40P01 after ~1 s. Interleaving, with no sleeps: a holder takes
// the advisory lock, the stage writer queues on it first, the patch queues second, and the holder commits. The writer is
// woken first and wants the row; under the old order the patch already holds it.
describe.skipIf(!HAS_DB)("batch 4 N1: patchDivision and the stage writers take the division locks in ONE order (advisory, then row)", () => {
  type Case = { name: string; seedStage: boolean; write: (auth: AuthCtx, divisionId: string) => Promise<unknown> };
  const cases: Case[] = [
    { name: "createStages", seedStage: false, write: (auth, id) => createStages(auth, id, [league(1)]) },
    { name: "replaceStages", seedStage: true, write: (auth, id) => replaceStages(auth, id, [league(1)]) },
  ];
  let checked = 0;

  it.each(cases)("$name on a COMPLETED division, racing a patch that names a masking field and a format field: both finish, no 40P01", async (c) => {
    const auth = await seedOrg("pro");
    const { divisionId } = await seedDivision(auth);
    if (c.seedStage) await createStages(auth, divisionId, [league(1)]);
    const stagesBefore = await stageIds(divisionId);
    expect(stagesBefore.length, "premise: the stage graph the writer finds").toBe(c.seedStage ? 1 : 0);
    // 'completed' with no fixtures: replaceStages is not FORMAT_LOCKED, and the writer reaches the reopen.
    await sql`update divisions set status = 'completed' where id = ${divisionId}`;
    const read = async () =>
      (await sql<{ status: string; player_name_display: string | null; tiebreakers: string[] | null }[]>`
        select status, player_name_display, tiebreakers from divisions where id = ${divisionId}`)[0]!;
    const start = await read();
    expect(start.status, "premise: a completed division").toBe("completed");
    expect(start.player_name_display, "premise: the masking field the patch changes").not.toBe("first_initial");
    expect(start.tiebreakers, "premise: the format field the patch changes").toBeNull();

    let writer!: Promise<unknown>;
    let patch!: Promise<unknown>;
    await sql.begin(async (holder) => {
      await holder`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
      const [held] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      writer = c.write(auth, divisionId);
      writer.catch(() => undefined); // the verdict is read below; a rejection must not escape as an unhandled one first
      await until("the stage writer queues on the held division lock", async () => (await waitersOn(held!.pid)).length === 1);
      patch = patchDivision(auth, divisionId, { player_name_display: "first_initial", tiebreakers: ["head_to_head"] as never });
      patch.catch(() => undefined);
      await until("the patch queues behind it", async () => (await waitersOn(held!.pid)).length === 2);
    }); // commits: the writer is woken first and wants the divisions row

    const verdict = (r: PromiseSettledResult<unknown>) =>
      r.status === "fulfilled" ? "fulfilled" : String((r.reason as { code?: string; message?: string }).code ?? r.reason);
    const settled = await Promise.allSettled([writer, patch]);
    expect(settled.map(verdict), "[stage writer, patch]: a deadlock would be 40P01 for one of them").toEqual(["fulfilled", "fulfilled"]);

    const end = await read();
    expect(end.status, "the stage write reopened the division").toBe("active");
    expect(end.player_name_display, "the patch's masking write landed").toBe("first_initial");
    expect(end.tiebreakers, "the patch's format write landed").toEqual(["head_to_head"]);
    const stagesAfter = await stageIds(divisionId);
    expect(stagesAfter.length, "one stage stands").toBe(1);
    if (c.seedStage) expect(stagesAfter, "replaceStages replaced the graph").not.toEqual(stagesBefore);
    checked += 1;
  });

  it("anti-vacuity: both stage writers were driven through the race", () => {
    expect(checked, "cases checked").toBe(cases.length);
  });
});
