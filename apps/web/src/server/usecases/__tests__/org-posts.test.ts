// PROMPT-82 — org news CRUD + decided-seam auto-drafts (SPEC-2). DB-backed;
// skipped without DATABASE_URL. Seeds orgs/divisions/fixtures with raw SQL and
// exercises: slug collision + publish freeze, archive/delete, ungated manual
// posts on community, listPosts filter, RLS isolation, public visibility guard,
// and the auto-draft hook (result draft, idempotency, void→stale, live
// entitlement probe, round recap, opt-in gate, scoring seam).
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";

import { sql, withTenant } from "@/lib/db";
import { hasFeature, invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  createPost,
  updatePost,
  deletePost,
  getPost,
  listPosts,
  publicPosts,
  publicPost,
  draftPostsForDecidedFixture,
  shouldFirePostPublished,
  assembleDigestStandings,
} from "../org-posts";
import { chessRoundRobin, levelLeague, sportOf } from "@/server/engine-db/__tests__/helpers/stored-table-rows";
import { scoreEvent } from "../scoring";
import { msgFor } from "@/lib/messages-i18n";
import { putLineup, getLineup } from "../fixtures";
import { createVenue } from "../venues";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;
// Full parsed football config — the module's fold needs it to initialize state
// (an empty {} makes applyForfeit read undefined score fields).
const FOOTBALL_CFG = builtinModules.find((m) => m.key === "football")!.configSchema.parse({});
// S4/#428 review round 2 — icehockey, not football, for the coach-scorer
// exclusion test below: football's applyGoal validates the scorer is
// state.squads[side].onPitch (players only, structurally — see
// reference_football_squad_is_players_only_structurally in agent memory),
// so a coach could never be recorded as a goal scorer there at all and the
// exclusion would be unfalsifiable (true regardless of whether the role
// filter works). icehockey's applyGoal (period/kernel.ts) has no such
// check — any person id folds — so it is the sport where "the coach is
// excluded from the scorers list" can ONLY be true because
// aggregatePlayerStats's lineups argument actually filtered him.
const ICEHOCKEY_CFG = builtinModules.find((m) => m.key === "icehockey")!.configSchema.parse({});
const icehockeyPositions = builtinModules.find((m) => m.key === "icehockey")!.positions;
// S8/#417 — badminton (setbased kernel) for the entrant-fallback wiring test
// below: NOT in the sibling session's packages/engine edit list, so its
// kernel-added `points_won` metric (entrantField "wonBy", fromEntrant true)
// is a stable, already-shipped target.
const badminton = builtinModules.find((m) => m.key === "badminton")!;
const BADMINTON_CFG = badminton.configSchema.parse({});

interface Ctx {
  auth: AuthCtx;
  orgId: string;
  userId: string;
  orgSlug: string;
}

async function seedOrg(plan: "pro" | "community" = "pro"): Promise<Ctx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`news-${suffix}@test.local`}, 'News', true) returning id`;
  const orgSlug = "news-" + suffix;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, default_locale)
    values (${"News " + suffix}, ${orgSlug}, ${userId}, 'en') returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  if (plan === "pro") {
    await setOrgPlan(orgId);
  }
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('football', 'Football', '1.0.0', ${sql.json({ groups: [], lineup: { size: 11, benchMax: 12 } })})
    on conflict (key) do nothing`;
  return {
    auth: { orgId, via: "session", userId, role: "owner", keyId: null },
    orgId,
    userId,
    orgSlug,
  };
}

interface DivCtx {
  compId: string;
  divisionId: string;
  stageId: string;
  entrantA: string;
  entrantB: string;
}

async function seedDivision(
  ctx: Ctx,
  opts: { autoPosts?: boolean; visibility?: string } = {},
): Promise<DivCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, created_by)
    values (${ctx.orgId}, 'Cup', ${"cup-" + suffix}, ${opts.visibility ?? "public"}, ${ctx.userId})
    returning id`;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, org_id, name, slug, sport_key, variant_key,
      config, module_version, auto_posts)
    values (${compId}, ${ctx.orgId}, 'Premier', ${"prem-" + suffix}, 'football', '11-a-side',
      ${sql.json(FOOTBALL_CFG as never)}, '1.0.0', ${opts.autoPosts ?? false})
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, org_id, seq, kind, name)
    values (${divisionId}, ${ctx.orgId}, 1, 'league', 'League') returning id`;
  const [{ id: entrantA }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, org_id, kind, display_name, seed)
    values (${divisionId}, ${ctx.orgId}, 'team', 'Riverside', 1) returning id`;
  const [{ id: entrantB }] = await sql<{ id: string }[]>`
    insert into entrants (division_id, org_id, kind, display_name, seed)
    values (${divisionId}, ${ctx.orgId}, 'team', 'Northside', 2) returning id`;
  return { compId, divisionId, stageId, entrantA, entrantB };
}

async function seedDecidedFixture(
  ctx: Ctx,
  div: DivCtx,
  opts: {
    round?: number;
    homeLine?: string;
    awayLine?: string;
    status?: string;
    stageId?: string;
  } = {},
): Promise<string> {
  const round = opts.round ?? 1;
  const stageId = opts.stageId ?? div.stageId;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round,
      home_entrant_id, away_entrant_id, status, outcome)
    values (${stageId}, ${div.divisionId}, ${ctx.orgId}, ${round}, 1,
      ${div.entrantA}, ${div.entrantB}, ${opts.status ?? "decided"},
      ${sql.json({ kind: "win", winner: div.entrantA, loser: div.entrantB })})
    returning id`;
  await sql`
    insert into match_states (fixture_id, org_id, last_seq, state, summary)
    values (${id}, ${ctx.orgId}, 1, ${sql.json({})},
      ${sql.json({
        headline: `${opts.homeLine ?? "2"}–${opts.awayLine ?? "1"}`,
        perSide: [
          { entrantId: div.entrantA, line: opts.homeLine ?? "2" },
          { entrantId: div.entrantB, line: opts.awayLine ?? "1" },
        ],
      })})
    on conflict (fixture_id) do update set summary = excluded.summary`;
  return id;
}

/**
 * `news.auto` is now resolved by the CALLER, outside the transaction — it is a
 * `hasFeature` read on the pooled `sql` proxy, and issuing that from inside
 * `withTenant` is the pool self-deadlock (lib/db.ts). `refreshNews` does it
 * exactly this way in usecases/scoring.ts.
 *
 * RESOLVED, not hardcoded true. Passing a literal would turn the community-org
 * case below into a test of its own argument: the point of that case is that a
 * community org RESOLVES to false, so the resolution has to be real.
 *
 * WITH the competition id, mirroring what `refreshNews` now does: V396 made
 * `news.auto` pass-lifted (false on Free, granted on both Event Pass rungs), so
 * an org-wide resolve here would answer a different question from the one
 * production asks and the pass case below could not exist.
 */
async function draft(ctx: Ctx, fixtureId: string, competitionId?: string): Promise<void> {
  const newsAuto = await hasFeature(ctx.orgId, "news.auto", competitionId);
  await withTenant(ctx.orgId, (tx) => draftPostsForDecidedFixture(tx, fixtureId, newsAuto));
}

describe.skipIf(!HAS_DB)("org-posts CRUD", () => {
  it("slugifies the title and suffixes -2 on collision", async () => {
    const ctx = await seedOrg();
    const a = await createPost(ctx.auth, ctx.orgId, {
      title: "Match Day Report",
    });
    const b = await createPost(ctx.auth, ctx.orgId, {
      title: "Match Day Report",
    });
    expect(a.slug).toBe("match-day-report");
    expect(b.slug).toBe("match-day-report-2");
    expect(a.status).toBe("draft");
    expect(a.kind).toBe("news");
  });

  it("slug-collision posts are both independently publishable with distinct public URLs", async () => {
    const ctx = await seedOrg();
    const a = await createPost(ctx.auth, ctx.orgId, {
      title: "Match Day Report",
    });
    const b = await createPost(ctx.auth, ctx.orgId, {
      title: "Match Day Report",
    });
    await updatePost(ctx.auth, a.id, { action: "publish" });
    await updatePost(ctx.auth, b.id, { action: "publish" });

    const pubA = await publicPost(ctx.orgSlug, a.slug);
    const pubB = await publicPost(ctx.orgSlug, b.slug);
    expect(a.slug).not.toBe(b.slug);
    expect(pubA.id).toBe(a.id);
    expect(pubB.id).toBe(b.id);
    const { posts } = await publicPosts(ctx.orgSlug);
    expect(posts.map((p) => p.slug)).toEqual(
      expect.arrayContaining(["match-day-report", "match-day-report-2"]),
    );
  });

  it("publish stamps published_at and freezes the slug across title edits", async () => {
    const ctx = await seedOrg();
    const post = await createPost(ctx.auth, ctx.orgId, {
      title: "Opening Weekend",
    });
    const published = await updatePost(ctx.auth, post.id, {
      action: "publish",
    });
    expect(published.status).toBe("published");
    expect(published.publishedAt).not.toBeNull();
    expect(published.slug).toBe("opening-weekend");
    // A title edit AFTER publish keeps the URL frozen (SPEC-2 invariant).
    const renamed = await updatePost(ctx.auth, post.id, {
      title: "Totally New Headline",
    });
    expect(renamed.title).toBe("Totally New Headline");
    expect(renamed.slug).toBe("opening-weekend");
  });

  it("a republish from archived does NOT move published_at, though analytics counts it", async () => {
    // Two answers to "was this published", and they disagree on exactly one
    // path — deliberately, but nothing said so until this test.
    //
    // `shouldFirePostPublished("archived", "publish")` is TRUE, so PostHog
    // records a second post_published. `published_at` is stamped only while
    // `neverPublished` (org-posts.ts, the `action === "publish"` branch), so
    // it does NOT move. Analytics counts publish TRANSITIONS; `published_at`
    // records FIRST publication and is frozen because the slug is frozen to it.
    //
    // Both are right for their own question. The hazard is a downstream
    // feature picking one while meaning the other — a digest keyed on
    // `published_at` silently skips a republished post, and a count keyed on
    // the event double-counts it. `published_at` is the only one an API client
    // can see at all (`api-v1/posts.ts:23`); the event reaches PostHog and
    // nothing else — no row, no outbox, no webhook.
    const ctx = await seedOrg();
    const post = await createPost(ctx.auth, ctx.orgId, { title: "Fixture Notice" });

    const first = await updatePost(ctx.auth, post.id, { action: "publish" });
    expect(first.publishedAt).not.toBeNull();
    const stampedAt = first.publishedAt;

    const archived = await updatePost(ctx.auth, post.id, { action: "archive" });
    expect(archived.status).toBe("archived");
    expect(archived.publishedAt).toEqual(stampedAt); // archiving does not clear it

    const republished = await updatePost(ctx.auth, post.id, { action: "publish" });
    expect(republished.status).toBe("published");
    // The assertion that matters: the stamp is the FIRST publication, not the
    // latest one. If this ever reds, decide which of the two definitions the
    // product means before changing it — the slug freeze reads the same field.
    expect(republished.publishedAt).toEqual(stampedAt);

    // And the analytics side of the same transition, so the divergence is
    // pinned from both ends rather than asserted about one of them.
    expect(shouldFirePostPublished("archived", "publish")).toBe(true);
  });

  it("regenerates the slug on a title edit while still a draft", async () => {
    const ctx = await seedOrg();
    const post = await createPost(ctx.auth, ctx.orgId, {
      title: "First Draft",
    });
    const edited = await updatePost(ctx.auth, post.id, {
      title: "Second Draft",
    });
    expect(edited.slug).toBe("second-draft");
  });

  it("archives and deletes", async () => {
    const ctx = await seedOrg();
    const post = await createPost(ctx.auth, ctx.orgId, { title: "Notice" });
    const archived = await updatePost(ctx.auth, post.id, { action: "archive" });
    expect(archived.status).toBe("archived");
    await deletePost(ctx.auth, post.id);
    await expect(getPost(ctx.auth, post.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("archiving a PUBLISHED post removes it from publicPosts but keeps it in the console with a frozen slug", async () => {
    const ctx = await seedOrg();
    const post = await createPost(ctx.auth, ctx.orgId, {
      title: "Season Wrap-Up",
    });
    await updatePost(ctx.auth, post.id, { action: "publish" });
    const { posts: before } = await publicPosts(ctx.orgSlug);
    expect(before.map((p) => p.slug)).toContain("season-wrap-up");

    const archived = await updatePost(ctx.auth, post.id, { action: "archive" });
    expect(archived.status).toBe("archived");
    expect(archived.slug).toBe("season-wrap-up");

    const { posts: after } = await publicPosts(ctx.orgSlug);
    expect(after.map((p) => p.id)).not.toContain(post.id);
    await expect(publicPost(ctx.orgSlug, "season-wrap-up")).rejects.toMatchObject({ status: 404 });

    // The console read still lists it, status archived, slug unchanged.
    const consoleRow = (await listPosts(ctx.auth, ctx.orgId)).find((p) => p.id === post.id)!;
    expect(consoleRow).toMatchObject({
      status: "archived",
      slug: "season-wrap-up",
    });
  });

  it("manual posts succeed on a community org (ungated PLG surface)", async () => {
    const ctx = await seedOrg("community");
    const post = await createPost(ctx.auth, ctx.orgId, {
      title: "Free Club News",
    });
    const published = await updatePost(ctx.auth, post.id, {
      action: "publish",
    });
    expect(published.status).toBe("published");
  });

  it("listPosts filters by status", async () => {
    const ctx = await seedOrg();
    const p1 = await createPost(ctx.auth, ctx.orgId, { title: "Draft One" });
    const p2 = await createPost(ctx.auth, ctx.orgId, { title: "Live One" });
    await updatePost(ctx.auth, p2.id, { action: "publish" });
    const drafts = await listPosts(ctx.auth, ctx.orgId, "draft");
    const published = await listPosts(ctx.auth, ctx.orgId, "published");
    expect(drafts.map((p) => p.id)).toContain(p1.id);
    expect(drafts.map((p) => p.id)).not.toContain(p2.id);
    expect(published.map((p) => p.id)).toEqual([p2.id]);
  });

  it("RLS isolates posts between orgs (non-vacuous raw count)", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    const post = await createPost(a.auth, a.orgId, { title: "Org A Only" });

    // Sanity: the superuser connection DOES see org A's row — the tenant check
    // below is meaningful, not vacuously zero.
    const [{ raw }] = await sql<{ raw: number }[]>`
      select count(*)::int as raw from org_posts where id = ${post.id}`;
    expect(raw).toBe(1);

    const seen = await withTenant(b.orgId, async (tx) => {
      const [{ n }] = await tx<{ n: number }[]>`
        select count(*)::int as n from org_posts where id = ${post.id}`;
      return n;
    });
    expect(seen).toBe(0);
    expect(await listPosts(b.auth, b.orgId)).toEqual([]);
  });

  it("public reads never return drafts or private-competition posts", async () => {
    const ctx = await seedOrg();
    const pub = await seedDivision(ctx, { visibility: "public" });
    const priv = await seedDivision(ctx, { visibility: "private" });

    const orgPost = await createPost(ctx.auth, ctx.orgId, {
      title: "Org Wide",
    });
    await updatePost(ctx.auth, orgPost.id, { action: "publish" });
    const draftPost = await createPost(ctx.auth, ctx.orgId, {
      title: "Hidden Draft",
    });
    void draftPost;
    const pubScoped = await createPost(ctx.auth, ctx.orgId, {
      title: "Public Comp Post",
      competitionId: pub.compId,
    });
    await updatePost(ctx.auth, pubScoped.id, { action: "publish" });
    const privScoped = await createPost(ctx.auth, ctx.orgId, {
      title: "Private Comp Post",
      competitionId: priv.compId,
    });
    await updatePost(ctx.auth, privScoped.id, { action: "publish" });

    const { posts } = await publicPosts(ctx.orgSlug);
    const slugs = posts.map((p) => p.slug);
    expect(slugs).toContain("org-wide");
    expect(slugs).toContain("public-comp-post");
    expect(slugs).not.toContain("hidden-draft");
    expect(slugs).not.toContain("private-comp-post");
    // Direct fetch of a draft / private-scoped post 404s.
    await expect(publicPost(ctx.orgSlug, "hidden-draft")).rejects.toMatchObject({ status: 404 });
    await expect(publicPost(ctx.orgSlug, "private-comp-post")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("paginates public posts 20/page with hasMore", async () => {
    const ctx = await seedOrg();
    for (let i = 0; i < 22; i++) {
      const p = await createPost(ctx.auth, ctx.orgId, { title: `Post ${i}` });
      await updatePost(ctx.auth, p.id, { action: "publish" });
    }
    const page0 = await publicPosts(ctx.orgSlug, 0);
    const page1 = await publicPosts(ctx.orgSlug, 1);
    expect(page0.posts).toHaveLength(20);
    expect(page0.hasMore).toBe(true);
    expect(page1.posts).toHaveLength(2);
    expect(page1.hasMore).toBe(false);
  });

  it("paginates 25 published posts newest-first: page0 20, page1 the remaining 5", async () => {
    const ctx = await seedOrg();
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const p = await createPost(ctx.auth, ctx.orgId, { title: `Story ${i}` });
      await updatePost(ctx.auth, p.id, { action: "publish" });
      ids.push(p.id);
    }
    // Stamp explicit, strictly increasing published_at so "newest first" is
    // unambiguous even if sequential publish() calls land in the same instant.
    for (let i = 0; i < ids.length; i++) {
      await sql`update org_posts set published_at = now() + (${i} * interval '1 second') where id = ${ids[i]}`;
    }

    const page0 = await publicPosts(ctx.orgSlug, 0);
    const page1 = await publicPosts(ctx.orgSlug, 1);
    expect(page0.posts).toHaveLength(20);
    expect(page0.hasMore).toBe(true);
    expect(page1.posts).toHaveLength(5);
    expect(page1.hasMore).toBe(false);
    // Newest first: Story 24 (stamped last) leads page0; Story 0 trails page1.
    expect(page0.posts[0]!.title).toBe("Story 24");
    expect(page1.posts[4]!.title).toBe("Story 0");
    const allIds = [...page0.posts, ...page1.posts].map((p) => p.id);
    expect(new Set(allIds).size).toBe(25); // no overlap/duplication across pages
  });
});

describe.skipIf(!HAS_DB)("org-posts auto-drafts", () => {
  it("drafts one result post for a decided fixture in an opted-in pro division", async () => {
    const ctx = await seedOrg();
    const div = await seedDivision(ctx, { autoPosts: true });
    const fx = await seedDecidedFixture(ctx, div, {
      homeLine: "3",
      awayLine: "1",
    });
    await draft(ctx, fx);

    const posts = await listPosts(ctx.auth, ctx.orgId);
    const results = posts.filter((p) => p.kind === "result");
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("Riverside 3–1 Northside");
    expect(results[0]!.status).toBe("draft");
    expect(results[0]!.autoSource).toMatchObject({
      trigger: "fixture_decided",
      fixture_id: fx,
      stale: false,
    });
  });

  // P9 sweep (pass 3c-4): draftPostsForDecidedFixture used to SELECT
  // fixtures.venue straight into the result draft's body — frozen since pass
  // 3a, so a fixture decided post-cutover drafted a blank venue line
  // regardless of its real venue_id.
  it("result draft body carries the live venue name, not a disagreeing frozen venue", async () => {
    const ctx = await seedOrg();
    const div = await seedDivision(ctx, { autoPosts: true });
    const fx = await seedDecidedFixture(ctx, div, { homeLine: "2", awayLine: "0" });
    const venue = await createVenue(ctx.auth, { name: "Meadow Park Live", sort: 0 });
    await sql`update fixtures set venue_id = ${venue.id}, venue = 'Stale Venue' where id = ${fx}`;

    await draft(ctx, fx);

    const posts = await listPosts(ctx.auth, ctx.orgId);
    const results = posts.filter((p) => p.kind === "result");
    expect(results).toHaveLength(1);
    expect(results[0]!.bodyMd).toContain("Meadow Park Live");
    expect(results[0]!.bodyMd).not.toContain("Stale Venue");
  });

  it("is idempotent under the auto-once index (re-run keeps one)", async () => {
    const ctx = await seedOrg();
    const div = await seedDivision(ctx, { autoPosts: true });
    const fx = await seedDecidedFixture(ctx, div);
    await draft(ctx, fx);
    await draft(ctx, fx);
    const results = (await listPosts(ctx.auth, ctx.orgId)).filter((p) => p.kind === "result");
    expect(results).toHaveLength(1);
  });

  it("void stamps stale on the DRAFT only; a published post is untouched", async () => {
    const ctx = await seedOrg();
    const div = await seedDivision(ctx, { autoPosts: true });
    const fx = await seedDecidedFixture(ctx, div, { round: 1 });
    await draft(ctx, fx);

    // A published auto post on a DIFFERENT fixture (unique index bars two auto
    // rows per fixture) — it must never be staled.
    const fxP = await seedDecidedFixture(ctx, div, { round: 2 });
    await draft(ctx, fxP);
    const published = (await listPosts(ctx.auth, ctx.orgId)).find(
      (p) => p.autoSource?.fixture_id === fxP,
    )!;
    await updatePost(ctx.auth, published.id, { action: "publish" });

    // Void erases fx's decision → its draft goes stale.
    await sql`update fixtures set status = 'in_play' where id = ${fx}`;
    await draft(ctx, fx);

    const posts = await listPosts(ctx.auth, ctx.orgId);
    const staledDraft = posts.find((p) => p.autoSource?.fixture_id === fx)!;
    const untouched = posts.find((p) => p.id === published.id)!;
    expect(staledDraft.autoSource?.stale).toBe(true);
    expect(untouched.status).toBe("published");
    expect(untouched.autoSource?.stale).toBe(false);
  });

  it("does not draft for an org DENIED news.auto, even if the toggle reads true", async () => {
    // A DENY override beats both the plan AND a pass (`resolve`'s precedence),
    // which is what makes it the right lever: it proves the probe is honoured
    // even where an entitled org would draft. (V393 freed the key and V396
    // re-gated it; the override case is unaffected by either.)
    const ctx = await seedOrg("community");
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
      values (${ctx.orgId}, 'news.auto', false, 'test')`;
    await invalidateOrgEntitlements(ctx.orgId);
    const div = await seedDivision(ctx, { autoPosts: true });
    const fx = await seedDecidedFixture(ctx, div);
    await draft(ctx, fx);
    expect(await listPosts(ctx.auth, ctx.orgId)).toEqual([]);
  });

  it("does NOT draft for a plain community org — V396 made news.auto paid again", async () => {
    // V393 freed this key and this case asserted a draft; V396 (entitlements
    // v18 W2 T15, owner ruling 2026-09-03) re-gated it as one of the three
    // share loops. Asserted on the RESOLVED value through the real probe, not
    // on the matrix row.
    const ctx = await seedOrg("community");
    const div = await seedDivision(ctx, { autoPosts: true });
    const fx = await seedDecidedFixture(ctx, div);
    await draft(ctx, fx, div.compId);
    expect(await listPosts(ctx.auth, ctx.orgId)).toEqual([]);
  });

  it("DOES draft for a community org holding an Event Pass on that competition", async () => {
    // The grant the owner kept when the loops went paid, driven end to end.
    // `news.auto` carries its `event_pass` row already (V112), so the only way
    // this can fail is the resolve dropping the competition id — which is what
    // `pass-scoping-guard.test.ts` guards and `refreshNews` now supplies.
    const ctx = await seedOrg("community");
    const div = await seedDivision(ctx, { autoPosts: true });
    await sql`
      insert into competition_passes (competition_id, org_id, pass_key)
      values (${div.compId}, ${ctx.orgId}, 'event_pass')`;
    await invalidateOrgEntitlements(ctx.orgId);
    const fx = await seedDecidedFixture(ctx, div);
    await draft(ctx, fx, div.compId);
    expect(await listPosts(ctx.auth, ctx.orgId)).not.toEqual([]);
  });

  it("drafts a round recap when the last fixture of a round is decided", async () => {
    const ctx = await seedOrg();
    const div = await seedDivision(ctx, { autoPosts: true });
    const fx1 = await seedDecidedFixture(ctx, div, {
      round: 1,
      homeLine: "3",
      awayLine: "1",
    });
    const fx2 = await seedDecidedFixture(ctx, div, {
      round: 1,
      homeLine: "0",
      awayLine: "0",
    });
    void fx1;
    await sql`
      insert into standings_snapshots (stage_id, org_id, pool_id, rows, computed_through_seq)
      values (${div.stageId}, ${ctx.orgId}, null,
        ${sql.json([
          {
            entrantId: div.entrantA,
            played: 1,
            won: 1,
            drawn: 0,
            lost: 0,
            points: 3,
            metrics: {},
            rank: 1,
          },
          {
            entrantId: div.entrantB,
            played: 1,
            won: 0,
            drawn: 0,
            lost: 1,
            points: 0,
            metrics: {},
            rank: 2,
          },
        ])}, 2)`;
    await draft(ctx, fx2);

    const posts = await listPosts(ctx.auth, ctx.orgId);
    const recap = posts.filter((p) => p.kind === "round_recap");
    expect(recap).toHaveLength(1);
    expect(recap[0]!.autoSource).toMatchObject({
      trigger: "round_complete",
      round_no: 1,
    });
    expect(recap[0]!.bodyMd).toContain("Riverside");
  });

  it("loop-F tidy (ruling 105's sibling): an EXPUNGED abandon and a cancelled line close the round — the recap drafts and lists only the result; a plain abandon, or an expunge since voided, still holds it", async () => {
    // single-sport: football, this file's rig; the probe reads fixture status and the ledger, never the sport.
    const resultLines = (body: string) => body.split("\n").filter((l) => l.startsWith("- Riverside ")).length;
    async function scene(abandon: "expunge" | "plain" | "expunge-voided") {
      const ctx = await seedOrg();
      const div = await seedDivision(ctx, { autoPosts: true });
      const gone = await seedDecidedFixture(ctx, div, { round: 1 });
      const cancelled = await seedDecidedFixture(ctx, div, { round: 1 });
      await sql`update fixtures set status = 'abandoned', outcome = null where id = ${gone}`;
      await sql`update fixtures set status = 'cancelled', outcome = null where id = ${cancelled}`;
      // The withdrawal cascade's own expunge shape (withdrawal.ts: core.abandon{reason: "withdrew", expunge: true}).
      const payload = abandon === "plain" ? { reason: "rain" } : { reason: "withdrew", expunge: true };
      const [ab] = await sql<{ id: string }[]>`
        insert into score_events (id, fixture_id, seq, type, payload, recorded_at)
        values (${randomUUID()}, ${gone}, 1, 'core.abandon', ${sql.json(payload)}, now()) returning id`;
      if (abandon === "expunge-voided") {
        await sql`insert into score_events (id, fixture_id, seq, type, payload, recorded_at, voids_event_id)
                  values (${randomUUID()}, ${gone}, 2, 'core.void', ${sql.json({ event_id: ab!.id })}, now(), ${ab!.id})`;
      }
      const last = await seedDecidedFixture(ctx, div, { round: 1, homeLine: "4", awayLine: "2" });
      await draft(ctx, last);
      return (await listPosts(ctx.auth, ctx.orgId)).filter((p) => p.kind === "round_recap");
    }
    const closed = await scene("expunge");
    expect(closed, "expunged + cancelled: the round is complete").toHaveLength(1);
    expect(closed[0]!.autoSource).toMatchObject({ trigger: "round_complete", round_no: 1 });
    expect(resultLines(closed[0]!.bodyMd), "only the DECIDED line is a result").toBe(1);
    expect(closed[0]!.bodyMd).toContain("- Riverside 4–2 Northside");
    expect(await scene("plain"), "a plain recorded abandon holds the round").toHaveLength(0);
    expect(await scene("expunge-voided"), "an expunge that was voided is no longer active: it holds the round").toHaveLength(0);
  });

  // Loop R M-11 — a credited result's recap line says which: a walkover keeps its credited score and adds its tag, an
  // abandon decided by the award policy names it, and a double walkover's tag stands in the score's place (its summary's
  // 0–0 is a score nobody played). The words are the dictionary's (org locale en), the tag read by the one reader over
  // the stored outcome and the ledger's active abandon. Single-sport: football, this file's rig; the line reads stored
  // rows, never the sport.
  it("Loop R M-11: the round recap tags a walkover and an award-policy abandon, and draws a double walkover's tag in the score's place", async () => {
    const ctx = await seedOrg();
    const div = await seedDivision(ctx, { autoPosts: true });
    const played = await seedDecidedFixture(ctx, div, { round: 1, homeLine: "3", awayLine: "1" });
    const wo = await seedDecidedFixture(ctx, div, { round: 1, homeLine: "3", awayLine: "0", status: "forfeited" });
    const ab = await seedDecidedFixture(ctx, div, { round: 1, homeLine: "1", awayLine: "0" });
    const dw = await seedDecidedFixture(ctx, div, { round: 1, homeLine: "0", awayLine: "0", status: "forfeited" });
    await sql`update fixtures set outcome = ${sql.json({ kind: "award", winner: div.entrantA, loser: div.entrantB, reason: "walkover" })} where id = ${wo}`;
    await sql`update fixtures set outcome = ${sql.json({ kind: "win", winner: div.entrantA, loser: div.entrantB, method: "abandoned" })} where id = ${ab}`;
    await sql`insert into score_events (id, fixture_id, seq, type, payload, recorded_at)
              values (${randomUUID()}, ${ab}, 1, 'core.start', ${sql.json({})}, now()),
                     (${randomUUID()}, ${ab}, 2, 'core.abandon', ${sql.json({ reason: "floodlights" })}, now())`;
    await sql`update fixtures set outcome = ${sql.json({ kind: "double_walkover" })} where id = ${dw}`;
    void played;
    await draft(ctx, dw);
    const recap = (await listPosts(ctx.auth, ctx.orgId)).filter((p) => p.kind === "round_recap");
    expect(recap, "the round is complete").toHaveLength(1);
    const lines = recap[0]!.bodyMd.split("\n").filter((l) => l.startsWith("- Riverside "));
    const tag = (k: Parameters<typeof msgFor>[1]) => msgFor("en", k);
    expect(lines.sort()).toEqual(
      [
        "- Riverside 3–1 Northside",
        `- Riverside 3–0 Northside (${tag("forfeit.tag.walkover")})`,
        `- Riverside 1–0 Northside (${tag("forfeit.tag.abandoned")})`,
        `- Riverside ${tag("forfeit.tag.doubleWalkover")} Northside`,
      ].sort(),
    );
    expect(recap[0]!.bodyMd, "never the double walkover's 0–0").not.toContain("Riverside 0–0 Northside");
    // A double walkover drafts no result post (audit 3.1); the walkover's is titled with its tag.
    const results = (await listPosts(ctx.auth, ctx.orgId)).filter((p) => p.kind === "result");
    expect(results, "the double walkover drafted none").toEqual([]);
    await draft(ctx, wo);
    const woPost = (await listPosts(ctx.auth, ctx.orgId)).filter((p) => p.kind === "result");
    expect(woPost.map((p) => p.title)).toEqual([`Riverside 3–0 Northside (${tag("forfeit.tag.walkover")})`]);
  });

  it("round recaps are stage-scoped: a sibling stage's open round 1 neither blocks the recap nor shares its auto-once key", async () => {
    const ctx = await seedOrg();
    const div = await seedDivision(ctx, { autoPosts: true }); // stage A: kind 'league', round numbers restart per stage
    // A second table stage in the SAME division, also carrying a round 1.
    const [{ id: stageB }] = await sql<{ id: string }[]>`
      insert into stages (division_id, org_id, seq, kind, name)
      values (${div.divisionId}, ${ctx.orgId}, 2, 'group', 'Group') returning id`;

    // Stage B round 1 has an OPEN (scheduled) fixture — under a division-wide
    // completeness count this scheduled fixture blocks stage A's recap forever.
    const [{ id: b1 }] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round,
        home_entrant_id, away_entrant_id, status)
      values (${stageB}, ${div.divisionId}, ${ctx.orgId}, 1, 1,
        ${div.entrantA}, ${div.entrantB}, 'scheduled') returning id`;

    // Stage A round 1: two decided fixtures → its recap should fire even though
    // stage B's round 1 is still open.
    const a1 = await seedDecidedFixture(ctx, div, {
      round: 1,
      homeLine: "3",
      awayLine: "1",
    });
    const a2 = await seedDecidedFixture(ctx, div, {
      round: 1,
      homeLine: "0",
      awayLine: "0",
    });
    void a1;
    await draft(ctx, a2);

    let recap = (await listPosts(ctx.auth, ctx.orgId)).filter((p) => p.kind === "round_recap");
    expect(recap).toHaveLength(1); // pre-fix: stage B's scheduled fixture keeps the round "open"
    expect(recap[0]!.autoSource).toMatchObject({
      trigger: "round_complete",
      round_no: 1,
      stage_id: div.stageId,
    });

    // Complete stage B's round 1 → its OWN recap, keyed on stage_id so the
    // auto-once index does not treat it as a dup of stage A's division+round row.
    await sql`
      update fixtures set status = 'decided',
        outcome = ${sql.json({ kind: "win", winner: div.entrantA, loser: div.entrantB })}
      where id = ${b1}`;
    await draft(ctx, b1);

    recap = (await listPosts(ctx.auth, ctx.orgId)).filter((p) => p.kind === "round_recap");
    expect(recap).toHaveLength(2);
    expect(new Set(recap.map((r) => r.autoSource?.stage_id))).toEqual(
      new Set([div.stageId, stageB]),
    );

    // Voiding a stage A result stales stage A's recap draft only — stage B's
    // same-numbered round is a different competition phase.
    await sql`update fixtures set status = 'scheduled', outcome = null where id = ${a1}`;
    await draft(ctx, a1);
    recap = (await listPosts(ctx.auth, ctx.orgId)).filter((p) => p.kind === "round_recap");
    expect(recap.find((r) => r.autoSource?.stage_id === div.stageId)?.autoSource?.stale).toBe(true);
    expect(recap.find((r) => r.autoSource?.stage_id === stageB)?.autoSource?.stale).toBeFalsy();
  });

  it("drafts nothing when the division has not opted in", async () => {
    const ctx = await seedOrg();
    const div = await seedDivision(ctx, { autoPosts: false });
    const fx = await seedDecidedFixture(ctx, div);
    await draft(ctx, fx);
    expect(await listPosts(ctx.auth, ctx.orgId)).toEqual([]);
  });

  it("the scoring decided seam drafts a result post (awaited but swallowed, isolated)", async () => {
    const ctx = await seedOrg();
    const div = await seedDivision(ctx, { autoPosts: true });
    await sql`update divisions set status = 'active' where id = ${div.divisionId}`;
    const [{ id: fx }] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round,
        home_entrant_id, away_entrant_id, status)
      values (${div.stageId}, ${div.divisionId}, ${ctx.orgId}, 1, 1,
        ${div.entrantA}, ${div.entrantB}, 'scheduled') returning id`;
    await scoreEvent(ctx.auth, fx, {
      expected_seq: 0,
      type: "core.forfeit",
      payload: { by: div.entrantB, reason: "walkover" },
    });
    const results = (await listPosts(ctx.auth, ctx.orgId)).filter((p) => p.kind === "result");
    expect(results).toHaveLength(1);
    expect(results[0]!.autoSource?.fixture_id).toBe(fx);
  });

  // S4/#428 review round 2 — the finding-1 standard ("must hold through the
  // real API path, not just a bare engine unit test") applied to the SECOND
  // aggregatePlayerStats call site named in the finding. Same shape as
  // player-stats.test.ts's coach regression: real putLineup (writes
  // LineupSlot.role over the real V357 column) -> real getLineup round-trip
  // -> real scoreEvent ledger -> the real auto-draft path
  // (draftPostsForDecidedFixture, fired here by the "scoring decided seam"
  // exactly like the sibling test above) -> assert on the PUBLISHED POST'S
  // OWN TEXT, not an intermediate return value.
  it("a coach's goal-shaped stat never appears in the auto-drafted result post's scorers", async () => {
    const ctx = await seedOrg();
    await sql`
      insert into sports (key, name, module_version, position_catalog)
      values ('icehockey', 'Ice Hockey', '1.0.0', ${sql.json(icehockeyPositions as never)})
      on conflict (key) do nothing`;
    const suffix = randomUUID().slice(0, 8);
    const [{ id: compId }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug, visibility, created_by)
      values (${ctx.orgId}, 'Ice Cup', ${"ice-cup-" + suffix}, 'public', ${ctx.userId})
      returning id`;
    const [{ id: divisionId }] = await sql<{ id: string }[]>`
      insert into divisions (competition_id, org_id, name, slug, sport_key, variant_key,
        config, module_version, auto_posts)
      values (${compId}, ${ctx.orgId}, 'Ice Premier', ${"ice-prem-" + suffix}, 'icehockey', 'iihf',
        ${sql.json(ICEHOCKEY_CFG as never)}, '1.0.0', true)
      returning id`;
    await sql`update divisions set status = 'active' where id = ${divisionId}`;
    const [{ id: stageId }] = await sql<{ id: string }[]>`
      insert into stages (division_id, org_id, seq, kind, name)
      values (${divisionId}, ${ctx.orgId}, 1, 'league', 'League') returning id`;
    const [{ id: entrantA }] = await sql<{ id: string }[]>`
      insert into entrants (division_id, org_id, kind, display_name, seed)
      values (${divisionId}, ${ctx.orgId}, 'team', 'Icebergs', 1) returning id`;
    const [{ id: entrantB }] = await sql<{ id: string }[]>`
      insert into entrants (division_id, org_id, kind, display_name, seed)
      values (${divisionId}, ${ctx.orgId}, 'team', 'Glaciers', 2) returning id`;

    const [{ id: playerId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${ctx.orgId}, 'Pat Player') returning id`;
    const [{ id: coachId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${ctx.orgId}, 'Cara Coach') returning id`;
    // A coach is a squad member (entrant_members) same as any player, S3
    // ruling 3 -- role lives on the per-fixture lineup slot, not here.
    await sql`
      insert into entrant_members (entrant_id, person_id, org_id)
      values (${entrantA}, ${playerId}, ${ctx.orgId}), (${entrantA}, ${coachId}, ${ctx.orgId})`;

    const [{ id: fx }] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round,
        home_entrant_id, away_entrant_id, status)
      values (${stageId}, ${divisionId}, ${ctx.orgId}, 1, 1,
        ${entrantA}, ${entrantB}, 'scheduled') returning id`;

    // Real putLineup, real role write.
    await putLineup(ctx.auth, fx, entrantA, {
      slots: [
        { person_id: playerId, slot: "starting", position_key: null, order_no: 1, roles: [] },
        { person_id: coachId, slot: "bench", position_key: null, order_no: 2, roles: [], role: "coach" },
      ],
    });
    // Real read path round-trip, same assertion shape as player-stats.test.ts.
    const lineup = await getLineup(ctx.auth, fx, entrantA);
    const coachSlot = (lineup.slots as { person_id: string; role: string }[]).find(
      (s) => s.person_id === coachId,
    );
    expect(coachSlot?.role).toBe("coach");

    await scoreEvent(ctx.auth, fx, { expected_seq: 0, type: "core.start", payload: {} });
    // THE event under test: icehockey.goal carries zero on-ice validation
    // (period/kernel.ts's applyGoal never checks the lineup at all, unlike
    // football's applyGoal), so this folds and counts for ANY person id
    // unless aggregatePlayerStats's role filter is the thing stopping it —
    // proving the wiring, not a structural fold-level accident.
    await scoreEvent(ctx.auth, fx, {
      expected_seq: 1,
      type: "icehockey.goal",
      payload: { by: entrantA, person: coachId },
    });
    await scoreEvent(ctx.auth, fx, {
      expected_seq: 2,
      type: "icehockey.goal",
      payload: { by: entrantA, person: playerId },
    });
    // Decides the fixture; the scoring decided seam drafts the result post
    // as a side effect of this call (same mechanism the sibling test above
    // exercises), which is what actually reaches extractScorers/org-posts.ts.
    await scoreEvent(ctx.auth, fx, {
      expected_seq: 3,
      type: "core.forfeit",
      // W2b D3 R2/R4: once play has started a walkover is refused outside the sport's walkover phases (default
      // pre-start); a retirement is the in-play forfeit (loop-F tidy: red since the engine wave).
      payload: { by: entrantB, reason: "retired" },
    });

    const results = (await listPosts(ctx.auth, ctx.orgId)).filter((p) => p.kind === "result");
    expect(results).toHaveLength(1);
    expect(results[0]!.autoSource?.fixture_id).toBe(fx);
    expect(results[0]!.bodyMd).toContain("Pat Player");
    expect(results[0]!.bodyMd).not.toContain("Cara Coach");
  });

  // S8/#417 — the SECOND aggregatePlayerStats call site (extractScorers,
  // org-posts.ts:585) must get the same ctx player-stats.ts's recompute now
  // does. S4/#428's review finding was exactly this class of bug: wiring one
  // call site and not the other. A v1-era entrant-only rally (wonBy, no
  // scorer/server) must still produce a scorer line through THIS path.
  it("S8/#417: an entrant-only rally (wonBy, no scorer) still names a scorer in the auto-drafted result post", async () => {
    const ctx = await seedOrg();
    await sql`
      insert into sports (key, name, module_version, position_catalog)
      values ('badminton', 'Badminton', ${badminton.version}, ${sql.json(badminton.positions as never)})
      on conflict (key) do nothing`;
    const suffix = randomUUID().slice(0, 8);
    const [{ id: compId }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug, visibility, created_by)
      values (${ctx.orgId}, 'Badminton Cup', ${"bad-cup-" + suffix}, 'public', ${ctx.userId})
      returning id`;
    const [{ id: divisionId }] = await sql<{ id: string }[]>`
      insert into divisions (competition_id, org_id, name, slug, sport_key, variant_key,
        config, module_version, auto_posts)
      values (${compId}, ${ctx.orgId}, 'Singles', ${"bad-singles-" + suffix}, 'badminton', 'default',
        ${sql.json(BADMINTON_CFG as never)}, ${badminton.version}, true)
      returning id`;
    await sql`update divisions set status = 'active' where id = ${divisionId}`;
    const [{ id: stageId }] = await sql<{ id: string }[]>`
      insert into stages (division_id, org_id, seq, kind, name)
      values (${divisionId}, ${ctx.orgId}, 1, 'league', 'League') returning id`;
    const [{ id: entrantA }] = await sql<{ id: string }[]>`
      insert into entrants (division_id, org_id, kind, display_name, seed)
      values (${divisionId}, ${ctx.orgId}, 'individual', 'Alex', 1) returning id`;
    const [{ id: entrantB }] = await sql<{ id: string }[]>`
      insert into entrants (division_id, org_id, kind, display_name, seed)
      values (${divisionId}, ${ctx.orgId}, 'individual', 'Bo', 2) returning id`;

    const [{ id: alexId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${ctx.orgId}, 'Alex Player') returning id`;
    const [{ id: boId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${ctx.orgId}, 'Bo Player') returning id`;
    await sql`
      insert into entrant_members (entrant_id, person_id, org_id)
      values (${entrantA}, ${alexId}, ${ctx.orgId}), (${entrantB}, ${boId}, ${ctx.orgId})`;

    const [{ id: fx }] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round,
        home_entrant_id, away_entrant_id, status)
      values (${stageId}, ${divisionId}, ${ctx.orgId}, 1, 1,
        ${entrantA}, ${entrantB}, 'scheduled') returning id`;

    await scoreEvent(ctx.auth, fx, { expected_seq: 0, type: "core.start", payload: {} });
    // ONLY the entrant id — no scorer, no server. Before S8/#417's wiring at
    // THIS call site, extractScorers folds this with no ctx and the rally
    // credits nobody.
    await scoreEvent(ctx.auth, fx, {
      expected_seq: 1,
      type: "badminton.rally",
      payload: { wonBy: entrantA },
    });
    // Decides the fixture; the scoring decided seam drafts the result post
    // as a side effect, which is what actually reaches extractScorers.
    await scoreEvent(ctx.auth, fx, {
      expected_seq: 2,
      type: "core.forfeit",
      // W2b D3 R2/R4: once play has started a walkover is refused outside the sport's walkover phases (default
      // pre-start); a retirement is the in-play forfeit (loop-F tidy: red since the engine wave).
      payload: { by: entrantB, reason: "retired" },
    });

    const results = (await listPosts(ctx.auth, ctx.orgId)).filter((p) => p.kind === "result");
    expect(results).toHaveLength(1);
    expect(results[0]!.bodyMd).toContain("Alex Player");
  });

  // P3 (D7) acceptance criterion (b): a GENUINELY poisoned stats source — a
  // real function throwing for a real reason, not a mock that cannot fail —
  // must still yield the draft, with only the poisoned section missing.
  //
  // Tried first, and instructive enough to leave a trace of: corrupting
  // divisions.module_version between two reads does NOT isolate cleanly —
  // `scoreEvent` itself calls `assertEntitledToScore` -> resolveModule on
  // EVERY write, so a bad module_version breaks the SETUP (scoreEvent
  // throws before the fixture ever decides), not just the enrichment read.
  // The clean, isolated poison is a malformed `previous_rows` JSON shape:
  // `biggestClimber` calls `.map()` on it unconditionally once past its
  // null/empty guard, so a stored value that is an OBJECT (not an array —
  // truthy, and `{}.length` is `undefined`, not `0`, so the empty-guard
  // does not catch it either) makes `.map` throw "not a function" for
  // real — no mock, and nothing else in the round-recap draft depends on
  // that column, so the rest of the draft is untouched.
  it("P3 fail-open: a malformed previous_rows value drops only the standings-moves line, never the recap draft", async () => {
    const ctx = await seedOrg();
    const div = await seedDivision(ctx, { autoPosts: true });
    const fx1 = await seedDecidedFixture(ctx, div, { round: 1, homeLine: "3", awayLine: "1" });
    const fx2 = await seedDecidedFixture(ctx, div, { round: 1, homeLine: "0", awayLine: "0" });
    void fx1;
    await sql`
      insert into standings_snapshots (stage_id, org_id, pool_id, rows, previous_rows, computed_through_seq)
      values (${div.stageId}, ${ctx.orgId}, null,
        ${sql.json([
          { entrantId: div.entrantA, played: 1, won: 1, drawn: 0, lost: 0, points: 3, metrics: {}, rank: 1 },
          { entrantId: div.entrantB, played: 1, won: 0, drawn: 0, lost: 1, points: 0, metrics: {}, rank: 2 },
        ])},
        ${sql.json({ corrupt: "not an array" })},
        2)`;

    await draft(ctx, fx2);

    const recap = (await listPosts(ctx.auth, ctx.orgId)).filter((p) => p.kind === "round_recap");
    expect(recap).toHaveLength(1); // the draft was NOT dropped
    // The plain results + standings blocks (unrelated to previous_rows)
    // still render normally.
    expect(recap[0]!.bodyMd).toContain("Riverside");
    expect(recap[0]!.bodyMd).toContain("Standings");
    // The poisoned source's OWN line is genuinely absent — not silently
    // wrong, just missing, and nothing about the crash leaked into the body.
    expect(recap[0]!.bodyMd).not.toContain("climbed from");
    expect(recap[0]!.bodyMd).not.toContain("Movers");
    expect(recap[0]!.bodyMd).not.toContain("undefined");
  });
});

// W2d T17 fix 1 (I3): the news posts print a stored table through the public table's own helpers — the stage's unit
// (chess's half-points, RB2B-17) and its level test (X-TB-6, anti-goal 3: a level table's order is the seed list, so it
// has no top). The snapshot rows are the engine's own (ranked by `completeTableStage` under the sport's rule); the rules
// are whatever the one loader serves for the seeded division. Expected values are FIDE's 1 / ½ / 0, never the helpers'.
describe.skipIf(!HAS_DB)("org-posts — W2d T17 fix 1: posts print the public table's points and never a level table's top", () => {
  /** A football division made a chess one (the loader reads the division's sport), with Clara and Dmitri added. */
  async function chessDivision(ctx: Ctx): Promise<DivCtx & { ids: [string, string, string, string] }> {
    const div = await seedDivision(ctx, { autoPosts: true });
    const chess = sportOf("boardgame");
    await sql`
      update divisions set sport_key = 'boardgame', variant_key = 'classical',
        config = ${sql.json(chess.variants["classical"] as never)}, module_version = ${chess.version}
      where id = ${div.divisionId}`;
    const more = await sql<{ id: string }[]>`
      insert into entrants (division_id, org_id, kind, display_name, seed)
      values (${div.divisionId}, ${ctx.orgId}, 'individual', 'Clara', 3), (${div.divisionId}, ${ctx.orgId}, 'individual', 'Dmitri', 4)
      returning id`;
    return { ...div, ids: [div.entrantA, div.entrantB, more[0]!.id, more[1]!.id] };
  }
  const storeSnapshot = (ctx: Ctx, stageId: string, rows: unknown[]) => sql`
    insert into standings_snapshots (stage_id, org_id, pool_id, rows, computed_through_seq)
    values (${stageId}, ${ctx.orgId}, null, ${sql.json(rows as never)}, 1)`;
  const recapOf = async (ctx: Ctx) => {
    const recap = (await listPosts(ctx.auth, ctx.orgId)).filter((p) => p.kind === "round_recap");
    expect(recap, "the round is complete: one recap").toHaveLength(1);
    return recap[0]!.bodyMd;
  };
  const digestOf = (ctx: Ctx, stageId: string) =>
    withTenant(ctx.orgId, (tx) => assembleDigestStandings(tx, [{ stage_id: stageId, division_name: "Premier" }]));

  it("a chess round recap and digest print 1½ / 1 / ½ / 0 — the stored half-points never leak", async () => {
    const ctx = await seedOrg();
    const div = await chessDivision(ctx);
    // Riverside beat Northside, drew Clara, lost to Dmitri: 1 + ½ + 0 = 1½; Dmitri 1; Clara ½; Northside 0.
    await storeSnapshot(ctx, div.stageId, chessRoundRobin(div.ids).rows);
    await draft(ctx, await seedDecidedFixture(ctx, div, { round: 1 }));
    const body = await recapOf(ctx);
    expect(body).toContain("**Standings**");
    expect(body.split("\n").filter((l) => /^\d\. /.test(l))).toEqual([
      "1. Riverside — 1½ pts (3)",
      "2. Dmitri — 1 pts (1)",
      "3. Clara — ½ pts (1)",
      "4. Northside — 0 pts (1)",
    ]);
    const [section] = await digestOf(ctx, div.stageId);
    expect(section?.top3).toEqual([
      { position: 1, name: "Riverside", points: "1½" },
      { position: 2, name: "Dmitri", points: "1" },
      { position: 3, name: "Clara", points: "½" },
    ]);
  });

  it("a level table (a round closed with nothing counted) gives the recap no standings block and the digest no section; one counted result gives both back", async () => {
    const ctx = await seedOrg();
    const div = await seedDivision(ctx, { autoPosts: true });
    const level = levelLeague([div.entrantA, div.entrantB]);
    expect(level.rows.every((r) => r.level === true), "premise: the engine marks every row level").toBe(true);
    await storeSnapshot(ctx, div.stageId, level.rows);
    await draft(ctx, await seedDecidedFixture(ctx, div, { round: 1 }));
    const body = await recapOf(ctx);
    expect(body, "the results are there").toContain("Riverside 2–1 Northside");
    expect(body, "no standings block (en recap heading)").not.toContain("**Standings**");
    expect(body.split("\n").filter((l) => /^\d\. /.test(l)), "no row reads as first").toEqual([]);
    expect(await digestOf(ctx, div.stageId)).toEqual([]);
    // The pair: the same stage once a result counts (Riverside 3, Northside 0 under football's 3-1-0).
    await sql`update standings_snapshots set rows = ${sql.json([
      { entrantId: div.entrantA, played: 1, won: 1, drawn: 0, lost: 0, points: 3, metrics: {}, rank: 1 },
      { entrantId: div.entrantB, played: 1, won: 0, drawn: 0, lost: 1, points: 0, metrics: {}, rank: 2 },
    ] as never)} where stage_id = ${div.stageId} and pool_id is null`;
    expect((await digestOf(ctx, div.stageId))[0]?.top3.map((r) => [r.name, r.points])).toEqual([["Riverside", "3"], ["Northside", "0"]]);
  });
});
