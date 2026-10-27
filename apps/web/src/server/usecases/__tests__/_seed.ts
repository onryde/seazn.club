// Shared DB-backed seed helpers for officials-unify tests (Tasks 1/2/3/7).
// Copied verbatim from me-officiating.test.ts (do not modify that file).
import { randomUUID } from "node:crypto";
import { football } from "@seazn/engine/sports/football";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { createVenue, createCourt } from "../venues";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
export const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

export async function makeUser(name: string): Promise<{ id: string; email: string }> {
  const email = `${name}-${randomUUID().slice(0, 8)}@test.local`;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${email}, ${name}, true)
    returning id`;
  return { id, email };
}

export async function seedOrg(plan: "community" | "pro" = "pro"): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const owner = await makeUser("owner");
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"V11 " + suffix}, ${"v11-" + suffix}, ${owner.id}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${owner.id}, 'owner')`;
  if (plan !== "community") {
    await setOrgPlan(orgId, plan);
  }
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  return {
    auth: {
      orgId,
      via: "session",
      userId: owner.id,
      role: "owner",
      keyId: null,
    },
  };
}

/**
 * The football sport and its `default` variant, for suites that need a sport
 * with a `playerStats` model (generic declares none, so `recomputePlayerStats`
 * returns before it touches the table).
 *
 * Seeded here rather than assumed present. `sync:sports` fills these rows in a
 * provisioned environment, but a suite that RELIES on that is order-dependent
 * against a fresh database: the same test passes locally on a DB some other
 * suite already seeded and fails in CI with
 * `HttpError 422 unknown variant 'default' for football` from `createDivision`.
 * That is exactly how #404 shipped green locally and red on the first CI run.
 * `player-stats.test.ts` has always seeded its own; this is that block, shared.
 */
export async function seedFootballCatalog(): Promise<void> {
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('football', 'Football', ${football.version}, ${sql.json(football.positions as never)})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('football', 'default', 'Default', ${sql.json({})}, true)
    on conflict do nothing`;
}

/** Division with FUTURE fixtures — the /me lane and re-accept both filter on
 *  matchday, so dates must be ahead of now.
 *
 *  P9 pass 3b: seeds a REAL venue + court and stamps `fixtures.court_id` —
 *  never the legacy `court_label` string. `court_id` is the identity every
 *  production reader goes through since pass 3a (`FixtureLite`'s own doc
 *  comment: "every 'does this fixture have a placed court' question reads
 *  THIS, never court_label"), and `resolveCandidateCourts`
 *  (court-candidates.ts) needs a REAL `courts.id` row to resolve against — a
 *  free-text label like the old 'Court 1' string is not a valid `CourtId`
 *  and every `ScheduleConfig.courts` parse would reject it. `venue`/`court`
 *  are returned alongside the existing fields (additive — every pre-existing
 *  `{ division, fixtures }` destructure keeps working) so a caller that needs
 *  to reference this exact court (e.g. to build its own
 *  `schedule_settings.config.courts`) does not have to look it up again. */
export async function seedFutureDivision(auth: AuthCtx) {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "V11 Cup",
    visibility: "public",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(
    auth,
    division.id,
    ["A", "B", "C", "D"].map((name, i) => ({
      kind: "individual" as const,
      display_name: name,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "League",
    config: {},
  });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  const venue = await createVenue(auth, { name: "Main venue", sort: 0 });
  const court = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
  const t0 = Date.now() + 7 * 86_400_000;
  for (let i = 0; i < fixtures.length; i++) {
    await sql`
      update fixtures
      set scheduled_at = ${new Date(t0 + i * 30 * 60_000).toISOString()},
          court_id = ${court.id}
      where id = ${fixtures[i]!.id}`;
  }
  return { division, fixtures, venue, court };
}

/** `count` real courts under one shared venue, org-scoped (P9 pass 3b) — for
 *  suites that only have an org id in hand (not a full `AuthCtx`) and just
 *  need N distinct, real `courts.id` values, e.g. to give two divisions of
 *  one competition a shared court plus a court each of their own. Named
 *  "Court 1".."Court N" for a readable failure message; nothing reads the
 *  name back. `via`/`role` mirror `seedOrg`'s own synthetic auth shape;
 *  `userId: null` is safe here — court creation carries no actor-specific
 *  logic. */
export async function seedCourts(orgId: string, count: number): Promise<string[]> {
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const venue = await createVenue(auth, { name: "Main venue", sort: 0 });
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const court = await createCourt(auth, venue.id, { name: `Court ${i + 1}`, sort: i, tags: [] });
    ids.push(court.id);
  }
  return ids;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// MOVED from discipline.test.ts (email outbox phase 3 wave 4, T3): the discipline suite, the kind sweep and the A-kind body guard
// all drive the suspension notices through the real producers on this seed.
// ---------------------------------------------------------------------------------------------------------------------------------

// Full football config snapshot (createDivision would store this) — needed so
// the seam test can fold a real forfeit through the module.
const FOOTBALL_CFG = builtinModules.find((m) => m.key === "football")!.configSchema.parse({});

export interface FootballCtx {
  auth: AuthCtx;
  orgId: string;
  userId: string;
  divisionId: string;
  entrantA: string;
  entrantB: string;
  personX: string;
  personY: string;
  stageId: string;
}

export async function seedFootballDivision(plan: "pro" | "community" = "pro"): Promise<FootballCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`disc-${suffix}@test.local`}, 'Disc', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Disc " + suffix}, ${"disc-" + suffix}, ${userId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  if (plan === "pro") {
    await setOrgPlan(orgId);
  }
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('football', 'Football', '1.0.0', ${sql.json({ groups: [], lineup: { size: 11, benchMax: 12 } })})
    on conflict (key) do nothing`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, created_by)
    values (${orgId}, 'Cup', ${"cup-" + suffix}, 'public', ${userId}) returning id`;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, org_id, name, slug, sport_key, variant_key, config, module_version)
    values (${compId}, ${orgId}, 'Open', 'open', 'football', '11-a-side', ${sql.json(FOOTBALL_CFG as never)}, '1.0.0')
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, org_id, seq, kind, name) values (${divisionId}, ${orgId}, 1, 'league', 'League')
    returning id`;
  const [{ id: entrantA }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, org_id, kind, display_name, seed) values (${divisionId}, ${orgId}, 'team', 'A', 1) returning id`;
  const [{ id: entrantB }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, org_id, kind, display_name, seed) values (${divisionId}, ${orgId}, 'team', 'B', 2) returning id`;
  const [{ id: personX }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name) values (${orgId}, 'Xavier Smith') returning id`;
  const [{ id: personY }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name) values (${orgId}, 'Yousef Kane') returning id`;
  await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${entrantA}, ${personX}, ${orgId})`;
  await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${entrantB}, ${personY}, ${orgId})`;
  return {
    auth: { orgId, via: "session", userId, role: "owner", keyId: null },
    orgId,
    userId,
    divisionId,
    entrantA,
    entrantB,
    personX,
    personY,
    stageId,
  };
}

/** Link a person to a claimed user account so the confirmed/served notices
 *  have an inbox to resolve (the producers join persons→users→email). Returns
 *  the account's id (the notices are addressed to it). */
export async function claimPerson(personId: string, email: string): Promise<string> {
  const [{ id: uid }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${email}, 'Claimed', true) returning id`;
  await sql`update persons set user_id = ${uid} where id = ${personId}`;
  return uid;
}

export async function makeFixture(
  ctx: FootballCtx,
  seqInRound: number,
  home: string | null,
  away: string | null,
  status = "scheduled",
): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status)
    values (${ctx.stageId}, ${ctx.divisionId}, ${ctx.orgId}, 1, ${seqInRound}, ${home}, ${away}, ${status})
    returning id`;
  return id;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// MOVED from match-reports.test.ts (email outbox phase 3 wave 4, T3): the report suite, the kind sweep and the A-kind body guard all
// file a match report through the real producer on these. `ctx` is any seed with an org, a league stage and two entrants (the report
// suite's own `seedOrg`, or `seedFootballDivision` above).
// ---------------------------------------------------------------------------------------------------------------------------------

type ReportSeedCtx = Pick<FootballCtx, "orgId" | "divisionId" | "stageId" | "entrantA" | "entrantB">;

/** A user + a person in this org linked to it + an official on that person —
 *  the claimed-official identity a report write proves. Returns both ids. */
export async function makeClaimedOfficial(ctx: Pick<ReportSeedCtx, "orgId">): Promise<{ userId: string; officialId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`ref-${suffix}@test.local`}, 'Ref', true) returning id`;
  const [{ id: personId }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, user_id) values (${ctx.orgId}, 'Ref Person', ${userId})
    returning id`;
  const [{ id: officialId }] = await sql<{ id: string }[]>`
    insert into officials (org_id, person_id, display_name, role_keys)
    values (${ctx.orgId}, ${personId}, 'The Ref', ${sql.json(["referee"])}) returning id`;
  return { userId, officialId };
}

export async function makeAssignment(
  ctx: ReportSeedCtx,
  officialId: string,
  opts: { status?: string; response?: string } = {},
): Promise<{ fixtureOfficialId: string; fixtureId: string }> {
  const status = opts.status ?? "decided";
  const response = opts.response ?? "accepted";
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round,
                          home_entrant_id, away_entrant_id, status)
    values (${ctx.stageId}, ${ctx.divisionId}, ${ctx.orgId}, 1, 1,
            ${ctx.entrantA}, ${ctx.entrantB}, ${status}) returning id`;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into fixture_officials (fixture_id, official_id, org_id, role_key, source, response)
    values (${fixtureId}, ${officialId}, ${ctx.orgId}, 'referee', 'manual', ${response})
    returning id`;
  return { fixtureOfficialId: id, fixtureId };
}
