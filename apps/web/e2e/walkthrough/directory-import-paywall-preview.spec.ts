import { test, expect } from "@playwright/test";
import { failOnNativeDialog } from "../helpers";
import {
  dismissConsent,
  freshOrg,
  invalidateOrgEntitlements,
  liveLimit,
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
/** Strictly BELOW `GOOD_ROWS`, so re-previewing the first file is refused too.
 *  At exactly `GOOD_ROWS` the guard is `wouldBe > limit`, so a 3-row re-map
 *  would SUCCEED and step 1c would quietly exercise a successful remap while
 *  claiming to test a failed one. */
const CAP = GOOD_ROWS - 1;

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

  // --- 1b. a SUCCESSFUL remap leaves the plan standing ---------------------
  //
  // A STEADY-STATE check, and honest about it: it cannot witness a transient
  // unmount. An earlier version of the fix cleared the preview at the top of
  // `upload()`, which tore the card down mid-flight on every remap — but the
  // POST returns in ~100-400ms and re-mounts it, and `toBeVisible()` retries
  // for 15s, so both shapes settle identically and this assertion passes
  // against either. Pinning that placement would mean holding the response
  // with `page.route` and sampling while it is pending. What actually guards
  // it is step 1c below, which needs no such trick.
  await page.getByRole("button", { name: "Re-map & re-preview" }).click();
  await expect(
    page.getByRole("heading", { name: `Preview — first.csv (${GOOD_ROWS} rows)` }),
    "a successful re-map left no plan behind",
  ).toBeVisible();
  await expect(commit, "a successful re-map left no committable plan").toBeVisible();

  // --- 2. drop the row cap UNDER the next file, without leaving the page ----
  //
  // The override alone is not enough: `liveLimit` warms a 300s entitlement
  // cache and `setEntitlementOverrideSql` invalidates nothing, so a read-then-
  // override-then-assert sequence asserts the STALE cap.
  await setEntitlementOverrideSql(orgId, "import.bulk", CAP);
  await invalidateOrgEntitlements(page.request, orgId);
  // Read it BACK. `invalidateOrgEntitlements` is unfalsifiable on a target with
  // no Redis — `lib/cache.ts` is fail-open — so on a cached target where the
  // invalidation silently fails, the refusal below never happens and the
  // failure blames the importer for a fixture that never took.
  expect(
    await liveLimit(page, orgId, "import.bulk"),
    "the entitlement override did not take — the rest of this test would be measuring the plan default",
  ).toBe(CAP);

  // --- 1c. a FAILED remap must NOT strand the organiser --------------------
  //
  // The mapping selects and the "Re-map & re-preview" button both live inside
  // `{preview && !result}`. Clearing the preview when a RE-MAP fails therefore
  // removes the only control that can retry it — and `remap()` has already
  // written the rejected mapping to localStorage, so every later upload
  // re-sends it. Unlike step 1b this one has teeth: drop the
  // `withMapping === undefined` guard in `upload()`'s catch and the re-map
  // button below is gone, so the assertion fails on a missing control rather
  // than settling.
  //
  // The cap is now below this file's row count, so re-previewing the SAME file
  // is refused — a failing remap with no route interception needed.
  const remapButton = page.getByRole("button", { name: "Re-map & re-preview" });
  await remapButton.click();
  await expect(
    page.locator('[data-feature="import.bulk"]'),
    "the re-map was not refused, so this step is not exercising a failed remap at all",
  ).toBeVisible();
  await expect(
    remapButton,
    "a failed re-map removed the control needed to retry it — the organiser is stranded with a poisoned mapping in localStorage",
  ).toBeVisible();

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
