import { test, expect } from "@playwright/test";
import { failOnNativeDialog, setBoolEntitlementOverrideSql } from "../helpers";
import {
  dismissConsent,
  freshOrg,
  invalidateOrgEntitlements,
  stamp,
  waitForHydration,
} from "../directory-kit";
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
 * ## The owner has ruled the ungate WRONG (2026-09-04)
 *
 * `officials.roles_multi` is to become a Pro key again. That pricing change is
 * not in this wave and no matrix row is touched here. When it lands, block A's
 * assertion must be INVERTED rather than removed — see the long comment there.
 * Block B and block C are unaffected either way: a staff deny and a lifted deny
 * are the same two states whatever the plan grants.
 *
 * Two findings routed to the owner rather than fixed here, both surfaced while
 * pinning the above: the enforcement is CLIENT-SIDE ONLY (see block C's save
 * comment), and the gate's upsell copy offers Pro for a refusal Pro cannot
 * lift, because an override outranks every plan.
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
 * 120s, matching every other walkthrough spec in this folder (`venues.spec.ts`
 * takes 120s for a strictly smaller journey; others go to 600s). These five
 * shipped on the project's flat 60s default, which was a deliberate speed
 * constraint in the design — and it was wrong.
 *
 * Measured 2026-09-05 on a loaded box: these specs run 7-35s idle and went
 * 26.7s / 57.5s / 1.1m under load, with one crossing 60s on a plain
 * `page.goto`. CI is worse, not better: `e2e.yml` runs `--workers=3` on a
 * 4-vcpu runner shared with Postgres and the Next server.
 *
 * The cost of being wrong here is asymmetric. On overrun Playwright prints
 * whichever poll was in flight ABOVE the timeout line, so a blown clock reads
 * as a data defect — in the same run, two scorepad specs reported
 * "Expected: 9 / Received: 8" over "Test timeout of 240000ms exceeded". A red
 * that lies about its own cause costs more than a slower budget. 120s still
 * catches a real regression against a 35s ceiling.
 */
test.setTimeout(120_000);


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
  //
  // ### THIS BLOCK PINS A STATE THE OWNER HAS RULED INCORRECT. READ BEFORE FIXING.
  //
  // It asserts what the product does TODAY: `V319__v17_phase1_reorg.sql:26`
  // ("Officials ungate (#253)") grants `officials.roles_multi` on community, so
  // a free org stacks roles and no gate appears.
  //
  // The owner ruled on 2026-09-04 that the ungate was WRONG and the key should
  // be Pro again. That pricing change is NOT in this wave and no matrix row is
  // touched here, so this block is a description of a state awaiting a fix, not
  // an endorsement of it.
  //
  // Consequently: WHEN THE RE-GATE SHIPS, THIS ASSERTION MUST BE INVERTED, NOT
  // DELETED. Its going red is the correct and intended signal that the re-gate
  // landed — community should then swap and raise the gate exactly as block B
  // does under a deny, and this block becomes a second, plan-driven proof of
  // the same refusal. Deleting it to "make the suite green" would throw away
  // the only executable record that the packaging ever moved.
  //
  // It is not decoration in the meantime: it is block B's control. Without it,
  // "the gate appeared" is also true of an org that can never stack anything.
  await page.goto("/directory?tab=officials");
  // Gate on hydration before the first click. The two counts below are
  // satisfied by the SSR markup, so they prove the page rendered and nothing
  // about whether a click will be heard.
  await waitForHydration(addChips);
  await expect(pressedIn(addChips)).toHaveCount(1);
  await expect(gate).toHaveCount(0);

  await addChip(roleA).click();
  await addChip(roleB).click();
  await expect(
    pressedIn(addChips),
    "officials.roles_multi is granted on community (V319) — a free org stacks roles. " +
      "If this is red, the owner's re-gate to Pro has shipped: INVERT this block, do not delete it.",
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
  await waitForHydration(addChips);

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
  await expect(row).toHaveCount(1);

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
  // The row, not the add form: hydration is per-boundary, and it is the ROW's
  // "Edit roles" button that is clicked next.
  await waitForHydration(row);

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
  // The editor closes only once the PATCH RESOLVES — `setOpenRow(null)` runs
  // inside `run`'s try, so a rejected request leaves it open. Waiting on the
  // close is therefore what makes a failed save a red HERE rather than a silent
  // no-op that the reload below would report as a persistence failure.
  //
  // Note what this does NOT wait for: an entitlement refusal. There is none.
  // `officials.roles_multi` is enforced CLIENT-SIDE ONLY — neither
  // POST /api/v1/officials nor PATCH /api/v1/officials/{id} checks it, and the
  // `assertRolesAllowed` those pickers' comments cite
  // (officials-shared.tsx:157,179) exists nowhere in server code. The only
  // server-side reader of the key is the AI planner
  // (usecases/officials-ai.ts:1196). Routed to the owner as a finding.
  await expect(row.getByRole("button", { name: "Save roles" })).toHaveCount(0);

  await page.reload();
  await waitForHydration(row);
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
  await row.getByLabel("Email", { exact: true }).fill(`delivered+official-${s}@resend.dev`);
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
  ).toBeVisible();
  await expect(row.getByText(/\/claim\/pc_/)).toBeVisible();
});
