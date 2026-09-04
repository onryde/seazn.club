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
});
