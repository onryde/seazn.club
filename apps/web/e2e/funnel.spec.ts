import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { PROD_TARGET, TAG, withDb } from "./helpers";

/** A dictionary file, read from the source the page and the server render from: copy and subjects are never retyped
 *  here (the `readFileSync` shape of walkthrough/scheduling-officials-handoff.spec.ts: Playwright's loader supplies no
 *  JSON import attribute). */
function dictionary(locale: string, ns: string): Record<string, string> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../src/dictionaries/${locale}/${ns}.json`, import.meta.url)), "utf8"),
  ) as Record<string, string>;
}
const EMAILS_EN = dictionary("en", "emails");
const EMAILS_FR = dictionary("fr", "emails");
const MARKETING_FR = dictionary("fr", "marketing");

/** A dictionary value, or a red that names the missing key (a locator or a comparison built from `undefined` fails
 *  somewhere unhelpful). Called inside a test body, never at module scope, so a missing key is a red test rather than
 *  zero collected ones. */
function need(dict: Record<string, string>, key: string, file: string): string {
  const v = dict[key];
  if (v === undefined) throw new Error(`${file} is missing key "${key}" this spec depends on`);
  return v;
}

/**
 * The claim email went through the email outbox: ONE `funnel_claim` row for the newest draft the start stored for
 * `email` (read back by the visitor's address, since the response does not name the draft). Its first attempt was
 * made in the request, so it is no longer waiting and holds no body (no Resend key: `dead`; one that can send:
 * `sent`), and its subject is `subject`.
 */
async function expectOneClaimEmail(email: string, subject: string): Promise<void> {
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
  expect(mail[0]!.subject).toBe(subject);
}

// PROMPT-36 (v3/07 §6): the /start funnel end-to-end — a fresh anonymous
// visitor configures a competition, receives the claim link (dev exposes it
// like the magic-link login_url), and one click lands them signed-in inside
// the created competition on the entrants tab. Fresh context per test: the
// funnel must never depend on an existing session.

test("wizard → claim link → inside the created competition", async ({ browser }) => {
  // This flow hinges on the dev-exposed claim link ([data-claim-url]) —
  // production targets (e.g. staging, and every CI e2e job) email it instead,
  // so skip there. Per test, not per file: the language case below needs no
  // claim link and runs everywhere.
  test.skip(PROD_TARGET, "dev claim-link exposure is disabled on production targets");
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

    // The English page's claim email, in English.
    const subject = need(EMAILS_EN, "funnelClaim.subject", "en/emails.json");
    await expectOneClaimEmail(email, subject.replaceAll("{competitionName}", name));

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

/**
 * The claim email is in the language the /start page was SHOWN in (D4's explicit pick): the wizard sends the
 * locale it rendered in, and the route uses it before the `seazn_locale` cookie. Driven through the real wizard,
 * because the request field is the seam: the route's own tests post it by hand and cannot see the client drop it.
 *
 * `/fr/start` with NO `seazn_locale` cookie and the browser's English Accept-Language, so the URL's `fr` is the
 * only French source: a wizard that stopped sending its locale, or a route that ignored it, lands on `en`. The
 * premise that the two subjects differ keeps that failure visible.
 *
 * Needs no dev claim link (it stops at the start step), so it runs on production targets and in CI too.
 */
test("a start from the French page queues the claim email in French", async ({ browser }) => {
  const enSubject = need(EMAILS_EN, "funnelClaim.subject", "en/emails.json");
  const frSubject = need(EMAILS_FR, "funnelClaim.subject", "fr/emails.json");
  expect(frSubject, "premise: the French subject differs from the English one").not.toBe(enSubject);

  // Explicitly empty storage: a bare newContext() inherits the project's storageState.
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  const name = `Funnel FR ${TAG}`;
  const email = `delivered+e2e-funnel-fr-${TAG}@resend.dev`;
  try {
    await page.goto("/fr/start?sport=Badminton&entrants=8");
    const wizard = page.locator("[data-start-wizard]");
    await expect(wizard).toBeVisible();

    await wizard
      .getByLabel(need(MARKETING_FR, "start.wizard.compName", "fr/marketing.json"), { exact: true })
      .fill(name);
    await wizard
      .getByRole("button", { name: need(MARKETING_FR, "start.wizard.recommend", "fr/marketing.json") })
      .click();
    await wizard
      .getByRole("button", { name: need(MARKETING_FR, "start.wizard.looksRight", "fr/marketing.json") })
      .click();
    await wizard
      .getByLabel(need(MARKETING_FR, "start.wizard.email", "fr/marketing.json"), { exact: true })
      .fill(email);

    expect(
      (await ctx.cookies()).filter((c) => c.name === "seazn_locale"),
      "premise: no seazn_locale cookie, so only the page's own language can make the email French",
    ).toEqual([]);
    await wizard
      .getByRole("button", { name: need(MARKETING_FR, "start.wizard.emailMe", "fr/marketing.json") })
      .click();
    await expect(page.locator("[data-funnel-done]")).toBeVisible({ timeout: 20_000 });

    await expectOneClaimEmail(email, frSubject.replaceAll("{competitionName}", name));
  } finally {
    await ctx.close();
  }
});

/**
 * The +24 h reminder through the REAL cron route (email outbox phase 3 wave 5): a draft the visitor never claims, aged 25 h
 * in SQL (the route's due filter is `created_at < now() - 24 h`), is claimed by `POST /api/funnel/remind` and gets ONE
 * `funnel_reminder` row about it — left to the worker (`queued`: a cron has no one waiting, so no attempt in the request),
 * transactional, addressed to the visitor's address and to no account (there is none yet). A second run finds the draft
 * stamped and queues nothing more.
 *
 * The start names `fr`, and the draft remembers it (P-W5-17), so the reminder's subject is the French one: the premise that
 * it differs from the English subject keeps a reminder that fell back to `en` visible. API only (no dev claim link), so it
 * runs on production targets and in CI.
 */
test("a day-old draft gets one queued reminder from the cron route, and a second run adds none", async ({ request }) => {
  const enSubject = need(EMAILS_EN, "funnelReminder.subject", "en/emails.json");
  const frSubject = need(EMAILS_FR, "funnelReminder.subject", "fr/emails.json");
  expect(frSubject, "premise: the French reminder subject differs from the English one").not.toBe(enSubject);
  // The route answers 503 without a secret on the server, and the header needs the same value here: the job sets it once.
  const cronSecret = process.env.CRON_SECRET;
  expect(cronSecret, "the e2e job must set CRON_SECRET (one value for the server and this runner)").toBeTruthy();

  const name = `Funnel Remind ${TAG}`;
  const email = `delivered+e2e-funnel-remind-${TAG}@resend.dev`;
  const started = await request.post("/api/funnel/start", {
    data: { email, locale: "fr", name, sport: "Badminton", entrants: 8 },
  });
  expect(started.status(), "the start stores the draft").toBe(200);

  const draftId = await withDb(async (sql) => {
    const [draft] = await sql<{ id: string; locale: string | null }[]>`
      select id, locale from funnel_drafts where email = ${email} order by created_at desc limit 1`;
    expect(draft, `the start stored no draft for ${email}`).toBeTruthy();
    expect(draft!.locale, "premise: the draft remembers the language the start named").toBe("fr");
    await sql`update funnel_drafts set created_at = now() - interval '25 hours' where id = ${draft!.id}`;
    return draft!.id;
  });

  const reminders = () =>
    withDb((sql) =>
      sql<
        { status: string; transactional: boolean; recipient: string; recipient_user_id: string | null; subject: string }[]
      >`
        select status, transactional, recipient, recipient_user_id, subject
          from email_outbox
         where kind = 'funnel_reminder' and ref_type = 'funnel_draft' and ref_id = ${draftId}`,
    );
  const remind = () => request.post("/api/funnel/remind", { headers: { "x-cron-secret": cronSecret! } });

  const first = await remind();
  expect(first.status(), "the cron route runs with the job's secret").toBe(200);
  const firstBody = (await first.json()) as { data?: { sent?: number } };
  expect(firstBody.data?.sent ?? 0, "the run queued at least this draft's reminder").toBeGreaterThanOrEqual(1);
  const rows = await reminders();
  expect(rows, "one funnel_reminder row for the draft").toHaveLength(1);
  expect(rows[0]).toEqual({
    status: "queued",
    transactional: true,
    recipient: email,
    recipient_user_id: null,
    subject: frSubject.replaceAll("{competitionName}", name),
  });

  // The draft is stamped: a second run (the next cron tick, or a second scheduler) adds nothing.
  const second = await remind();
  expect(second.status(), "a second cron run answers 200").toBe(200);
  expect(await reminders(), "a second run queues no second reminder").toHaveLength(1);
});
