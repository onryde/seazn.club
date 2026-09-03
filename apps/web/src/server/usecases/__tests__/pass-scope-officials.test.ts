// W2 T6 — `officials.auto` is resolved against the competition being officiated.
//
// V391 turns `officials.auto` TRUE on `event_pass` and `event_pass_l` and FALSE
// on `community`. usecases/officials.ts gated all three entry points ORG-WIDE
// (`requireFeature(auth.orgId, "officials.auto")`, no third argument), and
// lib/entitlements.ts only consults `competition_passes` when a competition is
// in scope — so a Free org that had bought an Event Pass was sold auto-officials
// and then refused them on the very competition it paid for.
//
// The matrix makes this a real separation, not a coincidence:
//   officials.auto  community=false  event_pass=true
// so a passed competition must be allowed and an unpassed one in the SAME org
// must still be refused. Both directions are asserted on all THREE entry points:
// a one-sided test stays green if the gate leaks org-wide, which is the other
// half of the bug, and `sourceOfficials` resolves the competition through
// stages -> divisions rather than divisions alone.
//
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { PaymentRequiredError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createStages } from "../stages";
import {
  applyOfficialAssignments,
  autoAssignOfficials,
  AutoAssignInput,
  sourceOfficials,
} from "../officials";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

// Parsed, not typed inline: every AssignPolicy field but `roles` carries a zod
// default, so the inferred OUTPUT type demands all seven.
const AUTO = AutoAssignInput.parse({ policy: { roles: ["referee"] }, rng_seed: "t6" });

const GENERIC_CONFIG = {
  resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false,
};

/** A COMMUNITY org with an explicit subscriptions row — `insert into
 *  organizations` alone leaves none, and `orgPlanKey` must resolve to a plan
 *  whose `officials.auto` is FALSE for the pass to be the thing under test. */
async function seedCommunityOrg(): Promise<{ orgId: string; auth: AuthCtx }> {
  const s = uniq();
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Off Pass " + s}, ${"off-pass-" + s})
    returning id`;
  await sql`
    with _owner as (
      insert into users (email, display_name, email_verified)
      values ('seedowner-' || gen_random_uuid() || '@test.local', 'Seed Owner', true)
      returning id
    ),
    _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status)
      select coalesce(o.created_by, (select id from _owner)), 'community', 'active'
      from organizations o where o.id = ${orgId}
      returning id
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
  await invalidateOrgEntitlements(orgId);
  return { orgId, auth: { orgId, via: "session", userId: null, role: "owner", keyId: null } };
}

/** competition + one division + one league stage — enough for all three gates. */
async function seedCompetition(
  auth: AuthCtx,
  name: string,
): Promise<{ competitionId: string; divisionId: string; stageId: string }> {
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31", name, visibility: "private", branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG,
  });
  const [stage] = await createStages(auth, division.id, {
    seq: 1, kind: "league", name: "League", config: {},
  });
  return { competitionId: competition.id, divisionId: division.id, stageId: stage!.id };
}

/** Buy an Event Pass for one competition. */
async function buyPass(orgId: string, competitionId: string): Promise<void> {
  await sql`
    insert into competition_passes (competition_id, org_id) values (${competitionId}, ${orgId})
    on conflict (competition_id) do nothing`;
  await invalidateOrgEntitlements(orgId);
}

/** Pin the refusal to THIS feature: `PaymentRequiredError extends HttpError`, so
 *  `rejects.toThrowError(HttpError)` is green on any 4xx/5xx, and a 402 naming a
 *  different key (say `competitions.max_active`) would pass a bare status check. */
async function expectPaywall(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toMatchObject({ status: 402, featureKey: "officials.auto" });
  await expect(p).rejects.toBeInstanceOf(PaymentRequiredError);
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("officials.auto is resolved against the competition being officiated", () => {
  it("lets a pass run auto-assign on its own competition and refuses the org's other one", async () => {
    const { orgId, auth } = await seedCommunityOrg();
    const passed = await seedCompetition(auth, "Passed Cup " + uniq());
    await buyPass(orgId, passed.competitionId);
    const plain = await seedCompetition(auth, "Plain Cup " + uniq());

    // RED before the fix: the gate never saw the competition, so the pass was
    // invisible and this threw 402 for the competition the org paid to unlock.
    const result = await autoAssignOfficials(auth, passed.divisionId, AUTO);
    expect(result.assignments).toEqual([]);

    // The other half — a pass lifts ONE competition.
    await expectPaywall(
      autoAssignOfficials(auth, plain.divisionId, AUTO),
    );
  });

  it("lets a pass apply assignments on its own competition and refuses the org's other one", async () => {
    const { orgId, auth } = await seedCommunityOrg();
    const passed = await seedCompetition(auth, "Passed Apply " + uniq());
    await buyPass(orgId, passed.competitionId);
    const plain = await seedCompetition(auth, "Plain Apply " + uniq());

    const applied = await applyOfficialAssignments(auth, passed.divisionId, { assignments: [] });
    expect(applied).toEqual({ applied: 0 });

    await expectPaywall(applyOfficialAssignments(auth, plain.divisionId, { assignments: [] }));
  });

  it("resolves the competition through stages -> divisions for sourceOfficials", async () => {
    const { orgId, auth } = await seedCommunityOrg();
    const passed = await seedCompetition(auth, "Passed Source " + uniq());
    await buyPass(orgId, passed.competitionId);
    const plain = await seedCompetition(auth, "Plain Source " + uniq());

    const sources = [{ kind: "rank" as const, fromStage: passed.stageId, take: [{ rank: 1 }] }];
    const resolved = await sourceOfficials(auth, passed.stageId, { sources });
    // Nothing has been played, so the source is pending — the point of the
    // assertion is that the CALL got past the gate at all.
    expect(resolved.pending.length).toBeGreaterThan(0);

    await expectPaywall(
      sourceOfficials(auth, plain.stageId, {
        sources: [{ kind: "rank" as const, fromStage: plain.stageId, take: [{ rank: 1 }] }],
      }),
    );
  });
});
