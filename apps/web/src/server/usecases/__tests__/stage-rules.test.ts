// Per-stage match rules, Task 4 (design 2026-09-17 §T3, rulings D1/D2/D2a) —
// `PUT /stages/:id/rules`. This suite is also what proves Task 1's extraction
// actually reaches the SERVER: `configKeysFor` is imported here through the
// real usecase, in the server graph. A unit test of the derivation passes
// whether or not the extraction worked, because vitest has no RSC boundary.
//
// Real Postgres required; skipped without DATABASE_URL.
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { buildRuleOverride } from "@/lib/match-rules";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
import { resolveModule } from "@/server/engine-db";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { putStageRules } from "../stage-rules";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Sr " + suffix}, ${"sr-" + suffix})
    returning id`;
  await setOrgPlan(orgId);
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
