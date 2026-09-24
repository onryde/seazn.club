import { expect } from "@playwright/test";
import { TAG } from "./helpers";
import { ownTest, signInOwnAccount, signedInUserId, userColumns } from "./own-account";

// Account tab basics that don't consume the email rate budget: display-name
// edit and the data export. Change-email and account deletion are deliberately
// NOT covered end-to-end: the confirmation token is only delivered by email (no
// dev fallback), and each attempt spends the fail-closed 5/5min email budget CI
// needs for logins.
//
// Both tests save a user row, so both run on an account of their own
// (own-account.ts explains). They used to save the shared AUTH_STATE user and
// restore it afterwards, while every other worker in the project was signed in
// as that user. Each reads the shared row back once its own save has landed.

/** The columns these tests save. */
const PROFILE = ["display_name", "timezone", "locale"] as const;

ownTest("display name edits persist and the data export downloads", async ({
  ownPage: page,
  request,
}) => {
  const sharedUserId = await signedInUserId(request);
  const sharedBefore = await userColumns(sharedUserId, PROFILE);
  await signInOwnAccount(page, "account", sharedUserId);

  await page.goto("/settings?tab=account");
  // The profile form: input placeholder "Your name" + Save.
  const input = page.getByPlaceholder("Your name");

  await input.fill(`Renamed User ${TAG}`);
  // Scope to the profile form (the tab has other Save buttons) and wait for
  // the PATCH to land before reloading.
  const profileForm = page.locator("form").filter({ has: page.getByPlaceholder("Your name") });
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/users/me") && r.request().method() === "PATCH"),
    profileForm.getByRole("button", { name: /^Sav/ }).click(),
  ]);
  await page.reload();
  await expect(page.getByPlaceholder("Your name")).toHaveValue(`Renamed User ${TAG}`, {
    timeout: 20_000,
  });
  // The rename landed on this account; the shared user's row is as found.
  expect(await userColumns(sharedUserId, PROFILE), "the shared Pro user's row moved").toEqual(
    sharedBefore,
  );

  // Data export responds with the user's JSON bundle.
  const exported = await page.request.get("/api/users/me/export");
  expect(exported.status()).toBe(200);
  const body = (await exported.json()) as Record<string, unknown>;
  expect(Object.keys(body).length).toBeGreaterThan(0);
});

// Timezone preference: pick a zone, it persists; a bogus zone is rejected by
// the API. No email budget touched. It lives on the Preferences tab, not
// Account — Account keeps identity and the irreversible actions.
ownTest("timezone preference persists and the API rejects a bogus zone", async ({
  ownPage: page,
  request,
}) => {
  const sharedUserId = await signedInUserId(request);
  const sharedBefore = await userColumns(sharedUserId, PROFILE);
  await signInOwnAccount(page, "tz", sharedUserId);

  await page.goto("/settings?tab=preferences");

  // The picker is a search combobox, not a <select> — 418 zones cannot be
  // scrolled, so selectOption/toHaveValue no longer apply. Type, then click.
  const tz = page.getByRole("combobox", { name: "Your timezone" });
  await expect(tz).toBeVisible();

  // Preferences form has its own Save; scope to the innermost div holding BOTH
  // the timezone picker and its Save button (the picker sits in its own
  // min-w-0 wrapper, so filtering on the picker alone lands too narrow).
  const tzForm = page
    .locator("div")
    .filter({ has: tz })
    .filter({ has: page.getByRole("button", { name: /^Sav/ }) })
    .last();

  await tz.click();
  await tz.fill("Kolkata");
  // Ranking puts the exact city first; the row carries its country, which is
  // the whole point of the rewrite.
  const kolkata = page.getByRole("option", { name: /Kolkata/ }).first();
  await expect(kolkata).toContainText("India");
  await kolkata.click();

  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/users/me") && r.request().method() === "PATCH" && r.ok(),
    ),
    tzForm.getByRole("button", { name: /^Sav/ }).click(),
  ]);

  await page.reload();
  await expect(page.getByRole("combobox", { name: "Your timezone" })).toContainText("Kolkata", {
    timeout: 20_000,
  });
  // The zone landed on this account; the shared user's row is as found.
  expect(await userColumns(sharedUserId, PROFILE), "the shared Pro user's row moved").toEqual(
    sharedBefore,
  );

  // The venue-vs-your-time helper copy is present.
  await expect(page.getByText(/venue/i).first()).toBeVisible();

  // API guards the column: a non-IANA zone is a 4xx, not stored.
  const bad = await page.request.patch("/api/users/me", {
    headers: { "Content-Type": "application/json" },
    data: { timezone: "Mars/Phobos" },
  });
  expect(bad.status()).toBeGreaterThanOrEqual(400);
  expect(bad.status()).toBeLessThan(500);
});
