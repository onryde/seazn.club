import { test, expect, type Page } from "@playwright/test";
import { failOnNativeDialog, setBoolEntitlementOverrideSql } from "../helpers";
import { freshOrg, invalidateOrgEntitlements, stamp } from "../directory-kit";
import { ALL_OFFICIAL_ROLES } from "../../src/lib/official-roles";

/**
 * `officials.roles_multi` in BOTH directions: refused, it must SWAP the pick
 * and raise the upgrade gate; allowed, both roles must stick, save, and survive
 * a reload — the jsonb write, not the client state.
 *
 * An entitlement asserted only on the allowed side is untested. The swap branch
 * is the half a `rolesMultiAllowed = true` mutant kills, and nothing else in
 * the suite covers it end to end: officials-directory.spec.ts edits roles on
 * the SHARED PRO account, where the predicate is true in every test it runs.
 *
 * ## The axis is a staff deny, NOT the plan. Read this before "fixing" it.
 *
 * This spec was briefed to reach the refusal by leaving an org on the free plan
 * and flipping it to Pro. That is no longer possible, and the first block below
 * is the executable record of why: V319__v17_phase1_reorg.sql:26 — "Officials
 * ungate (#253): manual assign / multi-role / marks free on every plan" —
 * grants `officials.roles_multi` on COMMUNITY, and the live catalog carries
 * `true` for all five plan keys (community, event_pass, event_pass_l, pro,
 * pro_plus). There is no plan on which a picker refuses a second role, so
 * `setOrgPlanBySql(..., "pro")` would move nothing and the swap assertions
 * would sit under a heading that lied about what produced them.
 *
 * The refusal is still reachable, because `resolve()` (src/lib/entitlements.ts)
 * overlays an override FIELD BY FIELD — `ov.bool_value ?? base?.bool_value` —
 * so a staff deny of `false` beats the plan's `true`. That is a real product
 * state written by /api/admin/orgs/{id}/entitlement-override, not a test-only
 * hack, and it is the ONLY live producer of `rolesMultiAllowed === false`.
 *
 * If the catalog ever re-gates the key, block A goes red and says so directly.
 * That is the intent: it is a claim about packaging, and it should not be able
 * to change silently underneath a spec whose subject is the gate.
 *
 * Fresh org, deliberately: the walkthrough project's storageState is a shared
 * Pro org, so block A could not make a statement about the community plan at
 * all. `freshOrg` arrives on community for free (`createOrgForUser` inserts
 * plan_key 'community').
 *
 * Role keys come from `ALL_OFFICIAL_ROLES` rather than a table typed in here,
 * so a change to the sport presets moves this test with it. Chip ORDER is that
 * array's order — the first-seen union of every preset crew, not alphabetical.
 */
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * Pre-dismiss the app-wide cookie-consent banner, exactly as auth.setup.ts does
 * for every spec that inherits a storageState. This file runs on an EMPTY one,
 * so it inherits nothing — and the banner is a FIXED overlay pinned bottom-left
 * (`bottom-4 left-4 … sm:max-w-sm`) that sits directly on top of the officials
 * "Add official" button, which lives in the last card on the page. Measured:
 * without this the click retries for the full timeout against
 * `<div class="fixed bottom-4 left-4 …"> intercepts pointer events`, and the
 * failure names the button rather than the thing covering it.
 *
 * "rejected" keeps analytics off. BOTH keys are required — the version stamp
 * must match COOKIE_POLICY_VERSION or the re-prompt logic reopens the banner.
 *
 * Duplicated from f3-day-one-shots.spec.ts (which duplicated auth.setup.ts)
 * rather than added to directory-kit.ts, which this task may not edit. It is a
 * standing obligation of every empty-storageState spec and is a candidate to
 * fold into the kit — see the task report.
 */
async function dismissConsent(page: Page): Promise<void> {
  const { CONSENT_KEY, CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION } = await import(
    "../../src/lib/consent"
  );
  await page.evaluate(
    ([k, vk, v]) => {
      localStorage.setItem(k, "rejected");
      localStorage.setItem(vk, v);
    },
    [CONSENT_KEY, CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION] as const,
  );
}

test("roles_multi is free on community, swaps under a deny, and sticks once allowed", async ({
  page,
}) => {
  failOnNativeDialog(page);
  const s = stamp();
  const { orgId } = await freshOrg(page, "officials");
  // After freshOrg the page is on the app origin, so localStorage is writable
  // and the value survives every navigation below.
  await dismissConsent(page);

  // [0] is "referee": it is `useState`'s initial selection AND the value a
  // lone-chip deselect refuses to give up (`nextOfficialRoles` keeps >= 1), so
  // starting there would assert nothing in either direction. [1] and [2] are
  // two chips that are both OFF at the start, which is what makes the swap
  // observable at all.
  const roleA = ALL_OFFICIAL_ROLES[1];
  const roleB = ALL_OFFICIAL_ROLES[2];
  if (!roleA || !roleB || roleA === roleB) {
    throw new Error(
      `ALL_OFFICIAL_ROLES no longer offers two distinct non-default chips: ${ALL_OFFICIAL_ROLES}`,
    );
  }
  // A chip's accessible name is the underscore-stripped LOWERCASE key —
  // "chair umpire", never "Chair Umpire". The capital is `capitalize`, i.e.
  // CSS, and an accessible name is computed from the DOM text.
  const label = (r: string) => r.replace(/_/g, " ");

  // `data-feature` is the ONLY place the entitlement key reaches the DOM: the
  // compact <UpgradeGate> carries no testid and its visible text is
  // `featureReason(feature)`, which is copy and would move under a rewrite.
  const gate = page.locator('[data-feature="officials.roles_multi"]');

  // Scoped to the ADD form, because a second `role="group"` named "Roles"
  // mounts inside the roster row the moment its editor is opened in block C. A
  // page-wide getByRole is unambiguous now and a strict-mode violation later.
  const addForm = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Add official" }) });
  const addChips = addForm.getByRole("group", { name: "Roles" });
  const addChip = (r: string) => addChips.getByRole("button", { name: label(r), exact: true });
  const pressedIn = (scope: ReturnType<typeof addForm.getByRole>) =>
    scope.getByRole("button", { pressed: true });

  // --- A. the community plan does NOT refuse a second role (#253 / V319) ----
  // The org is on community and carries no override, so this is the plan
  // speaking. Three chips stack and no gate appears.
  await page.goto("/directory?tab=officials");
  await expect(pressedIn(addChips)).toHaveCount(1);
  await expect(gate).toHaveCount(0);

  await addChip(roleA).click();
  await addChip(roleB).click();
  await expect(
    pressedIn(addChips),
    "officials.roles_multi is granted on community (V319) — a free org stacks roles",
  ).toHaveCount(3);
  await expect(gate).toHaveCount(0);

  // --- B. under a staff deny, a pick SWAPS and raises the gate -------------
  await setBoolEntitlementOverrideSql(orgId, "officials.roles_multi", false);
  // Block A already resolved this key for this org, and lib/entitlements caches
  // for 300s. Locally REDIS_URL is unset and the cache is fail-open, so
  // skipping this is green on this machine and red on a Redis-backed target —
  // exactly the drift directory-kit's re-export warns about.
  await invalidateOrgEntitlements(page.request, orgId);
  await page.reload();

  const name = `Wren Adeyemi ${s}`;
  await page.getByLabel("Name", { exact: true }).fill(name);
  // The reload reset the picker to its initial single role. Asserted, not
  // assumed: without it the "exactly one pressed" below is also satisfied by a
  // picker that never registered either click.
  await expect(pressedIn(addChips)).toHaveCount(1);
  await expect(gate).toHaveCount(0);

  await addChip(roleA).click();
  await addChip(roleB).click();

  await expect(addChip(roleB)).toHaveAttribute("aria-pressed", "true");
  await expect(addChip(roleA)).toHaveAttribute("aria-pressed", "false");
  await expect(pressedIn(addChips)).toHaveCount(1);
  await expect(gate).toBeVisible();

  await page.getByRole("button", { name: "Add official" }).click();
  const row = page.locator("li").filter({ hasText: name });
  await expect(row).toHaveCount(1, { timeout: 15_000 });

  // The swap reached the SERVER, not just the picker's local state. The roster
  // renders `role_keys` straight off the row it read back, so one chip here is
  // the denied org's single role as stored. The editor is closed at this point,
  // so these spans are the only elements carrying a role name — while it is
  // open the picker's buttons repeat every one of them.
  await expect(
    row.locator("span").filter({ hasText: new RegExp(`^${label(roleB)}$`) }),
  ).toBeVisible();
  await expect(
    row.locator("span").filter({ hasText: new RegExp(`^${label(roleA)}$`) }),
  ).toHaveCount(0);

  // --- C. allowed again: both stick, are SAVED, and survive a reload -------
  await setBoolEntitlementOverrideSql(orgId, "officials.roles_multi", true);
  await invalidateOrgEntitlements(page.request, orgId);
  await page.reload();

  // The row's picker is not mounted until its editor is opened: the row renders
  // read-only chip SPANS, and `OfficialRolesEditor` appears only under
  // `openRow.mode === "roles"`. Nor does toggling a chip persist anything — the
  // PATCH is on "Save roles".
  await row.getByRole("button", { name: "Edit roles" }).click();
  const rowChips = row.getByRole("group", { name: "Roles" });
  await expect(pressedIn(rowChips)).toHaveCount(1);

  await rowChips.getByRole("button", { name: label(roleA), exact: true }).click();
  await expect(pressedIn(rowChips)).toHaveCount(2);
  await expect(gate).toHaveCount(0);

  await row.getByRole("button", { name: "Save roles" }).click();
  // The editor closes only on a SUCCESSFUL PATCH (`setOpenRow(null)` runs
  // inside `run`'s try). Waiting on it is what makes a 422 from the server's own
  // `assertRolesAllowed` a red here, rather than a silent no-op that the reload
  // below would report as a persistence failure.
  await expect(row.getByRole("button", { name: "Save roles" })).toHaveCount(0, {
    timeout: 15_000,
  });

  await page.reload();
  await row.getByRole("button", { name: "Edit roles" }).click();
  const persisted = await row
    .getByRole("group", { name: "Roles" })
    .getByRole("button", { pressed: true })
    .allTextContents();
  expect(persisted.map((t) => t.trim()).sort()).toEqual([label(roleA), label(roleB)].sort());
  // Close it again: the row's "Invite" button renders only while no editor is
  // open on that row (`openRow?.id !== o.id`).
  await row.getByRole("button", { name: "Cancel" }).click();

  // --- D. the official is invited, and the link is real --------------------
  await row.getByRole("button", { name: "Invite" }).click();
  await row.getByLabel("Email", { exact: true }).fill(`official-${s}@example.com`);
  await row.getByRole("button", { name: "Send invite" }).click();
  // The link is the send-FAILURE fallback: with a mailer configured the form
  // renders `officials.inviteSent` and no link at all, so this spec says that
  // out loud instead of dying on an empty locator below. It is CI's path too —
  // e2e.yml sets no RESEND_API_KEY and lib/email's send() returns false when it
  // is unset. Note the officials invite does NOT emit `data-testid="claim-link"`
  // (that is the persons rail's); here the URL is bare <code> text.
  await expect(
    row.getByText(/Email failed to send/i),
    "the mailer accepted this invite, so no link is shown — this spec needs the send-failure fallback",
  ).toBeVisible({ timeout: 15_000 });
  await expect(row.getByText(/\/claim\/pc_/)).toBeVisible();
});
