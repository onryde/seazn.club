# Settings walkthroughs W1 — `/admin/settings` and the legacy redirects

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive every control on `/admin/settings` and every legacy `/settings/*` redirect by hand, pinning what each opens at and what each route actually answers — and fix the two defects that reading already found.

**Architecture:** One Playwright spec in the `walkthrough` project, plus one new SQL helper in `e2e/helpers.ts` so a test can become staff *without* becoming superadmin. The spec runs **sequentially within its file** (Playwright's default) because the platform fee is a single global row with no org scoping — the programme's one-org-per-test parallelism rule does not apply to a global singleton. Two component fixes ship with the tests that fail without them.

**Tech Stack:** Playwright, Next.js App Router, postgres.js, zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-03-settings-walkthrough-design.md`
**Programme rules:** `docs/superpowers/specs/2026-09-03-settings-walkthrough-prompts/_RULES.md`
**Programme index:** `docs/superpowers/specs/2026-09-03-settings-walkthrough-prompts/_INDEX.md`

## Global Constraints

- **Install with `pnpm install`.** `package.json` declares `pnpm@10.34.5` and `node >=26`. `npm install` fails with `Unsupported URL Type "workspace:"`. Scripts may still be run as `npm run …`.
- **Helpers never live under `e2e/walkthrough/`.** That directory's `testMatch` is a bare directory regex against the absolute path and replaces Playwright's default spec pattern, so every `.ts` there is loaded as a spec.
- **Restore every borrowed privilege in a `finally`.** The shared Pro user outlives the test that borrowed from it.
- **The platform fee default is a global row.** Any test that writes it restores it.
- **No `waitForTimeout`, no screenshots, no axe scans.** `expect.poll` / `waitForResponse` only.
- **No flat `test.setTimeout` in this spec.** Its slowest test is two navigations; the 60s global default already covers it, and a flat override beside a derived cost is the anti-pattern `_RULES.md` §5.7 names.
- **`AuthError` returns HTTP 401**, not 403 (`apps/web/src/lib/http.ts:34`).
- **`StaffRole` is `"support" | "superadmin"`** (`apps/web/src/lib/admin.ts:8`).
- **Judge green only from `--reporter=json`**, and confirm `.testResults[].name` resolves inside this worktree — shell cwd resets to the main checkout between calls.
- **Run the whole spec file, never a `-g` slice.**

---

## File Structure

| File | Responsibility |
| --- | --- |
| `apps/web/e2e/helpers.ts` (modify, near `setOwnerStaffSql` ~line 1143) | Add `setOwnerStaffRoleSql` — the only way to be staff *without* being superadmin. |
| `apps/web/e2e/walkthrough/settings-admin.spec.ts` (create) | W1's whole spec: the admin surface and the four legacy redirects. |
| `apps/web/src/components/admin-platform-settings.tsx` (modify) | The two fixes: a non-superadmin must not get a live Save; an empty field must not save 0%. |
| `apps/web/src/app/admin/settings/page.tsx` (modify) | Pass the caller's staff role down so the component can express the gate it already depends on. |

`e2e/settings-support.ts` is **not** created in this wave. W1 has no shared page-driving logic to put in it, and a support module with no consumer is an inert seam. It arrives in W2 with real consumers.

---

### Task 1: A test can be staff without being superadmin

**Files:**
- Modify: `apps/web/e2e/helpers.ts` (beside `setOwnerStaffSql`, ~line 1143)

**Interfaces:**
- Consumes: `withDb` (module-private in `helpers.ts`), which is why this helper belongs there and not in a new file.
- Produces: `setOwnerStaffRoleSql(orgId: string, role: "support" | "superadmin" | null): Promise<void>`

`setOwnerStaffSql` hardcodes `staff_role = 'superadmin'` and so cannot express the case W1 exists to test: a staff user who is not a superadmin.

- [ ] **Step 1: Add the helper**

```ts
/** Set the org owner's staff role precisely — `setOwnerStaffSql` can only
 *  express superadmin, so it cannot reach the staff-but-not-superadmin case
 *  that separates requireStaff() from requireSuperadmin(). Pass null to clear.
 *  ALWAYS restore in a finally: the shared Pro user outlives the borrower. */
export async function setOwnerStaffRoleSql(
  orgId: string,
  role: "support" | "superadmin" | null,
): Promise<void> {
  await withDb((sql) =>
    role
      ? sql`update users set is_staff = true, staff_role = ${role}
              where id in (select user_id from org_members
                            where org_id = ${orgId} and role = 'owner')`
      : sql`update users set is_staff = false, staff_role = null
              where id in (select user_id from org_members
                            where org_id = ${orgId} and role = 'owner')`,
  );
}
```

- [ ] **Step 2: Confirm it type-checks**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0. (`rtk` prints "tsc clean" while tsc exits 1 — read the exit code, not the wrapper's summary.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e/helpers.ts
git commit -m "test(e2e): setOwnerStaffRoleSql — reach staff-but-not-superadmin

setOwnerStaffSql hardcodes staff_role = 'superadmin', so nothing in the
suite can currently stand where requireStaff() passes and
requireSuperadmin() does not. That gap is exactly the /admin/settings
surface W1 tests."
```

---

### Task 2: F1 — a support-role staff user gets a live Save that 401s

**Files:**
- Create: `apps/web/e2e/walkthrough/settings-admin.spec.ts`
- Modify: `apps/web/src/app/admin/settings/page.tsx`
- Modify: `apps/web/src/components/admin-platform-settings.tsx`

**Interfaces:**
- Consumes: `setOwnerStaffRoleSql` (Task 1); `activeOrg(page): Promise<OrgInfo>` and `apiJson<T>(request, path, method?, body?): Promise<{status: number; data?: T; error?: {code?: string; message?: string}}>` from `e2e/helpers.ts`.
- Produces: the spec file every later task in this wave appends to.

`/admin/settings` gates the page on `requireStaff()` and the write on `requireSuperadmin()`. The component's only `disabled` is `busy || !valid`, which knows nothing about the role. A `support` staff user is therefore shown an enabled Save that always fails.

- [ ] **Step 1: Write the failing test**

Create `apps/web/e2e/walkthrough/settings-admin.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { activeOrg, apiJson, setOwnerStaffRoleSql } from "../helpers";

/**
 * W1 of the settings walkthrough programme. Complements nothing — this
 * surface had no e2e coverage of any kind.
 *
 * Deliberately NOT `mode: "parallel"`. The platform fee default is a single
 * global row (`platform_settings`), not an org-scoped value, so the
 * programme's one-org-per-test isolation rule cannot apply here. Playwright
 * runs a file's tests sequentially in one worker by default; this file relies
 * on that, and the file is small enough that it costs nothing.
 */

interface FeeBody {
  platform_fee_percent: number;
}

/** Read the current global default as superadmin. */
async function readFee(request: Parameters<typeof apiJson>[0]): Promise<number> {
  const res = await apiJson<FeeBody>(request, "/api/admin/settings");
  expect(res.status, "GET /api/admin/settings as superadmin").toBe(200);
  return res.data!.platform_fee_percent;
}

test.describe("admin platform settings", () => {
  test("a support-role staff member gets no live Save, and the route refuses the write", async ({
    page,
  }) => {
    const org = await activeOrg(page);
    await setOwnerStaffRoleSql(org.id, "superadmin");
    const original = await readFee(page.request);

    await setOwnerStaffRoleSql(org.id, "support");
    try {
      await page.goto("/admin/settings");

      // requireStaff() passes, so the page itself must still render.
      await expect(page.getByRole("heading", { name: "Platform settings" })).toBeVisible();

      const save = page.getByRole("button", { name: "Save" });
      await expect(save).toBeAttached();
      await expect(save, "support staff must not be offered a Save that cannot work").toBeDisabled();

      // The guard is only real if the route refuses it too.
      const write = await apiJson(page.request, "/api/admin/settings", "PUT", {
        platform_fee_percent: 9,
      });
      expect(write.status, "PUT as support staff").toBe(401);
    } finally {
      await setOwnerStaffRoleSql(org.id, "superadmin");
      const after = await readFee(page.request);
      expect(after, "the refused write must not have landed").toBe(original);
      await setOwnerStaffRoleSql(org.id, null);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail on the right assertion**

Run:
```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/settings-walkthrough/apps/web && \
  npx playwright test --project=walkthrough e2e/walkthrough/settings-admin.spec.ts --workers=1
```
Expected: FAIL on `toBeDisabled()` — the reported error names the Save button, not the 401. If it fails on the 401 instead, the premise is wrong and that is a finding: record it in `_INDEX.md` before changing anything.

- [ ] **Step 3: Let the page tell the component who is asking**

In `apps/web/src/app/admin/settings/page.tsx`, `requireStaff()` is already enforced by the layout, but the page never learns the role. Read it and pass it down:

```tsx
import Link from "@/components/ui/console-link";
import { platformFeeDefault } from "@/lib/platform-settings";
import { requireStaff } from "@/lib/admin";
import { AdminPlatformSettings } from "@/components/admin-platform-settings";

export const dynamic = "force-dynamic";

/** Platform settings (spec §5) — layout enforces staff; the API re-checks
 *  superadmin on write, so the form must express that same split or a support
 *  user is handed a Save that can only 401. */
export default async function AdminSettingsPage() {
  const [fee, staff] = await Promise.all([platformFeeDefault(), requireStaff()]);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Platform settings</h1>
        <p className="text-xs text-slate-500 mt-1">
          Fee resolution: org override → plan entitlement (registration.fee_percent) → this
          default → PLATFORM_FEE_PERCENT env → 5.
        </p>
      </div>
      <AdminPlatformSettings
        initialFeePercent={fee}
        canWrite={staff.staff_role === "superadmin"}
      />
      <p className="text-xs text-slate-500">
        See what the cut has earned →{" "}
        <Link href="/admin/revenue" className="text-purple-300 hover:text-white">
          Revenue
        </Link>
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Make the component honour it**

In `apps/web/src/components/admin-platform-settings.tsx`, change the signature and the two controls:

```tsx
export function AdminPlatformSettings({
  initialFeePercent,
  canWrite,
}: {
  initialFeePercent: number;
  canWrite: boolean;
}) {
```

then the input gains `disabled={!canWrite}`, the button becomes
`disabled={!canWrite || busy || !valid}`, and a note renders beside them:

```tsx
{!canWrite && (
  <span className="text-xs text-slate-400">Superadmin only.</span>
)}
```

- [ ] **Step 5: Run the test again**

Run: the Step 2 command.
Expected: PASS.

- [ ] **Step 6: Mutate the fix and confirm the test is not decoration**

Temporarily change the button back to `disabled={busy || !valid}`.
Run: the Step 2 command.
Expected: FAIL on `toBeDisabled()`. Then restore the fix and re-run to green. A guard nothing kills is decoration; this step is what proves it is not.

- [ ] **Step 7: Commit**

```bash
git add apps/web/e2e/walkthrough/settings-admin.spec.ts \
        apps/web/src/app/admin/settings/page.tsx \
        apps/web/src/components/admin-platform-settings.tsx
git commit -m "fix(admin): a support-role staff member gets no live Save

/admin/settings gates the page on requireStaff() and the write on
requireSuperadmin(). The form knew about neither — its only disabled was
busy || !valid — so a support user was shown a Save that could only 401.
The page now reads the caller's staff role and the form expresses the
same split the route already enforces.

Found by reading both files; the walkthrough that fails without this
drives it and asserts the route's own answer alongside the rendered
state, because a disabled control is not a guard."
```

---

### Task 3: F2 — clearing the fee field must not save 0%

**Files:**
- Modify: `apps/web/e2e/walkthrough/settings-admin.spec.ts`
- Modify: `apps/web/src/components/admin-platform-settings.tsx`

**Interfaces:**
- Consumes: `readFee` and the `test.describe` block from Task 2.
- Produces: nothing new.

`parsed = Number(fee)`. When the field is cleared, `fee` is `""` and `Number("")` is `0`, so `valid` stays true, the button stays enabled, and zod accepts `0`. The platform's entire cut can be zeroed by clearing a field and clicking Save.

- [ ] **Step 1: Write the failing test**

Append inside the existing `test.describe`:

```ts
  test("clearing the fee field cannot silently save 0%", async ({ page }) => {
    const org = await activeOrg(page);
    await setOwnerStaffRoleSql(org.id, "superadmin");
    const original = await readFee(page.request);

    try {
      await page.goto("/admin/settings");
      const input = page.getByLabel("Platform fee percent");

      // Pin what the control OPENS AT, derived from the route's own answer
      // rather than a constant typed into this test.
      await expect(input).toHaveValue(String(original));

      await input.fill("");
      await expect(
        page.getByRole("button", { name: "Save" }),
        "an empty field must not be a submittable 0%",
      ).toBeDisabled();

      // And if it were submitted anyway, the stored value must be untouched.
      expect(await readFee(page.request)).toBe(original);
    } finally {
      await setOwnerStaffRoleSql(org.id, null);
    }
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run:
```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/settings-walkthrough/apps/web && \
  npx playwright test --project=walkthrough e2e/walkthrough/settings-admin.spec.ts --workers=1
```
Expected: FAIL on `toBeDisabled()` — the button is live over an empty field.

- [ ] **Step 3: Require a non-empty field**

In `admin-platform-settings.tsx`, replace the validity derivation:

```tsx
  const trimmed = fee.trim();
  const parsed = Number(trimmed);
  // Number("") is 0, so an empty field would otherwise read as a valid 0%
  // and zero the platform's cut on a single click.
  const valid = trimmed !== "" && Number.isFinite(parsed) && parsed >= 0 && parsed <= 100;
```

- [ ] **Step 4: Run the test again**

Run: the Step 2 command.
Expected: PASS, and Task 2's test still passes.

- [ ] **Step 5: Mutate and confirm**

Temporarily drop the `trimmed !== ""` clause.
Run: the Step 2 command.
Expected: FAIL. Restore, re-run to green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/e2e/walkthrough/settings-admin.spec.ts \
        apps/web/src/components/admin-platform-settings.tsx
git commit -m "fix(admin): an empty fee field is not a valid 0%

Number(\"\") is 0, so clearing the input left `valid` true, the Save button
live, and zod content with the payload. Clearing a field and clicking Save
zeroed the platform's entire cut on entry fees.

The walkthrough pins what the control opens at — derived from the route's
own answer, not a constant — then clears it and asserts the button dies."
```

---

### Task 4: The superadmin drive, and the bounds table

**Files:**
- Modify: `apps/web/e2e/walkthrough/settings-admin.spec.ts`

**Interfaces:**
- Consumes: `readFee`, `setOwnerStaffRoleSql`, `apiJson`.
- Produces: nothing new.

Register case 21. The client says `min=0 max=100 step=0.5`; the route says `z.number().min(0).max(100)`. Nothing enforces the step on either side, so `2.7` is accepted end to end — the test pins what actually happens rather than what the attribute implies.

- [ ] **Step 1: Write the test**

Append inside the existing `test.describe`:

```ts
  test("a superadmin can change the fee, and the bounds hold on both sides", async ({ page }) => {
    const org = await activeOrg(page);
    await setOwnerStaffRoleSql(org.id, "superadmin");
    const original = await readFee(page.request);
    // Pick a target that differs from every wrong answer's constant: not the
    // current value, not 0 (F2's failure mode), not 5 (the env fallback).
    const target = original === 7.5 ? 8.5 : 7.5;

    try {
      await page.goto("/admin/settings");
      const input = page.getByLabel("Platform fee percent");
      await expect(input).toHaveValue(String(original));

      await input.fill(String(target));
      await Promise.all([
        page.waitForResponse(
          (r) => r.url().includes("/api/admin/settings") && r.request().method() === "PUT",
        ),
        page.getByRole("button", { name: "Save" }).click(),
      ]);
      await expect(page.getByText("Saved.")).toBeVisible();

      // Persisted, and rendered back after the one reload this tab gets.
      expect(await readFee(page.request)).toBe(target);
      await page.reload();
      await expect(input).toHaveValue(String(target));

      // Bounds, enumerated rather than sampled. `step` is advisory on both
      // sides: 2.7 is accepted, and this pins that rather than the attribute.
      const cases: { value: number; status: number; why: string }[] = [
        { value: -1, status: 400, why: "below the floor" },
        { value: 0, status: 200, why: "the floor itself is legal" },
        { value: 2.7, status: 200, why: "step=0.5 is enforced by nothing" },
        { value: 100, status: 200, why: "the ceiling itself is legal" },
        { value: 101, status: 400, why: "above the ceiling" },
      ];
      for (const c of cases) {
        const res = await apiJson(page.request, "/api/admin/settings", "PUT", {
          platform_fee_percent: c.value,
        });
        expect(res.status, `PUT ${c.value} — ${c.why}`).toBe(c.status);
      }
    } finally {
      await apiJson(page.request, "/api/admin/settings", "PUT", {
        platform_fee_percent: original,
      });
      expect(await readFee(page.request)).toBe(original);
      await setOwnerStaffRoleSql(org.id, null);
    }
  });
```

- [ ] **Step 2: Run it**

Run:
```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/settings-walkthrough/apps/web && \
  npx playwright test --project=walkthrough e2e/walkthrough/settings-admin.spec.ts --workers=1
```
Expected: PASS. If any row of the bounds table disagrees, that row is a finding — record the observed status in `_INDEX.md` and change the expectation to what the product does, not the other way round.

- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e/walkthrough/settings-admin.spec.ts
git commit -m "test(admin): drive the fee control and enumerate its bounds

Pins what the input opens at (read from the route, not typed here), drives
a real save through the UI, and reads the value back after one reload.
The bounds table is enumerated rather than sampled, and records that
step=0.5 is advisory on both sides — 2.7 is accepted end to end."
```

---

### Task 5: The four legacy `/settings/*` redirects

**Files:**
- Modify: `apps/web/e2e/walkthrough/settings-admin.spec.ts`

**Interfaces:**
- Consumes: `activeOrg`.
- Produces: nothing new.

Register case 24, in part. All four routes are `redirect()` shims and all four claim to preserve their query string — `?tab=` for settings, and Stripe's return params for billing and connect. `/settings/payments` forwards to `/settings/connect`, which forwards again, so it is a two-hop chain that nothing currently tests.

- [ ] **Step 1: Write the test**

Append a second `test.describe` to the same file:

```ts
test.describe("legacy settings redirects", () => {
  test("each legacy route lands org-scoped with its query intact", async ({ page }) => {
    const org = await activeOrg(page);

    const hops: { from: string; to: string; why: string }[] = [
      { from: "/settings?tab=preferences", to: `/o/${org.slug}/settings?tab=preferences`,
        why: "?tab= survives" },
      { from: "/settings", to: `/o/${org.slug}/settings`,
        why: "no query, no dangling ?" },
      { from: "/settings/billing?checkout=success&session_id=cs_test_x",
        to: `/o/${org.slug}/settings/billing?checkout=success&session_id=cs_test_x`,
        why: "an in-flight Stripe session reconciles on the new URL" },
      { from: "/settings/connect?connect=return",
        to: `/o/${org.slug}/settings/connect?connect=return`,
        why: "the Connect onboarding round-trip survives" },
      { from: "/settings/payments?connect=refresh",
        to: `/o/${org.slug}/settings/connect?connect=refresh`,
        why: "two hops: /payments → /connect → org-scoped" },
    ];

    for (const hop of hops) {
      await page.goto(hop.from);
      const landed = new URL(page.url());
      expect(`${landed.pathname}${landed.search}`, `${hop.from} — ${hop.why}`).toBe(hop.to);
    }
  });
});
```

- [ ] **Step 2: Run it**

Run:
```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/settings-walkthrough/apps/web && \
  npx playwright test --project=walkthrough e2e/walkthrough/settings-admin.spec.ts --workers=1
```
Expected: PASS. A failing hop is a finding — record the observed landing URL in `_INDEX.md` verbatim.

- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e/walkthrough/settings-admin.spec.ts
git commit -m "test(settings): the four legacy redirects keep their query

/settings, /settings/billing, /settings/connect and /settings/payments are
redirect shims into the org-scoped routes, and three of them carry query
params a payment round-trip depends on. /settings/payments is a two-hop
chain nothing tested. Asserts the landed pathname AND search, per hop."
```

---

### Task 6: Prove the wave, and record its cost

**Files:**
- Modify: `docs/superpowers/specs/2026-09-03-settings-walkthrough-prompts/_INDEX.md`

- [ ] **Step 1: Run the whole spec file, not a slice**

Run:
```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/settings-walkthrough/apps/web && \
  npx playwright test --project=walkthrough e2e/walkthrough/settings-admin.spec.ts \
  --reporter=json --output=/dev/null 2>/dev/null | \
  python3 -c "import json,sys; d=json.load(sys.stdin); \
    print('specs:', [s['file'] for s in d['suites']]); \
    print('duration_ms:', d['stats']['duration'], 'expected:', d['stats']['expected'], \
          'unexpected:', d['stats']['unexpected'])"
```
Expected: `unexpected: 0`, and the file list names only `settings-admin.spec.ts`. A `-g` slice is a filename sweep in a costume — do not substitute one.

- [ ] **Step 2: Confirm nothing else in the leg moved**

Run:
```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/settings-walkthrough/apps/web && \
  npx playwright test --project=walkthrough --reporter=json --output=/dev/null 2>/dev/null | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(d['stats'])"
```
Expected: `unexpected: 0`. Record `duration` — this is the wave's real cost against the ≤60s programme budget, and it is the number reported, not an estimate.

- [ ] **Step 3: Confirm the CI wiring guard still holds**

Run:
```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/settings-walkthrough/apps/web && \
  DATABASE_URL= npx vitest run src/lib/__tests__/e2e-ci-wiring.test.ts \
  --reporter=json --outputFile=/tmp/wiring.json && \
  python3 -c "import json; d=json.load(open('/tmp/wiring.json')); \
    print(d['numPassedTests'], '/', d['numTotalTests'])"
```
Expected: all passing. The empty `DATABASE_URL` is required — the repo refuses to run vitest against the dev DB. A new spec in an existing directory should need no guard change; if this reddens, the guard has found something real.

- [ ] **Step 4: Lint, reading the real output**

Run: `cd /Users/ashokhein/github/seazn.club/.claude/worktrees/settings-walkthrough && rtk proxy npm run lint`
Expected: `✖ 0 problems`. `rtk` hides lint output and prints "ESLint output (JSON parse failed)" — that is the wrapper losing the result, not a clean run, which is why this goes through `rtk proxy`.

- [ ] **Step 5: Update the programme index**

Set W1's state to done, move F1 and F2 to fixed with their commit SHAs, record F3 as pinned-not-fixed, and write the measured leg duration into the status table. Add any finding the runs turned up.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-09-03-settings-walkthrough-prompts/_INDEX.md
git commit -m "docs(settings): W1 done — findings, fixes and measured leg cost"
```

---

## Self-review

**Spec coverage.** W1's slice of the design is §7 case 1 (Task 2), case 21 (Task 4), case 24's redirect half (Task 5), and the §4 note that W0 folds in (File Structure). Cases 2–20, 22, 23, 25 belong to later waves and are listed in `_INDEX.md`. F2 and F3 are new findings this planning pass produced and are covered by Tasks 3 and 4.

**Placeholders.** None. Every code step carries the actual code; every run step carries the actual command and the expected result.

**Type consistency.** `setOwnerStaffRoleSql(orgId, role)` is defined in Task 1 and called with that signature in Tasks 2, 3 and 4. `readFee(request)` is defined in Task 2's file header and reused in Tasks 3 and 4. `AdminPlatformSettings` gains `canWrite: boolean` in Task 2 and is not re-shaped afterwards. `apiJson`'s return is destructured as `{status, data}` throughout, matching `helpers.ts:122`.

**Known deviation from the design.** §10 of the design says production changes wait for W8. Tasks 2 and 3 fix in W1 instead, because a knowingly-red test cannot sit in the CI leg for eight waves and both fixes are a few lines on a staff-only surface. Flagged for the owner in `_INDEX.md` under recommendations.

**Open question for the owner.** `admin-platform-settings.tsx` hardcodes every string today, so "Superadmin only." follows the file. The repo rule says any new user-facing string ships to all four locale dictionaries, and `/admin` is not one of the two declared exceptions. Needs a ruling; the alternative is to express the gate with no new string at all.
