// W2 T13 — the five keys V393 granted the Event Pass are resolved against the
// COMPETITION being acted on, at every enforcement site.
//
// V393 turns these ON (or lifts the cap) for `event_pass`/`event_pass_l` and
// leaves them OFF (or lower) for `community`:
//
//   stats.player                true  vs false
//   discipline.enforced         true  vs false
//   scoring.device_links        true  vs false
//   stages.per_division.max     4     vs 2
//   schedule.checkpoints.max    5     vs 2
//
// lib/entitlements.ts only consults `competition_passes` when a competition is
// in scope (`resolveFromDb`'s `if (competitionId)` branch), so every gate that
// omitted the third argument made the pass INVISIBLE: a Community org bought a
// $29 pass and was refused the very features the matrix sells with it.
//
// Every case asserts BOTH directions on the SAME org — granted on the passed
// competition, refused on a sibling competition that carries no pass. A
// one-sided test stays green if the gate leaks org-wide, which is the other
// half of the bug and the same $29 hole in the other direction.
//
// Not covered here, deliberately: usecases/templates.ts's
// `stages.per_division.max`. `createFromTemplate` generates the competition id
// itself, so no `competition_passes` row can reference it yet and the pass
// overlay resolves nothing either way — there is no behaviour to observe. That
// call site's test is lib/__tests__/pass-scoping-guard.test.ts, which fails the
// moment the argument is dropped (same reasoning the `divisions.per_competition
// .max` call beside it already carries in its own comment).
//
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { football } from "@seazn/engine/sports/football";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { PaymentRequiredError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createStages } from "../stages";
import { createDeviceLink } from "../device-links";
import { createCheckpoint } from "../history";
import { putMyReport, submitMyReport } from "../match-reports";
import { divisionPlayerStats, personCareerStats, personStats } from "../player-stats";
import {
  createManualSuspension,
  decideSuspension,
  getDisciplineRules,
  listSuspensions,
  putDisciplineRules,
  suspensionsForFixture,
} from "../discipline";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

const GENERIC_CONFIG = {
  resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false,
};

interface OrgCtx {
  orgId: string;
  userId: string;
  auth: AuthCtx;
}

/** A COMMUNITY org with an explicit `subscriptions` row — `insert into
 *  organizations` alone leaves none, and `orgPlanKey` must resolve to a plan
 *  whose values are the LOW side of every key above for the pass to be the
 *  thing under test. The owner user is real: `createDeviceLink` refuses
 *  anything but a session with a `userId`, and `device_links.issued_by` FKs it. */
async function seedCommunityOrg(): Promise<OrgCtx> {
  const s = uniq();
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`t13-${s}@test.local`}, 'T13 Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"T13 " + s}, ${"t13-" + s}, ${userId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  await sql`
    with _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status)
      values (${userId}, 'community', 'active') returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('football', 'Football', ${football.version}, ${sql.json(football.positions as never)})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('football', 'default', 'Default', ${sql.json({})}, true)
    on conflict do nothing`;
  await invalidateOrgEntitlements(orgId);
  return { orgId, userId, auth: { orgId, via: "session", userId, role: "owner", keyId: null } };
}

interface CompCtx {
  competitionId: string;
  divisionId: string;
  stageId: string;
  entrantA: string;
  entrantB: string;
}

/** competition + one division + one league stage + two entrants. */
async function seedCompetition(
  ctx: OrgCtx,
  name: string,
  sport: "generic" | "football" = "generic",
): Promise<CompCtx> {
  const competition = await createCompetition(ctx.auth, {
    ends_on: "2030-12-31", name, visibility: "private", branding: {},
  });
  const division = await createDivision(ctx.auth, competition.id, {
    name: "Open",
    sport_key: sport,
    variant_key: sport === "generic" ? "score" : "default",
    config: sport === "generic" ? GENERIC_CONFIG : {},
  });
  const [stage] = await createStages(ctx.auth, division.id, {
    seq: 1, kind: "league", name: "League", config: {},
  });
  const [{ id: entrantA }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, org_id, kind, display_name, seed)
    values (${division.id}, ${ctx.orgId}, 'team', 'Alpha', 1) returning id`;
  const [{ id: entrantB }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, org_id, kind, display_name, seed)
    values (${division.id}, ${ctx.orgId}, 'team', 'Bravo', 2) returning id`;
  return { competitionId: competition.id, divisionId: division.id, stageId: stage!.id, entrantA, entrantB };
}

/** Buy an Event Pass for one competition. */
async function buyPass(orgId: string, competitionId: string): Promise<void> {
  await sql`
    insert into competition_passes (competition_id, org_id) values (${competitionId}, ${orgId})
    on conflict (competition_id) do nothing`;
  await invalidateOrgEntitlements(orgId);
}

async function makeFixture(ctx: OrgCtx, c: CompCtx, status = "scheduled"): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round,
                          home_entrant_id, away_entrant_id, status)
    values (${c.stageId}, ${c.divisionId}, ${ctx.orgId}, 1, 1,
            ${c.entrantA}, ${c.entrantB}, ${status}) returning id`;
  return id;
}

async function makePerson(ctx: OrgCtx, name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name) values (${ctx.orgId}, ${name}) returning id`;
  return id;
}

/** A snapshot row is the disposable cache both person readers select from —
 *  seeding it directly keeps these tests about the GATE, not about the fold. */
async function seedSnapshot(
  ctx: OrgCtx, divisionId: string, personId: string, sportKey: string, stats: Record<string, number>,
): Promise<void> {
  await sql`
    insert into player_stat_snapshots (division_id, person_id, org_id, sport_key, stats, computed_through_seq)
    values (${divisionId}, ${personId}, ${ctx.orgId}, ${sportKey}, ${sql.json(stats)}, 0)
    on conflict (division_id, person_id) do update set stats = excluded.stats`;
}

/** Pin the refusal to THIS feature: `PaymentRequiredError extends HttpError`, so
 *  `rejects.toThrowError(HttpError)` is green on any 4xx/5xx, and a 402 naming a
 *  different key would pass a bare status check. */
async function expectPaywall(p: Promise<unknown>, featureKey: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ status: 402, featureKey });
  await expect(p).rejects.toBeInstanceOf(PaymentRequiredError);
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("Event Pass grants resolve against the competition (W2 T13)", () => {
  it("scoring.device_links: mints on the passed competition, 402s on the sibling", async () => {
    const ctx = await seedCommunityOrg();
    const passed = await seedCompetition(ctx, "DL Passed " + uniq());
    await buyPass(ctx.orgId, passed.competitionId);
    const plain = await seedCompetition(ctx, "DL Plain " + uniq());

    const link = await createDeviceLink(ctx.auth, await makeFixture(ctx, passed), "Pitch 1");
    expect(link.secret).toMatch(/^dl_/);

    await expectPaywall(
      createDeviceLink(ctx.auth, await makeFixture(ctx, plain), "Pitch 1"),
      "scoring.device_links",
    );
  });

  it("schedule.checkpoints.max: five save points on the passed competition, two on the sibling", async () => {
    const ctx = await seedCommunityOrg();
    const passed = await seedCompetition(ctx, "CP Passed " + uniq());
    await buyPass(ctx.orgId, passed.competitionId);
    const plain = await seedCompetition(ctx, "CP Plain " + uniq());

    // community = 2, event_pass = 5. Three manual saves: the passed division
    // keeps all three; the unpassed one rolls its window and evicts the oldest.
    for (const label of ["one", "two"]) await createCheckpoint(ctx.auth, passed.divisionId, label);
    const third = await createCheckpoint(ctx.auth, passed.divisionId, "three");
    expect(third.evicted).toBeUndefined();
    const [{ n: passedCount }] = await sql<{ n: number }[]>`
      select count(*)::int as n from division_checkpoints
      where division_id = ${passed.divisionId} and kind = 'manual'`;
    expect(passedCount).toBe(3);

    for (const label of ["one", "two"]) await createCheckpoint(ctx.auth, plain.divisionId, label);
    const rolled = await createCheckpoint(ctx.auth, plain.divisionId, "three");
    expect(rolled.evicted?.label).toBe("one");
    const [{ n: plainCount }] = await sql<{ n: number }[]>`
      select count(*)::int as n from division_checkpoints
      where division_id = ${plain.divisionId} and kind = 'manual'`;
    expect(plainCount).toBe(2);
  });

  it("discipline.enforced: the report bridge raises a suspension on the passed competition only", async () => {
    const ctx = await seedCommunityOrg();
    const passed = await seedCompetition(ctx, "Disc Passed " + uniq());
    await buyPass(ctx.orgId, passed.competitionId);
    const plain = await seedCompetition(ctx, "Disc Plain " + uniq());

    const fileReport = async (c: CompCtx): Promise<void> => {
      const s = uniq();
      const [{ id: refUser }] = await sql<{ id: string }[]>`
        insert into users (email, display_name, email_verified)
        values (${`ref-${s}@test.local`}, 'Ref', true) returning id`;
      const [{ id: refPerson }] = await sql<{ id: string }[]>`
        insert into persons (org_id, full_name, user_id)
        values (${ctx.orgId}, 'Ref Person', ${refUser}) returning id`;
      const [{ id: officialId }] = await sql<{ id: string }[]>`
        insert into officials (org_id, person_id, display_name, role_keys)
        values (${ctx.orgId}, ${refPerson}, 'The Ref', ${sql.json(["referee"])}) returning id`;
      const fixtureId = await makeFixture(ctx, c, "decided");
      const [{ id: foId }] = await sql<{ id: string }[]>`
        insert into fixture_officials (fixture_id, official_id, org_id, role_key, source, response)
        values (${fixtureId}, ${officialId}, ${ctx.orgId}, 'referee', 'manual', 'accepted') returning id`;
      const player = await makePerson(ctx, "Player Nine");
      const incidents = [{ kind: "red_card" as const, person_id: player, note: "violent conduct" }];
      await putMyReport(refUser, foId, { body: "as it happened", incidents });
      await submitMyReport(refUser, foId);
    };

    await fileReport(passed);
    await fileReport(plain);

    const [{ n: passedSuspensions }] = await sql<{ n: number }[]>`
      select count(*)::int as n from suspensions
      where division_id = ${passed.divisionId} and source = 'report'`;
    expect(passedSuspensions).toBe(1);

    const [{ n: plainSuspensions }] = await sql<{ n: number }[]>`
      select count(*)::int as n from suspensions
      where division_id = ${plain.divisionId} and source = 'report'`;
    expect(plainSuspensions).toBe(0);
  });

  it("stats.player: the division leaderboard reads on the passed competition and 402s on the sibling", async () => {
    const ctx = await seedCommunityOrg();
    const passed = await seedCompetition(ctx, "LB Passed " + uniq());
    await buyPass(ctx.orgId, passed.competitionId);
    const plain = await seedCompetition(ctx, "LB Plain " + uniq());

    const board = await divisionPlayerStats(ctx.auth, passed.divisionId, {});
    expect(board.rows).toEqual([]);

    await expectPaywall(divisionPlayerStats(ctx.auth, plain.divisionId, {}), "stats.player");
  });

  it("stats.player: a person card serves the passed competition's divisions and no other", async () => {
    const ctx = await seedCommunityOrg();
    const passed = await seedCompetition(ctx, "PC Passed " + uniq());
    await buyPass(ctx.orgId, passed.competitionId);
    const plain = await seedCompetition(ctx, "PC Plain " + uniq());
    const person = await makePerson(ctx, "Two Division Player");

    // Asked for the passed division by name: the point is that the call gets
    // PAST the gate. A named division is always recomputed, and `recompute`
    // deletes that division's snapshot rows before rebuilding them from
    // `score_events` — so nothing hand-seeded could survive this call, and the
    // empty result is the honest expectation for a division with no events.
    const scoped = await personStats(ctx.auth, person, passed.divisionId);
    expect(scoped.divisions).toEqual([]);

    // Asked for the unpassed one by name — the pass lifts ONE competition.
    await expectPaywall(personStats(ctx.auth, person, plain.divisionId), "stats.player");

    // Asked for everything: the unpassed competition's row must not ride along.
    // Seeded after the recompute above, and the person is rostered nowhere, so
    // the unscoped read touches the snapshots without rebuilding them.
    await seedSnapshot(ctx, passed.divisionId, person, "generic", { points: 3 });
    await seedSnapshot(ctx, plain.divisionId, person, "generic", { points: 7 });
    const all = await personStats(ctx.auth, person);
    expect(all.divisions.map((d) => d.division_id)).toEqual([passed.divisionId]);
  });

  it("stats.player: the career rollup sums the passed competition only, and 402s with no pass in it", async () => {
    const ctx = await seedCommunityOrg();
    const passed = await seedCompetition(ctx, "CR Passed " + uniq());
    await buyPass(ctx.orgId, passed.competitionId);
    const plain = await seedCompetition(ctx, "CR Plain " + uniq(), "football");

    const both = await makePerson(ctx, "Career Player");
    await seedSnapshot(ctx, passed.divisionId, both, "generic", { points: 3 });
    await seedSnapshot(ctx, plain.divisionId, both, "football", { goals: 7 });
    const rollup = await personCareerStats(ctx.auth, both);
    expect(rollup.sports.map((s) => s.sport_key)).toEqual(["generic"]);
    expect(rollup.sports[0]!.divisions).toBe(1);

    // A person who only ever played the unpassed competition has nothing the
    // pass covers, so the refusal is the honest answer — and it names the key.
    const outsider = await makePerson(ctx, "Outsider");
    await seedSnapshot(ctx, plain.divisionId, outsider, "football", { goals: 1 });
    await expectPaywall(personCareerStats(ctx.auth, outsider), "stats.player");
  });

  it("stages.per_division.max: four stages on the passed competition, two on the sibling", async () => {
    const ctx = await seedCommunityOrg();
    const passed = await seedCompetition(ctx, "SC Passed " + uniq());
    await buyPass(ctx.orgId, passed.competitionId);
    const plain = await seedCompetition(ctx, "SC Plain " + uniq());

    // Each division already holds stage seq 1. community = 2, event_pass = 4.
    await createStages(ctx.auth, passed.divisionId, [
      { seq: 2, kind: "league", name: "Two", config: {} },
      { seq: 3, kind: "league", name: "Three", config: {} },
    ]);
    const [{ n: passedStages }] = await sql<{ n: number }[]>`
      select count(*)::int as n from stages where division_id = ${passed.divisionId}`;
    expect(passedStages).toBe(3);

    await createStages(ctx.auth, plain.divisionId, { seq: 2, kind: "league", name: "Two", config: {} });
    await expectPaywall(
      createStages(ctx.auth, plain.divisionId, { seq: 3, kind: "league", name: "Three", config: {} }),
      "stages.per_division.max",
    );
  });
  // -------------------------------------------------------------------------
  // discipline.enforced, the OTHER six gates. The report bridge above is the
  // only WRITE into the suspensions table, and it was the only site V393's
  // wave scoped. usecases/discipline.ts read its key from a module-local
  // `const FEATURE`, which `pass-scoping-guard.test.ts` cannot see (it matches
  // a string LITERAL in argument 2), so six gates kept asking org-wide and
  // stayed silently unscoped.
  //
  // The customer consequence is worse than a plain refusal: the bridge WROTE
  // pending suspensions against the passed competition, and the console could
  // never list, waive or decide them. Money taken, state accumulating, feature
  // half-delivered.
  // -------------------------------------------------------------------------
  const DISCIPLINE_RULES = {
    accumulation: [{ key: "yellow_5", color: "yellow", count: 5, ban_matches: 1 }],
    dismissal: [{ key: "red", color: "red", ban_matches: 1 }],
  };

  it("discipline.enforced: the console reads and decides on the passed competition, and 402s on the sibling", async () => {
    const ctx = await seedCommunityOrg();
    const passed = await seedCompetition(ctx, "DC Passed " + uniq(), "football");
    await buyPass(ctx.orgId, passed.competitionId);
    const plain = await seedCompetition(ctx, "DC Plain " + uniq(), "football");

    // GET rules — the console's own entry point. Non-null is load-bearing:
    // `null` is the "this sport tracks no discipline" answer and would be a
    // green that proves nothing, so pin the sport's offerable colours too.
    const rules = await getDisciplineRules(ctx.auth, passed.divisionId);
    expect(rules?.sportColors.map((c) => c.key)).toContain("red");
    await expectPaywall(getDisciplineRules(ctx.auth, plain.divisionId), "discipline.enforced");

    // PUT rules — the write the organiser makes before anything detects.
    await putDisciplineRules(ctx.auth, passed.divisionId, {
      enabled: true,
      rules: DISCIPLINE_RULES,
    });
    expect((await getDisciplineRules(ctx.auth, passed.divisionId))?.enabled).toBe(true);
    await expectPaywall(
      putDisciplineRules(ctx.auth, plain.divisionId, { enabled: true, rules: DISCIPLINE_RULES }),
      "discipline.enforced",
    );

    // Manual ban + list.
    const player = await makePerson(ctx, "Suspended Nine");
    await sql`
      insert into entrant_members (entrant_id, person_id, org_id)
      values (${passed.entrantA}, ${player}, ${ctx.orgId})`;
    const manual = await createManualSuspension(ctx.auth, passed.divisionId, {
      personId: player,
      matchesTotal: 1,
      reason: "violent conduct",
    });
    expect(manual.status).toBe("pending");
    await expectPaywall(
      createManualSuspension(ctx.auth, plain.divisionId, {
        personId: player,
        matchesTotal: 1,
        reason: "violent conduct",
      }),
      "discipline.enforced",
    );

    expect((await listSuspensions(ctx.auth, passed.divisionId)).map((r) => r.id)).toEqual([manual.id]);
    await expectPaywall(listSuspensions(ctx.auth, plain.divisionId), "discipline.enforced");

    // Decide — resolved from the SUSPENSION's own division, one hop further
    // out than every other gate here.
    const active = await decideSuspension(ctx.auth, manual.id, { kind: "confirm" });
    expect(active.status).toBe("active");
    expect(active.entrantId).toBe(passed.entrantA);
  });

  it("discipline.enforced: the pad's suspension banner is populated by the pass, and its empty answer is the gate", async () => {
    // suspensionsForFixture returns [] on refusal rather than throwing (the
    // fixture page renders for every tier). An over-refusing guard therefore
    // hides behind an empty list, so the pass case must prove ROWS COME BACK
    // and the denied case must prove the row it declines to return EXISTS.
    const ctx = await seedCommunityOrg();
    const passed = await seedCompetition(ctx, "DB Passed " + uniq(), "football");
    await buyPass(ctx.orgId, passed.competitionId);
    const plain = await seedCompetition(ctx, "DB Plain " + uniq(), "football");

    const seedActiveBan = async (c: CompCtx, name: string): Promise<string> => {
      const person = await makePerson(ctx, name);
      await sql`
        insert into entrant_members (entrant_id, person_id, org_id)
        values (${c.entrantA}, ${person}, ${ctx.orgId})`;
      await sql`
        insert into suspensions (org_id, division_id, person_id, entrant_id, status, source,
                                 reason, matches_total, matches_served, decided_at)
        values (${ctx.orgId}, ${c.divisionId}, ${person}, ${c.entrantA}, 'active', 'manual',
                'violent conduct', 2, 0, now())`;
      return person;
    };
    const onPassed = await seedActiveBan(passed, "Banner Passed");
    const onPlain = await seedActiveBan(plain, "Banner Plain");

    expect(
      await suspensionsForFixture(ctx.auth, passed.divisionId, [passed.entrantA, passed.entrantB]),
    ).toEqual([{ personId: onPassed, personName: "Banner Passed", served: 0, total: 2 }]);

    // The sibling competition carries an identical row and is answered [].
    expect(
      await suspensionsForFixture(ctx.auth, plain.divisionId, [plain.entrantA, plain.entrantB]),
    ).toEqual([]);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from suspensions
      where division_id = ${plain.divisionId} and status = 'active'`;
    expect(n).toBe(1);

    // Same call, same rows, one pass bought: the [] above was the gate.
    await buyPass(ctx.orgId, plain.competitionId);
    expect(
      await suspensionsForFixture(ctx.auth, plain.divisionId, [plain.entrantA, plain.entrantB]),
    ).toEqual([{ personId: onPlain, personName: "Banner Plain", served: 0, total: 2 }]);
  });
});
