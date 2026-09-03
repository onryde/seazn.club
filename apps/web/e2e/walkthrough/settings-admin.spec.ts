import { test, expect, type APIRequestContext } from "@playwright/test";
import { activeOrg, apiJson, setOwnerStaffRoleSql } from "../helpers";

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

/** Read the current global default as superadmin. Asserts the 200, so call it
 *  from the test BODY only — never from a `finally`. */
async function readFee(request: APIRequestContext): Promise<number> {
  const { status, value } = await peekFee(request);
  expect(status, "GET /api/admin/settings as superadmin").toBe(200);
  return value!;
}

test.describe("admin platform settings", () => {
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
});
