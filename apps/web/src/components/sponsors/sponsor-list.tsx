"use client";

// The Sponsors tab's list (sponsor deals PR 2, Task 14; spec §6.1, mockup screen 1): the sponsors grouped by tier, each row with
// its logo, name, a sub-line about its deal, the deal's chip and at most ONE action - the one `rowNextAction` (lib/sponsor-deals.ts,
// F15) says the deal needs next. Everything else a deal can do lives on the deal (Tasks 15-17).
//
// STATELESS on purpose: its only hooks are the copy and locale reads. Every bit of state (which row is being edited, which ⋯ is open,
// the list itself, the network) is OrgSponsors', which hands it down with the handlers; that keeps the list drivable by the tests'
// `expandWithHooks` and keeps one owner for the writes. The sub-components here are plain functions called inline, never elements,
// for the same reason: an unexpanded child is a control a test cannot reach.
//
// The name is a link to the sponsor's own page (`sponsorHref`, Task 15), and Show on site again lives there now (spec §10.3).
//
// One DOM. Below md (768) the clicks and the edit / move / delete controls fold into a tray that is `max-md:hidden` until the ⋯
// (SponsorRowMore) opens it; from md up they sit inline. The controls exist once.
import type { ReactNode } from "react";
import Link from "@/components/ui/console-link";
import { ArrowDown, ArrowUp, MousePointerClick, Pencil, Trash2 } from "lucide-react";
import { useLocaleOrDefault, useMsg } from "@/components/i18n/dict-provider";
import { DealChip } from "@/components/sponsors/deal-chip";
import { SponsorRowMore } from "@/components/sponsors/sponsor-row-more";
import { TIER_BADGE, TIER_MSG } from "@/components/sponsors/tier-labels";
import type { SponsorItem } from "@/components/org-sponsors";
import { fmtNumber, fmtPublicDate } from "@/lib/format";
import type { MessageKey } from "@/lib/messages";
import { rowNextAction, type RowAction, type SponsorDeal } from "@/lib/sponsor-deals";
import { SPONSOR_TIERS, type SponsorTier } from "@/lib/sponsor-tiers";
import { dealHref, sponsorHref } from "@/lib/sponsors-hub";

/** The row actions that WRITE (the other two, Add deal and Open deal, navigate). */
export type DealWrite = Extract<RowAction, "resend_invoice" | "mark_paid" | "approve">;

/** Can the club switch this sponsor back on by hand (spec §10.3: "After all of a sponsor's deals have ended: the club may
 *  switch the sponsor back on by hand, as for a sponsor with no deal")? Exactly where the server takes `PATCH { status:
 *  "active" }` (server/usecases/sponsors.ts `patchSponsor`): the sponsor is off (`inactive`; a dispute-parked one is `pending`
 *  and refused), and no live deal (409 sponsor_locked_by_deal) or deal waiting to go live (409 sponsor_has_open_deal) holds
 *  its status. */
export function canShowAgain(s: SponsorItem): boolean {
  return s.status === "inactive" && !s.locked_by_deal && !s.has_open_deal;
}

/** The group a sponsor's row is drawn in: its deal's tier (even before the deal is live - the chip says whether it is), else the
 *  sponsor's own. The move buttons swap within the same group, so they read this too. */
export function groupTierOf(s: SponsorItem): SponsorTier {
  return s.deal?.tier ?? s.tier;
}

/** Can two NEIGHBOURS in a drawn group swap places? The server reads the list ordered by the sponsor's STORED tier, then
 *  display_order (server/usecases/sponsors.ts list), so two rows have an order between them only when that stored tier is the
 *  same. A native-gold sponsor and a partner with a gold deal share the Gold group but not an order: a swap between them would be
 *  drawn, persisted, and snap back on the next read. The arrows and `move()` both ask this. */
export function sameOrderBand(a: SponsorItem, b: SponsorItem): boolean {
  return a.tier === b.tier;
}

export interface SponsorListProps {
  /** In the order they were read (the server's tier-then-order list); the list groups them without reordering within a group. */
  sponsors: SponsorItem[];
  hasTiers: boolean;
  canEdit: boolean;
  /** A write is in flight: every control that would start another is disabled. */
  busy: boolean;
  orgSlug: string;
  /** The zone dates are read in (the viewer's). */
  tz: string;
  competitions: { id: string; name: string }[];
  /** The row being edited, drawn as `renderEditor(row)` in place of its content. */
  editingId: string | null;
  renderEditor: (s: SponsorItem) => ReactNode;
  /** The row whose ⋯ is open (below md its tray shows). */
  moreOpenId: string | null;
  onToggleMore: (id: string) => void;
  onEdit: (s: SponsorItem) => void;
  onMove: (id: string, delta: -1 | 1) => void;
  onRemove: (s: SponsorItem) => void;
  onAction: (s: SponsorItem, action: DealWrite) => void;
}

const ACTION_MSG: Record<RowAction, MessageKey> = {
  add_deal: "sponsors.deal.action.addDeal",
  open_deal: "sponsors.deal.action.openDeal",
  resend_invoice: "sponsors.deal.action.resendInvoice",
  mark_paid: "sponsors.deal.action.markPaid",
  approve: "sponsors.deal.action.approve",
};

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** "northbank-print.co.uk" from a sponsor's link; the link itself when it will not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** £1,500 / £120.50: whole amounts drop the pence, the way the mockup writes them. Exported for the Mark as paid confirm, which
 *  names the same amount the row shows. */
export function dealPrice(d: SponsorDeal, locale: string): string {
  const whole = d.amount_cents % 100 === 0;
  try {
    return fmtNumber(locale, d.amount_cents / 100, {
      style: "currency",
      currency: d.currency.toUpperCase(),
      minimumFractionDigits: whole ? 0 : 2,
    });
  } catch {
    return `${(d.amount_cents / 100).toFixed(2)} ${d.currency.toUpperCase()}`;
  }
}

/** The sub-line (mockup screen 1): `package · price · scope` for a live deal, and for every other state the third part says where
 *  the deal stands (invoice sent, paid, bank transfer, not sent yet, ended); a sponsor with no deal reads `No deal · host`. */
function subline(s: SponsorItem, ctx: { msg: Msg; locale: string; tz: string; competitions: { id: string; name: string }[] }): string {
  const { msg, locale, tz, competitions } = ctx;
  const d = s.deal;
  if (d === null) {
    const none = msg("sponsors.deal.chip.none");
    return s.url ? `${none} · ${hostOf(s.url)}` : none;
  }
  const day = (iso: string | null) => fmtPublicDate(locale, tz, iso, { day: "numeric", month: "short" });
  const scope = d.competition_id ? (competitions.find((c) => c.id === d.competition_id)?.name ?? "…") : msg("sponsors.scopeAll");
  const paidFor = d.payment_method === "complimentary" ? msg("sponsors.deal.subline.complimentary") : dealPrice(d, locale);
  let tail: string;
  if (d.deal_status === "ended") {
    tail = d.ended_at ? msg("sponsors.deal.subline.ended", { date: day(d.ended_at) }) : msg("sponsors.deal.chip.ended");
  } else if (d.deal_status === "live") {
    tail = scope;
  } else if (d.payment_status === "paid") {
    tail = d.paid_at ? msg("sponsors.deal.subline.paid", { date: day(d.paid_at) }) : msg("sponsors.deal.chip.paid");
  } else if (d.payment_method === "complimentary") {
    tail = scope;
  } else if (d.payment_method === "online") {
    tail = d.invoice_sent_at ? msg("sponsors.deal.subline.invoiceSent", { date: day(d.invoice_sent_at) }) : msg("sponsors.deal.subline.notSent");
  } else {
    tail = msg("sponsors.deal.subline.bankTransfer");
  }
  return [d.package_name, paidFor, tail].join(" · ");
}

const ICON_BUTTON =
  "grid h-7 w-7 place-items-center rounded text-slate-500 hover:bg-purple-50 hover:text-purple-700 disabled:opacity-30 max-md:h-11 max-md:w-11";

export function SponsorList(props: SponsorListProps) {
  const {
    sponsors, hasTiers, canEdit, busy, orgSlug, tz, competitions, editingId, renderEditor, moreOpenId, onToggleMore, onEdit, onMove,
    onRemove, onAction,
  } = props;
  const msg = useMsg();
  const locale = useLocaleOrDefault();

  if (sponsors.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-400">{msg("sponsors.empty")}</p>
    );
  }

  /** The one action a row offers an editor, or nothing: a viewer sees no action, and the live rows need none. */
  function action(s: SponsorItem): ReactNode {
    if (!canEdit) return null;
    const next = rowNextAction(s.deal);
    if (next === null) return null;
    const label = msg(ACTION_MSG[next]);
    const common = {
      "data-testid": "sponsor-row-action",
      "data-action": next,
      "aria-label": msg("sponsors.deal.action.for", { action: label, name: s.name }),
      className: `btn ${next === "approve" ? "btn-primary" : "btn-ghost"} px-3 py-1.5 text-xs max-md:min-h-11`,
    } as const;
    if (next === "add_deal") {
      return (
        <Link href={sponsorHref(orgSlug, s.id)} {...common}>
          {label}
        </Link>
      );
    }
    if (next === "open_deal") {
      // `rowNextAction` only answers open_deal for a deal, so `s.deal` is there; the href needs its id.
      return (
        <Link href={dealHref(orgSlug, s.id, s.deal!.id)} {...common}>
          {label}
        </Link>
      );
    }
    return (
      <button type="button" disabled={busy} onClick={() => onAction(s, next)} {...common}>
        {label}
      </button>
    );
  }

  function badge(s: SponsorItem): ReactNode {
    const cls = "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase";
    if (s.dispute_lost) {
      // The activating order was written off by a lost dispute - the placement stays down; say why.
      return <span className={`${cls} bg-rose-200 text-rose-900`}>{msg("sponsors.lostBadge")}</span>;
    }
    if (s.dispute_parked) {
      // Parked by an open payment dispute - the handler took it down; it returns if the dispute is won.
      return <span className={`${cls} bg-rose-100 text-rose-700`}>{msg("sponsors.parkedBadge")}</span>;
    }
    if (s.paid_order_id) {
      // Bought through a package - ties the sponsor list back to the Sell section's orders.
      return <span className={`${cls} bg-emerald-50 text-emerald-700`}>{msg("sponsors.paidBadge")}</span>;
    }
    return null;
  }

  function row(s: SponsorItem, group: SponsorItem[], index: number): ReactNode {
    const open = moreOpenId === s.id;
    const trayId = `sponsor-tools-${s.id}`;
    // The tray folds only where there is a ⋯ to open it: a viewer has no controls to fold, so the clicks stay put for them.
    const folded = canEdit && !open;
    const clicks = msg("sponsors.clicks", { count: s.click_count });
    return (
      <li key={s.id} data-testid="sponsor-row" data-sponsor-id={s.id} className="px-3 py-2.5">
        {editingId === s.id ? (
          renderEditor(s)
        ) : (
          <div
            data-testid="sponsor-row-grid"
            className="grid grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 md:grid-cols-[2.25rem_minmax(0,1fr)_auto_auto]"
          >
            {s.logo_path ? (
              // Stored via content-upload - an absolute CDN URL.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={s.logo_path} alt="" className="h-9 w-9 rounded object-contain ring-1 ring-slate-200" />
            ) : (
              <span className="grid h-9 w-9 place-items-center rounded bg-slate-100 text-xs font-semibold text-slate-500">
                {s.name.charAt(0).toUpperCase()}
              </span>
            )}
            <div data-testid="sponsor-row-main" className="min-w-0">
              {/* A badge (Disputed - parked, Paid ...) wraps under the name instead of squeezing it to "O..." in a 160px column. */}
              <p data-testid="sponsor-row-name" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium text-slate-800">
                {/* The name opens the sponsor's own page (Task 15). On a phone the link's tap area grows to 44px with padding that a
                    negative margin takes back, so the row does not get taller; `relative z-[1]` keeps that padding on top of the
                    sub-line it overlaps, or the lower half of the tap area would hit the sub-line instead of the link. */}
                <Link
                  href={sponsorHref(orgSlug, s.id)}
                  data-testid="sponsor-row-name-link"
                  className="relative z-[1] block min-w-0 max-w-full hover:text-purple-700 hover:underline max-md:-my-3 max-md:py-3"
                >
                  <span data-testid="sponsor-row-name-text" className="block min-w-0 max-w-full truncate">
                    {s.name}
                  </span>
                </Link>
                {badge(s)}
              </p>
              <p data-testid="sponsor-row-sub" className="truncate text-xs text-slate-500">
                {subline(s, { msg, locale, tz, competitions })}
              </p>
            </div>
            {canEdit ? <SponsorRowMore name={s.name} open={open} controlsId={trayId} onToggle={() => onToggleMore(s.id)} /> : null}
            <div
              data-testid="sponsor-row-deal"
              className="col-span-2 col-start-2 flex min-w-0 flex-wrap items-center justify-between gap-2 md:col-span-1 md:col-start-auto md:w-72"
            >
              <DealChip deal={s.deal} />
              {action(s)}
            </div>
            <div
              id={trayId}
              data-testid="sponsor-row-tools"
              className={`col-span-2 col-start-2 flex min-w-0 flex-wrap items-center gap-1 md:col-span-1 md:col-start-auto md:shrink-0 md:flex-nowrap md:justify-end ${folded ? "max-md:hidden" : ""}`}
            >
              <span
                data-testid="sponsor-row-clicks"
                className="flex shrink-0 items-center gap-1 pr-2 text-xs tabular-nums text-slate-500"
                title={clicks}
                aria-label={clicks}
              >
                <MousePointerClick className="h-3.5 w-3.5" strokeWidth={1.75} />
                {s.click_count}
              </span>
              {canEdit ? (
                <>
                  <button type="button" aria-label={msg("sponsors.edit", { name: s.name })} disabled={busy} onClick={() => onEdit(s)} className={ICON_BUTTON}>
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={msg("settings.org.sponsors.moveUp", { name: s.name })}
                    disabled={busy || index === 0 || !sameOrderBand(group[index - 1]!, s)}
                    onClick={() => onMove(s.id, -1)}
                    className={ICON_BUTTON}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={msg("settings.org.sponsors.moveDown", { name: s.name })}
                    disabled={busy || index === group.length - 1 || !sameOrderBand(group[index + 1]!, s)}
                    onClick={() => onMove(s.id, 1)}
                    className={ICON_BUTTON}
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={msg("settings.org.sponsors.remove", { name: s.name })}
                    disabled={busy}
                    onClick={() => onRemove(s)}
                    className="grid h-7 w-7 place-items-center rounded text-red-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-30 max-md:h-11 max-md:w-11"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              ) : null}
            </div>
          </div>
        )}
      </li>
    );
  }

  const list = (rows: SponsorItem[]) => (
    <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">{rows.map((s, i) => row(s, rows, i))}</ul>
  );

  if (!hasTiers) return <div className="space-y-5">{list(sponsors)}</div>;

  // Render in tier order; a group nobody is in is not drawn.
  return (
    <div className="space-y-5">
      {SPONSOR_TIERS.map((tier) => ({ tier, rows: sponsors.filter((s) => groupTierOf(s) === tier) }))
        .filter(({ rows }) => rows.length > 0)
        .map(({ tier, rows }) => (
          <div key={tier} data-testid="sponsor-group" data-tier={tier}>
            <p
              data-testid="sponsor-group-header"
              className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500"
            >
              {msg(TIER_MSG[tier])}
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${TIER_BADGE[tier]}`}>{rows.length}</span>
            </p>
            {list(rows)}
          </div>
        ))}
    </div>
  );
}
