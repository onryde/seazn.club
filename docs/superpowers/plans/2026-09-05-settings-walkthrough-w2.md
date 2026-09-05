# Settings walkthrough W2 — the seven `/o/{org}/settings` tabs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Drive and persist every control on the seven `?tab=` panels of
`/o/{org}/settings` (sponsors CRUD half only), fix the phone composition of
that page, and close the two items W1.5 handed forward.

**Architecture:** Two new walkthrough specs plus one shared support module,
sitting beside the existing `settings-admin.spec.ts`. The page itself changes
in exactly two places — the org identity row's phone layout, and `/orgs/new`
gaining a destination contract. No new route, no schema change.

**Tech Stack:** Playwright 1.61.1 (`walkthrough` project, `--workers=3`),
vitest `environment: "node"`, Next 16.2.9 App Router, postgres.js.

**Spec:** `docs/superpowers/specs/2026-09-03-settings-walkthrough-design.md`
**Programme index:** `docs/superpowers/specs/2026-09-03-settings-walkthrough-prompts/_INDEX.md`
**Programme rules:** `docs/superpowers/specs/2026-09-03-settings-walkthrough-prompts/_RULES.md`

---

## Global Constraints

Every task's requirements implicitly include this section.

1. **`pnpm`, never `npm install`.** `package.json` declares `pnpm@10.34.5`;
   `npm install` fails with `Unsupported URL Type "workspace:"`.
2. **Judge a vitest green only from `--reporter=json --outputFile`**, reading
   `numPassedTests`/`numTotalTests`, and confirm `.testResults[].name`
   resolves inside this worktree. `rtk` prints `PASS(0) FAIL(0)` for a suite
   that failed to collect and swallows exit codes.
3. **Run whole Playwright spec files, never a `-g` slice.** A `-g` filter is a
   filename sweep in costume and has already passed six green gates while
   missing the two tests a change broke.
4. **`apps/web` vitest is `environment: "node"`.** It cannot see a rendered
   button's enabled state, CSS cascade, focus, or tap area. Anything a user
   touches is proven by e2e or not at all.
5. **Every project runs as ONE shared Pro org** (`AUTH_STATE = e2e/.auth/pro.json`
   for `parallel`, `walkthrough` and `serial` alike). Scope every count to the
   spec's own `TAG`; never to a global total.
6. **Restore every borrowed privilege and shared resource in a `finally` /
   `afterAll`,** never a `finally` inside a test that can time out — a
   Playwright `test.setTimeout` skips `finally`.
7. **No new hardcoded user-facing English.** Any new or changed string ships in
   all four locale dictionaries and is regenerated through `gen-keys`.
   `/admin` and `content/help/**` are the only exemptions, and neither is in
   scope here.
8. **The phone rules from the composition design of record**
   (`docs/superpowers/specs/2026-09-02-scorepad-v3-phone-composition-design.md`):
   ONE DOM branched — below `md` (768) is `max-md:*`, phone-only is
   `md:hidden`, never a second phone tree. **≥768 must not change.**
   `/\bmd:hidden\b/` also matches inside `max-md:hidden`, so an assertion
   written that way passes on its own inversion — anchor on `\s...hidden"`.
9. **Speed budget: ≤60s added to the walkthrough leg across the whole
   programme.** Report raw before/after numbers each wave. No
   `waitForTimeout`; `expect.poll` / `waitForResponse` only. At most one
   `page.reload()` per tab. Derived timeouts
   (`Math.max(FLOOR, base + n * per_unit)`), never a flat constant beside a
   derived cost.
10. **Never `git add -A` or `git add .`.** Tasks run concurrently in one
    worktree and share a git index. Stage the exact paths your task owns.

---

## Findings that change the design — read before Task 1

These were established by reading the tree on 2026-09-05, and two of them
contradict documents this plan otherwise defers to. They bind.

### A. `_RULES.md` §2 is STALE — a new org gets its OWN community group

`_RULES.md` §2 says "`POST /api/orgs` creates an org that joins its creator's
**existing** group", and requires `splitOrgIntoOwnGroupSql` before any plan
flip. That was V309 behaviour. `createOrgForUser`
(`apps/web/src/lib/auth.ts:326-329`) now opens every org on its own bill:

```
insert into subscriptions (owner_user_id, plan_key, status, quantity_paid)
values (${userId}, 'community', 'active', 1)
```

Two consequences, both load-bearing:

- **`setOrgPlanBySql` on a freshly seeded org is now safe** — it can no longer
  drag the shared Pro org with it. Keep calling `splitOrgIntoOwnGroupSql`
  anyway (it is close to a no-op and costs one statement) so the spec stays
  correct if the default flips back. Say "defensive", not "necessary": if a
  later session believes that call is doing work today, it will not notice
  when it silently starts to.
- **A freshly seeded org is COMMUNITY, not Pro.** Every Pro-gated control on
  these tabs — `sponsors.tiers`, `sponsors.monetize`, `api.access`,
  `news.auto`, `dashboard.branding` — renders gated on it. A W2 spec that
  seeds an org and expects the Pro surface will assert against an upsell.
  Seeded orgs must be flipped to `pro` before driving them.

### B. The shared Pro user can own at most FIVE organisations, ever

`assertMayOwnAnotherOrg` (`apps/web/src/lib/auth.ts:223-226`) counts
`org_members` rows where `role = 'owner'` **for the user**, with no
`deleted_at` filter, and refuses when `owned.length + 1 > limit`. `limit` is
the max `orgs.max_owned` across the orgs that user owns — 5 on Pro
(`src/lib/billing-group.ts:109`).

- Soft-deleting an org does **not** return the slot; only removing the owner's
  `org_members` row does.
- The whole leg shares that user, and `org-management.spec.ts:35` already
  mints a second org on every run.
- **The design's "one org per test" (§8.1) is therefore not executable for
  W2.** It would exhaust the cap inside one spec file and 402 with
  `PaymentRequiredError`.

**Ruling:** one org per **spec file**, seeded in `beforeAll`, released in
`afterAll` via a new `releaseSeededOrgSql` that drops the owner membership row
and soft-deletes the org. Two spec files, two orgs in flight, both returned.

### C. `POST /api/orgs` switches the active org

`src/app/api/orgs/route.ts:29` calls `setActiveOrgId(org.id)`, and an
`APIRequestContext` shares the browser context's cookie jar. Seeding an org
moves the `seazn_org` cookie for that context. Every seed must restore the
previous active org, or a later assertion reads the wrong org's page.

### D. The tab rail is already a REACHABLE scrolling rail — do not "fix" it

The owner's 320px capture shows the rail cut off at the right edge. That is
the feature, not the defect. `settings-nav.tsx:217` carries
`scroll-x scroll-x-fade`, and `.scroll-x` is `@apply overflow-x-auto`
(`apps/web/src/app/globals.css:396-399`), inside a `ScrollActiveTabIntoView`
wrapper. Under AGENTS.md failure class 23 that is the reachable kind of
overflow, and `overflowingIn` (`e2e/mobile.spec.ts:91`) already classifies it
as `scrollable` rather than `clipped`. **Changing it would break a working
rail.** Record it as a case that turned out already-correct (`_RULES.md` §8)
and leave the markup alone.

---

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `apps/web/e2e/settings-support.ts` (create) | 1 | `seedSettingsOrg`, `restoreActiveOrg`, `openTab`, `saveAndReload` — page-driving support, deliberately OUTSIDE `e2e/walkthrough/` |
| `apps/web/e2e/helpers.ts` (modify) | 1 | `releaseSeededOrgSql` beside the other `withDb` helpers |
| `apps/web/e2e/walkthrough/settings-org-tabs.spec.ts` (create) | 2 | organisation, news, sponsors (CRUD half) |
| `apps/web/e2e/walkthrough/settings-people-tabs.spec.ts` (create) | 3 | team, api, preferences, account |
| `apps/web/src/app/o/[orgSlug]/settings/page.tsx` (modify) | 4 | the identity row's phone layout |
| `apps/web/e2e/mobile.spec.ts` (modify) | 4 | the width gate that fails without task 4 |
| `apps/web/e2e/walkthrough/settings-admin.spec.ts` (modify) | 5 | drive the email-change PRODUCER, not the URL |
| `apps/web/src/server/page-auth.ts` (modify) | 6 | carry the intended destination through the org-less bounce |
| `apps/web/src/app/orgs/new/page.tsx` (modify) | 6 | accept and honour `?next=` |
| `apps/web/src/components/create-org-form.tsx` (modify) | 6 | post-create destination |
| `apps/web/src/lib/__tests__/safe-next-path.test.ts` (modify) | 6 | the `/orgs/new` contract's unit half |

**Tasks 1, 4, 5 and 6 have provably disjoint file sets and run in parallel.**
Tasks 2 and 3 both consume Task 1's module and start once it lands; they are
disjoint from each other.

---

## Task 1: Support module and the org-slot release helper

**Files:**
- Create: `apps/web/e2e/settings-support.ts`
- Modify: `apps/web/e2e/helpers.ts` (append near `splitOrgIntoOwnGroupSql`)

**Interfaces:**
- Consumes: `withDb`, `apiJson`, `TAG`, `setOrgPlanBySql`,
  `splitOrgIntoOwnGroupSql`, `activeOrgIdFromRequest` from `./helpers`.
- Produces, for Tasks 2 and 3:
  - `seedSettingsOrg(request: APIRequestContext, opts?: { plan?: "community" | "pro"; label?: string }): Promise<SeededOrg>`
    where `SeededOrg = { orgId: string; slug: string; name: string; previousActiveOrgId: string | null }`
  - `releaseSettingsOrg(request: APIRequestContext, seeded: SeededOrg): Promise<void>`
  - `settingsUrl(slug: string, tab: string): string`
  - `releaseSeededOrgSql(orgId: string, ownerUserId?: string): Promise<void>` (from `./helpers`)

**Why this module exists and why it is not in `e2e/walkthrough/`:** the
`walkthrough` project's `testMatch` is a bare directory regex matched against
each file's absolute path, and `testMatch` REPLACES Playwright's default spec
pattern. Every `.ts` under `e2e/walkthrough/` is loaded as a spec, so a helper
placed there fails with `test file "…" should not import test file "…"`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/e2e/walkthrough/settings-support-smoke.spec.ts` — a real
consumer, so the module is not an inert seam on the day it lands:

```ts
import { test, expect } from "@playwright/test";
import { seedSettingsOrg, releaseSettingsOrg, settingsUrl } from "../settings-support";
import { apiJson } from "../helpers";

test.describe.configure({ mode: "default" });

test("a seeded settings org is Pro, reachable, and returns its slot", async ({ page }) => {
  const before = await apiJson<{ id: string }[]>(page.request, "/api/orgs");
  const seeded = await seedSettingsOrg(page.request, { plan: "pro" });
  try {
    // It exists, and the settings page renders it under its own slug.
    await page.goto(settingsUrl(seeded.slug, "organization"));
    await expect(page.getByText(seeded.name, { exact: false }).first()).toBeVisible({
      timeout: 20_000,
    });

    // Finding A: a fresh org is community by default. Prove the flip took,
    // by asking for a Pro-gated surface rather than reading the plan back.
    await page.goto(settingsUrl(seeded.slug, "api"));
    await expect(page.getByRole("button", { name: /create/i }).first()).toBeVisible({
      timeout: 20_000,
    });
  } finally {
    await releaseSettingsOrg(page.request, seeded);
  }

  // Finding B: the slot came back — the owned count is what it was.
  const after = await apiJson<{ id: string }[]>(page.request, "/api/orgs");
  expect(after.data?.length ?? 0).toBe(before.data?.length ?? 0);
});
```

- [ ] **Step 2: Run it and watch it fail for the right reason**

```bash
cd apps/web && npx playwright test e2e/walkthrough/settings-support-smoke.spec.ts \
  --project=walkthrough --reporter=list
```

Expected: `Cannot find module '../settings-support'`. If it fails any other
way, stop and read the error — a different failure means a different premise.

- [ ] **Step 3: Add `releaseSeededOrgSql` to `e2e/helpers.ts`**

Place it directly after `splitOrgIntoOwnGroupSql`. The comment is the point:
a future reader must not "simplify" it into a soft delete.

```ts
/**
 * Return an org-creation SLOT to `ownerUserId`, and take the org out of the
 * lists the UI reads.
 *
 * A soft delete is NOT enough. `assertMayOwnAnotherOrg` (lib/auth.ts:223)
 * counts `org_members` rows with `role = 'owner'` for the user and applies no
 * `deleted_at` filter at all, so an org that is soft-deleted still spends one
 * of the five slots a Pro user gets (`orgs.max_owned`, billing-group.ts:109).
 * Dropping the owner membership row is what actually frees it.
 *
 * Both statements, because either alone leaves a visible wrong state: without
 * the membership drop the slot leaks and the sixth seed in a leg 402s; without
 * the soft delete the org keeps appearing in public listings with no owner.
 */
export async function releaseSeededOrgSql(orgId: string, ownerUserId?: string): Promise<void> {
  await withDb(async (sql) => {
    if (ownerUserId) {
      await sql`delete from org_members where org_id = ${orgId} and user_id = ${ownerUserId}`;
    } else {
      await sql`delete from org_members where org_id = ${orgId} and role = 'owner'`;
    }
    await sql`update organizations set deleted_at = now() where id = ${orgId} and deleted_at is null`;
  });
}
```

- [ ] **Step 4: Write `apps/web/e2e/settings-support.ts`**

```ts
import type { APIRequestContext } from "@playwright/test";
import {
  TAG,
  apiJson,
  releaseSeededOrgSql,
  setOrgPlanBySql,
  splitOrgIntoOwnGroupSql,
  withDb,
} from "./helpers";

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
 *  - `createOrgForUser` (lib/auth.ts:326) opens every new org on its OWN
 *    community subscription. A fresh org is therefore COMMUNITY — every
 *    Pro-gated control on these tabs renders as an upsell until it is flipped.
 *  - `POST /api/orgs` (api/orgs/route.ts:29) calls `setActiveOrgId`, and an
 *    APIRequestContext shares the browser context's cookie jar. Seeding moves
 *    the active org out from under the caller, so the previous value is
 *    captured here and restored by `releaseSettingsOrg`.
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
  if (!created.data) throw new Error(`seedSettingsOrg: POST /api/orgs failed (${created.status})`);

  const seeded: SeededOrg = {
    orgId: created.data.id,
    slug: created.data.slug,
    name: created.data.name,
    previousActiveOrgId,
  };

  if ((opts.plan ?? "pro") === "pro") {
    // Belt and braces: the split is close to a no-op now that every org opens
    // its own group, and it is kept so this stays correct if that flips back.
    await splitOrgIntoOwnGroupSql(seeded.orgId);
    await setOrgPlanBySql(seeded.orgId, "pro");
  }
  return seeded;
}

/** Restore the active org, then hand the creation slot back. Safe to call twice. */
export async function releaseSettingsOrg(
  request: APIRequestContext,
  seeded: SeededOrg,
): Promise<void> {
  if (seeded.previousActiveOrgId) {
    await apiJson(request, "/api/orgs/active", "POST", { orgId: seeded.previousActiveOrgId });
  }
  const [owner] = await withDb((sql) =>
    sql<{ user_id: string }[]>`
      select user_id from org_members where org_id = ${seeded.orgId} and role = 'owner' limit 1`,
  );
  await releaseSeededOrgSql(seeded.orgId, owner?.user_id);
}
```

### Three corrections to the code above — found during Task 1, verified

The plan's `settings-support.ts` sketch does not compile as written. All three
were caught by reading the tree; the corrected forms are what shipped.

1. **`setOrgPlanBySql(target: { orgId?, email? }, plan)`** (`helpers.ts:447`),
   not `(orgId, plan)`. Given `orgId` it resolves `requireGroupId` and updates
   `subscriptions` by GROUP id.
2. **`withDb` is module-private** — `async function withDb` at
   `helpers.ts:295`, no `export`. The sketch imports it to look the owner up,
   which would not compile. Use `releaseSeededOrgSql`'s own `role = 'owner'`
   branch, which runs the identical delete.
3. **`POST /api/orgs/active` takes `{ org_id }`, snake_case**, and
   `setActiveOrgSchema` (`src/lib/types.ts:182-184`) is `.strict()`. The
   sketch's `{ orgId }` would 400 — and leave the active-org cookie pointing
   at the org about to be deleted, which is the worst place for it.

Tasks 2 and 3 consume this module; they inherit the corrected signatures.

- [ ] **Step 5: Run the consumer spec and watch it pass**

```bash
cd apps/web && npx playwright test e2e/walkthrough/settings-support-smoke.spec.ts \
  --project=walkthrough --reporter=list
```

Expected: 1 passed.

- [ ] **Step 6: Mutate the two findings this module exists for**

Neither is provable by reading. Run each mutant, record the output, revert.

1. Delete the `setOrgPlanBySql` line. Expected: the `?tab=api` assertion goes
   red — a fresh org really is community. If it stays GREEN, finding A is
   wrong for this surface and must be corrected in the plan and `_INDEX.md`.
2. In `releaseSeededOrgSql`, drop the `delete from org_members` statement and
   keep only the soft delete. Expected: the owned-count assertion goes red. If
   it stays green, finding B is wrong and the ruling on one-org-per-file can
   be relaxed — record that, do not silently keep the stricter rule.

Write both results into the task report as raw output, not as a verdict.

- [ ] **Step 7: Commit**

```bash
git add apps/web/e2e/settings-support.ts apps/web/e2e/helpers.ts \
        apps/web/e2e/walkthrough/settings-support-smoke.spec.ts
git commit -m "test(settings): W2 support module, with the org-slot release the cap needs"
```

---

## Task 2: organisation, news and sponsors (CRUD half)

**Files:**
- Create: `apps/web/e2e/walkthrough/settings-org-tabs.spec.ts`
- Test: itself

**Interfaces:**
- Consumes: `seedSettingsOrg`, `releaseSettingsOrg`, `settingsUrl` (Task 1).
- Produces: nothing other tasks read.

**Panel map** (verified 2026-09-05; all branches in
`apps/web/src/app/o/[orgSlug]/settings/page.tsx`, components under
`apps/web/src/components/`):

| Tab | Control | File | Save route |
|---|---|---|---|
| organization | Rename | `org-rename.tsx:58` | `PATCH /api/orgs/{id}` |
| organization | Brand colour | `org-brand-color.tsx:30` | `PATCH /api/orgs/{id}` |
| organization | About | `org-about.tsx:60` | `PATCH /api/orgs/{id}` |
| news | New / publish / archive | `news/news-tab.tsx` | `PATCH /api/v1/posts/{id}` |
| news | Delete (destructive) | `news/news-tab.tsx:83` | `DELETE /api/v1/posts/{id}` |
| sponsors | name / link / tier / scope | `org-sponsors.tsx:151,164,177,196` | `POST`,`PATCH /api/v1/orgs/{id}/sponsors[/{id}]` (`:335,375`) |
| sponsors | reorder | `org-sponsors.tsx:416` | `POST …/sponsors/reorder` |
| sponsors | delete (destructive) | `org-sponsors.tsx:396` | `DELETE …/sponsors/{id}` |

**Out of scope, explicitly:** every control in `sponsor-packages.tsx` (sell,
invoice, refund) — that is the monetize half, W4, and it needs the Connect
fixture account which has no release path. Logo upload is out too: it needs a
storage round trip and belongs with the other upload surfaces.

- [ ] **Step 1: Write the failing spec**

```ts
import { test, expect } from "@playwright/test";
import { seedSettingsOrg, releaseSettingsOrg, settingsUrl, type SeededOrg } from "../settings-support";
import { apiJson } from "../helpers";

/** One org for the whole FILE — see settings-support.ts on why not per test. */
let org: SeededOrg;

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  org = await seedSettingsOrg(ctx.request, { label: "org-tabs" });
  await ctx.close();
});

test.afterAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  await releaseSettingsOrg(ctx.request, org);
  await ctx.close();
});

test("organisation tab: about and brand colour persist together", async ({ page }) => {
  const about = `About ${Date.now().toString(36)}`;
  const colour = "#3f51b5";

  await page.goto(settingsUrl(org.slug, "organization"));
  await page.getByLabel(/about/i).fill(about);
  await page.getByLabel(/brand colou?r/i).fill(colour);
  await page.getByRole("button", { name: /^save$/i }).first().click();

  // Split the question: "did it persist" is an API read...
  await expect
    .poll(async () => (await apiJson<{ about?: string }>(page.request, `/api/orgs/${org.orgId}`)).data?.about,
      { timeout: 20_000 })
    .toBe(about);

  // ...and "does it render back" is the ONE reload this tab gets.
  await page.reload();
  await expect(page.getByLabel(/about/i)).toHaveValue(about, { timeout: 20_000 });
  await expect(page.getByLabel(/brand colou?r/i)).toHaveValue(colour);
});
```

Write the news and sponsors tests in the same shape. Each tab: fill every
field the table lists, ONE save, an API read for persistence, ONE reload for
render-back. Then the destructive control last, since it removes its subject.

Two things the spec must assert that a "did it save" test would miss:

- **Sponsor reorder must witness the ORDER, not just a 200.** Seed three
  sponsors with distinguishable names, move the third up, and assert the read
  order is `[a, c, b]`. An assertion that the list still has three members
  passes on a reorder that did nothing.
- **Delete must be shown to be the delete.** Assert the deleted sponsor is
  absent AND that its siblings are still present — a negative assertion needs
  its positive pair, or a route that deleted everything reads as a pass.

- [ ] **Step 2: Run and watch it fail**

```bash
cd apps/web && npx playwright test e2e/walkthrough/settings-org-tabs.spec.ts \
  --project=walkthrough --reporter=list
```

Every test must fail on a real assertion. A failure in `beforeAll` means Task
1's module is wrong — report it, do not work around it.

- [ ] **Step 3: Fix what the drive exposes, or record it**

These tests drive a surface with no behavioural e2e coverage at all — the
scout's own concern is that `tab=sponsors` appears exactly once in the whole
suite, in `mobile.spec.ts:608`, and that is a layout scan. Expect real
defects.

For each red: decide whether it is a test defect or a product defect by
driving the control by hand in a browser. A product defect gets a one-line
entry in `_INDEX.md` under "W2 findings" with the file:line and what the user
sees, and is fixed inline unless the blast radius is larger than this wave —
in which case it is recorded and left, never silently skipped.

- [ ] **Step 4: Green, with raw counts**

```bash
cd apps/web && npx playwright test e2e/walkthrough/settings-org-tabs.spec.ts \
  --project=walkthrough --reporter=list 2>&1 | tail -20
```

Paste the raw `N passed` line into the report. "Tests pass" without the count
is not an accepted report.

- [ ] **Step 5: Commit**

```bash
git add apps/web/e2e/walkthrough/settings-org-tabs.spec.ts
git commit -m "test(settings): drive and persist the organisation, news and sponsor-CRUD tabs"
```

---

## Task 3: team, api, preferences and account

**Files:**
- Create: `apps/web/e2e/walkthrough/settings-people-tabs.spec.ts`

**Interfaces:** consumes Task 1's module; produces nothing.

**Panel map** (verified 2026-09-05):

| Tab | Control | File | Route |
|---|---|---|---|
| team | invite by email | `org-team.tsx:261` | `POST /api/orgs/{id}/invites` |
| team | invite link | `org-team.tsx:334` | same |
| team | revoke invite | `org-team.tsx:135` | `POST …/invites/{token}/revoke` |
| team | change role | `org-team.tsx:140` | `POST …/members/{userId}/role` |
| api | name, scope, competition pin, Create | `api-keys.tsx:179,232,183` | `POST /api/v1/orgs/{id}/api-keys` |
| api | revoke | `api-keys.tsx:120` | `DELETE …/api-keys/{id}` |
| preferences | your timezone / language | `timezone-preference.tsx:45`, `locale-preference.tsx:29` | `PATCH /api/users/me` |
| preferences | org timezone / public language / registration currency | `page.tsx:42,49,54` | `PATCH /api/orgs/{id}` |
| account | display name | `account-actions.tsx:23` | `PATCH /api/users/me` |
| account | export | — | `GET /api/users/me/export` |

**Out of scope, and why:** remove-member, transfer-ownership, leave-org and
delete-account are Class 3 (ownership and last-actor) cases 11-14, assigned to
**W3**. They are also irreversible against the shared Pro user — a
`DELETE /api/users/me` here would end the leg for every other spec.

**The one hazard specific to this file:** `preferences` and `account` both
`PATCH /api/users/me`, which is the SHARED Pro user, not the seeded org. Those
two tests must restore the user's original display name, timezone and locale
in an `afterAll` — not a `finally` inside a test, which a Playwright timeout
skips. Read the originals once in `beforeAll`.

- [ ] **Step 1: Write the failing spec** — same shape as Task 2: fill, one
  save, an API read for persistence, one reload for render-back.

- [ ] **Step 2: Prove the restore actually restores.** Add a final test that
  reads `/api/users/me` and asserts the display name equals the value captured
  in `beforeAll`. Without it, the restore is an unverified claim and the next
  spec in the leg inherits whatever this one left.

- [ ] **Step 3: Run, fix or record, and report raw counts** — as Task 2 Step 3-4.

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e/walkthrough/settings-people-tabs.spec.ts
git commit -m "test(settings): drive and persist the team, api, preferences and account tabs"
```

---

## Task 4: the phone composition of the settings page

**Files:**
- Modify: `apps/web/src/app/o/[orgSlug]/settings/page.tsx` (the identity row,
  currently at `:288-300`)
- Modify: `apps/web/e2e/mobile.spec.ts`

**Owner instruction (2026-09-05):** a 320px capture of
`/o/{org}/settings?tab=organization`, with "fix the mobile view in this wave2".

**Do NOT touch the tab rail.** Finding D above: it is already a reachable
`overflow-x: auto` rail, and `overflowingIn` classifies it as `scrollable`.
Changing it breaks a working control. This is a case that turned out
already-correct — record it, do not fix it.

**The defect to fix.** `page.tsx:288` is:

```tsx
<div className="flex items-center gap-3">
  <span className="grid h-11 w-11 shrink-0 place-items-center …">{initial}</span>
  <div className="min-w-0 flex-1">
    <p className="truncate text-sm font-semibold …">{active.name}</p>
    <p className="truncate font-mono text-xs …">{active.slug}</p>
  </div>
  <span className={`badge ${ROLE_BADGE[active.role]}`}>{roleLabel(dict, active.role)}</span>
  <OrgSwitcher orgs={orgs} activeId={active.id} />
</div>
```

`min-w-0` is present, so the usual `truncate` diagnosis is NOT the cause here
— check that before writing the fix. The name block is `flex-1`, i.e.
`flex: 1 1 0%`, so it is the ONLY child that yields: the 44px avatar is
`shrink-0`, and the badge and the switcher size to their content. At 320 the
card's inner width is ~240px and those three take ~200px, leaving the org name
— the one thing the row exists to show — about 38px.

- [ ] **Step 1: Verify the cause in a browser before changing anything**

A screenshot shows symptoms, not causes. With the local prod server up:

```bash
cd apps/web && npx playwright test e2e/mobile.spec.ts --project=mobile-320 \
  --reporter=list 2>&1 | tail -20
```

Then measure the row directly, and record the numbers in the report:

```js
// in a page.evaluate against /o/{slug}/settings?tab=organization at 320px
const name = document.querySelector('[data-testid="org-identity-name"]')
          ?? document.querySelector('main p.truncate');
const r = name.getBoundingClientRect();
({ width: r.width, scrollWidth: name.scrollWidth, text: name.textContent });
```

A rendered width under ~80px with a longer `scrollWidth` confirms it. If the
measurement disagrees with this diagnosis, the diagnosis is the finding —
correct the plan and say so.

- [ ] **Step 2: Write the failing width assertion**

In `e2e/mobile.spec.ts`, beside the existing `/settings?tab=organization`
entry, assert that the org name gets a usable share of the row at phone
widths. Anchor on the rendered box, not on a class:

```ts
// The identity row's whole purpose is to say WHICH organisation you are in.
// At 320 the badge and the switcher used to take the row and leave the name
// ~38px — visible only in a browser, because apps/web vitest has no DOM.
test("the org name keeps a readable share of the identity row", async ({ page }) => {
  await page.goto("/settings?tab=organization");
  const name = page.getByTestId("org-identity-name");
  await expect(name).toBeVisible();
  const box = await name.boundingBox();
  expect(box, "identity name has no box").not.toBeNull();
  expect(box!.width).toBeGreaterThan(140);
});
```

Add `data-testid="org-identity-name"` to the name `<p>` in the same edit — a
test that hunts for `main p.truncate` breaks on the next unrelated `truncate`.

- [ ] **Step 3: Run it at every phone width and watch it fail**

```bash
cd apps/web && for p in mobile-se mobile-14 mobile-320 mobile-360 mobile-430; do
  npx playwright test e2e/mobile.spec.ts --project=$p --reporter=list 2>&1 | tail -3
done
```

Expected: red at 320/360/375 at least. Record which widths fail — that is the
evidence the fix is needed, and the set the fix must turn green.

- [ ] **Step 4: Fix the row — wrap the controls below the name on phones**

```tsx
<div className="flex flex-wrap items-center gap-3 md:flex-nowrap">
  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-purple-500 to-fuchsia-500 text-lg font-bold text-white">
    {active.name.charAt(0).toUpperCase()}
  </span>
  {/* `grow basis-40`, not `flex-1`: `flex-1` is shorthand for `flex: 1 1 0%`,
      whose 0% basis is what lets the badge and the switcher squeeze the name
      to ~38px at 320. A 10rem basis makes the name too wide to share the line
      with them, so they wrap onto their own row — and `md:basis-0` puts the
      desktop row back to exactly `flex-1`'s behaviour, byte for byte. */}
  <div className="min-w-0 grow basis-40 md:basis-0">
    <p data-testid="org-identity-name" className="truncate text-sm font-semibold text-slate-800">
      {active.name}
    </p>
    <p className="truncate font-mono text-xs text-purple-600">{active.slug}</p>
  </div>
  <span className={`badge ${ROLE_BADGE[active.role]}`}>{roleLabel(dict, active.role)}</span>
  <OrgSwitcher orgs={orgs} activeId={active.id} />
</div>
```

`flex-wrap` + `md:flex-nowrap` and `basis-40` + `md:basis-0` are the only two
changes, and both are neutralised at `md`. **≥768 must not change** — Step 6
is what proves that.

- [ ] **Step 5: Re-run all five phone widths; all green**

Same loop as Step 3. Paste the raw counts.

- [ ] **Step 6: Prove ≥768 did not move, and that the phone view is not a shrink**

Two checks, both from the live DOM, neither of them a box-size comparison:

```js
// control-set diff: membership, ORDER and repeats, at 320 vs 1280
Array.from(document.querySelectorAll('main button, main a, main input, main select'))
  .map(el => `${el.tagName}:${(el.getAttribute('data-testid') ?? el.textContent ?? '').trim().slice(0,30)}`);
```

The two lists must be IDENTICAL — this page is one DOM branched, and a phone
view showing the same controls at smaller sizes is a groomed shrink, which is
exactly what this bar exists to catch. Then capture 1280, 768 and 320 and
confirm no horizontal page scroll at any of them
(`document.documentElement.scrollWidth <= window.innerWidth`).

- [ ] **Step 7: Run the WHOLE mobile spec, every phone and tablet project**

Not a `-g` slice, and not one project. `mobile.spec.ts` runs
`describe.configure({ mode: "serial" })`, so **the first red aborts the rest
of that project's tests — a reported count is a floor, not a total.** Re-run
after every fix until a full pass completes.

```bash
cd apps/web && for p in mobile-se mobile-14 mobile-320 mobile-360 mobile-430 tablet-768 tablet-834; do
  echo "== $p"; npx playwright test e2e/mobile.spec.ts --project=$p --reporter=list 2>&1 | tail -4
done
```

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/app/o/\[orgSlug\]/settings/page.tsx apps/web/e2e/mobile.spec.ts
git commit -m "fix(settings): the org identity row loses its name at 320 — wrap the chrome below it"
```

---

## Task 5: drive the email-change PRODUCER, not the URL

**Files:**
- Modify: `apps/web/e2e/walkthrough/settings-admin.spec.ts`

**The defect in the test, carried in from W1.5.** Two tests hand-type
`/settings?tab=account&email_change=…`. That URL is exactly what
`/api/auth/change-email/confirm` is supposed to emit
(`apps/web/src/app/api/auth/change-email/confirm/route.ts:24-56`, all five
outcomes). Rename the param, or drop `tab=account` — which gates the banner at
`o/[orgSlug]/settings/page.tsx:559` — and both tests stay green while every
real confirmation in production breaks. A test that types its own producer's
output asserts the fixture on both ends.

- [ ] **Step 1: Replace the typed URL with the real producer**

`GET /api/auth/change-email/confirm?token=<garbage>` needs no seeding at all
— the `if (!row)` branch at `:23` yields the `invalid` outcome and drives
producer → redirect shim → banner in one hop.

```ts
test("a bad confirmation link reaches the account banner through the real route", async ({ page }) => {
  // Drives the PRODUCER. Typing /settings?tab=account&email_change=invalid
  // asserts a URL this test wrote; this asserts the URL the route emits.
  await page.goto(`/api/auth/change-email/confirm?token=not-a-real-token-${Date.now()}`);
  await expect(page).toHaveURL(/[?&]email_change=invalid\b/, { timeout: 20_000 });
  await expect(page).toHaveURL(/[?&]tab=account\b/);
  await expect(page.getByText(UI_EN["settings.emailChange.invalid"]!)).toBeVisible({
    timeout: 20_000,
  });
});
```

Keep reading the banner copy out of `ui.json` as this file already does — a
test carrying its own copy of a string asserts yesterday's wording.

- [ ] **Step 2: Cover `success` through the producer too, with a real row**

`invalid` alone proves the shim, not the happy path. Insert an
`email_change_requests` row for the shared Pro user with a known token and an
unexpired `expires_at`, drive the same route, and assert the `success` banner
— then restore the user's email in an `afterAll` (Global Constraint 6: a
`finally` inside a test is skipped on timeout).

This is the case that matters most: `success`, `taken` and `expired` were
indistinguishable to the user for as long as the banner had no producer.

- [ ] **Step 3: Mutate the shim to prove the tests can see it**

Change `email_change=invalid` to `email_change=nope` in `confirm/route.ts`,
run the file, confirm RED, revert. Then drop `tab=account` from the same
redirect, run, confirm RED, revert. A guard nothing kills is not tested; both
of those were survivable by the tests this task replaces.

- [ ] **Step 4: Run the whole file and commit**

```bash
cd apps/web && npx playwright test e2e/walkthrough/settings-admin.spec.ts \
  --project=walkthrough --reporter=list 2>&1 | tail -20
git add apps/web/e2e/walkthrough/settings-admin.spec.ts
git commit -m "test(settings): drive the email-change producer instead of retyping its own output"
```

---

## Task 6: `/orgs/new` gets a destination contract (F7's residual)

**Files:**
- Modify: `apps/web/src/server/page-auth.ts:37`
- Modify: `apps/web/src/app/orgs/new/page.tsx`
- Modify: `apps/web/src/components/create-org-form.tsx`
- Test: `apps/web/src/lib/__tests__/safe-next-path.test.ts`, plus one e2e

**The residual.** `requirePageAuth` drops the query on
`orgs.length === 0 → redirect("/orgs/new")` (`page-auth.ts:37`). W1.5 made
that path MORE reachable, not less: `postAuthLanding` returns a safe `next`
without provisioning an org (`lib/auth.ts:413-419`), so a first-time signup
arriving via `/login?next=/settings?tab=account` now lands org-less, gets
bounced to `/orgs/new`, and the destination is gone. `/orgs/new` has no `next`
handling of any kind today (`page.tsx` reads no `searchParams` at all).

**Not in scope:** the `role === "scorer"` → `/my-matches` branch at `:41`. A
scorer has no organiser surface at all, so carrying a settings destination
through it would land them somewhere they cannot use. Record that as the
reason, so the next session does not "finish the job".

- [ ] **Step 1: Write the failing unit test**

`safeNextPath` already exists and is already hardened (W1.5 closed an open
redirect there — `/\evil.com` resolved to `https://evil.com/`). This task
REUSES it and must not widen it. Add to `safe-next-path.test.ts`:

```ts
it("keeps a settings destination through the org-less bounce", () => {
  expect(safeNextPath("/settings?tab=account&email_change=success"))
    .toBe("/settings?tab=account&email_change=success");
});

it("still refuses a backslash-smuggled origin on this path", () => {
  // The hazard beside the verdict: new URL("/\\evil.com", base).origin is
  // "https://evil.com", so a prefix check on "/" alone would let it through.
  expect(safeNextPath("/\\evil.com")).toBeNull();
});
```

- [ ] **Step 2: Carry the destination through the bounce**

In `page-auth.ts`, build the org-less redirect from the current URL rather
than a bare literal. Use `safeNextPath` on whatever is carried, so this path
inherits the validator W1.5 hardened instead of inventing a second one.

- [ ] **Step 3: Honour it at `/orgs/new`**

Read `searchParams` (App Router: `searchParams: Promise<Record<string, string | undefined>>`
— await it), pass a validated `next` into `CreateOrgForm`, and redirect there
after a successful create instead of `/dashboard`. A missing or refused `next`
keeps today's behaviour exactly.

- [ ] **Step 4: Prove it end to end, not just in units**

A unit test cannot see a redirect chain. Add one e2e that starts org-less and
lands on the settings destination. If no org-less fixture exists in the suite,
say so in the report and cover it by driving `/orgs/new?next=…` directly plus
a unit test on the `page-auth` branch — and record the gap in `_INDEX.md`
rather than claiming the chain is proven.

- [ ] **Step 5: Mutate the new branch**

Make `safeNextPath` return the raw input in the `/orgs/new` path only. The
backslash test must go red. If it stays green, the new call site is not
actually using the validator.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/page-auth.ts apps/web/src/app/orgs/new/page.tsx \
        apps/web/src/components/create-org-form.tsx \
        apps/web/src/lib/__tests__/safe-next-path.test.ts
git commit -m "fix(auth): keep the intended destination through the org-less bounce to /orgs/new"
```

---

## Wave gate — run by the controller, not by a task

- [ ] Full `apps/web` vitest, JSON reporter, `.testResults[].name` confirmed
      inside this worktree.
- [ ] `seazn-env gate --label stw2` — lint + typecheck. Judge on
      `Cached: N cached, M total`, never on exit 0.
- [ ] The whole `walkthrough` project, plus all seven width projects of
      `mobile.spec.ts`. Serial file ⇒ a red count is a floor; re-run to a full
      pass.
- [ ] Walkthrough leg timing before and after, raw seconds, against the ≤60s
      programme budget.
- [ ] Screenshots at 1280, 768 and 320, with the control-set diff from Task 4
      Step 6 attached.
- [ ] `_INDEX.md` updated: W2 result, findings A-D, every case that turned out
      already-correct, and every defect recorded but not fixed.

---

## Self-review

**Spec coverage.** Design §4's W2 row ("7 tabs — drive+persist, sponsors CRUD
half") is Tasks 2-3. Case 24's W2 share (`?tab=bogus`, double-submit) is
folded into Tasks 2-3 as per-tab assertions rather than its own task — a
`?tab=bogus` test is three lines and does not earn a review seat. Cases 1-23
belong to other waves and are not touched. The phone view and the two
carried-in items are owner/W1.5 additions on top of the design's W2 row.

**Placeholders.** None: every code step carries the code, every verify step
carries the command and the expected result.

**Type consistency.** `SeededOrg` is produced in Task 1 and consumed by name
in Tasks 2 and 3; `seedSettingsOrg` / `releaseSettingsOrg` / `settingsUrl` are
spelled identically in all three. `releaseSeededOrgSql` is the `helpers.ts`
export, `releaseSettingsOrg` the `settings-support.ts` wrapper — two names on
purpose, because one takes an org id and the other takes the seed record.

**Known risk.** Tasks 2 and 3 drive a surface with zero behavioural e2e today.
The honest expectation is that they find product defects, not that they pass
first time. A green first run on those two files is itself a reason to check
that the assertions can fail.
