import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { loginUi, withDb, TAG } from "./helpers";

// Revshare affiliate attribution, browser half (see lib/revshare.ts):
//   root-layout <script> -> window.revshare_metadata.ref_code
//   -> <RevshareCapture> writes the first-party `rs_ref` cookie
//   -> a FRESH signup's org is stamped organizations.revshare_ref_code.
// The invoice -> Revshare half has no browser; it is pinned by
// revshare-sale-seam.test.ts (real runEvent) and the smoke suite.
//
// The third-party script is fulfilled at the network edge: the real file would
// make this test depend on revshare.so being up, and could not be told what
// ref_code to expose. What is under test is OUR wiring around it.
//
// Every visitor is a genuinely anonymous context — the project storageState is
// the authed Pro owner, whose session would make each "signup" below vacuous.
const anon = (b: Browser) => b.newContext({ storageState: { cookies: [], origins: [] } });

const TRACKING_URL = "https://www.revshare.so/tracking.js";

async function stubTracker(page: Page, refCode: string | null): Promise<void> {
  await page.route(TRACKING_URL, (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: refCode
        ? `window.revshare_metadata = { ref_code: ${JSON.stringify(refCode)} };`
        : `window.revshare_metadata = {};`,
    }),
  );
}

/** Sign a brand-new person up and return the stamped ref_code of the org they got. */
async function signUpAndReadStamp(page: Page, label: string): Promise<string | null> {
  const email = `delivered+rs-${label}-${TAG}@resend.dev`;
  await loginUi(page, email);
  // The org is auto-provisioned on the first console render.
  await page.goto("/dashboard");
  await expect
    .poll(
      async () =>
        withDb(async (sql) => {
          const rows = await sql<{ n: number }[]>`
            select count(*)::int as n from organizations o
              join users u on u.id = o.created_by where u.email = ${email}`;
          return rows[0].n;
        }),
      { message: "the new user should own exactly one org", timeout: 20_000 },
    )
    .toBe(1);
  return withDb(async (sql) => {
    // The ref_code lives on the billing GROUP the org pays through, not on the org.
    const rows = await sql<{ revshare_ref_code: string | null }[]>`
      select s.revshare_ref_code from organizations o
        join subscriptions s on s.id = o.subscription_id
        join users u on u.id = o.created_by where u.email = ${email}`;
    return rows[0].revshare_ref_code;
  });
}

const cookieValue = async (ctx: BrowserContext) =>
  (await ctx.cookies()).find((c) => c.name === "rs_ref")?.value;

// NEXT_PUBLIC_REVSHARE_ENABLED is baked at BUILD time and defaults off, and e2e.yml
// deliberately does not turn it on (every e2e page would then load the real
// revshare.so script). So this spec runs only against a server built with the
// switch on — locally: NEXT_PUBLIC_REVSHARE_ENABLED=1 seazn-env rebuild — and the
// test process must carry the same value so it knows which build it is driving.
test.describe("revshare affiliate attribution", () => {
  test.skip(
    process.env.NEXT_PUBLIC_REVSHARE_ENABLED !== "1",
    "needs a server built with NEXT_PUBLIC_REVSHARE_ENABLED=1 (and the same value in this process)",
  );

  test("the tracking script ships in <head> with this program's attributes", async ({ browser }) => {
    const ctx = await anon(browser);
    const page = await ctx.newPage();
    await stubTracker(page, null);
    await page.goto("/");
    const tag = page.locator(`head script[src="${TRACKING_URL}"]`);
    await expect(tag).toHaveCount(1);
    await expect(tag).toHaveAttribute("data-program-id", "6ac5012c6a42960a11fbb86b");
    await expect(tag).toHaveAttribute("data-domain", ".seazn.club");
    await expect(tag).toHaveAttribute("data-cookie-duration", "30");
    await expect(tag).toHaveAttribute("async", "");
    await ctx.close();
  });

  test("an affiliate landing becomes a stamped org after a fresh signup", async ({ browser }) => {
    const ref = `aff_e2e_${TAG}`;
    const ctx = await anon(browser);
    const page = await ctx.newPage();
    await stubTracker(page, ref);
    await page.goto("/");
    await expect.poll(() => cookieValue(ctx), { message: "RevshareCapture should write rs_ref" }).toBe(ref);
    expect(await signUpAndReadStamp(page, "hit")).toBe(ref);
    await ctx.close();
  });

  test("no affiliate landing -> no cookie and an unstamped org (negative pair)", async ({ browser }) => {
    const ctx = await anon(browser);
    const page = await ctx.newPage();
    await stubTracker(page, null);
    await page.goto("/");
    // RevshareCapture polls for 10s before giving up; give it a real chance to
    // (wrongly) write something, then assert nothing was written.
    await page.waitForTimeout(2_000);
    expect(await cookieValue(ctx)).toBeUndefined();
    expect(await signUpAndReadStamp(page, "miss")).toBeNull();
    await ctx.close();
  });

  // Chromium refuses to SET a cookie holding `;`, so those never reach the server
  // through a browser at all; what can arrive is a value Chromium accepts but our
  // alphabet does not — spaces, SQL-ish text, an over-long code.
  for (const [label, value] of [
    ["spaces and SQL-ish text", "x DROP TABLE organizations --"],
    ["65 chars (one over the limit)", "a".repeat(65)],
  ] as const) {
    test(`a hostile rs_ref cookie is never stored on the org: ${label}`, async ({ browser }) => {
      const ctx = await anon(browser);
      const base = new URL(process.env.PLAYWRIGHT_BASE ?? "http://localhost:3000");
      await ctx.addCookies([{ name: "rs_ref", value, domain: base.hostname, path: "/" }]);
      // Anti-vacuity: the hostile cookie really is in the jar when the signup runs.
      expect(await cookieValue(ctx)).toBe(value);
      const page = await ctx.newPage();
      await stubTracker(page, null);
      await page.goto("/");
      expect(await signUpAndReadStamp(page, `evil-${label.length}`)).toBeNull();
      await ctx.close();
    });
  }
});
