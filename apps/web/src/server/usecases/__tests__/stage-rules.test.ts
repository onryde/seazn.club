// Per-stage match rules, Task 4 (design 2026-09-17 §T3, rulings D1/D2/D2a) —
// `PUT /stages/:id/rules`.
//
// This suite does NOT prove Task 1's extraction reaches the server graph, and
// a header here used to claim it did (corrected 2026-09-18). Nothing in vitest
// is an RSC boundary: `configKeysFor` would resolve to real values from this
// file whether or not it had been moved out of the `"use client"` module, so
// the claim contradicted its own next sentence. What actually settles the
// extraction is the production import in `usecases/stage-rules.ts` plus a
// build; this suite settles the endpoint's BEHAVIOUR, which is plenty.
//
// Real Postgres required; skipped without DATABASE_URL.
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { getLimit, invalidateOrgEntitlements } from "@/lib/entitlements";
import { buildRuleOverride } from "@/lib/match-rules";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
import { resolveModule } from "@/server/engine-db";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { formatLockedStageIds, putStageRules } from "../stage-rules";
import { frozenCompetitionIds } from "../entitlement-freeze";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(plan: "pro" | "community" = "pro"): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Sr " + suffix}, ${"sr-" + suffix})
    returning id`;
  await setOrgPlan(orgId, plan);
  await invalidateOrgEntitlements(orgId);
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

/** `entrantCount: 0` for the football divisions — a team sport refuses
 *  `individual` entrants, and neither football test needs a fixture. */
async function seedDivision(
  auth: AuthCtx,
  sportKey: string,
  variantKey: string,
  entrantCount = 2,
): Promise<{ divisionId: string; entrants: string[] }> {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Sr Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: sportKey,
    variant_key: variantKey,
    config: {},
  });
  if (entrantCount === 0) return { divisionId: division.id, entrants: [] };
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: entrantCount }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  return { divisionId: division.id, entrants: entrants.map((e) => e.id) };
}

async function seedStage(auth: AuthCtx, divisionId: string, seq: number): Promise<string> {
  const [stage] = await createStages(auth, divisionId, {
    seq,
    kind: "league",
    name: "S" + seq,
    config: {},
    progression: null,
  });
  return stage!.id;
}

async function stageConfig(stageId: string): Promise<Record<string, unknown>> {
  const [row] = await sql<{ config: Record<string, unknown> }[]>`
    select config from stages where id = ${stageId}`;
  return row!.config;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("putStageRules (design §T3)", () => {
  it("stores the FRAGMENT, not a materialised config, and strips nulls on the way in", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "tennis", "tour");
    const stageId = await seedStage(auth, divisionId, 1);

    // `finalSet: null` means INHERIT. A null that reached the column would be
    // copied by the overlay's spread and BLANK the division's value.
    await putStageRules(auth, stageId, { rules: { bestOf: 3, finalSet: null } });

    // Exact equality, not a subset: storing `parsed.data` would write every
    // defaulted key here and pin the stage to the whole division format.
    expect((await stageConfig(stageId)).rules).toEqual({ bestOf: 3 });
  }, 30_000);

  it("accepts a tennis CONFIG key and rejects the FORM key whose build() writes it", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "tennis", "tour");
    const stageId = await seedStage(auth, divisionId, 1);

    // Derived from the rules table itself, never typed in: `setType` is the
    // FORM key and `set` is what its build() emits. A table change moves this
    // test with it. (It also has to be the COMPLETE four-field object — a
    // partial `set` fails the pinned module schema.)
    const fromSetType = buildRuleOverride("tennis", { setType: "tb6" });
    expect(Object.keys(fromSetType)).toEqual(["set"]);

    await expect(putStageRules(auth, stageId, { rules: fromSetType })).resolves.toBeTruthy();
    await expect(
      putStageRules(auth, stageId, { rules: { setType: "tb6" } }),
    ).rejects.toMatchObject({ status: 400, code: "UNKNOWN_RULE_KEY" });
  }, 30_000);

  it("refuses points through the ALLOWLIST, not by failing the merged parse", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "tennis", "tour");
    const stageId = await seedStage(auth, divisionId, 1);

    await expect(
      putStageRules(auth, stageId, { rules: { points: { win: 5, loss: 0 } } }),
    ).rejects.toMatchObject({ status: 400, code: "UNKNOWN_RULE_KEY" });

    // The positive half, and the reason the status code matters: tennis's own
    // configSchema ACCEPTS a top-level `points`, so the merged-config parse
    // would have let this through with a 200. The allowlist is the only thing
    // standing between a stage and the standings.custom_points entitlement —
    // if this assertion ever fails, the 400 above has become incidental.
    const [div] = await sql<
      { sport_key: string; module_version: string; config: Record<string, unknown> }[]
    >`select sport_key, module_version, config from divisions where id = ${divisionId}`;
    const module_ = resolveModule(div!.sport_key, div!.module_version);
    const merged = module_.configSchema.safeParse({
      ...div!.config,
      points: { win: 5, loss: 0 },
    });
    expect(merged.success).toBe(true);
  }, 30_000);

  it("refuses a sport outside the sets-based four", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "football", "11-a-side", 0);
    const stageId = await seedStage(auth, divisionId, 1);
    await expect(putStageRules(auth, stageId, { rules: { bestOf: 3 } })).rejects.toMatchObject({
      status: 400,
      code: "SPORT_NOT_SUPPORTED",
    });
  }, 30_000);

  it("422s when the MERGED config fails the module schema", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "tennis", "tour");
    const stageId = await seedStage(auth, divisionId, 1);
    // `bestOf` is an allowed key, so this gets past the allowlist and dies at
    // the parse — the other side of the previous test's distinction.
    await expect(putStageRules(auth, stageId, { rules: { bestOf: 0 } })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    expect((await stageConfig(stageId)).rules).toBeUndefined();
  }, 30_000);

  it("clears back to the division when rules is null", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "tennis", "tour");
    const stageId = await seedStage(auth, divisionId, 1);
    await putStageRules(auth, stageId, { rules: { bestOf: 3 } });
    expect((await stageConfig(stageId)).rules).toEqual({ bestOf: 3 });

    await putStageRules(auth, stageId, { rules: null });
    // The KEY must be gone, not present as null: the overlay treats absence as
    // inherit and would copy a null over the division's value.
    expect("rules" in (await stageConfig(stageId))).toBe(false);
  }, 30_000);

  it("locks once a fixture in THAT stage has an event, and leaves a sibling stage editable", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "tennis", "tour");
    const stageId = await seedStage(auth, divisionId, 1);
    const siblingId = await seedStage(auth, divisionId, 2);
    await generateStageFixtures(auth, stageId);
    const [fixture] = await sql<{ id: string }[]>`
      select id from fixtures where stage_id = ${stageId} limit 1`;

    await expect(putStageRules(auth, stageId, { rules: { bestOf: 3 } })).resolves.toBeTruthy();

    await appendEvent(auth.orgId, fixture!.id, 0, { type: "core.start", payload: {} });

    await expect(putStageRules(auth, stageId, { rules: { bestOf: 5 } })).rejects.toMatchObject({
      status: 409,
      code: "STAGE_FORMAT_LOCKED",
    });
    // Per STAGE, not per division — the sibling has not started.
    await expect(putStageRules(auth, siblingId, { rules: { bestOf: 5 } })).resolves.toBeTruthy();
  }, 30_000);

  it("stays locked when the start is voided and the fixture returns to scheduled", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "tennis", "tour");
    const stageId = await seedStage(auth, divisionId, 1);
    await generateStageFixtures(auth, stageId);
    const [fixture] = await sql<{ id: string }[]>`
      select id from fixtures where stage_id = ${stageId} limit 1`;

    const start = await appendEvent(auth.orgId, fixture!.id, 0, {
      type: "core.start",
      payload: {},
    });
    await appendEvent(auth.orgId, fixture!.id, 1, {
      type: "core.void",
      payload: {},
      voids: start.event.id,
    });

    // The premise this test exists for, asserted rather than assumed:
    // `fixtures.status` is NON-MONOTONIC. It really has gone backwards.
    const [after] = await sql<{ status: string }[]>`
      select status from fixtures where id = ${fixture!.id}`;
    expect(after!.status).toBe("scheduled");

    // …and the stage is STILL locked, because the ledger and the frozen
    // snapshot remain. A `status = 'in_play'` predicate would re-open a stage
    // that has already been played.
    await expect(putStageRules(auth, stageId, { rules: { bestOf: 5 } })).rejects.toMatchObject({
      status: 409,
      code: "STAGE_FORMAT_LOCKED",
    });
  }, 30_000);

  it("rejects an unknown key even when its VALUE is null", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "tennis", "tour");
    const stageId = await seedStage(auth, divisionId, 1);

    // The null strip and the allowlist are order-dependent, and the wrong order
    // is invisible: stripping first leaves an empty fragment that never meets
    // the allowlist, so a misspelled rule answers 200 and saves nothing. The
    // organiser is told it worked. 400 is the only honest answer.
    await expect(
      putStageRules(auth, stageId, { rules: { notAKey: null } }),
    ).rejects.toMatchObject({ status: 400, code: "UNKNOWN_RULE_KEY" });
    expect((await stageConfig(stageId)).rules).toBeUndefined();
  }, 30_000);

  it("treats an empty fragment as a CLEAR, not a stored empty object", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "tennis", "tour");
    const stageId = await seedStage(auth, divisionId, 1);
    await putStageRules(auth, stageId, { rules: { bestOf: 3 } });
    expect((await stageConfig(stageId)).rules).toEqual({ bestOf: 3 });

    // `{}` and `{bestOf: null}` both mean "inherit the division's format", so
    // both must land on `- 'rules'`. A stored `rules: {}` would override
    // nothing while reading as an override to every `"rules" in config` check.
    await putStageRules(auth, stageId, { rules: {} });
    expect("rules" in (await stageConfig(stageId))).toBe(false);

    await putStageRules(auth, stageId, { rules: { bestOf: 3 } });
    await putStageRules(auth, stageId, { rules: { bestOf: null } });
    expect("rules" in (await stageConfig(stageId))).toBe(false);
  }, 30_000);

  it("402s when the competition is frozen by the billing quota", async () => {
    // The freeze guard had no test at all (review 2026-09-18). Driven through
    // the real selector rather than a hand-set flag.
    //
    // A billing freeze is what a DOWNGRADE does to data already created — it
    // is not reachable by creating past the cap, because `createCompetition`
    // 402s at the quota first (found the hard way: the obvious version of this
    // test failed inside its own setup). So: build over the small plan's cap
    // while on `pro`, then drop to `community` and let `selectFrozen` retire
    // the least recently active ones. The cap is read from the plan rather than
    // typed in, so a repricing moves this test instead of breaking it.
    const auth = await seedOrg("pro");
    const { divisionId } = await seedDivision(auth, "tennis", "tour");
    const stageId = await seedStage(auth, divisionId, 1);
    const [{ competition_id: competitionId }] = await sql<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${divisionId}`;

    // It is editable BEFORE the freeze — otherwise a 402 below proves nothing.
    await expect(putStageRules(auth, stageId, { rules: { bestOf: 3 } })).resolves.toBeTruthy();

    await setOrgPlan(auth.orgId, "community");
    await invalidateOrgEntitlements(auth.orgId);
    const cap = await getLimit(auth.orgId, "competitions.max_active");
    expect(cap).not.toBeNull(); // an unlimited community plan would make this vacuous

    await setOrgPlan(auth.orgId, "pro");
    await invalidateOrgEntitlements(auth.orgId);
    for (let i = 0; i < cap!; i++)
      await createCompetition(auth, {
        ends_on: "2030-12-31",
        name: "Filler " + randomUUID().slice(0, 6),
        visibility: "private",
        branding: {},
      });

    await setOrgPlan(auth.orgId, "community");
    await invalidateOrgEntitlements(auth.orgId);
    // The oldest competition — the one holding our stage — is the one retired.
    expect((await frozenCompetitionIds(auth.orgId)).has(competitionId)).toBe(true);

    await expect(putStageRules(auth, stageId, { rules: { bestOf: 5 } })).rejects.toMatchObject({
      status: 402,
    });
    // …and the pre-freeze override is untouched.
    expect((await stageConfig(stageId)).rules).toEqual({ bestOf: 3 });
  }, 60_000);

  it("serialises on the division advisory lock its sibling writers take", async () => {
    // A lock has no single-threaded symptom, so nothing above could kill it and
    // it would have shipped as decoration. The race it closes: `append-event`
    // resolves cfg and then freezes the snapshot under a FIXTURE-scoped lock,
    // which does not serialise against this endpoint at all — so without a
    // division lock a scorer can read the old cfg, this PUT commits 200, and
    // the fixture freezes the OLD format while the stage is locked forever.
    // Proven the way `stage-config-atomic-write.test.ts` proves its own race:
    // hold the lock from a second connection and show the usecase PARKS.
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "tennis", "tour");
    const stageId = await seedStage(auth, divisionId, 1);

    let release!: () => void;
    const mayRelease = new Promise<void>((r) => (release = r));
    let holding!: () => void;
    const holderHasLock = new Promise<void>((r) => (holding = r));

    const holder = sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
      holding();
      await mayRelease;
    });
    await holderHasLock;

    let settled = false;
    const call = putStageRules(auth, stageId, { rules: { bestOf: 3 } }).then((r) => {
      settled = true;
      return r;
    });

    // Wait for it to actually reach the lock, then confirm it is STUCK there.
    for (let i = 0; i < 200 && !settled; i++) {
      const [{ waiting }] = await sql<{ waiting: number }[]>`
        select count(*)::int as waiting from pg_locks
        where locktype = 'advisory' and not granted
          and objid = hashtext(${"division:" + divisionId})::bigint & 4294967295`;
      if (waiting > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    // The whole point: it has NOT committed while another writer holds the
    // division. Without the lock this line is where the test reds.
    expect(settled).toBe(false);

    release();
    await holder;
    await call;
    expect((await stageConfig(stageId)).rules).toEqual({ bestOf: 3 });
  }, 60_000);

  it("404s for a stage in another org", async () => {
    const owner = await seedOrg();
    const stranger = await seedOrg();
    const { divisionId } = await seedDivision(owner, "tennis", "tour");
    const stageId = await seedStage(owner, divisionId, 1);
    await expect(
      putStageRules(stranger, stageId, { rules: { bestOf: 3 } }),
    ).rejects.toMatchObject({ status: 404 });
  }, 30_000);

  it("refuses a rules key through createStages", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "football", "11-a-side", 0);

    // The shape SPORT_RULES.football genuinely emits — derived from the table,
    // not invented. createStages parses stage config through no configSchema
    // at all, and its paywall gate reads `s.config.points`, never
    // `s.config.rules.points`, so without this refusal a football division
    // could set custom shoot-out points straight past the entitlement.
    const smuggled = buildRuleOverride("football", { shootoutWin: "3", shootoutLoss: "1" });
    expect(smuggled).toEqual({ points: { shootoutWin: 3, shootoutLoss: 1 } });

    await expect(
      createStages(auth, divisionId, {
        seq: 1,
        kind: "league",
        name: "L",
        config: { rules: smuggled },
        progression: null,
      }),
    ).rejects.toMatchObject({ status: 400, code: "RULES_NOT_ACCEPTED_HERE" });
  }, 30_000);
});

// Task 7 — the READ half of the same lock. The fixtures panel decides whether
// to OFFER the format editor; `putStageRules` decides whether to REFUSE the
// write. They share ONE predicate (`lockedStageIdsAmong`) precisely because
// the failure mode of two copies is an organiser shown an Edit button that
// then 409s. These tests are the second half of that proof: breaking either
// half of the single predicate must red BOTH this describe and the
// `putStageRules` one above.
describe.skipIf(!HAS_DB)("formatLockedStageIds (design §T3, Task 7)", () => {
  it("reports nothing while no fixture in the division has started", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "tennis", "tour");
    const stageId = await seedStage(auth, divisionId, 1);
    await generateStageFixtures(auth, stageId);

    expect(await formatLockedStageIds(auth, divisionId)).toEqual([]);
  }, 30_000);

  it("reports the started stage and NOT its untouched sibling", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "tennis", "tour");
    const stageId = await seedStage(auth, divisionId, 1);
    const siblingId = await seedStage(auth, divisionId, 2);
    await generateStageFixtures(auth, stageId);
    const [fixture] = await sql<{ id: string }[]>`
      select id from fixtures where stage_id = ${stageId} limit 1`;

    await appendEvent(auth.orgId, fixture!.id, 0, { type: "core.start", payload: {} });

    const locked = await formatLockedStageIds(auth, divisionId);
    expect(locked).toEqual([stageId]);
    expect(locked).not.toContain(siblingId);
    // The two halves agree: what the reader reports locked, the writer refuses.
    await expect(putStageRules(auth, stageId, { rules: { bestOf: 5 } })).rejects.toMatchObject({
      status: 409,
      code: "STAGE_FORMAT_LOCKED",
    });
    await expect(putStageRules(auth, siblingId, { rules: { bestOf: 5 } })).resolves.toBeTruthy();
  }, 30_000);

  // THE test this prop exists for. `fixtures.status` is non-monotonic: voiding
  // a start moves it back to `scheduled`. A panel deriving its locked state
  // from status would re-open the editor here and the organiser's save would
  // come back 409 — the exact disagreement the shared predicate prevents.
  it("still reports the stage after the start is VOIDED and the fixture is scheduled again", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "tennis", "tour");
    const stageId = await seedStage(auth, divisionId, 1);
    await generateStageFixtures(auth, stageId);
    const [fixture] = await sql<{ id: string }[]>`
      select id from fixtures where stage_id = ${stageId} limit 1`;

    const start = await appendEvent(auth.orgId, fixture!.id, 0, {
      type: "core.start",
      payload: {},
    });
    await appendEvent(auth.orgId, fixture!.id, 1, {
      type: "core.void",
      payload: {},
      voids: start.event.id,
    });

    // The premise, asserted rather than assumed — status really went backwards.
    const [after] = await sql<{ status: string }[]>`
      select status from fixtures where id = ${fixture!.id}`;
    expect(after!.status).toBe("scheduled");
    // …and the reader still says LOCKED, agreeing with the writer.
    expect(await formatLockedStageIds(auth, divisionId)).toEqual([stageId]);
  }, 30_000);

  // WHY NEITHER HALF OF THE PREDICATE HAS ITS OWN KILLER, pinned as an
  // invariant rather than left for the next reader to re-derive.
  //
  // `append-event.ts:255` freezes the snapshot on the FIRST event whenever the
  // resolved cfg is non-null, and no production path ever clears one
  // (`admin-fixture-config.ts:184-194` only sets it when not already frozen).
  // So for the four sports that can reach this lock at all, "has events" and
  // "has a snapshot" arrive together and either half alone answers correctly —
  // a mutant deleting one SURVIVES. The `score_events` half is defence in
  // depth for the carve-out that comment names (a division whose config is a
  // JSON null), which is not constructible here: the engine cannot fold a
  // tennis fixture with a null cfg at all — it throws
  // `Cannot read properties of null (reading 'bestOf')` before any event lands.
  //
  // This test is what would red if that gate ever changed, which is the point
  // at which the two halves stop being redundant.
  it("freezes a snapshot on the same first event that writes the ledger", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "tennis", "tour");
    const stageId = await seedStage(auth, divisionId, 1);
    await generateStageFixtures(auth, stageId);
    const [fixture] = await sql<{ id: string }[]>`
      select id from fixtures where stage_id = ${stageId} limit 1`;

    await appendEvent(auth.orgId, fixture!.id, 0, { type: "core.start", payload: {} });

    const [row] = await sql<{ config_snapshot: unknown; events: number }[]>`
      select f.config_snapshot,
             (select count(*)::int from score_events e where e.fixture_id = f.id) as events
        from fixtures f where f.id = ${fixture!.id}`;
    expect(row!.events).toBeGreaterThan(0);
    expect(row!.config_snapshot).not.toBeNull();
  }, 30_000);

  it("is scoped to the division asked for, not the whole org", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "tennis", "tour");
    const other = await seedDivision(auth, "tennis", "tour");
    const stageId = await seedStage(auth, divisionId, 1);
    await generateStageFixtures(auth, stageId);
    const [fixture] = await sql<{ id: string }[]>`
      select id from fixtures where stage_id = ${stageId} limit 1`;
    await appendEvent(auth.orgId, fixture!.id, 0, { type: "core.start", payload: {} });

    expect(await formatLockedStageIds(auth, divisionId)).toEqual([stageId]);
    expect(await formatLockedStageIds(auth, other.divisionId)).toEqual([]);
  }, 30_000);
});
