import { test, expect } from "@playwright/test";
import { failOnNativeDialog } from "../helpers";
import {
  dismissConsent,
  freshOrg,
  invalidateOrgEntitlements,
  participantCsv,
  setEntitlementOverrideSql,
  stamp,
  uniqueName,
  waitForHydration,
} from "../directory-kit";

/**
 * A refused upload must not leave the PREVIOUS file's plan on screen.
 *
 * `ImportWizard.upload()` resets `error`, `paywallFeature` and `result` but not
 * `preview`, and `fail()` does not clear it either. The `UpgradeGate` renders
 * ABOVE the `{preview && !result}` block whose "Commit import" button stays
 * enabled — so an organiser who trips a cap on their SECOND file sees the
 * paywall sitting on top of the FIRST file's still-committable plan. Pressing
 * the button then imports a file they believe was rejected.
 *
 * The clubs-import walkthrough cannot see this: it `goto`s `/import` between
 * uploads, which unmounts the wizard and takes the stale preview with it. The
 * shape only exists when both uploads happen on ONE mounted wizard, which is
 * exactly what a person does.
 *
 * The commit path's own 402 preserving the preview is CORRECT and is not
 * touched here — a cap hit at commit time should leave the plan on screen for
 * the organiser to trim. Only the upload path is wrong.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const GOOD_ROWS = 3;
const REFUSED_ROWS = 5;

test("a refused upload clears the previous file's committable plan", async ({ page }) => {
  failOnNativeDialog(page);
  const s = stamp();
  const { orgId } = await freshOrg(page, "import-paywall");
  await dismissConsent(page);

  await page.goto("/import");
  const fileInput = page.locator('input[type="file"]');
  await waitForHydration(fileInput);

  const csv = (n: number): string =>
    participantCsv(
      Array.from({ length: n }, (_, i) => ({
        club: uniqueName(`Club ${i}`),
        team: `Team ${i} ${s}`,
        player: `Player ${i} ${s}`,
      })),
    );

  // --- 1. a good file: the plan appears and is committable ------------------
  await fileInput.setInputFiles({
    name: "first.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv(GOOD_ROWS)),
  });
  const commit = page.getByRole("button", { name: "Commit import" });
  await expect(
    page.getByRole("heading", { name: `Preview — first.csv (${GOOD_ROWS} rows)` }),
  ).toBeVisible();
  await expect(commit, "the first file did not produce a committable plan").toBeVisible();

  // --- 2. drop the row cap UNDER the next file, without leaving the page ----
  //
  // The override alone is not enough: `liveLimit` warms a 300s entitlement
  // cache and `setEntitlementOverrideSql` invalidates nothing, so a read-then-
  // override-then-assert sequence asserts the STALE cap.
  await setEntitlementOverrideSql(orgId, "import.bulk", GOOD_ROWS);
  await invalidateOrgEntitlements(page.request, orgId);

  // --- 3. the second file is refused at UPLOAD, not at commit --------------
  await fileInput.setInputFiles({
    name: "over-cap.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv(REFUSED_ROWS)),
  });
  await expect(
    page.locator('[data-feature="import.bulk"]'),
    "the over-cap upload was not refused — the row cap never reached the upload path",
  ).toBeVisible();

  // --- 4. THE assertion. Nothing committable may survive the refusal -------
  //
  // Both halves matter and neither implies the other: the heading proves the
  // stale PLAN is gone, the button proves the stale ACTION is gone. A fix that
  // hid the plan while leaving the button mounted would still import the wrong
  // file.
  await expect(
    page.getByRole("heading", { name: /^Preview — / }),
    "the refused upload left the previous file's plan on screen under the paywall",
  ).toHaveCount(0);
  await expect(
    commit,
    "the refused upload left a live Commit button — pressing it imports a file the organiser was told was rejected",
  ).toHaveCount(0);
});
