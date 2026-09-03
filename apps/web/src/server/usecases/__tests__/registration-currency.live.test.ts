// LIVE contract probe for the RS003 group checkout — NOT a unit test.
//
// The mocked matrix in registrations.test.ts already pins the ARITHMETIC for
// every member of REGISTRATION_CURRENCIES: line items, the summed total, the
// application fee over that sum, the destination account. What a mock cannot
// answer is whether STRIPE accepts the parameters we actually send — a
// destination charge in each allowlisted currency, with an application fee, to
// a real connected account. That is this file's only question.
//
// It drives the REAL `mintGroupCheckout` rather than assembling session params
// itself. A probe that built its own session would stay green even if our mint
// sent something Stripe rejects, which is precisely the failure worth catching.
//
// ── What this does and does NOT prove ───────────────────────────────────────
// Every connected test account on this platform settles in GBP, and owner
// ruling 10 pins an org's charge currency to its Connect account's settlement
// currency. So for anything but gbp this proves STRIPE ACCEPTS OUR PARAMETERS,
// not that the charge is reachable in production — INR in particular is
// offline/display-only on a GB platform (RS001b recorded that a GB→GB INR
// destination charge passes in test mode and is irrelevant). The mocked matrix
// is the arithmetic gate; this is the API-contract gate. Neither replaces the
// other.
//
// Skipped unless BILLING_LIVE=1 — vitest.config.ts deletes STRIPE_SECRET_KEY
// from the loaded env otherwise, so CI (which ships no .env.local) can never
// run this. Runs against Stripe TEST mode and expires every session it opens;
// no money moves. Run:
//
//   BILLING_LIVE=1 \
//   DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/<db> DATABASE_SSL=disable \
//     npx vitest run --testTimeout=30000 \
//       src/server/usecases/__tests__/registration-currency.live.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { sql } from "@/lib/db";
import { getStripe } from "@/lib/stripe";
import { REGISTRATION_CURRENCIES } from "@/lib/currency";
import { generateRefCode } from "@/lib/ref-code";
import { mintGroupCheckout } from "@/server/usecases/registrations";
import { asOwner, rig, seedOrg, seedRegistration, SETTINGS_BASE } from "./_registration-fixtures";

const LIVE = process.env.BILLING_LIVE === "1" && !!process.env.STRIPE_SECRET_KEY;
const HAS_DB = !!process.env.DATABASE_URL;
const RUN = LIVE && HAS_DB;

/** Sessions opened by this file, expired in afterAll so the test account keeps
 *  no live artifacts. */
const opened: string[] = [];
/** A real connected account with charges enabled, discovered at run time — the
 *  fixtures' fake `acct_<uuid>` ids would be rejected by Stripe. */
let connectedAccount: string | null = null;
/** ONE org for the whole file. `organizations_stripe_account_idx` is UNIQUE, so
 *  a connected account attaches to exactly ONE org — seeding an org per
 *  currency collides on the second (23505). The org's `currency` is rewritten
 *  per iteration instead, which is also closer to the real thing: one
 *  organiser changing their preferred currency. */
let orgCtx: { orgId: string; ownerId: string } | null = null;

beforeAll(async () => {
  if (!RUN) return;
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  // Refuse to touch a live key. Never print the key itself.
  expect(key.startsWith("sk_test"), "refusing to run against a non-test key").toBe(true);
  const accounts = await getStripe().accounts.list({ limit: 10 });
  connectedAccount = accounts.data.find((a) => a.charges_enabled)?.id ?? null;
  expect(
    connectedAccount,
    "no connected test account with charges_enabled — create one before running this probe",
  ).toBeTruthy();
  // Detach the account from any org a PREVIOUS run of this probe left it on:
  // the unique index makes the probe non-rerunnable otherwise, and a test that
  // only passes on a virgin database is a test nobody will run twice.
  await sql`update organizations set stripe_account_id = null where stripe_account_id = ${connectedAccount}`;
  const { orgId, ownerId } = await seedOrg();
  await sql`
    update organizations
    set stripe_account_id = ${connectedAccount}, stripe_charges_enabled = true
    where id = ${orgId}`;
  orgCtx = { orgId, ownerId };
}, 30_000);

afterAll(async () => {
  if (RUN) {
    for (const id of opened) {
      // Best-effort: an already-expired session is not a failure.
      await getStripe().checkout.sessions.expire(id).catch(() => undefined);
    }
  }
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
}, 30_000);

/**
 * Entry fees in MINOR units, sized so the cart clears Stripe's minimum charge
 * once converted to the platform's currency (~30p on this GB platform).
 * 500+700 is £12.00 in gbp but ₹12.00 in inr — about 9p — and Stripe refuses
 * the session outright. That refusal is real and worth knowing about (it is
 * now translated to a clean 422, see `mintOrTranslate`), but it is not what
 * THIS probe is asking: the question here is whether Stripe accepts a
 * destination charge in each currency at a sane fee.
 */
const FEES: Record<string, [number, number]> = {
  usd: [500, 700],
  eur: [500, 700],
  gbp: [500, 700],
  inr: [30000, 50000], // ₹300 + ₹500
};

describe.skipIf(!RUN)("group checkout — live per-currency destination charge", () => {
  // Driven off the CONSTANT, so adding a currency without running this probe
  // leaves it uncovered rather than silently passing.
  it.each(REGISTRATION_CURRENCIES)(
    "%s: Stripe accepts a destination charge for a two-entry cart",
    async (currency) => {
      const { orgId, ownerId } = orgCtx!;
      await sql`update organizations set currency = ${currency} where id = ${orgId}`;
      const owner = asOwner(orgId, ownerId);
      const { competition, division } = await rig(owner);
      const [feeA, feeB] = FEES[currency] ?? [500, 700];
      await sql`
        insert into registration_settings
          (division_id, enabled, entrant_kind, fee_cents, payment_method, approval, allow_free_agents)
        values (${division.id}, true, 'individual', ${feeA}, 'stripe', 'auto', false)`;

      const seeded = await seedRegistration(
        competition.id,
        division.id,
        { ...SETTINGS_BASE, fee_cents: feeA, currency, payment_method: "stripe" },
        { refCode: generateRefCode(), displayName: `Live ${currency}` },
      );
      // A second payable entry on the same cart: the fee must be computed over
      // the SUM, and Stripe must accept multi-line-item destination charges.
      await sql`
        insert into registrations (group_id, division_id, display_name, status, amount_cents, answers)
        values (${seeded.registration.group_id}, ${division.id}, 'Live second', 'pending', ${feeB}, '{}'::jsonb)`;

      const url = await mintGroupCheckout(
        seeded.registration.group_id,
        division.id,
        "https://live-probe.test",
        seeded.access_token,
      );
      expect(url, "Stripe returned no checkout url").toBeTruthy();
      expect(url).toContain("checkout.stripe.com");

      // Read the session BACK from Stripe — the url alone does not prove what
      // was quoted. This is the assertion a mock cannot make.
      const [row] = await sql<{ checkout_session_id: string | null }[]>`
        select checkout_session_id from registration_groups where id = ${seeded.registration.group_id}`;
      expect(row?.checkout_session_id).toBeTruthy();
      opened.push(row!.checkout_session_id!);

      const session = await getStripe().checkout.sessions.retrieve(row!.checkout_session_id!, {
        expand: ["line_items"],
      });
      expect(session.currency).toBe(currency);
      expect(session.amount_total).toBe(feeA + feeB);
      expect(session.line_items?.data).toHaveLength(2);
      expect(session.metadata?.kind).toBe("registration_group");
      expect(session.metadata?.registration_group_id).toBe(seeded.registration.group_id);
    },
    30_000,
  );

  it("a currency outside the allowlist never reaches Stripe", async () => {
    const { orgId, ownerId } = orgCtx!;
    await sql`update organizations set currency = ${"gbp"} where id = ${orgId}`;
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await sql`
      insert into registration_settings
        (division_id, enabled, entrant_kind, fee_cents, payment_method, approval, allow_free_agents)
      values (${division.id}, true, 'individual', 500, 'stripe', 'auto', false)`;
    const seeded = await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode: generateRefCode() },
    );
    // The group column deliberately carries NO allowlist CHECK (RS001b: a
    // snapshot is a historical fact), so a delisted currency can genuinely sit
    // here — which is exactly why the mint validates before calling Stripe.
    await sql`update registration_groups set currency = ${"jpy"} where id = ${seeded.registration.group_id}`;

    const before = opened.length;
    await expect(
      mintGroupCheckout(
        seeded.registration.group_id,
        division.id,
        "https://live-probe.test",
        seeded.access_token,
      ),
    ).rejects.toMatchObject({ status: 422, code: "REGISTRATION_CURRENCY_UNAVAILABLE" });
    // Nothing was minted, so nothing needs expiring.
    expect(opened.length).toBe(before);
    const [row] = await sql<{ checkout_session_id: string | null }[]>`
      select checkout_session_id from registration_groups where id = ${seeded.registration.group_id}`;
    expect(row?.checkout_session_id).toBeNull();
  }, 30_000);
});
