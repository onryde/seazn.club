// Phase 2 pass-scoping sweep — `entrants.per_division.max` resolved against
// the competition being entered, not the org as a whole.
//
// Originally pinned through usecases/registrations.ts `submitRegistration`,
// which bounded PUBLIC intake by the plan's entrant quota so it never
// accepted money for a spot the plan could not materialise. It resolved that
// quota ORG-WIDE (`getLimit(ctx.org_id, …)`) twelve lines after using
// `ctx.competition_id` for the paid-intake gate, so an Event Pass never
// raised the cap on the competition it was bought for.
//
// `submitRegistration` is deleted (RS001 registration demolition, #588; the
// public submit route stays closed until RS002/RS003). The SAME scoping
// concern survives on a still-wired sibling call site instead:
// usecases/entrants.ts `createEntrants` resolves the identical
// `entrants.per_division.max` key, scoped by `ref?.competition_id`, for the
// organiser's own "add entrant" batch — see entrants.ts:225-235's own comment
// on why the scope id is resolved ahead of the transaction. This file now
// pins THAT call site instead; the scoping bug class it guards against is
// identical, only the caller changed.
//
// The matrix makes this a real separation:
//   entrants.per_division.max  community=64  event_pass=128
// so with 64 spots already taken the 65th entrant must be ACCEPTED on the
// passed competition and REFUSED (402) on an unpassed one in the same org.
// Asserting only the accepted side would still pass if the raised cap leaked
// org-wide.
//
// Real Postgres required; skipped without DATABASE_URL. Seeds are run-unique.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { getLimit, invalidateOrgEntitlements } from "@/lib/entitlements";
import { PaymentRequiredError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

const GENERIC_CONFIG = {
  resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false,
};

const oneEntrant = (name: string) => [
  {
    kind: "individual" as const,
    display_name: name,
    members: [{ new_person: { full_name: name }, is_captain: false, roles: [] }],
    seed: null,
    team_id: null,
    copy_roster_from_entrant_id: null,
    badge_url: null,
  },
];

async function seedCommunityOrg(): Promise<{ orgId: string; orgSlug: string; auth: AuthCtx }> {
  const s = uniq();
  const orgSlug = "cap-org-" + s;
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`cap-${s}@test.local`}, 'Cap Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Cap Org " + s}, ${orgSlug}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  // A raw org insert leaves NO subscriptions row; the pass arm only fires while
  // the resolved plan is 'community', so pin it rather than rely on fallback.
  await sql`with _owner as (
      insert into users (email, display_name, email_verified)
      values ('seedowner-' || gen_random_uuid() || '@test.local', 'Seed Owner', true)
      returning id
    ),
    _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status)
      select coalesce(o.created_by, (select id from _owner)), 'community', 'active' from organizations o where o.id = ${orgId}
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
  return { orgId, orgSlug, auth: { orgId, via: "session", userId: ownerId, role: "owner", keyId: null } };
}

/** An UNLISTED competition with one division, pre-loaded with `taken`
 *  spot-holding entrants (inserted directly — 64 round trips through
 *  createEntrants would only slow the suite down; this file's own subject
 *  is the ONE extra entrant added on top, below).
 *
 *  Unlisted, not public: community holds only ONE public competition
 *  (`dashboard.public.max` = 1) and this rig needs two side by side. */
async function seedFullDivision(
  auth: AuthCtx,
  taken: number,
): Promise<{ competitionId: string; divisionId: string }> {
  const s = uniq();
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Cap Cup " + s, visibility: "unlisted", branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open", sport_key: "generic", variant_key: "score",
    config: GENERIC_CONFIG, eligibility: [],
  });
  await sql`
    insert into entrants (division_id, kind, display_name, status)
    select ${division.id}, 'individual', 'Seed ' || g, 'confirmed'
    from generate_series(1, ${taken}) g`;
  return { competitionId: competition.id, divisionId: division.id };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("entrants.per_division.max is resolved against the competition being entered", () => {
  it("accepts entrant 65 on the passed competition and 402s on an unpassed one", async () => {
    const { orgId, auth } = await seedCommunityOrg();
    const passed = await seedFullDivision(auth, 64);
    const plain = await seedFullDivision(auth, 64);
    await sql`
      insert into competition_passes (competition_id, org_id)
      values (${passed.competitionId}, ${orgId}) on conflict (competition_id) do nothing`;
    await invalidateOrgEntitlements(orgId);

    // Guard against a vacuous pass: the two quotas must actually differ, or
    // both arms below would agree for reasons that have nothing to do with
    // scoping. 64 spots taken sits exactly on the community cap (V319).
    expect(await getLimit(orgId, "entrants.per_division.max")).toBe(64);
    expect(await getLimit(orgId, "entrants.per_division.max", passed.competitionId)).toBe(128);

    // RED before the fix: the quota was resolved org-wide, so the passed
    // competition capped at 64 too and this would 402.
    const onPassed = await createEntrants(auth, passed.divisionId, oneEntrant("Entry 65"));
    expect(onPassed).toHaveLength(1);

    // The pass lifts ONE competition — the sibling stays on the community cap.
    await expect(
      createEntrants(auth, plain.divisionId, oneEntrant("Entry 65")),
    ).rejects.toThrow(PaymentRequiredError);
  });
});
