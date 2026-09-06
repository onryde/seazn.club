# Settings W5 Implementation Plan — competition settings: frozen, visibility, discoverable

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive `/o/{org}/c/{comp}/settings` — the competition settings surface that had **zero** e2e coverage before this wave — closing design's edge cases #4 (frozen read-only) and #10 (discoverable auto-clear on a visibility drop), plus the Class-1 (UI-disabled-but-API-open) and Class-3 (ownership) shapes this surface repeats from earlier waves: `discoverable`/`discovery.branding`/`dashboard.theme` entitlement gates, and non-owner access.

**Architecture:** Two new `e2e/walkthrough/*.spec.ts` files, following the W2-W4 pattern exactly (`seedSettingsOrg`/`releaseSettingsOrg`, one org per file, `test.describe.configure({ mode: "default" })`). Both run parallel, API-first per `_RULES.md` §5 — a browser page load only where a rendered `disabled`/hidden state, or the youth-consent interstitial, is the thing under test. Reports against **both halves of owner ruling 8's split budget** (fast-path total, real-money allowance — this wave adds nothing to the second bucket, it has no Stripe surface).

**Tech Stack:** Playwright (`walkthrough` project), Vitest (unit regression for the one code path this wave touches), `seedSettingsOrg`/`releaseSettingsOrg`/`settingsUrl`-style helpers (new competition-scoped equivalents added in Task 1), `apiJson`, `setEntitlementOverrideSql`, `setBoolEntitlementOverrideSql`.

**Spec:** `docs/superpowers/specs/2026-09-03-settings-walkthrough-design.md` (design of record, §4 wave table, §7 edge-case register cases #4/#10/#18), `docs/superpowers/specs/2026-09-03-settings-walkthrough-prompts/_INDEX.md` (rulings — **read ruling 8 before reporting any timing number**), `_RULES.md` beside it (speed/isolation rules, referenced by section below).

## §0. Ground truth as of 2026-09-06 (re-verified against `origin/main` at `aabb701ea`, not memory)

The surface under test is `apps/web/src/components/v2/competition-settings.tsx` (464 lines), rendered by `apps/web/src/app/o/[orgSlug]/c/[compSlug]/settings/page.tsx`. It is **one form, three tabs** (`general` / `branding` / `archived`) — tabs only organise fields, one submit handler (`save`) PATCHes `/api/v1/competitions/{id}`.

Fields and their gates, read directly from the component (line numbers are `competition-settings.tsx`):

| Field | Gate | Where enforced |
|---|---|---|
| `name`, `description`, `starts_on`, `ends_on`, `visibility`, `status` | `readOnly = !canEdit \|\| competition.frozen` (line 109) | client `disabled`; server via `patchCompetition` |
| `discoverable` checkbox + `city`/`country` | `readOnly \|\| form.visibility !== "public"` (line 355) | client only for the visibility half — **no server check that `discoverable:true` requires `visibility:"public"` in the SAME patch is needed**, because `patchCompetition` (usecases/competitions.ts:560-562) 422s that combination unconditionally |
| `tagline`, `hero_image_path` | `readOnly \|\| !discoveryBranding` (lines 404, 419) | client `disabled`; server `requireFeature(orgId, "discovery.branding")` when either is non-empty (usecases/competitions.ts:519-521) — a **Class-1 shape**: the two inputs are merely `disabled`, not removed, so a scripted PATCH is the only thing stopping a Free org |
| `discoverable` (the write, not the checkbox) | none client-side beyond the above | server `requireFeature(orgId, "discovery.listed")` when `discoverable === true` (usecases/competitions.ts:517) — **also Class-1**: `discovery.listed` is `true` on BOTH `community` and `pro` by default (`V240__entitlement_seeds_v2.sql:24-25`), so the only way to see this gate fire is an org-scoped override, exactly the tool `_RULES.md` §2 prefers |
| Branding tab (`brand_primary`) | tab only rendered `themeBranding ? [...] : []` (line 201) | entitlement key is `dashboard.theme` (**not** `dashboard.branding` — page.tsx:53's own comment: `dashboard.branding` was retired to badge-removal-only since V396/enterprise) |
| `frozen` | whole form read-only (line 109, 241-243 badge) | **derived, not stored as a direct toggle** — see below |

**`frozen` is NOT a column you can flip.** `apps/web/src/server/usecases/entitlement-freeze.ts:261` (`frozenCompetitionIds`) computes it live: `getLimit(orgId, "competitions.max_active")`, and if the org's **currently live/unpassed** competition count exceeds that limit, `selectFrozen` picks which ones are over (oldest-activity-first survive; see the function's own doc comment and `billing-states.spec.ts:170-174`'s established pattern: "the FIRST one created is always the one that freezes once a later one exists"). `patchCompetition` (usecases/competitions.ts:476) calls `assertCompetitionNotFrozen` before any patch **except** a bare `{status: "completed"|"archived"}` (`isRetirePatch`, line 462-469 — a frozen competition can still be retired, so the org can get back under quota).

**Seed a frozen competition with `setEntitlementOverrideSql`, never a real plan downgrade** — `_RULES.md` §2 preference order 1, and it is strictly correct here: `frozenCompetitionIds` reads the entitlement resolver, which honours an org-scoped override over the plan default (that is the whole point of the override table). Recipe, confirmed against the source above: seed a **Pro** org (`competitions.max_active` is `null`/unlimited on `pro` per `V112__entitlements_v2.sql:33`, so it would never freeze on its own plan), create **two** competitions with `visibility: "public"` and `status: "live"` (must satisfy `liveUnpassedCompetition`, not `draft`), then `setEntitlementOverrideSql(orgId, "competitions.max_active", 1)`. The **first**-created competition is the one that freezes.

**Case #10 (discoverable auto-clear) is already implemented**, not a gap: `patchCompetition` (usecases/competitions.ts:563-565) — `if (nextVisibility !== "public" && before.discoverable && effective.discoverable !== false) effective.discoverable = false;`. This wave's job is proving it with a real PATCH+read-back, per `_RULES.md` §9 ("a claim about what a person sees is settled by driving the product, never by reading the code") — not fixing anything.

**Case #18 (`ends_on < starts_on`)** is enforced twice: client (`save()`, line 142-145, blocks before the request) and server (`schemas.ts:74-78`, a zod `.refine` on `PatchCompetition` producing `code: "custom", path: ["ends_on"]`). Both need a positive proof, per `_RULES.md` §9 and the programme's own recurring finding that a client-only check reads as a server guarantee it is not.

**Youth interstitial** (`visibility-picker.tsx:47-56`): leaving `private` while `hasYouthDivisions` raises a `useConfirm()` modal (`visibility.youth.*` message keys) before `onChange` fires. `hasYouthDivisions` is a server-computed prop (page.tsx:82-88, reads the `divisions.youth` boolean column) — this is UI-only behavior (the modal, and the fact that declining leaves `value` unchanged) with no server-side equivalent to cross-check, so it earns its one browser round trip per `_RULES.md` §5.4.

## Global Constraints

- `pnpm@10.34.5`, `node >=26`. Fresh worktree: `pnpm install`, then `db:apply` + `sync:sports` (`AGENTS.md` "Environment setup").
- One org per **spec file**, seeded via `seedSettingsOrg(request, { plan: "pro", label: "W5" })`; release in `afterAll` with `releaseSettingsOrg`. Both new files seed `plan: "pro"` — the gates matrix needs `discoveryBranding`/`themeBranding` present by default so it can prove the ABSENCE case with an explicit `setBoolEntitlementOverrideSql(orgId, key, false)` override (never re-derive a Free org's baked-in entitlement set from scratch; overriding down from Pro is the same `_RULES.md` §2 preference-order-1 tool, applied to a boolean key).
- Helpers live outside `e2e/walkthrough/` (`_RULES.md` §3): new competition-scoped seed/release helpers go in `apps/web/e2e/settings-support.ts` beside `seedSettingsOrg`; any new SQL helper (there is one, `setCompetitionStatusSql` if the API route requires a status client cannot reach some other way — check first, see Task 1 Step 1) goes in `apps/web/e2e/helpers.ts`.
- `test.describe.configure({ mode: "default" })` on both files (never `serial` — `_RULES.md` §7 / rule 21's own citation: serial hides every red after the first).
- No `waitForTimeout` — `expect.poll`/`waitForResponse` only. No screenshots, no axe. At most one `page.reload()` per tab under test (`_RULES.md` §5).
- Restore every borrowed privilege in `finally`/`afterAll` — the entitlement overrides this wave writes are org-scoped and die with `releaseSettingsOrg`'s org delete, but a member identity borrowed for the non-owner case (Task 2) still needs its own `release()` call per the existing `MemberIdentity` pattern (`settings-support.ts`, grep for `MemberIdentity` usage in `settings-org-tabs.spec.ts` for the exact shape).
- Subagent dispatches use Opus 5 (programme ruling 5).
- Any new user-facing string ships to all four locale dictionaries via `gen-keys`. Neither task adds one — both reuse existing `compset.*`/`showcase.*`/`visibility.*` keys already in the dictionaries.
- New `WALKTHROUGH_SPECS` entries appended to `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts`'s array in the same task that adds each spec file (the trap that cost W3 two red CI checks).
- **Budget reporting uses owner ruling 8's two buckets, not one number.** Both this wave's files are fast-path (API-first, no Stripe) — report their measured cost against the fast-path budget only; do not invent or touch a real-money figure.

---

### Task 1: `settings-competition-drive.spec.ts` — general/branding drive+persist, discoverable auto-clear, youth interstitial

**Files:**
- Modify: `apps/web/e2e/settings-support.ts` — add `seedCompetition`/`releaseCompetition` helpers
- Create: `apps/web/e2e/walkthrough/settings-competition-drive.spec.ts`
- Modify: `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts`

**Interfaces:**
- Consumes: `seedSettingsOrg`/`releaseSettingsOrg` (`../settings-support`), `apiJson` (`../helpers`).
- Produces: `seedCompetition(request, orgId, opts?)` → `{ id, slug }` and `releaseCompetition(request, id)` — Task 2 reuses both; put their exact signature at the top of this task's report so Task 2's dispatch can quote it verbatim.

- [ ] **Step 1: Add competition seed/release helpers to `settings-support.ts`**

Read `settings-support.ts` in full first (it is short, ~170 lines) — do not guess its existing exports. Append below `releaseSettingsOrg`:

```ts
export interface SeededCompetition {
  id: string;
  slug: string;
}

/**
 * A competition inside a settings-seeded org, defaulting to a state the
 * frozen/visibility/discoverable matrix can drive without a second write:
 * live + public, so `liveUnpassedCompetition` counts it (frozen seeding,
 * Task 2) and the visibility picker starts somewhere case #10 can leave.
 */
export async function seedCompetition(
  request: APIRequestContext,
  orgId: string,
  opts: { name?: string; visibility?: "private" | "unlisted" | "public"; status?: string } = {},
): Promise<SeededCompetition> {
  const created = await apiJson<{ id: string; slug: string }>(
    request,
    "/api/v1/competitions",
    "POST",
    {
      name: opts.name ?? `W5 Competition ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
      ends_on: "2030-12-31",
      visibility: opts.visibility ?? "public",
      status: opts.status ?? "live",
    },
  );
  if (!created.data) {
    throw new Error(
      `seedCompetition: POST /api/v1/competitions failed (${created.status}) ${JSON.stringify(created.error)}`,
    );
  }
  return created.data;
}

/** Safe to call on a competition that was already deleted or never created. */
export async function releaseCompetition(request: APIRequestContext, id: string): Promise<void> {
  await apiJson(request, `/api/v1/competitions/${id}`, "DELETE");
}
```

Check `POST /api/v1/competitions`'s create schema (`schemas.ts` around line 88-93, already read for §0) for any other **required** field beyond `name`/`ends_on` before finalizing this — `rs007-money-matrix.spec.ts:333`'s own `createCompetition` helper is the closest existing example; diff your version against it and reconcile any field it sends that this one does not, or say why not.

- [ ] **Step 2: Write the spec file — general tab drive+persist**

```ts
import { test, expect } from "@playwright/test";
import { seedSettingsOrg, releaseSettingsOrg, seedCompetition, releaseCompetition } from "../settings-support";
import { apiJson } from "../helpers";
import type { SeededOrg } from "../settings-support";

test.describe.configure({ mode: "default" });

test.describe("competition settings — drive and persist", () => {
  let org: SeededOrg;

  test.beforeAll(async ({ request }) => {
    org = await seedSettingsOrg(request, { plan: "pro", label: "W5-drive" });
  });

  test.afterAll(async ({ request }) => {
    await releaseSettingsOrg(request, org);
  });

  test("general fields persist across a reload", async ({ page, request }) => {
    const comp = await seedCompetition(request, org.orgId, { visibility: "private", status: "draft" });
    try {
      await page.goto(`/o/${org.slug}/c/${comp.slug}/settings`);
      await page.getByLabel(/^Name$/i).fill("Renamed via W5");
      await page.getByLabel(/^Starts$/i).fill("2027-03-01");
      await page.getByLabel(/^Ends/i).fill("2027-03-14");
      await page.getByRole("button", { name: /^Save/i }).click();
      await expect(page.getByText(/saved/i)).toBeVisible();
      await page.reload();
      await expect(page.getByLabel(/^Name$/i)).toHaveValue("Renamed via W5");
      await expect(page.getByLabel(/^Starts$/i)).toHaveValue("2027-03-01");
      await expect(page.getByLabel(/^Ends/i)).toHaveValue("2027-03-14");

      const read = await apiJson<{ name: string; starts_on: string; ends_on: string }>(
        request, `/api/v1/competitions/${comp.id}`, "GET",
      );
      expect(read.data?.name).toBe("Renamed via W5");
    } finally {
      await releaseCompetition(request, comp.id);
    }
  });
```

Use the real `msg()` dictionary keys, not the placeholder label text above — before finalizing, grep `content/dictionaries/en.json` (or wherever the four locale JSONs live — confirm the path from an existing spec's own selector, e.g. `settings-org-tabs.spec.ts`) for `compset.name`, `compset.starts`, `compset.ends`, `compset.save` and use `page.getByLabel(dict.compset.name)`-equivalent text, exactly as the sibling W2/W3 specs already do (read one of them for the exact idiom — `getByLabel` against a raw English string is fragile if the copy ever localizes the *rendered* string differently per test locale, and this repo's specs already have a house pattern for this; do not invent a new one).

- [ ] **Step 3: Visibility drive + case #10 (discoverable auto-clear)**

```ts
  test("case #10: discoverable clears when visibility drops from public, and stays cleared on reload", async ({ page, request }) => {
    const comp = await seedCompetition(request, org.orgId, { visibility: "public", status: "live" });
    try {
      await page.goto(`/o/${org.slug}/c/${comp.slug}/settings`);
      await page.getByLabel(/showcase/i).check();
      await page.getByRole("button", { name: /^Save/i }).click();
      await expect(page.getByText(/saved/i)).toBeVisible();

      let read = await apiJson<{ discoverable: boolean }>(request, `/api/v1/competitions/${comp.id}`, "GET");
      expect(read.data?.discoverable).toBe(true);

      // Drop to unlisted via the picker — a real click through the radio
      // cards, not an API-only flip, per design §7's own framing of this
      // case as a UI question ("does the UI show a stale true?").
      await page.getByRole("radio", { name: /unlisted/i }).click();
      await page.getByRole("button", { name: /^Save/i }).click();
      await expect(page.getByText(/saved/i)).toBeVisible();
      await page.reload();
      await expect(page.getByLabel(/showcase/i)).not.toBeChecked();

      read = await apiJson<{ discoverable: boolean }>(request, `/api/v1/competitions/${comp.id}`, "GET");
      expect(read.data?.discoverable).toBe(false);
    } finally {
      await releaseCompetition(request, comp.id);
    }
  });
```

- [ ] **Step 4: Youth interstitial (browser-only behavior, earns its round trip per `_RULES.md` §5.4)**

Seed a competition `visibility: "private"`, then create one division with a youth-eligible age band through the existing division-create API (find the exact field name and a legal U-age value by reading `apps/web/src/server/usecases/divisions.ts`'s `deriveYouth` — referenced in page.tsx:79 — do not guess the age cutoff). Then:

```ts
  test("youth interstitial blocks leaving Private without confirming, and a decline is a true no-op", async ({ page, request }) => {
    const comp = await seedCompetition(request, org.orgId, { visibility: "private" });
    try {
      // create one youth division — see divisions.ts's deriveYouth for the
      // exact age field/cutoff; do not hardcode a guessed value here.
      await apiJson(request, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
        name: "U12 Mixed",
        sport_key: "badminton",
        age_max: 12, // confirm this is actually the field deriveYouth reads before relying on it
      });
      await page.goto(`/o/${org.slug}/c/${comp.slug}/settings`);
      await page.getByRole("radio", { name: /public/i }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();

      // Decline: value must not have changed.
      await dialog.getByRole("button", { name: /cancel/i }).click();
      await expect(page.getByRole("radio", { name: /private/i })).toBeChecked();

      // Confirm: value changes, and the picker reflects it before any Save.
      await page.getByRole("radio", { name: /public/i }).click();
      await page.getByRole("dialog").getByRole("button", { name: /confirm/i }).click();
      await expect(page.getByRole("radio", { name: /public/i })).toBeChecked();
    } finally {
      await releaseCompetition(request, comp.id);
    }
  });
});
```

The exact confirm/cancel button copy comes from `visibility.youth.confirm` and whatever cancel label `useConfirm`'s dialog uses by default (check `confirm-provider.tsx` for a default cancel label if the call site above doesn't pass one) — read both before finalizing, do not guess the accessible names.

- [ ] **Step 5: Branding tab, gated on `dashboard.theme`**

Pro org already has `dashboard.theme = true` by default (`V397__dashboard_theme_key.sql:44`) — one test: switch to the Branding tab, set a color via `BrandColorPicker`, save, reload, confirm it persisted in `competition.branding.colors.primary` via an API read (read `BrandColorPicker`'s interaction pattern from an existing spec that already drives it — the sponsors/org-branding tests in W2 likely already do; mirror that click sequence exactly rather than inventing one for a component you have not read the internals of).

- [ ] **Step 6: Wire into `e2e-ci-wiring.test.ts`**

Append `"settings-competition-drive.spec.ts"` to the `WALKTHROUGH_SPECS` array (currently closing around line 205 — re-check the exact line before editing, W4 already moved it once). Run `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts` alone and confirm it's still green — this is the trap that cost W3 two red CI checks.

- [ ] **Step 7: Run the file alone, `--workers=1`, JSON reporter**

```bash
cd apps/web && PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/w5-task1.json npx playwright test --project=walkthrough --workers=1 e2e/walkthrough/settings-competition-drive.spec.ts
```

Read `/tmp/w5-task1.json`'s `stats` — expect all `expected`, zero `unexpected`/`flaky`. Record the file's summed `.testResults[].duration` in the report; this is the fast-path budget number for this file.

- [ ] **Step 8: Commit**

```bash
git add apps/web/e2e/settings-support.ts apps/web/e2e/walkthrough/settings-competition-drive.spec.ts apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts
git commit -m "test(settings): W5 Task 1 — competition drive+persist, case #10, youth interstitial"
```

---

### Task 2: `settings-competition-gates.spec.ts` — frozen (#4), entitlement gates, non-owner, ends<starts (#18)

**Files:**
- Modify: `apps/web/e2e/helpers.ts` — add `freezeCompetitionSql` if no equivalent exists (Step 1 checks first)
- Create: `apps/web/e2e/walkthrough/settings-competition-gates.spec.ts`
- Modify: `apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts`

**Interfaces:**
- Consumes: `seedSettingsOrg`/`releaseSettingsOrg`/`seedCompetition`/`releaseCompetition` (Task 1's exact signatures — read Task 1's report before writing this task, do not re-derive them), `setEntitlementOverrideSql`/`setBoolEntitlementOverrideSql`/`apiJson` (`../helpers`), `seedMemberIdentity` (`../settings-support:158`, signature `(browser, owner, orgId, role)` → `MemberIdentity`).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Case #4 — freeze via entitlement override, prove UI AND API**

```ts
import { test, expect } from "@playwright/test";
import {
  seedSettingsOrg, releaseSettingsOrg, seedCompetition, releaseCompetition,
} from "../settings-support";
import { apiJson, setEntitlementOverrideSql, setBoolEntitlementOverrideSql } from "../helpers";
import type { SeededOrg } from "../settings-support";

test.describe.configure({ mode: "default" });

test.describe("competition settings — gating matrix", () => {
  let org: SeededOrg;

  test.beforeAll(async ({ request }) => {
    org = await seedSettingsOrg(request, { plan: "pro", label: "W5-gates" });
  });

  test.afterAll(async ({ request }) => {
    await releaseSettingsOrg(request, org);
  });

  test("case #4: a frozen competition is read-only in the UI and PATCH refuses", async ({ page, request }) => {
    // Two live+public competitions so one goes over quota; the FIRST is the
    // one selectFrozen keeps live, per billing-states.spec.ts's own established
    // pattern — confirm this still holds by asserting on the OLDER id, not by
    // assuming it without the read-back.
    const older = await seedCompetition(request, org.orgId, { visibility: "public", status: "live" });
    const newer = await seedCompetition(request, org.orgId, { visibility: "public", status: "live" });
    try {
      await setEntitlementOverrideSql(org.orgId, "competitions.max_active", 1);

      const frozenCheck = await apiJson<{ frozen: boolean }>(request, `/api/v1/competitions/${older.id}`, "GET");
      expect(frozenCheck.data?.frozen).toBe(true);

      await page.goto(`/o/${org.slug}/c/${older.slug}/settings`);
      await expect(page.getByText(/read.?only/i)).toBeVisible();
      await expect(page.getByLabel(/^Name$/i)).toBeDisabled();
      await expect(page.getByRole("button", { name: /^Save/i })).toHaveCount(0);

      const patch = await apiJson(request, `/api/v1/competitions/${older.id}`, "PATCH", { name: "should refuse" });
      expect(patch.status).toBe(402);

      // The retire escape hatch: a bare status->archived patch must still work
      // on a frozen competition (usecases/competitions.ts's isRetirePatch).
      const retire = await apiJson(request, `/api/v1/competitions/${older.id}`, "PATCH", { status: "archived" });
      expect(retire.status).toBe(200);
    } finally {
      await setEntitlementOverrideSql(org.orgId, "competitions.max_active", 9999);
      await releaseCompetition(request, newer.id);
      await releaseCompetition(request, older.id);
    }
  });
```

Confirm `402` against the ACTUAL error envelope shape this repo uses for `PaymentRequiredError` — grep an existing spec asserting one of these (`billing-states.spec.ts` almost certainly does) for the exact status code and body shape before hardcoding `402`; do not assume without confirming against a real prior assertion in this repo.

- [ ] **Step 2: `discovery.branding` and `discovery.listed` — Class-1 shape, UI disabled but API is the real guard**

```ts
  test("tagline/hero are disabled without discovery.branding, and the API 402s a scripted write too", async ({ page, request }) => {
    const comp = await seedCompetition(request, org.orgId, { visibility: "public" });
    try {
      await setBoolEntitlementOverrideSql(org.orgId, "discovery.branding", false);
      await page.goto(`/o/${org.slug}/c/${comp.slug}/settings`);
      await page.getByLabel(/showcase/i).check();
      await expect(page.getByLabel(/tagline/i)).toBeDisabled();

      const patch = await apiJson(request, `/api/v1/competitions/${comp.id}`, "PATCH", {
        discoverable: true,
        discovery: { tagline: "should 402" },
      });
      expect(patch.status).toBe(402);
    } finally {
      await setBoolEntitlementOverrideSql(org.orgId, "discovery.branding", true);
      await releaseCompetition(request, comp.id);
    }
  });

  test("discoverable itself 402s when discovery.listed is overridden off, even though the checkbox stays clickable", async ({ page, request }) => {
    const comp = await seedCompetition(request, org.orgId, { visibility: "public" });
    try {
      await setBoolEntitlementOverrideSql(org.orgId, "discovery.listed", false);
      const patch = await apiJson(request, `/api/v1/competitions/${comp.id}`, "PATCH", { discoverable: true });
      expect(patch.status).toBe(402);
    } finally {
      await setBoolEntitlementOverrideSql(org.orgId, "discovery.listed", true);
      await releaseCompetition(request, comp.id);
    }
  });
```

Confirm `invalidateOrgEntitlements` (referenced in `setBoolEntitlementOverrideSql`'s own doc comment, `helpers.ts`) needs calling after these overrides in this environment — its doc says it is "required against staging's cache; a cheap no-op locally/CI", so confirm which this run is before deciding whether to call it; if in doubt, call it (cheap no-op is the safe default per that same comment).

- [ ] **Step 3: `dashboard.theme` off — Branding tab is absent, not disabled**

```ts
  test("branding tab does not render at all without dashboard.theme", async ({ page, request }) => {
    const comp = await seedCompetition(request, org.orgId, {});
    try {
      await setBoolEntitlementOverrideSql(org.orgId, "dashboard.theme", false);
      await page.goto(`/o/${org.slug}/c/${comp.slug}/settings`);
      await expect(page.getByRole("tab", { name: /branding/i })).toHaveCount(0);
    } finally {
      await setBoolEntitlementOverrideSql(org.orgId, "dashboard.theme", true);
      await releaseCompetition(request, comp.id);
    }
  });
```

- [ ] **Step 4: Non-owner member — read-only render and a 403 on PATCH**

`settings-support.ts:158` already exports `seedMemberIdentity(browser, owner, orgId, role)` → `MemberIdentity { ctx, request, userId, release() }` — read its full doc comment (lines 139-157) before using it: it mints an invite as the owner (`owner` param is an `APIRequestContext` already authenticated as the org owner — pass this file's `request` fixture, which `seedSettingsOrg` already used to create `org`) and accepts it from a **second browser context on the community storageState**, never `browser.newContext()` with no storageState (that inherits the signed-in Pro session — the exact bug this helper's own comment warns about). Use role `"viewer"` — the closest existing role to design's "member (non-editor)" framing (case #5, already covered for the org-tabs surface in W3; this test is that same shape applied to a competition).

```ts
  test("a non-editor member sees the form disabled and the API 403s their PATCH", async ({ request, browser }) => {
    const comp = await seedCompetition(request, org.orgId, {});
    const member = await seedMemberIdentity(browser, request, org.orgId, "viewer");
    try {
      const memberPage = await member.ctx.newPage();
      await memberPage.goto(`/o/${org.slug}/c/${comp.slug}/settings`);
      await expect(memberPage.getByLabel(/^Name$/i)).toBeDisabled();
      await expect(memberPage.getByRole("button", { name: /^Save/i })).toHaveCount(0);
      await memberPage.close();

      const patch = await apiJson(member.request, `/api/v1/competitions/${comp.id}`, "PATCH", { name: "should 403" });
      expect(patch.status).toBe(403);
    } finally {
      await member.release();
      await releaseCompetition(request, comp.id);
    }
  });
```

- [ ] **Step 5: Case #18 (server half) — `ends_on < starts_on` on THIS surface**

The client half is already proven implicitly by Task 1 never sending an invalid pair. Prove the server half directly, bypassing the client:

```ts
  test("case #18: PATCH refuses ends_on before starts_on", async ({ request }) => {
    const comp = await seedCompetition(request, org.orgId, {});
    try {
      const patch = await apiJson(request, `/api/v1/competitions/${comp.id}`, "PATCH", {
        starts_on: "2027-06-01",
        ends_on: "2027-01-01",
      });
      expect(patch.status).toBe(422);
      expect(patch.error?.issues?.[0]?.path).toContain("ends_on");
    } finally {
      await releaseCompetition(request, comp.id);
    }
  });
});
```

Confirm the exact shape `apiJson`'s error envelope exposes zod issues in (`patch.error?.issues` is a guess at the shape — check an existing spec that already asserts a 422 from this same `parseBody`/zod pipeline, e.g. anything asserting `ENDS_BEFORE_STARTS_MESSAGE` or a `code: "custom"` issue elsewhere in the walkthrough suite, and match its exact assertion shape).

- [ ] **Step 6: Wire into `e2e-ci-wiring.test.ts`, run alone, JSON reporter**

Same as Task 1 Step 6/7, for `settings-competition-gates.spec.ts`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/e2e/helpers.ts apps/web/e2e/walkthrough/settings-competition-gates.spec.ts apps/web/src/lib/__tests__/e2e-ci-wiring.test.ts
git commit -m "test(settings): W5 Task 2 — frozen (#4), entitlement gates, non-owner, ends<starts (#18)"
```

---

## Final whole-branch review focus

Beyond the standard rubric: (a) confirm the frozen-seeding recipe in Task 2 Step 1 actually froze the OLDER competition, not the newer one, by reading `selectFrozen`'s ordering rule directly rather than trusting this plan's restatement of it; (b) confirm every `setEntitlementOverrideSql`/`setBoolEntitlementOverrideSql` call in Task 2 is restored in a `finally`, since three different keys get flipped across the file and a leaked override on one test's org corrupts a sibling test in the SAME file (both tests share the one `org` seeded in `beforeAll`); (c) confirm neither task added a second `page.reload()` per tab (Task 1 Step 3 reloads once); (d) the youth-interstitial division's `age_max` value — verify it actually derives `youth = true` by reading it back from the DB or API, not by assuming the guessed cutoff in Task 1 Step 4's draft code was right.

## Budget report (fill in from Task 1/2 Step 7's real numbers, owner ruling 8's fast-path bucket)

Cumulative fast-path total through W4 was ~94-100s (ruling 8's own figure). Report this wave's two files' summed durations against that bucket, not against a single 60s ceiling.
