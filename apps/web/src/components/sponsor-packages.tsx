"use client";

// Sponsor monetization console (v10 PROMPT-56 follow-on): the owner-facing
// surface for the packages/orders rail. Create a priced package, send one of
// the org's sponsors a pay-now invoice (a DEAL for that sponsor + Stripe
// Checkout link + email), and watch the list move pending → paid as the
// placement goes live. Pro `sponsors.monetize`; checkout itself also requires
// Stripe Connect.
//
// Transitional (sponsor deals T12): the order rail is the deal API now. This
// tab keeps today's layout on it - the typed sponsor name became a picker of
// the org's sponsors - until the deal screens replace it (PR 2). Batch F fix
// round 1: each order row can Resend its invoice and End now, so the console
// can exit every deal it creates. Batch G: the Refund and End now confirms say
// what happens to the money and to the public pages for the deal in front of
// them, and the pay-link banner shows only while its deal can still be paid.
import { useCallback, useEffect, useState } from "react";
import Link from "@/components/ui/console-link";
import { CircleStop, Copy, Send, Undo2, XCircle } from "lucide-react";
import { useMsg } from "@/components/i18n/dict-provider";
import { useConfirm } from "@/components/ui/confirm-provider";
import { sponsorSaveErrorKey, type SponsorWrite } from "@/components/sponsors/save-error";
import { ApiV1Error } from "@/lib/client-v1";
import type { MessageKey } from "@/lib/messages";
import {
  dupConfirmBodyKey,
  endConfirmBodyKey,
  endKeepsPayment,
  hasLiveDeal,
  hasOpenDealOn,
} from "@/components/sponsors/deal-copy";
import { allowedActions, isUnpaid, type PaymentStatus, type SponsorDeal } from "@/lib/sponsor-deals";
import { SPONSOR_TIERS, type SponsorTier } from "@/components/org-sponsors";

// The deal screens' shared words and questions moved to components/sponsors/deal-copy.ts (sponsor deals PR 2, Task 15); this tab's
// transitional picker (deleted in Task 18) keeps exporting them under the names its tests import.
export { dupConfirmBodyKey, endConfirmBodyKey, endKeepsPayment, hasLiveDeal, hasOpenDealOn };

interface PackageItem {
  id: string;
  competition_id: string | null;
  name: string;
  description: string | null;
  price_cents: number;
  currency: string;
  tier: SponsorTier;
  active: boolean;
}

/** What the invoice form needs of a sponsor: the page hands over these three fields, not the whole row. */
export interface SponsorPick {
  id: string;
  name: string;
  display_order: number;
}

const TIER_MSG: Record<SponsorTier, MessageKey> = {
  title: "sponsors.tier.titleTier",
  gold: "sponsors.tier.gold",
  silver: "sponsors.tier.silver",
  partner: "sponsors.tier.partner",
};

const STATUS_MSG: Record<PaymentStatus, MessageKey> = {
  pending: "sponsors.order.status.pending",
  paid: "sponsors.order.status.paid",
  failed: "sponsors.order.status.failed",
  refunded: "sponsors.order.status.refunded",
  none: "sponsors.order.status.none",
};

const STATUS_BADGE: Record<PaymentStatus, string> = {
  pending: "bg-amber-50 text-amber-700",
  paid: "bg-emerald-50 text-emerald-700",
  failed: "bg-red-50 text-red-600",
  refunded: "bg-slate-100 text-slate-500",
  none: "bg-slate-100 text-slate-500",
};

const CURRENCIES = ["gbp", "eur", "usd"] as const;

function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** The picker's order: by `display_order`, ties kept in the order they arrived in (the server's tier-then-order list). The
 *  first of these is where the invoice form opens. */
export function sponsorsByDisplayOrder(sponsors: readonly SponsorPick[]): SponsorPick[] {
  return sponsors
    .map((sponsor, position) => ({ sponsor, position }))
    .sort((a, b) => a.sponsor.display_order - b.sponsor.display_order || a.position - b.position)
    .map(({ sponsor }) => sponsor);
}

/** The refund confirm's money words (review m1, batch G New-3): back to the card through Stripe only when a card payment at
 *  Stripe paid the deal - `has_payment_intent`, the SAME fact refundDeal decides on (server/usecases/sponsor-deals.ts). Without
 *  it (marked as paid by hand, or paid offline) the refund is recorded and the club pays the sponsor back. `marked_paid_by` is
 *  not that fact: it is nulled when the marking user is deleted. */
export function refundConfirmBodyKey(deal: SponsorDeal): MessageKey {
  return deal.has_payment_intent ? "sponsors.order.refundConfirm.body" : "sponsors.order.refundConfirm.bodyRecorded";
}

/** The refund confirm's placement words (review m1 remainder, batch G): a refund ends the deal, so the public pages do what
 *  ending it does (endConfirmBodyKey) - except for a deal that has already ended, where nothing on them changes. */
export function refundPlacementKey(deals: readonly SponsorDeal[], deal: SponsorDeal): MessageKey {
  if (deal.deal_status === "ended") return "sponsors.order.refundConfirm.placementEnded";
  if (deal.deal_status === "live") return "sponsors.order.refundConfirm.placementLive";
  if (deal.sponsor_id !== null && hasLiveDeal(deals, deal.sponsor_id)) return "sponsors.order.refundConfirm.placementKept";
  return "sponsors.order.refundConfirm.placementHidden";
}

/** Can the pay link the console last showed still be paid (batch G New-1)? Only while its deal has not ended and still owes
 *  money: End now kills the link, and a paid or refunded deal has nothing left to pay. The deal is the list's copy when the
 *  list has it - every action re-reads it - else the one the send answered (the re-read has not landed yet). */
export function payLinkStillOpen(deals: readonly SponsorDeal[], sent: SponsorDeal): boolean {
  const current = deals.find((d) => d.id === sent.id) ?? sent;
  return current.deal_status !== "ended" && isUnpaid(current.payment_status);
}

/** The payment chip (review m3): an ended deal that was never paid says so, rather than reading as a live "Pending". */
function paymentChip(deal: SponsorDeal): { key: MessageKey; className: string } {
  if (deal.disputed_at) return { key: "sponsors.order.status.disputed", className: "bg-rose-100 text-rose-700" };
  if (deal.payment_status === "refunded" && deal.dispute_id) {
    return { key: "sponsors.order.status.disputeLost", className: "bg-rose-200 text-rose-900" };
  }
  if (deal.deal_status === "ended" && isUnpaid(deal.payment_status)) {
    return { key: "sponsors.order.status.endedUnpaid", className: "bg-slate-100 text-slate-500" };
  }
  return { key: STATUS_MSG[deal.payment_status], className: STATUS_BADGE[deal.payment_status] };
}

export function SponsorPackages({
  orgId,
  competitions,
  sponsors,
  hasMonetize,
  billingHref,
  sponsorsHref,
  finishedCompetitionIds = [],
}: {
  orgId: string;
  competitions: { id: string; name: string }[];
  /** The org's sponsors, for the invoice form's picker. */
  sponsors: SponsorPick[];
  hasMonetize: boolean;
  billingHref: string;
  /** The Sponsors tab, for the empty picker's "Add a sponsor first". */
  sponsorsHref: string;
  /** Competitions that have finished: a package for one of them is not sold (review m4; the create refuses it anyway). */
  finishedCompetitionIds?: readonly string[];
}) {
  const msg = useMsg();
  const confirm = useConfirm();
  const [packages, setPackages] = useState<PackageItem[]>([]);
  const [deals, setDeals] = useState<SponsorDeal[]>([]);
  const [draft, setDraft] = useState({
    name: "", price: "", currency: "gbp" as string, tier: "gold" as SponsorTier, competition_id: "",
  });
  const [invoiceFor, setInvoiceFor] = useState<string | null>(null);
  const [invoice, setInvoice] = useState({ sponsorId: "", email: "" });
  // The pay link a send or resend answered, with the deal it pays: the banner shows it only while that deal can still be paid.
  const [sent, setSent] = useState<{ deal: SponsorDeal; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The picker lists the sponsors in display order and opens at the first. The chosen one is derived, not copied into state: a
  // sponsor that is no longer in the list (the page was refreshed under the form) falls back to the first.
  const pickable = sponsorsByDisplayOrder(sponsors);
  const chosen = pickable.find((s) => s.id === invoice.sponsorId) ?? pickable[0];

  const api = useCallback(
    async (path: string, init?: RequestInit): Promise<unknown> => {
      const res = await fetch(`/api/v1/orgs/${orgId}${path}`, {
        headers: { "Content-Type": "application/json" },
        ...init,
      });
      const json = (await res.json().catch(() => ({}))) as {
        data?: unknown;
        error?: string | { code?: string; message?: string };
      };
      if (!res.ok) {
        // The envelope's CODE rides on the error: `run` shows the dictionary's words for it, never the server's sentence.
        const e = typeof json.error === "string" ? { message: json.error } : (json.error ?? {});
        throw new ApiV1Error(e.message ?? "Request failed", res.status, e.code ?? "UNKNOWN");
      }
      return json.data;
    },
    [orgId],
  );

  /** Packages and deals (the orders list), as data — no state. Without the plan only the deals are read: their exits stay
   *  (final review m1), the packages are selling and are not shown. */
  const fetchSponsorship = useCallback(
    () =>
      Promise.all([
        hasMonetize ? (api("/sponsor-packages") as Promise<PackageItem[]>) : Promise.resolve([] as PackageItem[]),
        api("/sponsor-deals") as Promise<SponsorDeal[]>,
      ]),
    [api, hasMonetize],
  );

  /** Re-read after an action (an event, so awaiting in place is fine). */
  const load = useCallback(async () => {
    const [pkgs, rows] = await fetchSponsorship();
    setPackages(pkgs);
    setDeals(rows);
  }, [fetchSponsorship]);

  // The first read, on every plan (final review m1: an org that lost the
  // feature still reads its deals, to exit them): set from the request's
  // own callback (never synchronously in the effect), ignored once
  // superseded. A failed first read stays silent, as before.
  useEffect(() => {
    let ignore = false;
    fetchSponsorship().then(
      ([pkgs, rows]) => {
        if (ignore) return;
        setPackages(pkgs);
        setDeals(rows);
      },
      () => {},
    );
    return () => {
      ignore = true;
    };
  }, [fetchSponsorship]);

  async function run(fn: () => Promise<void>, opts: { write?: SponsorWrite; dealWrite?: boolean } = {}) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      // A server refusal reads the dictionary's words for its code (components/sponsors/save-error.ts) - the write's own words
      // first; anything else - a network failure, a non-envelope body - is the house fallback.
      setError(msg(sponsorSaveErrorKey(err, opts.write)));
      // A deal write can fail AFTER it changed something (review I1): a create saves its deal before Stripe makes the link, a
      // Resend may close the old link first. The list is re-read so it shows what the server holds - and the next Send meets
      // the saved deal's duplicate confirm. A failed re-read leaves the error already shown.
      if (opts.dealWrite) await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  function createPackage() {
    void run(async () => {
      const price_cents = Math.round(Number.parseFloat(draft.price) * 100);
      await api("/sponsor-packages", {
        method: "POST",
        body: JSON.stringify({
          name: draft.name.trim(),
          price_cents,
          currency: draft.currency,
          tier: draft.tier,
          ...(draft.competition_id ? { competition_id: draft.competition_id } : {}),
        }),
      });
      setDraft({ name: "", price: "", currency: "gbp", tier: "gold", competition_id: "" });
      await load();
    });
  }

  function retirePackage(pkg: PackageItem) {
    void (async () => {
      const ok = await confirm({
        title: msg("sponsors.pkg.retireConfirm.title"),
        body: msg("sponsors.pkg.retireConfirm.body", { name: pkg.name }),
        confirmLabel: msg("sponsors.pkg.retireConfirm.label"),
      });
      if (!ok) return;
      await run(async () => {
        await api(`/sponsor-packages/${pkg.id}`, { method: "DELETE" });
        await load();
      });
    })();
  }

  function refundDeal(deal: SponsorDeal) {
    void (async () => {
      const amount = money(deal.amount_cents, deal.currency);
      const ok = await confirm({
        title: msg("sponsors.order.refundConfirm.title"),
        // What happens to the money, then to the public pages (by the deal's state), then that it is final.
        body: [
          msg(refundConfirmBodyKey(deal), { amount, name: deal.sponsor_name }),
          msg(refundPlacementKey(deals, deal), { name: deal.sponsor_name }),
          msg("sponsors.order.refundConfirm.irreversible"),
        ].join(" "),
        confirmLabel: msg("sponsors.order.refundConfirm.label", { amount }),
        tone: "danger",
      });
      if (!ok) return;
      await run(
        async () => {
          await api(`/sponsor-deals/${deal.id}/refund`, { method: "POST" });
          await load();
        },
        { dealWrite: true },
      );
    })();
  }

  /** Resend (or, for a draft, send) a deal's invoice: the server reuses an open payment link or makes a new one, and emails
   *  it (ensureDealCheckout). The answer carries the link, like the create's. */
  function resendInvoice(deal: SponsorDeal) {
    void run(
      async () => {
        const result = (await api(`/sponsor-deals/${deal.id}/send-invoice`, { method: "POST" })) as {
          deal: SponsorDeal;
          checkout_url: string | null;
        };
        setSent(result.checkout_url ? { deal: result.deal, url: result.checkout_url } : null);
        await load();
      },
      { write: "resend_invoice", dealWrite: true },
    );
  }

  /** End a deal now (review I2: the console can exit every deal it creates). Its payment link stops working; the confirm says
   *  what the public pages do next. */
  function endDealNow(deal: SponsorDeal) {
    void (async () => {
      const ok = await confirm({
        title: msg("sponsors.order.endConfirm.title"),
        body: [
          msg(endConfirmBodyKey(deals, deal), { name: deal.sponsor_name }),
          ...(endKeepsPayment(deal)
            ? [msg("sponsors.order.endConfirm.paidKept", { amount: money(deal.amount_cents, deal.currency), name: deal.sponsor_name })]
            : []),
        ].join(" "),
        confirmLabel: msg("sponsors.order.endConfirm.label"),
        tone: "danger",
      });
      if (!ok) return;
      await run(
        async () => {
          await api(`/sponsor-deals/${deal.id}/end`, { method: "POST" });
          await load();
        },
        { dealWrite: true },
      );
    })();
  }

  /** Open (or close) a package's invoice form. It always opens at the first sponsor with a blank email: an email left over
   *  from the last pick must never ride along to a different sponsor. */
  function toggleInvoice(pkg: PackageItem) {
    setInvoiceFor(invoiceFor === pkg.id ? null : pkg.id);
    setInvoice({ sponsorId: pickable[0]?.id ?? "", email: "" });
    setSent(null);
  }

  function sendInvoice(pkg: PackageItem) {
    if (!chosen) return;
    const sponsor = chosen;
    void (async () => {
      // Each invoice is its own payable deal — warn before minting a second
      // one for the same sponsor + package, or they can pay twice.
      if (hasOpenDealOn(deals, sponsor.id, pkg.id)) {
        const ok = await confirm({
          title: msg("sponsors.order.dupConfirm.title"),
          body: msg(dupConfirmBodyKey(deals, sponsor.id, pkg.id), { name: sponsor.name }),
          confirmLabel: msg("sponsors.order.dupConfirm.label"),
          tone: "danger",
        });
        if (!ok) return;
      }
      await run(
        async () => {
          // A deal for the picked sponsor, paid online and live when paid: today's "pay-now invoice". The package's own scope
          // rides along (a package for one competition must be sold for it). Never `end_current`: the console does not end a
          // live deal behind the club's back, so a create's only Stripe call is the invoice, after the save (F11).
          const result = (await api(`/sponsors/${sponsor.id}/deals`, {
            method: "POST",
            body: JSON.stringify({
              package_id: pkg.id,
              competition_id: pkg.competition_id,
              payment_method: "online",
              go_live: "on_payment",
              sponsor_email: invoice.email.trim(),
            }),
          })) as { deal: SponsorDeal; checkout_url: string | null };
          // F11: the pay link rides beside the deal in the create's answer; the deal itself carries no url.
          setSent(result.checkout_url ? { deal: result.deal, url: result.checkout_url } : null);
          setInvoice({ sponsorId: "", email: "" });
          setInvoiceFor(null);
          await load();
        },
        { write: "create_deal", dealWrite: true },
      );
    })();
  }

  const priceInvalid = draft.price.trim() !== "" && !(Number.parseFloat(draft.price) > 0);
  const sentUrl = sent && payLinkStillOpen(deals, sent.deal) ? sent.url : null;

  // The Orders list: every deal and the exits it offers (End now, Refund, the evidence pack). It renders on ANY plan (final
  // review m1): an org that lost `sponsors.monetize` must still be able to take a live sponsor off its pages, and neither
  // /end nor /refund asks the plan. Only what sells needs it - the package form, Send invoice and Resend (the server refuses
  // an invoice without the plan, 402).
  const ordersList = (
    <div>
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {msg("sponsors.orders.title")}
      </p>
      {deals.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-sm text-slate-400">
          {msg("sponsors.orders.empty")}
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
          {deals.map((deal) => {
            const actions = allowedActions(deal);
            const chip = paymentChip(deal);
            return (
              <li key={deal.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">{deal.sponsor_name}</p>
                  {deal.sponsor_email ? (
                    <p className="truncate text-xs text-slate-400">{deal.sponsor_email}</p>
                  ) : null}
                </div>
                <span className="text-sm tabular-nums text-slate-600">
                  {money(deal.amount_cents, deal.currency)}
                </span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${chip.className}`}>
                  {msg(chip.key)}
                </span>
                {/* The row's actions wrap as one group under the name on a phone. */}
                <div className="flex flex-wrap items-center gap-1">
                  {hasMonetize && (actions.includes("send_invoice") || actions.includes("resend_invoice")) ? (
                    <button
                      type="button"
                      data-testid={`order-resend-${deal.id}`}
                      disabled={busy}
                      onClick={() => resendInvoice(deal)}
                      className="btn flex items-center gap-1.5 text-xs"
                    >
                      <Send className="h-3.5 w-3.5" />
                      {msg("sponsors.order.resend")}
                    </button>
                  ) : null}
                  {actions.includes("end_now") ? (
                    <button
                      type="button"
                      data-testid={`order-end-${deal.id}`}
                      disabled={busy}
                      onClick={() => endDealNow(deal)}
                      className="btn flex items-center gap-1.5 text-xs text-red-500 hover:bg-red-50"
                    >
                      <CircleStop className="h-3.5 w-3.5" />
                      {msg("sponsors.order.endNow")}
                    </button>
                  ) : null}
                  {actions.includes("refund") ? (
                    <button
                      type="button"
                      data-testid={`order-refund-${deal.id}`}
                      disabled={busy}
                      onClick={() => refundDeal(deal)}
                      className="btn flex items-center gap-1.5 text-xs text-red-500 hover:bg-red-50"
                    >
                      <Undo2 className="h-3.5 w-3.5" />
                      {msg("sponsors.order.refund")}
                    </button>
                  ) : null}
                  {deal.disputed_at || deal.dispute_id ? (
                    // Same rail as registrations: one document, mapped to
                    // Stripe's evidence fields, downloaded from the flagged row.
                    <a
                      data-testid={`order-evidence-${deal.id}`}
                      href={`/api/v1/orgs/${orgId}/sponsor-deals/${deal.id}/evidence`}
                      download
                      className="btn btn-ghost text-xs font-medium text-rose-700"
                      title={msg("sponsors.order.evidenceTitle")}
                    >
                      {msg("sponsors.order.evidence")}
                    </a>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  if (!hasMonetize) {
    // The upsell, then the deals the org already has with their exits - and nothing below the upsell when it has none (the
    // Orders empty line invites a Send this plan cannot make).
    return (
      <div data-testid="sponsor-packages" className="space-y-4">
        <p data-testid="sponsor-sell-upsell" className="text-sm text-slate-500">
          {msg("sponsors.sell.upsell")}{" "}
          <Link href={billingHref} className="text-purple-600 underline">
            {msg("settings.upgrade.link")}
          </Link>
        </p>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {deals.length > 0 ? ordersList : null}
      </div>
    );
  }

  return (
    // `sponsor-packages` scopes the e2e walkthrough's locators to this console.
    // Not convenience: `OrgSponsors` renders directly above on the same tab and
    // draws its Tier and Competition labels from the SAME two dictionary keys
    // (`sponsors.tierLabel`, `sponsors.scopeLabel`), so an unscoped label
    // locator is ambiguous by construction.
    <div data-testid="sponsor-packages" className="space-y-4">
      <p className="text-sm text-slate-500">{msg("sponsors.sell.hint")}</p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {sentUrl ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          <span>{msg("sponsors.order.sent")}</span>
          <code data-testid="invoice-link" className="max-w-72 truncate text-xs">
            {sentUrl}
          </code>
          <button
            type="button"
            aria-label={msg("sponsors.order.copyLink")}
            onClick={() => void navigator.clipboard?.writeText(sentUrl)}
            className="grid h-6 w-6 place-items-center rounded text-emerald-700 hover:bg-emerald-100"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      {/* Create a package: its testid is the sell console's own (`sponsor-packages` also wraps the no-plan view). */}
      <div data-testid="sponsor-pkg-create" className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
        <p className="mb-3 text-sm font-semibold text-slate-800">{msg("sponsors.pkg.create")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="label">{msg("sponsors.pkg.name")}</span>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              maxLength={120}
              className="input w-full"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="label">{msg("sponsors.pkg.price")}</span>
              <input
                value={draft.price}
                onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                inputMode="decimal"
                placeholder="250"
                aria-invalid={priceInvalid || undefined}
                className={`input w-full ${priceInvalid ? "border-red-400" : ""}`}
              />
            </label>
            <label className="block">
              <span className="label">{msg("sponsors.pkg.currency")}</span>
              <select
                value={draft.currency}
                onChange={(e) => setDraft({ ...draft, currency: e.target.value })}
                className="input w-full"
              >
                {CURRENCIES.map((cur) => (
                  <option key={cur} value={cur}>
                    {cur.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block">
            <span className="label">{msg("sponsors.tierLabel")}</span>
            <select
              value={draft.tier}
              onChange={(e) => setDraft({ ...draft, tier: e.target.value as SponsorTier })}
              className="input w-full"
            >
              {SPONSOR_TIERS.map((t) => (
                <option key={t} value={t}>
                  {msg(TIER_MSG[t])}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">{msg("sponsors.scopeLabel")}</span>
            <select
              value={draft.competition_id}
              onChange={(e) => setDraft({ ...draft, competition_id: e.target.value })}
              className="input w-full"
            >
              <option value="">{msg("sponsors.scopeAll")}</option>
              {competitions.map((comp) => (
                <option key={comp.id} value={comp.id}>
                  {comp.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            disabled={busy || !draft.name.trim() || !(Number.parseFloat(draft.price) > 0)}
            onClick={createPackage}
            className="btn btn-primary"
          >
            {busy ? "…" : msg("sponsors.pkg.create")}
          </button>
        </div>
      </div>

      {/* Packages */}
      {packages.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-sm text-slate-400">
          {msg("sponsors.sell.empty")}
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
          {packages.map((pkg) => {
            const finished = pkg.competition_id !== null && finishedCompetitionIds.includes(pkg.competition_id);
            return (
              <li key={pkg.id} className="px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800">
                      {pkg.name}
                      {!pkg.active ? (
                        <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-500">
                          {msg("sponsors.pkg.retired")}
                        </span>
                      ) : null}
                    </p>
                    <p className="truncate text-xs text-slate-400">
                      {msg(TIER_MSG[pkg.tier])} · {money(pkg.price_cents, pkg.currency)}
                      {pkg.competition_id
                        ? ` · ${competitions.find((c) => c.id === pkg.competition_id)?.name ?? "…"}`
                        : ""}
                    </p>
                  </div>
                  {pkg.active ? (
                    <div className="flex shrink-0 items-center gap-1">
                      {finished ? (
                        // The competition is over: the deal would end within the hour (§8a), so the package is not sold.
                        <span
                          data-testid={`pkg-finished-${pkg.id}`}
                          className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-500"
                        >
                          {msg("sponsors.pkg.competitionFinished")}
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          data-testid={`invoice-open-${pkg.id}`}
                          onClick={() => toggleInvoice(pkg)}
                          className="btn flex items-center gap-1.5 text-xs"
                        >
                          <Send className="h-3.5 w-3.5" />
                          {msg("sponsors.pkg.invoice")}
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label={msg("sponsors.pkg.retire", { name: pkg.name })}
                        disabled={busy}
                        onClick={() => retirePackage(pkg)}
                        className="grid h-7 w-7 place-items-center rounded text-slate-400 hover:bg-red-50 hover:text-red-500"
                      >
                        <XCircle className="h-4 w-4" />
                      </button>
                    </div>
                  ) : null}
                </div>
                {invoiceFor === pkg.id && !finished ? (
                  chosen ? (
                    <div className="mt-3 grid items-end gap-3 sm:grid-cols-3">
                      <label className="block min-w-0">
                        <span className="label">{msg("sponsors.order.sponsorPick")}</span>
                        <select
                          data-testid="invoice-sponsor"
                          value={chosen.id}
                          onChange={(e) => setInvoice({ ...invoice, sponsorId: e.target.value })}
                          className="input w-full"
                        >
                          {pickable.map((sponsor) => (
                            <option key={sponsor.id} value={sponsor.id}>
                              {sponsor.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block min-w-0">
                        <span className="label">{msg("sponsors.order.email")}</span>
                        <input
                          data-testid="invoice-email"
                          value={invoice.email}
                          onChange={(e) => setInvoice({ ...invoice, email: e.target.value })}
                          type="email"
                          className="input w-full"
                        />
                      </label>
                      <button
                        type="button"
                        data-testid="invoice-send"
                        disabled={busy || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(invoice.email)}
                        onClick={() => sendInvoice(pkg)}
                        className="btn btn-primary"
                      >
                        {busy ? "…" : msg("sponsors.order.send")}
                      </button>
                      {/* The invoice is always a "live when paid" deal, so until it is paid the sponsor drops off the public pages -
                          unless a live deal is already keeping it there, in which case the new deal queues behind it (§8a). The
                          club is told which, in the form that does it. */}
                      {hasLiveDeal(deals, chosen.id) ? (
                        <p data-testid="invoice-queued-note" className="text-xs text-slate-500 sm:col-span-3">
                          {msg("sponsors.order.queuedAfterCurrent")}
                        </p>
                      ) : (
                        <p data-testid="invoice-hidden-note" className="text-xs text-slate-500 sm:col-span-3">
                          {msg("sponsors.order.hiddenUntilPaid")}
                        </p>
                      )}
                    </div>
                  ) : (
                    // An invoice goes to one of the org's sponsors, so an org with none starts there.
                    <p className="mt-3 text-sm">
                      <Link
                        data-testid="invoice-no-sponsors"
                        href={sponsorsHref}
                        className="font-medium text-purple-700 underline"
                      >
                        {msg("sponsors.order.noSponsors")}
                      </Link>
                    </p>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {ordersList}
    </div>
  );
}
