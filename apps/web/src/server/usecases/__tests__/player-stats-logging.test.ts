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
const volleyball = builtinModules.find((m) => m.key === "volleyball")!;

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

// S8/#417 W6 review round 2, fix 1 — a team-kind entrant division (volleyball
// is the natural case: its default variant's entrantModel is team-only).
// Mirrors seedBadmintonSingles's shape exactly, swapped to a sport whose
// entrants are kind "team" rather than "individual".
async function seedVolleyballTeams(
  auth: AuthCtx,
): Promise<{ divisionId: string; fixtureId: string }> {
  const mod: AnySportModule = volleyball;
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
  // Real, non-empty rosters — a person genuinely on the entrant's squad, so
  // the test is falsifiable: were the kind guard not enforced, this would
  // show up as a credited row instead of a skipped entrant.
  const home1 = await createPerson(auth, {
    full_name: "Home Log",
    consent: { public_name: true },
    dob: null,
    gender: null,
    external_ref: null,
  });
  const away1 = await createPerson(auth, {
    full_name: "Away Log",
    consent: { public_name: true },
    dob: null,
    gender: null,
    external_ref: null,
  });
  await createEntrants(auth, division.id, [
    {
      kind: "team",
      display_name: "Reds",
      seed: 1,
      members: [{ person_id: home1.id, squad_number: null, is_captain: false, roles: [], default_position_key: null }],
    },
    {
      kind: "team",
      display_name: "Blues",
      seed: 2,
      members: [{ person_id: away1.id, squad_number: null, is_captain: false, roles: [], default_position_key: null }],
    },
  ]);
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  await startDivision(auth, division.id);
  return { divisionId: division.id, fixtureId: fixtures[0]!.id };
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

  it("does NOT warn on a team-kind entrant's designed skip (volleyball) — teamEntrantsSkipped is a routine count, not a ctx/ledger disagreement", async () => {
    // S8/#417 W6 review round 2, fix 1: before this fix, the warn condition
    // was `unknownEntrants.size > 0 || teamEntrantsSkipped.size > 0`, so
    // EVERY healthy volleyball (or football/hockey/cricket) recompute
    // warned — teamEntrantsSkipped is the engine's DESIGNED skip for a KNOWN
    // team-kind entrant (packages/engine/src/stats/stats.ts's mandatory kind
    // guard; DOMAIN.volleyball.md:34 calls this "the designed state for a
    // team entrant"), not a disagreement between ctx.entrants and the
    // ledger. A warning that fires on the happy path trains an operator to
    // ignore the channel, burying the genuine unknownEntrants signal.
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await seedVolleyballTeams(auth);

    await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    const [fixture] = await sql<{ home_entrant_id: string }[]>`
      select home_entrant_id from fixtures where id = ${fixtureId}`;
    // wonBy only — no scorer/server — so the kernel's points_won metric
    // (entrantField: "wonBy", fromEntrant: true) falls to the entrant
    // fallback, resolves the home entrant, finds it KNOWN with kind "team",
    // and the mandatory kind guard skips it: exactly what populates
    // teamEntrantsSkipped on a perfectly ordinary, healthy recompute.
    await scoreEvent(auth, fixtureId, {
      expected_seq: 1,
      type: "volleyball.rally",
      payload: { wonBy: fixture!.home_entrant_id },
    });

    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => undefined as never);
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined as never);
    try {
      await withTenant(auth.orgId, (tx) => recomputePlayerStats(tx, divisionId));

      const call = infoSpy.mock.calls.find(
        (c) => typeof c[1] === "string" && c[1].includes("recomputePlayerStats"),
      );
      expect(call).toBeDefined();
      const fields = call![0] as Record<string, unknown>;
      // The designed skip still surfaces as an ordinary count in the info
      // line — it must not also duplicate into a warn.
      expect((fields.teamEntrantsSkipped as string[]).length).toBeGreaterThan(0);

      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      // try/finally (unlike this file's other tests) because this assertion
      // is EXPECTED to fail red before the fix — an uncaught throw here
      // would leave log.info/log.warn permanently mocked for every test
      // that runs after this one in the same file.
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("logs the folded path's own diagnostics, not just the metric loop's", async () => {
    // The `folded` path carries production stats for 8 of the 11 modules —
    // badminton's matches/sets_won/sets_lost among them — so a recompute that
    // reported only metric-loop counters would be blind to most of what it
    // just computed. Without the folded fields in the payload this test fails
    // on the first assertion: `foldedFixtures` is simply absent.
    const { auth } = await seedOrg();
    const { divisionId, fixtureId } = await seedBadmintonSingles(auth);
    await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    const [fixture] = await sql<{ home_entrant_id: string }[]>`
      select home_entrant_id from fixtures where id = ${fixtureId}`;
    await scoreEvent(auth, fixtureId, {
      expected_seq: 1,
      type: "badminton.rally",
      payload: { wonBy: fixture!.home_entrant_id },
    });

    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => undefined as never);
    await withTenant(auth.orgId, (tx) => recomputePlayerStats(tx, divisionId));

    const call = infoSpy.mock.calls.find(
      (c) => typeof c[1] === "string" && c[1].includes("recomputePlayerStats"),
    );
    const fields = call![0] as Record<string, unknown>;
    // One fixture, and its folded model RAN — the distinction that matters:
    // "ran and produced nothing" and "never ran at all" are the same empty
    // stat table from the outside, and only these counters tell them apart.
    expect(fields.foldedFixtures).toBe(1);
    expect(fields.foldedEmptyFixtures).toBe(0);
    expect(typeof fields.foldedRows).toBe("number");
    expect(fields.foldedRows as number).toBeGreaterThan(0);
    expect(fields.foldedCredits as number).toBeGreaterThan(0);
    infoSpy.mockRestore();
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
