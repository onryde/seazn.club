import type { APIRequestContext } from "@playwright/test";
import {
  TAG,
  apiJson,
  releaseSeededOrgSql,
  setOrgPlanBySql,
  splitOrgIntoOwnGroupSql,
} from "./helpers";

/**
 * Support for the W2 settings walkthrough specs.
 *
 * Deliberately OUTSIDE `e2e/walkthrough/`: the `walkthrough` project's
 * `testMatch` is a bare directory regex matched against each file's absolute
 * path, and `testMatch` REPLACES Playwright's default spec pattern. Every
 * `.ts` under `e2e/walkthrough/` is loaded as a spec, so a helper placed there
 * fails with `test file "…" should not import test file "…"`.
 */

export interface SeededOrg {
  orgId: string;
  slug: string;
  name: string;
  /** The `seazn_org` value before this seed moved it — see the note below. */
  previousActiveOrgId: string | null;
}

/** `/o/{slug}/settings?tab=…` — one place, so a route change moves every spec. */
export function settingsUrl(slug: string, tab: string): string {
  return `/o/${slug}/settings?tab=${tab}`;
}

async function activeOrgCookie(request: APIRequestContext): Promise<string | null> {
  const state = await request.storageState();
  return state.cookies.find((c) => c.name === "seazn_org")?.value ?? null;
}

/**
 * One org per SPEC FILE, not per test.
 *
 * The design's §8.1 says one per test. It cannot: the shared Pro user may own
 * five orgs in total (`orgs.max_owned`, and `assertMayOwnAnotherOrg` bounds a
 * PERSON, not a group), the whole walkthrough + parallel leg shares that user,
 * and `org-management.spec.ts` already spends one on every run. A per-test
 * seed exhausts the cap inside a single file and 402s.
 *
 * Two other behaviours this has to work around, both read out of the tree on
 * 2026-09-05 rather than assumed:
 *
 *  - `createOrgForUser` (src/lib/auth.ts) opens every new org on its OWN
 *    community subscription — the insert is literally
 *    `insert into subscriptions (…) values (…, 'community', 'active', 1)`.
 *    A fresh org is therefore COMMUNITY: every Pro-gated control on these tabs
 *    (`sponsors.tiers`, `sponsors.monetize`, `api.access`, `news.auto`,
 *    `dashboard.branding`) renders as an upsell until it is flipped.
 *  - `POST /api/orgs` (src/app/api/orgs/route.ts) calls `setActiveOrgId`, and
 *    an APIRequestContext shares the browser context's cookie jar. Seeding
 *    moves the active org out from under the caller, so the previous value is
 *    captured here and restored by {@link releaseSettingsOrg}.
 */
export async function seedSettingsOrg(
  request: APIRequestContext,
  opts: { plan?: "community" | "pro"; label?: string } = {},
): Promise<SeededOrg> {
  const previousActiveOrgId = await activeOrgCookie(request);
  const name = `Settings ${opts.label ?? "W2"} ${TAG}-${Math.random().toString(36).slice(2, 6)}`;
  const created = await apiJson<{ id: string; slug: string; name: string }>(
    request,
    "/api/orgs",
    "POST",
    { name },
  );
  if (!created.data) {
    throw new Error(
      `seedSettingsOrg: POST /api/orgs failed (${created.status}) ${created.error?.code ?? ""} ${
        created.error?.message ?? ""
      }`.trim(),
    );
  }

  const seeded: SeededOrg = {
    orgId: created.data.id,
    slug: created.data.slug,
    name: created.data.name,
    previousActiveOrgId,
  };

  if ((opts.plan ?? "pro") === "pro") {
    // DEFENSIVE, and doing no work today — say so plainly, because a later
    // session that believes this line is earning its keep will not notice the
    // day it silently starts to. `createOrgForUser` already inserts a fresh
    // `subscriptions` row per org, so the group is this org's own before the
    // split runs and the split is a no-op. It is kept for the V309 shape, in
    // which a new org joined its creator's EXISTING group — under which the
    // plan flip below would drag every sibling on that bill, the shared Pro
    // org included.
    await splitOrgIntoOwnGroupSql(seeded.orgId);
    // `setOrgPlanBySql` takes a TARGET OBJECT, not a bare id (helpers.ts —
    // `{ orgId?, email? }`), and when given `orgId` it resolves that org's
    // billing GROUP via `requireGroupId` and updates `subscriptions` by group
    // id. It is GROUP-scoped, never org-scoped — which is exactly why the
    // call above matters if the default ever reverts.
    await setOrgPlanBySql({ orgId: seeded.orgId }, "pro");
  }
  return seeded;
}

/** Restore the active org, then hand the creation slot back. Safe to call twice. */
export async function releaseSettingsOrg(
  request: APIRequestContext,
  seeded: SeededOrg,
): Promise<void> {
  if (seeded.previousActiveOrgId) {
    // `setActiveOrgSchema` is `.strict()` and its key is `org_id`, snake_case
    // (src/lib/types.ts) — an `{ orgId }` body 400s on an unrecognised key and
    // leaves the cookie pointing at the org this seed is about to delete.
    await apiJson(request, "/api/orgs/active", "POST", { org_id: seeded.previousActiveOrgId });
  }
  // No owner lookup here: `withDb` is module-private to helpers.ts, so it
  // cannot be imported. `releaseSeededOrgSql`'s own `role = 'owner'` branch
  // runs the identical delete against this org's single owner row.
  await releaseSeededOrgSql(seeded.orgId);
}
