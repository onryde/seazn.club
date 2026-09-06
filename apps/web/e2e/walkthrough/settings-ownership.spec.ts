import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { seedSettingsOrg, releaseSettingsOrg, seedMemberIdentity, settingsUrl } from "../settings-support";
import { apiJson, TAG, mintLoginPathBySql, releaseSeededOrgSql } from "../helpers";

/**
 * W3 Task 4 — register cases 11-14 (ownership and last-actor), the four W2
 * deliberately excluded as irreversible against the shared Pro user
 * (`docs/superpowers/plans/2026-09-05-settings-walkthrough-w3.md:395-420`).
 *
 * **Correction against the dispatch**: the brief cites
 * `docs/superpowers/specs/2026-09-03-settings-walkthrough-prompts/_INDEX.md`
 * as the source naming "Cases 11/14" against specific route lines. That file
 * (and `_RULES.md` beside it) exist and were read, but neither one actually
 * enumerates Cases 11-14 by number anywhere — the case text is the plan
 * file's own prose, quoted into the brief near-verbatim. `_INDEX.md`/
 * `_RULES.md` are still binding for this wave's STANDING rules (one org per
 * test, restore every borrowed privilege, no `waitForTimeout`, the ≤60s
 * walkthrough budget) and those were followed; only the specific-case
 * citation was mis-attributed.
 *
 * Every route/UI citation below was re-read directly against this tree
 * (2026-09-06), not assumed from the brief:
 *  - `members/me/route.ts`: the last-owner check is lines 21-31 (the brief
 *    said 22-31 — off by one; `if (role === "owner") {` opens at 21).
 *  - `role/route.ts`: the last-owner check is lines 35-41 — exact match.
 *  - `users/me/route.ts`: the sole-owner block is lines 84-103; the
 *    UNCONDITIONAL `delete from org_members where user_id = ...` the brief
 *    calls out is lines 157-158 — exact match. No undelete route exists
 *    anywhere in this codebase (grepped `src/app/api/`).
 *  - `page.tsx`: 660-663 gates `TransferOwnerForm` on `members.length > 1`,
 *    666-667 gates `LeaveOrgButton` on `role !== "owner"`, 669-671 renders
 *    the static sole-owner note at `members.length === 1` — all exact.
 *  - `account-actions.tsx`: 252-258 is the form's own dead-end text once
 *    mounted with zero non-owner `candidates`. **Observed, not fixed**: this
 *    string (and several siblings — "Leave org", "Ownership transferred
 *    successfully.", the delete-account copy) is hardcoded English, not a
 *    dictionary key. Pre-existing, out of this file-scoped task's brief.
 *
 * **Two corrections found only by actually running this file, recorded here
 * because they would otherwise cost the next reader the same detour:**
 *
 *  1. `apiJson`'s (`helpers.ts`) declared `error?: { code?: string; message?:
 *     string }` shape is WRONG for every route in this file. `lib/http.ts`'s
 *     `handlerInner` returns `{ ok: false, error: err.message }` — a bare
 *     STRING — for `AuthError`/`HttpError` alike; only `/api/v1/*`'s separate
 *     envelope (server/api-v1, not exercised here) carries the `{code,
 *     message, feature_key}` object shape `settings-entitlement-gates.spec.ts`
 *     correctly uses for THAT family. Reading `res.error?.message` here
 *     silently evaluates to `undefined` (a string has no `.message`) and the
 *     assertion fails on the matcher, not the real check — caught by running
 *     the file, not by reading either file in isolation. Read `res.error`
 *     directly below (cast, since the shared helper's declared type still
 *     claims the object shape — fixing that is out of this file's scope: it
 *     is `/api/v1`-correct and many other specs may rely on it as declared).
 *  2. A brand-new account is NOT reliably "owns zero orgs" the instant its
 *     session exists. `postAuthLanding` (`lib/auth.ts:439`) calls
 *     `ensureActiveOrg` — which auto-provisions "My organization" — for ANY
 *     magic-link consumption with no safe `next`, or one whose `next` is
 *     itself an org-requiring page (`/dashboard`'s own `requirePageAuth()`
 *     "would auto-provision them a 'My organization'", its own comment says).
 *     A first login with no `next` (this file's Case 12b, before the fix)
 *     therefore already owns ONE auto-provisioned org by the time
 *     `seedSettingsOrg` creates a second — 402 on a Community `orgs.max_owned`
 *     of 1, discovered only by actually running the test, not by reading
 *     `users/me/route.ts` (the file under test) at all. Case 12b passes
 *     `next=/` (a safe, org-agnostic destination — `postAuthLanding`'s own
 *     safe-and-zero-orgs branch returns `{orgId: null, hasOrg: false}`
 *     without provisioning anything), so `seedSettingsOrg`'s org is the
 *     account's only one, matching the case's own intent exactly.
 *
 * **Case 12b is the one genuinely irreversible action in this file**: a sole
 * owner of an org with NO other members is not blocked by the guard above
 * (it only counts members OTHER than the caller), so the DELETE proceeds to
 * anonymise the user and destroy their session. It runs against a one-off
 * account this test mints and discards — `mintLoginPathBySql` (never the
 * rate-limited magic-link POST endpoint), a random address that is never
 * `proEmail()`/`communityEmail()`, and a storage state that is never
 * persisted to any `e2e/.auth/*.json` file. See that test's own comments for
 * the exact mechanism, mirrored from `auth.setup.ts`'s `provision()`.
 * Cases 11/12a/13/14 all run against throwaway orgs under the shared Pro
 * identity and are refusal/absence assertions only — nothing destructive.
 */

const UI_EN: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
);

/** Copy read from the dictionary the page renders from, never retyped —
 *  this folder's idiom (settings-org-tabs.spec.ts, settings-entitlement-gates.spec.ts). */
function ui(key: string): string {
  const raw = UI_EN[key];
  if (raw === undefined) throw new Error(`missing en dictionary key: ${key}`);
  return raw;
}

const NAV_MS = 20_000;
const budget = (navs: number): number => Math.max(30_000, 10_000 + navs * NAV_MS);

/**
 * The account tab's "Organizations" section, scoped to one org's own card.
 *
 * The shared Pro identity belongs to many orgs by the time W3 runs (every
 * spec file in this whole run shares `pro.json`), so the account tab renders
 * one card per org — locating by the SEEDED org's own slug (unique per test,
 * `TAG` + a random suffix) is what keeps this from accidentally reading a
 * sibling org's card. The section itself is found by its own `<h2>` (an exact
 * dictionary-string match) rather than a bare CSS class, since `space-y-3` is
 * a plain Tailwind utility with no guarantee of being unique to this section.
 */
function orgAccountCard(page: Page, orgSlug: string) {
  const heading = page.getByRole("heading", {
    name: ui("settings.account.organizations"),
    level: 2,
    exact: true,
  });
  const section = heading.locator("xpath=ancestor::section[1]");
  return section.locator("div.space-y-3").filter({ hasText: orgSlug });
}

// ---------------------------------------------------------------------------
// Case 11 — last owner leaves
// ---------------------------------------------------------------------------

test("Case 11: the last owner cannot leave (409), and the UI shows no Leave control plus the sole-owner note", async ({
  request,
  page,
}) => {
  test.setTimeout(budget(1));
  const org = await seedSettingsOrg(request, { label: "w3-case11" });
  try {
    const res = await apiJson(request, `/api/orgs/${org.orgId}/members/me`, "DELETE");
    expect(res.status, "DELETE members/me as the sole owner").toBe(409);
    // res.error is a bare string here, not {message} — see file header
    // correction 1.
    expect(
      res.error as unknown as string,
      "must name the sole-owner refusal (members/me/route.ts:27-30)",
    ).toContain("You are the sole owner");

    await page.goto(settingsUrl(org.slug, "account"));
    const card = orgAccountCard(page, org.slug);
    await expect(card, "the seeded org's own account card must render").toBeAttached({
      timeout: NAV_MS,
    });
    await expect(
      card.getByRole("button", { name: "Leave org" }),
      "page.tsx:666-667 renders Leave only when role !== \"owner\" — a sole owner must never see it",
    ).toHaveCount(0);
    await expect(
      card.getByText(ui("settings.account.soleOwner")),
      "page.tsx:669-671's static sole-owner note must render for a lone owner",
    ).toBeVisible({ timeout: NAV_MS });
  } finally {
    await releaseSettingsOrg(request, org);
  }
});

// ---------------------------------------------------------------------------
// Case 12a — delete account while owning an org WITH other members (safe)
// ---------------------------------------------------------------------------

test("Case 12a: deleting the account while owning an org with other members is blocked (409)", async ({
  browser,
  request,
}) => {
  const org = await seedSettingsOrg(request, { label: "w3-case12a" });
  const member = await seedMemberIdentity(browser, request, org.orgId, "viewer");
  try {
    const res = await apiJson(request, "/api/users/me", "DELETE", { confirm: "DELETE" });
    expect(res.status, "DELETE /api/users/me while owning an org with another member").toBe(409);
    expect(
      res.error as unknown as string,
      "must name the sole-owner refusal (users/me/route.ts:97-103)",
    ).toContain("sole owner");

    // Extra safety proof, given the stakes of this file: a 409 must mean the
    // shared Pro identity is still fully live, not merely that the response
    // code looked right.
    const whoami = await apiJson(request, "/api/users/me");
    expect(whoami.status, "the shared Pro identity must remain fully live after a 409").toBe(200);
  } finally {
    await member.release();
    await releaseSettingsOrg(request, org);
  }
});

// ---------------------------------------------------------------------------
// Case 12b — THE GAP: a sole owner of an org with NO other members
// ---------------------------------------------------------------------------

test("Case 12b: a sole owner of an org with NO other members is NOT blocked — the gap, driven for real", async ({
  browser,
}) => {
  test.setTimeout(budget(1));
  // A genuinely fresh, single-use account. Never proEmail()/communityEmail()
  // (those name the two long-lived shared fixtures), and its storage state is
  // never written to any e2e/.auth/*.json file — nothing else in this suite
  // will ever address this identity again once this test ends.
  const email = `e2e-w3-case12b-${TAG}-${randomBytes(4).toString("hex")}@example.com`;
  const ctx = await browser.newContext(); // no storageState — genuinely anonymous start
  const page = await ctx.newPage();
  let orgId: string | undefined;
  try {
    // Mirrors auth.setup.ts's provision(): mint the login link directly in
    // the DB, never the rate-limited magic-link POST endpoint (that budget
    // belongs to setup + passwordless-login.spec.ts — helpers.ts's own doc
    // comment on mintLoginPathBySql / the magic-link route).
    //
    // `next=/` matters (see file header correction 2): with no safe `next`,
    // consuming the link auto-provisions "My organization" via
    // postAuthLanding -> ensureActiveOrg BEFORE seedSettingsOrg ever runs,
    // which then 402s on Community's orgs.max_owned=1 for what looks like a
    // fresh account's FIRST org. `/` is safe and org-agnostic, so
    // postAuthLanding's zero-orgs branch returns without provisioning
    // anything, and seedSettingsOrg's org below is genuinely the only one.
    const loginUrl = `${await mintLoginPathBySql(email)}&next=${encodeURIComponent("/")}`;
    await page.goto(loginUrl);
    await page.waitForURL((u) => !u.pathname.startsWith("/magic-link"), { timeout: 30_000 });
    await page.request.post("/api/onboarding/complete", { data: {} });

    // This fresh identity creates and owns its own throwaway org — no other
    // member ever joins it, which is exactly the shape the guard misses.
    // Community, not Pro: the plan is irrelevant to the finding, and skipping
    // seedSettingsOrg's Pro branch avoids an unneeded billing-group flip.
    const org = await seedSettingsOrg(page.request, { plan: "community", label: "w3-case12b" });
    orgId = org.orgId;

    const del = await apiJson(page.request, "/api/users/me", "DELETE", { confirm: "DELETE" });
    expect(
      del.status,
      "THE FINDING: users/me/route.ts:84-95's blockedOrgs query only counts " +
        "members OTHER than the caller (m3.user_id <> user.id) — an org with " +
        "zero other members never enters the blocked set, so a sole owner of " +
        "an otherwise-empty org is not blocked at all and the delete proceeds",
    ).toBe(200);

    // Prove the account is actually gone, not just that the route said 200 —
    // the same session can no longer authenticate at all.
    const whoami = await apiJson(page.request, "/api/users/me");
    expect(whoami.status, "the deleted account's session must be dead").toBe(401);
  } finally {
    // No live session survives to drive releaseSettingsOrg's API-based
    // restore (and this fresh identity never had a previousActiveOrgId to
    // restore in the first place). Soft-delete the now-ownerless org row
    // directly, by SQL, so it drops out of listings — never attempted via any
    // authenticated call, since none would succeed against a deleted account.
    if (orgId) await releaseSeededOrgSql(orgId).catch(() => {});
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// Case 13 — transfer ownership at one member, then at two owners
// ---------------------------------------------------------------------------

test("Case 13: the transfer-ownership control is absent at one member, and a 2-owner org lands on the form's own dead-end text", async ({
  browser,
  request,
  page,
}) => {
  test.setTimeout(budget(2));
  const org = await seedSettingsOrg(request, { label: "w3-case13" });
  let coOwner: Awaited<ReturnType<typeof seedMemberIdentity>> | undefined;
  try {
    await page.goto(settingsUrl(org.slug, "account"));
    let card = orgAccountCard(page, org.slug);
    await expect(card, "the seeded org's own account card must render").toBeAttached({
      timeout: NAV_MS,
    });
    await expect(
      card.getByText(ui("settings.account.transferOwnership"), { exact: true }),
      "page.tsx:660-663 mounts TransferOwnerForm only when members.length > 1 — a sole owner must never see it",
    ).toHaveCount(0);

    // Second guard: promote a second member to owner too (Task 2 Case 6's
    // mechanism — the invites schema has no "owner" enum value, so invite as
    // admin then self-role-change via the route this case is really about).
    coOwner = await seedMemberIdentity(browser, request, org.orgId, "admin");
    const promote = await apiJson(
      request,
      `/api/orgs/${org.orgId}/members/${coOwner.userId}/role`,
      "POST",
      { role: "owner" },
    );
    expect(promote.status, "promoting the second member to owner").toBe(200);

    await page.goto(settingsUrl(org.slug, "account"));
    card = orgAccountCard(page, org.slug);
    await expect(card, "the seeded org's own account card must render after promotion").toBeAttached({
      timeout: NAV_MS,
    });
    // The page-level gate now passes (members.length === 2 > 1), but every
    // OTHER member is also an owner, so account-actions.tsx:212's own
    // `members.filter(m => m.role !== "owner")` is empty and the mounted
    // form lands on its dead-end text instead of a working picker.
    await expect(
      card.getByText("Add at least one other member before transferring ownership."),
      "OBSERVED: account-actions.tsx:252-258's dead-end text (hardcoded English, pre-existing — see file header)",
    ).toBeVisible({ timeout: NAV_MS });
  } finally {
    if (coOwner) await coOwner.release();
    await releaseSettingsOrg(request, org);
  }
});

// ---------------------------------------------------------------------------
// Case 14 — demote the only owner
// ---------------------------------------------------------------------------

test("Case 14: demoting the sole owner is refused (409), keeping at least one owner", async ({
  browser,
  request,
}) => {
  const org = await seedSettingsOrg(request, { label: "w3-case14" });
  const admin = await seedMemberIdentity(browser, request, org.orgId, "admin");
  try {
    const me = await apiJson<{ id: string }>(request, "/api/users/me");
    const ownerUserId = me.data!.id;

    const res = await apiJson(
      request,
      `/api/orgs/${org.orgId}/members/${ownerUserId}/role`,
      "POST",
      { role: "admin" },
    );
    expect(res.status, "demoting the sole owner").toBe(409);
    expect(
      res.error as unknown as string,
      "must name the last-owner refusal (role/route.ts:39-40)",
    ).toContain("An organization must keep at least one owner");

    // A 409 must mean nothing moved — not just that the status code looked right.
    const after = await apiJson<{ user_id: string; role: string }[]>(
      request,
      `/api/orgs/${org.orgId}/members`,
    );
    const ownerRow = after.data!.find((m) => m.user_id === ownerUserId);
    expect(ownerRow?.role, "the 409 must mean the owner's row did not move").toBe("owner");
  } finally {
    await admin.release();
    await releaseSettingsOrg(request, org);
  }
});
