// Shared rig for the player payment page specs (plan 2026-11-11-player-payment-page, Tasks 4-7): a Pro org with Connect on, one
// card-paid division, a pending entry due inside the sweep's T-24h window, the real sweep, and the pay link read out of its mail.
// It lives beside helpers.ts, not in e2e/walkthrough/ (Playwright selects that directory by path, and a spec may not import a spec).
import { expect, type Browser, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { apiJson, TAG, withDb } from "./helpers";
import { signInAs } from "./overlay-kit";
import { latestOutboxBody, payLinkFrom } from "./outbox-body-open";

export const WIDTHS = [320, 768, 1280] as const;
export const FEE = 1500;
export const INSTRUCTIONS = "Bank transfer to Riverside CC, quoting your reference";

export type Rig = { orgId: string; orgSlug: string; compSlug: string; owner: Page; competitionId: string; divisionId: string; compName: string; divName: string };

/** A fresh Pro org with Connect on (a test account id: the sweep's reminder needs charges enabled, nothing here calls Stripe), its
 *  owner signed in on a page of its own, and one card-paid division. */
export async function seedRig(browser: Browser): Promise<Rig> {
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
  const comp = await apiJson<{ id: string; slug: string }>(owner.request, "/api/v1/competitions", "POST", {
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
  return { orgId, orgSlug: `paypage-${tag}`, compSlug: comp.data!.slug, owner, competitionId: comp.data!.id, divisionId: div.data!.id, compName, divName };
}

/** The organiser's own settings write (the real API): the page reads the division's method at view time. */
export async function putSettings(owner: Page, divisionId: string, method: "stripe" | "offline"): Promise<void> {
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
export async function seedDueEntry(rig: Rig, name: string): Promise<{ regId: string; refCode: string }> {
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
export async function sweepAndOpenLink(page: Page, regId: string): Promise<string> {
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

export const escapeRe = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const tokensFor = (regId: string) =>
  withDb(async (sql) => Number((await sql<{ n: string }[]>`select count(*)::text as n from registration_pay_tokens where registration_id = ${regId}`)[0]!.n));

export async function noHorizontalScroll(page: Page, label: string): Promise<void> {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(m.sw, `${label}: scrollWidth ${m.sw} <= innerWidth ${m.iw}`).toBeLessThanOrEqual(m.iw);
}

