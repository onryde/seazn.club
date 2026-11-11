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
// in its own transaction; sendDealInvoice mints one for a numbered deal that has none (a deal made before this task); Task 23
// mails it and rotates it on a resend. A complimentary deal has no number, so it never has one.
//
// THE DOCUMENT is in the ORG's language (`default_locale`): the club issues it, whoever opens it.
import { sql, withTenant, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { getDictionary, t } from "@/lib/i18n";
import { toLocale, type Locale } from "@/lib/i18n-constants";
import { allowedActions, formatInvoiceNumber, type PaymentMethod, type SponsorDeal } from "@/lib/sponsor-deals";
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
  method: PaymentMethod;
  /** How to pay by transfer: the club's bank details, on an OFFLINE invoice while it is still due (`unpaid`). Null on an online
   *  invoice (the settings card sets them "for offline invoices"; an online one is paid by card: T21 review carry), once it is
   *  paid, refunded or void (a settled invoice does not invite a second transfer), or when the club has set none (null, "" and
   *  whitespace-only alike: `filled`). */
  bankDetails: string | null;
  /** The sponsor can pay this invoice by card now (`cardPayable`). */
  payable: boolean;
  locale: Locale;
}

/**
 * The invoice's state, from the deal's money first: `paid`, `refunded`, else `void` when the deal ended unpaid (the invoice is
 * no longer due), else `unpaid`. A complimentary deal (`none`) is never numbered, so it never has an invoice to ask about: a
 * refusal, not a guess.
 */
export function invoiceState(d: Pick<SponsorDeal, "payment_status" | "deal_status">): InvoiceState {
  switch (d.payment_status) {
    case "paid":
      return "paid";
    case "refunded":
      return "refunded";
    case "pending":
    case "failed":
      return d.deal_status === "ended" ? "void" : "unpaid";
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
export function cardPayable(
  d: Pick<SponsorDeal, "payment_method" | "deal_status" | "payment_status" | "disputed_at" | "ended_reason">,
): boolean {
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

/** Does this numbered deal still lack a token (a deal numbered before tokens were minted)? On `tx`. */
export async function needsInvoiceToken(tx: Tx, dealId: string): Promise<boolean> {
  const [row] = await tx<{ needs: boolean }[]>`
    select invoice_number is not null and invoice_token_hash is null as needs from sponsor_orders where id = ${dealId}`;
  return row?.needs ?? false;
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
  return withTenant(found.orgId, async (tx) => {
    const deal = await readDeal(tx, found.dealId);
    return deal ? buildDoc(tx, found.orgId, deal) : null;
  });
}

/** The console's copy of a deal's invoice (the PDF download): this org's deal, numbered - else 404. */
export async function invoiceDocForDeal(auth: AuthCtx, dealId: string): Promise<SponsorInvoiceDoc> {
  const doc = await withTenant(auth.orgId, async (tx) => {
    const deal = await readDeal(tx, dealId);
    return deal && deal.invoice_number !== null ? buildDoc(tx, auth.orgId, deal) : null;
  });
  if (!doc) throw new HttpError(404, "this deal has no invoice");
  return doc;
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

/** Build the document for a numbered deal, on `tx` (its org's tenant). Null when the org is soft-deleted. */
async function buildDoc(tx: Tx, orgId: string, deal: ServerDeal): Promise<SponsorInvoiceDoc | null> {
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
  return {
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
    method: deal.payment_method,
    bankDetails: state === "unpaid" && deal.payment_method === "offline" ? filled(org.sponsor_invoice_bank_details) : null,
    payable: cardPayable(deal),
    locale,
  };
}
