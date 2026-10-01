// P3 (D7) — the weekly digest usecase (generateWeeklyDigest, the console
// button's callee, and sweepWeeklyDigests, the stg cron sweep's callee).
// DB-backed; skipped without DATABASE_URL. Sibling of org-posts.test.ts
// (auto-drafts) — this file is scoped to the NEW digest kind specifically,
// matching this repo's convention of splitting a large usecase's tests
// across several files once one feature within it grows its own fixture
// shape (e.g. competition-schedule-*.test.ts for schedule-ai.ts).
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { isoWeekKeyUtc } from "@/server/news/enrichment";
import { log } from "@/server/logger";
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

/**
 * A competition of its own, with ONE upcoming fixture inside the digest's
 * next-7-days window and uniquely-named entrants. Enough on its own to make
 * `digestForOrg` produce an enriched post, and the entrant names are what a
 * scoped digest either does or does not print — so a competition the org may
 * not auto-publish about is visible in the body or it is not, with no
 * standings/stats machinery in between.
 */
async function seedUpcomingCompetition(
  ctx: Ctx,
  label: string,
): Promise<{ compId: string; homeName: string; awayName: string }> {
  const suffix = randomUUID().slice(0, 8);
  const homeName = `${label} Home ${suffix}`;
  const awayName = `${label} Away ${suffix}`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, created_by)
    values (${ctx.orgId}, ${label}, ${"cup-" + suffix}, 'public', ${ctx.userId}) returning id`;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, org_id, name, slug, sport_key, variant_key, config, module_version)
    values (${compId}, ${ctx.orgId}, ${label + " Singles"}, ${"singles-" + suffix}, 'badminton', 'default',
      ${sql.json(BADMINTON_CFG as never)}, ${badminton.version})
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, org_id, seq, kind, name)
    values (${divisionId}, ${ctx.orgId}, 1, 'league', 'League') returning id`;
  const [{ id: home }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, org_id, kind, display_name, seed)
    values (${divisionId}, ${ctx.orgId}, 'individual', ${homeName}, 1) returning id`;
  const [{ id: away }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, org_id, kind, display_name, seed)
    values (${divisionId}, ${ctx.orgId}, 'individual', ${awayName}, 2) returning id`;
  await sql`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round,
      home_entrant_id, away_entrant_id, status, scheduled_at)
    values (${stageId}, ${divisionId}, ${ctx.orgId}, 1, 1, ${home}, ${away}, 'scheduled',
            now() + interval '2 days')`;
  return { compId, homeName, awayName };
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

    // Standings movement source: `decideWithRally`'s real scoring pipeline
    // already ran recomputeStandings (onDecided), which inserted THIS
    // stage's snapshot row — overwrite it with a `previous_rows` value the
    // real write path would not have produced on a single decided fixture,
    // so biggestClimber has a genuine delta to find.
    await sql`
      update standings_snapshots set
        rows = ${sql.json([
          { entrantId: div.entrantA, played: 1, won: 1, drawn: 0, lost: 0, points: 3, metrics: {}, rank: 1 },
          { entrantId: div.entrantB, played: 1, won: 0, drawn: 0, lost: 1, points: 0, metrics: {}, rank: 2 },
        ])},
        previous_rows = ${sql.json([
          { entrantId: div.entrantA, played: 0, won: 0, drawn: 0, lost: 0, points: 0, metrics: {}, rank: 2 },
          { entrantId: div.entrantB, played: 0, won: 0, drawn: 0, lost: 0, points: 0, metrics: {}, rank: 1 },
        ])}
      where stage_id = ${div.stageId} and pool_id is null`;

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

  it("requires news.auto — 402s when the org is denied the key", async () => {
    // A DENY override beats both the plan and a pass (`resolve`'s precedence),
    // so it is the lever that proves the door shuts for a PRO org, which no
    // plan row can do. Same 402, same key, whether the refusal comes from the
    // override or (since V396) from a plain Free org's empty scope.
    const ctx = await seedOrg("pro");
    // The org must OWN a competition for a refusal to be possible: the door is
    // "you may auto-publish about none of your competitions", and an org with
    // none has nothing to be refused about (see `newsAutoCompetitionScope`).
    await seedUpcomingCompetition(ctx, "Denied Cup");
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
      values (${ctx.orgId}, 'news.auto', false, 'test')`;
    await invalidateOrgEntitlements(ctx.orgId);
    await expect(generateWeeklyDigest(ctx.auth, ctx.orgId)).rejects.toMatchObject({ status: 402 });
  });

  it("402s a plain community org — V396 made news.auto paid again", async () => {
    // V393 freed the key and this case asserted a digest; V396 (entitlements
    // v18 W2 T15, owner ruling 2026-09-03) re-gated it. The refusal now comes
    // from `newsAutoCompetitionScope` resolving to an EMPTY set rather than
    // from a bare `requireFeature`, which is what lets the pass case below
    // succeed on the same plan.
    const ctx = await seedOrg("community");
    await seedUpcomingCompetition(ctx, "Free Cup");
    await expect(generateWeeklyDigest(ctx.auth, ctx.orgId)).rejects.toMatchObject({
      status: 402,
      featureKey: "news.auto",
    });
  });

  it("402s a community org that owns NO competitions at all — total === 0 was a hole", async () => {
    // T20 finding 1 (reviewer pass 3, 2026-09-03). The button guard read
    // `scope.total > 0 && scope.allowed.length === 0`, so an org with nothing
    // at all skipped the refusal and minted a `weekly_digest` on Free. A
    // comment five lines above the sweep's own check claimed the two "cannot
    // answer differently"; they did, in exactly this case.
    //
    // The paired over-refusal guard is "an org with no activity at all still
    // gets a draft from the button" below: that org is PRO with zero
    // competitions, so a fix that simply refuses on an empty `allowed` set
    // would show a paywall to someone who has already paid. With no
    // competitions there can be no pass either (a pass is FK'd to a
    // competition row), so the plan answer is the whole answer here.
    const ctx = await seedOrg("community");
    await expect(generateWeeklyDigest(ctx.auth, ctx.orgId)).rejects.toMatchObject({
      status: 402,
      featureKey: "news.auto",
    });
  });

  it("a community org holding an Event Pass gets a digest, scoped to that competition", async () => {
    // The digest is an ORG-level artefact and a pass buys ONE competition, so
    // the entitlement question is a SET, not a boolean. Both halves are pinned:
    // the passed competition appears, and a second competition in the same org
    // — which the org is NOT entitled to auto-publish about — does not.
    const ctx = await seedOrg("community");
    const passed = await seedUpcomingCompetition(ctx, "Passed Cup");
    const unpassed = await seedUpcomingCompetition(ctx, "Unpassed Cup");
    await sql`
      insert into competition_passes (competition_id, org_id, pass_key)
      values (${passed.compId}, ${ctx.orgId}, 'event_pass')`;
    await invalidateOrgEntitlements(ctx.orgId);
    const post = await generateWeeklyDigest(ctx.auth, ctx.orgId);
    expect(post.kind).toBe("weekly_digest");
    expect(post.bodyMd).toContain(passed.homeName);
    expect(post.bodyMd).not.toContain(unpassed.homeName);
  });

  it("two consecutive presses create two independent, non-deduped drafts", async () => {
    const ctx = await seedOrg("pro");
    const first = await generateWeeklyDigest(ctx.auth, ctx.orgId);
    const second = await generateWeeklyDigest(ctx.auth, ctx.orgId);
    expect(first.id).not.toBe(second.id);
    const digests = (await listPosts(ctx.auth, ctx.orgId)).filter((p) => p.kind === "weekly_digest");
    expect(digests).toHaveLength(2);
  });

  it("an org with no activity at all still gets a draft from the button, and it SAYS so instead of being blank", async () => {
    const ctx = await seedOrg("pro");
    const post = await generateWeeklyDigest(ctx.auth, ctx.orgId);
    expect(post.kind).toBe("weekly_digest");
    expect(post.bodyMd).not.toContain("undefined");
    // Was `bodyMd: ""` — a title with a completely blank body, which reads
    // as a broken button rather than as a quiet week. "a missing DRAFT is a
    // defect" is a rule about whether the draft EXISTS; it never licensed a
    // blank one.
    expect(post.bodyMd.trim().length).toBeGreaterThan(0);
    expect(post.bodyMd).toContain("to report this week");
  });

  it("one malformed standings row drops ONLY the standings section, not the whole digest", async () => {
    // The regression this exists for: the four digest sources are each
    // wrapped in their own try/catch, which looks like isolation and is not.
    // A REJECTED statement aborts the entire Postgres transaction, and a JS
    // catch cannot undo that — so before the savepoint went onto
    // assembleDigestStandings, one bad row here poisoned the transaction and
    // the next three sources all died on their own first query, were caught
    // by their own catch, and were dropped. The organiser got an empty draft
    // and no error; the only evidence was four log lines.
    //
    // `standings_snapshots.rows` is jsonb and nothing validates the
    // `entrantId` inside it, so a non-uuid there is a real reachable state,
    // not a contrived one: `where id = any(...)` rejects it with
    // `invalid input syntax for type uuid`.
    const ctx = await seedOrg("pro");
    const div = await seedDivision(ctx);
    // Same seeding the happy-path test above uses — a claimed person on
    // entrantA and an upcoming fixture — so the OTHER three sources have
    // genuine content. Without it they are legitimately empty and the test
    // passes for the wrong reason, which is exactly what the first draft of
    // this test did.
    const [{ id: playerUserId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`cascade-${randomUUID().slice(0, 8)}@test.local`}, 'Player', true) returning id`;
    const [{ id: personId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, user_id)
      values (${ctx.orgId}, 'Riverside Player', ${playerUserId}) returning id`;
    await sql`
      insert into entrant_members (entrant_id, person_id, org_id)
      values (${div.entrantA}, ${personId}, ${ctx.orgId})`;
    await decideWithRally(ctx, div, div.entrantA, div.entrantB);
    await sql`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round,
        home_entrant_id, away_entrant_id, status, scheduled_at)
      values (${div.stageId}, ${div.divisionId}, ${ctx.orgId}, 2, 1,
        ${div.entrantA}, ${div.entrantB}, 'scheduled', now() + interval '2 days')`;

    // Corrupt the snapshot the scoring path already wrote, rather than
    // inserting one: that is the reachable state (a stored row going bad),
    // and it avoids guessing at computed_through_seq / pool_scope defaults.
    const updated = await sql`
      update standings_snapshots
         set rows = ${sql.json([{ entrantId: "not-a-uuid", rank: 1, points: 3 }] as never)}
       where stage_id = ${div.stageId} and pool_id is null
      returning stage_id`;
    // Guard the premise: with no snapshot to corrupt there is no standings
    // source to poison, and the whole test would pass vacuously.
    expect(updated).toHaveLength(1);

    const post = await generateWeeklyDigest(ctx.auth, ctx.orgId);

    // The poisoned source is gone...
    expect(post.bodyMd).not.toContain("Standings movement");
    // ...and the survivors are still there. Before the fix this was the
    // empty-digest body instead, which is precisely the symptom that is
    // invisible from the UI.
    expect(post.bodyMd).toContain("Stat leaders");
    expect(post.bodyMd).not.toContain("to report this week");
  });

  it("sweepWeeklyDigests: creates for an active Pro org, skips a community org, skips a Pro org with nothing to report", async () => {
    const active = await seedOrg("pro");
    const activeDiv = await seedDivision(active);
    await decideWithRally(active, activeDiv, activeDiv.entrantA, activeDiv.entrantB);

    const community = await seedOrg("community");
    const idleActivePro = await seedOrg("pro"); // Pro, but zero activity this week

    const result = await sweepWeeklyDigests();
    // Loose on the totals — this file is not the only one creating orgs in the
    // shared test DB, so only lower bounds are safe on the aggregates.
    expect(result.orgsTotal).toBeGreaterThanOrEqual(3);
    expect(result.digestsCreated).toBeGreaterThanOrEqual(1);

    // Regression guard against the sweep going back to scanning every org.
    // It used to `select id from organizations` and do an entitlement
    // round-trip plus a tenant transaction per row, which stopped finishing
    // altogether once the DB held a few thousand orgs — this test failed on a
    // 30s timeout, not an assertion. `community` and `idleActivePro` are
    // seeded with no fixtures whatsoever, so neither can ever be a candidate;
    // the narrowed set is therefore at least two smaller than the full count,
    // always. A revert to the full scan makes these equal and reds here.
    expect(result.orgsChecked).toBeLessThanOrEqual(result.orgsTotal - 2);

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

  it("sweepWeeklyDigests: at most ONE cron digest per org per ISO week; console presses stay unlimited", async () => {
    // single-sport: badminton via seedDivision; the guard keys on org and ISO week, never on sport.
    const org = await seedOrg("pro");
    const div = await seedDivision(org);
    await decideWithRally(org, div, div.entrantA, div.entrantB);
    const now = Date.now();
    const digests = async () => (await listPosts(org.auth, org.orgId)).filter((p) => p.kind === "weekly_digest");

    // 1. First cron firing drafts one, stamped with this ISO week. The expected
    // key comes from isoWeekKeyUtc, which is code under test (TEST-STRATEGY
    // rule 3). That is accepted here because iso-week.test.ts pins it to
    // ISO-8601 facts, and pre-flight checked it against an independent oracle
    // (7/7 cases; a 52,598-point sweep over 1999-2040 with 0 differences).
    await sweepWeeklyDigests(now);
    const first = await digests();
    expect(first).toHaveLength(1);
    expect(first[0]!.autoSource).toMatchObject({ trigger: "weekly_digest", origin: "cron", cron_week: isoWeekKeyUtc(now) });

    // 2. A double fire / retry in the same week drafts nothing more, and is a
    // quiet no-op for this org rather than a swallowed failure (m4: the
    // per-org catch would hide a throw behind the same count of 1).
    const warn = vi.spyOn(log, "warn");
    try {
      await sweepWeeklyDigests(now);
      expect(await digests()).toHaveLength(1);
      expect(warn.mock.calls.filter(([o]) => (o as { orgId?: string } | undefined)?.orgId === org.orgId)).toEqual([]);
    } finally {
      warn.mockRestore();
    }

    // 3. The console button is untouched by the guard (P3/D7): still a fresh draft.
    const pressed = await generateWeeklyDigest(org.auth, org.orgId);
    expect(pressed.autoSource).not.toHaveProperty("cron_week");
    expect(await digests()).toHaveLength(2);

    // 4. A later week is a new identity: age the cron row, sweep again, one more draft.
    await sql`
      update org_posts set auto_source = jsonb_set(auto_source, '{cron_week}', '"2000-W01"')
      where org_id = ${org.orgId} and auto_source ? 'cron_week'`;
    await sweepWeeklyDigests(now);
    expect(await digests()).toHaveLength(3);
  });

  it("digest window respects a non-UTC org timezone without throwing", async () => {
    const ctx = await seedOrg("pro", "Pacific/Auckland");
    const post = await generateWeeklyDigest(ctx.auth, ctx.orgId);
    expect(post.kind).toBe("weekly_digest");
  });
});
