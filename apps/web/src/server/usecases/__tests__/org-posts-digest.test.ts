// P3 (D7) — the weekly digest usecase (generateWeeklyDigest, the console
// button's callee, and sweepWeeklyDigests, the stg cron sweep's callee).
// DB-backed; skipped without DATABASE_URL. Sibling of org-posts.test.ts
// (auto-drafts) — this file is scoped to the NEW digest kind specifically,
// matching this repo's convention of splitting a large usecase's tests
// across several files once one feature within it grows its own fixture
// shape (e.g. competition-schedule-*.test.ts for schedule-ai/).
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { builtinModules } from "@seazn/engine/sports";
import { isLevelTable, type StandingsRow } from "@seazn/engine/competition";
import { sql, withTenant } from "@/lib/db";
import { isoWeekKeyUtc } from "@/server/news/enrichment";
import { log } from "@/server/logger";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  assembleDigestStandings,
  assembleRecapEnrichment,
  type FixtureCtx,
  digestCandidateOrgIds,
  draftPostsForDecidedFixture,
  generateWeeklyDigest,
  newsAutoCompetitionScope,
  sweepWeeklyDigests,
  listPosts,
} from "../org-posts";
import { scoreEvent } from "../scoring";
import { startDivision } from "../schedule";
import { withdrawEntrantCascade } from "../withdrawal";
import { createEntrants, patchEntrant } from "../entrants";
import { playBadminton, post } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { playToDecided } from "./_quick-match-probe";
import { BADMINTON, FOOTBALL, rig, type Rig, type SportPick } from "./_w5-t3-rig";
import { levelLeague } from "@/server/engine-db/__tests__/helpers/stored-table-rows";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { systemAuth } from "@/lib/quick-match-auth";
import { QUICK_MATCH_SYSTEM_ORG_ID, QUICK_MATCH_SYSTEM_USER_ID } from "@/lib/quick-match-constants";

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

/** `made` receives the competition id straight after its insert, so a caller's cleanup still finds it when a later
 *  insert throws. */
async function seedDivision(
  ctx: Ctx,
  opts: { visibility?: "public" | "private"; made?: string[] } = {},
): Promise<DivCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, created_by)
    values (${ctx.orgId}, 'Cup', ${"cup-" + suffix}, ${opts.visibility ?? "public"}, ${ctx.userId}) returning id`;
  opts.made?.push(compId);
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
  // W2b core (64c1a2881): a walkover is refused once something is played (ruling 112 keeps it only while nothing is);
  // a side that quits after the rally above retires.
  await scoreEvent(ctx.auth, fx, {
    expected_seq: 2,
    type: "core.forfeit",
    payload: { by: loser, reason: "retired" },
  });
  return fx;
}

const DAY_MS = 86_400_000;

/**
 * The earliest instant `freeSweepAnchor` will return. Far past any wall clock
 * a suite runs at, so a fresh database always lands here.
 */
const SWEEP_ANCHOR_FLOOR_MS = Date.UTC(2099, 5, 10, 12);

/**
 * A `sweepWeeklyDigests(nowMs)` instant that NO other row in the database can
 * reach, so the sweep's candidate set is exactly the rows this test writes.
 *
 * Why this exists: the sweep pre-filters to orgs with decided activity in
 * `[now - 8d, now + 1d)` or an upcoming fixture in `[now, now + 8d)`, then does
 * an entitlement round-trip and a tenant transaction PER candidate. At the real
 * `Date.now()` that set is every org any suite in the shard decided a match for
 * minutes ago — the W3 Swiss suites alone take it from 7 to ~625 on a
 * 29-file load — so the test's runtime scaled with other suites' rows and a
 * three-sweep test blew its 30s budget (CI "Smoke — usecases [i-z]", twice).
 *
 * The anchor is the later of the fixed floor and 30 days past the latest
 * `match_states.updated_at` / `fixtures.scheduled_at` in the database: 30 days
 * clears the sweep's 8-day reach in both directions with room to spare. A fixed
 * instant alone would be wrong on a REUSED database — the previous run's org
 * still sits at it, so the candidate set would grow by one per run.
 */
async function freeSweepAnchor(): Promise<number> {
  const [row] = await sql<{ latest: Date | null }[]>`
    select greatest(
      (select max(updated_at) from match_states),
      (select max(scheduled_at) from fixtures)) as latest`;
  const anchor = Math.max(SWEEP_ANCHOR_FLOOR_MS, (row?.latest?.getTime() ?? 0) + 30 * DAY_MS);
  // "Cannot happen" as a guard, not a comment: a runaway row would push the
  // anchor past what an ISO string / timestamptz round-trips.
  expect(new Date(anchor).getUTCFullYear()).toBeLessThan(9000);
  return anchor;
}

/**
 * Re-date the fold timestamp of the (single) decided fixture `decideWithRally`
 * left in `orgId`. `match_states.updated_at` is the one column both the sweep's
 * candidate filter and `digestForOrg`'s window read for a decided fixture, so
 * moving it puts the org's activity inside the anchor's week and nowhere else.
 */
async function moveDecidedActivityTo(orgId: string, atMs: number): Promise<void> {
  const moved = await sql`
    update match_states set updated_at = ${new Date(atMs)} where org_id = ${orgId} returning fixture_id`;
  expect(moved).toHaveLength(1);
}

/**
 * Activity for each arm of the sweep's candidate query, in a division of its own in `ctx`'s org, at `anchor`:
 * `decided` is a match scored through the real scoring path whose fold is re-dated a day before the anchor (the
 * first arm reads `match_states.updated_at`); `upcoming` is a fixture scheduled two days after it (the second arm
 * reads `fixtures.scheduled_at`). Re-dated by FIXTURE id, never by org: the quick-match system org is shared with
 * every other suite's quick matches. The competition is pushed onto `made` as soon as it is inserted, so a caller in
 * the shared system org can delete it even when a later step throws. `visibility` is the competition's: real quick
 * matches are private (C7).
 */
async function seedSweepActivity(
  ctx: Ctx,
  anchor: number,
  arms: { decided: boolean; upcoming: boolean },
  opts: { visibility?: "public" | "private"; made?: string[] } = {},
): Promise<void> {
  const div = await seedDivision(ctx, opts);
  if (arms.decided) {
    const fx = await decideWithRally(ctx, div, div.entrantA, div.entrantB);
    const moved = await sql`
      update match_states set updated_at = ${new Date(anchor - DAY_MS)} where fixture_id = ${fx} returning fixture_id`;
    expect(moved).toHaveLength(1);
  }
  if (arms.upcoming) {
    await sql`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round,
        home_entrant_id, away_entrant_id, status, scheduled_at)
      values (${div.stageId}, ${div.divisionId}, ${ctx.orgId}, 2, 1, ${div.entrantA}, ${div.entrantB}, 'scheduled',
              ${new Date(anchor + 2 * DAY_MS)})`;
  }
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

    // Swept at an instant of its own (see freeSweepAnchor): at the real "now"
    // the candidate set is every org any other suite decided a match for, and
    // this call walks them all.
    const anchor = await freeSweepAnchor();
    await moveDecidedActivityTo(active.orgId, anchor - DAY_MS);

    const result = await sweepWeeklyDigests(anchor);
    // Loose on the totals — this file is not the only one creating orgs in the
    // shared test DB, so only lower bounds are safe on the aggregates.
    expect(result.orgsTotal).toBeGreaterThanOrEqual(3);
    // Anti-vacuity: at the anchor the candidate set is exactly `active`, and
    // it yielded its one digest — so the sweep checked something, and that
    // something is this test's org (only a candidate is ever digested).
    expect(result.orgsChecked).toBe(1);
    expect(result.digestsCreated).toBe(1);

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
    // Every sweep below runs at an instant of this test's own (see
    // freeSweepAnchor), with this org's one decided fixture dated a day before
    // it. At the real "now" the sweep walks every org any other suite decided a
    // match for — three walks over a shard-loaded database blew the 30s budget.
    const now = await freeSweepAnchor();
    await moveDecidedActivityTo(org.orgId, now - DAY_MS);
    const digests = async () => (await listPosts(org.auth, org.orgId)).filter((p) => p.kind === "weekly_digest");

    // 1. First cron firing drafts one, stamped with this ISO week. The expected
    // key comes from isoWeekKeyUtc, which is code under test (TEST-STRATEGY
    // rule 3). That is accepted here because iso-week.test.ts pins it to
    // ISO-8601 facts, and pre-flight checked it against an independent oracle
    // (7/7 cases; a 52,598-point sweep over 1999-2040 with 0 differences).
    //
    // Anti-vacuity: the sweep digests only a candidate, so this org's draft
    // existing proves it was among the orgs checked; `orgsChecked` of exactly 1
    // proves it was the ONLY one — the candidate set no longer depends on what
    // any other suite wrote. Without this, a sweep that checked nothing (or a
    // whole shard's worth) would read the same as a pass.
    const firstSweep = await sweepWeeklyDigests(now);
    expect(firstSweep).toMatchObject({ orgsChecked: 1, digestsCreated: 1 });
    const first = await digests();
    expect(first).toHaveLength(1);
    expect(first[0]!.autoSource).toMatchObject({ trigger: "weekly_digest", origin: "cron", cron_week: isoWeekKeyUtc(now) });

    // 2. A double fire / retry in the same week drafts nothing more, and is a
    // quiet no-op for this org rather than a swallowed failure (m4: the
    // per-org catch would hide a throw behind the same count of 1).
    const warn = vi.spyOn(log, "warn");
    try {
      // Still checked (orgsChecked 1: this org IS a candidate again) and still
      // quiet (digestsCreated 0), so the no-op is the once-per-week guard
      // answering, not the org dropping out of the candidate set.
      expect(await sweepWeeklyDigests(now)).toMatchObject({ orgsChecked: 1, digestsCreated: 0 });
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
    expect(await sweepWeeklyDigests(now)).toMatchObject({ orgsChecked: 1, digestsCreated: 1 });
    expect(await digests()).toHaveLength(3);
  });

  it("the quick-match system org is never a digest candidate, even with news.auto ON; a control org with the same activity is one", async () => {
    // single-sport: badminton via seedDivision; the exclusion keys on the org id, never on sport.
    // Quick match plan 3 Task 8 (E1): the system org holds every guest's quick match, so it has scored and scheduled
    // fixtures all week. It must never get a weekly digest, and that must not hang on the community plan happening to
    // lack `news.auto`: the feature is switched ON for it below, so only the candidate query's exclusion stands
    // between it and a digest.
    const [systemOrg] = await sql<{ id: string }[]>`select id from organizations where id = ${QUICK_MATCH_SYSTEM_ORG_ID}`;
    expect(systemOrg, "premise: the system org is seeded (V506)").toBeDefined();
    const [ownOverride] = await sql`
      select 1 from org_entitlement_overrides where org_id = ${QUICK_MATCH_SYSTEM_ORG_ID} and feature_key = 'news.auto'`;
    expect(ownOverride, "premise: the system org carries no news.auto override of its own, so the cleanup restores it").toBeUndefined();

    const anchor = await freeSweepAnchor();
    // Empty case first: at a free anchor nothing at all is a candidate, so every candidate below is a row seeded here.
    expect(await digestCandidateOrgIds(anchor)).toEqual([]);

    const decidedOnly = await seedOrg("pro");
    const upcomingOnly = await seedOrg("pro");
    await seedSweepActivity(decidedOnly, anchor, { decided: true, upcoming: false });
    await seedSweepActivity(upcomingOnly, anchor, { decided: false, upcoming: true });
    const system: Ctx = { auth: systemAuth(), orgId: QUICK_MATCH_SYSTEM_ORG_ID, userId: QUICK_MATCH_SYSTEM_USER_ID };
    const systemCompIds: string[] = [];
    try {
      // The system org gets the activity of BOTH arms, scored through the same path its quick matches are, so each
      // arm's exclusion is witnessed on its own: drop either one and the system org is back through that arm.
      await seedSweepActivity(
        system,
        anchor,
        { decided: true, upcoming: true },
        { visibility: "private", made: systemCompIds },
      );
      await sql`
        insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
        values (${QUICK_MATCH_SYSTEM_ORG_ID}, 'news.auto', true, 'org-posts-digest.test: the system org with the feature ON')`;
      await invalidateOrgEntitlements(QUICK_MATCH_SYSTEM_ORG_ID);
      const scope = await newsAutoCompetitionScope(QUICK_MATCH_SYSTEM_ORG_ID);
      expect(scope.permitted, "premise: news.auto is ON for the system org").toBe(true);
      expect(scope.allowed).toContain(systemCompIds[0]);

      // At the candidate selection: a verdict per seeded org. Anti-vacuity: three orgs checked, one per verdict.
      const candidates = await digestCandidateOrgIds(anchor);
      const verdicts = [
        { org: "system, decided + upcoming", candidate: candidates.includes(QUICK_MATCH_SYSTEM_ORG_ID) },
        { org: "control, decided only", candidate: candidates.includes(decidedOnly.orgId) },
        { org: "control, upcoming only", candidate: candidates.includes(upcomingOnly.orgId) },
      ];
      expect(verdicts, JSON.stringify(verdicts)).toEqual([
        { org: "system, decided + upcoming", candidate: false },
        { org: "control, decided only", candidate: true },
        { org: "control, upcoming only", candidate: true },
      ]);
      expect(candidates, "the anchor is free: the two controls and nothing else").toHaveLength(2);

      // Through the sweep, twice (the second call is the same week's retry): the controls are checked and the system
      // org is not, so it never gets a digest.
      expect(await sweepWeeklyDigests(anchor)).toMatchObject({ orgsChecked: 2, digestsCreated: 2 });
      expect(await sweepWeeklyDigests(anchor)).toMatchObject({ orgsChecked: 2, digestsCreated: 0 });
      const systemDigests = await sql`
        select id from org_posts where org_id = ${QUICK_MATCH_SYSTEM_ORG_ID} and kind = 'weekly_digest'`;
      expect(systemDigests, "no weekly digest in the system org").toEqual([]);
      for (const control of [decidedOnly, upcomingOnly]) {
        const drafted = (await listPosts(control.auth, control.orgId)).filter((p) => p.kind === "weekly_digest");
        expect(drafted, `control ${control.orgId}: one digest`).toHaveLength(1);
      }
    } finally {
      await sql`
        delete from org_entitlement_overrides where org_id = ${QUICK_MATCH_SYSTEM_ORG_ID} and feature_key = 'news.auto'`;
      await invalidateOrgEntitlements(QUICK_MATCH_SYSTEM_ORG_ID);
      // A digest only a broken exclusion writes, and this test's own competitions: the system org is shared.
      await sql`
        delete from org_posts where org_id = ${QUICK_MATCH_SYSTEM_ORG_ID}
           and (kind = 'weekly_digest' or competition_id = any(${systemCompIds}::uuid[]))`;
      if (systemCompIds.length > 0) await sql`delete from competitions where id = any(${systemCompIds}::uuid[])`;
    }
  });

  it("digest window respects a non-UTC org timezone without throwing", async () => {
    const ctx = await seedOrg("pro", "Pacific/Auckland");
    const post = await generateWeeklyDigest(ctx.auth, ctx.orgId);
    expect(post.kind).toBe("weekly_digest");
  });
});

// ---------------------------------------------------------------------------
// W5 app PR A, Task 21 (X-SF-2; ST-G6): the digest and the round recap list EVERY pool of a pooled stage, in the stage's own pool
// order, one section per pool. A stage with several pools has no single table (`readSingleTableSnapshot` answers undefined for it by
// design), so before this task both surfaces dropped a pooled division's standings without a word - the absent symptom reads as "no
// standings yet". Driven through the real producers: the stage by `createStages` + `generateStageFixtures`, each result by the real
// scoring path (`playToDecided`) which writes the per-pool snapshots, the digest by `generateWeeklyDigest`, the recap by
// `draftPostsForDecidedFixture`. Expected values: the pool a fixture belongs to is the stored `fixtures.pool_id`, the winner the stored
// outcome's, the heading the public dictionary's own `table.poolLabel` (never typed here), the order the pools' keys A, B, C.
// ---------------------------------------------------------------------------

type PoolLocale = "en" | "es" | "fr" | "nl";
const publicDict = (locale: PoolLocale) =>
  JSON.parse(readFileSync(new URL(`../../../dictionaries/${locale}/public.json`, import.meta.url), "utf8")) as Record<string, string>;
const groupLabel = (locale: PoolLocale, key: string) => publicDict(locale)["table.poolLabel"]!.replace("{key}", key);

interface PooledPlay {
  r: Rig;
  /** Pool keys in the stage's order, each with the winner and loser of its one decided match (stored outcome, never recomputed). */
  pools: { id: string; key: string; winner: string; loser: string }[];
}

/** A group stage of `poolCount` pools of two, every pool's one match decided through the real write path. */
async function pooledPlay(sport: SportPick, poolCount: number, onlyPools?: number[]): Promise<PooledPlay> {
  const r = await rig({ n: poolCount * 2, kind: "group", pools: poolCount, sport });
  await startDivision(r.auth, r.divisionId);
  const pools = await sql<{ id: string; key: string }[]>`select id, key from pools where stage_id = ${r.stageId} order by key`;
  expect(pools, "premise: the generator made every pool").toHaveLength(poolCount);
  const out: PooledPlay["pools"] = [];
  for (const [i, p] of pools.entries()) {
    const [fx] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${r.stageId} and pool_id = ${p.id}`;
    if (onlyPools && !onlyPools.includes(i)) {
      out.push({ ...p, winner: "", loser: "" });
      continue;
    }
    expect(await playToDecided(r.auth, fx!.id), `premise: pool ${p.key}'s match decided`).toMatchObject({ kind: "decided" });
    const [{ outcome }] = await sql<{ outcome: { winner: string; loser: string } }[]>`select outcome from fixtures where id = ${fx!.id}`;
    const names = await sql<{ id: string; display_name: string }[]>`select id, display_name from entrants where id in ${sql([outcome.winner, outcome.loser])}`;
    const nameOf = (id: string) => names.find((n) => n.id === id)!.display_name;
    out.push({ ...p, winner: nameOf(outcome.winner), loser: nameOf(outcome.loser) });
  }
  return { r, pools: out };
}

/** Re-write pool `key`'s snapshot row so it is the physically last (and newest) row of the stage: heap and `updated_at` order then
 *  disagree with the pool order, so only the pools' own order can put A before B (AGENTS class 18). */
async function makeSnapshotLatest(stageId: string, poolId: string): Promise<void> {
  const moved = await sql`
    with d as (delete from standings_snapshots where stage_id = ${stageId} and pool_id = ${poolId} returning *)
    insert into standings_snapshots (stage_id, pool_id, org_id, rows, computed_through_seq, updated_at, previous_rows)
    select stage_id, pool_id, org_id, rows, computed_through_seq, now() + interval '1 hour', previous_rows from d returning 1`;
  expect(moved, "premise: the snapshot row was re-written").toHaveLength(1);
  // the pool's own row too: an update writes a new tuple at the end of the heap, so a pool read with no order of its own reads B first
  const touched = await sql`update pools set name = name where id = ${poolId} returning 1`;
  expect(touched, "premise: the pool row was re-written").toHaveLength(1);
}

/** Pool `i`'s stored table replaced by a level one (a started pool with nothing counted, X-TB-6), over its own two entrants. */
async function makePoolLevel(s: PooledPlay, i: number): Promise<void> {
  const ids = await sql<{ home_entrant_id: string; away_entrant_id: string }[]>`
    select home_entrant_id, away_entrant_id from fixtures where stage_id = ${s.r.stageId} and pool_id = ${s.pools[i]!.id}`;
  const level = levelLeague([ids[0]!.home_entrant_id, ids[0]!.away_entrant_id]);
  const set = await sql`update standings_snapshots set rows = ${sql.json(level.rows as never)} where stage_id = ${s.r.stageId} and pool_id = ${s.pools[i]!.id} returning 1`;
  expect(set, `premise: pool ${s.pools[i]!.key}'s stored table is now level`).toHaveLength(1);
}

const DIGEST_SPORTS = [BADMINTON, FOOTBALL];

describe.skipIf(!HAS_DB)("X-SF-2 the weekly digest lists every pool of a pooled stage, in pool order", () => {
  for (const sport of DIGEST_SPORTS) {
    // differential: today none - a stage with several pools yields no standings section at all
    it(`X-SF-2 a pooled division's digest lists every pool (${sport.key}): one section per pool, its own top and its own heading, A before B though A's snapshot was written last`, async () => {
      const s = await pooledPlay(sport, 2);
      await makeSnapshotLatest(s.r.stageId, s.pools[0]!.id);
      const post = await generateWeeklyDigest(s.r.auth, s.r.auth.orgId);
      const body = post.bodyMd;
      let checked = 0;
      const at = (needle: string) => {
        const i = body.indexOf(needle);
        expect(i, `${needle} is in the digest:\n${body}`).toBeGreaterThanOrEqual(0);
        checked += 1;
        return i;
      };
      const headA = at(`_Open — ${groupLabel("en", "A")}_`);
      const headB = at(`_Open — ${groupLabel("en", "B")}_`);
      expect(headA, "pool A's section reads before pool B's").toBeLessThan(headB);
      // each pool's own winner is under its own heading, and the other pool's players are not
      for (const [i, p] of s.pools.entries()) {
        const from = i === 0 ? headA : headB;
        const to = i === 0 ? headB : body.length;
        const slice = body.slice(from, to);
        expect(slice, `pool ${p.key}'s winner is in its section`).toContain(p.winner);
        expect(slice, `pool ${p.key}'s loser is in its section`).toContain(p.loser);
        const other = s.pools[1 - i]!;
        expect(slice, `pool ${other.key}'s winner is not in pool ${p.key}'s section`).not.toContain(other.winner);
        checked += 3;
      }
      expect(checked, "anti-vacuity: every pool's three facts and both headings were checked").toBe(8);
      expect(body).not.toContain("undefined");
    });
  }

  it("X-SF-2 three pools, only the first and last have a counted result: those two are listed, in order, and the empty pool is no section (anti-goal 3: nobody reads as first)", async () => {
    const s = await pooledPlay(BADMINTON, 3, [0, 2]);
    const sections = await withTenant(s.r.auth.orgId, (tx) => assembleDigestStandings(tx, [{ stage_id: s.r.stageId, division_name: "Open" }]));
    expect(sections.map((x) => x.poolLabel)).toEqual([groupLabel("en", "A"), groupLabel("en", "C")]);
    expect(sections.map((x) => x.top3[0]!.name)).toEqual([s.pools[0]!.winner, s.pools[2]!.winner]);
  });

  it("X-SF-2 a pool whose table is level (started, nothing counted) is no digest section, while the other pool is listed", async () => {
    const s = await pooledPlay(BADMINTON, 2);
    await makePoolLevel(s, 1);
    const sections = await withTenant(s.r.auth.orgId, (tx) => assembleDigestStandings(tx, [{ stage_id: s.r.stageId, division_name: "Open" }]));
    expect(sections.map((x) => x.poolLabel)).toEqual([groupLabel("en", "A")]);
  });

  it("X-SF-2 each pool's section carries its own climber, read from its own previous table", async () => {
    const s = await pooledPlay(BADMINTON, 2);
    // pool B's winner stood second before; pool A has no previous table. B5 G3 (n1): the previous table is the one BEFORE the result,
    // so both sides of the pool's one match had played one fewer - a step a result made.
    await sql`
      update standings_snapshots set previous_rows = (
        select jsonb_agg(jsonb_set(jsonb_set(r, '{rank}', to_jsonb(case when r->>'rank' = '1' then 2 else 1 end)), '{played}', to_jsonb((r->>'played')::int - 1)))
          from jsonb_array_elements(rows) r)
      where stage_id = ${s.r.stageId} and pool_id = ${s.pools[1]!.id}`;
    const sections = await withTenant(s.r.auth.orgId, (tx) => assembleDigestStandings(tx, [{ stage_id: s.r.stageId, division_name: "Open" }]));
    expect(sections).toHaveLength(2);
    expect(sections[0]!.climber, "pool A has nobody who climbed").toBeUndefined();
    expect(sections[1]!.climber?.entrantName, "pool B's climber is its own winner").toBe(s.pools[1]!.winner);
  });

  it("X-SF-2 the heading is the public dictionary's label in each of the four locales (Group / Grupo / Poule / Poule)", async () => {
    const s = await pooledPlay(BADMINTON, 2);
    let checked = 0;
    for (const locale of ["en", "es", "fr", "nl"] as const) {
      const sections = await withTenant(s.r.auth.orgId, (tx) =>
        assembleDigestStandings(tx, [{ stage_id: s.r.stageId, division_name: "Open" }], locale),
      );
      expect(sections.map((x) => x.poolLabel), locale).toEqual([groupLabel(locale, "A"), groupLabel(locale, "B")]);
      checked += sections.length;
    }
    expect(checked, "anti-vacuity: 4 locales x 2 pools").toBe(8);
    expect(groupLabel("nl", "A"), "the dictionary is really translated, not an English echo").not.toBe(groupLabel("en", "A"));
  });

  // pin, no defect expected: today a league's section is the stage's own, headed by the division alone
  it("X-SF-2 a league's digest is unchanged: one section, no pool heading, the division's name alone", async () => {
    const r = await rig({ n: 2, kind: "league" });
    await startDivision(r.auth, r.divisionId);
    const [fx] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${r.stageId}`;
    expect(await playToDecided(r.auth, fx!.id)).toMatchObject({ kind: "decided" });
    const sections = await withTenant(r.auth.orgId, (tx) => assembleDigestStandings(tx, [{ stage_id: r.stageId, division_name: "Open" }]));
    expect(sections).toHaveLength(1);
    expect("poolLabel" in sections[0]!, "a league names no pool").toBe(false);
    expect(sections[0]!.top3).toHaveLength(2);
    const post = await generateWeeklyDigest(r.auth, r.auth.orgId);
    expect(post.bodyMd).toContain("_Open_");
    expect(post.bodyMd).not.toContain(groupLabel("en", "A"));
  });

  // pin: a group of ONE pool reads as a league (X-BD-7) - not "Group A"
  it("X-SF-2 a one-pool group's digest is a league's: one section, no pool heading", async () => {
    const r = await rig({ n: 2, kind: "group" });
    await startDivision(r.auth, r.divisionId);
    const [fx] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${r.stageId}`;
    expect(await playToDecided(r.auth, fx!.id)).toMatchObject({ kind: "decided" });
    const sections = await withTenant(r.auth.orgId, (tx) => assembleDigestStandings(tx, [{ stage_id: r.stageId, division_name: "Open" }]));
    expect(sections).toHaveLength(1);
    expect("poolLabel" in sections[0]!).toBe(false);
  });
});

describe.skipIf(!HAS_DB)("X-SF-2 the round recap lists every pool of a pooled stage, in pool order", () => {
  /** The round recap the LAST decided fixture of round 1 drafts (the real hook: `draftPostsForDecidedFixture`). */
  async function recapBody(s: PooledPlay, locale: PoolLocale = "en"): Promise<string> {
    await sql`update divisions set auto_posts = true where id = ${s.r.divisionId}`;
    await sql`update organizations set default_locale = ${locale} where id = ${s.r.auth.orgId}`;
    const fixtures = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${s.r.stageId} order by pool_id`;
    await withTenant(s.r.auth.orgId, (tx) => draftPostsForDecidedFixture(tx, fixtures.at(-1)!.id, true));
    const recap = (await listPosts(s.r.auth, s.r.auth.orgId)).filter((p) => p.kind === "round_recap");
    expect(recap, "the round is complete: one recap").toHaveLength(1);
    return recap[0]!.bodyMd;
  }

  for (const sport of DIGEST_SPORTS) {
    // differential: today none - a pooled stage's recap has no standings block at all
    it(`X-SF-2 the recap lists every pool in pool order (${sport.key}): a block per pool, its own rows, A before B though A's snapshot was written last`, async () => {
      const s = await pooledPlay(sport, 2);
      await makeSnapshotLatest(s.r.stageId, s.pools[0]!.id);
      const body = await recapBody(s);
      const lines = body.split("\n");
      const headings = lines.map((l, i) => ({ l, i })).filter((x) => x.l.startsWith("**Standings"));
      expect(headings.map((h) => h.l)).toEqual([`**Standings — ${groupLabel("en", "A")}**`, `**Standings — ${groupLabel("en", "B")}**`]);
      let checked = 0;
      for (const [k, p] of s.pools.entries()) {
        const from = headings[k]!.i + 1;
        const to = headings[k + 1]?.i ?? lines.length;
        const rows = lines.slice(from, to).filter((l) => /^\d\. /.test(l));
        expect(rows.map((r) => r.replace(/^\d\. (.*?) — .*$/, "$1")).sort(), `pool ${p.key}'s block lists its own two players`).toEqual([p.winner, p.loser].sort());
        expect(rows[0], `pool ${p.key}'s leader is its winner, ranked 1`).toMatch(new RegExp(`^1\\. ${p.winner} — `));
        checked += 2;
      }
      expect(checked, "anti-vacuity: both pools, a leader and a membership each").toBe(4);
    });
  }

  it("X-SF-2 the recap's pool heading is the org's language (Dutch: Poule)", async () => {
    const s = await pooledPlay(BADMINTON, 2);
    const body = await recapBody(s, "nl");
    expect(body).toContain(`${groupLabel("nl", "A")}**`);
    expect(body).toContain(`${groupLabel("nl", "B")}**`);
    expect(body).not.toContain(groupLabel("en", "A"));
  });

  it("X-SF-2 a pool whose table is level is no recap block, while the other pool is listed", async () => {
    const s = await pooledPlay(BADMINTON, 2);
    await makePoolLevel(s, 1);
    const body = await recapBody(s);
    expect(body.split("\n").filter((l) => l.startsWith("**Standings"))).toEqual([`**Standings — ${groupLabel("en", "A")}**`]);
  });

  it("X-SF-2 a pool with nothing counted yet is no block in the recap (pool B untouched), and a league's recap keeps its single un-headed block", async () => {
    const s = await pooledPlay(BADMINTON, 2, [0]);
    // the round is open (pool B's match is undecided), so draft the recap by deciding it after the table of A alone is read
    const [untouched] = await sql<{ rows: StandingsRow[] }[]>`select rows from standings_snapshots where stage_id = ${s.r.stageId} and pool_id = ${s.pools[1]!.id}`;
    // W5 app PR B Task 1: a pool is its seating, so pool B stores its two seats from Start - LEVEL (nothing counted), no place to print.
    expect(untouched!.rows, "premise: pool B lists its two seats").toHaveLength(2);
    expect(isLevelTable(untouched!.rows), "premise: pool B has no counted result, so its table is level").toBe(true);
    const sections = await withTenant(s.r.auth.orgId, (tx) => assembleDigestStandings(tx, [{ stage_id: s.r.stageId, division_name: "Open" }]));
    expect(sections.map((x) => x.poolLabel), "a one-table pooled stage still names its pool").toEqual([groupLabel("en", "A")]);

    const r = await rig({ n: 2, kind: "league" });
    await startDivision(r.auth, r.divisionId);
    const [fx] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${r.stageId}`;
    expect(await playToDecided(r.auth, fx!.id)).toMatchObject({ kind: "decided" });
    await sql`update divisions set auto_posts = true where id = ${r.divisionId}`;
    await withTenant(r.auth.orgId, (tx) => draftPostsForDecidedFixture(tx, fx!.id, true));
    const recap = (await listPosts(r.auth, r.auth.orgId)).find((p) => p.kind === "round_recap");
    expect(recap, "premise: the league recapped").toBeDefined();
    expect(recap!.bodyMd.split("\n").filter((l) => l.startsWith("**Standings"))).toEqual(["**Standings**"]);
  });
});

// ---------------------------------------------------------------------------
// Task 21 fix round 1 (X-SF-2; ST-G6): a pooled fixture's movement reads ITS pool's table. The result post's "moves up to Nth" and the
// recap's "climbed from N to M" were measured against `readSingleTableSnapshot`, which answers undefined for a several-pool stage, so a
// pooled stage had neither. Expected values: the winner is the stored outcome's; the rank is written by the test into the pool's own
// stored table (pool A: 1st, pool B: 2nd) so a reader that took the wrong pool's table says the wrong ordinal; the previous tables
// differ per pool so a climber of pool A can never be pool B's.
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("X-SF-2 a pooled fixture's movement and climber read its own pool's table", () => {
  interface PoolFx {
    fixtureId: string;
    poolId: string;
    key: string;
    winnerName: string;
    winnerId: string;
  }
  /** Two pools of two, each pool's one match decided; each fixture's winner from the stored outcome. */
  async function twoPools(sport: SportPick = BADMINTON): Promise<{ r: Rig; fx: PoolFx[] }> {
    const s = await pooledPlay(sport, 2);
    const fx: PoolFx[] = [];
    for (const p of s.pools) {
      const [f] = await sql<{ id: string; outcome: { winner: string } }[]>`select id, outcome from fixtures where stage_id = ${s.r.stageId} and pool_id = ${p.id}`;
      fx.push({ fixtureId: f!.id, poolId: p.id, key: p.key, winnerName: p.winner, winnerId: f!.outcome.winner });
    }
    await sql`update divisions set auto_posts = true where id = ${s.r.divisionId}`;
    return { r: s.r, fx };
  }
  /** Pool `poolId`'s stored table with `entrantId` at rank `rank` (the other row at the other rank), and a previous table in which that entrant stood second. */
  async function setTable(stageId: string, poolId: string, winnerId: string, rank: 1 | 2, previous: boolean): Promise<void> {
    const [{ rows }] = await sql<{ rows: { entrantId: string; rank: number; played: number }[] }[]>`select rows from standings_snapshots where stage_id = ${stageId} and pool_id = ${poolId}`;
    const now = rows.map((x) => ({ ...x, rank: x.entrantId === winnerId ? rank : 3 - rank }));
    // B5 G3 (n1): the table before the result - both sides of the pool's one match had played one fewer.
    const prev = rows.map((x) => ({ ...x, rank: x.entrantId === winnerId ? 2 : 1, played: x.played - 1 }));
    await sql`update standings_snapshots set rows = ${sql.json(now as never)}, previous_rows = ${previous ? sql.json(prev as never) : null} where stage_id = ${stageId} and pool_id = ${poolId}`;
  }
  async function ctxOf(fixtureId: string): Promise<FixtureCtx> {
    const [row] = await sql<FixtureCtx[]>`
      select f.id as fixture_id, f.org_id, f.division_id, d.competition_id, f.stage_id, f.pool_id, st.kind as stage_kind, f.round_no, f.status,
             f.home_entrant_id, f.away_entrant_id, h.display_name as home_name, a.display_name as away_name, f.scheduled_at,
             null::text as venue, null::text as venue_tz, d.name as division_name, c.name as competition_name,
             d.sport_key, d.module_version, d.auto_posts, null::text as default_locale
      from fixtures f join stages st on st.id = f.stage_id join divisions d on d.id = f.division_id
        join competitions c on c.id = d.competition_id join entrants h on h.id = f.home_entrant_id join entrants a on a.id = f.away_entrant_id
      where f.id = ${fixtureId}`;
    return row!;
  }
  const resultPostOf = async (r: Rig, fixtureId: string) => {
    const posts = (await listPosts(r.auth, r.auth.orgId)).filter((p) => p.kind === "result");
    return posts.find((p) => (p.autoSource as { fixture_id?: string } | null)?.fixture_id === fixtureId)?.bodyMd ?? "";
  };

  for (const sport of DIGEST_SPORTS) {
    // differential: today none - a pooled stage's result post has no movement line at all
    it(`X-SF-2 the result post's "moves up to Nth" is the winner's place in HIS pool's table, in both pools (${sport.key})`, async () => {
      const { r, fx } = await twoPools(sport);
      // pool A's winner is 1st in A; pool B's winner is 2nd in B (so the wrong pool's table says the wrong ordinal)
      await setTable(r.stageId, fx[0]!.poolId, fx[0]!.winnerId, 1, false);
      await setTable(r.stageId, fx[1]!.poolId, fx[1]!.winnerId, 2, false);
      for (const f of fx) await withTenant(r.auth.orgId, (tx) => draftPostsForDecidedFixture(tx, f.fixtureId, true));
      expect(await resultPostOf(r, fx[0]!.fixtureId)).toContain(`${fx[0]!.winnerName} moves up to 1st.`);
      expect(await resultPostOf(r, fx[1]!.fixtureId)).toContain(`${fx[1]!.winnerName} moves up to 2nd.`);
    });
  }

  it("X-SF-2 the recap's climber is measured against the fixture's own pool's previous table: pool A's fixture names A's climber, pool B's names B's", async () => {
    const { r, fx } = await twoPools();
    await setTable(r.stageId, fx[0]!.poolId, fx[0]!.winnerId, 1, true);
    await setTable(r.stageId, fx[1]!.poolId, fx[1]!.winnerId, 1, true);
    let checked = 0;
    for (const f of fx) {
      const out = await withTenant(r.auth.orgId, async (tx) => assembleRecapEnrichment(tx, await ctxOf(f.fixtureId), []));
      expect(out.standingsMoves, `pool ${f.key}'s climber is its own winner, 2 -> 1`).toEqual([{ entrantName: f.winnerName, from: 2, to: 1 }]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: both pools").toBe(2);
    // a pool with no previous table has no climber, even though the other pool has one
    await sql`update standings_snapshots set previous_rows = null where stage_id = ${r.stageId} and pool_id = ${fx[1]!.poolId}`;
    const none = await withTenant(r.auth.orgId, async (tx) => assembleRecapEnrichment(tx, await ctxOf(fx[1]!.fixtureId), []));
    expect(none.standingsMoves, "pool B has no previous table: no climber, and never pool A's").toBeUndefined();
  });

  // pin, no defect expected: a league's movement and climber read the stage's table as before
  it("X-SF-2 a league's result post and recap climber are unchanged: the winner's place in the stage table, the stage's previous table", async () => {
    const r = await rig({ n: 2, kind: "league" });
    await startDivision(r.auth, r.divisionId);
    const [f] = await sql<{ id: string; outcome: { winner: string } }[]>`select id, outcome from fixtures where stage_id = ${r.stageId}`;
    expect(await playToDecided(r.auth, f!.id)).toMatchObject({ kind: "decided" });
    const [{ outcome }] = await sql<{ outcome: { winner: string } }[]>`select outcome from fixtures where id = ${f!.id}`;
    const [w] = await sql<{ display_name: string }[]>`select display_name from entrants where id = ${outcome.winner}`;
    await sql`update divisions set auto_posts = true where id = ${r.divisionId}`;
    // B5 G3 (n1): the table before the result - both sides had played one fewer.
    await sql`
      update standings_snapshots set previous_rows = (
        select jsonb_agg(jsonb_set(jsonb_set(x, '{rank}', to_jsonb(case when x->>'entrantId' = ${outcome.winner} then 2 else 1 end)), '{played}', to_jsonb((x->>'played')::int - 1)))
          from jsonb_array_elements(rows) x)
      where stage_id = ${r.stageId}`;
    await withTenant(r.auth.orgId, (tx) => draftPostsForDecidedFixture(tx, f!.id, true));
    const posts = await listPosts(r.auth, r.auth.orgId);
    expect(posts.find((p) => p.kind === "result")?.bodyMd).toContain(`${w!.display_name} moves up to 1st.`);
    expect(posts.find((p) => p.kind === "round_recap")?.bodyMd).toContain(`${w!.display_name} climbed from 2 to 1.`);
  });
});

// ---------------------------------------------------------------------------
// Task 21 fix round 1: a leaver in a pool's post (RB5-W1, W2, W3; owner ruling 277) and a repeated post. RB5-W1: a withdrawn or disqualified
// entrant stays in the table, ranked LAST, on every surface. RB5-W2: under half played, her results are removed. RB5-W3: half or more
// played, her results stand. Either way she stays, ranked last (W5 app PR B Task 1: a pool is its seating, so the expunged leaver is a row
// too, as in a league). So a post never lists a leaver above a competing entrant. The expected positions come from the rulebook (last =
// pool size), never from the code.
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("X-SF-2 posts after a withdrawal: a leaver is never crowned, walked over or expunged; a repeated post repeats nothing", () => {
  /** A group of two pools of FOUR (badminton). Every line of both pools is played (home wins) except `target`'s, which plays `targetPlays` of her three. */
  async function poolOfFour(targetPlays: number) {
    const r = await rig({ n: 8, kind: "group", pools: 2, sport: BADMINTON });
    await startDivision(r.auth, r.divisionId);
    const pools = await sql<{ id: string; key: string }[]>`select id, key from pools where stage_id = ${r.stageId} order by key`;
    const lines = await sql<{ id: string; pool_id: string; round_no: number; home_entrant_id: string; away_entrant_id: string }[]>`
      select id, pool_id, round_no, home_entrant_id, away_entrant_id from fixtures where stage_id = ${r.stageId} order by round_no, seq_in_round`;
    const inA = lines.filter((l) => l.pool_id === pools[0]!.id);
    const target = inA[0]!.home_entrant_id;
    let hers = 0;
    for (const l of lines) {
      const isHers = l.home_entrant_id === target || l.away_entrant_id === target;
      if (isHers) {
        if (hers >= targetPlays) continue;
        hers += 1;
        // she wins every match she plays: the leaver would top a points-only table
        await playBadminton(r.auth, l.id, l.home_entrant_id === target);
      } else {
        await playBadminton(r.auth, l.id, true);
      }
    }
    expect(hers, "premise: she played the number of lines the case names (of her 3)").toBe(targetPlays);
    const [{ display_name }] = await sql<{ display_name: string }[]>`select display_name from entrants where id = ${target}`;
    return { r, pools, target, targetName: display_name, firstRoundLine: lines.find((l) => l.pool_id === pools[0]!.id && l.round_no === 1 && l.home_entrant_id !== target && l.away_entrant_id !== target)!.id };
  }

  it("X-SF-2 RB5-W1/W3: a leaver who played half or more stays in her pool's table, ranked LAST - never in the digest's top 3 and last in the recap block", async () => {
    const { r, pools, target, targetName, firstRoundLine } = await poolOfFour(2);
    // premise (the rulebook's own scene): before she leaves she out-scores everyone in her pool
    const stored = async () => (await sql<{ rows: { entrantId: string; rank: number; points: number }[] }[]>`select rows from standings_snapshots where stage_id = ${r.stageId} and pool_id = ${pools[0]!.id}`)[0]!.rows;
    const before = (await stored()).find((x) => x.entrantId === target)!;
    expect(before.rank, "premise: with two wins she is in the top three - only the rule can move her out").toBeLessThanOrEqual(3);
    await withdrawEntrantCascade(r.auth, target);
    const rows = await stored();
    expect(rows, "premise: results stand at 2 of 3, so she is still in the table").toHaveLength(4);
    expect(rows.find((x) => x.entrantId === target)!.rank, "RB5-W1: ranked last of four").toBe(4);

    const sections = await withTenant(r.auth.orgId, (tx) => assembleDigestStandings(tx, [{ stage_id: r.stageId, division_name: "Open" }]));
    const a = sections.find((x) => x.poolLabel === groupLabel("en", "A"))!;
    expect(a.top3, "a pool of four lists its top three").toHaveLength(3);
    expect(a.top3.map((x) => x.name), "the leaver is not in pool A's top 3").not.toContain(targetName);
    expect(sections.flatMap((x) => x.top3.map((t) => t.name))).not.toContain(targetName);

    await sql`update divisions set auto_posts = true where id = ${r.divisionId}`;
    await withTenant(r.auth.orgId, (tx) => draftPostsForDecidedFixture(tx, firstRoundLine, true));
    const recap = (await listPosts(r.auth, r.auth.orgId)).find((p) => p.kind === "round_recap");
    expect(recap, "premise: the round recapped").toBeDefined();
    const lines = recap!.bodyMd.split("\n");
    const head = lines.findIndex((l) => l === `**Standings — ${groupLabel("en", "A")}**`);
    const block = lines.slice(head + 1).filter((l) => /^\d\. /.test(l)).slice(0, 4);
    expect(block, "pool A's block lists four").toHaveLength(4);
    // RB5-W1 "marked on every surface" (owner fix-now 2026-11-18): her line carries the hub chip's own word, after her name
    expect(block[3], "she is the LAST line, position 4, marked").toMatch(new RegExp(`^4\\. ${targetName} \\(${publicDict("en")["table.withdrawn"]}\\) — `));
    expect(block.slice(0, 3).some((l) => l.includes(targetName))).toBe(false);
  });

  // W5 app PR B Task 1 (X-WDT-7, RB5-W1): the pool is its SEATING now, so an expunged leaver stays a row of her pool (nothing counted,
  // ranked last), as she always did in a league - and a post lists her as the walkover leaver above: never in the top three, LAST and
  // marked in the recap block (was: "in no table and in no post at all", which held only while a pool's members were its results).
  it("X-SF-2 RB5-W2 + W1: a leaver under half played is expunged - her results are gone, she stays LAST in her pool's table, never in the top 3, marked last in the recap", async () => {
    const { r, pools, target, targetName, firstRoundLine } = await poolOfFour(0);
    await withdrawEntrantCascade(r.auth, target);
    const [{ rows }] = await sql<{ rows: { entrantId: string; rank: number; played: number }[] }[]>`select rows from standings_snapshots where stage_id = ${r.stageId} and pool_id = ${pools[0]!.id}`;
    expect(rows, "the pool's four seats").toHaveLength(4);
    expect(rows.find((x) => x.entrantId === target), "RB5-W2: nothing of hers counts; RB5-W1: ranked last of four").toMatchObject({ rank: 4, played: 0 });
    const sections = await withTenant(r.auth.orgId, (tx) => assembleDigestStandings(tx, [{ stage_id: r.stageId, division_name: "Open" }]));
    expect(sections.length, "both pools are listed").toBe(2);
    expect(sections.flatMap((x) => x.top3.map((t) => t.name)), "never in a top 3").not.toContain(targetName);
    await sql`update divisions set auto_posts = true where id = ${r.divisionId}`;
    await withTenant(r.auth.orgId, (tx) => draftPostsForDecidedFixture(tx, firstRoundLine, true));
    const recap = (await listPosts(r.auth, r.auth.orgId)).find((p) => p.kind === "round_recap");
    expect(recap, "premise: the round recapped after the cascade").toBeDefined();
    const lines = recap!.bodyMd.split("\n");
    const head = lines.findIndex((l) => l === `**Standings — ${groupLabel("en", "A")}**`);
    const block = lines.slice(head + 1).filter((l) => /^\d\. /.test(l)).slice(0, 4);
    expect(block, "pool A's block lists four").toHaveLength(4);
    expect(block[3], "she is the LAST line, position 4, marked").toMatch(new RegExp(`^4\\. ${targetName} \\(${publicDict("en")["table.withdrawn"]}\\) — `));
    expect(block.slice(0, 3).some((l) => l.includes(targetName))).toBe(false);
  });

  it("X-SF-2 a repeated post repeats nothing: the digest run twice makes two independent drafts, each with every pool once; the recap fired twice stays one", async () => {
    const s = await pooledPlay(BADMINTON, 2);
    await sql`update divisions set auto_posts = true where id = ${s.r.divisionId}`;
    const first = await generateWeeklyDigest(s.r.auth, s.r.auth.orgId);
    const second = await generateWeeklyDigest(s.r.auth, s.r.auth.orgId);
    expect(second.id, "two presses, two drafts").not.toBe(first.id);
    for (const post of [first, second]) {
      for (const key of ["A", "B"]) {
        expect(post.bodyMd.split(`_Open — ${groupLabel("en", key)}_`).length - 1, `pool ${key} is listed once per digest`).toBe(1);
      }
    }
    expect(second.bodyMd, "the same week, the same standings").toBe(first.bodyMd);
    const [fx] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${s.r.stageId} limit 1`;
    await withTenant(s.r.auth.orgId, (tx) => draftPostsForDecidedFixture(tx, fx!.id, true));
    await withTenant(s.r.auth.orgId, (tx) => draftPostsForDecidedFixture(tx, fx!.id, true));
    const recaps = (await listPosts(s.r.auth, s.r.auth.orgId)).filter((p) => p.kind === "round_recap");
    expect(recaps, "the auto-once index keeps the recap at one").toHaveLength(1);
    expect(recaps[0]!.bodyMd.split("**Standings —").length - 1, "and it lists each pool once").toBe(2);
  });
});

// ---------------------------------------------------------------------------
// B5 owner fix-now (b), RB5-W1 "a withdrawn or disqualified entrant stays in the table, ranked last, MARKED on every surface": the
// recap and the digest list a leaver whenever her table is short enough for her to reach the printed top (a pool of three, a league
// of three), and printed her bare - a reader took her for a competitor. The mark is the hub chip's own word (`DEPARTED_STATUS_CHIPS`
// labels), read here from the public dictionary file of the post's locale - never typed, never from the code under test. No new words.
// differential: today the leaver's line is "3. <name> — ..." with no mark, in every locale.
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("RB5-W1 posts mark who left, with the word every table uses", () => {
  const LOCALES = ["en", "es", "fr", "nl"] as const;
  const word = (locale: PoolLocale, status: "withdrawn" | "disqualified") => publicDict(locale)[`table.${status}`]!;
  /** Every `(<chip word>)` mark of either status in either locale's dictionary - a competing line must carry none of them. */
  const ANY_MARK = LOCALES.flatMap((l) => [`(${word(l, "withdrawn")})`, `(${word(l, "disqualified")})`]);

  /** Every line of `stageId` played (home wins) except `target`'s, who plays (and wins) only her FIRST line in round order. */
  async function playAllButHerSecond(r: Rig) {
    const lines = await sql<{ id: string; pool_id: string | null; round_no: number; home_entrant_id: string; away_entrant_id: string }[]>`
      select id, pool_id, round_no, home_entrant_id, away_entrant_id from fixtures where stage_id = ${r.stageId} order by round_no, seq_in_round`;
    const target = lines[0]!.home_entrant_id;
    let hers = 0;
    for (const l of lines) {
      const isHers = l.home_entrant_id === target || l.away_entrant_id === target;
      if (isHers && hers++ >= 1) continue;
      await playBadminton(r.auth, l.id, isHers ? l.home_entrant_id === target : true);
    }
    const [{ display_name }] = await sql<{ display_name: string }[]>`select display_name from entrants where id = ${target}`;
    return { lines, target, targetName: display_name, roundOneLine: lines.find((l) => l.round_no === 1)!.id };
  }

  /** The round recap of round 1 in `locale`, drafted afresh (the auto-once row of an earlier locale is taken away first). */
  async function recapIn(r: Rig, fixtureId: string, locale: PoolLocale): Promise<string> {
    await sql`update divisions set auto_posts = true where id = ${r.divisionId}`;
    await sql`update organizations set default_locale = ${locale} where id = ${r.auth.orgId}`;
    await sql`delete from org_posts where org_id = ${r.auth.orgId} and kind = 'round_recap'`;
    await withTenant(r.auth.orgId, (tx) => draftPostsForDecidedFixture(tx, fixtureId, true));
    const recap = (await listPosts(r.auth, r.auth.orgId)).filter((p) => p.kind === "round_recap");
    expect(recap, `premise: round 1 recapped in ${locale}`).toHaveLength(1);
    return recap[0]!.bodyMd;
  }

  it("RB5-W1 a pool of three: the leaver (1 of 2 played, results stand) is listed LAST and marked in the digest and the recap, in all four locales; nobody else is marked", async () => {
    const r = await rig({ n: 6, kind: "group", pools: 2, sport: BADMINTON });
    await startDivision(r.auth, r.divisionId);
    const { target, targetName, roundOneLine } = await playAllButHerSecond(r);
    await withdrawEntrantCascade(r.auth, target);
    const [poolA] = await sql<{ id: string }[]>`select pool_id as id from fixtures where stage_id = ${r.stageId} and (home_entrant_id = ${target} or away_entrant_id = ${target}) limit 1`;
    const [{ rows }] = await sql<{ rows: { entrantId: string; rank: number }[] }[]>`select rows from standings_snapshots where stage_id = ${r.stageId} and pool_id = ${poolA!.id}`;
    expect(rows, "premise: RB5-W3, half played - her results stand, she is still in her pool of three").toHaveLength(3);
    expect(rows.find((x) => x.entrantId === target)!.rank, "premise RB5-W1: ranked last of three").toBe(3);

    let checked = 0;
    for (const locale of LOCALES) {
      const mark = `(${word(locale, "withdrawn")})`;
      // the digest: her pool's top 3 is the whole pool, so she is listed - third, and marked; nobody else is
      const sections = await withTenant(r.auth.orgId, (tx) => assembleDigestStandings(tx, [{ stage_id: r.stageId, division_name: "Open" }], locale));
      const top = sections.flatMap((s) => s.top3);
      expect(top.filter((x) => x.name === targetName).map((x) => x.position), `${locale}: listed once in the digest, third`).toEqual([3]);
      expect(top.filter((x) => x.departed !== undefined).map((x) => [x.name, x.departed]), `${locale}: the digest marks her, and only her`).toEqual([
        [targetName, word(locale, "withdrawn")],
      ]);
      // the recap
      const body = await recapIn(r, roundOneLine, locale);
      const lines = body.split("\n").filter((l) => /^\d\. /.test(l));
      const herLine = lines.find((l) => l.includes(targetName));
      expect(herLine, `${locale}: the recap lists her LAST in her pool, position 3, marked with the chip's word:\n${body}`).toMatch(
        new RegExp(`^3\\. ${targetName} ${mark.replace(/[()]/g, "\\$&")} — `),
      );
      for (const l of lines.filter((x) => !x.includes(targetName))) {
        expect(ANY_MARK.some((m) => l.includes(m)), `${locale}: a competing line carries no mark: ${l}`).toBe(false);
      }
      checked += 1;
    }
    expect(checked, "anti-vacuity: four locales").toBe(4);
    expect(word("nl", "withdrawn"), "the dictionary is translated, not an English echo").not.toBe(word("en", "withdrawn"));
  });

  it("RB5-W1 a league of three: a disqualified entrant is marked Disqualified (not Withdrawn) in the rendered digest; Reinstate takes the mark away", async () => {
    const r = await rig({ n: 3, kind: "league", sport: BADMINTON });
    await startDivision(r.auth, r.divisionId);
    const { target, targetName } = await playAllButHerSecond(r);
    await withdrawEntrantCascade(r.auth, target, { as: "disqualified" });
    const [{ rows }] = await sql<{ rows: { entrantId: string; rank: number }[] }[]>`select rows from standings_snapshots where stage_id = ${r.stageId} and pool_id is null`;
    expect(rows.find((x) => x.entrantId === target)?.rank, "premise RB5-W1/W3: in the table, ranked last of three").toBe(3);
    const after = await generateWeeklyDigest(r.auth, r.auth.orgId);
    expect(after.bodyMd.split(targetName).length - 1, `premise: the digest lists her once:\n${after.bodyMd}`).toBe(1);
    expect(after.bodyMd, "the league's digest lists her, marked with the DQ chip's word").toContain(`${targetName} (${word("en", "disqualified")})`);
    expect(after.bodyMd, "never the other status's word").not.toContain(`(${word("en", "withdrawn")})`);

    await patchEntrant(r.auth, target, { status: "confirmed" });
    const back = await generateWeeklyDigest(r.auth, r.auth.orgId);
    expect(back.bodyMd, "after Reinstate she is listed").toContain(targetName);
    for (const m of ANY_MARK) expect(back.bodyMd, `after Reinstate no line carries ${m}`).not.toContain(m);
  });
});

// ---------------------------------------------------------------------------
// B5 fix wave G3 (batch review m3 + controller ruling n1, owner standing "apply rec"). m3, RB5-W1 "marked on every surface": the result
// post's score line, the streak line and the recap's results list name a leaver with her table chip's word, as the standings rows
// already do - differential: today (880f1529b7) only `topOfTable` and the digest's top 3 mark her. n1: "Biggest climber" / "moves up"
// measure a move a RESULT caused - a withdrawal, a Reinstate, a DQ or a late entry never makes a climber, and a leaver never "moves up".
// differential: today the digest right after a Reinstate prints "Biggest climber: <her> (4 → 1)" (B5 batch probe, n1).
// Expected words: the public dictionary's chip labels and the UI catalog's streak sentence, read from the files - never typed, never
// from the code under test. Single sport (badminton singles): the marks and the climber read statuses and stored rows, never a sport
// field (the RB5-W1 block above sweeps the four locales and two stage kinds).
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("B5 G3 posts mark a leaver on every line; a climber climbs on results only", () => {
  const uiDict = (locale: PoolLocale) =>
    JSON.parse(readFileSync(new URL(`../../../dictionaries/${locale}/ui.json`, import.meta.url), "utf8")) as Record<string, string>;
  const chip = (locale: PoolLocale, status: "withdrawn" | "disqualified") => publicDict(locale)[`table.${status}`]!;

  async function freshPosts(r: Rig, fixtureId: string, locale: PoolLocale) {
    await sql`update divisions set auto_posts = true where id = ${r.divisionId}`;
    await sql`update organizations set default_locale = ${locale} where id = ${r.auth.orgId}`;
    await sql`delete from org_posts where org_id = ${r.auth.orgId} and kind in ('result', 'round_recap')`;
    await withTenant(r.auth.orgId, (tx) => draftPostsForDecidedFixture(tx, fixtureId, true));
    const posts = await listPosts(r.auth, r.auth.orgId);
    const result = posts.find((p) => p.kind === "result");
    return { title: result?.title, result: result?.bodyMd, recap: posts.find((p) => p.kind === "round_recap")?.bodyMd };
  }

  it("m3 a league of three: she wins both her matches and then withdraws - her result post's score and streak lines and the recap's result line carry the chip's word (en, nl); no line says she moves up", async () => {
    const r = await rig({ n: 3, kind: "league", sport: BADMINTON });
    await startDivision(r.auth, r.divisionId);
    const lines = await sql<{ id: string; round_no: number; home_entrant_id: string; away_entrant_id: string }[]>`
      select id, round_no, home_entrant_id, away_entrant_id from fixtures where stage_id = ${r.stageId} order by round_no, seq_in_round`;
    const target = lines[0]!.home_entrant_id;
    const hers = lines.filter((l) => l.home_entrant_id === target || l.away_entrant_id === target);
    expect(hers, "premise: a league of three plays her twice").toHaveLength(2);
    for (const l of lines) await playBadminton(r.auth, l.id, hers.includes(l) ? l.home_entrant_id === target : true);
    await withdrawEntrantCascade(r.auth, target);
    const [{ display_name: name, status }] = await sql<{ display_name: string; status: string }[]>`select display_name, status from entrants where id = ${target}`;
    expect(status, "premise: she has left").toBe("withdrawn");
    const lastWin = hers[hers.length - 1]!;

    let checked = 0;
    for (const locale of ["en", "nl"] as const) {
      const marked = `${name} (${chip(locale, "withdrawn")})`;
      const { title, result, recap } = await freshPosts(r, lastWin.id, locale);
      expect(result, `${locale}: premise - a result post was drafted`).toBeTruthy();
      expect(recap, `${locale}: premise - the round's recap was drafted`).toBeTruthy();
      const resultLines = result!.split("\n");
      // The score line (the post's title, "Home s-s Away") names her marked.
      expect(title, `${locale}: the result post's score line names her marked`).toContain(marked);
      // The streak sentence, as the catalog writes it, with her marked name (she won both: 2 in a row).
      const streak = uiDict(locale)["news.enrich.streak.win"]!.replace("{entrant}", marked).replace("{length}", "2");
      expect(result, `${locale}: the streak line marks her:\n${result}`).toContain(streak);
      // No line names her bare: every occurrence of her name carries the mark.
      expect(result!.split(name).length - 1, `${locale}: every mention of her in the result post is marked`).toBe(result!.split(marked).length - 1);
      // n1: her place was set by her withdrawal, not by this result - no "moves up" line names her.
      expect(resultLines.filter((l) => l.includes(name) && /moves up|stijgt|monte|sube/i.test(l)), `${locale}: no movement line for a leaver`).toEqual([]);
      // The recap's results list: her line marked, every mention of her marked.
      const recapResults = recap!.split("\n").filter((l) => l.startsWith("- "));
      expect(recapResults.some((l) => l.includes(marked)), `${locale}: the recap's result line marks her:\n${recap}`).toBe(true);
      expect(recap!.split(name).length - 1, `${locale}: every mention of her in the recap is marked`).toBe(recap!.split(marked).length - 1);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("n1/m4 a league of four: withdraw (results stand) then Reinstate - each roster refold rebases the step, so the digest names no climber", async () => {
    const r = await rig({ n: 4, kind: "league", sport: BADMINTON });
    await startDivision(r.auth, r.divisionId);
    const lines = await sql<{ id: string; round_no: number; home_entrant_id: string; away_entrant_id: string }[]>`
      select id, round_no, home_entrant_id, away_entrant_id from fixtures where stage_id = ${r.stageId} order by round_no, seq_in_round`;
    const target = lines[0]!.home_entrant_id;
    // She plays (and wins) her first two lines; every other line but one is played (home wins), so she leads with 2 of 3 played.
    let hers = 0;
    const open: string[] = [];
    for (const l of lines) {
      const isHers = l.home_entrant_id === target || l.away_entrant_id === target;
      if (isHers && hers++ >= 2) continue;
      if (!isHers && open.length === 0 && l.round_no === 3) {
        open.push(l.id);
        continue;
      }
      await playBadminton(r.auth, l.id, isHers ? l.home_entrant_id === target : true);
    }
    const [{ display_name: name }] = await sql<{ display_name: string }[]>`select display_name from entrants where id = ${target}`;
    const rankOf = async (col: "rows" | "previous_rows") => {
      const [snap] = await sql<{ r: { entrantId: string; rank?: number }[] | null }[]>`
        select ${sql(col)} as r from standings_snapshots where stage_id = ${r.stageId} and pool_id is null`;
      return snap?.r?.find((x) => x.entrantId === target)?.rank;
    };
    const climberLines = (body: string) => body.split("\n").filter((l) => l.includes(uiDict("en")["news.digest.standings.climber"]!.split("{entrant}")[0]!));

    await withdrawEntrantCascade(r.auth, target);
    expect(await rankOf("rows"), "premise RB5-W1: ranked last after leaving").toBe(4);
    // m4: the withdrawal's refold is a roster step - the stored step is rebased onto the new table (no move recorded).
    expect(await rankOf("previous_rows"), "the withdrawal left no step: previous is the table as it now stands").toBe(4);
    const afterLeave = await generateWeeklyDigest(r.auth, r.auth.orgId);
    expect(climberLines(afterLeave.bodyMd), `a withdrawal makes no climber:\n${afterLeave.bodyMd}`).toEqual([]);

    await patchEntrant(r.auth, target, { status: "confirmed" });
    // differential: at 36eff19653 the stored step read 4 -> 1, a "climb" only a Reinstate caused. m4: the Reinstate's refold is
    // a roster step, so the step is rebased - previous is the table as it now stands.
    expect([await rankOf("previous_rows"), await rankOf("rows")], "the Reinstate left no step").toEqual([1, 1]);
    const afterBack = await generateWeeklyDigest(r.auth, r.auth.orgId);
    expect(afterBack.bodyMd, "premise: the digest lists the table").toContain(name);
    expect(climberLines(afterBack.bodyMd), `a Reinstate makes no climber:\n${afterBack.bodyMd}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// B5 fix wave fix round 2 (re-review m4; controller ruling, owner standing "apply rec"): a climber is measured over the step a
// RESULT made, comparing the rows both tables share. The row-count rule of 36eff19653 hid a real climb whenever the same result
// was somebody's FIRST counted match in a table that lists only entrants with a result (a group pool), or a late entrant's first
// result. The cause is now recorded by the writer (`writeSnapshot`: a result rolls the step, a roster refold rebases it).
// Driven through the real producers: results by `scoreEvent`, the placement by the organiser's add (`createEntrants` after Start),
// the digest by `assembleDigestStandings` / `generateWeeklyDigest`. Expected values: the stored ranks (premises, read back), the
// entrant the result's own outcome names.
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("B5 fix round 2 m4 a climber climbs on a result step, never a roster step", () => {
  async function poolTable(stageId: string, poolId: string) {
    const [snap] = await sql<{ rows: { entrantId: string; rank: number }[]; previous_rows: { entrantId: string; rank: number }[] | null }[]>`
      select rows, previous_rows from standings_snapshots where stage_id = ${stageId} and pool_id = ${poolId}`;
    return snap;
  }
  const climberOf = async (r: Rig) => {
    const sections = await withTenant(r.auth.orgId, (tx) => assembleDigestStandings(tx, [{ stage_id: r.stageId, division_name: "Open" }]));
    return sections.filter((x) => x.climber !== undefined).map((x) => x.climber!);
  };

  // W5 app PR B Task 1: a pool is its SEATING now, so all four are rows from Start - C's row is no longer new at B's win, but the probe's
  // point stands (the step is the result's and names its climber); premises re-read for four rows.
  it("m4 the re-review's probe (football, a group pool of four): A and B draw; B then beats C, who had not played - B climbs 2 -> 1", async () => {
    const r = await rig({ n: 8, kind: "group", pools: 2, sport: FOOTBALL });
    await startDivision(r.auth, r.divisionId);
    const lines = await sql<{ id: string; pool_id: string; home_entrant_id: string; away_entrant_id: string }[]>`
      select id, pool_id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${r.stageId} order by round_no, seq_in_round`;
    const first = lines[0]!;
    // A draw: 0-0 at full time (a table stage decides it as a draw).
    await post(r.auth, first.id, "core.start");
    await post(r.auth, first.id, "football.period", { phase: "HT" });
    await post(r.auth, first.id, "football.period", { phase: "FT" });
    const before = await poolTable(r.stageId, first.pool_id);
    expect(before?.rows.length, "premise: the pool table lists its four seats").toBe(4);
    const b = before!.rows.find((x) => x.rank === 2)!.entrantId;
    const a = before!.rows.find((x) => x.rank === 1)!.entrantId;
    // B's next line in the pool, against someone who has not played (C).
    const next = lines.find((l) => l.pool_id === first.pool_id && l.id !== first.id && (l.home_entrant_id === b || l.away_entrant_id === b) && l.home_entrant_id !== a && l.away_entrant_id !== a)!;
    expect(next, "premise: B has a line against a pool member who has not played").toBeDefined();
    const c = next.home_entrant_id === b ? next.away_entrant_id : next.home_entrant_id;
    await post(r.auth, next.id, "core.start");
    await post(r.auth, next.id, "core.forfeit", { by: c, reason: "walkover" });
    const [{ outcome }] = await sql<{ outcome: { winner?: string } }[]>`select outcome from fixtures where id = ${next.id}`;
    expect(outcome.winner, "premise: B won").toBe(b);
    const after = await poolTable(r.stageId, first.pool_id);
    expect(after!.rows.slice(0, 2).map((x) => x.entrantId), "premise: B 1st, A 2nd").toEqual([b, a]);
    expect(after!.rows.map((x) => x.entrantId), "premise: C is still a row").toContain(c);
    expect(after!.previous_rows?.find((x) => x.entrantId === b)?.rank, "premise: the step is the result's - B was 2nd before it").toBe(2);
    // differential: at 36eff19653 no climber (the row-count rule).
    expect(await climberOf(r)).toEqual([expect.objectContaining({ from: 2, to: 1 })]);
    const [{ display_name }] = await sql<{ display_name: string }[]>`select display_name from entrants where id = ${b}`;
    expect((await climberOf(r))[0]!.entrantName).toBe(display_name);
  });

  it("m4 a late entrant placed after Start, then a result: the placement leaves no step; the result's step names its climber", async () => {
    const r = await rig({ n: 4, kind: "league", sport: BADMINTON });
    await startDivision(r.auth, r.divisionId);
    const lines = await sql<{ id: string; round_no: number; home_entrant_id: string; away_entrant_id: string }[]>`
      select id, round_no, home_entrant_id, away_entrant_id from fixtures where stage_id = ${r.stageId} order by round_no, seq_in_round`;
    // Round 1 only: two winners on 3, two losers on 0.
    for (const l of lines.filter((x) => x.round_no === 1)) await playBadminton(r.auth, l.id, true);
    const [late] = await createEntrants(r.auth, r.divisionId, [
      { kind: "individual", display_name: "Late Lou", seed: null, members: [{ new_person: { full_name: `Late Lou ${randomUUID().slice(0, 4)}` }, is_captain: false, roles: [] }] } as never,
    ]);
    const snapAfterPlacement = await sql<{ rows: { entrantId: string; rank: number }[]; previous_rows: unknown }[]>`
      select rows, previous_rows from standings_snapshots where stage_id = ${r.stageId} and pool_id is null`;
    expect(snapAfterPlacement[0]!.previous_rows, "the placement's refold left no step (rebased or unchanged)").not.toBeNull();
    expect(await climberOf(r), "after the placement alone: no climber").toEqual([]);
    // The 2nd-placed round-1 winner beats the newcomer: 6 points, alone at the top.
    const table = snapAfterPlacement[0]!.rows;
    const second = table.find((x) => x.rank === 2)!.entrantId;
    const vsLate = (await sql<{ id: string; home_entrant_id: string }[]>`
      select id, home_entrant_id from fixtures where stage_id = ${r.stageId} and status not in ('decided','finalized','forfeited')
        and ((home_entrant_id = ${second} and away_entrant_id = ${late!.id}) or (home_entrant_id = ${late!.id} and away_entrant_id = ${second}))`)[0];
    expect(vsLate, "premise: the late entrant has a catch-up line against the 2nd-placed").toBeDefined();
    await playBadminton(r.auth, vsLate!.id, vsLate!.home_entrant_id === second);
    const [step] = await sql<{ rows: { entrantId: string; rank: number }[]; previous_rows: { entrantId: string; rank: number }[] }[]>`
      select rows, previous_rows from standings_snapshots where stage_id = ${r.stageId} and pool_id is null`;
    const rankIn = (t: { entrantId: string; rank: number }[], id: string) => t.find((x) => x.entrantId === id)?.rank;
    // The stored step, read back (the engine's ranks, never typed): the result moved the winner 2 -> 1; the newcomer's first match
    // (lost) moved her up from 5th too, to 3rd or 4th on a tiebreak among the 0-point rows - the step's biggest move either way
    // is one of the two, and the line names it with its stored ranks.
    expect([rankIn(step!.previous_rows, second), rankIn(step!.rows, second)], "premise: the winner went 2 -> 1").toEqual([2, 1]);
    expect(rankIn(step!.previous_rows, late!.id), "premise: the step starts from the table the placement left (her 5th, unplayed)").toBe(5);
    const names = new Map(
      (await sql<{ id: string; display_name: string }[]>`select id, display_name from entrants where id = any(${[second, late!.id]})`).map((e) => [e.display_name, e.id]),
    );
    const climbers = await climberOf(r);
    expect(climbers, "the result's step names a climber").toHaveLength(1);
    const id = names.get(climbers[0]!.entrantName);
    expect(id, `the climber is the winner or the newcomer: ${climbers[0]!.entrantName}`).toBeDefined();
    expect([climbers[0]!.from, climbers[0]!.to], "named with its stored ranks").toEqual([rankIn(step!.previous_rows, id!), rankIn(step!.rows, id!)]);
  });
});

