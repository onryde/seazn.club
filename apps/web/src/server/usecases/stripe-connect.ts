import "server-only";
// Stripe Connect Express onboarding (doc 16 §1.1, PROMPT-20a): an org connects
// a Stripe account with the EXPRESS DASHBOARD so entry fees settle to the CLUB,
// with the platform taking an application fee % (second revenue line). Only the
// onboarding state lives here; entry-fee checkout is in registrations.ts.
//
// Accounts are created through ACCOUNTS V2 (`stripe.v2.core.accounts`); every
// other Stripe path in this file — and in billing-events.ts, the webhook route
// and the destination charges in registrations.ts / sponsors.ts — stays on v1,
// which is not a half-migration but the documented interop: a v2 account id
// passed to `/v1/accounts` returns a v1-shaped Account carrying every field
// `syncConnectAccount` reads, and v2 accounts still emit v1 `account.updated`.
// See `createConnectOnboardingLink` for the field-by-field reasoning.
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { isRegistrationCurrency } from "@/lib/currency";
import { HttpError } from "@/lib/errors";
import { log } from "@/server/logger";
import { requireFeature } from "@/lib/entitlements";
import { getStripe } from "@/lib/stripe";
import type { AuthCtx } from "@/server/api-v1/auth";

export interface ConnectStatusRow {
  connected: boolean;
  charges_enabled: boolean;
  details_submitted: boolean | null;
  // Connect health mirror (P1-8): a verification lapse freezes payouts while
  // charges keep landing. Surfaced as an owner attention banner so the club
  // resumes onboarding before Stripe support has to explain the frozen payout.
  payouts_enabled: boolean;
  disabled_reason: string | null;
  requirements_due: number;
  /** RS001b: the account's settlement currency when it is outside
   *  `REGISTRATION_CURRENCIES`, else null. Non-null means card registration is
   *  unavailable for this org — the same-currency rule forbids charging in
   *  anything but the settlement currency, and that one cannot be priced. */
  unsupported_currency: string | null;
}

/** Billing surface — owner-only, session-only (matches /api/billing/*). */
function requireOwnerSession(auth: AuthCtx, orgId: string): void {
  if (auth.orgId !== orgId) throw new HttpError(403, "Wrong organization");
  if (auth.via !== "session" || auth.role !== "owner") {
    throw new HttpError(403, "Only the org owner can manage Stripe Connect");
  }
}

interface OrgConnectCols {
  stripe_account_id: string | null;
  stripe_charges_enabled: boolean;
  stripe_payouts_enabled: boolean;
  stripe_disabled_reason: string | null;
  stripe_requirements_due: number;
  stripe_unsupported_currency: string | null;
}

async function orgConnect(orgId: string): Promise<OrgConnectCols> {
  const [row] = await sql<OrgConnectCols[]>`
    select stripe_account_id, stripe_charges_enabled,
           stripe_payouts_enabled, stripe_disabled_reason, stripe_requirements_due,
           stripe_unsupported_currency
    from organizations where id = ${orgId}`;
  if (!row) throw new HttpError(404, "organization not found");
  return row;
}

/**
 * Connect status; `refresh` re-reads the account from Stripe so the
 * return-from-onboarding page shows live state even before the
 * account.updated webhook lands (reconcile-on-return, billing.ts pattern).
 */
export async function connectStatus(
  auth: AuthCtx,
  orgId: string,
  refresh = false,
): Promise<ConnectStatusRow> {
  requireOwnerSession(auth, orgId);
  let row = await orgConnect(orgId);
  let detailsSubmitted: boolean | null = null;
  if (row.stripe_account_id && refresh) {
    try {
      const account = await getStripe().accounts.retrieve(row.stripe_account_id);
      detailsSubmitted = account.details_submitted ?? null;
      await syncConnectAccount(account);
      row = await orgConnect(orgId);
    } catch {
      // Best-effort refresh; stored state still answers.
    }
  }
  return {
    connected: row.stripe_account_id !== null,
    charges_enabled: row.stripe_charges_enabled,
    details_submitted: detailsSubmitted,
    payouts_enabled: row.stripe_payouts_enabled,
    disabled_reason: row.stripe_disabled_reason,
    requirements_due: row.stripe_requirements_due,
    unsupported_currency: row.stripe_unsupported_currency,
  };
}

/**
 * ISO 3166-1 alpha-2 country a connected account is CREATED with.
 *
 * Accounts v2 REQUIRES `identity.country` before `configuration.merchant` can
 * be set; the v1 call this replaced required nothing and let Stripe default the
 * account to the PLATFORM's country, with the club confirming its own inside
 * Stripe's hosted onboarding form. Defaulting here reproduces that exactly.
 *
 * Safe because the field is MUTABLE until onboarding completes — verified
 * against the live test API on 2026-09-18: a `gb` account was updated to `IE`,
 * and a cross-border create (an IE account from this GB platform) also
 * succeeded. So a club outside the platform country still onboards correctly;
 * Stripe collects and confirms the real country itself. A country PICKER is a
 * separate product decision and deliberately not built here.
 */
export const CONNECT_ACCOUNT_DEFAULT_COUNTRY = "GB";

/**
 * The one answer an owner gets when onboarding cannot start.
 *
 * EXPORTED so tests assert against this value rather than hand-mirroring the
 * sentence — three copies had already been typed out, which is the drift this
 * const exists to prevent. The client maps the 502 to `pay.onboardErr`, so the
 * English never reaches a screen: it is the STATUS that carries the meaning.
 *
 * That now holds for EVERY refusal below, not just this one:
 * org-payment-instructions.tsx picks translated copy per status and renders
 * none of these sentences. They are an operator- and log-facing record of
 * what went wrong, so keep them specific — the screen no longer depends on
 * their wording, and a vaguer one here would only cost a debugger.
 *
 * Every refusal `createConnectOnboardingLink` can reach, and why each is or is
 * not masked — the enumeration, so the next survivor is visible:
 *
 *   403 requireOwnerSession ×2 · 422 ToS gate
 *       Actionable: the client has a key each (`pay.connectOwnerOnly`,
 *       `pay.connectTosFirst`) saying the same thing in the reader's
 *       language. Do not collapse either into the generic — the 422 is the
 *       one refusal here an owner can clear unaided.
 *   404 orgConnect
 *       Not actionable to a human; the client lands it on `pay.onboardErr`.
 *   402 requireFeature (PaymentRequiredError)
 *       Has its own client key (`pay.needPro`), so it never renders raw.
 *   502 getStripe() · v2 accounts.create · accountLinks.create
 *       Masked by stripeOnboardingStep below.
 *   502 owner-email unreadable · created-account-unstorable
 *       Masked by hand, with the detail logged. Both used to be 500s, which
 *       the client renders verbatim.
 *
 * That is every `throw` on this path. `sql` can still reject with a driver
 * error, which `v1()` answers 500 with the driver's message — a pre-existing
 * hole shared with every use-case in this repo, not specific to Connect.
 */
export const ONBOARDING_FAILED = "Stripe couldn't start onboarding for this organization";

/**
 * Run one step of the onboarding flow that can fail outside our control,
 * masking the failure.
 *
 * Without this, `v1()`'s catch-all (server/api-v1/http.ts:245-247) puts
 * `err.message` straight into the response body and `startOnboarding()` in
 * org-payment-instructions.tsx renders it verbatim — so Stripe's raw text
 * ("You provided a malformed API Key 'sk_test_…' for account 'acct_…'") is
 * printed on a money screen, naming the PLATFORM key and account id.
 *
 * `getStripe()` goes INSIDE this guard, exactly as it does inside
 * `createConnectDashboardLink`'s try below. Client construction throws a bare
 * Error naming STRIPE_SECRET_KEY when the key is missing (lib/stripe.ts:8-11),
 * and a bare Error is not an HttpError — so leaving it outside answered 500
 * with the env var's name in the body, and 500 is not a status the client
 * translates either. Hence `run` may be sync or async: so the call can be
 * passed straight in.
 *
 * Deliberately wraps only these steps, not the whole function body: the
 * refusals around them — the 422 ToS gate above all — are deliberate answers
 * whose copy tells the owner what to DO, and a catch-all over the lot would
 * relabel them, and a failing `sql` query, as "Stripe couldn't".
 */
async function stripeOnboardingStep<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    log.error({ err }, "createConnectOnboardingLink failed");
    throw new HttpError(502, ONBOARDING_FAILED);
  }
}

/**
 * Create (once) the connected account — Accounts v2, Express Dashboard — and
 * mint an onboarding link through Account Links v1. Gated on
 * `registration.paid`, which V310 (D19) made free on every plan — so the gate
 * now only stops an org a staff override has denied (abuse, chargeback risk).
 */
export async function createConnectOnboardingLink(
  auth: AuthCtx,
  orgId: string,
  origin: string,
  returnPath: string,
  tosAgreed = false,
): Promise<{ url: string }> {
  requireOwnerSession(auth, orgId);
  // Org-wide on purpose: Connect is org-level plumbing, one account for every
  // competition, so there is no competition to scope this to.
  //
  // This used to carry an "any Event Pass in the org unlocks it" escape hatch.
  // That is dead code twice over now. `registration.paid` is true on the
  // community matrix, so the plan row already satisfies the gate and the escape
  // never fires; and the only thing that can still deny it — an
  // org_entitlement_overrides row — BEATS a pass anyway (lib/entitlements.ts
  // folds the override over the pass with `ov.bool_value ?? base`, so a
  // non-null false short-circuits). Keeping it would have meant a staff deny
  // could be walked around by buying a $29 pass.
  await requireFeature(orgId, "registration.paid");

  let { stripe_account_id: accountId } = await orgConnect(orgId);
  // ToS gate (PROMPT-55): the org accepts the entry-fee chargeback clause
  // (lost disputes are recovered from its connected balance) BEFORE the
  // connected account exists. Resuming onboarding never re-asks; the
  // acceptance timestamp lives on the account metadata — no DB column.
  // Checked before getStripe() so the 422 answers even keyless.
  if (!accountId && !tosAgreed) {
    throw new HttpError(
      422,
      "Agree to the Terms of Service (entry-fee chargebacks) before connecting Stripe",
    );
  }
  const stripe = await stripeOnboardingStep(() => getStripe());
  if (!accountId) {
    // Two values Accounts v2 requires that v1 did not, and that nothing in
    // scope already holds: `AuthCtx` carries a userId but no email, and
    // `organizations` has no contact-email column. `requireOwnerSession` above
    // has already established that this session IS the org owner, so the
    // owner's `users.email` is the account's contact. One extra round trip,
    // only ever on an org's FIRST connect.
    const [profile] = await sql<{ org_name: string; owner_email: string | null }[]>`
      select o.name as org_name,
             (select email from users where id = ${auth.userId}) as owner_email
      from organizations o
      where o.id = ${orgId}`;
    if (!profile?.owner_email) {
      // Not a Stripe failure, but the same dead end for the owner: onboarding
      // cannot start and there is nothing they can do about it. Answered with
      // the SAME masked 502 rather than a 500 carrying its own sentence —
      // a 500 renders verbatim on the client, so this was a new English-only
      // string on a money screen. The actionable detail goes to the log,
      // where an operator can act on it.
      log.error(
        { org_id: orgId, user_id: auth.userId },
        "createConnectOnboardingLink: no owner email for contact_email",
      );
      throw new HttpError(502, ONBOARDING_FAILED);
    }
    // `organizations.name` is `text not null` with no non-empty CHECK, so a
    // blank name is reachable — and `display_name: ""` is a 400, while an
    // ABSENT display_name simply lets Stripe collect one during onboarding.
    const displayName = profile.org_name.trim();
    // Pinned for the same reason as `linkAccount` below: the guard above
    // narrows `owner_email` to a string, but TypeScript drops that narrowing
    // for a property read inside a callback.
    const contactEmail = profile.owner_email;
    const account = await stripeOnboardingStep(() =>
      stripe.v2.core.accounts.create({
        // The Express Dashboard, exactly as the v1 `type: "express"` account
        // had. Required whenever a merchant or recipient configuration is
        // present, and it is what keeps createConnectDashboardLink's v1 Login
        // Link path applicable instead of forcing an embedded-components build.
        dashboard: "express",
        contact_email: contactEmail,
        ...(displayName ? { display_name: displayName } : {}),
        identity: { country: CONNECT_ACCOUNT_DEFAULT_COUNTRY },
        configuration: {
          // BOTH halves, which is exact parity with v1's `card_payments` +
          // `transfers`. Dropping `merchant` is the trap: a recipient-only
          // account can receive transfers but may never light `charges_enabled`
          // — written in one place (syncConnectAccount, below) and read across
          // ~17 non-test sites that gate registration, sponsors and public data.
          merchant: { capabilities: { card_payments: { requested: true } } },
          recipient: {
            capabilities: { stripe_balance: { stripe_transfers: { requested: true } } },
          },
        },
        defaults: {
          // Deliberately NO `currency`: syncConnectAccount below handles a null
          // settlement currency on purpose (an account has none until Stripe
          // knows its country/bank), and the field does not follow a later
          // country change, so anything pinned here would go stale.
          //
          // Both collectors are `application` — not a new policy, a statement of
          // what destination charges already do: the platform pays Stripe's
          // processing fees and owns negative-balance liability (the recovery
          // path is dispute-recovery.ts, and the ToS gate above is the club
          // agreeing to it).
          responsibilities: { fees_collector: "application", losses_collector: "application" },
        },
        // Unchanged from v1, and load-bearing: the ToS acceptance timestamp
        // lives HERE, not in a DB column (see the gate above).
        metadata: { org_id: orgId, tos_agreed_at: new Date().toISOString() },
      }),
    );
    accountId = account.id;
    // First write wins: a concurrent onboarding click must not orphan an
    // account that Stripe already created for this org.
    const [claimed] = await sql<{ stripe_account_id: string }[]>`
      update organizations set stripe_account_id = ${accountId}
      where id = ${orgId} and stripe_account_id is null
      returning stripe_account_id`;
    if (!claimed) {
      ({ stripe_account_id: accountId } = await orgConnect(orgId));
      if (!accountId) {
        // Same masking as the two above: a 500 renders verbatim on the client
        // (only 402 and 502 are routed to the dictionary), and "Failed to
        // store the Connect account" means nothing to an owner anyway. The
        // account id is the part that matters — Stripe has one this org lost
        // the race to record — so it goes to the log, where it can be
        // reconciled by hand.
        log.error(
          { org_id: orgId, stripe_account_id: account.id },
          "createConnectOnboardingLink: created account could not be stored",
        );
        throw new HttpError(502, ONBOARDING_FAILED);
      }
    }
  }

  // Pinned to a const: `accountId` is a `let`, and TypeScript drops its
  // non-null narrowing inside a callback (the closure could run later).
  const linkAccount = accountId;
  const link = await stripeOnboardingStep(() =>
    stripe.accountLinks.create({
      account: linkAccount,
      type: "account_onboarding",
      refresh_url: `${origin}${returnPath}?connect=refresh`,
      return_url: `${origin}${returnPath}?connect=return`,
    }),
  );
  return { url: link.url };
}

/**
 * Mint a one-time Express Dashboard login link (payouts, charge history,
 * and Stripe's own "more information needed" prompts live there). Fresh per
 * click — the URLs are single-use and short-lived.
 */
/** Stripe's own Express login page (email/OTP) — works for every Express
 *  account with no API call; the fallback when login links can't be minted. */
const EXPRESS_LOGIN_URL = "https://connect.stripe.com/express_login";

export async function createConnectDashboardLink(
  auth: AuthCtx,
  orgId: string,
): Promise<{ url: string }> {
  requireOwnerSession(auth, orgId);
  const { stripe_account_id: accountId } = await orgConnect(orgId);
  // Checked before getStripe() so the 409 answers even keyless.
  if (!accountId) {
    throw new HttpError(409, "Connect Stripe first — this organization has no Stripe account");
  }
  try {
    const link = await getStripe().accounts.createLoginLink(accountId);
    return { url: link.url };
  } catch (err) {
    // Restricted (rk_) keys cannot mint login links at all — Stripe fences
    // the endpoint to full secret keys, it's not a grantable scope. Send the
    // owner to Stripe's own Express login page instead of failing.
    const type = (err as { type?: string }).type;
    const status = (err as { statusCode?: number }).statusCode;
    if (type === "StripePermissionError" || status === 403) {
      return { url: EXPRESS_LOGIN_URL };
    }
    // Anything else: log the detail, answer clean — Stripe's raw message
    // names the platform key and account id and must never reach a client.
    log.error({ err }, "createConnectDashboardLink failed");
    throw new HttpError(502, "Stripe couldn't create a dashboard link for this account");
  }
}

/**
 * Mirror Stripe's account flags (account.updated webhook + refresh path), and
 * enforce the SAME-CURRENCY RULE (owner ruling 2026-08-16, RS001b).
 *
 * A registration entry fee is a DESTINATION charge onto the club's connected
 * account, not the platform charging itself. The ruling: while an org is
 * connected, its charge currency always equals that account's settlement
 * currency, so no FX leg ever exists. This function is where that is enforced —
 * `organizations.currency` mirrors `account.default_currency` on EVERY sync,
 * overwriting any manual choice, so an org that changes its Stripe bank later
 * converges rather than quietly quoting in a currency it cannot settle. Free
 * choice from `REGISTRATION_CURRENCIES` is for UNCONNECTED (offline/display)
 * orgs only; RS004 greys the select accordingly.
 *
 * Groups already submitted keep the currency they snapshotted
 * (`registration_groups.currency`) — a lock convergence never rewrites what a
 * cart was charged.
 *
 * When the account settles in a currency the platform cannot price a
 * registration in, `organizations.currency` is left ALONE and the offending
 * code is recorded in `stripe_unsupported_currency` — a card-unsupported state
 * the settings UI reads (same storage/read shape as `stripe_disabled_reason`).
 * Writing the code into `currency` would violate the allowlist CHECK and abort
 * the whole sync transaction, taking the health-flag mirror down with it; and
 * charging in the org's own currency off a foreign-settling account is exactly
 * the FX leg the ruling forbids. So the failure surfaces at CONNECT time, never
 * on a registrant's pay page.
 */
export async function syncConnectAccount(account: Stripe.Account): Promise<void> {
  // Absent until Stripe knows the account's country/bank — an Express account
  // exists before onboarding completes, and there is nothing to lock to yet.
  const settlement = account.default_currency?.toLowerCase() ?? null;
  const supported = settlement !== null && isRegistrationCurrency(settlement);
  const [row] = await sql<{ id: string; currency: string }[]>`
    update organizations
    set stripe_charges_enabled  = ${account.charges_enabled === true},
        stripe_payouts_enabled  = ${account.payouts_enabled === true},
        stripe_disabled_reason  = ${account.requirements?.disabled_reason ?? null},
        stripe_requirements_due = ${account.requirements?.currently_due?.length ?? 0},
        currency = ${supported ? settlement : sql`currency`},
        -- An account that reports no settlement currency yet leaves BOTH
        -- columns alone. Clearing the card-unsupported state on "we don't
        -- know" would flip the settings UI to "card is fine" on absence of
        -- evidence, for a payment capability — the state only clears when a
        -- sync actually observes an allowlisted settlement currency.
        stripe_unsupported_currency = ${
          settlement === null
            ? sql`stripe_unsupported_currency`
            : supported
              ? null
              : settlement
        }
    where stripe_account_id = ${account.id}
    returning id, currency`;
  // No row: the account belongs to no org here (or the org disconnected). An
  // unconnected org's chosen currency is never touched by a sync.
  if (!row) return;
  if (supported) {
    log.info(
      { org_id: row.id, account_id: account.id, currency: settlement },
      "connect.currency_locked",
    );
  } else if (settlement !== null) {
    log.warn(
      { org_id: row.id, account_id: account.id, settlement_currency: settlement },
      "connect.currency_unsupported",
    );
  }
}
