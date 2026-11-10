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
// the org's sponsors - until the deal screens replace it (PR 2).
import { useCallback, useEffect, useState } from "react";
import Link from "@/components/ui/console-link";
import { Copy, Send, Undo2, XCircle } from "lucide-react";
import { useMsg } from "@/components/i18n/dict-provider";
import { useConfirm } from "@/components/ui/confirm-provider";
import { sponsorSaveErrorKey } from "@/components/sponsors/save-error";
import { ApiV1Error } from "@/lib/client-v1";
import type { MessageKey } from "@/lib/messages";
import { allowedActions, type PaymentStatus, type SponsorDeal } from "@/lib/sponsor-deals";
import { SPONSOR_TIERS, type SponsorTier } from "@/components/org-sponsors";

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

/** Does this sponsor already have an OPEN deal on this package - one that has not gone live yet (draft, awaiting payment or
 *  approval, scheduled)? A live deal is running and an ended one is over; neither is a second invoice for the same thing. The
 *  same rule as `has_open_deal` (server/sponsors/deal-apply.ts `isOpen`). Keys on the SPONSOR, not the typed email. */
export function hasOpenDealOn(deals: readonly SponsorDeal[], sponsorId: string, packageId: string): boolean {
  return deals.some(
    (d) =>
      d.sponsor_id === sponsorId && d.package_id === packageId && d.deal_status !== "live" && d.deal_status !== "ended",
  );
}

export function SponsorPackages({
  orgId,
  competitions,
  sponsors,
  hasMonetize,
  billingHref,
  sponsorsHref,
}: {
  orgId: string;
  competitions: { id: string; name: string }[];
  /** The org's sponsors, for the invoice form's picker. */
  sponsors: SponsorPick[];
  hasMonetize: boolean;
  billingHref: string;
  /** The Sponsors tab, for the empty picker's "Add a sponsor first". */
  sponsorsHref: string;
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
  const [sentUrl, setSentUrl] = useState<string | null>(null);
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

  /** Packages and deals (the orders list), as data — no state. */
  const fetchSponsorship = useCallback(
    () =>
      Promise.all([
        api("/sponsor-packages") as Promise<PackageItem[]>,
        api("/sponsor-deals") as Promise<SponsorDeal[]>,
      ]),
    [api],
  );

  /** Re-read after an action (an event, so awaiting in place is fine). */
  const load = useCallback(async () => {
    const [pkgs, rows] = await fetchSponsorship();
    setPackages(pkgs);
    setDeals(rows);
  }, [fetchSponsorship]);

  // The first read, for a plan that has the feature: set from the request's
  // own callback (never synchronously in the effect), ignored once
  // superseded. A failed first read stays silent, as before.
  useEffect(() => {
    if (!hasMonetize) return;
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
  }, [hasMonetize, fetchSponsorship]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      // A server refusal reads the dictionary's words for its code (components/sponsors/save-error.ts); anything else - a
      // network failure, a non-envelope body - is the house fallback.
      setError(msg(sponsorSaveErrorKey(err)));
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
        body: msg("sponsors.order.refundConfirm.body", { amount, name: deal.sponsor_name }),
        confirmLabel: msg("sponsors.order.refundConfirm.label", { amount }),
        tone: "danger",
      });
      if (!ok) return;
      await run(async () => {
        await api(`/sponsor-deals/${deal.id}/refund`, { method: "POST" });
        await load();
      });
    })();
  }

  /** Open (or close) a package's invoice form. It always opens at the first sponsor with a blank email: an email left over
   *  from the last pick must never ride along to a different sponsor. */
  function toggleInvoice(pkg: PackageItem) {
    setInvoiceFor(invoiceFor === pkg.id ? null : pkg.id);
    setInvoice({ sponsorId: pickable[0]?.id ?? "", email: "" });
    setSentUrl(null);
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
          body: msg("sponsors.order.dupConfirm.body", { name: sponsor.name }),
          confirmLabel: msg("sponsors.order.dupConfirm.label"),
          tone: "danger",
        });
        if (!ok) return;
      }
      await run(async () => {
        // A deal for the picked sponsor, paid online and live when paid: today's "pay-now invoice". The package's own scope
        // rides along (a package for one competition must be sold for it).
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
        setSentUrl(result.checkout_url);
        setInvoice({ sponsorId: "", email: "" });
        setInvoiceFor(null);
        await load();
      });
    })();
  }

  const priceInvalid = draft.price.trim() !== "" && !(Number.parseFloat(draft.price) > 0);

  if (!hasMonetize) {
    return (
      <p className="text-sm text-slate-500">
        {msg("sponsors.sell.upsell")}{" "}
        <Link href={billingHref} className="text-purple-600 underline">
          {msg("settings.upgrade.link")}
        </Link>
      </p>
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

      {/* Create a package */}
      <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
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
          {packages.map((pkg) => (
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
              {invoiceFor === pkg.id ? (
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
          ))}
        </ul>
      )}

      {/* Orders (the deals) */}
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
            {deals.map((deal) => (
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
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                    deal.disputed_at
                      ? "bg-rose-100 text-rose-700"
                      : deal.payment_status === "refunded" && deal.dispute_id
                        ? "bg-rose-200 text-rose-900"
                        : STATUS_BADGE[deal.payment_status]
                  }`}
                >
                  {msg(
                    deal.disputed_at
                      ? "sponsors.order.status.disputed"
                      : deal.payment_status === "refunded" && deal.dispute_id
                        ? "sponsors.order.status.disputeLost"
                        : STATUS_MSG[deal.payment_status],
                  )}
                </span>
                {allowedActions(deal).includes("refund") ? (
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
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
