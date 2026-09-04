import { test, expect, type APIRequestContext } from "@playwright/test";
import { activeOrg, apiJson, platformFeePercentSql, setOwnerStaffRoleSql } from "../helpers";

/**
 * W1 of the settings walkthrough programme. Complements nothing — this
 * surface had no e2e coverage of any kind.
 *
 * The platform fee default is a single GLOBAL row (`platform_settings`), not
 * an org-scoped value, so the programme's one-org-per-test isolation rule
 * cannot apply here: two tests in this file must never be in flight at once.
 *
 * `mode: "default"` is what buys that, and it is NOT the ambient behaviour —
 * playwright.config.ts sets `fullyParallel: true`, which this project inherits
 * and CI runs with `--workers=3`, so without this line Playwright would spread
 * this file's tests across workers and let them fight over that one row.
 * `default` rather than `serial` deliberately: serial also SKIPS every test
 * after the first red, and each test here restores its state in its own
 * `finally`, so the cascade protection buys nothing and would only hide the
 * second failure behind the first.
 *
 * WHAT THAT LINE DOES NOT BUY: it orders tests WITHIN THIS FILE ONLY. At
 * `--workers=3` two OTHER walkthrough specs run alongside this one, and both
 * the fee row and the shared Pro user are global to the leg — so a spec here
 * that leaves a borrowed `staff_role` behind breaks a stranger's spec, not its
 * own. That is why every grant below lives inside a `try` whose `finally`
 * clears it unconditionally, and why nothing that can throw sits between a
 * grant and that `try`.
 */
test.describe.configure({ mode: "default" });

interface FeeBody {
  platform_fee_percent: number;
}

/**
 * Raw read of the global default. Asserts NOTHING, so it is safe to call from
 * a `finally` — an assertion there would replace the test's real failure with
 * its own and hide what actually broke.
 */
async function peekFee(request: APIRequestContext): Promise<{ status: number; value?: number }> {
  const res = await apiJson<FeeBody>(request, "/api/admin/settings");
  return { status: res.status, value: res.data?.platform_fee_percent };
}

/** Read the current global default as superadmin. Asserts the 200 AND that a
 *  number actually came back, so call it from the test BODY only — never from a
 *  `finally`.
 *
 *  The definedness assertion is not belt-and-braces, it is the money guard.
 *  `apiJson` swallows a body-parse failure (`helpers.ts`:
 *  `.catch(() => ({ ok: false }))`) and hands back `data: undefined`, so a 200
 *  carrying a malformed or envelope-less body yields `undefined` rather than
 *  throwing. Without this line `original` goes undefined, the closing
 *  "the refused write must not have landed" degrades to
 *  `expect(undefined).toBe(undefined)`, and the one assertion this test exists
 *  for passes vacuously. `value!` is erased at runtime and saves nothing.
 *  Verified: with the read forced to a 200 that carries no
 *  `platform_fee_percent`, the suite was GREEN without this assertion and RED
 *  with it. */
async function readFee(request: APIRequestContext): Promise<number> {
  const { status, value } = await peekFee(request);
  expect(status, "GET /api/admin/settings as superadmin").toBe(200);
  expect(value, "GET /api/admin/settings must carry platform_fee_percent").toBeDefined();
  return value!;
}

test.describe("admin platform settings", () => {
  /**
   * Timeout-independent cleanup, and the reason it exists is not theoretical.
   *
   * VERIFIED on Playwright 1.61.1: when a test TIMES OUT, Playwright does not
   * unwind the test function, so NEITHER `finally` below runs — a probe that
   * timed out while the grant was held left the shared Pro user
   * `is_staff=t, staff_role=superadmin` in the database. `afterEach` DOES run,
   * and its awaits complete. So the try/finally is the ordinary-failure path
   * (it also has to restore superadmin mid-test to re-read the fee), and this
   * hook is the backstop for the one failure mode a `finally` cannot cover.
   *
   * It carries the GLOBAL FEE ROW as well as the borrowed role, and for the same
   * reason: `platform_settings` is one row shared by the whole leg, T4 writes
   * it, and a timeout mid-write would leave the platform's default cut changed
   * for every run that follows. The `finally` in a fee-writing test cannot be
   * the protection — on a timeout it never starts.
   *
   * Every test in this block inherits both — which is the point, because T3-T5
   * append here. Set `borrowedOrgId` BEFORE the first grant, never after.
   */
  let borrowedOrgId: string | null = null;
  let originalFeePercent: number | null = null;

  test.beforeEach(async () => {
    borrowedOrgId = null;
    /**
     * Captured BEFORE any test in this block can write it, and read by SQL
     * rather than through `GET /api/admin/settings` — the route is
     * superadmin-only, and at this point no privilege has been borrowed yet.
     * `null` means the row is absent, in which case there is nothing to restore
     * and writing one would be a new setting rather than a restore.
     */
    originalFeePercent = await platformFeePercentSql();
  });

  test.afterEach(async ({ page }) => {
    const orgId = borrowedOrgId;
    const fee = originalFeePercent;
    borrowedOrgId = null;
    originalFeePercent = null;
    // Gated on the BORROW, not on whether the test thinks it wrote: the fee can
    // only be written by a superadmin, superadmin can only come from a grant,
    // and a grant that did not arm `borrowedOrgId` first has already leaked the
    // louder of the two things. It is also the only org id this hook has, and
    // it needs one to borrow the privilege the restore itself requires.
    if (!orgId) return;
    try {
      if (fee !== null) {
        /**
         * Through the ROUTE, never raw SQL. `platformFeeDefault()` is
         * cache-aside on a 300s Redis entry and `setPlatformFeeDefault` is the
         * only writer that invalidates it, so an UPDATE here would put the row
         * back and leave the stale value serving every later reader for five
         * minutes — a restore that reads as clean in psql and is not one.
         *
         * Unconditional: no read-then-compare, because a failing compare would
         * fail OPEN and skip the restore, and the write is idempotent anyway.
         */
        await setOwnerStaffRoleSql(orgId, "superadmin");
        const res = await apiJson(page.request, "/api/admin/settings", "PUT", {
          platform_fee_percent: fee,
        });
        // Reported, never ASSERTED. An expect() in a hook replaces the test's
        // real failure with its own, which is the trap the peekFee/readFee split
        // above exists to avoid; a warning says what happened without hiding
        // what broke.
        if (res.status !== 200) {
          console.warn(
            `[settings-admin] fee restore to ${fee}% did not land (HTTP ${res.status})`,
          );
        }
      }
    } finally {
      await setOwnerStaffRoleSql(orgId, null);
    }
  });

  test("a support-role staff member gets no live Save, and the route refuses the write", async ({
    page,
  }) => {
    const org = await activeOrg(page);

    let original: number | undefined;
    let after: { status: number; value?: number } | undefined;

    // The FIRST grant is already inside this try. Nothing that can throw may
    // sit between a grant and the `finally` that clears it: the org owner is
    // the SHARED Pro user, and a leaked `superadmin` does not fail here — it
    // fails in some other spec in the leg, whose diff explains nothing.
    try {
      // Arm the afterEach backstop BEFORE the grant exists to leak.
      borrowedOrgId = org.id;
      await setOwnerStaffRoleSql(org.id, "superadmin");
      original = await readFee(page.request);

      await setOwnerStaffRoleSql(org.id, "support");
      await page.goto("/admin/settings");

      // LOAD-BEARING, and not decoration for the 401 below. `setOwnerStaffRoleSql`
      // has no zero-rows guard: if its UPDATE matched nothing the user is simply
      // NOT STAFF, and a non-staff caller is refused the write too — so the
      // refusal on its own would pass vacuously. /admin/layout.tsx redirects a
      // non-staff caller away, so this heading is the proof that requireStaff()
      // actually passed FOR THIS USER before we assert what requireSuperadmin()
      // denies them.
      await expect(
        page.getByRole("heading", { name: "Platform settings" }),
        "requireStaff() must have passed — a zero-row role update would redirect instead",
      ).toBeVisible();

      const save = page.getByRole("button", { name: "Save" });
      await expect(save).toBeAttached();
      await expect(save, "support staff must not be offered a Save that cannot work").toBeDisabled();

      // The other half of the same proof: this note renders only when the page
      // resolved the caller as NOT superadmin. Heading + note together pin the
      // role at staff-but-not-superadmin, which is the only state this test is
      // about.
      await expect(
        page.getByText("Superadmin only."),
        "the form must say why the Save is dead",
      ).toBeVisible();

      // The guard is only real if the route refuses it too.
      const write = await apiJson(page.request, "/api/admin/settings", "PUT", {
        platform_fee_percent: 9,
      });
      expect(write.status, "PUT as support staff").toBe(401);
    } finally {
      // Borrow superadmin back just long enough to read the fee, then clear the
      // privilege NO MATTER WHAT. The inner finally holds only the restore, so
      // a failing read can never skip it.
      try {
        await setOwnerStaffRoleSql(org.id, "superadmin");
        after = await peekFee(page.request);
      } finally {
        await setOwnerStaffRoleSql(org.id, null);
      }
    }

    // Deliberately OUTSIDE every `finally`. A throw above never reaches here,
    // so these assertions can only ever report their own failure — they can
    // never overwrite the real one with a confusing "the fee moved" message.
    expect(after?.status, "GET /api/admin/settings after restoring superadmin").toBe(200);
    expect(after?.value, "the refused write must not have landed").toBe(original);
  });

  /**
   * F2. `Number("")` is `0`, so clearing the input left `valid` true, the Save
   * button live, and the PUT body carrying `platform_fee_percent: 0` — the
   * platform's entire cut on entry fees, zeroed by a clear and a click.
   *
   * THE GUARD HAS TO BE CLIENT-SIDE, and that is not a shortcut. `0` is a
   * legitimate fee (the route's `z.number().min(0)` accepts it, and T4's bounds
   * table pins that 200), so the server cannot tell "the admin meant zero" from
   * "the admin cleared the box". Only the form knows the field was EMPTY.
   */
  test("clearing the fee field cannot silently save 0%", async ({ page }) => {
    const org = await activeOrg(page);

    // The grant lives INSIDE the try (nothing that can throw may sit between a
    // grant and the finally that clears it), and `borrowedOrgId` is armed
    // BEFORE the grant exists to leak, or the afterEach backstop is a no-op.
    try {
      borrowedOrgId = org.id;
      await setOwnerStaffRoleSql(org.id, "superadmin");
      const original = await readFee(page.request);

      await page.goto("/admin/settings");
      const input = page.getByLabel("Platform fee percent");
      const save = page.getByRole("button", { name: "Save" });

      // Pin what the control OPENS AT, derived from the route's own answer
      // rather than a constant typed into this test.
      await expect(input).toHaveValue(String(original));

      // The differential's first half, and it is load-bearing rather than
      // decoration: `disabled={!canWrite || busy || !valid}` has three inputs,
      // so a bare toBeDisabled() below would also pass for a caller who is not
      // superadmin at all. Enabled here pins `canWrite` true and `busy` false,
      // which leaves `valid` as the ONLY thing the clear can change.
      await expect(save, "a superadmin over a valid value must have a live Save").toBeEnabled();

      await input.fill("");
      await expect(input, "the clear must actually have emptied the field").toHaveValue("");
      await expect(
        save,
        "an empty field must not be a submittable 0%",
      ).toBeDisabled();
      await expect(page.getByText("0–100 only"), "the form must say why the Save is dead").toBeVisible();

      // And if it were submitted anyway, the stored value must be untouched.
      expect(
        await readFee(page.request),
        "clearing the field must not have written anything",
      ).toBe(original);
    } finally {
      await setOwnerStaffRoleSql(org.id, null);
    }
  });

  /**
   * The drive: what the control OPENS AT, a real save made through the UI, and
   * the value read back — then the bounds, on BOTH sides of the seam. The
   * form's own `valid` predicate and the route's zod schema are separate
   * guards and neither implies the other, so each is enumerated against the
   * side that owns it.
   *
   * `step={0.5}` on the input is enforced by NOTHING: the client tests
   * `parsed >= 0 && parsed <= 100`, and the route's schema is
   * `z.number().min(0).max(100)` with no `multipleOf`. So 2.7 is accepted end
   * to end, and the table pins what the product DOES rather than what the
   * attribute implies.
   *
   * The refusals are 400, not 422. `setPlatformFeeDefault` does throw
   * `HttpError(422)` out of bounds, but `putSchema.parse` runs first and
   * `handler()` maps a ZodError to 400 (`lib/http.ts`), so 422 is unreachable
   * through this route and asserting it would be asserting a dead branch.
   */
  test("a superadmin can change the fee, and the bounds hold on both sides", async ({ page }) => {
    const org = await activeOrg(page);

    // Hoisted so the closing assertions can live OUTSIDE every `finally`.
    let original: number | undefined;
    let restored: { status: number; value?: number } | undefined;

    try {
      // Arm the afterEach backstop BEFORE the grant exists to leak — and this
      // is the test that hook was built for: it is the only one here that
      // WRITES the global fee row, and on a TIMEOUT the `finally` below never
      // starts, so without this line the platform's default cut would stay
      // wherever this test left it for every run that follows.
      borrowedOrgId = org.id;
      await setOwnerStaffRoleSql(org.id, "superadmin");
      original = await readFee(page.request);
      // A target that differs from every wrong answer's constant: not the
      // current value, not 0 (F2's failure mode), not 5 (the env fallback).
      const target = original === 7.5 ? 8.5 : 7.5;

      await page.goto("/admin/settings");
      const input = page.getByLabel("Platform fee percent");
      const save = page.getByRole("button", { name: "Save" });

      // What the control opens at, derived from the route's own answer rather
      // than a constant typed here — a reachability check would pass on any
      // value, including a stale one.
      await expect(input, "the form must open at the stored default").toHaveValue(String(original));

      await input.fill(String(target));
      await Promise.all([
        page.waitForResponse(
          (r) => r.url().includes("/api/admin/settings") && r.request().method() === "PUT",
        ),
        save.click(),
      ]);
      await expect(page.getByText("Saved."), "the form must confirm the write").toBeVisible();

      // Persisted, and served back on the next load — the page is
      // `force-dynamic` and `setPlatformFeeDefault` drops the 300s cache entry,
      // so a reload is a genuine re-read rather than a repaint of local state.
      expect(await readFee(page.request), "the save must have landed").toBe(target);
      await page.reload();
      await expect(input, "the reloaded page must open at the saved value").toHaveValue(
        String(target),
      );

      // The CLIENT half of the bounds, driven as a transition in both
      // directions. Only the second half is the point: T3 proved an EMPTY box
      // kills the Save, and a `parsed > 0` predicate would satisfy that test
      // too while making a deliberate 0% — a legal fee, and a 200 in the table
      // below — unsubmittable. The 101 line above it is what stops
      // `toBeEnabled()` from being a constant: it proves this button does go
      // dark on a fill, so its coming back live at 0 is the form's answer and
      // not just the state it was already in.
      await input.fill("101");
      await expect(save, "over the ceiling the form must kill the Save").toBeDisabled();
      await expect(page.getByText("0–100 only"), "and say why").toBeVisible();
      await input.fill("0");
      await expect(save, "0% is a legal fee — the form must still offer a Save").toBeEnabled();
      await expect(
        page.getByText("0–100 only"),
        "0 is in range, so the form must not claim otherwise",
      ).toBeHidden();

      // The ROUTE half, enumerated rather than sampled. Nothing is clicked
      // here: the form cannot express -1 or 101 as a submitted value (the
      // guard just proved that), so the only way to ask the route what it
      // does with them is to ask it directly.
      const cases: { value: number; status: number; why: string }[] = [
        { value: -1, status: 400, why: "below the floor" },
        { value: 0, status: 200, why: "the floor itself is legal" },
        { value: 2.7, status: 200, why: "step=0.5 is enforced by nothing" },
        { value: 100, status: 200, why: "the ceiling itself is legal" },
        { value: 101, status: 400, why: "above the ceiling" },
      ];
      for (const c of cases) {
        const res = await apiJson<FeeBody>(page.request, "/api/admin/settings", "PUT", {
          platform_fee_percent: c.value,
        });
        expect(res.status, `PUT ${c.value} — ${c.why}`).toBe(c.status);
        // A 200 is satisfied by ANY stored value, so an accepted row has to
        // say what it stored. This is what makes 2.7 "accepted end to end"
        // rather than merely "not refused": the route echoes
        // `platformFeeDefault()` read back AFTER the write, so a silent round
        // to 3 (or a step the column quietly enforced) shows up here.
        if (c.status === 200) {
          expect(
            res.data?.platform_fee_percent,
            `PUT ${c.value} — accepted, so it must have stored ${c.value}`,
          ).toBe(c.value);
        }
      }
    } finally {
      // Cleanup UNCONDITIONAL, and ordered so the fee restore can never skip
      // the role clear: the inner `finally` holds only the clear, so a restore
      // that throws still drops the borrowed `superadmin` off the shared Pro
      // user. Nothing here asserts, for the same reason `peekFee` exists — an
      // expect() in this block would replace the test's real failure with its
      // own.
      //
      // Through the ROUTE, never raw SQL: `platformFeeDefault()` is cache-aside
      // on a 300s entry that only `setPlatformFeeDefault` invalidates, so an
      // UPDATE would put the row back and leave the stale value serving every
      // later reader. The role is still `superadmin` here — this test never
      // demotes — so the PUT is authorised without re-granting.
      //
      // `original === undefined` means `readFee` never returned, which means
      // nothing above it ever wrote: there is nothing to restore, and PUTting
      // `undefined` would only add a 400 to the log.
      try {
        if (original !== undefined) {
          await apiJson(page.request, "/api/admin/settings", "PUT", {
            platform_fee_percent: original,
          });
        }
        restored = await peekFee(page.request);
      } finally {
        await setOwnerStaffRoleSql(org.id, null);
      }
    }

    // Deliberately OUTSIDE every `finally`. A throw above never reaches here,
    // so these can only ever report their own failure — never overwrite the
    // real one with a confusing "the fee moved".
    expect(restored?.status, "GET /api/admin/settings after the restore").toBe(200);
    expect(restored?.value, "the fee must be back where this test found it").toBe(original);
  });
});
