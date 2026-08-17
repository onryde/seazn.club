import "server-only";
// Stripe Connect Express onboarding (doc 16 §1.1, PROMPT-20a): an org
// connects an Express account so entry fees settle to the CLUB, with the
// platform taking an application fee % (second revenue line). Only the
// onboarding state lives here; entry-fee checkout is in registrations.ts.
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
 * Create (once) the Express account and mint an onboarding link. Gated on
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
  // Express account exists. Resuming onboarding never re-asks; the
  // acceptance timestamp lives on the account metadata — no DB column.
  // Checked before getStripe() so the 422 answers even keyless.
  if (!accountId && !tosAgreed) {
    throw new HttpError(
      422,
      "Agree to the Terms of Service (entry-fee chargebacks) before connecting Stripe",
    );
  }
  const stripe = getStripe();
  if (!accountId) {
    const account = await stripe.accounts.create({
      type: "express",
      metadata: { org_id: orgId, tos_agreed_at: new Date().toISOString() },
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
    });
    accountId = account.id;
    // First write wins: a concurrent onboarding click must not orphan an
    // account that Stripe already created for this org.
    const [claimed] = await sql<{ stripe_account_id: string }[]>`
      update organizations set stripe_account_id = ${accountId}
      where id = ${orgId} and stripe_account_id is null
      returning stripe_account_id`;
    if (!claimed) {
      ({ stripe_account_id: accountId } = await orgConnect(orgId));
      if (!accountId) throw new HttpError(500, "Failed to store the Connect account");
    }
  }

  const link = await stripe.accountLinks.create({
    account: accountId,
    type: "account_onboarding",
    refresh_url: `${origin}${returnPath}?connect=refresh`,
    return_url: `${origin}${returnPath}?connect=return`,
  });
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
    console.error("createConnectDashboardLink failed", err);
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
