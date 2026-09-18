// Idempotent Stripe Connect fixture for the registration entry-fee card path
// (RS006). `createRegistrationCheckout` (apps/web/src/server/usecases/
// registrations.ts) mints a DESTINATION charge — payment_intent_data.
// transfer_data.destination = organizations.stripe_account_id — and Stripe
// rejects a destination that is not a real connected account with an ACTIVE
// transfers capability. Locally (and in CI unless a secret is supplied) no
// such account exists: every division is payment_method: 'offline' and the
// org's stripe_account_id is null, so the card path has never actually run.
// This script gets you a real one to point at.
//
// Usage (matches stripe:sync's invocation shape exactly):
//   npm run stripe:connect-fixture
//   node --env-file-if-exists=apps/web/.env.local --experimental-strip-types \
//     scripts/stripe-connect-fixture.ts
//
// ── What this script can and cannot do ──────────────────────────────────────
// It CAN create the Express account (the API half of onboarding) and verify
// an existing one is still healthy. It CANNOT get a fresh account to
// charges_enabled: true by itself, in test mode or otherwise, and does not
// try to fake it.
//
// Why: Express means Stripe-hosted Dashboard access — under Accounts v2 that
// is the `dashboard: "express"` property rather than v1's `type: "express"`,
// but it is the same access and the same consequence. Stripe's own docs
// (docs.stripe.com/connect/updating-service-agreements) say API-driven
// service-agreement acceptance and identity-verification submission is
// available only "for accounts with no Stripe-hosted Dashboard access,
// including Custom accounts" — Express accounts are explicitly outside that
// set. The Terms-of-Service acceptance an Express account needs can only
// happen through Stripe's own hosted onboarding UI (account_onboarding
// AccountLink), never via the platform submitting tos_acceptance on its
// behalf through the API. This repo already reached the same conclusion
// independently, for the analogous sponsor-Connect checkout fixture:
// scripts/smoke.ts's setConnect() doc comment says plainly "Express
// onboarding can't run headless; ... a fresh Express account has
// charges_enabled: false until a human finishes onboarding" — this script
// does not change that, it just gives that one-time onboarding a real
// account to run against, in test mode (Stripe's hosted form there accepts
// valid-shaped test data — a test SSN, a test bank account, a test
// address — never real PII: docs.stripe.com/connect/testing).
//
// Once that one-time onboarding is done, the resulting acct_… id is durable:
// set STRIPE_CONNECT_TEST_ACCOUNT to it and every future run of this script
// (or of scripts/smoke.ts, which reads the same variable for the analogous
// sponsor-checkout fixture) just verifies it and exits, doing nothing.
//
// Not imported from apps/web/src/server/usecases/stripe-connect.ts, even
// though createConnectOnboardingLink's account create is what
// createFixtureAccount below stands in for: that file starts with `import
// "server-only"` and reaches `@/lib/db` etc. through the app's `@/` alias,
// which tsconfig.scripts.json maps for type-checking but plain
// `node --experimental-strip-types` cannot resolve at RUNTIME (nodenext
// resolution needs every specifier to carry an explicit extension; `@/lib/db`
// has none — the same reason stripe-sync.ts re-declares REQUIRED_CURRENCIES
// as a literal instead of importing lib/currency.ts, and openapi-gen.ts
// reaches into apps/web/src only via relative, extension-carrying paths).
// The create below is therefore hand-written, but it DOES mirror production
// field for field — Accounts v2, both capability halves, both responsibility
// collectors — so the fixture exercises the account users actually get. The
// one literal that had to be copied rather than imported, the account country,
// is held to production's by a drift test; see FIXTURE_ACCOUNT_COUNTRY.
import { fileURLToPath } from "node:url";
import Stripe from "stripe";

/** Build the pinned Stripe client, or exit 1 for a missing/live key. Kept out
 *  of module scope — unlike an earlier version of this file — so importing
 *  this module for its pure helpers (isHealthy, reportNotReady) never reads
 *  env vars or constructs a real client as a side effect. Mirrors
 *  stripe-sync.ts's own shape: only main() touches the network or the key. */
function requireTestStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error("STRIPE_SECRET_KEY is not set.");
    process.exit(1);
  }
  // Refuse live, unconditionally. This script creates and inspects Connect
  // fixtures for local/CI testing; it must never run against a live key, no
  // matter what STRIPE_CONNECT_TEST_ACCOUNT is set to. Same "_test_" substring
  // stripe-sync.ts uses to LOG the mode — here it is a hard gate, not a log line.
  if (!key.includes("_test_")) {
    console.error(
      'STRIPE_SECRET_KEY does not look like a test-mode key (no "_test_" substring). ' +
        "Refusing to run — this is a fixture script and must never touch a live account.",
    );
    process.exit(1);
  }
  console.log("Stripe mode: TEST");
  return new Stripe(key, {
    // Pinned — matches apps/web/src/lib/stripe.ts's getStripe(). An unpinned
    // client would follow whatever version the account defaults to and could
    // silently see a different Account/Capability shape than the app does.
    apiVersion: "2026-06-24.dahlia",
    timeout: 10_000,
    maxNetworkRetries: 0,
  });
}

/** ISO 3166-1 alpha-2 country the fixture account is created with.
 *
 *  HAND-MIRRORED from `CONNECT_ACCOUNT_DEFAULT_COUNTRY` in
 *  apps/web/src/server/usecases/stripe-connect.ts, for the same reason
 *  stripe-sync.ts re-declares REQUIRED_CURRENCIES instead of importing
 *  lib/currency.ts: this file runs under plain `node
 *  --experimental-strip-types`, which resolves neither `server-only` nor the
 *  `@/` alias (see the header). The copy is not left to trust —
 *  apps/web/src/__tests__/stripe-connect-fixture-drift.test.ts imports BOTH
 *  and fails if they ever diverge. */
export const FIXTURE_ACCOUNT_COUNTRY = "GB";

/** Create the fixture account the same way production creates a real one.
 *
 *  Mirrors `createConnectOnboardingLink`'s `stripe.v2.core.accounts.create`
 *  (apps/web/src/server/usecases/stripe-connect.ts — the call sits under the
 *  `if (!accountId)` branch; search for `v2.core.accounts.create` rather than
 *  trusting a line number). Every field production sends is sent here too,
 *  with exactly two deliberate differences:
 *
 *    - NO `org_id` in the metadata. This account belongs to no organization;
 *      a stray org_id would make it look like a real club's. The `fixture` and
 *      `created_at` keys stay, so the account is identifiable in the Dashboard.
 *    - The two IDENTITY fields — `contact_email` and `display_name` — are
 *      fixture constants rather than the owner's email and the org's name,
 *      because there is no org or owner here to read them from. Both are still
 *      SENT: v2 REQUIRES `contact_email` whenever `configuration.recipient` is
 *      supplied, and production sends `display_name` for every org whose name
 *      is non-blank — essentially always — so omitting it would leave the
 *      fixture a different shape from the accounts users get. Non-empty on
 *      purpose: `display_name: ""` is a 400, which is the trap production's
 *      own conditional exists to avoid.
 *
 *  Why the create is followed by a v1 retrieve: `v2.core.accounts.create`
 *  answers a V2 Account, which carries none of `charges_enabled`,
 *  `payouts_enabled` or `capabilities` — the fields `isHealthy` and
 *  `reportNotReady` below are written against. Reading the new account back
 *  through `/v1/accounts` returns the V1-interop view that the rest of this
 *  script (and `syncConnectAccount` in the app) already speaks.
 *  connect-accounts-v2.live.test.ts settled against the live test API that
 *  this view really does carry `capabilities.transfers` for a v2 account,
 *  which is what made this migration safe to make. */
export async function createFixtureAccount(stripe: Stripe): Promise<Stripe.Account> {
  const created = await stripe.v2.core.accounts.create({
    dashboard: "express",
    contact_email: "stripe-connect-fixture@seazn.test",
    display_name: "Seazn Connect Fixture",
    identity: { country: FIXTURE_ACCOUNT_COUNTRY },
    configuration: {
      // BOTH halves — exact parity with the v1 `card_payments` + `transfers`
      // this replaced. A recipient-only account can take transfers but may
      // never light `charges_enabled`, and `charges_enabled` is half of what
      // isHealthy gates on (and all of what the app's own checkout gate reads).
      merchant: { capabilities: { card_payments: { requested: true } } },
      recipient: {
        capabilities: { stripe_balance: { stripe_transfers: { requested: true } } },
      },
    },
    defaults: {
      responsibilities: { fees_collector: "application", losses_collector: "application" },
    },
    metadata: {
      fixture: "scripts/stripe-connect-fixture.ts",
      created_at: new Date().toISOString(),
    },
  });
  return stripe.accounts.retrieve(created.id);
}

/** Healthy = still exists AND can actually carry the registration checkout
 *  path: `transfers` capability active is what a destination charge's
 *  `transfer_data.destination` needs (dispatch context: "Stripe rejects a
 *  destination that isn't a real connected account with transfers active"),
 *  and `charges_enabled` is what the APP's own gate reads — mintGroupCheckout
 *  throws 503 unless ctx.charges_enabled, which syncConnectAccount mirrors
 *  1:1 from this same field. Either being false means "not ready" — treated
 *  the same as unset below. */
export function isHealthy(account: Stripe.Account): boolean {
  return account.charges_enabled === true && account.capabilities?.transfers === "active";
}

/** Best-effort convenience: a directly-clickable onboarding link for the
 *  fresh/stale account, so the one-time manual step doesn't require first
 *  wiring the account onto an org in the app. Never fatal — if minting fails
 *  (e.g. no network), the account id printed above is still enough to
 *  proceed by hand from the Stripe Dashboard. */
async function tryMintOnboardingLink(stripe: Stripe, accountId: string): Promise<string | null> {
  const origin = process.env.SMOKE_BASE ?? process.env.E2E_PROD_TARGET ?? "http://localhost:3000";
  try {
    const link = await stripe.accountLinks.create({
      account: accountId,
      type: "account_onboarding",
      refresh_url: `${origin}/settings/connect?connect=refresh`,
      return_url: `${origin}/settings/connect?connect=return`,
    });
    return link.url;
  } catch {
    return null;
  }
}

function reportNotReady(account: Stripe.Account, link: string | null): void {
  console.log("");
  console.log(`Account: ${account.id}`);
  console.log(
    `  charges_enabled=${account.charges_enabled}  ` +
      `transfers=${account.capabilities?.transfers ?? "unrequested"}`,
  );
  console.log("");
  console.log(
    "This account cannot reach charges_enabled: true through the API alone — an Express",
  );
  console.log(
    "account's Terms-of-Service acceptance can only happen through Stripe's own hosted",
  );
  console.log("onboarding UI (see the file header for why). One-time steps:");
  console.log("");
  console.log("  1. Finish onboarding in test mode (valid-shaped fake data is fine — a test");
  console.log("     SSN, test bank account, test address: docs.stripe.com/connect/testing):");
  console.log(link ? `       ${link}` : "       (link mint failed — use the Dashboard instead)");
  console.log(`       https://dashboard.stripe.com/test/connect/accounts/${account.id}`);
  console.log("  2. Re-run this script once onboarding completes to confirm charges_enabled.");
  console.log("  3. Set the id it prints as STRIPE_CONNECT_TEST_ACCOUNT:");
  console.log("       - Locally: apps/web/.env.local (root .env.local; apps/web's is a symlink)");
  console.log("       - CI: a GitHub Actions secret named STRIPE_CONNECT_TEST_ACCOUNT");
  console.log("");
  console.log(`  ${account.id}`);
  console.log("");
}

/** Exit code, never a direct process.exit(0) on the success path — letting a
 *  clean run fall through to Node's natural exit avoids any risk of
 *  truncating not-yet-flushed stdout, which an explicit exit(0) right after
 *  a console.log can do. Only the non-success paths call process.exit. */
async function main(): Promise<number> {
  const stripe = requireTestStripe();
  const existingId = process.env.STRIPE_CONNECT_TEST_ACCOUNT;

  if (existingId) {
    let account: Stripe.Account;
    try {
      account = await stripe.accounts.retrieve(existingId);
    } catch (err) {
      console.log(
        `STRIPE_CONNECT_TEST_ACCOUNT=${existingId} could not be retrieved ` +
          `(${err instanceof Error ? err.message : String(err)}) — treating as stale.`,
      );
      const fresh = await createFixtureAccount(stripe);
      console.log(`Created a new fixture account: ${fresh.id}`);
      reportNotReady(fresh, await tryMintOnboardingLink(stripe, fresh.id));
      return 1;
    }
    if (isHealthy(account)) {
      console.log(`OK  ${account.id} is healthy (charges_enabled, transfers active). Nothing to do.`);
      return 0;
    }
    console.log(`${account.id} exists but is not chargeable yet — treating as stale.`);
    reportNotReady(account, await tryMintOnboardingLink(stripe, account.id));
    return 1;
  }

  console.log("STRIPE_CONNECT_TEST_ACCOUNT is not set — creating a fixture account.");
  const account = await createFixtureAccount(stripe);
  console.log(`Created: ${account.id}`);
  reportNotReady(account, await tryMintOnboardingLink(stripe, account.id));
  return 1;
}

// Only run when invoked as a script — mirrors stripe-sync.ts's own guard so
// a future test can import the pure helpers above without side effects.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const code = await main();
  if (code !== 0) process.exit(code);
}
