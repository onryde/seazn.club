// S8/#417 — structured logging for recomputePlayerStats's entrant-fallback
// wiring (owner standing rule: all new code logs). In the STYLE of
// schedule-ai-logging.test.ts (vi.spyOn(log, ...), assert on the call's
// structured fields) but DB-backed, unlike that file: the point here is that
// the diagnostic NUMBERS in the log line are real fold output, not an echo
// of a stubbed return value — "assert on real emitted fields, not a mock's
// shape" (the brief's own words), which a mocked aggregatePlayerStats would
// defeat.
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import { sql, withTenant } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { log } from "@/server/logger";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createPerson } from "../persons";
import { createStages, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { recomputePlayerStats } from "../player-stats";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

const badminton = builtinModules.find((m) => m.key === "badminton")!;

async function seedOrg(): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`stats-log-${suffix}@test.local`}, 'Log', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"StatsLog " + suffix}, ${"stats-log-" + suffix}, ${userId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  await setOrgPlan(orgId);
  await invalidateOrgEntitlements(orgId);
  return { auth: { orgId, via: "session", userId, role: "owner", keyId: null } };
}

async function seedBadmintonSingles(
  auth: AuthCtx,
): Promise<{ divisionId: string; entrantA: string; entrantB: string; fixtureId: string }> {
  const mod: AnySportModule = badminton;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values (${mod.key}, ${mod.key}, ${mod.version}, ${sql.json(mod.positions as never)})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values (${mod.key}, 'default', 'Default', ${sql.json({})}, true)
    on conflict do nothing`;
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Log Cup",
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: mod.key,
    variant_key: "default",
    config: {},
    eligibility: [],
  });
  const alex = await createPerson(auth, {
    full_name: "Alex Log",
    consent: { public_name: true },
    dob: null,
    gender: null,
    external_ref: null,
  });
  const bo = await createPerson(auth, {
    full_name: "Bo Log",
    consent: { public_name: true },
    dob: null,
    gender: null,
    external_ref: null,
  });
  const entrants = await createEntrants(auth, division.id, [
    {
      kind: "individual",
      display_name: "Alex",
      seed: 1,
      members: [{ person_id: alex.id, squad_number: null, is_captain: false, roles: [], default_position_key: null }],
    },
    {
      kind: "individual",
      display_name: "Bo",
      seed: 2,
      members: [{ person_id: bo.id, squad_number: null, is_captain: false, roles: [], default_position_key: null }],
    },
  ]);
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  await startDivision(auth, division.id);
  return {
    divisionId: division.id,
    entrantA: entrants[0]!.id,
    entrantB: entrants[1]!.id,
    fixtureId: fixtures[0]!.id,
  };
}

describe.skipIf(!HAS_DB)("S8/#417 recomputePlayerStats structured logging", () => {
  it("logs real fold-derived diagnostics on every recompute, and does not warn when the ledger agrees with ctx.entrants", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await seedBadmintonSingles(auth);

    await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    // Two wonBy-only rallies. Per rally, badminton.rally matches 3 metrics
    // (points/serves/points_won); with no scorer/server: "points" and
    // "serves" resolve nobody (unattributed +1 each, no fromEntrant declared)
    // and "points_won" (fromEntrant:true) falls to wonBy and resolves the
    // individual entrant's one member (fromEntrantFallback +1). Two rallies
    // ⇒ fromEntrantFallback:2, fromPersonField:0, unattributed:4 — numbers a
    // reader can verify by hand against packages/engine/src/sports/setbased/
    // badminton.ts's own metric declarations, not just trust this comment.
    const [fixture] = await sql<{ home_entrant_id: string }[]>`
      select home_entrant_id from fixtures where id = ${fixtureId}`;
    for (let seq = 1; seq <= 2; seq += 1) {
      await scoreEvent(auth, fixtureId, {
        expected_seq: seq,
        type: "badminton.rally",
        payload: { wonBy: fixture!.home_entrant_id },
      });
    }

    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => undefined as never);
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined as never);
    await withTenant(auth.orgId, (tx) => recomputePlayerStats(tx, divisionId));

    const call = infoSpy.mock.calls.find(
      (c) => typeof c[1] === "string" && c[1].includes("recomputePlayerStats"),
    );
    expect(call).toBeDefined();
    const fields = call![0] as Record<string, unknown>;
    expect(fields.divisionId).toBe(divisionId);
    expect(fields.sportKey).toBe("badminton");
    expect(fields.fixtures).toBe(1);
    expect(fields.fromPersonField).toBe(0);
    expect(fields.fromEntrantFallback).toBe(2);
    expect(fields.unattributed).toBe(4);
    expect(fields.unknownEntrants).toEqual([]);
    expect(fields.teamEntrantsSkipped).toEqual([]);

    expect(warnSpy).not.toHaveBeenCalled();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("warns when ctx.entrants disagrees with the ledger (an entrantField id the loader never returned)", async () => {
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await seedBadmintonSingles(auth);
    // Bypass scoreEvent's write-path validation on purpose: a rally naming an
    // entrant id THIS fixture never declared is real-world ledger/roster
    // drift (a historical event, a re-keyed entrant), not a shape the write
    // path could ever accept — which is exactly why this diagnostic exists
    // instead of trusting the write path to make it impossible.
    const ghostEntrantId = randomUUID();
    await sql`
      insert into score_events (fixture_id, org_id, seq, type, payload)
      values (${fixtureId}, ${auth.orgId}, 0, 'badminton.rally', ${sql.json({ wonBy: ghostEntrantId })})`;

    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined as never);
    await withTenant(auth.orgId, (tx) => recomputePlayerStats(tx, divisionId));

    const call = warnSpy.mock.calls.find(
      (c) => typeof c[1] === "string" && c[1].includes("disagreement"),
    );
    expect(call).toBeDefined();
    const fields = call![0] as { divisionId: string; unknownEntrants: string[] };
    expect(fields.divisionId).toBe(divisionId);
    expect(fields.unknownEntrants).toContain(ghostEntrantId);
    warnSpy.mockRestore();
  });

  it("warns when a division's fixtures have events but no entrant roster data resolves at all", async () => {
    const { auth } = await seedOrg();
    const { divisionId, entrantA, entrantB, fixtureId } = await seedBadmintonSingles(auth);
    await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    const [fixture] = await sql<{ home_entrant_id: string }[]>`
      select home_entrant_id from fixtures where id = ${fixtureId}`;
    await scoreEvent(auth, fixtureId, {
      expected_seq: 1,
      type: "badminton.rally",
      payload: { wonBy: fixture!.home_entrant_id },
    });

    // Construct the degradation directly rather than mocking the loader:
    // deleting both entrants leaves the ledger's events in place (score_events
    // has no FK to entrants) while `fixtures.home/away_entrant_id` — declared
    // `on delete set null` — nulls itself out, and
    // loadEntrantMembersForDivision resolves an empty map. Real DB state, not
    // a stubbed dependency.
    await sql`delete from entrant_members where entrant_id in (${entrantA}, ${entrantB})`;
    await sql`delete from entrants where id in (${entrantA}, ${entrantB})`;

    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined as never);
    await withTenant(auth.orgId, (tx) => recomputePlayerStats(tx, divisionId));

    const call = warnSpy.mock.calls.find(
      (c) => typeof c[1] === "string" && c[1].includes("no entrant roster data"),
    );
    expect(call).toBeDefined();
    warnSpy.mockRestore();
  });
});
