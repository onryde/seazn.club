"use client";

// The Sponsors tab's list (sponsor deals PR 2, Task 14; spec §6.1, mockup screen 1): the sponsors grouped by tier, each row with
// its logo, name, a sub-line about its deal, the deal's chip and at most ONE action - the one `rowNextAction` (lib/sponsor-deals.ts,
// F15) says the deal needs next. Everything else a deal can do lives on the deal (Tasks 15-17).
//
// STATELESS on purpose: its only hooks are the copy and locale reads. Every bit of state (which ⋯ is open, the list itself, the
// network) is OrgSponsors', which hands it down with the handlers; that keeps the list drivable by the tests' `expandWithHooks` and
// keeps one owner for the writes. The sub-components here are plain functions called inline, never elements, for the same reason: an
// unexpanded child is a control a test cannot reach.
//
// ONE way into a sponsor from the row, and it is the pencil (owner, 2026-11-11: "keep the pencil and remove the name link? most of
// the time, customer doesn't know where to click"): a link to the sponsor's own page with its editor open (`sponsorEditHref`, Task 15);
// a viewer's is the same button opening the page read-only (`sponsorHref`). The name is plain text. The row has no editor of its own -
// the sponsor's page owns it - and Show on site again lives there too (spec §10.3).
//
// One DOM. The way in sits in the row's lead cell, beside the ⋯, and is on screen at every width: it is what people look for, so a
// phone never makes an editor open a menu to find it. Below md (768) the clicks and the move / delete controls fold into a tray that
// is `max-md:hidden` until the ⋯ (SponsorRowMore) opens it; from md up they sit inline. The controls exist once.
import type { ReactNode } from "react";
import Link from "@/components/ui/console-link";
import { ArrowDown, ArrowUp, ChevronRight, Pencil, Trash2 } from "lucide-react";
import { useLocaleOrDefault, useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import { DealChip } from "@/components/sponsors/deal-chip";
import { priceLabel } from "@/components/sponsors/deal-copy";
import { SponsorRowMore } from "@/components/sponsors/sponsor-row-more";
import { TIER_BADGE, TIER_MSG } from "@/components/sponsors/tier-labels";
import type { SponsorItem } from "@/components/org-sponsors";
import { fmtPublicDate } from "@/lib/format";
import type { MessageKey } from "@/lib/messages";
import { isOpenDeal, rowNextAction, type RowAction, type SponsorDeal } from "@/lib/sponsor-deals";
import { SPONSOR_TIERS, type SponsorTier } from "@/lib/sponsor-tiers";
import { dealHref, sponsorEditHref, sponsorHref } from "@/lib/sponsors-hub";

/** The row actions that WRITE (the other two: Add deal opens the Add deal sheet, Open deal navigates to the deal). */
export type DealWrite = Extract<RowAction, "resend_invoice" | "mark_paid" | "approve">;

/** Can the club switch this sponsor back on by hand (spec §10.3: "After all of a sponsor's deals have ended: the club may
 *  switch the sponsor back on by hand, as for a sponsor with no deal")? Exactly where the server takes `PATCH { status:
 *  "active" }` (server/usecases/sponsors.ts `patchSponsor`): the sponsor is off (`inactive`; a dispute-parked one is `pending`
 *  and refused), and no live deal (409 sponsor_locked_by_deal) or deal waiting to go live (409 sponsor_has_open_deal) holds
 *  its status. */
export function canShowAgain(s: SponsorItem): boolean {
  return s.status === "inactive" && !s.locked_by_deal && !s.has_open_deal;
}

/** The group a sponsor's row is drawn in: the tier it shows at NOW - the sponsor's own, which is what the public board draws (a live
 *  deal sets it, D9, so a live deal's row is where its deal's tier puts it). A deal still waiting to go live changes nothing yet, so
 *  its sponsor stays where it is and the row says what is coming (`tierComing`) - owner, 2026-11-11: a title package that is not paid
 *  must not list the sponsor under Title while the page and the board show a Partner. The move buttons swap within the same group,
 *  so they read this too. */
export function groupTierOf(s: SponsorItem): SponsorTier {
  return s.tier;
}

/** The deal that will change this sponsor's placement when it goes live: it waits to go live (no live deal holds the sponsor). The
 *  list's hint and the sponsor's page both read it, so the two cannot disagree about which deal is "coming". */
export function comingDeal(s: SponsorItem): SponsorDeal | null {
  return !s.locked_by_deal && s.has_open_deal && s.deal !== null && isOpenDeal(s.deal) ? s.deal : null;
}

/** The tier this sponsor moves to when its waiting deal goes live, or null when nothing is coming or the deal's tier is the one it
 *  already shows at. */
export function tierComing(s: SponsorItem): SponsorTier | null {
  const next = comingDeal(s);
  return next !== null && next.tier !== s.tier ? next.tier : null;
}

/** Can two NEIGHBOURS in a drawn list swap places? The server reads the list ordered by the sponsor's STORED tier, then
 *  display_order (server/usecases/sponsors.ts list), so two rows have an order between them only when that stored tier is the
 *  same. With tiers the groups ARE stored-tier bands, so this is true inside one; it still decides for the plan WITHOUT tiers, whose
 *  one flat list can hold sponsors stored at different tiers (an organisation that came down from a paid plan): a swap between
 *  those would be drawn, persisted, and snap back on the next read. The arrows and `move()` both ask this. */
export function sameOrderBand(a: SponsorItem, b: SponsorItem): boolean {
  return a.tier === b.tier;
}

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** The tier word that rides beside a deal's package name ("Testing001 Gold · Title · £20"), or null when there is none to say. A plan
 *  without tiers has none to show for a Partner deal - the sponsor page's own Tier row is not drawn there either - but a deal that
 *  carries a higher tier (one placed while the plan had tiers, or on an Event Pass competition) still says so. And a package named
 *  for its own tier ("Partner") would read "Partner · Partner", so the word is left off then. */
export function dealTierWord(d: Pick<SponsorDeal, "tier" | "package_name">, hasTiers: boolean, msg: Msg): string | null {
  if (!hasTiers && d.tier === "partner") return null;
  const word = msg(TIER_MSG[d.tier]);
  return d.package_name.trim().toLowerCase() === word.toLowerCase() ? null : word;
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
  /** The row whose ⋯ is open (below md its tray shows). */
  moreOpenId: string | null;
  onToggleMore: (id: string) => void;
  onMove: (id: string, delta: -1 | 1) => void;
  onRemove: (s: SponsorItem) => void;
  onAction: (s: SponsorItem, action: DealWrite) => void;
  /** Add deal opens the Add deal sheet for this sponsor (Task 16); it writes nothing itself. */
  onAddDeal: (s: SponsorItem) => void;
}

const ACTION_MSG: Record<RowAction, MessageKey> = {
  add_deal: "sponsors.deal.action.addDeal",
  open_deal: "sponsors.deal.action.openDeal",
  resend_invoice: "sponsors.deal.action.resendInvoice",
  mark_paid: "sponsors.deal.action.markPaid",
  approve: "sponsors.deal.action.approve",
};

/** "northbank-print.co.uk" from a sponsor's link; the link itself when it will not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A deal's price as its row shows it (`priceLabel`). Exported for the Mark as paid confirm, which names the same amount. */
export function dealPrice(d: SponsorDeal, locale: string): string {
  return priceLabel(locale, d.amount_cents, d.currency);
}

/** The sub-line (mockup screen 1): `package · tier · price · scope` for a live deal, and for every other state the last part says where
 *  the deal stands (invoice sent, paid, bank transfer, not sent yet, ended); a sponsor with no deal reads `No deal · host`. The tier
 *  word is the DEAL's (`dealTierWord`), so a waiting title deal reads "Title" here while the row sits under the tier it shows at now. */
function subline(
  s: SponsorItem,
  ctx: { msg: Msg; locale: string; tz: string; competitions: { id: string; name: string }[]; hasTiers: boolean },
): string {
  const { msg, locale, tz, competitions, hasTiers } = ctx;
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
  return [d.package_name, dealTierWord(d, hasTiers, msg), paidFor, tail].filter((part) => part !== null).join(" · ");
}

const ICON_BUTTON =
  "grid h-7 w-7 place-items-center rounded text-slate-500 hover:bg-purple-50 hover:text-purple-700 disabled:opacity-30 max-md:h-11 max-md:w-11";

export function SponsorList(props: SponsorListProps) {
  const {
    sponsors, hasTiers, canEdit, busy, orgSlug, tz, competitions, moreOpenId, onToggleMore, onMove, onRemove, onAction, onAddDeal,
  } = props;
  const msg = useMsg();
  const plural = useMsgPlural();
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
        <button type="button" disabled={busy} onClick={() => onAddDeal(s)} {...common}>
          {label}
        </button>
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
    // A chip may shrink and truncate: a `shrink-0` one held its width in a name column that is 130px on a 320 phone and ran under the
    // pencil beside it (a longer word - French, Dutch - or "Disputed - parked" did). `max-w-full` caps it at the name line; the flex-wrap
    // line it sits in puts it under the name first.
    const cls = "min-w-0 max-w-full truncate rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase";
    // The `title` holds the same words in full: a chip that was cut ("En disputa - ret...") can still be read on hover or long-press.
    const chip = (words: string, tone: string) => (
      <span data-testid="sponsor-row-badge" title={words} className={`${cls} ${tone}`}>{words}</span>
    );
    if (s.dispute_lost) {
      // The activating order was written off by a lost dispute - the placement stays down; say why.
      return chip(msg("sponsors.lostBadge"), "bg-rose-200 text-rose-900");
    }
    if (s.dispute_parked) {
      // Parked by an open payment dispute - the handler took it down; it returns if the dispute is won.
      return chip(msg("sponsors.parkedBadge"), "bg-rose-100 text-rose-700");
    }
    if (s.paid_order_id) {
      // Bought through a package - ties the sponsor list back to the Sell section's orders.
      return chip(msg("sponsors.paidBadge"), "bg-emerald-50 text-emerald-700");
    }
    return null;
  }

  /** "Title when live": the sponsor's waiting deal will move it to another tier than the group it is drawn in. Only where groups are
   *  drawn (a plan with tiers), and never for a live deal (it already is where it says) or an ended one. */
  function tierHint(s: SponsorItem): ReactNode {
    const next = hasTiers ? tierComing(s) : null;
    if (next === null) return null;
    const words = msg("sponsors.row.tierWhenLive", { tier: msg(TIER_MSG[next]) });
    return (
      <span
        data-testid="sponsor-row-tier-hint"
        data-tier={next}
        title={words}
        className={`min-w-0 max-w-full truncate rounded-full px-2 py-0.5 text-[10px] font-medium ${TIER_BADGE[next]}`}
      >
        {words}
      </span>
    );
  }

  function row(s: SponsorItem, group: SponsorItem[], index: number): ReactNode {
    const open = moreOpenId === s.id;
    const trayId = `sponsor-tools-${s.id}`;
    // The tray folds only where there is a ⋯ to open it: a viewer has no controls to fold, so the clicks stay put for them.
    const folded = canEdit && !open;
    // "1 click" / "41 clicks": the number says what it counts, in the words of the locale's plural rule (owner, 2026-11-11: a bare
    // pointer icon and a number was not read as a count of anything).
    const clicks = plural("sponsors.row.clicks", s.click_count);
    // The arrows swap a sponsor with its neighbour in the same group. A group of one has nobody to swap with, so there is nothing to
    // show - not a pair of dead buttons (owner, 2026-11-11). A group of two or more keeps both, the one at an edge disabled.
    const canReorder = group.length > 1;
    const moveUp = msg("settings.org.sponsors.moveUp", { name: s.name });
    const moveDown = msg("settings.org.sponsors.moveDown", { name: s.name });
    return (
      <li key={s.id} data-testid="sponsor-row" data-sponsor-id={s.id} className="px-3 py-2.5">
        <div
          data-testid="sponsor-row-grid"
          className="grid grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 max-[376px]:grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[2.25rem_minmax(0,1fr)_auto_auto_auto]"
        >
          {/* Below 376 (a 320, 360 or 375 phone: the commonest widths) the logo tile goes (the name needs the 48px, and the tile is
              decoration), the grid is name + pencil, the deal and tray cells start at the first column, and the name and the sub-line
              may take two lines. From 376 it is the row it was. `max-[376px]` is "width < 376" in Tailwind v4. */}
          {s.logo_path ? (
            // Stored via content-upload - an absolute CDN URL.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={s.logo_path} alt="" data-testid="sponsor-row-logo" className="h-9 w-9 rounded object-contain ring-1 ring-slate-200 max-[376px]:hidden" />
          ) : (
            <span data-testid="sponsor-row-logo" className="grid h-9 w-9 place-items-center rounded bg-slate-100 text-xs font-semibold text-slate-500 max-[376px]:hidden">
              {s.name.charAt(0).toUpperCase()}
            </span>
          )}
          <div data-testid="sponsor-row-main" className="min-w-0">
            {/* A badge (Disputed - parked, Paid ...) wraps under the name instead of squeezing it to "O..." in a 160px column. */}
            <p data-testid="sponsor-row-name" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium text-slate-800">
              {/* Plain text: the pencil is the one way into the sponsor (a name that looked like a link was the thing people did not find). */}
              <span data-testid="sponsor-row-name-text" className="block min-w-0 max-w-full truncate max-[376px]:line-clamp-2 max-[376px]:whitespace-normal max-[376px]:break-words">
                {s.name}
              </span>
              {badge(s)}
              {tierHint(s)}
            </p>
            <p data-testid="sponsor-row-sub" className="truncate text-xs text-slate-500 max-[376px]:line-clamp-2 max-[376px]:whitespace-normal max-[376px]:break-words">
              {subline(s, { msg, locale, tz, competitions, hasTiers })}
            </p>
          </div>
          {/* The lead cell: the one way in, then (below md, editors only) the ⋯ that opens the rest. Never folded - see the header. */}
          <div data-testid="sponsor-row-lead" className="flex items-center">
            {canEdit ? (
              <Link href={sponsorEditHref(orgSlug, s.id)} data-testid="sponsor-row-edit" aria-label={msg("sponsors.edit", { name: s.name })} className={ICON_BUTTON}>
                <Pencil className="h-3.5 w-3.5" />
              </Link>
            ) : (
              <Link href={sponsorHref(orgSlug, s.id)} data-testid="sponsor-row-open" aria-label={msg("sponsors.open", { name: s.name })} className={ICON_BUTTON}>
                <ChevronRight className="h-4 w-4" />
              </Link>
            )}
            {canEdit ? <SponsorRowMore name={s.name} open={open} controlsId={trayId} onToggle={() => onToggleMore(s.id)} /> : null}
          </div>
          <div
            data-testid="sponsor-row-deal"
            className="col-span-2 col-start-2 flex min-w-0 flex-wrap items-center justify-between gap-2 max-[376px]:col-start-1 md:col-span-1 md:col-start-auto md:w-72"
          >
            <DealChip deal={s.deal} />
            {action(s)}
          </div>
          <div
            id={trayId}
            data-testid="sponsor-row-tools"
            className={`col-span-2 col-start-2 flex min-w-0 flex-wrap items-center gap-1 max-[376px]:col-start-1 md:col-span-1 md:col-start-auto md:shrink-0 md:flex-nowrap md:justify-end ${folded ? "max-md:hidden" : ""}`}
          >
            {/* The visible words ARE the accessible name ("41 clicks"), so a screen reader keeps the count; the title says what a click is.
                No icon: the words carry it, and 768-1279 has no spare width for both beside the deal cell. */}
            {/* From md the label sits in a box of one fixed least width, text to the right, so "1 click" and "41 clicks" take the same room and
                the controls after it - and, because the tray is the last column, the pencil and the deal cell before it - stand in the same
                place on every row. 5rem holds "999 klikken" (the longest of the four languages) with room to spare. */}
            <span
              data-testid="sponsor-row-clicks"
              className="shrink-0 whitespace-nowrap pr-2 text-xs tabular-nums text-slate-500 md:min-w-[5rem] md:text-right"
              title={msg("sponsors.row.clicksHint")}
            >
              {clicks}
            </span>
            {canEdit ? (
              <>
                {canReorder ? (
                  <>
                    <button
                      type="button"
                      title={moveUp}
                      aria-label={moveUp}
                      disabled={busy || index === 0 || !sameOrderBand(group[index - 1]!, s)}
                      onClick={() => onMove(s.id, -1)}
                      className={ICON_BUTTON}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      title={moveDown}
                      aria-label={moveDown}
                      disabled={busy || index === group.length - 1 || !sameOrderBand(group[index + 1]!, s)}
                      onClick={() => onMove(s.id, 1)}
                      className={ICON_BUTTON}
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : (
                  // A group of one draws NO arrows (nothing to swap with), but from md the room they would take stays, so this row's tray is
                  // as wide as its neighbours' and the columns line up. Two 28px buttons and the 4px gap between them: 3.75rem. Not a
                  // control: aria-hidden, nothing focusable in it, and gone below md (a phone's tray wraps and has no columns to keep).
                  <div data-testid="sponsor-row-move-spacer" aria-hidden="true" className="shrink-0 max-md:hidden md:w-[3.75rem]" />
                )}
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
