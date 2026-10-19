import { test, expect } from "@playwright/test";

// Password sign-in was removed 2026-10-19. The product signs in by emailed link and Google (and the profile-claim
// flow). The unit tripwire is src/lib/__tests__/no-password-auth.test.ts; THIS spec asks the real server:
//   - the two old pages answer the app's normal 404 (not a 500, not a blank page, not a redirect to a sign-in form);
//   - the four old API routes answer 404 to a POST, so a stale client or an old emailed link cannot reach them;
//   - the login page offers an email field and Google, and no password field;
//   - the verify-email page, which a staff "resend verification" still links to, is alive.
//
// Unauthenticated on purpose (a signed-in session must not change what a retired URL answers), and independent of
// the dev-link exposure, so it also runs against a production-mode target.
test.use({ storageState: { cookies: [], origins: [] } });

const OLD_PAGES = ["/forgot-password", "/reset-password", "/reset-password?token=abc123def456abc123def456"];
const OLD_ROUTES = ["/api/auth/login", "/api/auth/signup", "/api/auth/forgot-password", "/api/auth/reset-password"];

for (const url of OLD_PAGES) {
  test(`the retired page ${url} answers the normal 404`, async ({ page }) => {
    const res = await page.goto(url);
    expect(res, "the server answered").not.toBeNull();
    expect(res!.status(), `${url} is not a 5xx and not a page`).toBe(404);
    // Still the app's 404 page, not an empty body: the framework's not-found copy is on screen.
    await expect(page.getByText(/this page could not be found/i)).toBeVisible();
    // And it never offered a form.
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
  });
}

for (const route of OLD_ROUTES) {
  test(`the retired route ${route} answers 404 to a POST`, async ({ request }) => {
    const res = await request.post(route, {
      data: { email: "retired@example.test", password: "hunter22", token: "abc123def456abc123def456" },
    });
    expect(res.status(), `POST ${route}`).toBe(404);
    // A removed route must not mint a session as a side effect of being hit.
    expect(res.headers()["set-cookie"] ?? "", `POST ${route} sets no cookie`).not.toContain("seazn_session");
  });
}

test("the login page offers email and Google and no password field", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByRole("link", { name: /google/i })).toBeVisible();
  await expect(page.getByLabel("Password")).toHaveCount(0);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  // The old "Forgot your password?" way out is gone with it.
  await expect(page.getByRole("link", { name: /forgot/i })).toHaveCount(0);
});

test("the verify-email page that a staff resend links to is still alive", async ({ page }) => {
  const res = await page.goto("/verify-email");
  expect(res!.status()).toBe(200);
  // No token in the URL: the page says so rather than crashing.
  await expect(page.getByText(/missing verification token/i)).toBeVisible();
});
