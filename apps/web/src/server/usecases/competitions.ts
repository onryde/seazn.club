import "server-only";
// Competition use-cases (doc 08 §3). The service layer both /api/v1 routes and
// Server Components call — the only writer. Auth happens in the route (an
// AuthCtx proves it); tenancy is enforced by withTenant + RLS.
import { z } from "zod";
import { sql, withTenant } from "@/lib/db";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { invalidateOrgEntitlements, requireFeature, withinLimit } from "@/lib/entitlements";
import { publicDashboardsReason } from "@/lib/feature-copy";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS, type AnalyticsEvent } from "@/lib/analytics-events";
import { log } from "@/server/logger";
import type { AuthCtx } from "@/server/api-v1/auth";
import { page, type ListQuery, type Page } from "@/server/api-v1/http";
import { CompetitionStatus, ENDS_BEFORE_STARTS, type CreateCompetition, type PatchCompetition, type PublicQuotaDegraded } from "@/server/api-v1/schemas";
import {
  fireDiscoveryRevalidate,
  fireOrgRevalidate,
  invalidateDiscoveryCache,
} from "@/server/public-site/revalidate";
import { orgLiveCacheKey } from "@/server/public-site/org-live-cache-key";
import { cacheDel } from "@/lib/cache";
import { competitionIsListed } from "@/lib/competition-listing";
import { ONBOARDING_EARN, REFERRAL_WELCOME_EARN, tryEarnGrant } from "@/lib/credits";
import { invalidateSlugCache } from "@/server/slug-resolve";
import { dropPublicCompetitionRefs } from "@/server/public-site/public-ref-cache";
import {
  assertCompetitionNotFrozen,
  countActiveCompetitions,
  countPublicDashboards,
  countsTowardPublicQuota,
  frozenCompetitionIds,
  PUBLIC_DASHBOARD_STATUSES,
} from "./entitlement-freeze";

export interface CompetitionRow {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  description: string | null;
  starts_on: string | null;
  ends_on: string | null;
  visibility: string;
  branding: unknown;
  status: string;
  created_at: string;
  /** Doc 15 §1 — opt-in showcase consent + organiser-entered presentation. */
  discoverable: boolean;
  discovery: unknown;
  /** doc 10 §2.4 — over-quota after a downgrade: read-only, never deleted. */
  frozen?: boolean;
  /** T20 — set by `createCompetition` ONLY, and only when the
   *  public-dashboard cap turned a requested public create private. Not a
   *  column: it describes what happened to THIS request, so a later read of
   *  the same row never carries it. */
  public_quota_degraded?: PublicQuotaDegraded;
}

const COLS = [
  "id", "org_id", "name", "slug", "description", "starts_on", "ends_on",
  "visibility", "branding", "status", "created_at", "discoverable", "discovery",
] as const;

// Slug helpers moved to ./slugs (PROMPT-30) \u2014 re-exported for existing importers.
import {
  slugify,
  withUniqueSlug,
  SLUG_CONSTRAINT,
  recordSlugHistory,
  RESERVED_ENTITY_SLUGS,
} from "./slugs";
import type postgres from "postgres";
export { slugify } from "./slugs";

/** Cheap existence check (no row data) — used to gate first-login UI (e.g.
 *  the product tour's centered welcome card, which would otherwise land on
 *  top of the org-home empty-state CTA on a brand-new org). */
export async function hasAnyCompetitions(auth: AuthCtx): Promise<boolean> {
  const rows = await withTenant(auth.orgId, (tx) =>
    tx<{ exists: boolean }[]>`select exists(select 1 from competitions) as exists`,
  );
  return rows[0]?.exists ?? false;
}

// Two phases, and the boundary is load-bearing for the same reason spelled out
// over `getCompetition` below: `withTenant` PINS one of the pool's five
// connections, and `frozenCompetitionIds` queries the pooled `sql` proxy on a
// cache miss, so awaiting it from inside asks the same pool for a second
// connection while the first is held. Five concurrent renders deadlock the
// process permanently. This is the HOTTER of the two sites — an org home lists
// on every visit; the detail page is a click further in — so it is the one that
// would have hung first.
//
// The rows leave the transaction UNTRIMMED (`limit + 1`): `page()` mints
// `nextCursor` from the over-fetch, so trimming here would drop pagination
// without failing any deadlock assertion. Pinned by the tripwire's second
// `listCompetitions` case.
export async function listCompetitions(
  auth: AuthCtx,
  query: ListQuery,
): Promise<Page<CompetitionRow>> {
  const rows = await withTenant(auth.orgId, async (tx) =>
    query.cursor
      ? await tx<CompetitionRow[]>`
          select ${tx(COLS)} from competitions
          where (created_at, id) < (${query.cursor.createdAt}, ${query.cursor.id})
          order by created_at desc, id desc limit ${query.limit + 1}`
      : await tx<CompetitionRow[]>`
          select ${tx(COLS)} from competitions
          order by created_at desc, id desc limit ${query.limit + 1}`,
  );
  const frozen = await frozenCompetitionIds(auth.orgId);
  return page(rows.map((r) => ({ ...r, frozen: frozen.has(r.id) })), query.limit);
}

// Doc 10 §1: `competitions.max_active` — draft/published/live competitions
// count; completed/archived don't, and neither do Event-Passed comps (a pass
// buys its competition out of the quota, v3/07 §3) — for as long as the pass
// APPLIES, which is what this used to get wrong (#347). "A pass row exists" is
// not the rule: SPEC-4 §7 ends the pass at the grace boundary, and a live
// competition past that boundary was keeping a free slot for ever. Same
// predicate the resolver uses (V343's pass_applies), so the three sites cannot
// drift apart again. Enforced at the write (doc 10 §2 rule 1).
// Exported (only) for createFromTemplate (usecases/templates.ts, D1a): a
// template-instantiated competition is a competition for quota purposes, and
// this is the SAME pre-transaction check createCompetition itself runs below
// — reused, not restated, so the two can never disagree about the boundary.
export async function assertActiveQuota(auth: AuthCtx): Promise<void> {
  const count = await countActiveCompetitions(auth.orgId);
  const { ok } = await withinLimit(auth.orgId, "competitions.max_active", count + 1);
  if (!ok) throw new PaymentRequiredError("competitions.max_active");
}

/**
 * Doc 10 §1: `dashboard.public.max` — how many public dashboards the org may
 * have LIVE at once. Enforced at the write (doc 10 §2 rule 1), not in the UI.
 *
 * WHICH visibilities that is, and why `unlisted` is one of them, lives with the
 * set itself: `PUBLICLY_READABLE_VISIBILITIES` in ./entitlement-freeze, beside
 * the status/pass predicate below. Counting only `visibility = 'public'` left a
 * one-word bypass beside the cap until 2026-09-05 — an unlisted competition is
 * served the same dashboard by `public_competitions_v`, so it was the paid
 * thing under a different name.
 *
 * The count is the same `liveUnpassedCompetition` predicate `assertActiveQuota`
 * uses, and until V396 it was neither half of it: a flat
 * `count(*) where visibility = 'public'` with no status filter and no pass
 * exclusion. So it metered HISTORY — a club three seasons in carried three
 * public dashboards for ever and was refused a fourth while nothing at all was
 * running — and a competition an Event Pass had bought out of the active quota
 * still occupied a public slot. That mattered more once T15 cut Free's cap to
 * 2. The old header here also claimed "Community holds 1 public competition at
 * a time", which had been wrong through two cap changes; the number is not
 * restated in prose any more, it travels with the refusal (see below).
 *
 * `excludeId` is the PATCH path's "don't count the row being changed".
 *
 * Split into a boolean form and an asserting form because the create path must
 * DEGRADE rather than refuse (T15/F, owner ruling 2026-09-03) while the patch
 * path still 402s.
 */
export async function withinPublicQuota(auth: AuthCtx, excludeId?: string): Promise<{ ok: boolean; limit: number | null }> {
  const count = await countPublicDashboards(auth.orgId, excludeId);
  return withinLimit(auth.orgId, "dashboard.public.max", count + 1);
}

/** The REFUSING form, and the only caller left is `patchCompetition` below:
 *  since T15/F both create paths degrade instead (`resolveCreateVisibility`),
 *  so createFromTemplate — which this comment used to name as the reason for
 *  the export — no longer calls it. Kept exported alongside
 *  `withinPublicQuota` so the boolean and asserting forms stay one pair with
 *  one visibility. */
export async function assertPublicQuota(auth: AuthCtx, excludeId?: string): Promise<void> {
  const { ok, limit } = await withinPublicQuota(auth, excludeId);
  // The cap travels WITH the refusal rather than being restated in copy: the
  // flat sentence in `feature-copy.ts` said "one public dashboard at a time"
  // through caps of 1, 3 and 2. Same mechanism `import.bulk` uses.
  if (!ok) {
    throw new PaymentRequiredError("dashboard.public.max", {
      limit,
      reason: publicDashboardsReason(limit),
    });
  }
}

/**
 * The create-time visibility decision, resolved ONCE for both create paths
 * (T20, reviewer pass 3, 2026-09-03).
 *
 * `createCompetition` and `instantiateTemplate` each carried their own copy of
 *
 *     const quotaMet = input.visibility === "public" && !(await withinPublicQuota(auth)).ok;
 *     const visibility = quotaMet ? "private" : (input.visibility ?? "public");
 *
 * and the template copy had a real hole in it: the GUARD keyed on
 * `=== "public"` while the VALUE keyed on `?? "public"`, so an omitted
 * visibility skipped the quota check entirely and still created a PUBLIC
 * competition, over the cap, with neither a note nor a refusal. Two spellings
 * of one rule is how that happens, so there is now one — the default is
 * applied FIRST and the guard reads the resolved answer, which makes the two
 * incapable of disagreeing again.
 *
 * Returns the note as well as the value, because the note is the API contract:
 * see `PublicQuotaDegraded` (api-v1/schemas.ts) for why a silent substitution
 * in a 201 is wrong for every consumer and not only for the client that
 * happens to diff the row.
 *
 * NEVER blocks. The PATCH path still 402s through `assertPublicQuota` above —
 * switching an existing competition to public is a deliberate act with a wrong
 * answer available, so it gets an error; a create is not.
 */
export async function resolveCreateVisibility(
  auth: AuthCtx,
  requested: "private" | "unlisted" | "public" | undefined,
): Promise<{
  visibility: "private" | "unlisted" | "public";
  degraded: PublicQuotaDegraded | null;
}> {
  // PUBLIC BY DEFAULT (V396/T15). Applied here, before the guard reads it, so
  // "what an omitted visibility means" is answered in exactly one place for
  // both create paths and for every direct usecase caller.
  const wanted = requested ?? "public";
  if (!countsTowardPublicQuota(wanted))
    return { visibility: wanted, degraded: null };
  const { ok, limit } = await withinPublicQuota(auth);
  // `wanted`, NOT a hardcoded "public". The literal was harmless while only
  // `public` could reach this line; now that `unlisted` does, returning
  // "public" here would publish a competition the organiser asked to keep off
  // the listing — a silent promotion, which is worse than the refusal this
  // function exists to avoid.
  if (ok) return { visibility: wanted, degraded: null };
  return {
    visibility: "private",
    degraded: {
      feature_key: "dashboard.public.max",
      // What the CALLER asked for. A note that always said "public" would tell
      // a consumer something untrue about its own request.
      requested_visibility: wanted,
      applied_visibility: "private",
      limit,
      // The SAME sentence `assertPublicQuota`'s 402 carries, from the same
      // builder — the cap travels with the answer instead of being restated.
      reason: publicDashboardsReason(limit),
    },
  };
}

/** Activation event (feature 1) — first competition is the "aha" moment.
 *  Exported so createFromTemplate (usecases/templates.ts, D1a) can fire the
 *  SAME event, with the SAME shape, after ITS OWN transaction commits — a
 *  template-instantiated competition is a competition for the activation
 *  funnel too. P4 review (2026-08-13) finding 1: an earlier draft of the
 *  template path called no emitter at all, so a feature built to lower
 *  friction to a first competition could not be measured doing it. */
export async function fireCompetitionCreated(auth: AuthCtx, visibility: string): Promise<void> {
  await captureServer({
    event: EVENTS.COMPETITION_CREATED,
    distinctId: auth.userId ?? `org:${auth.orgId}`,
    orgId: auth.orgId,
    properties: { visibility },
  });
}

/** Activation funnel completion (feature 1) — fires once, on the transition
 *  INTO "public" (see shouldFireMadePublic, exported alongside this so a
 *  caller can decide WHETHER to call it). Exported so createFromTemplate
 *  (usecases/templates.ts, D1a) can fire the SAME event, with the SAME
 *  shape, when a template-instantiated competition is created directly
 *  public — CreateFromTemplate.visibility accepts "public" exactly like
 *  CreateCompetition's does, so the same completion milestone applies.
 *
 *  P4 review follow-up (2026-08-13): the first fix wired up
 *  COMPETITION_CREATED but stopped at the one emitter the review named,
 *  instead of auditing every event createCompetition fires — this was the
 *  second one it missed, of exactly two (the other is patchCompetition's
 *  transition-into-public case below, unaffected — a template never PATCHes
 *  during instantiation). */
export async function fireCompetitionMadePublic(auth: AuthCtx, competitionId: string): Promise<void> {
  await captureServer({
    event: EVENTS.COMPETITION_MADE_PUBLIC,
    distinctId: auth.userId ?? `org:${auth.orgId}`,
    orgId: auth.orgId,
    properties: { competition_id: competitionId },
  });
}

export async function createCompetition(
  auth: AuthCtx,
  input: CreateCompetition,
): Promise<CompetitionRow> {
  await assertActiveQuota(auth);
  // NEVER BLOCK A CREATE on the public-dashboard cap (T15/F, owner ruling
  // 2026-09-03). Competitions are public BY DEFAULT now, and Free is 3 active
  // competitions against 2 public dashboards — so under the old
  // `assertPublicQuota` throw the THIRD create on the plan whose one-line sell
  // is "run a club night" would have 402'd by default, with no wrong choice
  // made by the organiser. It degrades instead: the competition is created
  // PRIVATE, the row that comes back carries the visibility that was actually
  // applied, and (T20) `public_quota_degraded` names the substitution and the
  // cap that caused it, so a consumer does not have to diff the response
  // against its own request to notice. The PATCH path still 402s — switching
  // an existing competition to public is a deliberate act with a wrong answer
  // available, so it gets one.
  // Resolved through the shared helper both create paths use — see
  // `resolveCreateVisibility` for why the default and the guard must be one
  // answer, and `PublicQuotaDegraded` for why `degraded` reaches the caller.
  const { visibility, degraded } = await resolveCreateVisibility(
    auth,
    input.visibility,
  );
  // Showcase at create time follows the exact PATCH rules (doc 15 §1):
  // gate key server-side, and never let a non-public competition opt in. Both
  // checks read the CALLER'S OWN input, not the degraded value: a caller that
  // asked for private + showcase is contradicting itself and must still get
  // the 422, and one that asked for public + showcase must still be told about
  // the entitlement. The degrade then drops the opt-in below, because a
  // private competition can never be showcased.
  if (input.discoverable === true) {
    await requireFeature(auth.orgId, "discovery.listed");
    if (input.visibility !== "public") {
      throw new HttpError(422, "Only public competitions can be showcased on seazn.club");
    }
  }
  const discoverable = !degraded && input.discoverable === true;
  const row = await withTenant(auth.orgId, async (tx) => {
    // The insert is shared by both slug paths so the generated one can be
    // RETRIED against the unique index — `q` is the savepoint the retry rolls
    // back to, and must be used in place of `tx` inside it.
    const insert = async (slug: string, q: postgres.TransactionSql): Promise<CompetitionRow> => {
      const [row] = await q<CompetitionRow[]>`
        insert into competitions (org_id, name, slug, description, starts_on, ends_on,
                                  visibility, branding, discoverable, created_by)
        values (${auth.orgId}, ${input.name}, ${slug}, ${input.description ?? null},
                ${input.starts_on ?? null}, ${input.ends_on ?? null}, ${visibility},
                ${q.json(input.branding as never)}, ${discoverable},
                ${auth.userId})
        returning ${q(COLS)}`;
      return row!;
    };
    // Explicit slugs are the caller's choice — collisions 409. Generated
    // slugs dedupe with "-2" suffixes; "new" is reserved (static /c/new).
    let created: CompetitionRow;
    if (input.slug) {
      if (RESERVED_ENTITY_SLUGS.has(input.slug)) {
        throw new HttpError(422, `slug '${input.slug}' is reserved`);
      }
      const [existing] = await tx`select 1 from competitions where slug = ${input.slug}`;
      if (existing) throw new HttpError(409, `slug '${input.slug}' is already in use`);
      created = await insert(input.slug, tx);
    } else {
      created = await withUniqueSlug(
        tx,
        {
          base: slugify(input.name),
          constraint: SLUG_CONSTRAINT.competitions,
          taken: async (s) => {
            const [taken] = await tx`select 1 from competitions where slug = ${s}`;
            return !!taken;
          },
        },
        insert,
      );
    }
    // Opt-in is audited exactly like the PATCH path (doc 15 §1 "who/when").
    if (created.discoverable) {
      await tx`
        insert into competition_events (competition_id, org_id, type, payload, actor_id)
        values (${created.id}, ${auth.orgId}, 'discovery.opt_in',
                ${tx.json({ auto: false } as never)}, ${auth.userId})`;
    }
    return created;
  });
  if (row.discoverable) {
    await invalidateDiscoveryCache();
    fireDiscoveryRevalidate();
  }
  // Activation event (feature 1) — first competition is the "aha" moment.
  // The visibility it was CREATED with, not the one that was asked for: a
  // degraded competition is a private one and the funnel must not read it as a
  // public launch.
  await fireCompetitionCreated(auth, visibility);
  // Activation funnel completion — created directly public (no prior state).
  if (shouldFireMadePublic(undefined, visibility)) {
    await fireCompetitionMadePublic(auth, row.id);
  }
  // The degrade note rides ALONGSIDE the row rather than replacing anything in
  // it: a consumer that never looks at it still reads the truthful
  // `visibility` off the resource itself (T20).
  // The degrade note carries BOTH substitutions or it under-reports. `degraded`
  // is built by `resolveCreateVisibility`, which never sees `input.discoverable`
  // — so the showcase half is attached here, where both facts are in scope.
  return degraded
    ? {
        ...row,
        public_quota_degraded: {
          ...degraded,
          ...(input.discoverable === true
            ? { discoverable_dropped: true as const }
            : {}),
        },
      }
    : row;
}

// Two phases on purpose, and the boundary is load-bearing (see
// pool-nesting-tripwire.test.ts). `withTenant` is `getClient().begin()`, so it
// PINS one of the pool's five connections (lib/db.ts `max: 5`) for the whole
// callback. `frozenCompetitionIds` opens with `getLimit`, which on a cache miss
// queries the pooled `sql` proxy — i.e. asks the same pool for a SECOND
// connection while the first is still held. Five concurrent renders reaching
// that await pin all five slots and queue for a sixth that can never exist;
// postgres.js has no queue-wait timeout, so the process hangs permanently at
// ~0% CPU with every DB-touching route (including /api/health) stalled.
// Reading the row, closing the transaction, and only then computing `frozen`
// costs one extra round trip and cannot self-deadlock. Same phase boundary
// autoSchedule documents: transaction for the read, no pooled connection held
// for the unbounded work.
export async function getCompetition(auth: AuthCtx, id: string): Promise<CompetitionRow> {
  const row = await withTenant(auth.orgId, async (tx) => {
    const [found] = await tx<CompetitionRow[]>`
      select ${tx(COLS)} from competitions where id = ${id}`;
    return found;
  });
  if (!row) throw new HttpError(404, "competition not found");
  const frozen = await frozenCompetitionIds(auth.orgId);
  return { ...row, frozen: frozen.has(row.id) };
}

// Activation funnel (feature 1): `competition_made_public` fires exactly once
// per transition INTO "public" — never on create-already-public double count
// with itself, and never re-fired by an unrelated patch to an already-public
// competition. Pure so create + patch can share one rule.
export function shouldFireMadePublic(
  oldVisibility: string | null | undefined,
  newVisibility: string | null | undefined,
): boolean {
  return newVisibility === "public" && oldVisibility !== "public";
}

// Growth-loop gate (SPEC-5 §2, v17 gap #296): true only on the transition
// INTO "published" with at least one (non-archived) division on the
// competition — the cheapest signal that a human is running a real
// competition, not a scripted signup. Pure so it's unit-testable without a
// DB, mirroring shouldFireMadePublic above.
export function shouldFireGrowthEarnGrants(
  statusChangedTo: string | null,
  divisionCount: number,
): boolean {
  return statusChangedTo === "published" && divisionCount >= 1;
}

/** v17 #289: `live` = play started; `completed` = wrapped up. `published`
 *  does NOT count as started — a competition can sit published for weeks
 *  before its first fixture. Pure like shouldFireMadePublic above, and
 *  typed on the zod enum (not `string`) so a typo'd literal fails tsc
 *  instead of silently comparing false forever — exactly how the
 *  pre-#289 bug shipped: `statusChangedTo === "active"` compared against
 *  values that could never equal any CompetitionStatus member. */
export function competitionLifecycleEvent(
  statusChangedTo: z.infer<typeof CompetitionStatus> | null,
): AnalyticsEvent | null {
  if (statusChangedTo === "live") return EVENTS.COMPETITION_STARTED;
  if (statusChangedTo === "completed") return EVENTS.COMPETITION_COMPLETED;
  return null;
}

// A frozen competition is read-only — but retiring it (status → completed/
// archived) must stay possible, or the org could never get back under quota.
function isRetirePatch(patch: PatchCompetition): boolean {
  const keys = Object.keys(patch);
  return (
    keys.length === 1 &&
    keys[0] === "status" &&
    (patch.status === "completed" || patch.status === "archived")
  );
}

export async function patchCompetition(
  auth: AuthCtx,
  id: string,
  patch: PatchCompetition,
): Promise<CompetitionRow> {
  if (!isRetirePatch(patch)) await assertCompetitionNotFrozen(auth.orgId, id);
  // Any transition INTO a publicly readable state, not just into `public`
  // (owner ruling 2026-09-05). `excludeId` is what keeps a LATERAL move
  // possible: public -> unlisted does not add a readable dashboard, so counting
  // the row against itself would refuse a change that costs the org nothing.
  if (patch.visibility && countsTowardPublicQuota(patch.visibility)) {
    await assertPublicQuota(auth, id);
  }
  // The OTHER transition into a publicly readable state, and the one that
  // closes the hole `PUBLIC_DASHBOARD_STATUSES` would otherwise open. Since a
  // draft no longer meters, an org could create any number of PUBLIC drafts
  // (each counting zero) and then publish them all — the cap enforced nowhere,
  // because create degrades rather than refusing and nothing else looked at
  // status. Publishing is exactly the "deliberate act with a wrong answer
  // available" the visibility guard above exists for, so it 402s the same way.
  //
  // Reads the row's CURRENT visibility when the patch does not carry one:
  // publishing an already-public draft is the common case and the patch that
  // does it usually says only `status`.
  if (
    patch.status &&
    (PUBLIC_DASHBOARD_STATUSES as readonly string[]).includes(patch.status)
  ) {
    const [current] = await withTenant(
      auth.orgId,
      (tx) =>
        tx<{ visibility: string; status: string }[]>`
          select visibility, status from competitions where id = ${id}`,
    );
    // Only a transition — republishing something already published (or going
    // published -> live) must not be refused for a slot it already holds.
    const alreadyMetered =
      !!current &&
      (PUBLIC_DASHBOARD_STATUSES as readonly string[]).includes(current.status);
    const goingPublic =
      !!current &&
      countsTowardPublicQuota(patch.visibility ?? current.visibility);
    if (goingPublic && !alreadyMetered) await assertPublicQuota(auth, id);
  }
  // Doc 15 §5: listing is free on every tier, but the gate stays server-side
  // so a plan without the key (or a staff override) can switch it off.
  if (patch.discoverable === true) await requireFeature(auth.orgId, "discovery.listed");
  // Presentation depth is the paid layer (doc 15 §1): tagline/hero → 402.
  if (patch.discovery?.tagline || patch.discovery?.hero_image_path) {
    await requireFeature(auth.orgId, "discovery.branding");
  }
  let statusChangedTo: z.infer<typeof CompetitionStatus> | null = null;
  let previousSlug: string | null = null;
  let oldVisibility: string | null = null;
  let publishedDivisionCount = 0;
  // Public hub perf T2: the public read path caches "publicly readable under
  // these slugs" (`findCompetitionRef`, usecases/public.ts), keyed by the
  // ORG's slug and the competition's. Read in the same statement as `before`.
  let refOrgSlug: string | null = null;
  let refSlugBefore: string | null = null;
  const { row, discoveryTouched, listingChanged } = await withTenant(auth.orgId, async (tx) => {
    if (patch.slug) {
      if (RESERVED_ENTITY_SLUGS.has(patch.slug)) {
        throw new HttpError(422, `slug '${patch.slug}' is reserved`);
      }
      const [taken] = await tx`
        select 1 from competitions where slug = ${patch.slug} and id <> ${id}`;
      if (taken) throw new HttpError(409, `slug '${patch.slug}' is already in use`);
    }
    const [before] = await tx<
      {
        visibility: string;
        discoverable: boolean;
        status: string;
        name: string;
        slug: string;
        starts_on: string | null;
        ends_on: string | null;
        org_slug: string | null;
      }[]
    >`
      select visibility, discoverable, status, name, slug, starts_on, ends_on,
             (select o.slug from organizations o where o.id = competitions.org_id) as org_slug
      from competitions where id = ${id}`;
    if (!before) throw new HttpError(404, "competition not found");
    refOrgSlug = before.org_slug;
    refSlugBefore = before.slug;
    // Settings walkthrough F8. `checkDateOrder` (api-v1/schemas.ts) is a
    // `superRefine` on the request BODY, so it only ever compares the two
    // dates a single request CARRIES — and the settings form always sends
    // both, which is why this hole never showed up through the UI. A scripted
    // `PATCH { ends_on }` alone walked straight past it and left the row
    // ending before it starts (witnessed 2026-09-06 against a running
    // server: starts_on 2027-06-01 stored, `{ ends_on: "2027-01-01" }` -> 200).
    // `schemas.ts` had documented this re-check as already existing; it did
    // not. Same merge-against-the-stored-row shape as `divisions.ts`'s
    // age_min/age_max check, inside the SAME tenant transaction as the write
    // so nothing can slip between the read and the update, and reusing the
    // exported message so the 400 (zod) and the 422 (here) cannot drift apart.
    //
    // #376 keeps `ends_on` non-nullable on PATCH but `starts_on` nullable, so
    // a merged pair with a null side is legal and simply not comparable —
    // ISO `YYYY-MM-DD` sorts lexicographically, so a string compare IS the
    // date compare (same reasoning as `checkDateOrder`'s own comment).
    if (patch.starts_on !== undefined || patch.ends_on !== undefined) {
      const mergedStarts = patch.starts_on !== undefined ? patch.starts_on : before.starts_on;
      const mergedEnds = patch.ends_on !== undefined ? patch.ends_on : before.ends_on;
      if (mergedStarts && mergedEnds && mergedEnds < mergedStarts) {
        throw new HttpError(422, ENDS_BEFORE_STARTS);
      }
    }
    if (patch.status && patch.status !== before.status) statusChangedTo = patch.status;
    oldVisibility = before.visibility;
    // Growth-loop gate (SPEC-5 §2, v17 gap #296): count divisions here, in
    // the same tenant tx, only when the patch might trigger the earn grants
    // below — avoids a division-count query on every unrelated patch.
    if (statusChangedTo === "published") {
      const [{ n }] = await tx<{ n: number }[]>`
        select count(*)::int as n from divisions
        where competition_id = ${id} and archived_at is null`;
      publishedDivisionCount = n;
    }

    const effective = { ...patch };
    // Rename regenerates the slug (v3/01 §2); the old slug keeps redirecting
    // via slug_history, so links and QR codes survive.
    const regenerating = !patch.slug && !!patch.name && patch.name !== before.name;
    const nextVisibility = patch.visibility ?? before.visibility;
    // Hard coupling (doc 15 §1): never leak a non-public competition to
    // discovery. Turning it on needs `public`; dropping visibility
    // auto-disables it in the SAME tx.
    if (effective.discoverable === true && nextVisibility !== "public") {
      throw new HttpError(422, "Only public competitions can be showcased on seazn.club");
    }
    if (nextVisibility !== "public" && before.discoverable && effective.discoverable !== false) {
      effective.discoverable = false;
    }

    // The rename's slug write is retryable, so the history row it implies has
    // to sit inside the same savepoint — a rollback that kept the history but
    // discarded the update would leave a redirect pointing at a slug that
    // never existed.
    const update = async (
      eff: PatchCompetition,
      q: postgres.TransactionSql,
    ): Promise<CompetitionRow> => {
      if (eff.slug && eff.slug !== before.slug) {
        await recordSlugHistory(q, "competition", auth.orgId, before.slug, id);
        previousSlug = before.slug;
      }
      const cols = Object.keys(eff) as (keyof PatchCompetition)[];
      const values = {
        ...eff,
        ...(eff.branding ? { branding: q.json(eff.branding as never) } : {}),
        ...(eff.discovery ? { discovery: q.json(eff.discovery as never) } : {}),
      };
      const [updated] = await q<CompetitionRow[]>`
        update competitions set ${q(values as never, ...(cols as never[]))}
        where id = ${id} returning ${q(COLS)}`;
      if (!updated) throw new HttpError(404, "competition not found");
      return updated;
    };
    const row = regenerating
      ? await withUniqueSlug(
          tx,
          {
            base: slugify(patch.name!),
            constraint: SLUG_CONSTRAINT.competitions,
            taken: async (s) => {
              const [taken] = await tx`
                select 1 from competitions where slug = ${s} and id <> ${id}`;
              return !!taken;
            },
          },
          // A regenerated slug equal to the current one is not a rename at all
          // — no slug column write, no history row (pre-existing behaviour).
          // `previousSlug` is cleared per attempt: a retry can land back on the
          // current slug, and leftover bookkeeping would bust the slug cache
          // for a rename that did not happen.
          (slug, sp) => {
            previousSlug = null;
            return update(slug === before.slug ? effective : { ...effective, slug }, sp);
          },
        )
      : await update(effective, tx);

    // Opt-in/out is org-level content consent — recorded as a division-
    // independent competition event in the same tx (doc 15 §1 "audited
    // who/when"; competition_events is append-only by grants).
    if (before.discoverable !== row.discoverable) {
      await tx`
        insert into competition_events (competition_id, org_id, type, payload, actor_id)
        values (${id}, ${auth.orgId},
                ${row.discoverable ? "discovery.opt_in" : "discovery.opt_out"},
                ${tx.json({ auto: effective.discoverable !== patch.discoverable } as never)},
                ${auth.userId})`;
    }

    const discoveryTouched =
      before.discoverable !== row.discoverable ||
      (row.discoverable &&
        Boolean(patch.discovery ?? patch.name ?? patch.starts_on ?? patch.ends_on ?? patch.status));
    // Did the competition join or leave the org home's list? Publishing a
    // draft, un-publishing, or a visibility move across `public` — the listing
    // rule is `competitionIsListed` (owner decision 2026-09-27: a draft is
    // unlisted until published).
    const listingChanged = competitionIsListed(before) !== competitionIsListed(row);
    return { row, discoveryTouched, listingChanged };
  });
  // v17 #287: ANY competition write can move status/ends_on, which the Event
  // Pass lock (isPassLocked) reads live off this row on every resolve — so
  // invalidate broadly (not gated to "did status/ends_on change") rather than
  // reason about which columns matter. Fail-open by construction:
  // invalidateOrgEntitlements -> cacheDelPattern swallows every Redis error
  // internally (lib/cache.ts) and never throws, so this can never fail the
  // write it rides on; the 300s TTL is the last-resort bound if it's ever
  // skipped. Outside the tx, same reasoning as the discovery/slug busts below
  // — invalidation never rolls back a write.
  await invalidateOrgEntitlements(auth.orgId);
  // Public hub perf T2: the polled public readers (the hub, the player page)
  // answer "is this competition publicly readable under these slugs" from
  // Redis. Visibility and slug (explicit, or regenerated by a rename) are
  // written ONLY here, so the lookup under the old slug and the new one is
  // dropped after EVERY patch — one DEL, and a future filter on another column
  // is covered without anyone remembering this line. Outside the tx for the
  // reason the busts around it give; never throws.
  if (refOrgSlug) await dropPublicCompetitionRefs(refOrgSlug, refSlugBefore, row.slug);
  // Toggle-off is immediate (doc 15 §1): drop the Redis window and fire the
  // `discovery` ISR tag. Outside the tx — invalidation never rolls back a write.
  if (discoveryTouched) {
    await invalidateDiscoveryCache();
    fireDiscoveryRevalidate();
  }
  // The org home should follow a publish at once: an organiser who publishes
  // a draft looks for it on their public page next. Without this the page's
  // data entry and ISR render (30s) and the chip poll's Redis document (15s)
  // would keep the old list for their TTL — bounded, but it reads as "publish
  // did not work". `{ expire: 0 }` on the org tag (`fireOrgRevalidate`), the
  // poll document dropped. MEASURED 2026-09-27 (local prod build): the poll
  // read is fresh on the very next request, but the org home and hub PAGES
  // serve their previous render once or twice (`x-nextjs-cache: STALE`) and
  // are fresh ~2s later — so this is a ~2s bound, not read-your-own-writes;
  // why the expiry acts as stale here is an open finding (smoke pins the
  // bound). Expiring the whole org tag is affordable here because
  // this is a rare, deliberate write — never a scoring path. The sitemap is NOT
  // refreshed here, by design: `app/sitemap.ts` renders at request time and
  // reads its competitions through `sitemap-cache.ts`'s cache, so a publish or
  // an unpublish shows in the sitemap within that window
  // (SITEMAP_REVALIDATE_SECONDS, an hour). The lag is owner-accepted
  // (2026-09-28): the page itself refuses at once, and only the slug lingers
  // in the sitemap until the window turns. Discovery is covered above
  // (`discoveryTouched` includes a status change of a discoverable
  // competition). Outside the tx — invalidation never rolls back a write — and
  // best-effort like the grants below: the write has committed, so a failed
  // slug read is logged, never a 500 for a publish that succeeded.
  if (listingChanged) {
    await cacheDel(orgLiveCacheKey(auth.orgId));
    try {
      const [org] = await sql<{ slug: string }[]>`
        select slug from organizations where id = ${auth.orgId}`;
      if (org) fireOrgRevalidate(org.slug);
    } catch (err) {
      log.error({ err, orgId: auth.orgId }, "competitions: org home revalidation failed");
    }
  }
  // A rename busts the cached slug resolution (old + new key) — outside the
  // tx, same reasoning as the discovery invalidation above.
  if (previousSlug) await invalidateSlugCache("competition", auth.orgId, previousSlug, row.slug);
  // Lifecycle events (feature 1): tournament start/finish. Pure helper so
  // the rule is unit-tested without a DB (mirrors shouldFireMadePublic).
  const lifecycleEvent = competitionLifecycleEvent(statusChangedTo);
  if (lifecycleEvent) {
    await captureServer({
      event: lifecycleEvent,
      distinctId: auth.userId ?? `org:${auth.orgId}`,
      orgId: auth.orgId,
      properties: { competition_id: id },
    });
  }
  // Activation funnel completion (feature 1) — fires once, on the
  // transition INTO "public" only (see shouldFireMadePublic).
  if (shouldFireMadePublic(oldVisibility, patch.visibility)) {
    await fireCompetitionMadePublic(auth, id);
  }
  // Growth-loop gate (SPEC-5 §2, v17 gap #296): onboarding + referral-welcome
  // earn credits pay out only once this org proves a human is running a real
  // competition — publishing one with at least one (non-archived) division —
  // never at signup or onboarding-complete alone (moved off auth.ts's
  // createOrgForUser and api/onboarding/complete/route.ts). Both grants are
  // idempotent per org (tryEarnGrant never throws), so re-publishing, or
  // publishing a second/third competition, is always a safe no-op.
  //
  // Best-effort, and the try/catch is load-bearing: this whole block runs
  // AFTER the tenant transaction has committed. `tryEarnGrant` never throws,
  // but the `referred_by_org_id` read is a raw query — a transient DB error
  // there would escape as a 500 for a publish that already succeeded, and the
  // grant would be lost for good, because the gate only fires on the
  // TRANSITION into "published" and the row is already published on any
  // retry. Swallow and log instead; the caller gets its row either way.
  if (shouldFireGrowthEarnGrants(statusChangedTo, publishedDivisionCount)) {
    try {
      await tryEarnGrant(auth.orgId, "onboarding", ONBOARDING_EARN);
      const [orgRow] = await sql<{ referred_by_org_id: string | null }[]>`
        select referred_by_org_id from organizations where id = ${auth.orgId}`;
      if (orgRow?.referred_by_org_id) {
        await tryEarnGrant(auth.orgId, "referral_welcome", REFERRAL_WELCOME_EARN);
      }
    } catch (err) {
      log.error({ err, orgId: auth.orgId }, "competitions: growth earn grants failed");
    }
  }
  return row;
}

export async function deleteCompetition(auth: AuthCtx, id: string): Promise<void> {
  const gone = await withTenant(auth.orgId, async (tx) => {
    // Guard: no deleting a competition with recorded play (ledger is precious).
    const [scored] = await tx`
      select 1 from score_events e
      join fixtures f on f.id = e.fixture_id
      join divisions d on d.id = f.division_id
      where d.competition_id = ${id} limit 1`;
    if (scored) {
      throw new HttpError(409, "competition has recorded score events — archive it instead");
    }
    // Money guards (payments-hardening spec P0-1): a delete would CASCADE
    // paid registrations, the Event Pass, and comp-scoped sponsorship —
    // erasing the app's only record of live money. Archive is always allowed.
    //
    // Deliberately bare row-existence, NOT V343's pass_applies (#347): this
    // asks "was a pass ever bought" — money history, like pass-credit.ts:138 —
    // not "is a pass applying". Adding the lock predicate here would INVERT the
    // guard on exactly the competitions most likely to be deleted (long-ended
    // ones), letting the cascade erase the record of a real $29/$59 charge.
    const [pass] = await tx`
      select 1 from competition_passes where competition_id = ${id} limit 1`;
    if (pass) {
      throw new HttpError(409, "competition has an Event Pass — archive it instead");
    }
    const [liveMoney] = await tx`
      select 1 from registrations r
      join divisions d on d.id = r.division_id
      join registration_groups g on g.id = r.group_id
      where d.competition_id = ${id}
        and g.payment_intent_id is not null
        and g.refunded_cents < g.amount_cents
      limit 1`;
    if (liveMoney) {
      throw new HttpError(
        409,
        "competition has card payments that are not fully refunded — refund them or archive it instead",
      );
    }
    const [paidSponsor] = await tx`
      select 1 from sponsor_orders o
      join sponsor_packages p on p.id = o.package_id
      where p.competition_id = ${id}
        and (o.payment_intent_id is not null
             or o.disputed_at is not null
             or o.status in ('paid', 'refunded'))
      limit 1`;
    if (paidSponsor) {
      throw new HttpError(
        409,
        "competition has sponsorship payment records — refund history is kept; archive it instead",
      );
    }
    // V299 made sponsor_orders.package_id RESTRICT, so the comp→package
    // cascade can no longer sweep abandoned checkouts implicitly. The
    // sponsor_orders_prune policy (V300) fences this delete to rows that
    // never became money: pending, intent-less, undisputed.
    await tx`
      delete from sponsor_orders o
      using sponsor_packages p
      where p.id = o.package_id and p.competition_id = ${id}`;
    const [deleted] = await tx<{ slug: string; org_slug: string | null }[]>`
      delete from competitions c where c.id = ${id}
      returning c.slug, (select o.slug from organizations o where o.id = c.org_id) as org_slug`;
    if (!deleted) throw new HttpError(404, "competition not found");
    return deleted;
  });
  // Public hub perf T2: a deleted competition must stop answering the polled
  // public readers' cached slug lookup (`findCompetitionRef`, usecases/public.ts)
  // now, not at its TTL. After the commit; never throws.
  if (gone.org_slug) await dropPublicCompetitionRefs(gone.org_slug, gone.slug);
}
