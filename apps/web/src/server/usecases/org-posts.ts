import "server-only";
// SPEC-2 / PROMPT-82 — org news posts. Manual composer posts are FREE on every
// plan (the PLG ad-network thesis); the auto-drafting of result/round_recap
// posts on the decided-write seam is Pro (`news.auto`). CRUD runs on the tenant
// rail (organiser console); public reads go through the superuser sql
// connection filtered status='published' + competition visibility (the
// publicDivisionStats guard chain). Slug is slugify(title) with a `-2` collision
// suffix and FROZEN at first publish (edits after publish keep the URL — a
// data-model invariant enforced here, not just in the UI). Auto-draft
// idempotency is the V295 partial unique index (org_posts_auto_once), never an
// app pre-check; a void/re-decide stamps auto_source.stale on the DRAFT only.
import type postgres from "postgres";
import { aggregatePlayerStats, type PlayerStatRow } from "@seazn/engine/stats";
import type { EventEnvelope } from "@seazn/engine/core";
import { hhmmInTz } from "@seazn/engine/scheduling/tz";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { firePostRevalidate } from "@/server/public-site/revalidate";
import { hasFeature, requireFeature } from "@/lib/entitlements";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import { toLocale, type Locale } from "@/lib/i18n-constants";
import { resolveVenueTz } from "@/lib/tz";
import type { AuthCtx } from "@/server/api-v1/auth";
import { resolveFixtureCfg, resolveModule } from "@/server/engine-db";
import { loadLineupPair } from "@/server/engine-db/lineups";
import { entrantFoldCtx, loadEntrantMembersForFixture } from "@/server/engine-db/entrant-members";
import { log } from "@/server/logger";
import { slugify, uniqueSlug } from "./slugs";
import { recomputePlayerStats } from "./player-stats";
import {
  resultDraft,
  roundRecapDraft,
  weeklyDigestDraft,
  type ResultEnrichment,
  type RecapEnrichment,
  type DigestStandingsSection,
  type DigestLeaderLine,
  type DigestUpcomingDay,
  type DigestClaimedHighlight,
} from "@/server/news/draft-templates";
import {
  biggestClimber,
  biggestMargin,
  computeLeaderboardMoves,
  computeStreak,
  digestWindow,
  groupUpcomingByDay,
  type DigestWindow,
  type RankedEntrantRow,
  type ResultOutcome,
  type UpcomingFixture,
} from "@/server/news/enrichment";

type Tx = postgres.TransactionSql;
const superuser = sql as unknown as Tx;

export type PostKind = "news" | "result" | "round_recap" | "announcement" | "weekly_digest";
export type PostStatus = "draft" | "published" | "archived";

export interface OrgPost {
  id: string;
  orgId: string;
  competitionId: string | null;
  divisionId: string | null;
  kind: PostKind;
  status: PostStatus;
  slug: string;
  title: string;
  bodyMd: string;
  heroImagePath: string | null;
  autoSource: {
    trigger: string;
    stale?: boolean;
    fixture_id?: string;
    division_id?: string;
    stage_id?: string;
    round_no?: number;
  } | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Decided-seam triggers (auto_source.trigger). The V295 partial unique index
// keys result on fixture_id, round_recap on division_id + stage_id + round_no
// (round numbers restart per stage — fixtures' natural key is stage+round+seq).
const TRIGGER_RESULT = "fixture_decided";
const TRIGGER_RECAP = "round_complete";
// P3 (D7) — button/cron trigger for the weekly digest. V358 exempts this
// trigger from org_posts_auto_once entirely (see that migration's own
// comment): every button press is a deliberate request for a fresh draft.
const TRIGGER_DIGEST = "weekly_digest";

/** post_published fires only on the transition INTO published (mirrors
 *  competitions.shouldFireMadePublic): a publish action from any non-published
 *  status. Editing an already-published post (no action) never re-fires. */
export function shouldFirePostPublished(
  prevStatus: PostStatus,
  action: "publish" | "archive" | undefined,
): boolean {
  return action === "publish" && prevStatus !== "published";
}
// League-stage kinds carry a table, so the standings-movement line + recap make
// sense only for these (mirrors scoring.ts TABLE_KINDS).
const TABLE_KINDS = new Set(["league", "group", "swiss"]);
const DECIDED = new Set(["decided", "finalized", "forfeited"]);
const RECAP_STANDINGS_TOP = 5;

interface OrgPostRow {
  id: string;
  org_id: string;
  competition_id: string | null;
  division_id: string | null;
  kind: PostKind;
  status: PostStatus;
  slug: string;
  title: string;
  body_md: string;
  hero_image_path: string | null;
  auto_source: OrgPost["autoSource"];
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLS = (tx: Tx) => tx`
  id, org_id, competition_id, division_id, kind, status, slug, title, body_md,
  hero_image_path, auto_source, published_at, created_at, updated_at`;

function mapPost(r: OrgPostRow): OrgPost {
  return {
    id: r.id,
    orgId: r.org_id,
    competitionId: r.competition_id,
    divisionId: r.division_id,
    kind: r.kind,
    status: r.status,
    slug: r.slug,
    title: r.title,
    bodyMd: r.body_md,
    heroImagePath: r.hero_image_path,
    autoSource: r.auto_source,
    publishedAt: r.published_at ? r.published_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Console CRUD (tenant rail). Manual posts are ungated — free on every plan.
// ---------------------------------------------------------------------------

export async function listPosts(
  auth: AuthCtx,
  orgId: string,
  status?: PostStatus,
): Promise<OrgPost[]> {
  void orgId; // RLS scopes to auth.orgId; the route proved auth against this org.
  return withTenant(auth.orgId, async (tx) => {
    const rows = await tx<OrgPostRow[]>`
      select ${COLS(tx)} from org_posts
      where org_id = ${auth.orgId}
      ${status ? tx`and status = ${status}` : tx``}
      order by coalesce(published_at, created_at) desc, id`;
    return rows.map(mapPost);
  });
}

/** Assert a competition/division belongs to the auth org (defense-in-depth: FKs
 *  bypass RLS, so a cross-org scope id would otherwise FK-succeed). */
async function assertScope(
  tx: Tx,
  competitionId: string | undefined,
  divisionId: string | undefined,
): Promise<void> {
  if (competitionId) {
    const [c] = await tx`select 1 from competitions where id = ${competitionId}`;
    if (!c) throw new HttpError(404, "competition not found");
  }
  if (divisionId) {
    const [d] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!d) throw new HttpError(404, "division not found");
  }
}

export async function createPost(
  auth: AuthCtx,
  orgId: string,
  input: {
    title: string;
    bodyMd?: string;
    kind?: PostKind;
    competitionId?: string;
    divisionId?: string;
    heroImagePath?: string;
  },
): Promise<OrgPost> {
  void orgId;
  return withTenant(auth.orgId, async (tx) => {
    await assertScope(tx, input.competitionId, input.divisionId);
    const slug = await uniqueSlug(slugify(input.title), (s) => slugTaken(tx, auth.orgId, s));
    const [row] = await tx<OrgPostRow[]>`
      insert into org_posts
        (org_id, competition_id, division_id, author_user_id, kind, status, slug,
         title, body_md, hero_image_path)
      values (${auth.orgId}, ${input.competitionId ?? null}, ${input.divisionId ?? null},
              ${auth.userId}, ${input.kind ?? "news"}, 'draft', ${slug}, ${input.title},
              ${input.bodyMd ?? ""}, ${input.heroImagePath ?? null})
      returning ${COLS(tx)}`;
    const post = mapPost(row!);
    await captureServer({
      event: EVENTS.POST_CREATED,
      distinctId: auth.userId ?? `org:${auth.orgId}`,
      orgId: auth.orgId,
      properties: { kind: post.kind },
    });
    return post;
  });
}

async function slugTaken(tx: Tx, orgId: string, slug: string, exceptId?: string): Promise<boolean> {
  const [row] = await tx`
    select 1 from org_posts
    where org_id = ${orgId} and slug = ${slug}
    ${exceptId ? tx`and id <> ${exceptId}` : tx``}`;
  return !!row;
}

export async function updatePost(
  auth: AuthCtx,
  id: string,
  input: {
    title?: string;
    bodyMd?: string;
    heroImagePath?: string | null;
    competitionId?: string | null;
    divisionId?: string | null;
    action?: "publish" | "archive";
  },
): Promise<OrgPost> {
  return withTenant(auth.orgId, async (tx) => {
    const [existing] = await tx<
      { id: string; status: PostStatus; slug: string; title: string; published_at: Date | null }[]
    >`select id, status, slug, title, published_at from org_posts where id = ${id}`;
    if (!existing) throw new HttpError(404, "post not found");

    await assertScope(
      tx,
      input.competitionId ?? undefined,
      input.divisionId ?? undefined,
    );

    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (input.title !== undefined) patch.title = input.title;
    if (input.bodyMd !== undefined) patch.body_md = input.bodyMd;
    if (input.heroImagePath !== undefined) patch.hero_image_path = input.heroImagePath;
    if (input.competitionId !== undefined) patch.competition_id = input.competitionId;
    if (input.divisionId !== undefined) patch.division_id = input.divisionId;

    // Slug freeze (SPEC-2 invariant): the URL regenerates on a title change ONLY
    // while the post has never been published; once published_at is stamped the
    // slug is frozen for good (edits keep the URL), archive included.
    const neverPublished = existing.published_at === null;
    if (input.title !== undefined && input.title !== existing.title && neverPublished) {
      patch.slug = await uniqueSlug(slugify(input.title), (s) => slugTaken(tx, auth.orgId, s, id));
    }

    if (input.action === "publish") {
      patch.status = "published";
      if (neverPublished) patch.published_at = new Date(); // stamp once, then frozen
    } else if (input.action === "archive") {
      patch.status = "archived";
    }

    const cols = Object.keys(patch);
    const [row] = await tx<OrgPostRow[]>`
      update org_posts set ${tx(patch as never, ...(cols as never[]))}
      where id = ${id}
      returning ${COLS(tx)}`;
    const post = mapPost(row!);
    if (input.action) {
      // Status flipped — purge the ISR'd public page so archive/republish
      // takes effect on the next request, not after the 30s window.
      const [org] = await tx<{ slug: string }[]>`
        select slug from organizations where id = ${auth.orgId}`;
      if (org) firePostRevalidate(org.slug, post.slug);
    }
    if (shouldFirePostPublished(existing.status, input.action)) {
      await captureServer({
        event: EVENTS.POST_PUBLISHED,
        distinctId: auth.userId ?? `org:${auth.orgId}`,
        orgId: auth.orgId,
        // { kind, auto }: an auto-draft carries auto_source; a manual post does not.
        properties: { kind: post.kind, auto: post.autoSource !== null },
      });
    }
    return post;
  });
}

export async function getPost(auth: AuthCtx, id: string): Promise<OrgPost> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<OrgPostRow[]>`
      select ${COLS(tx)} from org_posts where id = ${id}`;
    if (!row) throw new HttpError(404, "post not found");
    return mapPost(row);
  });
}

export async function deletePost(auth: AuthCtx, id: string): Promise<void> {
  await withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ slug: string }[]>`
      delete from org_posts where id = ${id} returning slug`;
    if (!row) throw new HttpError(404, "post not found");
    const [org] = await tx<{ slug: string }[]>`
      select slug from organizations where id = ${auth.orgId}`;
    if (org) firePostRevalidate(org.slug, row.slug);
  });
}

// ---------------------------------------------------------------------------
// Public reads (superuser sql; published only; competition-visibility guard).
// Org-level posts (no competition) are always public — the org page has no
// visibility gate; a competition-scoped post inherits its competition's gate.
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20;

const PUBLIC_WHERE = (tx: Tx, orgSlug: string) => tx`
  o.slug = ${orgSlug}
  and p.status = 'published'
  and (p.competition_id is null or c.visibility in ('public','unlisted'))`;

export async function publicPosts(
  orgSlug: string,
  page = 0,
): Promise<{ posts: OrgPost[]; hasMore: boolean }> {
  const offset = Math.max(0, Math.trunc(page)) * PAGE_SIZE;
  const rows = await superuser<OrgPostRow[]>`
    select p.*
    from org_posts p
    join organizations o on o.id = p.org_id
    left join competitions c on c.id = p.competition_id
    where ${PUBLIC_WHERE(superuser, orgSlug)}
    order by p.published_at desc, p.id
    limit ${PAGE_SIZE + 1} offset ${offset}`;
  const hasMore = rows.length > PAGE_SIZE;
  return { posts: rows.slice(0, PAGE_SIZE).map(mapPost), hasMore };
}

export async function publicPost(orgSlug: string, postSlug: string): Promise<OrgPost> {
  const [row] = await superuser<OrgPostRow[]>`
    select p.*
    from org_posts p
    join organizations o on o.id = p.org_id
    left join competitions c on c.id = p.competition_id
    where ${PUBLIC_WHERE(superuser, orgSlug)} and p.slug = ${postSlug}`;
  if (!row) throw new HttpError(404, "post not found");
  return mapPost(row);
}

// ---------------------------------------------------------------------------
// Decided-seam auto-draft hook (SPEC-2). Called from scoring.ts on the
// decided/void write. Probes divisions.auto_posts + the live news.auto
// entitlement, builds drafts via the pure templates, inserts on-conflict-do-
// nothing. Never auto-edits/publishes/deletes; a void stamps stale on the DRAFT.
// ---------------------------------------------------------------------------

interface FixtureCtx {
  fixture_id: string;
  org_id: string;
  division_id: string;
  competition_id: string;
  stage_id: string;
  stage_kind: string;
  round_no: number | null;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  home_name: string | null;
  away_name: string | null;
  scheduled_at: Date | null;
  venue: string | null;
  venue_tz: string | null;
  division_name: string;
  competition_name: string;
  sport_key: string;
  module_version: string;
  auto_posts: boolean;
  default_locale: string | null;
}

interface SideSummary {
  entrantId: string;
  line: string;
}

function sideLine(summary: unknown, entrantId: string | null): string {
  if (!entrantId) return "";
  const perSide = (summary as { perSide?: SideSummary[] } | null)?.perSide;
  return perSide?.find((s) => s.entrantId === entrantId)?.line ?? "";
}

/**
 * `newsAuto` is passed IN rather than resolved here, and that is the whole of
 * the change: this runs inside the caller's `withTenant`, and `hasFeature`
 * queries the pooled `sql` proxy — a second pool checkout while the first
 * connection is pinned, which is the self-deadlock `lib/db.ts`'s nesting guard
 * exists to catch. The caller has an org id before it opens its transaction and
 * every caller resolves the same org, so nothing about the answer changes.
 */
export async function draftPostsForDecidedFixture(
  tx: Tx,
  fixtureId: string,
  newsAuto: boolean,
): Promise<void> {
  const [fx] = await tx<FixtureCtx[]>`
    select f.id as fixture_id, f.org_id, f.division_id, d.competition_id, f.stage_id,
           st.kind as stage_kind, f.round_no, f.status,
           f.home_entrant_id, f.away_entrant_id,
           h.display_name as home_name, a.display_name as away_name,
           f.scheduled_at, f.venue, coalesce(ss.tz, vorg.timezone, 'UTC') as venue_tz,
           d.name as division_name, c.name as competition_name,
           d.sport_key, d.module_version, d.auto_posts, o.default_locale
    from fixtures f
    join divisions d on d.id = f.division_id
    join competitions c on c.id = d.competition_id
    join organizations o on o.id = f.org_id
    join stages st on st.id = f.stage_id
    left join schedule_settings ss on ss.division_id = d.id
    left join organizations vorg on vorg.id = d.org_id
    left join entrants h on h.id = f.home_entrant_id
    left join entrants a on a.id = f.away_entrant_id
    where f.id = ${fixtureId}`;
  // Cheap probe: opt-in division only, and Pro news.auto live (a community org
  // whose toggle somehow reads true still gets no draft).
  if (!fx || !fx.auto_posts) return;
  if (!newsAuto) return;

  const locale: Locale = toLocale(fx.default_locale);
  const decided = DECIDED.has(fx.status);

  if (!decided) {
    // A void erased the decision → stamp stale on the DRAFT(s) for this fixture /
    // round; published posts are never touched (SPEC-2). Re-decide re-enters via
    // the decided branch and the unique index keeps the count at one.
    await staleDrafts(tx, fx);
    return;
  }

  await draftResult(tx, fx, locale);
  if (fx.round_no !== null && TABLE_KINDS.has(fx.stage_kind)) {
    await maybeDraftRecap(tx, fx, locale);
  }
}

async function staleDrafts(tx: Tx, fx: FixtureCtx): Promise<void> {
  await tx`
    update org_posts
    set auto_source = coalesce(auto_source, '{}'::jsonb) || jsonb_build_object('stale', true),
        updated_at = now()
    where org_id = ${fx.org_id} and status = 'draft'
      and auto_source->>'trigger' = ${TRIGGER_RESULT}
      and auto_source->>'fixture_id' = ${fx.fixture_id}`;
  if (fx.round_no !== null) {
    await tx`
      update org_posts
      set auto_source = coalesce(auto_source, '{}'::jsonb) || jsonb_build_object('stale', true),
          updated_at = now()
      where org_id = ${fx.org_id} and status = 'draft'
        and auto_source->>'trigger' = ${TRIGGER_RECAP}
        and auto_source->>'division_id' = ${fx.division_id}
        and auto_source->>'stage_id' = ${fx.stage_id}
        and auto_source->>'round_no' = ${String(fx.round_no)}`;
  }
}

async function draftResult(tx: Tx, fx: FixtureCtx, locale: Locale): Promise<void> {
  const [state] = await tx<{ summary: unknown }[]>`
    select summary from match_states where fixture_id = ${fx.fixture_id}`;
  const scorers = await extractScorers(tx, fx);
  const movement = TABLE_KINDS.has(fx.stage_kind)
    ? await winnerMovement(tx, fx)
    : null;
  const enrichment = await assembleResultEnrichment(tx, fx, scorers);
  const enriched = Object.keys(enrichment).length > 0;

  const { title, bodyMd } = resultDraft({
    locale,
    homeName: fx.home_name ?? "TBD",
    awayName: fx.away_name ?? "TBD",
    homeScore: sideLine(state?.summary, fx.home_entrant_id),
    awayScore: sideLine(state?.summary, fx.away_entrant_id),
    competitionName: fx.competition_name,
    divisionName: fx.division_name,
    venue: fx.venue,
    scheduledAt: fx.scheduled_at ? fx.scheduled_at.toISOString() : null,
    venueTz: fx.venue_tz,
    ...(scorers.length > 0 ? { scorers } : {}),
    movement,
    ...(enriched ? { enrichment } : {}),
  });

  const autoSource = {
    trigger: TRIGGER_RESULT,
    fixture_id: fx.fixture_id,
    division_id: fx.division_id,
    ...(fx.round_no !== null ? { round_no: fx.round_no } : {}),
    stale: false,
  };
  await insertDraft(tx, fx, "result", title, bodyMd, autoSource, enriched);
}

async function maybeDraftRecap(tx: Tx, fx: FixtureCtx, locale: Locale): Promise<void> {
  const roundNo = fx.round_no!;
  // Round numbers restart per stage (natural key stage+round+seq) — scope the
  // completeness probe to THIS stage, else a scheduled knockout round 1 blocks
  // the group round 1 recap forever.
  const [{ open }] = await tx<{ open: number }[]>`
    select count(*) filter (where status not in ('decided','finalized','forfeited'))::int as open
    from fixtures
    where division_id = ${fx.division_id} and stage_id = ${fx.stage_id} and round_no = ${roundNo}`;
  if (open > 0) return; // round not complete yet

  const resultRows = await tx<
    { home_name: string | null; away_name: string | null; home_id: string | null; away_id: string | null; summary: unknown }[]
  >`
    select h.display_name as home_name, a.display_name as away_name,
           f.home_entrant_id as home_id, f.away_entrant_id as away_id, m.summary
    from fixtures f
    left join entrants h on h.id = f.home_entrant_id
    left join entrants a on a.id = f.away_entrant_id
    left join match_states m on m.fixture_id = f.id
    where f.division_id = ${fx.division_id} and f.stage_id = ${fx.stage_id} and f.round_no = ${roundNo}
    order by f.fixture_no nulls last, f.id`;
  const results = resultRows.map((r) => ({
    homeName: r.home_name ?? "TBD",
    awayName: r.away_name ?? "TBD",
    homeScore: sideLine(r.summary, r.home_id),
    awayScore: sideLine(r.summary, r.away_id),
  }));

  const standings = await topStandings(tx, fx.stage_id);
  const enrichment = await assembleRecapEnrichment(tx, fx, results);
  const enriched = Object.keys(enrichment).length > 0;

  const { title, bodyMd } = roundRecapDraft({
    locale,
    competitionName: fx.competition_name,
    divisionName: fx.division_name,
    roundNo,
    results,
    standings,
    ...(enriched ? { enrichment } : {}),
  });
  const autoSource = {
    trigger: TRIGGER_RECAP,
    division_id: fx.division_id,
    stage_id: fx.stage_id,
    round_no: roundNo,
    stale: false,
  };
  await insertDraft(tx, fx, "round_recap", title, bodyMd, autoSource, enriched);
}

async function insertDraft(
  tx: Tx,
  fx: FixtureCtx,
  kind: PostKind,
  title: string,
  bodyMd: string,
  autoSource: Record<string, unknown>,
  enriched: boolean,
): Promise<void> {
  const row = await insertGeneratedPost(tx, {
    orgId: fx.org_id,
    competitionId: fx.competition_id,
    divisionId: fx.division_id,
    kind,
    title,
    bodyMd,
    autoSource,
  });
  // Only on a REAL insert — the auto-once index (V295) on-conflict-do-nothing
  // skips a repeat firing for the same fixture/round, and that idempotent
  // no-op must not be logged as a fresh draft.
  if (row) {
    log.info(
      { orgId: fx.org_id, fixtureId: fx.fixture_id, divisionId: fx.division_id, kind, enriched },
      "post_drafted",
    );
  }
}

/**
 * Low-level insert shared by the fixture-scoped auto-drafts (`insertDraft`,
 * on-conflict-do-nothing against `org_posts_auto_once`) and the org-level
 * weekly digest (`generateWeeklyDigest`, no fixture/division/stage/round to
 * key on — V358 exempts `weekly_digest` from that index entirely, so this
 * `on conflict do nothing` never has a matching constraint to trigger for
 * it and every digest press inserts a fresh row).
 */
async function insertGeneratedPost(
  tx: Tx,
  params: {
    orgId: string;
    competitionId: string | null;
    divisionId: string | null;
    kind: PostKind;
    title: string;
    bodyMd: string;
    autoSource: Record<string, unknown>;
  },
): Promise<{ id: string } | null> {
  const slug = await uniqueSlug(slugify(params.title), (s) => slugTaken(tx, params.orgId, s));
  const rows = await tx<{ id: string }[]>`
    insert into org_posts
      (org_id, competition_id, division_id, author_user_id, kind, status, slug,
       title, body_md, auto_source)
    values (${params.orgId}, ${params.competitionId}, ${params.divisionId}, null, ${params.kind}, 'draft',
            ${slug}, ${params.title}, ${params.bodyMd}, ${tx.json(params.autoSource as never)})
    on conflict do nothing
    returning id`;
  return rows[0] ?? null;
}

/** Scorers list for the result draft: the fixture's ledger folded through the
 *  sport's playerStats model on the "goals" metric (best-effort — a fold hiccup
 *  yields no scorers line, never a failed draft). */
async function extractScorers(
  tx: Tx,
  fx: FixtureCtx,
): Promise<{ name: string; count: number; personId: string }[]> {
  try {
    const model = resolveModule(fx.sport_key, fx.module_version).playerStats;
    if (!model) return [];
    const metric =
      model.metrics.find((m) => m.key === "goals") ?? model.metrics[0];
    if (!metric) return [];
    const events = await tx<
      { id: string; seq: number; type: string; payload: unknown; voids_event_id: string | null }[]
    >`
      select id, seq, type, payload, voids_event_id from score_events
      where fixture_id = ${fx.fixture_id} order by seq`;
    const ledger = events.map(
      (e) =>
        ({
          id: e.id,
          seq: e.seq,
          type: e.type,
          payload: e.payload,
          recordedAt: new Date().toISOString(),
          ...(e.voids_event_id !== null ? { voids: e.voids_event_id } : {}),
        }) as EventEnvelope,
    );
    // S4 (#428) review round 1, finding 1 — same role discriminator as
    // player-stats.ts: a non-player (coach/staff) must not appear in a
    // scorers line either. Single fixture here, so the plain per-fixture
    // loader (`recomputePlayerStats` batches for a whole division instead).
    const lineups =
      fx.home_entrant_id && fx.away_entrant_id
        ? await loadLineupPair(tx, fx.fixture_id, fx.home_entrant_id, fx.away_entrant_id)
        : undefined;
    // S8/#417 — the SAME entrant→person fallback ctx player-stats.ts's
    // recomputePlayerStats builds, at this SECOND aggregatePlayerStats call
    // site (S4/#428's review finding: wiring one call site and not the other
    // is exactly how this class of bug ships). Single fixture here, so a
    // single-fixture cfg resolve — same three inputs `fold.ts`'s
    // `foldFixture` reads (config_snapshot, division.config, stage.config) —
    // rather than the division-batched query the division-wide recompute uses.
    const [fixtureCfgRow] = await tx<{ config_snapshot: unknown }[]>`
      select config_snapshot from fixtures where id = ${fx.fixture_id}`;
    const [divisionCfgRow] = await tx<{ config: unknown }[]>`
      select config from divisions where id = ${fx.division_id}`;
    const [stageCfgRow] = await tx<{ config: Record<string, unknown> | null }[]>`
      select config from stages where id = ${fx.stage_id}`;
    const cfg = resolveFixtureCfg(
      fixtureCfgRow?.config_snapshot,
      divisionCfgRow?.config,
      stageCfgRow?.config,
    );
    // S8/#417 W6 review round 2, fix 2 — the fixture-scoped loader, not
    // loadEntrantMembersForDivision: this function is single-fixture (see
    // this function's own doc comment above), so pulling the WHOLE
    // division's roster for two entrants was O(division roster) work
    // repeated on every fixture-decided write where O(1) is what is needed.
    const entrantMembers = await loadEntrantMembersForFixture(tx, fx.home_entrant_id, fx.away_entrant_id);
    const ctx = entrantFoldCtx(fx.home_entrant_id, fx.away_entrant_id, entrantMembers, cfg);
    const rows = aggregatePlayerStats(ledger, model, lineups, ctx)
      .filter((r) => (r.stats[metric.key] ?? 0) > 0)
      .sort((a, b) => (b.stats[metric.key] ?? 0) - (a.stats[metric.key] ?? 0));
    if (rows.length === 0) return [];
    const names = new Map(
      (
        await tx<{ id: string; full_name: string }[]>`
          select id, full_name from persons where id = any(${rows.map((r) => r.personId)})`
      ).map((p) => [p.id, p.full_name]),
    );
    return rows
      .filter((r) => names.has(r.personId))
      .map((r) => ({ name: names.get(r.personId)!, count: r.stats[metric.key] ?? 0, personId: r.personId }));
  } catch {
    return [];
  }
}

/** Up to `limit` recent decided results for `entrantId` within one stage
 *  (round numbers restart per stage, same scoping discipline as the
 *  round-recap completeness probe), most-recent-first — the input
 *  `computeStreak` (enrichment.ts) wants. Best-effort: an outcome shape this
 *  function does not recognise reads as a draw rather than throwing, since a
 *  wrong streak line is a worse failure mode than a missing one only when it
 *  silently corrupts data — here it can only under-report a streak. */
async function entrantRecentOutcomes(
  tx: Tx,
  divisionId: string,
  stageId: string,
  entrantId: string,
  limit: number,
): Promise<ResultOutcome[]> {
  const rows = await tx<
    { outcome: unknown; home_entrant_id: string | null; away_entrant_id: string | null }[]
  >`
    select outcome, home_entrant_id, away_entrant_id
    from fixtures
    where division_id = ${divisionId} and stage_id = ${stageId}
      and status in ('decided','finalized','forfeited')
      and (home_entrant_id = ${entrantId} or away_entrant_id = ${entrantId})
    order by round_no desc, fixture_no desc nulls last, id desc
    limit ${limit}`;
  return rows.map((r): ResultOutcome => {
    const o = r.outcome as { kind?: string; winner?: string } | null;
    if (!o || o.kind === "draw") return "draw";
    return o.winner === entrantId ? "win" : "loss";
  });
}

/**
 * P3 (D7) — one pure helper per source, each wrapped so a source erroring
 * drops ONLY its own field (Failure matrix: "match summary read fails ->
 * result draft plain, warn logged"). Returns `{}` (no keys) when every
 * source came back empty/failed — the caller treats an empty object as "no
 * enrichment" for both rendering and the `enriched` flag on `post_drafted`.
 */
async function assembleResultEnrichment(
  tx: Tx,
  fx: FixtureCtx,
  scorers: { name: string; count: number; personId: string }[],
): Promise<ResultEnrichment> {
  const out: ResultEnrichment = {};
  if (scorers.length === 0) return out;

  let metric: { key: string; label: string } | undefined;
  try {
    const model = resolveModule(fx.sport_key, fx.module_version).playerStats;
    metric = model?.metrics.find((m) => m.key === "goals") ?? model?.metrics[0];
  } catch (err) {
    log.warn(
      { fixtureId: fx.fixture_id, source: "topPerformers", err: String(err) },
      "news enrichment: source failed, dropping section",
    );
  }

  if (metric) {
    // A highlight, not a roster — the existing `scorers` block already lists
    // everyone; cap at 2 so this reads as "who stood out", not a duplicate.
    out.topPerformers = scorers
      .slice(0, 2)
      .map((s) => ({ personName: s.name, statLine: `${s.count} ${metric!.label.toLowerCase()}` }));

    try {
      const { rows } = await recomputePlayerStats(tx, fx.division_id);
      const after = rows.map((r) => ({ personId: r.personId, personName: "", value: r.stats[metric!.key] ?? 0 }));
      const contributions = scorers.map((s) => ({ personId: s.personId, personName: s.name, credit: s.count }));
      const moves = computeLeaderboardMoves(after, contributions, metric.label);
      if (moves.length > 0) out.leaderboardMoves = moves;
    } catch (err) {
      log.warn(
        { fixtureId: fx.fixture_id, source: "leaderboardMoves", err: String(err) },
        "news enrichment: source failed, dropping section",
      );
    }
  }

  if (TABLE_KINDS.has(fx.stage_kind)) {
    try {
      const [row] = await tx<{ outcome: unknown }[]>`
        select outcome from fixtures where id = ${fx.fixture_id}`;
      const outcome = row?.outcome as { kind?: string; winner?: string } | null;
      if (outcome && (outcome.kind === "win" || outcome.kind === "award") && outcome.winner) {
        const [entrant] = await tx<{ display_name: string }[]>`
          select display_name from entrants where id = ${outcome.winner}`;
        const recent = await entrantRecentOutcomes(tx, fx.division_id, fx.stage_id, outcome.winner, 10);
        const streak = computeStreak(recent);
        if (streak && entrant) {
          out.streak = { entrantName: entrant.display_name, kind: streak.kind, length: streak.length };
        }
      }
    } catch (err) {
      log.warn(
        { fixtureId: fx.fixture_id, source: "streak", err: String(err) },
        "news enrichment: source failed, dropping section",
      );
    }
  }

  return out;
}

/** Same one-helper-per-source, fail-open discipline as
 *  assembleResultEnrichment, for the round-recap draft. `results` is the
 *  SAME array `maybeDraftRecap` already built for the plain results list —
 *  biggestMargin reads it, it is never refetched. */
async function assembleRecapEnrichment(
  tx: Tx,
  fx: FixtureCtx,
  results: { homeName: string; homeScore: string; awayName: string; awayScore: string }[],
): Promise<RecapEnrichment> {
  const out: RecapEnrichment = {};

  try {
    const { rows, hasModel } = await recomputePlayerStats(tx, fx.division_id);
    if (hasModel && rows.length > 0) {
      const model = resolveModule(fx.sport_key, fx.module_version).playerStats;
      const metric = model?.metrics.find((m) => m.key === "goals") ?? model?.metrics[0];
      if (metric) {
        const top = [...rows].sort((a, b) => (b.stats[metric.key] ?? 0) - (a.stats[metric.key] ?? 0))[0];
        if (top && (top.stats[metric.key] ?? 0) > 0) {
          const [person] = await tx<{ full_name: string }[]>`
            select full_name from persons where id = ${top.personId}`;
          if (person) {
            out.leaders = [{ metric: metric.label, personName: person.full_name, value: top.stats[metric.key] ?? 0 }];
          }
        }
      }
    }
  } catch (err) {
    log.warn(
      { divisionId: fx.division_id, source: "recapLeaders", err: String(err) },
      "news enrichment: source failed, dropping section",
    );
  }

  try {
    const margin = biggestMargin(results);
    if (margin) out.biggestResult = margin;
  } catch (err) {
    log.warn(
      { divisionId: fx.division_id, source: "biggestResult", err: String(err) },
      "news enrichment: source failed, dropping section",
    );
  }

  try {
    const [snap] = await tx<{ rows: RankedEntrantRow[]; previous_rows: RankedEntrantRow[] | null }[]>`
      select rows, previous_rows from standings_snapshots
      where stage_id = ${fx.stage_id} and pool_id is null`;
    if (snap) {
      const climber = biggestClimber(snap.rows, snap.previous_rows);
      if (climber) {
        const [entrant] = await tx<{ display_name: string }[]>`
          select display_name from entrants where id = ${climber.entrantId}`;
        if (entrant) out.standingsMoves = [{ entrantName: entrant.display_name, from: climber.from, to: climber.to }];
      }
    }
  } catch (err) {
    log.warn(
      { divisionId: fx.division_id, source: "standingsMoves", err: String(err) },
      "news enrichment: source failed, dropping section",
    );
  }

  return out;
}

/** The just-won entrant's current table position, for the "moves up to Nth"
 *  line (league stages only; best-effort). */
async function winnerMovement(
  tx: Tx,
  fx: FixtureCtx,
): Promise<{ team: string; position: number } | null> {
  try {
    const [state] = await tx<{ outcome: unknown }[]>`
      select outcome from fixtures where id = ${fx.fixture_id}`;
    const outcome = state?.outcome as { kind?: string; winner?: string } | null;
    if (!outcome || (outcome.kind !== "win" && outcome.kind !== "award") || !outcome.winner) {
      return null;
    }
    const rows = await topStandings(tx, fx.stage_id, Number.MAX_SAFE_INTEGER);
    const [row] = await tx<{ display_name: string }[]>`
      select display_name from entrants where id = ${outcome.winner}`;
    const idx = rows.findIndex((r) => r.entrantId === outcome.winner);
    if (idx < 0 || !row) return null;
    return { team: row.display_name, position: rows[idx]!.position };
  } catch {
    return null;
  }
}

interface StandingRow {
  entrantId: string;
  position: number;
  name: string;
  played: number;
  points: number;
}

/** Top of the stage table from standings_snapshots (JSON rows), entrant names
 *  resolved, ranked by the engine's `rank` (falls back to array order). */
async function topStandings(tx: Tx, stageId: string, top = RECAP_STANDINGS_TOP): Promise<StandingRow[]> {
  const rows = await tx<
    { rows: { entrantId: string; played: number; points: number; rank?: number }[] }[]
  >`
    select rows from standings_snapshots where stage_id = ${stageId} and pool_id is null`;
  const table = rows[0]?.rows;
  if (!table || table.length === 0) return [];
  const sorted = [...table].sort(
    (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER),
  );
  const wanted = sorted.slice(0, top);
  const names = new Map(
    (
      await tx<{ id: string; display_name: string }[]>`
        select id, display_name from entrants where id = any(${wanted.map((r) => r.entrantId)})`
    ).map((e) => [e.id, e.display_name]),
  );
  return wanted.map((r, i) => ({
    entrantId: r.entrantId,
    position: r.rank ?? i + 1,
    name: names.get(r.entrantId) ?? "—",
    played: r.played,
    points: r.points,
  }));
}

// ---------------------------------------------------------------------------
// Weekly digest (P3 / D7). Two callers: the console button
// (generateWeeklyDigest, auth-gated, always creates a draft even when
// every section is empty — "A missing DRAFT (any path) is a defect")
// and the stg cron sweep (sweepWeeklyDigests, no AuthCtx — an automated
// weekly run for an org with genuinely nothing to report skips it instead
// of spamming an empty post; a HUMAN pressing the button gets a definite
// answer either way).
// ---------------------------------------------------------------------------

interface ActiveDivision {
  division_id: string;
  division_name: string;
  sport_key: string;
  module_version: string;
}

interface ActiveTableStage {
  stage_id: string;
  division_name: string;
}

const DECIDED_STATUSES = ["decided", "finalized", "forfeited"] as const;

/** Divisions with >=1 fixture the fold last touched inside the window
 *  (`match_states.updated_at`, not `scheduled_at` — a late-recorded result
 *  still counts as "happened this week", the same recompute-on-read
 *  discipline the rest of this file uses). */
async function activeDivisionsInWindow(tx: Tx, orgId: string, window: DigestWindow): Promise<ActiveDivision[]> {
  return tx<ActiveDivision[]>`
    select distinct d.id as division_id, d.name as division_name, d.sport_key, d.module_version
    from fixtures f
    join match_states m on m.fixture_id = f.id
    join divisions d on d.id = f.division_id
    where f.org_id = ${orgId} and f.status in ${tx(DECIDED_STATUSES as unknown as string[])}
      and m.updated_at >= ${window.start}::timestamptz and m.updated_at < ${window.end}::timestamptz`;
}

/** Same window probe, scoped to TABLE_KINDS stages only (standings movement
 *  makes sense only where there is a table — mirrors org-posts.ts's own
 *  TABLE_KINDS gate on the round-recap trigger). */
async function activeTableStagesInWindow(tx: Tx, orgId: string, window: DigestWindow): Promise<ActiveTableStage[]> {
  return tx<ActiveTableStage[]>`
    select distinct s.id as stage_id, d.name as division_name
    from fixtures f
    join match_states m on m.fixture_id = f.id
    join stages s on s.id = f.stage_id
    join divisions d on d.id = f.division_id
    where f.org_id = ${orgId} and f.status in ${tx(DECIDED_STATUSES as unknown as string[])}
      and s.kind in ${tx([...TABLE_KINDS])}
      and m.updated_at >= ${window.start}::timestamptz and m.updated_at < ${window.end}::timestamptz`;
}

async function assembleDigestStandings(
  tx: Tx,
  stages: readonly ActiveTableStage[],
): Promise<DigestStandingsSection[]> {
  const out: DigestStandingsSection[] = [];
  for (const stage of stages) {
    const [snap] = await tx<{ rows: RankedEntrantRow[]; previous_rows: RankedEntrantRow[] | null }[]>`
      select rows, previous_rows from standings_snapshots
      where stage_id = ${stage.stage_id} and pool_id is null`;
    if (!snap || snap.rows.length === 0) continue;
    const sorted = [...snap.rows].sort(
      (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER),
    );
    const top3 = sorted.slice(0, 3);
    if (top3.length === 0) continue;
    const names = new Map(
      (
        await tx<{ id: string; display_name: string }[]>`
          select id, display_name from entrants where id = any(${top3.map((r) => r.entrantId)})`
      ).map((e) => [e.id, e.display_name]),
    );
    let climberOut: DigestStandingsSection["climber"];
    const climber = biggestClimber(snap.rows, snap.previous_rows);
    if (climber) {
      const [entrant] = await tx<{ display_name: string }[]>`
        select display_name from entrants where id = ${climber.entrantId}`;
      if (entrant) climberOut = { entrantName: entrant.display_name, from: climber.from, to: climber.to };
    }
    out.push({
      divisionName: stage.division_name,
      top3: top3.map((r, i) => ({
        position: r.rank ?? i + 1,
        name: names.get(r.entrantId) ?? "—",
        points: r.points,
      })),
      ...(climberOut ? { climber: climberOut } : {}),
    });
  }
  return out;
}

interface DivisionHeadline {
  metric: { key: string; label: string };
  rows: PlayerStatRow[];
}

/** One `recomputePlayerStats` + headline-metric resolution per active
 *  division, shared by assembleDigestLeaders and assembleDigestClaimed so
 *  neither recomputes the same division's stats twice. */
async function loadDivisionHeadlines(
  tx: Tx,
  divisions: readonly ActiveDivision[],
): Promise<Map<string, DivisionHeadline>> {
  const out = new Map<string, DivisionHeadline>();
  for (const div of divisions) {
    const model = resolveModule(div.sport_key, div.module_version).playerStats;
    const metric = model?.metrics.find((m) => m.key === "goals") ?? model?.metrics[0];
    if (!metric) continue;
    const { rows } = await recomputePlayerStats(tx, div.division_id);
    if (rows.length > 0) out.set(div.division_id, { metric, rows });
  }
  return out;
}

/** Top metric leader per active division — the CURRENT cumulative value
 *  divisionPlayerStats already emits, never a window-scoped diff (design
 *  ruling: "never derived ad hoc"). */
async function assembleDigestLeaders(
  tx: Tx,
  divisions: readonly ActiveDivision[],
  headlines: ReadonlyMap<string, DivisionHeadline>,
): Promise<DigestLeaderLine[]> {
  const out: DigestLeaderLine[] = [];
  for (const div of divisions) {
    const h = headlines.get(div.division_id);
    if (!h) continue;
    const top = [...h.rows].sort((a, b) => (b.stats[h.metric.key] ?? 0) - (a.stats[h.metric.key] ?? 0))[0];
    if (!top || (top.stats[h.metric.key] ?? 0) <= 0) continue;
    const [person] = await tx<{ full_name: string }[]>`
      select full_name from persons where id = ${top.personId}`;
    if (!person) continue;
    out.push({
      divisionName: div.division_name,
      metricLabel: h.metric.label,
      personName: person.full_name,
      value: top.stats[h.metric.key] ?? 0,
    });
  }
  return out;
}

/** At most one: the CLAIMED person (persons.user_id not null, same
 *  discriminator player-stats.ts's countMatchesByDivision "claimedPersons"
 *  branch uses) with the best current headline-metric value, among those
 *  who actually played a fixture decided WITHIN the window — eligibility is
 *  window-scoped, the displayed value is the same current cumulative total
 *  assembleDigestLeaders reads (never a window diff). */
async function assembleDigestClaimed(
  tx: Tx,
  divisions: readonly ActiveDivision[],
  headlines: ReadonlyMap<string, DivisionHeadline>,
  window: DigestWindow,
): Promise<DigestClaimedHighlight | undefined> {
  let best: { value: number; personName: string; statLine: string } | undefined;
  for (const div of divisions) {
    const h = headlines.get(div.division_id);
    if (!h) continue;
    const claimed = await tx<{ person_id: string; full_name: string }[]>`
      select distinct p.id as person_id, p.full_name
      from entrant_members em
      join persons p on p.id = em.person_id and p.user_id is not null and p.merged_into is null
      join fixtures f on f.division_id = ${div.division_id}
        and em.entrant_id in (f.home_entrant_id, f.away_entrant_id)
      join match_states m on m.fixture_id = f.id
      where f.status in ${tx(DECIDED_STATUSES as unknown as string[])}
        and m.updated_at >= ${window.start}::timestamptz and m.updated_at < ${window.end}::timestamptz`;
    if (claimed.length === 0) continue;
    const statsByPerson = new Map(h.rows.map((r) => [r.personId, r.stats[h.metric.key] ?? 0]));
    for (const cp of claimed) {
      const value = statsByPerson.get(cp.person_id) ?? 0;
      if (value <= 0) continue;
      if (!best || value > best.value) {
        best = { value, personName: cp.full_name, statLine: `${value} ${h.metric.label.toLowerCase()}` };
      }
    }
  }
  return best ? { personName: best.personName, statLine: best.statLine } : undefined;
}

/** Next-7-days fixtures, org-wide, grouped by org-local day and capped at 10
 *  (design). The lookahead boundary is a flat +7d duration, not the
 *  calendar-exact arithmetic `digestWindow` uses for the lookback — only the
 *  lookback window's DST behaviour is a stated acceptance criterion, and a
 *  fixture landing a few hours either side of the cutoff has no product
 *  consequence the way the digest's OWN window boundary would. */
async function assembleDigestUpcoming(
  tx: Tx,
  orgId: string,
  nowMs: number,
  orgTz: string,
): Promise<{ upcoming: DigestUpcomingDay[]; overflow: number }> {
  const nowIso = new Date(nowMs).toISOString();
  const endIso = new Date(nowMs + 7 * 24 * 3600_000).toISOString();
  const rows = await tx<
    {
      id: string;
      home_name: string | null;
      away_name: string | null;
      scheduled_at: Date;
      competition_name: string;
      division_name: string;
    }[]
  >`
    select f.id, h.display_name as home_name, a.display_name as away_name, f.scheduled_at,
           c.name as competition_name, d.name as division_name
    from fixtures f
    join divisions d on d.id = f.division_id
    join competitions c on c.id = d.competition_id
    left join entrants h on h.id = f.home_entrant_id
    left join entrants a on a.id = f.away_entrant_id
    where f.org_id = ${orgId} and f.status = 'scheduled'
      and f.scheduled_at >= ${nowIso}::timestamptz and f.scheduled_at < ${endIso}::timestamptz
    order by f.scheduled_at`;
  const fixtures: UpcomingFixture[] = rows.map((r) => ({
    id: r.id,
    homeName: r.home_name ?? "TBD",
    awayName: r.away_name ?? "TBD",
    scheduledAt: r.scheduled_at.toISOString(),
    competitionName: r.competition_name,
    divisionName: r.division_name,
  }));
  const { groups, overflow } = groupUpcomingByDay(fixtures, orgTz, 10);
  return {
    upcoming: groups.map((g) => ({
      dayYmd: g.dayYmd,
      lines: g.fixtures.map((f) => ({
        homeName: f.homeName,
        awayName: f.awayName,
        timeLabel: hhmmInTz(Date.parse(f.scheduledAt), orgTz),
      })),
    })),
    overflow,
  };
}

/**
 * The shared core behind both callers below. `skipIfEmpty` is what tells
 * them apart: the button caller never sets it (a human asked, they get an
 * answer, even an empty one — "a missing DRAFT is a defect"); the cron
 * sweep sets it so a silent org's automated weekly run creates nothing
 * rather than a blank post every week.
 */
async function digestForOrg(
  tx: Tx,
  orgId: string,
  nowMs: number,
  opts: { skipIfEmpty?: boolean } = {},
): Promise<OrgPost | null> {
  const [org] = await tx<{ name: string; timezone: string | null; default_locale: string | null }[]>`
    select name, timezone, default_locale from organizations where id = ${orgId}`;
  if (!org) throw new HttpError(404, "organization not found");
  const orgTz = resolveVenueTz(null, org.timezone);
  const locale = toLocale(org.default_locale);
  const window = digestWindow(nowMs, orgTz);

  const divisions = await activeDivisionsInWindow(tx, orgId, window);
  const stages = await activeTableStagesInWindow(tx, orgId, window);
  const headlines = await loadDivisionHeadlines(tx, divisions);

  let standings: DigestStandingsSection[] = [];
  try {
    standings = await assembleDigestStandings(tx, stages);
  } catch (err) {
    log.warn({ orgId, source: "digestStandings", err: String(err) }, "news enrichment: source failed, dropping section");
  }

  let leaders: DigestLeaderLine[] = [];
  try {
    leaders = await assembleDigestLeaders(tx, divisions, headlines);
  } catch (err) {
    log.warn({ orgId, source: "digestLeaders", err: String(err) }, "news enrichment: source failed, dropping section");
  }

  let upcoming: DigestUpcomingDay[] = [];
  let upcomingOverflow = 0;
  try {
    const res = await assembleDigestUpcoming(tx, orgId, nowMs, orgTz);
    upcoming = res.upcoming;
    upcomingOverflow = res.overflow;
  } catch (err) {
    log.warn({ orgId, source: "digestUpcoming", err: String(err) }, "news enrichment: source failed, dropping section");
  }

  let claimedHighlight: DigestClaimedHighlight | undefined;
  try {
    claimedHighlight = await assembleDigestClaimed(tx, divisions, headlines, window);
  } catch (err) {
    log.warn({ orgId, source: "digestClaimed", err: String(err) }, "news enrichment: source failed, dropping section");
  }

  const enriched =
    standings.length > 0 || leaders.length > 0 || upcoming.length > 0 || claimedHighlight !== undefined;
  if (!enriched && opts.skipIfEmpty) return null;

  const { title, bodyMd } = weeklyDigestDraft({
    locale,
    orgName: org.name,
    weekOfYmd: window.weekOfYmd,
    standings,
    leaders,
    upcoming,
    upcomingOverflow,
    ...(claimedHighlight ? { claimedHighlight } : {}),
  });

  const autoSource = { trigger: TRIGGER_DIGEST, window_start: window.start, window_end: window.end };
  const inserted = await insertGeneratedPost(tx, {
    orgId,
    competitionId: null,
    divisionId: null,
    kind: "weekly_digest",
    title,
    bodyMd,
    autoSource,
  });
  // Unreachable in practice: V358 exempts weekly_digest from the only unique
  // index `on conflict do nothing` guards against, so this insert has no
  // constraint left to collide with. Guarded rather than asserted with `!`
  // so a future re-introduction of a digest uniqueness rule fails loud here
  // instead of a silent `mapPost(undefined)`.
  if (!inserted) throw new HttpError(500, "digest draft insert failed unexpectedly");
  log.info(
    { orgId, fixtureId: null, divisionId: null, kind: "weekly_digest" as const, enriched },
    "post_drafted",
  );
  const [row] = await tx<OrgPostRow[]>`select ${COLS(tx)} from org_posts where id = ${inserted.id}`;
  return mapPost(row!);
}

/** POST /orgs/{id}/posts/digest (console button). Pro `news.auto` — same
 *  entitlement as the system auto-drafts: a digest is system-COMPOSED
 *  content (assembled from stats), not organiser-authored, same PLG line
 *  the V295 migration draws between manual (free) and generated (Pro). */
export async function generateWeeklyDigest(auth: AuthCtx, orgId: string): Promise<OrgPost> {
  void orgId; // RLS scopes to auth.orgId; the route proved auth against this org.
  await requireFeature(auth.orgId, "news.auto");
  const post = await withTenant(auth.orgId, (tx) => digestForOrg(tx, auth.orgId, Date.now()));
  // skipIfEmpty is not set above, so digestForOrg cannot return null here.
  if (!post) throw new HttpError(500, "digest generation failed unexpectedly");
  return post;
}

/** The stg cron sweep (`/api/cron/news-digest`, no AuthCtx — a system
 *  trigger, not a user session). Every org table row is checked for the
 *  entitlement directly (`hasFeature`, the same resolver the button path's
 *  `requireFeature` uses) rather than pre-filtering by plan in SQL — the
 *  resolver already accounts for Event Passes, billing-group overrides and
 *  trials, and re-deriving that logic here is exactly how it would drift. */
export async function sweepWeeklyDigests(
  nowMs: number = Date.now(),
): Promise<{ orgsChecked: number; digestsCreated: number }> {
  const orgIds = (await superuser<{ id: string }[]>`select id from organizations`).map((r) => r.id);
  let digestsCreated = 0;
  for (const orgId of orgIds) {
    if (!(await hasFeature(orgId, "news.auto"))) continue;
    try {
      const post = await withTenant(orgId, (tx) => digestForOrg(tx, orgId, nowMs, { skipIfEmpty: true }));
      if (post) digestsCreated += 1;
    } catch (err) {
      log.warn({ orgId, err: String(err) }, "weekly digest sweep: org failed, continuing with the rest");
    }
  }
  return { orgsChecked: orgIds.length, digestsCreated };
}
