import "server-only";
// Server Component auth for the organiser UI (doc 08 §1: pages read through
// the same service layer as /api/v1 — no HTTP hop). Builds the AuthCtx the
// use-cases expect from the session cookie.
//
// PROMPT-30: the /o tree authorises from the URL (requireOrgPage family) —
// the seazn_org cookie no longer decides what a page shows, so two tabs on
// two orgs can't corrupt each other. Renamed slugs permanent-redirect.
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { getCurrentUser, getUserOrgs, getActiveOrgId, safeNextPath } from "@/lib/auth";
import { sql } from "@/lib/db";
import { EDITOR_ROLES, type OrgMembership, type User } from "@/lib/types";
import { resourceOrg, type AuthCtx, type ResourceKind } from "@/server/api-v1/auth";
import { HttpError } from "@/lib/errors";
import { routes } from "@/lib/routes";
import {
  orgBySlug,
  compBySlug,
  divBySlug,
  fixtureByNo,
  type ResolvedEntity,
  type Resolution,
} from "@/server/slug-resolve";

export interface PageAuth {
  auth: AuthCtx;
  user: User;
  org: OrgMembership;
  canEdit: boolean;
}

// ---------------------------------------------------------------------------
// The /orgs/new destination contract (W2 task 6 — F7's residual).
//
// The org-less bounce used to be a bare `redirect("/orgs/new")` that threw the
// destination away. W1.5 made that reachable rather than theoretical:
// `postAuthLanding` now honours a safe `next` WITHOUT provisioning an org
// (lib/auth.ts:444-453), so a first-time signup arriving at
// `/login?next=/settings?tab=account&email_change=success` lands org-less, is
// bounced here, and the outcome of the email change they just confirmed is
// gone — they see an ordinary onboarding page and never learn what happened.
//
// Both ends REUSE `safeNextPath`. It is not widened, not relaxed, and not
// re-implemented: it is the single origin check in this repo, and W1.5 wrote
// it the way it is because a prefix test on a leading "/" is NOT origin
// validation — `new URL("/\\evil.com", "https://seazn.club").href` is
// "https://evil.com/", the URL parser having normalised the backslash to a
// slash in the authority position. Widening reach to an untouched validator
// is itself a security change, so the reach is exactly two call sites and
// both refuse identically.
//
// Both are exported (rather than inlined where they are used) because neither
// branch is reachable from a node-env unit test: `requirePageAuth` needs a
// session, a database and Next's `redirect()`, and `/orgs/new` is a Server
// Component. `safe-next-path.test.ts` pins the refusals here.
// ---------------------------------------------------------------------------

/**
 * Where an org-less visitor is sent, carrying the destination they asked for.
 *
 * A refused or absent `next` yields the exact literal this branch has always
 * emitted, so no visitor's behaviour today can move: the query is added or it
 * is not, and there is no third outcome.
 */
export function orgLessRedirect(next: unknown): string {
  const safe = safeNextPath(next);
  // Encoded, not interpolated raw: the destination carries its own `?` and
  // `&` (`/settings?tab=account&email_change=success` is the archetype), and
  // pasted in unencoded those become extra params OF /orgs/new — the page
  // would then read `next` as "/settings" and silently drop the two params
  // the whole contract exists to preserve.
  return safe ? `/orgs/new?next=${encodeURIComponent(safe)}` : "/orgs/new";
}

/**
 * The post-create destination `/orgs/new` will honour, read from its own
 * query. `null` means "no destination" and the form keeps its `/dashboard`
 * default.
 *
 * Validated HERE as well as at the producer, deliberately. `/orgs/new` is a
 * public URL — nothing stops anyone mailing `/orgs/new?next=/\evil.com` — so
 * a check that lived only in `orgLessRedirect` would leave the page pushing a
 * stranger's origin after a successful create. Two guards covering for each
 * other are each untested; these two are mutated one at a time.
 */
export function newOrgDestination(sp: Record<string, string | undefined>): string | null {
  return safeNextPath(sp.next);
}

/** Session auth against the active org. Redirects out when unauthenticated. */
export async function requirePageAuth(opts: { next?: unknown } = {}): Promise<PageAuth> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const orgs = await getUserOrgs(user.id);
  if (orgs.length === 0) redirect(orgLessRedirect(opts.next));
  const activeId = await getActiveOrgId();
  const org = orgs.find((o) => o.id === activeId) ?? (orgs[0] as OrgMembership);
  return {
    auth: { orgId: org.id, via: "session", userId: user.id, role: org.role, keyId: null },
    user,
    org,
    canEdit: (EDITOR_ROLES as readonly string[]).includes(org.role),
  };
}

// ---------------------------------------------------------------------------
// PROMPT-30: URL-derived auth for the /o/[orgSlug]/... tree.
// ---------------------------------------------------------------------------

/** Unwrap a slug resolution: miss → 404 (existence never leaks past
 *  membership, which callers check first); rename → 301 to the URL the
 *  builder makes from the current slug. */
function settle(res: Resolution, target: (newSlug: string) => string): ResolvedEntity {
  if (res && "renamedTo" in res) permanentRedirect(target(res.renamedTo));
  if (!res) notFound();
  return res;
}

/** Session auth from the org slug in the path. Members only — non-members
 * 404 (existence never leaks). */
export async function requireOrgPage(
  orgSlug: string,
  opts: { tail?: string } = {},
): Promise<PageAuth> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const resolved = await orgBySlug(orgSlug);
  if (resolved && "renamedTo" in resolved) {
    permanentRedirect(routes.orgHome(resolved.renamedTo) + (opts.tail ?? ""));
  }
  if (!resolved) notFound();
  const orgs = await getUserOrgs(user.id);
  const org = orgs.find((o) => o.id === resolved.id);
  if (!org) notFound();
  return {
    auth: { orgId: org.id, via: "session", userId: user.id, role: org.role, keyId: null },
    user,
    org,
    canEdit: (EDITOR_ROLES as readonly string[]).includes(org.role),
  };
}

/**
 * Session auth for the BILLING tabs under `/o/[orgSlug]/settings`
 * (Billing, Credits, Add-ons) — v17 gap #333.
 *
 * `requireOrgPage`'s rule is membership, and that is right for every organiser
 * surface: those pages are about the club. Billing is not about the club, it is
 * about the GROUP — `subscriptions` is its own row with its own
 * `owner_user_id`, one bill may fund many clubs, and `transferGroup` moves that
 * column ALONE, leaving memberships untouched. So a payer can end up funding a
 * bill they are not a member of (by transfer, or by an org owner removing them)
 * and, gated on membership, has no route to any of the pages that manage it —
 * not even to cancel.
 *
 * THE ONE RELAXATION, stated exactly: membership is no longer the only way in.
 * The group's payer is admitted as well. Nothing else moves —
 *
 *   - a member is admitted on exactly the terms `requireOrgPage` gives them,
 *     with the same role and the same `canEdit`;
 *   - a non-member who does NOT pay for this org's group still 404s, so
 *     existence is never leaked to a stranger;
 *   - the payer is admitted READ-ONLY as far as the org goes: `role` is null
 *     and `canEdit` is false, so nothing here becomes a way to edit a club.
 *     What they get is the bill, which is theirs already.
 *
 * `requireOrgPage` itself is deliberately UNCHANGED. Putting the exception
 * inside it would relax the membership rule for every organiser page in the
 * tree to serve three tabs; a separate gate keeps the widening where it is
 * legible and where a reviewer can see its whole audience.
 *
 * `viaPayer` tells the page which of the two it is looking at. Chrome that
 * assumes membership — the back link into the org's own Settings index, which
 * IS member-gated — must not be rendered for a payer who would only 404 on it.
 */
export async function requireBillingPage(
  orgSlug: string,
  opts: { tail?: string } = {},
): Promise<PageAuth & { viaPayer: boolean }> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const resolved = await orgBySlug(orgSlug);
  if (resolved && "renamedTo" in resolved) {
    permanentRedirect(routes.orgHome(resolved.renamedTo) + (opts.tail ?? ""));
  }
  if (!resolved) notFound();
  const orgs = await getUserOrgs(user.id);
  const org = orgs.find((o) => o.id === resolved.id);

  if (org) {
    return {
      auth: { orgId: org.id, via: "session", userId: user.id, role: org.role, keyId: null },
      user,
      org,
      canEdit: (EDITOR_ROLES as readonly string[]).includes(org.role),
      viaPayer: false,
    };
  }

  const [payer] = await sql<{ owner_user_id: string }[]>`
    select s.owner_user_id
      from organizations o
      join subscriptions s on s.id = o.subscription_id
     where o.id = ${resolved.id}`;
  if (!payer || payer.owner_user_id !== user.id) notFound();

  return {
    auth: { orgId: resolved.id, via: "session", userId: user.id, role: null, keyId: null },
    user,
    org: {
      id: resolved.id,
      slug: resolved.slug,
      name: resolved.name,
      role: null,
    } as unknown as OrgMembership,
    canEdit: false,
    viaPayer: true,
  };
}

/** `tail` keeps sub-pages (/schedule, /settings, …) on their own page after
 *  a rename redirect. */
export async function requireCompetitionPage(
  orgSlug: string,
  compSlug: string,
  opts: { tail?: string } = {},
): Promise<PageAuth & { competition: ResolvedEntity }> {
  const page = await requireOrgPage(orgSlug, opts);
  const competition = settle(
    await compBySlug(page.org.id, compSlug),
    (s) => routes.competition(orgSlug, s) + (opts.tail ?? ""),
  );
  return { ...page, competition };
}

export async function requireDivisionPage(
  orgSlug: string,
  compSlug: string,
  divSlug: string,
  opts: { tail?: string } = {},
): Promise<PageAuth & { competition: ResolvedEntity; division: ResolvedEntity }> {
  const withComp = await requireCompetitionPage(orgSlug, compSlug);
  const division = settle(
    await divBySlug(withComp.competition.id, divSlug),
    (s) => routes.division(orgSlug, compSlug, s) + (opts.tail ?? ""),
  );
  return { ...withComp, division };
}

/**
 * Fixture pages allow accepted officials (design v2 §A2) — parity with
 * requireResourcePageAuth's fixture path.
 */
export async function requireFixturePage(
  orgSlug: string,
  compSlug: string,
  divSlug: string,
  no: number,
): Promise<
  PageAuth & {
    competition: ResolvedEntity;
    division: ResolvedEntity;
    fixtureId: string;
    canScore: boolean;
  }
> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const org = settle(await orgBySlug(orgSlug), (s) => routes.orgHome(s));
  const orgs = await getUserOrgs(user.id);
  const membership = orgs.find((o) => o.id === org.id);
  const compRes = await compBySlug(org.id, compSlug);
  if (!compRes) notFound();
  if ("renamedTo" in compRes) {
    if (membership) permanentRedirect(routes.competition(orgSlug, compRes.renamedTo));
    notFound();
  }
  const competition = compRes;

  const divRes = await divBySlug(competition.id, divSlug);
  if (!divRes) notFound();
  if ("renamedTo" in divRes) {
    if (membership) permanentRedirect(routes.division(orgSlug, compSlug, divRes.renamedTo));
    notFound();
  }
  const division = divRes;
  const fixture = await fixtureByNo(division.id, no);
  if (!fixture) notFound();

  const canEdit = membership
    ? (EDITOR_ROLES as readonly string[]).includes(membership.role)
    : false;
  let canScore = canEdit;
  if (!canScore) {
    const { acceptedOfficialCovers } = await import("@/server/usecases/scorers");
    if (await acceptedOfficialCovers(user.id, fixture.id)) canScore = true;
    else if (!membership) notFound();
  }
  return {
    auth: { orgId: org.id, via: "session", userId: user.id, role: membership?.role ?? null, keyId: null },
    user,
    org:
      membership ??
      ({ id: org.id, slug: org.slug, name: org.name, role: null } as unknown as OrgMembership),
    canEdit,
    canScore,
    competition,
    division,
    fixtureId: fixture.id,
  };
}

/**
 * Session auth against the org that OWNS a resource (deep links keep working
 * across the user's orgs). 404 when the resource doesn't exist or the user
 * has no role in its org — existence is never leaked.
 *
 * Non-editors see fixture pages when a covering official assignment exists
 * (canScore true); every other organiser page 404s for non-members.
 */
export async function requireResourcePageAuth(
  kind: ResourceKind,
  id: string,
): Promise<PageAuth & { canScore: boolean }> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  let orgId: string;
  try {
    orgId = await resourceOrg(kind, id);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }
  const orgs = await getUserOrgs(user.id);
  const org = orgs.find((o) => o.id === orgId);

  const canEdit = org ? (EDITOR_ROLES as readonly string[]).includes(org.role) : false;
  let canScore = canEdit;
  if (!canScore && kind === "fixture") {
    const { acceptedOfficialCovers } = await import("@/server/usecases/scorers");
    if (await acceptedOfficialCovers(user.id, id)) canScore = true;
    else if (!org) notFound();
  } else if (!org) {
    notFound();
  }
  return {
    auth: { orgId, via: "session", userId: user.id, role: org?.role ?? null, keyId: null },
    user,
    org:
      org ??
      ({ id: orgId, slug: "", name: "", role: null } as unknown as OrgMembership),
    canEdit,
    canScore,
  };
}
