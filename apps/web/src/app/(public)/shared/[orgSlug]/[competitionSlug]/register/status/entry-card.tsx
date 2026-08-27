// One cart entry, rendered as a self-contained "docket": status, money (pay
// control / resolved instructions / nothing owed), roster fill meter with
// per-player consent chips and claim links, and a cancel control.
//
// Deliberately a PLAIN (non-async) function component, even though it
// composes client islands (PayButton/CancelEntry): the page renders a LIST
// of these via renderToStaticMarkup(await StatusPage(...)) in tests
// (react-dom/server does not await a nested async component the way the
// Next.js framework runtime does), so any async work (renderProse for the
// offline instructions) is resolved ONCE in page.tsx and handed down here
// as a plain string.
import type { ReactNode } from "react";
import { formatMinor, type Currency } from "@/lib/currency";
import { fmtDateTime, UTC } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { CompetitionProse } from "@/components/public-site/competition-prose";
import { PayButton } from "./pay-button";
import { CancelEntry } from "./cancel-entry";
import {
  canCancelEntry,
  claimHref,
  entryCountsTowardTotal,
  resolveMoneyState,
  rosterCounts,
  type EntryStatus,
} from "./view-model";

const STATUS_TONE: Record<EntryStatus, { rail: string; badge: string }> = {
  pending: { rail: "bg-amber-400", badge: "bg-amber-50 text-amber-800 border-amber-200" },
  paid: { rail: "bg-emerald-500", badge: "bg-emerald-50 text-emerald-800 border-emerald-200" },
  confirmed: { rail: "bg-emerald-500", badge: "bg-emerald-50 text-emerald-800 border-emerald-200" },
  waitlisted: { rail: "bg-sky-400", badge: "bg-sky-50 text-sky-800 border-sky-200" },
  withdrawn: { rail: "bg-zinc-300", badge: "bg-zinc-100 text-zinc-500 border-zinc-200" },
  expired: { rail: "bg-zinc-300", badge: "bg-zinc-100 text-zinc-500 border-zinc-200" },
  rejected: { rail: "bg-red-400", badge: "bg-red-50 text-red-700 border-red-200" },
};

const STATUS_KEY: Record<EntryStatus, string> = {
  pending: "reg.status.pending",
  paid: "reg.status.paid",
  confirmed: "reg.status.confirmed",
  waitlisted: "reg.status.waitlisted",
  rejected: "reg.status.rejected",
  withdrawn: "reg.status.withdrawn",
  expired: "reg.status.expired",
};

export interface EntryCardProps {
  entry: {
    id: string;
    division_id: string;
    division_name: string;
    display_name: string;
    status: EntryStatus;
    amount_cents: number;
    free_agent: boolean;
    join_code: string | null;
    /** False for a `pair` — its fixed two-person roster leaves no room for
     *  a new joiner, so only its per-slot partner link is real. */
    allows_new_joiner: boolean;
    promotion_expires_at: string | null;
    players: { id: string; full_name: string; consent_status: "pending" | "granted" | "guardian" }[];
    refund_policy: { refundable: boolean; deadline: string | null; amount_cents: number };
  };
  cart: {
    payment_method: "offline" | "stripe" | null;
    expires_at: string | null;
    charges_enabled: boolean;
    /** Pre-rendered offline instructions (renderProse + fillPaymentInstructions
     *  already applied, once, in page.tsx) — null for a stripe-method cart or
     *  a cart with no instructions configured. */
    instructionsHtml: string | null;
    currency: string;
  };
  orgSlug: string;
  competitionSlug: string;
  token: string;
  locale: Locale;
  ui: Dict;
}

export function EntryCard({ entry, cart, orgSlug, competitionSlug, token, locale, ui }: EntryCardProps) {
  const tone = STATUS_TONE[entry.status];
  const money = resolveMoneyState(entry, cart);
  const roster = rosterCounts(entry.players);
  const unclaimed = entry.players.filter((p) => p.consent_status === "pending");

  // FIX 1 (RS007 status-page review): formatMinor(entry.amount_cents, …)
  // used to appear ONLY inside the stripe_due "Pay now — {amount}" label,
  // so an offline_due/stripe_unavailable/paid/confirmed card named no
  // figure at all — a bank-transfer card showed instructions and a
  // deadline with nothing to actually transfer. `feeLabel` is this entry's
  // own figure, phrased the SAME way the review step/cart already phrase a
  // zero fee (`register.entries.free`, never a bare "£0"). `showsFeeLine`
  // is gated by the SAME `entryCountsTowardTotal` predicate the page's own
  // Subtotal filters by (page.tsx), so a card can never show a fee the
  // Subtotal disagrees about (or vice-versa) — and excludes `stripe_due`
  // specifically because that state already names the figure inside its
  // own "Pay now — {amount}" button, right below.
  const feeLabel =
    entry.amount_cents === 0
      ? t(ui, "register.entries.free")
      : formatMinor(entry.amount_cents, cart.currency as Currency, locale);
  const showsFeeLine = entryCountsTowardTotal(entry.status) && money.kind !== "stripe_due";

  let moneyNode: ReactNode = null;
  if (money.kind === "stripe_due") {
    const label = t(ui, "register.status.pay.cta", { amount: feeLabel });
    moneyNode = (
      <div className="space-y-1.5">
        <PayButton entryId={entry.id} token={token} label={label} />
        {money.deadline && (
          <p className="text-xs text-ink-muted">
            {t(ui, "register.status.money.deadline", { date: fmtDateTime(UTC, money.deadline) })}
          </p>
        )}
      </div>
    );
  } else if (money.kind === "stripe_unavailable") {
    moneyNode = (
      <div className="space-y-1">
        <p className="text-sm font-semibold text-ink">{feeLabel}</p>
        <p className="text-sm text-amber-800">{t(ui, "register.status.pay.unavailable")}</p>
      </div>
    );
  } else if (money.kind === "offline_due") {
    moneyNode = (
      <div className="space-y-1.5">
        <p className="text-sm font-semibold text-ink">{feeLabel}</p>
        <p className="text-xs font-semibold tracking-wide text-ink-muted uppercase">
          {t(ui, "register.status.offline.heading")}
        </p>
        {cart.instructionsHtml ? <CompetitionProse html={cart.instructionsHtml} /> : null}
        {money.deadline && (
          <p className="text-xs text-ink-muted">
            {t(ui, "register.status.money.deadline", { date: fmtDateTime(UTC, money.deadline) })}
          </p>
        )}
      </div>
    );
  } else if (entry.status === "waitlisted") {
    moneyNode = <p className="text-sm text-ink-muted">{t(ui, "register.status.waitlisted.note")}</p>;
  } else if (showsFeeLine) {
    // paid/confirmed (the only remaining entryCountsTowardTotal-true
    // statuses once pending is excluded — pending always lands in one of
    // the three money.kind branches above via resolveMoneyState).
    moneyNode = <p className="text-sm font-medium text-ink">{feeLabel}</p>;
  }

  return (
    <li className="flex overflow-hidden rounded-xl border border-zinc-200 bg-surface shadow-sm">
      <span aria-hidden className={`w-1.5 shrink-0 ${tone.rail}`} />
      <div className="min-w-0 flex-1 space-y-3 p-4">
        {/* Wraps for the same reason the roster rows below do: the status
            badge is shrink-0, so at 320px it took the row and truncated the
            entry's own name to "Width Team ri...". The name IS the card's
            identity — the badge drops to its own line instead. */}
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1 basis-48">
            <p className="truncate text-xs font-semibold tracking-wide text-ink-muted uppercase">
              {entry.division_name}
            </p>
            <p className="truncate font-display text-lg font-semibold text-ink">{entry.display_name}</p>
          </div>
          <span
            className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold tracking-wide uppercase ${tone.badge}`}
          >
            {t(ui, STATUS_KEY[entry.status])}
          </span>
        </div>

        {moneyNode}

        {entry.players.length > 0 && (
          <div className="rounded-lg bg-canvas p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold tracking-wide text-ink-muted uppercase">
                {t(ui, "register.status.roster.heading")}
              </p>
              <p className="text-xs text-ink-muted">
                {t(ui, "register.status.roster.meter", { claimed: roster.claimed, total: roster.total })}
              </p>
            </div>
            {/* Each row wraps rather than letting the badge win. The badge is
                shrink-0 and the name truncates, so at 320px a long status
                label ("Awaiting confirmation") took the whole row and crushed
                the name to a few characters — a roster that tells you a spot
                is unclaimed but not WHOSE it is. Wrapping drops the badge to
                its own line there and gives the name full width. Verified by
                screenshot at 320/768/1280; the no-horizontal-scroll e2e gate
                passed both before and after, so it could not see this. */}
            <ul className="mt-2 space-y-1.5">
              {entry.players.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-sm">
                  <span className="min-w-0 flex-1 basis-40 truncate text-ink">{p.full_name}</span>
                  <span
                    className={
                      p.consent_status === "pending"
                        ? "shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700"
                        : "shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700"
                    }
                  >
                    {t(ui, p.consent_status === "pending" ? "register.status.roster.pending" : "register.status.roster.claimed")}
                  </span>
                </li>
              ))}
            </ul>
            {entry.join_code && (unclaimed.length > 0 || entry.allows_new_joiner) && (
              <ul className="mt-2 space-y-1 border-t border-zinc-200 pt-2">
                {unclaimed.map((p) => (
                  <li key={p.id}>
                    <a
                      href={claimHref(orgSlug, competitionSlug, entry.join_code!, p.id)}
                      className="text-xs font-medium text-accent-strong underline underline-offset-2"
                    >
                      {t(ui, "register.status.roster.claimLink", { name: p.full_name })}
                    </a>
                  </li>
                ))}
                {/* The generic (no player_id) link only ever works for a
                    team — a pair's roster is fixed at two, and joinTeamEntry
                    422s its insert-a-new-person path. */}
                {entry.allows_new_joiner && (
                  <li>
                    <a
                      href={claimHref(orgSlug, competitionSlug, entry.join_code)}
                      className="text-xs font-medium text-accent-strong underline underline-offset-2"
                    >
                      {t(ui, "register.status.roster.genericClaimLink")}
                    </a>
                  </li>
                )}
              </ul>
            )}
          </div>
        )}

        {canCancelEntry(entry.status) && (
          <div className="border-t border-zinc-100 pt-3">
            <CancelEntry
              entryId={entry.id}
              token={token}
              divisionName={entry.division_name}
              refundable={entry.refund_policy.refundable}
              refundAmountFormatted={formatMinor(entry.refund_policy.amount_cents, cart.currency as Currency, locale)}
            />
          </div>
        )}
      </div>
    </li>
  );
}
