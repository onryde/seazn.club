// PROMPT-13 acceptance: (1) matrix test — feature_key × plan asserted at the
// ENFORCEMENT POINT (the use-case call), not just hasFeature; (2) downgrade
// simulation — pro → community keeps data, over-quota freezes, coarse scoring
// still works. Real Postgres required (RLS, triggers); skipped without
// DATABASE_URL — CI runs them against its service container. Redis is
// intentionally absent here: every entitlement read exercises the documented
// fail-open path (cache miss → Postgres).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { football } from "@seazn/engine/sports/football";
import { cricket } from "@seazn/engine/sports/cricket";
import { icehockey } from "@seazn/engine/sports/icehockey";
import { sql } from "@/lib/db";
import { getLimit, invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition, patchCompetition, listCompetitions, getCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createApiKey } from "../api-keys";
import { feePercentFor } from "../registrations";
import { platformFeeDefault } from "@/lib/platform-settings";

const HAS_DB = !!process.env.DATABASE_URL;

type Plan = "community" | "pro" | "enterprise";

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedOrg(plan: Plan): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Ent " + suffix}, ${"ent-" + suffix})
    returning id`;
  // No subscription row = community (the resolver's fallback).
  if (plan !== "community") {
    await sql`
      with _owner as (
      insert into users (email, display_name, email_verified)
      values ('seedowner-' || gen_random_uuid() || '@test.local', 'Seed Owner', true)
      returning id
    ),
    _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status)
      select coalesce(o.created_by, (select id from _owner)), ${plan}, 'active' from organizations o where o.id = ${orgId}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
  }
  await sql`
    insert into sports (key, name, module_version, position_catalog) values
      ('generic',   'Generic',    '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })}),
      ('football',  'Football',   ${football.version}, ${sql.json(football.positions as never)}),
      ('cricket',   'Cricket',    ${cricket.version}, ${sql.json(cricket.positions as never)}),
      ('icehockey', 'Ice Hockey', ${icehockey.version}, ${sql.json(icehockey.positions as never)})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system) values
      ('generic',   'score',   'Score',   ${sql.json(GENERIC_CONFIG)}, true),
      ('football',  'default', 'Default', ${sql.json({})}, true),
      ('cricket',   't20',     'T20',     ${sql.json(cricket.variants.t20 as never)}, true),
      ('icehockey', 'iihf',    'IIHF',    ${sql.json(icehockey.variants.iihf as never)}, true)
    on conflict do nothing`;
  return { auth: { orgId, via: "session", userId: null, role: "owner", keyId: null } };
}

async function setPlan(orgId: string, plan: Plan): Promise<void> {
  await sql`
    with _owner as (
      insert into users (email, display_name, email_verified)
      values ('seedowner-' || gen_random_uuid() || '@test.local', 'Seed Owner', true)
      returning id
    ),
    _seed_sub as (
      insert into subscriptions (owner_user_id, plan_key, status)
      select coalesce(o.created_by, (select id from _owner)), ${plan}, 'active' from organizations o where o.id = ${orgId}
      returning id
    )
    update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
  await invalidateOrgEntitlements(orgId);
}

async function makeCompetition(
  auth: AuthCtx,
  name: string,
  visibility: "private" | "public" = "private",
) {
  return createCompetition(auth, { ends_on: "2030-12-31", name, visibility, branding: {} });
}

// R6 fix pass 4, finding E — icehockey joins this lookup so `makeFixture`
// below can build an icehockey rig too. Kept a map rather than another
// ternary arm: unlisted (currently only "cricket") falls back to "t20",
// byte-identical to the pre-R6-fix-4 default.
const VARIANT_BY_SPORT: Record<string, string> = { generic: "score", football: "default", icehockey: "iihf" };

async function makeDivision(auth: AuthCtx, competitionId: string, sport: string, config: object) {
  return createDivision(auth, competitionId, {
    name: `Div ${randomUUID().slice(0, 6)}`,
    sport_key: sport,
    variant_key: VARIANT_BY_SPORT[sport] ?? "t20",
    config,
  } as never);
}

/** division + 2 entrants + generated league fixture — the scoring probe rig. */
async function makeFixture(auth: AuthCtx, competitionId: string, sport: string, config: object) {
  const division = await makeDivision(auth, competitionId, sport, config);
  // Team-declared sports (football, cricket — entrant shapes, spec
  // 2026-07-18) reject individual entrants at the write path now; generic
  // keeps the legacy anything-goes.
  const kind = sport === "generic" ? "individual" : "team";
  const entrants = await createEntrants(auth, division.id, [
    { kind, display_name: "A", seed: 1, members: [] },
    { kind, display_name: "B", seed: 2, members: [] },
  ] as never);
  const [stage] = await createStages(auth, division.id, {
    seq: 1, kind: "league", name: "L", config: {},
  } as never);
  const { fixtures } = await generateStageFixtures(auth, stage.id);
  // Scoring opens only after start (doc 12 §1, PROMPT-17).
  await startDivision(auth, division.id);
  return { division, entrants, fixtureId: fixtures[0].id };
}

// ---------------------------------------------------------------------------
// The matrix: feature_key × plan, probed at the enforcement point. `probe`
// performs the just-over-the-limit action; deny must be a 402 carrying
// exactly this feature_key (the UpgradeGate contract, doc 10 §3).
// ---------------------------------------------------------------------------
const MATRIX: { feature: string; plan: Plan; allowed: boolean }[] = [
  { feature: "competitions.max_active",       plan: "community", allowed: false },
  { feature: "competitions.max_active",       plan: "pro",       allowed: true },
  { feature: "dashboard.public.max",          plan: "community", allowed: false },
  { feature: "dashboard.public.max",          plan: "pro",       allowed: true },
  { feature: "divisions.per_competition.max", plan: "community", allowed: false },
  { feature: "divisions.per_competition.max", plan: "pro",       allowed: true },
  { feature: "stages.per_division.max",       plan: "community", allowed: false },
  { feature: "stages.per_division.max",       plan: "pro",       allowed: true },
  { feature: "entrants.per_division.max",     plan: "community", allowed: false },
  { feature: "entrants.per_division.max",     plan: "pro",       allowed: true },
  // V391 (entitlements v18 §2): double elimination and cricket DLS are free on
  // every plan now — the rows still EXIST in plan_entitlements (unlike
  // scoring.match_timeline below, which was deleted), so the community arm is
  // still a real assertion: it says the boundary was opened, not removed.
  { feature: "formats.double_elim",           plan: "community", allowed: true },
  { feature: "formats.double_elim",           plan: "pro",       allowed: true },
  // W1 (entitlements v18, 2026-09-02): `scoring.match_timeline` formerly sat
  // here as community=false/pro=true — deleted, not flipped to true/true,
  // because it is no longer a PLAN-gated feature key at all (V390 drops it
  // from `plan_entitlements` entirely; `scoreEvent` never calls `hasFeature`
  // for it). A matrix row asserts a feature/plan boundary; there is none left
  // to assert here. "coarse scoring never needs a plan" below (football.goal)
  // and this file's own `scoring-free.test.ts` sibling now prove the same
  // fact for the general case, across every shipped sport.
  { feature: "cricket.dls",                   plan: "community", allowed: true },
  { feature: "cricket.dls",                   plan: "pro",       allowed: true },
  { feature: "api.access",                    plan: "community", allowed: false },
  { feature: "api.access",                    plan: "pro",       allowed: true },
  // V391 (entitlements v18) re-homes api.write above Pro on Enterprise: score/manage keys need it (a
  // community org's write-key attempt still 402s on api.access first, above).
  { feature: "api.write",                     plan: "pro",       allowed: false },
  { feature: "api.write",                     plan: "enterprise", allowed: true },
];

async function probe(feature: string, auth: AuthCtx): Promise<() => Promise<unknown>> {
  switch (feature) {
    case "competitions.max_active": {
      // Fill to the plan's cap (v3: community 1), then try one more.
      const limit = (await getLimit(auth.orgId, "competitions.max_active")) ?? 2;
      for (let i = 1; i <= limit; i++) await makeCompetition(auth, `C${i}`);
      return () => makeCompetition(auth, "C over"); // one past the cap
    }
    case "dashboard.public.max": {
      // The active-comp cap would fire first; lift it via override so this
      // probe isolates the public-dashboard quota. Fill to the COMMUNITY cap,
      // read from the matrix rather than typed (V391 moved it 1 -> 3), so the
      // community arm sits exactly at its limit and pro (unlimited) has room.
      const [{ int_value: pub }] = await sql<{ int_value: number }[]>`
        select int_value from plan_entitlements
        where plan_key = 'community' and feature_key = 'dashboard.public.max'`;
      await sql`
        insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
        values (${auth.orgId}, 'competitions.max_active', ${pub + 1}, 'test probe')`;
      await invalidateOrgEntitlements(auth.orgId);
      for (let i = 1; i <= pub; i++) await makeCompetition(auth, `P${i}`, "public");
      return () => makeCompetition(auth, `P${pub + 1}`, "public"); // one past the cap
    }
    case "divisions.per_competition.max": {
      // Fill to the COMMUNITY cap, read from the matrix. That one number does
      // both arms: community sits exactly at its limit and must 402, while pro
      // (V391: 20, no longer unlimited) still has room and must succeed.
      // Filling to the ORG's own cap made the pro arm 402 the moment pro
      // stopped being unlimited.
      const comp = await makeCompetition(auth, "D");
      const [{ int_value: fill }] = await sql<{ int_value: number }[]>`
        select int_value from plan_entitlements
        where plan_key = 'community' and feature_key = 'divisions.per_competition.max'`;
      for (let i = 1; i <= fill; i++) await makeDivision(auth, comp.id, "generic", GENERIC_CONFIG);
      return () => makeDivision(auth, comp.id, "generic", GENERIC_CONFIG); // one past the cap
    }
    case "stages.per_division.max": {
      const comp = await makeCompetition(auth, "S");
      const division = await makeDivision(auth, comp.id, "generic", GENERIC_CONFIG);
      await createStages(auth, division.id, [
        { seq: 1, kind: "league", name: "S1", config: {} },
        { seq: 2, kind: "knockout", name: "S2", config: {} },
      ] as never);
      return () => // 3rd stage
        createStages(auth, division.id, { seq: 3, kind: "knockout", name: "S3", config: {} } as never);
    }
    case "entrants.per_division.max": {
      const comp = await makeCompetition(auth, "E");
      const division = await makeDivision(auth, comp.id, "generic", GENERIC_CONFIG);
      // Fill to the COMMUNITY cap, then try one more. That single number does
      // both arms of the matrix: the community org is exactly at its limit and
      // must 402, while pro (256) still has room and must succeed. Read it from
      // plan_entitlements rather than writing 32 — V311 moved this row 16 → 32
      // and a stale literal would leave the deny arm filling half the quota and
      // asserting nothing at all.
      const [{ int_value: fill }] = await sql<{ int_value: number }[]>`
        select int_value from plan_entitlements
        where plan_key = 'community' and feature_key = 'entrants.per_division.max'`;
      await createEntrants(
        auth,
        division.id,
        Array.from({ length: fill }, (_, i) => ({
          kind: "individual" as const, display_name: `E${i}`, seed: i + 1, members: [],
        })) as never,
      );
      return () => // one past the community cap
        createEntrants(auth, division.id, [
          { kind: "individual", display_name: `E${fill + 1}`, seed: fill + 1, members: [] },
        ] as never);
    }
    case "formats.double_elim": {
      const comp = await makeCompetition(auth, "DE");
      const division = await makeDivision(auth, comp.id, "generic", GENERIC_CONFIG);
      return () =>
        createStages(auth, division.id, { seq: 1, kind: "double_elim", name: "DE", config: {} } as never);
    }
    case "cricket.dls": {
      const comp = await makeCompetition(auth, "CR");
      const { fixtureId } = await makeFixture(auth, comp.id, "cricket", {
        dls: { enabled: true, edition: "standard" },
      });
      return () => // revise WITHOUT a manual target ⇒ fold computes DLS
        scoreEvent(auth, fixtureId, {
          expected_seq: 0,
          type: "cricket.revise",
          payload: { oversPerSide: 10 },
        });
    }
    case "api.access":
      return () => createApiKey(auth, { name: "k", scopes: ["read"] });
    case "api.write":
      return () => createApiKey(auth, { name: "k", scopes: ["read", "write"] });
    default:
      throw new Error(`no probe for ${feature}`);
  }
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("entitlements v2 matrix (doc 10 §1/§2)", () => {
  it.each(MATRIX)("$feature × $plan → allowed=$allowed", async ({ feature, plan, allowed }) => {
    const { auth } = await seedOrg(plan);
    const act = await probe(feature, auth);
    if (allowed) {
      await expect(act()).resolves.toBeDefined();
    } else {
      await expect(act()).rejects.toMatchObject({ status: 402, featureKey: feature });
    }
  });

  it("cricket.revise with a MANUAL umpire target is always allowed (doc 10 §1)", async () => {
    const { auth } = await seedOrg("community");
    const comp = await makeCompetition(auth, "CRM");
    const { fixtureId } = await makeFixture(auth, comp.id, "cricket", {
      dls: { enabled: true, edition: "standard" },
    });
    const out = await scoreEvent(auth, fixtureId, {
      expected_seq: 0,
      type: "cricket.revise",
      payload: { oversPerSide: 10, target: 95 },
    });
    expect(out.seq).toBe(1);
  });

  it("coarse scoring never needs a plan: community appends a football goal", async () => {
    const { auth } = await seedOrg("community");
    const comp = await makeCompetition(auth, "FG");
    const { entrants, fixtureId } = await makeFixture(auth, comp.id, "football", {});
    await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    const out = await scoreEvent(auth, fixtureId, {
      expected_seq: 1,
      type: "football.goal",
      payload: { by: entrants[0].id },
    });
    expect(out.seq).toBe(2);
  });

  // R6 fix pass 4, finding E (owner ruling, 2026-08-30) freed
  // `icehockey.suspension.start` alone, leaving `icehockey.set_piece` on the
  // SAME fixture Pro-gated — a narrow, sport-specific carve-out that predates
  // this wave. W1 (entitlements v18, owner ruling 2026-08-30) supersedes it:
  // scoring detail is free on every plan, full stop, so the set piece is now
  // free too — formerly asserted 402 + `featureKey: "scoring.match_timeline"`
  // here; that refusal no longer exists. At `scoreEvent` — the EXACT function
  // `POST /api/v1/fixtures/[id]/events` calls — against REAL Postgres (RLS,
  // triggers), not a pure unit.
  it("community appends an icehockey suspension.start AND its set piece free — both fine events, same fixture", async () => {
    const { auth } = await seedOrg("community");
    const comp = await makeCompetition(auth, "IH");
    const { entrants, fixtureId } = await makeFixture(auth, comp.id, "icehockey", {});
    await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    const out = await scoreEvent(auth, fixtureId, {
      expected_seq: 1,
      type: "icehockey.suspension.start",
      payload: { by: entrants[0].id, class: "minor", at: { period: "P1", elapsed: 100 } },
    });
    expect(out.seq).toBe(2);
    const setPiece = await scoreEvent(auth, fixtureId, {
      expected_seq: 2,
      type: "icehockey.set_piece",
      payload: { by: entrants[0].id, kind: "ps" },
    });
    expect(setPiece.seq).toBe(3);
  });
});

describe.skipIf(!HAS_DB)("downgrade simulation (doc 10 §2.4)", () => {
  it("pro → community: data kept, over-quota frozen, coarse scoring still works", async () => {
    const { auth } = await seedOrg("pro");

    // Twelve active competitions under Pro. B carries real play (a generic
    // fixture we keep scoring, plus a football division with fine events).
    // Community's cap is 10 since V319 (was 5), so the org has to sit TWO over
    // for this to remain a partial-freeze test — with fewer than twelve
    // competitions the downgrade would now freeze nothing and every assertion
    // below would pass vacuously.
    const compA = await makeCompetition(auth, "Alpha");
    const compB = await makeCompetition(auth, "Beta");
    const compC = await makeCompetition(auth, "Gamma");
    for (const n of [
      "Delta", "Epsilon", "Zeta", "Eta", "Theta",
      "Iota", "Kappa", "Lambda", "Mu",
    ]) await makeCompetition(auth, n);
    const rigGeneric = await makeFixture(auth, compB.id, "generic", GENERIC_CONFIG);
    const rigFootball = await makeFixture(auth, compB.id, "football", {});

    // Fine event under Pro: allowed (and stays visible after the downgrade).
    await scoreEvent(auth, rigFootball.fixtureId, {
      expected_seq: 0,
      type: "football.card",
      payload: { by: rigFootball.entrants[0].id, color: "yellow" },
    });
    await scoreEvent(auth, rigGeneric.fixtureId, {
      expected_seq: 0, type: "core.start", payload: {},
    });

    // Deterministic activity order: A oldest, C next, then the four fillers
    // (created just now), B newest of all (it carries score events).
    await sql`update competitions set created_at = now() - interval '2 hours' where id = ${compA.id}`;
    await sql`update competitions set created_at = now() - interval '1 hour' where id = ${compC.id}`;

    await setPlan(auth.orgId, "community");

    // Nothing deleted; the most recently active survive the community cap
    // (V319 10 -> V391 3) and the rest freeze. The cap is READ, so a re-tune
    // moves this test instead of quietly freezing nothing.
    const [{ int_value: commCap }] = await sql<{ int_value: number }[]>`
      select int_value from plan_entitlements
      where plan_key = 'community' and feature_key = 'competitions.max_active'`;
    expect(commCap, "community must cap active competitions below the 12 seeded here")
      .toBeLessThan(12);
    const { items } = await listCompetitions(auth, { cursor: null, limit: 50 });
    expect(items).toHaveLength(12);
    expect(items.filter((c) => c.frozen)).toHaveLength(12 - commCap);
    const byId = new Map(items.map((c) => [c.id, c]));
    expect(byId.get(compA.id)?.frozen).toBe(true);
    expect(byId.get(compB.id)?.frozen).toBe(false);
    expect(byId.get(compC.id)?.frozen).toBe(true);
    expect((await getCompetition(auth, compA.id)).frozen).toBe(true);

    // Frozen = read-only: no new structure, no renames…
    await expect(makeDivision(auth, compA.id, "generic", GENERIC_CONFIG)).rejects.toMatchObject({
      status: 402, featureKey: "competitions.max_active",
    });
    await expect(patchCompetition(auth, compA.id, { name: "Alpha 2" })).rejects.toMatchObject({
      status: 402, featureKey: "competitions.max_active",
    });

    // …but coarse scoring in the surviving competitions still works,
    await scoreEvent(auth, rigGeneric.fixtureId, {
      expected_seq: 1,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 1 },
    });
    // …and NEW fine events keep working too (W1: formerly asserted 402
    // `scoring.match_timeline` here — scoring detail is free on every plan
    // since R9, so a downgrade cannot take fine-grained recording away).
    const newCard = await scoreEvent(auth, rigFootball.fixtureId, {
      expected_seq: 1,
      type: "football.card",
      payload: { by: rigFootball.entrants[1].id, color: "yellow" },
    });
    expect(newCard.seq).toBe(2);

    // Retiring frozen competitions is the sanctioned way back under quota:
    // archiving every frozen one leaves the survivors inside the cap.
    for (const c of items.filter((x) => x.frozen)) {
      await patchCompetition(auth, c.id, { status: "archived" });
    }
    const after = await listCompetitions(auth, { cursor: null, limit: 50 });
    expect(after.items.every((c) => !c.frozen)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Event Pass (v3/07 §3): a one-time purchase upgrades ONE competition to the
// event_pass column of the matrix. Resolution: override → pass (community
// orgs only) → plan → deny; passed comps leave the active-comp quota.
// ---------------------------------------------------------------------------

async function grantPass(orgId: string, competitionId: string): Promise<void> {
  await sql`
    insert into competition_passes (competition_id, org_id)
    values (${competitionId}, ${orgId})
    on conflict (competition_id) do nothing`;
  await invalidateOrgEntitlements(orgId);
}

describe.skipIf(!HAS_DB)("event pass (v3/07 §3)", () => {
  it("lifts per-comp caps on the passed competition only", async () => {
    const { auth } = await seedOrg("community");
    const passed = await makeCompetition(auth, "Passed");
    await grantPass(auth.orgId, passed.id);

    // Passed comp: divisions cap is the pass's 10, not community's 4 (V319).
    for (let i = 0; i < 4; i++) await makeDivision(auth, passed.id, "generic", GENERIC_CONFIG);
    await expect(
      makeDivision(auth, passed.id, "generic", GENERIC_CONFIG), // 5th — beyond community
    ).resolves.toBeDefined();

    // A passed comp stops counting toward competitions.max_active, so the
    // free slot opens for a sibling…
    const sibling = await makeCompetition(auth, "Sibling");
    // …which stays on community caps: 5th division 402s (community cap is 4).
    for (let i = 0; i < 4; i++) await makeDivision(auth, sibling.id, "generic", GENERIC_CONFIG);
    await expect(
      makeDivision(auth, sibling.id, "generic", GENERIC_CONFIG),
    ).rejects.toMatchObject({ status: 402, featureKey: "divisions.per_competition.max" });
  });

  // V319 moved this rung: community 64, pass 128. The pass had to rise
  // with community — left at 64 it would have lifted nothing at all.
  it("entrants: 128 on the passed comp, 129th still 402s with the same key", async () => {
    const { auth } = await seedOrg("community");
    const comp = await makeCompetition(auth, "PE");
    await grantPass(auth.orgId, comp.id);
    const division = await makeDivision(auth, comp.id, "generic", GENERIC_CONFIG);
    await createEntrants(
      auth,
      division.id,
      Array.from({ length: 128 }, (_, i) => ({
        kind: "individual" as const, display_name: `E${i}`, seed: i + 1, members: [],
      })) as never,
    );
    await expect(
      createEntrants(auth, division.id, [
        { kind: "individual", display_name: "E129", seed: 129, members: [] },
      ] as never),
    ).rejects.toMatchObject({ status: 402, featureKey: "entrants.per_division.max" });
  });

  // W1 (entitlements v18, 2026-09-02): this used to prove the pass's own
  // fallthrough rule ("keys missing from the pass matrix fall through to the
  // community plan") with `football.card`/`scoring.match_timeline` as the
  // still-Pro-only example — that key is deleted (scoring detail is free on
  // every plan since R9), so it can no longer witness the rule.
  //
  // Fix round 1, M-3: a first swap landed on `cricket.dls`, which the wave
  // plan itself says W2 changes — a witness that would need moving again one
  // wave later, and would then share a single point of failure with
  // `scoring-dls-gate.test.ts` and the `MATRIX`'s own two `cricket.dls` rows.
  // Swapped again, to `api.access` — confirmed absent from BOTH `event_pass`
  // and `event_pass_l` (`plan_entitlements` query against the wave DB: zero
  // rows), and out of scope for this entire programme (no task in this wave
  // touches API keys), so this witness survives W2 untouched. `api.access`
  // is also already the MATRIX's own established Pro-only probe two rows
  // above (`case "api.access"`), so this reuses a pattern rather than
  // inventing a new one.
  it("unlocks advanced formats on the passed comp; Pro-only features stay Pro", async () => {
    const { auth } = await seedOrg("community");
    const comp = await makeCompetition(auth, "PF");
    await grantPass(auth.orgId, comp.id);
    const division = await makeDivision(auth, comp.id, "generic", GENERIC_CONFIG);
    await expect(
      createStages(auth, division.id, {
        seq: 1, kind: "double_elim", name: "DE", config: {},
      } as never),
    ).resolves.toBeDefined();

    // Keys missing from the pass matrix fall through to the community plan:
    // `api.access` remains a Pro upsell even on a passed comp.
    await expect(
      createApiKey(auth, { name: "k", scopes: ["read"] }),
    ).rejects.toMatchObject({ status: 402, featureKey: "api.access" });
  });

  it("is moot under Pro and revives after a downgrade", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await makeCompetition(auth, "PM");
    await grantPass(auth.orgId, comp.id);
    // Pro's matrix wins while the plan is paid…
    expect(await getLimit(auth.orgId, "entrants.per_division.max", comp.id)).toBe(256);
    // …and the pass takes back over when the org drops to community.
    await setPlan(auth.orgId, "community");
    expect(await getLimit(auth.orgId, "entrants.per_division.max", comp.id)).toBe(128);
  });

  it("org override beats the pass", async () => {
    const { auth } = await seedOrg("community");
    const comp = await makeCompetition(auth, "PO");
    await grantPass(auth.orgId, comp.id);
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
      values (${auth.orgId}, 'entrants.per_division.max', 40, 'test')`;
    await invalidateOrgEntitlements(auth.orgId);
    expect(await getLimit(auth.orgId, "entrants.per_division.max", comp.id)).toBe(40);
  });

  it("purchase invalidates the cached community value", async () => {
    const { auth } = await seedOrg("community");
    const comp = await makeCompetition(auth, "PC");
    // Prime the comp-scoped cache with the community value…
    expect(await getLimit(auth.orgId, "entrants.per_division.max", comp.id)).toBe(64);
    // …then grantPass (insert + invalidate) must surface the pass value.
    await grantPass(auth.orgId, comp.id);
    expect(await getLimit(auth.orgId, "entrants.per_division.max", comp.id)).toBe(128);
  });

  // V310 fee ladder (D20): community 8 → pass 5 → pro 2 → pro plus 1. The
  // community leg is the one that matters. It used to have no row and fell back
  // to platformFeeDefault() (5), which is EXACTLY the pass rate — so the pass
  // discounted nothing. The assertion below is deliberately written against the
  // literal 8 AND against platformFeeDefault(), because a regression that drops
  // the community row reintroduces the fallback silently.
  it("fee percent ladder: community 8%, pass comps 5%, pro orgs 2%", async () => {
    const { auth } = await seedOrg("community");
    const comp = await makeCompetition(auth, "Fee");
    expect(await feePercentFor(auth.orgId, comp.id)).toBe(8);
    expect(await feePercentFor(auth.orgId, comp.id)).not.toBe(await platformFeeDefault());
    // Org-level too — the community rate is not competition-scoped.
    expect(await feePercentFor(auth.orgId)).toBe(8);
    await grantPass(auth.orgId, comp.id);
    expect(await feePercentFor(auth.orgId, comp.id)).toBe(5);
    await setPlan(auth.orgId, "pro");
    expect(await feePercentFor(auth.orgId, comp.id)).toBe(2);
  });

  it("passed competitions never freeze", async () => {
    const { auth } = await seedOrg("community");
    const old = await makeCompetition(auth, "Old passed");
    await grantPass(auth.orgId, old.id);
    await sql`update competitions set created_at = now() - interval '2 hours' where id = ${old.id}`;
    const fresh = await makeCompetition(auth, "Fresh free");
    const { items } = await listCompetitions(auth, { cursor: null, limit: 50 });
    const byId = new Map(items.map((c) => [c.id, c]));
    // Without the pass exemption the older comp would freeze (cap 1).
    expect(byId.get(old.id)?.frozen).toBe(false);
    expect(byId.get(fresh.id)?.frozen).toBe(false);
  });
});
