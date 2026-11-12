// Player payment page (plan 2026-11-11-player-payment-page, Tasks 4 and 5): the page a chase mail links, `/r/pay/<token>`, driven
// in a browser against a prod build. The token is never hand-made: a REAL producer issues it into a REAL mail, and the runner opens
// that mail's sealed body (e2e/outbox-body-open.ts) and follows its link, as the registrant would.
//
// Which producer: the sweep's T-24h reminder (`POST /api/cron/registrations`), because it is the one whose first attempt is the
// WORKER's - its row still holds its sealed body when the runner reads it. The organiser's reminder (`POST
// /api/v1/registrations/:id/remind`) attempts at once, and with no Resend key (CI, local) that attempt ends the row `dead` and drops
// its body, so its link cannot be read back; the spec still drives it and proves it queued a mail and issued a token.
//
// Needs, in BOTH the server's and this runner's env: EMAIL_OUTBOX_KEK (same value; without it bodies are not sealed) and
// CRON_SECRET (same value). e2e.yml sets both job-level.
//
// Widths: 320, 768 and 1280 (the page is public, so the full bar), with no horizontal page scroll at any of them.
import { test, expect, type Browser, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apiJson, TAG, withDb } from "./helpers";
import { signInAs } from "./overlay-kit";
import { latestOutboxBody, payLinkFrom } from "./outbox-body-open";

const enUi = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;

const WIDTHS = [320, 768, 1280] as const;
const FEE = 1500;
const INSTRUCTIONS = "Bank transfer to Riverside CC, quoting your reference";

type Rig = { orgId: string; owner: Page; competitionId: string; divisionId: string; compName: string; divName: string };

/** A fresh Pro org with Connect on (a test account id: the sweep's reminder needs charges enabled, nothing here calls Stripe), its
 *  owner signed in on a page of its own, and one card-paid division. */
async function seedRig(browser: Browser): Promise<Rig> {
  const tag = `${TAG}-${randomBytes(4).toString("hex")}`;
  const email = `delivered+paypage-${tag}@resend.dev`;
  const orgId = await withDb(async (sql) => {
    const [{ id: uid }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified) values (${email}, ${"Pay Page Owner " + tag}, true) returning id`;
    const [{ id: org }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by, currency, stripe_charges_enabled, stripe_account_id)
      values (${"Pay Page Club " + tag}, ${`paypage-${tag}`}, 'active', ${uid}, 'gbp', true, ${`acct_e2e_${tag}`}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${org}, ${uid}, 'owner')`;
    const [{ id: subId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status) values (${uid}, 'pro', 'active') returning id`;
    await sql`update organizations set subscription_id = ${subId} where id = ${org}`;
    return org;
  });
  const owner = await (await browser.newContext()).newPage();
  await signInAs(owner, email);
  const compName = `Pay Page Cup ${tag}`;
  const divName = `Open ${tag.slice(-4)}`;
  const comp = await apiJson<{ id: string }>(owner.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: compName,
    visibility: "public",
  });
  expect(comp.status, JSON.stringify(comp.error)).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(owner.request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: divName,
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  expect(div.status, JSON.stringify(div.error)).toBeLessThan(300);
  await putSettings(owner, div.data!.id, "stripe");
  return { orgId, owner, competitionId: comp.data!.id, divisionId: div.data!.id, compName, divName };
}

/** The organiser's own settings write (the real API): the page reads the division's method at view time. */
async function putSettings(owner: Page, divisionId: string, method: "stripe" | "offline"): Promise<void> {
  const res = await apiJson(owner.request, `/api/v1/divisions/${divisionId}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    opens_at: null,
    closes_at: null,
    capacity: null,
    refund_lock_at: null,
    form_fields: [],
    fee_cents: FEE,
    payment_method: method,
    payment_instructions: method === "offline" ? INSTRUCTIONS : null,
    approval: "auto",
  });
  expect(res.status, JSON.stringify(res.error)).toBeLessThan(300);
}

/** A pending card entry whose cart is due within the sweep's T-24h window. */
async function seedDueEntry(rig: Rig, name: string): Promise<{ regId: string; refCode: string }> {
  const refCode = `PP${randomBytes(3).toString("hex").toUpperCase()}`;
  return withDb(async (sql) => {
    const [g] = await sql<{ id: string }[]>`
      insert into registration_groups
        (competition_id, contact_name, contact_email, access_token_hash, amount_cents, currency, payment_method, expires_at,
         locale, ref_code, privacy_consent_at, privacy_consent_version)
      values (${rig.competitionId}, ${name}, ${`delivered+paypage-entry-${randomBytes(4).toString("hex")}@resend.dev`},
              ${randomBytes(32).toString("hex")}, ${FEE}, 'gbp', 'stripe', now() + interval '10 hours', 'en', ${refCode},
              now(), 'e2e')
      returning id`;
    const [r] = await sql<{ id: string }[]>`
      insert into registrations (group_id, division_id, display_name, status, amount_cents)
      values (${g!.id}, ${rig.divisionId}, ${name}, 'pending', ${FEE}) returning id`;
    return { regId: r!.id, refCode };
  });
}

/** Run the real sweep, then read the entry's reminder out of the outbox and return its pay-page path. */
async function sweepAndOpenLink(page: Page, regId: string): Promise<string> {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) throw new Error("CRON_SECRET is required (the same value the server under test runs with)");
  const sweep = await page.request.fetch("/api/cron/registrations", { method: "POST", headers: { "x-cron-secret": cronSecret } });
  expect(sweep.status(), "the registrations sweep call failed").toBeLessThan(300);
  const body = await latestOutboxBody("payment_reminder", "registration", regId);
  for (const part of [body.html, body.text]) {
    expect(part, "the mail carries no Checkout url").not.toContain("checkout.stripe.com");
    expect(part).not.toContain("cs_test_");
  }
  const link = payLinkFrom(body.html);
  expect(body.text, "the text part carries the same link").toContain(link);
  return new URL(link).pathname;
}

const tokensFor = (regId: string) =>
  withDb(async (sql) => Number((await sql<{ n: string }[]>`select count(*)::text as n from registration_pay_tokens where registration_id = ${regId}`)[0]!.n));

async function noHorizontalScroll(page: Page, label: string): Promise<void> {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(m.sw, `${label}: scrollWidth ${m.sw} <= innerWidth ${m.iw}`).toBeLessThanOrEqual(m.iw);
}

test.describe("player payment page", () => {
  test("offline entry shows instructions and no Pay", async ({ browser }) => {
    test.setTimeout(150_000);
    const rig = await seedRig(browser);
    const entry = await seedDueEntry(rig, `Offline Entrant ${TAG}`);
    const path = await sweepAndOpenLink(rig.owner, entry.regId);
    expect(await tokensFor(entry.regId), "the sweep's reminder issued one token").toBe(1);

    // The organiser switches the division to offline after the mail went out: the page reads the method at view time.
    await putSettings(rig.owner, rig.divisionId, "offline");

    const visitor = await (await browser.newContext()).newPage();
    let checked = 0;
    for (const width of WIDTHS) {
      await visitor.setViewportSize({ width, height: 900 });
      const res = await visitor.goto(path);
      expect(res?.status(), `${width}: the page answers 200`).toBe(200);
      await expect(visitor.getByTestId("pay-page")).toBeVisible();
      await expect(visitor.getByTestId("pay-offline"), `${width}: the offline panel`).toBeVisible();
      await expect(visitor.getByTestId("pay-offline")).toContainText(INSTRUCTIONS);
      await expect(visitor.getByTestId("pay-offline")).toContainText(entry.refCode);
      await expect(visitor.getByTestId("pay-form"), `${width}: no Pay form`).toHaveCount(0);
      await expect(visitor.getByTestId("pay-page")).toContainText(rig.compName);
      await expect(visitor.getByTestId("pay-page")).toContainText(rig.divName);
      await noHorizontalScroll(visitor, `offline @${width}`);
      checked += 1;
    }
    expect(checked).toBe(WIDTHS.length);

    // The organiser's own reminder, through the real API, now for an offline entry: it answers, queues one mail and issues one
    // more token. (Its body is attempted at once and so is not readable here - see the header.)
    const remind = await apiJson<{ sent: boolean }>(rig.owner.request, `/api/v1/registrations/${entry.regId}/remind`, "POST");
    expect(remind.status, JSON.stringify(remind.error)).toBe(200);
    expect(await tokensFor(entry.regId), "the organiser's reminder issued a token of its own").toBe(2);
    const manual = await withDb((sql) => sql<{ n: string }[]>`
      select count(*)::text as n from email_outbox
       where kind = 'payment_reminder' and ref_type = 'registration' and ref_id = ${entry.regId} and dedupe_key is null`);
    expect(Number(manual[0]!.n), "one organiser reminder row").toBe(1);
    // Every token for an entry stays valid: the sweep's link still opens the page.
    await visitor.setViewportSize({ width: 1280, height: 900 });
    await visitor.goto(path);
    await expect(visitor.getByTestId("pay-offline")).toBeVisible();
  });

  test("unknown token is the opaque 404", async ({ browser }) => {
    test.setTimeout(150_000);
    const rig = await seedRig(browser);
    const entry = await seedDueEntry(rig, `Withdrawn Entrant ${TAG}`);
    const realPath = await sweepAndOpenLink(rig.owner, entry.regId);
    // The positive pair: the real token opens the page before the entry is withdrawn.
    const visitor = await (await browser.newContext()).newPage();
    await visitor.goto(realPath);
    await expect(visitor.getByTestId("pay-form")).toBeVisible();

    const withdraw = await apiJson(rig.owner.request, `/api/v1/registrations/${entry.regId}/withdraw`, "POST");
    expect(withdraw.status, JSON.stringify(withdraw.error)).toBeLessThan(300);

    const unknownPath = `/r/pay/${randomBytes(32).toString("base64url")}`;
    const title = enUi["regPay.notFound.title"]!;
    const bodyCopy = enUi["regPay.notFound.body"]!;
    let checked = 0;
    for (const width of WIDTHS) {
      await visitor.setViewportSize({ width, height: 900 });
      const texts: string[] = [];
      for (const [label, path] of [["unknown", unknownPath], ["withdrawn", realPath]] as const) {
        const res = await visitor.goto(path);
        expect(res?.status(), `${label} @${width}: 404`).toBe(404);
        const notFound = visitor.getByTestId("pay-not-found");
        await expect(notFound, `${label} @${width}: the one not-found`).toBeVisible();
        await expect(notFound).toContainText(title);
        await expect(notFound).toContainText(bodyCopy);
        await expect(visitor.getByTestId("pay-page")).toHaveCount(0);
        await expect(visitor.getByTestId("pay-form")).toHaveCount(0);
        await noHorizontalScroll(visitor, `${label} @${width}`);
        texts.push(await notFound.innerText());
        checked += 1;
      }
      expect(texts[1], `@${width}: a withdrawn entry's real token reads exactly as an unknown one`).toBe(texts[0]);
    }
    expect(checked).toBe(WIDTHS.length * 2);
  });
});
