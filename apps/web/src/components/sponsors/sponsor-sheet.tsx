"use client";

// A sponsor's own page (sponsor deals PR 2, Task 15; spec §6.2, mockup screen 2 "option B"): the sponsor's details, its deals and
// its report link, opened from a row's name (`?sponsor=<id>`, lib/sponsors-hub.ts `sponsorHref`).
//
// ONE body, two wrappers. Below md (768) the page IS this screen: the list behind it is `max-md:hidden` and the body sits in the
// page with a back link. From md up it is a right-hand side panel over the list (`Modal placement="side"`). CSS alone cannot make
// one element both the in-flow page body and a focus-trapped dialog, so `SponsorSheet` picks the wrapper from `useMdUp` and the
// body (`SponsorSheetBody`) is rendered once, inside whichever it picked - never a second phone tree.
//
// `SponsorSheetBody` is STATELESS (hooks: the copy and locale reads only): OrgSponsors owns every bit of state and every write and
// hands both down, as it does for the list, so a test can expand it with `expandWithHooks`. The one stateful part is the report
// link's open/closed (`ReportLinkSection`), a leaf.
//
// Which actions a deal offers is `allowedActions(deal)` (lib/sponsor-deals.ts, the engine's answer) filtered to the ones this page
// can run; there is no client copy of the rules it reads.
import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Eye, Pencil } from "lucide-react";
import Link from "@/components/ui/console-link";
import { Modal } from "@/components/modal";
import { useMdUp } from "@/components/ui/use-md-up";
import { useLocaleOrDefault, useMsg } from "@/components/i18n/dict-provider";
import { DealChip } from "@/components/sponsors/deal-chip";
import { PayLinkBanner } from "@/components/sponsors/pay-link-banner";
import { ShareReport } from "@/components/sponsors/share-report";
import { TIER_MSG } from "@/components/sponsors/tier-labels";
import { canShowAgain, comingDeal, dealPrice, dealTierWord } from "@/components/sponsors/sponsor-list";
import type { SponsorItem } from "@/components/org-sponsors";
import { fmtPublicDate } from "@/lib/format";
import type { MessageKey } from "@/lib/messages";
import { allowedActions, DEAL_ACTIONS, isLiveDeal, isOpenDeal, type DealAction, type SponsorDeal } from "@/lib/sponsor-deals";
import type { ReportLinkDefaults, ReportLinkSummary } from "@/lib/sponsor-report";
import { dealHref } from "@/lib/sponsors-hub";

/** The deal actions this page can run. Refund is not among them: it asks about the money and lives on the deal's own page. */
export type SheetDealAction = Extract<DealAction, "send_invoice" | "resend_invoice" | "mark_paid" | "approve" | "end_now">;

/** The order the buttons are drawn in: `DEAL_ACTIONS` (the engine's order) narrowed to what this page runs. A list, not a second
 *  set of rules - whether a deal OFFERS an action is `allowedActions`. */
const SHEET_ACTIONS: readonly SheetDealAction[] = DEAL_ACTIONS.filter((a): a is SheetDealAction => a !== "refund");

const ACTION_MSG: Record<SheetDealAction, MessageKey> = {
  send_invoice: "sponsors.deal.action.sendInvoice",
  resend_invoice: "sponsors.deal.action.resendInvoice",
  mark_paid: "sponsors.deal.action.markPaid",
  approve: "sponsors.deal.action.approve",
  end_now: "sponsors.deal.action.endNow",
};

function time(d: SponsorDeal): number {
  return new Date(d.created_at).getTime();
}

/** A sponsor's deals for its page: `current` (live first, then the ones waiting to go live) and `past` (ended), each newest
 *  first. A legacy pre-deals order is an ended deal, so it is in `past`. Other sponsors' deals are not here. */
export function sponsorDealGroups(
  deals: readonly SponsorDeal[],
  sponsorId: string,
): { current: SponsorDeal[]; past: SponsorDeal[] } {
  const newestFirst = (a: SponsorDeal, b: SponsorDeal) => time(b) - time(a) || (a.id < b.id ? 1 : -1);
  const mine = deals.filter((d) => d.sponsor_id === sponsorId);
  const live = mine.filter(isLiveDeal).sort(newestFirst);
  const open = mine.filter(isOpenDeal).sort(newestFirst);
  const past = mine.filter((d) => d.deal_status === "ended").sort(newestFirst);
  return { current: [...live, ...open], past };
}

/** "northbank-print.co.uk" from a sponsor's link; the link itself when it will not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The sponsor page's card, section title and small button - the deal page (deal-page.tsx) wears the same three. */
export const CARD = "min-w-0 rounded-xl border border-slate-200 bg-white p-4";
export const SECTION_TITLE = "text-sm font-semibold text-slate-800";
export const SMALL_BTN = "btn btn-ghost px-3 py-1.5 text-xs max-md:min-h-11";

/** The wrapper: the page body below md, a right-hand side panel from md. `closeHref` is the list's URL; closing navigates there.
 *  `suspended`: another sheet (Add deal) is open over this one, so a close aimed at this one (Escape reaches both) does nothing. */
export function SponsorSheet({
  title,
  backText,
  backLabel,
  closeHref,
  suspended,
  children,
}: {
  title: string;
  backText: string;
  backLabel: string;
  closeHref: string;
  suspended: boolean;
  children: ReactNode;
}) {
  const mdUp = useMdUp();
  const router = useRouter();
  if (mdUp === true) {
    return (
      <Modal
        title={title}
        placement="side"
        onClose={() => {
          if (!suspended) router.push(closeHref);
        }}
      >
        {children}
      </Modal>
    );
  }
  // Below md, and the render the server sends (`null`: the browser has not been asked yet). The server does not know the viewport,
  // so it sends the phone body hidden from md up; a desktop never flashes it before the panel replaces it.
  return (
    <div data-testid="sponsor-sheet-page" className={mdUp === null ? "md:hidden" : undefined}>
      <Link
        href={closeHref}
        data-testid="sponsor-sheet-back"
        aria-label={backLabel}
        className="mb-3 inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-purple-700 hover:underline"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        {backText}
      </Link>
      {children}
    </div>
  );
}

export interface SponsorSheetBodyProps {
  sponsor: SponsorItem;
  /** Every deal of the org (the page's, re-read after a write); the body takes this sponsor's. */
  deals: readonly SponsorDeal[];
  orgId: string;
  orgSlug: string;
  hasTiers: boolean;
  canEdit: boolean;
  /** A write is in flight: every control that would start another is disabled. */
  busy: boolean;
  /** The zone dates are read in (the viewer's). */
  tz: string;
  competitions: { id: string; name: string }[];
  /** The Details editor is open: `renderEditor()` replaces the read-only rows. */
  editing: boolean;
  renderEditor: () => ReactNode;
  onEdit: () => void;
  onToggleStream: (next: boolean) => void;
  onShowAgain: () => void;
  onAddDeal: () => void;
  onDealAction: (deal: SponsorDeal, action: SheetDealAction) => void;
  /** The last refusal and the last "it was sent" - the page-level ones sit behind a side panel's backdrop, so the body shows them. */
  error: string | null;
  notice: string | null;
  /** The pay link the console last made, while its deal can still be paid (the page applies `payLinkStillOpen`); null shows none. */
  payLink: string | null;
  /** The sponsor's live report links (an editor's page only) and the share form's opening dates; null hides the section. */
  reportLinks: ReportLinkSummary[];
  reportDefaults: ReportLinkDefaults | null;
}

export function SponsorSheetBody(props: SponsorSheetBodyProps) {
  const {
    sponsor, deals, orgId, orgSlug, hasTiers, canEdit, busy, tz, competitions, editing, renderEditor, onEdit, onToggleStream,
    onShowAgain, onAddDeal, onDealAction, error, notice, payLink, reportLinks, reportDefaults,
  } = props;
  const msg = useMsg();
  const locale = useLocaleOrDefault();

  const { current, past } = sponsorDealGroups(deals, sponsor.id);
  const day = (iso: string | null) => fmtPublicDate(locale, tz, iso, { day: "numeric", month: "short" });
  const scopeName = (competitionId: string | null) =>
    competitionId ? (competitions.find((c) => c.id === competitionId)?.name ?? msg("sponsors.dealSheet.scopeUnknown")) : msg("sponsors.scopeAll");

  // D9 / F28: a LIVE deal owns the sponsor's tier, competition and stream, so they are shown as the deal's, read-only, with the
  // reason. A deal still waiting to go live changes none of them yet, and the line says what the deal will change when it goes live.
  // No deal, or every deal ended: the sponsor shows as it is stored (a plain Partner for the whole organisation unless it was
  // placed another way) - read-only too: no screen edits the tier or the scope, a deal sets them (owner, 2026-11-11).
  const locked = sponsor.locked_by_deal;
  const liveDeal = locked ? (current.find(isLiveDeal) ?? null) : null;
  const shownTier = liveDeal?.tier ?? sponsor.tier;
  const shownScope = liveDeal ? liveDeal.competition_id : sponsor.competition_id;
  const coming = comingDeal(sponsor);
  const tierNow = coming !== null && coming.tier !== sponsor.tier ? coming : null;
  // The same for the scope: a deal that differs from the sponsor's own placement ONLY in scope (the same tier, another competition) still
  // changes what the sponsor shows on when it goes live, and the page says so, whichever of the two moved.
  const scopeNow = coming !== null && coming.competition_id !== sponsor.competition_id ? coming : null;
  const lockNoteId = `sponsor-sheet-lock-${sponsor.id}`;
  const nameId = `sponsor-sheet-name-${sponsor.id}`;

  /** The state line under a deal's package and scope: where the money and the invoice stand. A complimentary deal has none. */
  function stateLine(d: SponsorDeal): string | null {
    if (d.deal_status === "ended") {
      return d.ended_at ? msg("sponsors.deal.subline.ended", { date: day(d.ended_at) }) : msg("sponsors.deal.chip.ended");
    }
    if (d.payment_method === "complimentary") return null;
    if (d.payment_status === "paid") return d.paid_at ? msg("sponsors.deal.subline.paid", { date: day(d.paid_at) }) : msg("sponsors.deal.chip.paid");
    if (d.payment_method === "online") {
      return d.invoice_sent_at ? msg("sponsors.deal.subline.invoiceSent", { date: day(d.invoice_sent_at) }) : msg("sponsors.deal.subline.notSent");
    }
    return msg("sponsors.deal.subline.bankTransfer");
  }

  function dealItem(d: SponsorDeal): ReactNode {
    const offered = allowedActions(d);
    const buttons = canEdit ? SHEET_ACTIONS.filter((a) => offered.includes(a)) : [];
    const state = stateLine(d);
    const price = d.payment_method === "complimentary" ? msg("sponsors.deal.subline.complimentary") : dealPrice(d, locale);
    return (
      <li key={d.id} data-testid="sponsor-sheet-deal" data-deal-id={d.id} data-deal-status={d.deal_status} className="grid min-w-0 gap-1.5 py-3">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <DealChip deal={d} />
          <span data-testid="sponsor-sheet-deal-price" className="text-sm font-medium tabular-nums text-slate-800">
            {price}
          </span>
        </div>
        <p data-testid="sponsor-sheet-deal-what" className="min-w-0 break-words text-sm text-slate-700">
          {[d.package_name, dealTierWord(d, hasTiers, msg), scopeName(d.competition_id)].filter((part) => part !== null).join(" · ")}
        </p>
        {state !== null ? (
          <p data-testid="sponsor-sheet-deal-state" className="min-w-0 break-words text-xs text-slate-500">
            {state}
          </p>
        ) : null}
        {canEdit ? (
          <div className="mt-1 flex min-w-0 flex-wrap gap-2">
            {buttons.map((a) => (
              <button
                key={a}
                type="button"
                data-testid="sponsor-sheet-deal-action"
                data-action={a}
                data-deal-id={d.id}
                disabled={busy}
                aria-label={msg("sponsors.sheet.dealActionFor", { action: msg(ACTION_MSG[a]), package: d.package_name })}
                onClick={() => onDealAction(d, a)}
                className={`btn ${a === "approve" ? "btn-primary" : "btn-ghost"} px-3 py-1.5 text-xs max-md:min-h-11 ${a === "end_now" ? "text-red-600" : ""}`}
              >
                {msg(ACTION_MSG[a])}
              </button>
            ))}
            <Link
              href={dealHref(orgSlug, sponsor.id, d.id)}
              data-testid="sponsor-sheet-deal-open"
              aria-label={msg("sponsors.sheet.dealActionFor", { action: msg("sponsors.deal.action.openDeal"), package: d.package_name })}
              className={`${SMALL_BTN} inline-flex items-center`}
            >
              {msg("sponsors.deal.action.openDeal")}
            </Link>
          </div>
        ) : null}
      </li>
    );
  }

  const addDeal = canEdit ? (
    <button type="button" data-testid="sponsor-sheet-add-deal" disabled={busy} onClick={onAddDeal} className={`${SMALL_BTN} shrink-0`}>
      {msg("sponsors.deal.action.addDeal")}
    </button>
  ) : null;
  const url = sponsor.url;

  return (
    <section data-testid="sponsor-sheet" data-sponsor-id={sponsor.id} aria-labelledby={nameId} className="grid min-w-0 gap-4">
      {/* The page-level error and notice sit behind a side panel's backdrop, so while the sheet is open the sheet shows them. The
          status line is always mounted: a live region that appears WITH its text is not reliably announced. */}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <p role="status" data-testid="sponsor-notice" className="text-sm text-emerald-700 empty:sr-only">
        {notice}
      </p>
      {payLink !== null ? <PayLinkBanner url={payLink} /> : null}

      <header className="flex min-w-0 items-center gap-3">
        {sponsor.logo_path ? (
          // Stored via content-upload - an absolute CDN URL.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={sponsor.logo_path} alt="" className="h-12 w-12 shrink-0 rounded-lg object-contain ring-1 ring-slate-200" />
        ) : (
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-slate-100 text-base font-semibold text-slate-500">
            {sponsor.name.charAt(0).toUpperCase()}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h2 id={nameId} data-testid="sponsor-sheet-name" className="min-w-0 break-words text-base font-semibold text-slate-900">
            {sponsor.name}
          </h2>
          <p data-testid="sponsor-sheet-meta" className="min-w-0 truncate text-xs text-slate-500">
            {[url ? hostOf(url) : null, msg("sponsors.clicks", { count: sponsor.click_count })].filter(Boolean).join(" · ")}
          </p>
          <div className="mt-1.5 flex min-w-0">
            <DealChip deal={sponsor.deal} />
          </div>
        </div>
      </header>

      <div data-testid="sponsor-sheet-details" className={CARD}>
        <div className="flex min-w-0 items-center justify-between gap-3">
          <h3 className={SECTION_TITLE}>{msg("sponsors.sheet.details")}</h3>
          {canEdit && !editing ? (
            <button
              type="button"
              data-testid="sponsor-sheet-edit"
              aria-label={msg("sponsors.edit", { name: sponsor.name })}
              disabled={busy}
              onClick={onEdit}
              className={`${SMALL_BTN} shrink-0`}
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden />
              {msg("sponsors.sheet.edit")}
            </button>
          ) : null}
        </div>
        {editing ? (
          <div data-testid="sponsor-sheet-editor" className="mt-3 min-w-0">
            {renderEditor()}
          </div>
        ) : (
          <>
            <dl className="mt-3 grid min-w-0 grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-sm">
              <dt className="text-slate-500">{msg("settings.org.sponsors.name")}</dt>
              <dd data-testid="sponsor-sheet-detail-name" className="min-w-0 break-words text-slate-800">
                {sponsor.name}
              </dd>
              <dt className="text-slate-500">{msg("settings.org.sponsors.link")}</dt>
              <dd data-testid="sponsor-sheet-detail-link" className="min-w-0 break-all text-slate-800">
                {url ? (
                  <a href={url} target="_blank" rel="noopener noreferrer" className="text-purple-700 underline">
                    {hostOf(url)}
                  </a>
                ) : (
                  <span className="text-slate-500">{msg("sponsors.sheet.noLink")}</span>
                )}
              </dd>
              {hasTiers ? (
                <>
                  <dt className="text-slate-500">{msg("sponsors.tierLabel")}</dt>
                  <dd data-testid="sponsor-sheet-detail-tier" className="min-w-0 text-slate-800">
                    {msg(TIER_MSG[shownTier])}
                    {tierNow !== null ? (
                      <span data-testid="sponsor-sheet-tier-now" className="mt-0.5 block text-xs text-slate-500">
                        {msg("sponsors.sheet.tierNow", { now: msg(TIER_MSG[sponsor.tier]), next: msg(TIER_MSG[tierNow.tier]) })}
                      </span>
                    ) : null}
                  </dd>
                  <dt className="text-slate-500">{msg("sponsors.scopeLabel")}</dt>
                  <dd data-testid="sponsor-sheet-detail-scope" className="min-w-0 break-words text-slate-800">
                    {scopeName(shownScope)}
                    {scopeNow !== null ? (
                      <span data-testid="sponsor-sheet-scope-now" className="mt-0.5 block text-xs text-slate-500">
                        {msg("sponsors.sheet.scopeNow", { now: scopeName(sponsor.competition_id), next: scopeName(scopeNow.competition_id) })}
                      </span>
                    ) : null}
                  </dd>
                </>
              ) : null}
              <dt className="text-slate-500">{msg("sponsors.sheet.onStream")}</dt>
              <dd className="min-w-0 text-slate-800">
                {canEdit ? (
                  <label className="inline-flex min-h-11 items-center gap-2 md:min-h-0">
                    <input
                      type="checkbox"
                      data-testid="sponsor-sheet-stream"
                      checked={sponsor.on_stream}
                      disabled={busy || locked}
                      aria-describedby={locked ? lockNoteId : undefined}
                      onChange={(e) => onToggleStream(e.target.checked)}
                      className="h-4 w-4 accent-purple-600"
                    />
                    {msg("sponsors.sheet.onStreamShow")}
                  </label>
                ) : (
                  <span data-testid="sponsor-sheet-stream-state">{sponsor.on_stream ? msg("sponsors.sheet.on") : msg("sponsors.sheet.off")}</span>
                )}
              </dd>
            </dl>
            {locked ? (
              <p id={lockNoteId} data-testid="sponsor-sheet-locked-note" className="mt-3 text-xs text-slate-500">
                {msg("sponsors.deal.lockedNote")}
              </p>
            ) : hasTiers ? (
              // The tier and the scope are read-only here and in the editor alike: a deal sets them (owner, 2026-11-11). While a live deal
              // holds them the note above already says so; otherwise this one says only WHAT sets them (a deal) - it names no button and
              // no step, so it does not tell the reader how to change them.
              <p data-testid="sponsor-sheet-placement-note" className="mt-3 text-xs text-slate-500">
                {msg("sponsors.sheet.placementNote")}
              </p>
            ) : null}
            {canEdit && canShowAgain(sponsor) ? (
              // Off the public pages with nothing holding it there: its last deal ended (or it never had one). Spec §10.3.
              <button
                type="button"
                data-testid={`sponsor-show-${sponsor.id}`}
                aria-label={msg("sponsors.showAgainLabel", { name: sponsor.name })}
                disabled={busy}
                onClick={onShowAgain}
                className={`${SMALL_BTN} mt-3 w-fit`}
              >
                <Eye className="h-3.5 w-3.5" aria-hidden />
                {msg("sponsors.showAgain")}
              </button>
            ) : null}
          </>
        )}
      </div>

      <div data-testid="sponsor-sheet-deals" className={CARD}>
        <div className="flex min-w-0 items-center justify-between gap-3">
          <h3 className={SECTION_TITLE}>{msg("sponsors.sheet.deals")}</h3>
          {current.length + past.length > 0 ? addDeal : null}
        </div>
        {current.length + past.length === 0 ? (
          <div data-testid="sponsor-sheet-no-deals" className="mt-3 grid min-w-0 justify-items-start gap-2">
            <p className="text-sm font-medium text-slate-700">{msg("sponsors.sheet.noDeals")}</p>
            <p className="text-xs text-slate-500">{msg("sponsors.sheet.noDealsHint", { name: sponsor.name })}</p>
            {addDeal}
          </div>
        ) : (
          <div className="mt-1 grid min-w-0 gap-1">
            {current.length > 0 ? (
              <div data-testid="sponsor-sheet-current" className="min-w-0">
                <p className="mt-2 text-xs font-medium text-slate-500">{msg("sponsors.sheet.current")}</p>
                <ul className="divide-y divide-slate-100">{current.map(dealItem)}</ul>
              </div>
            ) : null}
            {past.length > 0 ? (
              <div data-testid="sponsor-sheet-past" className="min-w-0">
                <p className="mt-2 text-xs font-medium text-slate-500">{msg("sponsors.sheet.past")}</p>
                <ul className="divide-y divide-slate-100">{past.map(dealItem)}</ul>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {canEdit && reportDefaults !== null ? (
        <ReportLinkSection orgId={orgId} sponsor={{ id: sponsor.id, name: sponsor.name }} links={reportLinks} defaults={reportDefaults} />
      ) : null}
    </section>
  );
}

/** The sponsor's report link (PR A's Share report, scoped to this sponsor): a private page the club sends the sponsor. Closed it
 *  says how many links are live; open it is the Overview's own `ShareReport` - the form to make one, and the live ones with Revoke. */
export function ReportLinkSection({
  orgId,
  sponsor,
  links,
  defaults,
}: {
  orgId: string;
  sponsor: { id: string; name: string };
  links: ReportLinkSummary[];
  defaults: ReportLinkDefaults;
}) {
  const msg = useMsg();
  const [open, setOpen] = useState(false);
  const panelId = `sponsor-sheet-share-${sponsor.id}`;
  return (
    <div data-testid="sponsor-sheet-report" className={CARD}>
      <div className="flex min-w-0 items-center justify-between gap-3">
        <h3 className={SECTION_TITLE}>{msg("sponsors.sheet.report")}</h3>
        <button
          type="button"
          data-testid="sponsor-sheet-share"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(!open)}
          className={`${SMALL_BTN} shrink-0`}
        >
          {msg("sponsors.overview.share")}
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-500">{msg("sponsors.sheet.reportHint", { name: sponsor.name })}</p>
      <p data-testid="sponsor-sheet-report-count" className="mt-1 text-xs text-slate-500">
        {msg("sponsors.sheet.reportLinks", { count: links.length })}
      </p>
      {open ? (
        <ShareReport
          id={panelId}
          orgId={orgId}
          sponsor={sponsor}
          defaults={defaults}
          competitionName={null}
          links={links}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}
