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
 * after the first red, and each test here restores the row in its own
 * `finally`, so the cascade protection buys nothing and would only hide the
 * second failure behind the first.
 */
test.describe.configure({ mode: "default" });

interface FeeBody {
  platform_fee_percent: number;
}

/** Read the current global default as superadmin. */
async function readFee(request: APIRequestContext): Promise<number> {
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

      // LOAD-BEARING, and not decoration for the 401 below. `setOwnerStaffRoleSql`
      // has no zero-rows guard: if its UPDATE matched nothing the user is simply
      // NOT STAFF, and a non-staff caller is refused the write too — so the
      // refusal on its own would pass vacuously. /admin/layout.tsx redirects a
      // non-staff caller to /login, so this heading is the proof that
      // requireStaff() actually passed FOR THIS USER before we assert what
      // requireSuperadmin() denies them.
      await expect(
        page.getByRole("heading", { name: "Platform settings" }),
        "requireStaff() must have passed — a zero-row role update would land on /login instead",
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
      await setOwnerStaffRoleSql(org.id, "superadmin");
      const after = await readFee(page.request);
      expect(after, "the refused write must not have landed").toBe(original);
      await setOwnerStaffRoleSql(org.id, null);
    }
  });
});
