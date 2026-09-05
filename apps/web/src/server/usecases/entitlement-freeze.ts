import "server-only";
// Downgrade behaviour (doc 10 §2.4): existing data is NEVER deleted; resources
// over the new plan's quota become read-only, flagged `frozen` in read models.
// Which N stay active is decided in exactly one place — the selector below:
// most recently active first (last score event, else creation time).
import type postgres from "postgres";
import { withTenant } from "@/lib/db";
import { getLimit } from "@/lib/entitlements";
import { PaymentRequiredError } from "@/lib/errors";

type Tx = postgres.TransactionSql;

// Competition statuses that count against `competitions.max_active`. A draft
// IS an active slot — it is work in progress the org is holding open.
export const ACTIVE_COMPETITION_STATUSES = [
  "draft",
  "published",
  "live",
] as const;

/**
 * Competition statuses that count against `dashboard.public.max` — the SAME
 * question asked of a different cap, and deliberately a smaller set.
 *
 * A draft shows the world nothing. `public_competitions_v` is keyed on
 * visibility, but a draft competition has no standings, no fixtures anyone is
 * reading and no link an organiser has handed out yet — so metering it charges
 * a PUBLIC DASHBOARD quota for something that is not a public dashboard.
 *
 * This was not a hypothetical. With drafts counted, Free (cap 2) meant an
 * organiser planning next season with two drafts had their THIRD competition
 * silently created private (`resolveCreateVisibility` degrades rather than
 * refusing), and the first they knew of it was a share link that 404ed. The
 * same shape took out five public-page e2e specs on a fixture org holding 279
 * drafts against a cap of 50.
 *
 * Splitting the sets moves the enforcement point from create to PUBLISH, which
 * is where it belongs and matches the rule `patchCompetition`'s visibility
 * guard already follows: a create is not a deliberate act with a wrong answer
 * available, so it degrades; publishing is, so it 402s. The organiser now
 * learns the cap at the moment it means something, with the competition
 * already built, instead of discovering it as a dead link.
 */
export const PUBLIC_DASHBOARD_STATUSES = ["published", "live"] as const;

/**
 * THE VISIBILITIES `dashboard.public.max` METERS.
 *
 * `unlisted` is in the set, and that is the whole point of it. The cap sells a
 * PUBLIC DASHBOARD — a URL an organiser hands to entrants and parents — and
 * `unlisted` serves exactly that. `public_competitions_v`, the only relation the
 * anonymous read path ever selects from, is
 *
 *     ... from competitions where visibility = any (array['public','unlisted'])
 *
 * and neither `getPublicCompetition` (the RSC dashboard) nor `publicCompetition`
 * (/api/v1/public) adds a visibility filter of its own. The one reader that
 * does is `getPublicOrg` — the org LANDING LIST. So `unlisted` withholds
 * discoverability and nothing else: the same page, the same divisions, the same
 * standings, to anyone holding the link.
 *
 * Counting only `visibility = 'public'` therefore put a one-word bypass beside
 * the cap: Community's 2 was unlimited to anyone who typed "unlisted", which is
 * not a cap. Owner ruling 2026-09-05 — the cap counts what is publicly
 * READABLE, not what is LISTED. `public-dashboard-quota.test.ts` establishes the
 * readability half against the real anonymous readers rather than asserting it,
 * so this comment has a witness and not just an author.
 *
 * `private` is genuinely outside the set: the view does not admit it, and the
 * `/shared/...` page 404s for it (V230, see usecases/exports.ts).
 */
export const PUBLICLY_READABLE_VISIBILITIES = ["public", "unlisted"] as const;
export type PubliclyReadableVisibility =
  (typeof PUBLICLY_READABLE_VISIBILITIES)[number];

/**
 * Does this visibility consume a `dashboard.public.max` slot?
 *
 * ONE predicate, read by all three sites the ruling names — the COUNT below,
 * the create-time degrade in `resolveCreateVisibility`, and the PATCH guard in
 * `patchCompetition`. Three spellings of one rule is how the template path
 * grew a hole the last time this function was touched (see
 * `resolveCreateVisibility`), so there is one.
 *
 * NOT the same question as "is this a public launch": the activation funnel's
 * `shouldFireMadePublic` still means `public` strictly, because an unlisted
 * competition is not a launch. The two ideas were one word until this ruling
 * split them.
 */
export function countsTowardPublicQuota(
  visibility: string,
): visibility is PubliclyReadableVisibility {
  return (PUBLICLY_READABLE_VISIBILITIES as readonly string[]).includes(
    visibility,
  );
}

/**
 * THE predicate: "this competition is live AND is not bought out by an Event
 * Pass". A SQL fragment rather than four hand-written copies, because it has
 * two halves that are each easy to omit and each fail silently.
 *
 * The status half stops a quota metering HISTORY — completed and archived
 * competitions are not live surfaces and must not hold a slot. The pass half
 * is v3/07 §3: a pass buys its competition out of the quota, for as long as
 * the pass APPLIES. "A pass row exists" is NOT the rule and getting that wrong
 * cost a release (#347): SPEC-4 §7 ends a pass at the grace boundary, and a
 * live competition past that boundary was keeping a free slot for ever.
 * V343's `pass_applies` is the same predicate the entitlement resolver uses.
 *
 * Callers must alias the competitions table as `c` — the fragment names
 * `c.id`, `c.status` and `c.ends_on`.
 *
 * Four call sites share it, and the fourth is why it was extracted:
 * `assertActiveQuota` already claimed in its own header that this was "the
 * same predicate the resolver uses, so the three sites cannot drift apart
 * again", and `assertPublicQuota` was conspicuously not one of those three —
 * it had NEITHER half. Copying the clauses into it would have made a fourth
 * place to drift; this makes it impossible.
 *
 * The STATUS half is a parameter, because the two caps meter different sets
 * (see `PUBLIC_DASHBOARD_STATUSES`): a draft is an active slot but not a public
 * dashboard. The pass-exclusion half is NOT a parameter and must never become
 * one — it is the clause this function was extracted to stop being copied.
 */
export function liveUnpassedCompetition(
  t: Tx,
  statuses: readonly string[] = ACTIVE_COMPETITION_STATUSES,
) {
  return t`c.status in ${t([...statuses])}
      and not exists (
        select 1 from competition_passes cp
         where cp.competition_id = c.id
           and pass_applies(c.status, c.ends_on, (now() at time zone 'utc')::date))`;
}

/**
 * THE COUNT every `dashboard.public.max` and `competitions.max_active` question
 * is answered from — the enforcement path and both usage meters alike.
 *
 * It exists because "how many is the org holding" had two implementations that
 * happened to agree about nothing. Enforcement asked
 * `liveUnpassedCompetition`; the two meters
 * (`app/api/orgs/[id]/entitlements/route.ts`,
 * `app/o/[orgSlug]/settings/billing/page.tsx`) asked their own SQL, and the
 * answers diverged in both directions a customer can see:
 *
 *  - a Free org (cap 2) with 2 live public competitions and 3 archived public
 *    seasons — enforcement counted 2 and published a third dashboard, while
 *    the billing page rendered 5/2 in red;
 *  - a Free org with a competition an Event Pass had bought out — enforcement
 *    counted 0 and left the whole cap open, while the meter read the org full.
 *
 * Two implementations that happen to agree today are the defect, not the
 * symptom, so there is one and the meters call it. `publiclyReadable` is the
 * only axis they differ on; `excludeId` is the PATCH path's "don't count the
 * row being changed", which is what keeps a public -> unlisted lateral move
 * possible.
 *
 * NOT the same shape as `frozenCompetitionIds` below: that one already holds a
 * transaction when it needs the number, so it calls `quotaCount` directly
 * rather than opening a second one (see its header for why nesting is fatal).
 */
async function quotaCount(
  t: Tx,
  scope: { publiclyReadable: boolean; excludeId?: string },
): Promise<number> {
  // The status set moves WITH the axis: `dashboard.public.max` meters only
  // competitions that are actually published, `competitions.max_active` meters
  // drafts too. Two axes, one predicate, no second spelling.
  const [row] = await t<{ n: number }[]>`
    select count(*)::int as n from competitions c
    where ${liveUnpassedCompetition(
      t,
      scope.publiclyReadable
        ? PUBLIC_DASHBOARD_STATUSES
        : ACTIVE_COMPETITION_STATUSES,
    )}
      ${
        scope.publiclyReadable
          ? t`and c.visibility in ${t([...PUBLICLY_READABLE_VISIBILITIES])}`
          : t``
      }
      ${scope.excludeId ? t`and c.id <> ${scope.excludeId}` : t``}`;
  return row?.n ?? 0;
}

/** How many competitions count against `competitions.max_active` right now. */
export async function countActiveCompetitions(orgId: string): Promise<number> {
  return withTenant(orgId, (t) => quotaCount(t, { publiclyReadable: false }));
}

/**
 * How many publicly-readable dashboards count against `dashboard.public.max`
 * right now. `excludeId` omits one competition — the row a PATCH is changing.
 */
export async function countPublicDashboards(
  orgId: string,
  excludeId?: string,
): Promise<number> {
  return withTenant(orgId, (t) =>
    quotaCount(t, { publiclyReadable: true, excludeId }),
  );
}

export interface FreezeCandidate {
  id: string;
  lastActiveAt: string | Date;
}

/**
 * Pure freeze selector: given all candidates and the plan limit, return the
 * ids that must freeze. Keeps the `limit` most recently active; ties break on
 * id so the same inputs always freeze the same rows. limit null = unlimited.
 */
export function selectFrozen(
  candidates: readonly FreezeCandidate[],
  limit: number | null,
): Set<string> {
  if (limit === null || candidates.length <= limit) return new Set();
  const sorted = [...candidates].sort((a, b) => {
    const ta = new Date(a.lastActiveAt).getTime();
    const tb = new Date(b.lastActiveAt).getTime();
    if (ta !== tb) return tb - ta; // most recently active first
    return a.id < b.id ? -1 : 1;
  });
  return new Set(sorted.slice(Math.max(limit, 0)).map((c) => c.id));
}

// Activity = latest score event anywhere in the competition, else created_at.
// Passed competitions (v3/07 §3) are excluded here AND from the count below:
// an Event Pass buys that competition out of the active-comp quota for its
// lifetime — which ENDS at the grace boundary (SPEC-4 §7). This used to read
// "a pass row exists", so the exemption never ended (#347): a `live`
// competition past its ends_on + grace was immune to freezing for ever.
// V343's pass_applies is the same predicate the resolver uses.
async function loadCandidates(tx: Tx): Promise<FreezeCandidate[]> {
  const rows = await tx<{ id: string; last_active: string }[]>`
    select c.id,
           greatest(c.created_at, coalesce(max(e.recorded_at), c.created_at)) as last_active
    from competitions c
    left join divisions d on d.competition_id = c.id
    left join fixtures f on f.division_id = d.id
    left join score_events e on e.fixture_id = f.id
    where ${liveUnpassedCompetition(tx)}
    group by c.id, c.created_at`;
  return rows.map((r) => ({ id: r.id, lastActiveAt: r.last_active }));
}

/**
 * The org's frozen competition ids (empty for in-quota orgs — the common case
 * costs one count query).
 *
 * MUST NOT be called from inside a `withTenant` callback. It opens with
 * `getLimit`, which queries the POOLED `sql` proxy on a cache miss; asking the
 * pool for a second connection while `withTenant` still pins the first is the
 * self-deadlock that hung production twice on 2026-08-05 (see
 * `__tests__/pool-nesting-tripwire.test.ts`). It used to take an optional `tx`
 * that looked like it made the nested case safe — it did not: `getLimit` runs
 * BEFORE the `tx` branch is ever reached, so every caller that threaded the
 * ambient transaction through was still nesting a pooled query. The parameter
 * is gone rather than fixed so the trap cannot be re-set; callers inside a
 * transaction resolve the set first and use `assertNotFrozen` below.
 */
export async function frozenCompetitionIds(
  orgId: string,
): Promise<Set<string>> {
  const limit = await getLimit(orgId, "competitions.max_active");
  if (limit === null) return new Set();
  const run = async (t: Tx): Promise<Set<string>> => {
    // The shared count, inside the transaction this already holds — see
    // `quotaCount`. Opening its own would be the nesting this header warns
    // about two paragraphs up.
    const n = await quotaCount(t, { publiclyReadable: false });
    if (n <= limit) return new Set();
    return selectFrozen(await loadCandidates(t), limit);
  };
  return withTenant(orgId, run);
}

/**
 * The guard, split from the lookup: PURE, so it can be evaluated on a
 * competition id that only becomes known inside a transaction without dragging
 * a pooled query in there with it.
 *
 * The two-phase shape every write path now uses:
 *
 *     const frozen = await frozenCompetitionIds(auth.orgId);   // before the tx
 *     return withTenant(auth.orgId, async (tx) => {
 *       const [division] = await tx`select competition_id ...`;
 *       assertNotFrozen(frozen, division.competition_id);      // no I/O
 *     });
 *
 * The set is keyed on the ORG, not on the entity, so hoisting the lookup never
 * needs an id the transaction has not read yet, and the entity's own 404 still
 * fires first (an unknown id is never a member of the set).
 */
export function assertNotFrozen(
  frozen: ReadonlySet<string>,
  competitionId: string,
): void {
  if (frozen.has(competitionId)) {
    throw new PaymentRequiredError("competitions.max_active");
  }
}

/**
 * Write guard for anything living under a competition (divisions, stages,
 * entrants, scoring, edits). Frozen ⇒ 402 carrying the quota key, so the UI
 * shows the same contextual paywall as a blocked create.
 *
 * OUTSIDE a transaction only — see `frozenCompetitionIds`. Callers that already
 * hold the competition id before opening theirs keep using this; callers that
 * read the id inside use `frozenCompetitionIds` + `assertNotFrozen`.
 */
export async function assertCompetitionNotFrozen(
  orgId: string,
  competitionId: string,
): Promise<void> {
  assertNotFrozen(await frozenCompetitionIds(orgId), competitionId);
}

// ---------------------------------------------------------------------------
// Member seats (doc 13 §5 + doc 10 §2.4): after a downgrade an org can hold
// more owner/admin/viewer members than members.max allows. Nothing is
// deleted — over-quota members become effectively read-only (the freeze
// rule), owners exempt (an org must keep a working owner; the owner frees
// seats by demoting/removing). Same lazy selector as competitions, with
// membership age as the activity signal.
// ---------------------------------------------------------------------------

/** user_ids of members whose WRITE access is frozen by members.max. */
export async function frozenMemberIds(orgId: string): Promise<Set<string>> {
  const limit = await getLimit(orgId, "members.max");
  if (limit === null) return new Set();
  const rows = await withTenant(
    orgId,
    (tx) =>
      tx<{ user_id: string; role: string; created_at: string }[]>`
      select user_id, role, created_at from org_members
      where org_id = ${orgId} and role <> 'scorer'`,
  );
  if (rows.length <= limit) return new Set();
  const owners = rows.filter((r) => r.role === "owner");
  const rest = rows.filter((r) => r.role !== "owner");
  // Owners always stay active but still occupy seats.
  const restLimit = Math.max(limit - owners.length, 0);
  return selectFrozen(
    rest.map((r) => ({ id: r.user_id, lastActiveAt: r.created_at })),
    restLimit,
  );
}

/** 402 when this member's seat is frozen (doc 10 §2.4) — call on write auth. */
export async function assertMemberNotFrozen(
  orgId: string,
  userId: string,
): Promise<void> {
  const frozen = await frozenMemberIds(orgId);
  if (frozen.has(userId)) throw new PaymentRequiredError("members.max");
}
