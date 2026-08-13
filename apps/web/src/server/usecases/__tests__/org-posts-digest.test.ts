// P3 (D7) — the weekly digest usecase (generateWeeklyDigest, the console
// button's callee, and sweepWeeklyDigests, the stg cron sweep's callee).
// DB-backed; skipped without DATABASE_URL. Sibling of org-posts.test.ts
// (auto-drafts) — this file is scoped to the NEW digest kind specifically,
// matching this repo's convention of splitting a large usecase's tests
// across several files once one feature within it grows its own fixture
// shape (e.g. competition-schedule-*.test.ts for schedule-ai.ts).
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { generateWeeklyDigest, sweepWeeklyDigests, listPosts } from "../org-posts";
import { scoreEvent } from "../scoring";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";

const HAS_DB = !!process.env.DATABASE_URL;

const badminton = builtinModules.find((m) => m.key === "badminton")!;
const BADMINTON_CFG = badminton.configSchema.parse({});

interface Ctx {
  auth: AuthCtx;
  orgId: string;
  userId: string;
}

async function seedOrg(plan: "pro" | "community" = "pro", timezone: string | null = "UTC"): Promise<Ctx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`digest-${suffix}@test.local`}, 'Digest', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, default_locale, timezone)
    values (${"Digest " + suffix}, ${"digest-" + suffix}, ${userId}, 'en', ${timezone})
    returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  if (plan === "pro") await setOrgPlan(orgId);
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('badminton', 'Badminton', ${badminton.version}, ${sql.json(badminton.positions as never)})
    on conflict (key) do nothing`;
  return { auth: { orgId, via: "session", userId, role: "owner", keyId: null }, orgId, userId };
}

interface DivCtx {
  compId: string;
  divisionId: string;
  stageId: string;
  entrantA: string;
  entrantB: string;
}

async function seedDivision(ctx: Ctx): Promise<DivCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, created_by)
    values (${ctx.orgId}, 'Cup', ${"cup-" + suffix}, 'public', ${ctx.userId}) returning id`;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, org_id, name, slug, sport_key, variant_key, config, module_version)
    values (${compId}, ${ctx.orgId}, 'Singles', ${"singles-" + suffix}, 'badminton', 'default',
      ${sql.json(BADMINTON_CFG as never)}, ${badminton.version})
    returning id`;
  await sql`update divisions set status = 'active' where id = ${divisionId}`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, org_id, seq, kind, name)
    values (${divisionId}, ${ctx.orgId}, 1, 'league', 'League') returning id`;
  const [{ id: entrantA }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, org_id, kind, display_name, seed)
    values (${divisionId}, ${ctx.orgId}, 'individual', 'Riverside', 1) returning id`;
  const [{ id: entrantB }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, org_id, kind, display_name, seed)
    values (${divisionId}, ${ctx.orgId}, 'individual', 'Northside', 2) returning id`;
  return { compId, divisionId, stageId, entrantA, entrantB };
}

/** Real score_events via the live scoring path (not a raw-SQL fake) so
 *  recomputePlayerStats has genuine ledger data to fold — a directly-seeded
 *  player_stat_snapshots row would be wiped by the very first recompute,
 *  since it deletes-then-reinserts for the division. Returns the fixture id. */
async function decideWithRally(ctx: Ctx, div: DivCtx, winner: string, loser: string): Promise<string> {
  const [{ id: fx }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round,
      home_entrant_id, away_entrant_id, status)
    values (${div.stageId}, ${div.divisionId}, ${ctx.orgId}, 1, 1, ${winner}, ${loser}, 'scheduled')
    returning id`;
  await scoreEvent(ctx.auth, fx, { expected_seq: 0, type: "core.start", payload: {} });
  await scoreEvent(ctx.auth, fx, { expected_seq: 1, type: "badminton.rally", payload: { wonBy: winner } });
  await scoreEvent(ctx.auth, fx, {
    expected_seq: 2,
    type: "core.forfeit",
    payload: { by: loser, reason: "walkover" },
  });
  return fx;
}

describe.skipIf(!HAS_DB)("weekly digest (P3 / D7)", () => {
  it("generateWeeklyDigest creates a weekly_digest draft with standings, leaders, and upcoming sections", async () => {
    const ctx = await seedOrg("pro");
    const div = await seedDivision(ctx);
    const claimedPersonId = randomUUID();
    // A CLAIMED person (persons.user_id not null) who plays and wins, so the
    // claimed-player highlight has a real candidate.
    const [{ id: playerUserId }] = await sql<{ id: string }[]>`
      insert into users (id, email, display_name, email_verified)
      values (${claimedPersonId}, ${`player-${claimedPersonId}@test.local`}, 'Player', true)
      returning id`;
    const [{ id: personId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, user_id) values (${ctx.orgId}, 'Riverside Player', ${playerUserId})
      returning id`;
    await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${div.entrantA}, ${personId}, ${ctx.orgId})`;

    await decideWithRally(ctx, div, div.entrantA, div.entrantB);

    // Standings movement source: a real snapshot with SOME history to diff
    // (seeded directly — recomputeStandings is a different call path this
    // test does not need to exercise; org-posts.test.ts's own round-recap
    // test already seeds standings_snapshots this same way).
    await sql`
      insert into standings_snapshots (stage_id, org_id, pool_id, rows, previous_rows, computed_through_seq)
      values (${div.stageId}, ${ctx.orgId}, null,
        ${sql.json([
          { entrantId: div.entrantA, played: 1, won: 1, drawn: 0, lost: 0, points: 3, metrics: {}, rank: 1 },
          { entrantId: div.entrantB, played: 1, won: 0, drawn: 0, lost: 1, points: 0, metrics: {}, rank: 2 },
        ])},
        ${sql.json([
          { entrantId: div.entrantA, played: 0, won: 0, drawn: 0, lost: 0, points: 0, metrics: {}, rank: 2 },
          { entrantId: div.entrantB, played: 0, won: 0, drawn: 0, lost: 0, points: 0, metrics: {}, rank: 1 },
        ])},
        1)`;

    // An upcoming fixture in the next 7 days.
    await sql`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round,
        home_entrant_id, away_entrant_id, status, scheduled_at)
      values (${div.stageId}, ${div.divisionId}, ${ctx.orgId}, 2, 1,
        ${div.entrantA}, ${div.entrantB}, 'scheduled', now() + interval '2 days')`;

    const post = await generateWeeklyDigest(ctx.auth, ctx.orgId);
    expect(post.kind).toBe("weekly_digest");
    expect(post.status).toBe("draft");
    expect(post.title).toContain("Digest ");
    expect(post.bodyMd).toContain("Standings movement");
    expect(post.bodyMd).toContain("Riverside");
    expect(post.bodyMd).toContain("Biggest climber");
    expect(post.bodyMd).toContain("Stat leaders");
    expect(post.bodyMd).toContain("Next 7 days");
    expect(post.bodyMd).toContain("Northside");
    expect(post.bodyMd).toContain("Your player of the week");
    expect(post.bodyMd).not.toContain("undefined");

    const listed = await listPosts(ctx.auth, ctx.orgId);
    expect(listed.filter((p) => p.kind === "weekly_digest")).toHaveLength(1);
  });

  it("requires news.auto — 402s on a community org", async () => {
    const ctx = await seedOrg("community");
    await expect(generateWeeklyDigest(ctx.auth, ctx.orgId)).rejects.toMatchObject({ status: 402 });
  });

  it("two consecutive presses create two independent, non-deduped drafts", async () => {
    const ctx = await seedOrg("pro");
    const first = await generateWeeklyDigest(ctx.auth, ctx.orgId);
    const second = await generateWeeklyDigest(ctx.auth, ctx.orgId);
    expect(first.id).not.toBe(second.id);
    const digests = (await listPosts(ctx.auth, ctx.orgId)).filter((p) => p.kind === "weekly_digest");
    expect(digests).toHaveLength(2);
  });

  it("an org with no activity at all still gets a (near-empty) draft from the button — 'a missing draft is a defect'", async () => {
    const ctx = await seedOrg("pro");
    const post = await generateWeeklyDigest(ctx.auth, ctx.orgId);
    expect(post.kind).toBe("weekly_digest");
    expect(post.bodyMd).not.toContain("undefined");
  });

  it("sweepWeeklyDigests: creates for an active Pro org, skips a community org, skips a Pro org with nothing to report", async () => {
    const active = await seedOrg("pro");
    const activeDiv = await seedDivision(active);
    await decideWithRally(active, activeDiv, activeDiv.entrantA, activeDiv.entrantB);

    const community = await seedOrg("community");
    const idleActivePro = await seedOrg("pro"); // Pro, but zero activity this week

    const result = await sweepWeeklyDigests();
    // Loose on the totals — this sweep is unscoped by design (every org in
    // the shared test DB) and this file is not the only one that creates
    // orgs, so only >=1 is safe to assert on the aggregate.
    expect(result.orgsChecked).toBeGreaterThanOrEqual(3);
    expect(result.digestsCreated).toBeGreaterThanOrEqual(1);

    const activeDigests = (await listPosts(active.auth, active.orgId)).filter((p) => p.kind === "weekly_digest");
    const communityDigests = (await listPosts(community.auth, community.orgId)).filter(
      (p) => p.kind === "weekly_digest",
    );
    const idleDigests = (await listPosts(idleActivePro.auth, idleActivePro.orgId)).filter(
      (p) => p.kind === "weekly_digest",
    );
    expect(activeDigests).toHaveLength(1); // entitled + active -> created
    expect(communityDigests).toHaveLength(0); // not entitled -> skipped
    expect(idleDigests).toHaveLength(0); // entitled but nothing to report -> skipped (cron only)
  });

  it("digest window respects a non-UTC org timezone without throwing", async () => {
    const ctx = await seedOrg("pro", "Pacific/Auckland");
    const post = await generateWeeklyDigest(ctx.auth, ctx.orgId);
    expect(post.kind).toBe("weekly_digest");
  });
});
