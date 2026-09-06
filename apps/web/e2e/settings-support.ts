import type { APIRequestContext, Browser, BrowserContext } from "@playwright/test";
import { expect } from "@playwright/test";
import {
  TAG,
  apiJson,
  releaseSeededOrgSql,
  setOrgPlanBySql,
  splitOrgIntoOwnGroupSql,
} from "./helpers";
// Type-only: erased at compile time (same pattern as event-pass.spec.ts's
// `PassLockReason` import), so it costs nothing at runtime. A VALUE import of
// anything from settings-nav.tsx is not possible from this process — verified
// empirically, see the comment on `TABS` below.
import type { SettingsTab } from "../src/app/o/[orgSlug]/settings/_components/settings-nav";

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
    // NOT a no-op (corrected 2026-09-06, W4 Task 3 review) — `splitOrgIntoOwnGroupSql`
    // (helpers.ts:1158-1166) unconditionally mints a NEW `subscriptions` row and
    // deletes the old one, even though `createOrgForUser` already gave this org
    // its own group. This is why a `"pro"`-seeded org has NO credit history: the
    // bootstrap grant lives on the row this call just replaced. What IS a no-op
    // here is only the cross-org drag this call exists to prevent: for the V309
    // shape, a new org joined its creator's EXISTING group, under which the plan
    // flip below would drag every sibling on that bill, the shared Pro org
    // included. Kept for that reason, not because it does nothing.
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

export interface MemberIdentity {
  ctx: BrowserContext;
  request: APIRequestContext;
  userId: string;
  release: () => Promise<void>;
}

/**
 * A real non-owner member of `orgId`, drivable as its own APIRequestContext.
 *
 * There is no `impersonate`/`loginAs`/`addMemberSql` anywhere in this suite
 * (verified — grepped `apps/web/e2e/`), and `members/route.ts` exports GET
 * only, so there is no add-member POST to call directly. The only working
 * pattern is `members-roles.spec.ts:17-35`: the owner mints
 * `POST /api/orgs/{id}/invites {role, max_uses}`, then a second browser
 * context on the community storageState calls
 * `POST /api/invites/{token}/accept`.
 *
 * The community storageState is the ONLY second identity the suite has, and
 * no project wires it in (playwright.config.ts declares pro.json everywhere),
 * so it is opted into per-context exactly like members-roles.spec.ts:17-35.
 *
 * `browser.newContext()` with NO storageState would inherit the signed-in Pro
 * session — the bug that makes a gate test pass as the owner. The path is
 * named explicitly for that reason.
 */
export async function seedMemberIdentity(
  browser: Browser,
  owner: APIRequestContext,
  orgId: string,
  role: "admin" | "viewer" | "scorer",
): Promise<MemberIdentity> {
  const invite = await owner.post(`/api/orgs/${orgId}/invites`, {
    data: { role, max_uses: 1 },
  });
  if (!invite.ok()) {
    throw new Error(`invite mint failed: ${invite.status()} ${await invite.text()}`);
  }
  const token = ((await invite.json()) as { data: { token: string } }).data.token;

  const ctx = await browser.newContext({ storageState: "e2e/.auth/community.json" });
  const accept = await ctx.request.post(`/api/invites/${token}/accept`);
  if (!accept.ok()) {
    await ctx.close();
    throw new Error(`invite accept failed: ${accept.status()} ${await accept.text()}`);
  }
  const me = await ctx.request.get("/api/users/me");
  const userId = ((await me.json()) as { data: { id: string } }).data.id;

  return {
    ctx,
    request: ctx.request,
    userId,
    // The community user outlives this test. Remove the membership so the next
    // run's accept is a fresh join rather than a no-op on an existing row.
    //
    // Both steps are independently `.catch`-guarded so one failing can never
    // block the other from running, and `release()` itself never rejects and
    // short-circuits a caller's `finally` chain (a caller typically runs
    // `await member.release(); await releaseSettingsOrg(request, org);` in
    // sequence — an unguarded throw here would leak the seeded org too).
    //
    // Known gap, not fixed here: if `owner.delete(...)` fails for a reason
    // OTHER than "already removed", it is swallowed silently and nothing else
    // cleans up that membership row. `releaseSeededOrgSql`
    // (`e2e/helpers.ts:1143-1153`) soft-deletes the org (`deleted_at = now()`,
    // not a real `DELETE`), so the `org_members` row's `ON DELETE CASCADE` FK
    // never fires as a backstop — the row can permanently pollute the shared
    // `e2e/.auth/community.json` fixture's visible org list. Flagged for
    // whoever writes the Task 5 mutation sweep.
    release: async () => {
      await owner.delete(`/api/orgs/${orgId}/members/${userId}`).catch(() => {});
      await ctx.close().catch(() => {});
    },
  };
}

/**
 * Assert the ROUTE's own answer to a write, with the label in the message.
 *
 * Deliberately asserts an exact status, not `>= 400`: the two route families
 * differ (401 vs 403) and "some kind of refusal" is satisfied by a 404 from a
 * path typo, which is how a matrix row silently stops testing anything.
 */
export async function expectGate(opts: {
  label: string;
  request: APIRequestContext;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  expectStatus: number;
}): Promise<void> {
  const { request, method, path, body } = opts;
  const res = await request.fetch(path, {
    method,
    ...(body === undefined ? {} : { data: body }),
  });
  expect(
    res.status(),
    `${opts.label}: ${method} ${path} answered ${res.status()}, expected ${opts.expectStatus} — ${await res.text()}`,
  ).toBe(opts.expectStatus);
}

/**
 * The seven `?tab=` keys, typed directly against the app's own `SettingsTab`
 * union (`settings-nav.tsx`) so a renamed or removed key reds `tsc` here.
 *
 * NOT a runtime import of `SETTINGS_TABS` itself — verified infeasible from
 * this process, two independent ways. `settings-nav.tsx` is a page-tree
 * component: importing it (even for one named export) pulls in
 * `@/components/ui/console-link` -> `next/link`, an extensionless specifier
 * Next's bundler resolves and plain Node ESM cannot (confirmed empirically —
 * a probe `import { SETTINGS_TABS } from ".../settings-nav"` in a Playwright
 * spec fails with `Cannot find module '.../node_modules/next/link'`). Past
 * that it also pulls in `@/lib/i18n` and `@/lib/credits`, both of which open
 * with a bare `import "server-only"`, a specifier that resolves only inside
 * Next's own build — `node -e "require.resolve('server-only')"` from this
 * workspace throws `MODULE_NOT_FOUND`. `import type` is erased at compile
 * time (confirmed empirically too — the same probe file with `import type {
 * SettingsTab }` instead runs clean), so it costs nothing at runtime; a plain
 * value import does not have that option.
 *
 * Gap this leaves, recorded rather than hidden: this catches a RENAMED or
 * REMOVED tab (the literal would no longer satisfy `SettingsTab` and `tsc`
 * reds), but not a tab ADDED to the app and never mirrored here. Closing that
 * fully would mean giving the app a values-only constants module that both
 * `settings-nav.tsx` and this file could import — an app-source change, out
 * of this task's one-file scope.
 */
export const TABS: readonly SettingsTab[] = [
  "organization",
  "news",
  "sponsors",
  "team",
  "api",
  "preferences",
  "account",
] as const;
