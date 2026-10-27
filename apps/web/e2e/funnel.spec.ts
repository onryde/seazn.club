import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { PROD_TARGET, TAG, withDb } from "./helpers";

/** The claim email's subject, read from the dictionary the server renders it from, never retyped here (the
 *  `readFileSync` shape of walkthrough/scheduling-officials-handoff.spec.ts: Playwright's loader supplies no JSON
 *  import attribute). */
const EMAILS_EN: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/emails.json", import.meta.url)), "utf8"),
);

// The funnel flow hinges on the dev-exposed claim link ([data-claim-url]) —
// production targets (e.g. staging) email it instead, so skip there.
test.skip(PROD_TARGET, "dev claim-link exposure is disabled on production targets");

// PROMPT-36 (v3/07 §6): the /start funnel end-to-end — a fresh anonymous
// visitor configures a competition, receives the claim link (dev exposes it
// like the magic-link login_url), and one click lands them signed-in inside
// the created competition on the entrants tab. Fresh context per test: the
// funnel must never depend on an existing session.

test("wizard → claim link → inside the created competition", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const name = `Funnel E2E ${TAG}`;
  try {
    // Hero form params prefill step 1.
    await page.goto("/start?sport=Badminton&entrants=8");
    const wizard = page.locator("[data-start-wizard]");
    await expect(wizard).toBeVisible();
    // Scope to the wizard — the marketing footer carries a second <select>
    // (locale switcher), which trips strict mode on a bare page.locator.
    await expect(wizard.locator("select")).toHaveValue("Badminton");

    await page.getByLabel("Competition name").fill(name);
    await page.getByRole("button", { name: /recommend a format/i }).click();

    // Step 2: the live recommendation strip (pure recommendFormats) renders
    // ranked options; keep the best fit.
    await expect(page.getByText("Best fit")).toBeVisible();
    await page.getByRole("button", { name: /looks right/i }).click();

    // Step 3: email capture → draft + dev claim link.
    const email = `delivered+e2e-funnel-${TAG}@resend.dev`;
    await page.getByLabel("Your email").fill(email);
    await page.getByRole("button", { name: /email me the link/i }).click();
    const claim = page.locator("[data-claim-url]");
    await expect(claim).toBeVisible({ timeout: 20_000 });
    const claimUrl = await claim.getAttribute("data-claim-url");
    expect(claimUrl).toBeTruthy();

    // The claim email went through the email outbox: ONE `funnel_claim` row for the draft (read back by the
    // visitor's address, since the response does not name the draft). Its first attempt was made in the request,
    // so it is no longer waiting and holds no body (no Resend key: `dead`; one that can send: `sent`), and its
    // subject is the English one for this competition.
    const subject = EMAILS_EN["funnelClaim.subject"];
    expect(subject, "funnelClaim.subject missing from en/emails.json").toBeTruthy();
    const mail = await withDb(async (sql) => {
      const [draft] = await sql<{ id: string }[]>`
        select id from funnel_drafts where email = ${email} order by created_at desc limit 1`;
      expect(draft, `the start stored no draft for ${email}`).toBeTruthy();
      return sql<{ status: string; hasBody: boolean; subject: string }[]>`
        select status, body_sealed is not null as "hasBody", subject
          from email_outbox
         where kind = 'funnel_claim' and ref_type = 'funnel_draft' and ref_id = ${draft!.id}`;
    });
    expect(mail, "one claim email for the draft").toHaveLength(1);
    expect(["queued", "sending"], "the claim email's first attempt was made in the request").not.toContain(
      mail[0]!.status,
    );
    expect(mail[0]!.hasBody, "no body is left on the row after its attempt").toBe(false);
    expect(mail[0]!.subject).toBe(subject!.replaceAll("{competitionName}", name));

    // The single link signs in AND creates org + competition + division.
    await page.goto(claimUrl!);
    await page.waitForURL(/\/o\/[^/]+\/c\/[^/]+\/d\/[^/?]+\?tab=entrants/, { timeout: 30_000 });
    await expect(page.locator("body")).toContainText(name);

    // Single-use: revisiting the link fails cleanly with a way forward.
    await page.goto(claimUrl!);
    await expect(page.locator("[data-funnel-claim]")).toContainText(/didn.t work/i, {
      timeout: 20_000,
    });
  } finally {
    await ctx.close();
  }
});
