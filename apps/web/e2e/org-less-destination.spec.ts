import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { TAG, loginUi } from "./helpers";

// W2 task 6 — F7's residual, driven end to end.
//
// `requirePageAuth` used to bounce an org-less visitor with a bare
// `redirect("/orgs/new")`, dropping the query. W1.5 turned that from a corner
// into the DEFAULT shape of a first-time email-change confirmation:
// `postAuthLanding` honours a safe `next` WITHOUT provisioning an org
// (lib/auth.ts:444-453), so a brand-new account arriving at
// `/login?next=/settings?tab=account&email_change=…` lands org-less, is
// bounced, and never learns what happened to the address change it just
// confirmed.
//
// Why this spec has to exist at all: `apps/web` vitest is `environment:
// "node"`, so the unit half can only pin the two pure helpers
// (`orgLessRedirect`, `newOrgDestination`). It is blind to whether anything
// CALLS them — a mutant that replaces `newOrgDestination(await searchParams)`
// with `(await searchParams).next` in `app/orgs/new/page.tsx` leaves the unit
// suite at 12/12. Only a browser walking the chain can see that. This test
// drives the REAL producer (a magic link with a `next`, the same route the
// confirmation email uses), the real bounce, the real form, and the real
// landing.
//
// It runs in the `parallel` project on its OWN fresh user, deliberately:
// `assertMayOwnAnotherOrg` (lib/auth.ts:223) bounds a PERSON at five owned
// organisations with no `deleted_at` filter, and the shared Pro account is
// already spending those. A new account starts at zero and costs the leg
// nothing.

const UI_EN: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;

/** The destination the whole contract exists to carry. `invalid` is chosen
 *  over `success` on purpose: it is the one email-change outcome that needs no
 *  seeding at all, and it still exercises every param the shim forwards. */
const DESTINATION = "/settings?tab=account&email_change=invalid";

test.describe("the org-less bounce keeps where you were going", () => {
  test.slow(); // a fresh account, a bounce, a create, and two forwards

  test("a first-time signup lands on its settings destination, not the board", async ({
    browser,
  }) => {
    // Explicitly empty: a bare `newContext()` INHERITS the project's
    // `storageState` and would be signed in as the shared Pro organiser, who
    // has organisations and therefore never takes the branch under test.
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await ctx.newPage();
    try {
      const email = `e2e-orgless-${TAG}-${Math.random().toString(36).slice(2, 7)}@example.com`;

      // The PRODUCER, not a hand-typed URL: `loginUi` mints the same magic
      // link the auth routes email and appends `next` the way they do, so
      // `postAuthLanding` decides what happens next, not this test.
      await loginUi(page, email, DESTINATION);

      // Bounced — and the destination came with it. Read `next` back through
      // URLSearchParams rather than string-matching: the value carries its own
      // `?` and `&`, and an unencoded interpolation would look right in a
      // `toContain` while having lost both params.
      await expect(page, "org-less arrival should bounce to /orgs/new").toHaveURL(
        /\/orgs\/new\?next=/,
        { timeout: 20_000 },
      );
      expect(
        new URL(page.url()).searchParams.get("next"),
        "the whole destination survives the bounce, params included",
      ).toBe(DESTINATION);

      // Now finish onboarding the way a real first-timer would.
      const name = `Orgless ${TAG} ${Math.random().toString(36).slice(2, 6)}`;
      await page.getByLabel(UI_EN["orgNew.nameLabel"]!).fill(name);
      await page.getByRole("button", { name: UI_EN["orgNew.create"]! }).click();

      // …and land on what they came for. The shim forwards to the org-scoped
      // page once they HAVE an org, so the final URL is /o/{slug}/settings —
      // with both params still attached. Asserting the two params separately
      // is the point: dropping `email_change` is exactly the regression this
      // whole contract exists to prevent, and a bare "reached settings"
      // assertion passes straight through it.
      await expect(page, "post-create landing is the settings destination").toHaveURL(
        /\/o\/[^/]+\/settings\?/,
        { timeout: 30_000 },
      );
      await expect(page).toHaveURL(/[?&]tab=account\b/);
      await expect(page).toHaveURL(/[?&]email_change=invalid\b/);

      // The banner the destination was carrying the param FOR. Read out of
      // ui.json, never retyped — a test carrying its own copy of a string
      // asserts yesterday's wording.
      const copy = UI_EN["settings.emailChange.invalid"];
      expect(copy, "settings.emailChange.invalid missing from en/ui.json").toBeTruthy();
      await expect(page.getByText(copy!)).toBeVisible({ timeout: 20_000 });
    } finally {
      await ctx.close();
    }
  });

  test("no destination still means the board — today's behaviour, unchanged", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await ctx.newPage();
    try {
      const email = `e2e-orgless-plain-${TAG}-${Math.random().toString(36).slice(2, 7)}@example.com`;
      // Sign in carrying a SAFE, non-settings destination. That matters for a
      // reason this test originally got wrong and which no unit test can see:
      //
      // logging in with NO `next` makes `postAuthLanding` take its other arm
      // and provision a default org (`ensureActiveOrg`). The account then owns
      // one org — and community `orgs.max_owned` is **1**
      // (`db/migration/deltas/V112__entitlements_v2.sql:23`, unchanged by
      // V314). So the create below became this user's SECOND org,
      // `assertMayOwnAnotherOrg` computed `1 + 1 > 1` and threw
      // PaymentRequiredError, `CreateOrgForm` caught it and called `setError`
      // instead of `router.push`, and the URL assertion timed out at 30s. The
      // test could never have passed; it was written and never run.
      //
      // A safe `next` is honoured WITHOUT provisioning (`postAuthLanding`), so
      // the account stays org-less and the create below is its FIRST org,
      // inside the community cap. `/dashboard` deliberately, not `/settings`:
      // the settings shim is what test 1 exercises, and reusing it here would
      // make this test pass for the other test's reason.
      await loginUi(page, email, "/dashboard");

      await page.goto("/orgs/new");
      expect(new URL(page.url()).searchParams.get("next")).toBeNull();

      const name = `Orgless plain ${TAG} ${Math.random().toString(36).slice(2, 6)}`;
      await page.getByLabel(UI_EN["orgNew.nameLabel"]!).fill(name);
      await page.getByRole("button", { name: UI_EN["orgNew.create"]! }).click();

      await expect(page, "with no destination the create still lands on the board").toHaveURL(
        /\/dashboard\b/,
        { timeout: 30_000 },
      );
    } finally {
      await ctx.close();
    }
  });
});
