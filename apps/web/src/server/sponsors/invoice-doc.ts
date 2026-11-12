import "server-only";
// server/sponsors/invoice-doc.ts - sponsor invoices (plan 2026-11-07-sponsor-deals, Task 22; spec §7, F9): a deal's invoice as
// ONE document, read from the deal's own snapshot (D4) and its org, and drawn twice - the sponsor's page
// (`/r/sponsor/invoice/<token>`, components/sponsors/invoice-view.tsx) and its PDF (./invoice-pdf.ts) - plus the token that opens
// it.
//
// ONE AUTHORITY FOR "HAS AN INVOICE": the deal's `invoice_number` (D11, T20). createDeal numbers every online and offline deal,
// and this module mints a token only for a numbered deal and opens only a numbered one. The payment method alone proves nothing:
// a duplicate-payment row is online and unnumbered, and so is a deal made before invoices were numbered (review carry m6).
//
// THE TOKEN (F9): 32 random bytes, base64url (`mintReportToken`), stored only as its sha256 (`hashReportToken`) in
// `sponsor_orders.invoice_token_hash`. The raw token leaves only through `mintInvoiceToken`'s return value. createDeal mints it
// in its own transaction; every send mints a new one and mails it (Task 23: the earlier link stops opening). A complimentary deal
// has no number, so it never has one.
//
// THE DOCUMENT is in the ORG's language (`default_locale`): the club issues it, whoever opens it.
import { sql, withTenant, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { hasFeature } from "@/lib/entitlements";
import { getDictionary, t } from "@/lib/i18n";
import { toLocale, type Locale } from "@/lib/i18n-constants";
import {
  allowedActions,
  endedStillDue,
  formatInvoiceNumber,
  type DealActionFacts,
  type PaymentMethod,
  type SponsorDeal,
} from "@/lib/sponsor-deals";
import type { InvoiceState } from "@/lib/sponsor-invoice";
import type { SponsorTier } from "@/lib/sponsor-tiers";
import type { AuthCtx } from "@/server/api-v1/auth";
import { resolveLogoUrl } from "@/server/public-site/data";
import { readDeal, type ServerDeal } from "./deal-apply";
import { hashReportToken, mintReportToken } from "./report-token";

export type { InvoiceState };

/** A deal's invoice, as both its page and its PDF draw it. Every string is already in `locale`, the org's language. */
export interface SponsorInvoiceDoc {
  /** `SP-0001`: the org's own sequence (T20). */
  number: string;
  /** The day the invoice was issued - the deal's creation day, in the org's timezone - as `YYYY-MM-DD`. */
  issuedOn: string;
  /** The club that issues it. `logoPath` is an absolute URL, or null (no logo, or a plan without `branding`). */
  org: { name: string; address: string | null; logoPath: string | null };
  billedTo: { name: string; email: string | null };
  /** The one line: "<package> sponsorship — <scope or All competitions>", and the deal's snapshot price. */
  line: { description: string; amountCents: number; currency: string };
  /** What the sponsorship includes, from the deal's snapshot (spec §5.1; controller ruling 2026-11-11): its tier, its scope
   *  (a competition's name, or "All competitions"), and whether it is on the stream. Every sponsor shows on the public pages
   *  (§8a), so that line needs no field. */
  included: { tier: SponsorTier; scope: string; onStream: boolean };
  state: InvoiceState;
  /** The deal has ended. With `unpaid` it is an offline deal that ran live and ended unpaid: "ended, and still due". */
  dealEnded: boolean;
  method: PaymentMethod;
  /** How to pay by transfer: the club's bank details, on an OFFLINE invoice while it is still due (`unpaid`, including one whose
   *  deal ran live and then ended unpaid). Null on an online invoice (the settings card sets them "for offline invoices"; an
   *  online one is paid by card: T21 review carry), once it is paid, refunded, cancelled or ended with nothing claimed (a
   *  settled invoice does not invite a second transfer), or when the club has set none (null, "" and whitespace-only alike:
   *  `filled`). */
  bankDetails: string | null;
  /** The sponsor can pay this invoice by card now: `cardPayable`, AND the club can take cards (`clubTakesCards`) - the page
   *  never offers what the pay route would refuse (review m2). */
  payable: boolean;
  /** `cardPayable`, but the club cannot take cards now (its plan lost `sponsors.monetize`, or Connect stopped taking charges):
   *  the page says so and names the club to contact, instead of a button that cannot work. */
  cardUnavailable: boolean;
  locale: Locale;
}

/**
 * The invoice's state (lib/sponsor-invoice.ts INVOICE_STATES), from the deal's money first: `paid`, `refunded`; an unpaid deal
 * still running is `unpaid`. An unpaid deal that ENDED says what is true of how it ended (review I3), read from `ended_reason`:
 *  - `ended_now`: the club cancelled it - `void`, nothing is due;
 *  - `written_off`: the club waived what was still due (Task 23) - `written_off`, nothing is due;
 *  - still due (`endedStillDue`: an OFFLINE deal that went live, ended by the sweep): the sponsor had the placement and has not
 *    paid - still `unpaid`, with its bank details (product-owner recommendation, task-22-report.md fix round 1);
 *  - anything else (it never went live, an online deal, a pre-deals row): `ended`, which claims nothing - contact the club.
 * A complimentary deal (`none`) is never numbered, so it never has an invoice to ask about: a refusal, not a guess.
 */
export function invoiceState(
  d: Pick<SponsorDeal, "payment_status" | "deal_status" | "ended_reason" | "payment_method" | "live_at">,
): InvoiceState {
  switch (d.payment_status) {
    case "paid":
      return "paid";
    case "refunded":
      return "refunded";
    case "pending":
    case "failed": {
      if (d.deal_status !== "ended") return "unpaid";
      if (d.ended_reason === "ended_now") return "void";
      if (d.ended_reason === "written_off") return "written_off";
      return endedStillDue(d) ? "unpaid" : "ended";
    }
    case "none":
      throw new Error("sponsor invoices: a complimentary deal has no invoice (it is never numbered)");
  }
}

/**
 * Can the sponsor pay this invoice by card now? An ONLINE deal that a payment would move: the deals the club could mark as paid
 * (`allowedActions` offers `mark_paid`: unpaid, and awaiting payment, live or scheduled). That is exactly what the payment
 * webhook accepts (F12): a draft (its invoice never sent) or an awaiting-approval deal would take the money and only raise an
 * owner alert, and an ended one is not due. Offline invoices are paid by transfer, never here.
 */
export function cardPayable(d: DealActionFacts): boolean {
  return d.payment_method === "online" && allowedActions(d).includes("mark_paid");
}

/**
 * Mint a NEW invoice token for a numbered deal, on `tx` (the caller's transaction, under its tenant): stores the token's hash,
 * replacing any earlier one (so a mint is also a rotation: Task 23), and returns the raw token - its only way out. A deal with
 * no number has no invoice: refused, and nothing is written.
 */
export async function mintInvoiceToken(tx: Tx, dealId: string): Promise<string> {
  const token = mintReportToken();
  const rows = await tx`
    update sponsor_orders set invoice_token_hash = ${hashReportToken(token)}
     where id = ${dealId} and invoice_number is not null
    returning id`;
  if (rows.length !== 1) throw new Error(`sponsor invoices: deal ${dealId} has no invoice number, so it has no invoice link`);
  return token;
}

/**
 * Can the club take a card payment for a deal on this scope now: Connect takes charges and the plan has `sponsors.monetize` on
 * the deal's competition. The same two gates payInvoice asks before Stripe (`assertOnlineAllowed`: 402; `checkoutOrg`: 409
 * `connect_required`), asked here so the page never offers a button the route would refuse (review m2). Privileged (`sql`):
 * outside the doc's tenant transaction, so it never holds a second connection inside one.
 */
export async function clubTakesCards(orgId: string, competitionId: string | null): Promise<boolean> {
  const [org] = await sql<{ stripe_account_id: string | null; stripe_charges_enabled: boolean }[]>`
    select stripe_account_id, stripe_charges_enabled from organizations where id = ${orgId}`;
  if (!org?.stripe_account_id || !org.stripe_charges_enabled) return false;
  return hasFeature(orgId, "sponsors.monetize", competitionId ?? undefined);
}

/** The numbered deal a token names, and its org - or null for a token that names none (unknown, rotated, malformed, an
 *  unnumbered row, a soft-deleted org: one answer). Privileged: a visitor has no org yet, the token is what names one. */
export async function invoiceDealByToken(token: string): Promise<{ orgId: string; dealId: string } | null> {
  const [row] = await sql<{ org_id: string; id: string }[]>`
    select d.org_id, d.id
      from sponsor_orders d
      join organizations o on o.id = d.org_id and o.deleted_at is null
     where d.invoice_token_hash = ${hashReportToken(token)} and d.invoice_number is not null`;
  return row ? { orgId: row.org_id, dealId: row.id } : null;
}

/** The sponsor's invoice, from the token in its link: null for every token that opens nothing (the page's one opaque 404). */
export async function invoiceDocByToken(token: string): Promise<SponsorInvoiceDoc | null> {
  const found = await invoiceDealByToken(token);
  if (!found) return null;
  const built = await withTenant(found.orgId, async (tx) => {
    const deal = await readDeal(tx, found.dealId);
    return deal ? buildDoc(tx, found.orgId, deal) : null;
  });
  return built && withCardGate(found.orgId, built);
}

/** The console's copy of a deal's invoice (the PDF download): this org's deal, numbered - else 404. */
export async function invoiceDocForDeal(auth: AuthCtx, dealId: string): Promise<SponsorInvoiceDoc> {
  const built = await withTenant(auth.orgId, async (tx) => {
    const deal = await readDeal(tx, dealId);
    return deal && deal.invoice_number !== null ? buildDoc(tx, auth.orgId, deal) : null;
  });
  if (!built) throw new HttpError(404, "this deal has no invoice");
  return withCardGate(auth.orgId, built);
}

/** A doc as `buildDoc` drew it (card payability by the deal alone), with the deal's scope for the club's card gate. */
interface BuiltDoc {
  doc: SponsorInvoiceDoc;
  competitionId: string | null;
}

/** Fold the club's card gate into a built doc: a deal a card could pay is `payable` only while the club can take cards, else
 *  `cardUnavailable`. Asked only for a deal a card could pay (one query and one entitlement read; none otherwise). */
async function withCardGate(orgId: string, { doc, competitionId }: BuiltDoc): Promise<SponsorInvoiceDoc> {
  if (!doc.payable) return doc;
  const takes = await clubTakesCards(orgId, competitionId);
  return { ...doc, payable: takes, cardUnavailable: !takes };
}

interface OrgRow {
  name: string;
  sponsor_invoice_address: string | null;
  sponsor_invoice_bank_details: string | null;
  default_locale: string;
  logo_url: string | null;
  logo_storage_path: string | null;
  issued_on: string;
}

/** A blank setting is no setting: null, "" and whitespace-only are absent (the org PATCH normalises blanks to null since T21,
 *  and a row written before it may still hold ""). */
const filled = (s: string | null): string | null => (s !== null && s.trim() !== "" ? s.trim() : null);

/** The club's bank details for an OFFLINE invoice's email (Task 23), as its invoice settings hold them - the same setting, read
 *  the same way (`filled`), as the invoice page's. Null when the club has set none. On `tx`. */
export async function invoiceBankDetails(tx: Tx, orgId: string): Promise<string | null> {
  const [org] = await tx<{ sponsor_invoice_bank_details: string | null }[]>`
    select sponsor_invoice_bank_details from organizations where id = ${orgId}`;
  return filled(org?.sponsor_invoice_bank_details ?? null);
}

/** Build the document for a numbered deal, on `tx` (its org's tenant). Null when the org is soft-deleted. Card payability here is
 *  the deal's alone (`cardPayable`); `withCardGate` adds the club's, outside the transaction. */
async function buildDoc(tx: Tx, orgId: string, deal: ServerDeal): Promise<BuiltDoc | null> {
  if (deal.invoice_number === null) return null;
  // The logo as the public site shows it: only on a plan with `branding` (server/public-site/data.ts getPublicOrg). The issue
  // day is the deal's creation in the org's timezone (V305; NULL is UTC), the same zone createDeal reads `ends_on` in.
  const [org] = await tx<OrgRow[]>`
    select o.name, o.sponsor_invoice_address, o.sponsor_invoice_bank_details, o.default_locale,
           case when org_has_feature(o.id, 'branding') then o.logo_url end as logo_url,
           case when org_has_feature(o.id, 'branding') then o.logo_storage_path end as logo_storage_path,
           (${deal.created_at}::timestamptz at time zone coalesce(o.timezone, 'UTC'))::date::text as issued_on
      from organizations o
     where o.id = ${orgId} and o.deleted_at is null`;
  if (!org) return null;
  const locale = toLocale(org.default_locale);
  const ui = await getDictionary(locale, "ui");
  let scope = t(ui, "sponsors.scopeAll");
  if (deal.competition_id !== null) {
    const [c] = await tx<{ name: string }[]>`select name from competitions where id = ${deal.competition_id}`;
    // sponsor_orders_competition_id_fkey is RESTRICT (V495): a deal's competition cannot be gone.
    if (!c) throw new Error(`sponsor invoices: deal ${deal.id}'s competition ${deal.competition_id} is not there`);
    scope = c.name;
  }
  const state = invoiceState(deal);
  const doc: SponsorInvoiceDoc = {
    number: formatInvoiceNumber(deal.invoice_number),
    issuedOn: org.issued_on,
    org: { name: org.name, address: filled(org.sponsor_invoice_address), logoPath: resolveLogoUrl(org.logo_storage_path, org.logo_url) },
    billedTo: { name: deal.sponsor_name, email: deal.sponsor_email },
    line: {
      description: t(ui, "sponsors.invoice.line", { package: deal.package_name, scope }),
      amountCents: deal.amount_cents,
      currency: deal.currency,
    },
    included: { tier: deal.tier, scope, onStream: deal.includes_on_stream },
    state,
    dealEnded: deal.deal_status === "ended",
    method: deal.payment_method,
    bankDetails: state === "unpaid" && deal.payment_method === "offline" ? filled(org.sponsor_invoice_bank_details) : null,
    payable: cardPayable(deal),
    cardUnavailable: false,
    locale,
  };
  return { doc, competitionId: deal.competition_id };
}
