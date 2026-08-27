// F2 (P7 follow-up, 2026-08-14) — pins the unreachability of a hazard P6
// recorded as an open follow-up: "because generateStageFixtures only
// inserts, a fixture orphaned by a rules change stays live. It can still
// take a scheduled time and a result indefinitely, silently polluting
// standings and exports." That state was investigated and found NOT
// reachable — two properties compose to make it impossible. This file pins
// both, so neither can be weakened or deleted silently later without a red
// test (see .superpowers/sdd/2026-08-14-p7-multi-stage-templates-plan/
// f2-brief.md for the full analysis; no production code changes here).
//
// 1. replaceStages (usecases/stages.ts:260-285) is the ONLY writer that
//    mutates kind/seeding/structural config on an existing stage row, and it
//    refuses with 409 FORMAT_LOCKED while ANY fixture exists in the
//    division, under an advisory xact lock taken in the same transaction —
//    so it cannot be raced. Every other rules-edit route is
//    delete-and-recreate.
// 2. fixtures.stage_id is `on delete cascade`
//    (db/migration/v2-engine/tables/V214__fixtures.sql:6) — the
//    delete-and-recreate routes above take a stage's fixtures WITH it
//    rather than leaving them behind to orphan.
//
// Real Postgres required; skipped without DATABASE_URL (same convention as
// the sibling *-precondition test files in this directory).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, deleteStage, generateStageFixtures, replaceStages } from "../stages";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedOrg(): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Orphan " + suffix}, ${"orphan-" + suffix})
    returning id`;
  await setOrgPlan(orgId);
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  return { auth: { orgId, via: "session", userId: null, role: "owner", keyId: null } };
}

/** A single-stage league division with generated (unplayed, 'scheduled') fixtures. */
async function seedDivisionWithFixtures(auth: AuthCtx): Promise<{ divisionId: string; stageId: string }> {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Orphan Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(auth, division.id, [
    { kind: "individual", display_name: "A", seed: 1, members: [] },
    { kind: "individual", display_name: "B", seed: 2, members: [] },
  ]);
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "L",
    config: {},
    progression: null,
  });
  await generateStageFixtures(auth, stage!.id);
  return { divisionId: division.id, stageId: stage!.id };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("F2 — the orphaned-fixture hazard P6 recorded is unreachable", () => {
  it("property 1: replaceStages refuses 409 FORMAT_LOCKED once a fixture exists in the division", async () => {
    const { auth } = await seedOrg();
    const { divisionId } = await seedDivisionWithFixtures(auth);

    try {
      await replaceStages(auth, divisionId, [
        { seq: 1, kind: "league", name: "L2", config: {}, progression: null },
      ]);
      expect.unreachable("expected replaceStages to throw FORMAT_LOCKED");
    } catch (err) {
      expect(err).toMatchObject({ status: 409, code: "FORMAT_LOCKED" });
    }
  });

  it("property 2: deleting a stage cascades its fixtures away instead of orphaning them (ON DELETE CASCADE)", async () => {
    const { auth } = await seedOrg();
    const { stageId } = await seedDivisionWithFixtures(auth);

    const [{ count: before }] = await sql<{ count: string }[]>`
      select count(*)::text from fixtures where stage_id = ${stageId}`;
    expect(Number(before)).toBeGreaterThan(0);

    await deleteStage(auth, stageId);

    const [{ count: after }] = await sql<{ count: string }[]>`
      select count(*)::text from fixtures where stage_id = ${stageId}`;
    expect(Number(after)).toBe(0);
  });
});
