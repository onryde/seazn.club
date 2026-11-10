"use client";

// One deal's own page (sponsor deals PR 2, Task 17; spec §6.5, mockup screen 5), opened from a deal's "Open deal" link
// (`?sponsor=<id>&deal=<id>`, lib/sponsors-hub.ts `dealHref`): what the deal is, what it is waiting on, what the club can do about it,
// and what going live switches on.
//
// The wrapper is the sponsor page's (`SponsorSheet`: the page body below md with a back link, a right-hand side panel from md); this
// file is the BODY. It is STATELESS (hooks: the copy and locale reads only): OrgSponsors owns every bit of state and every write and
// hands both down, as it does for the sponsor page, so a test can expand it with `expandWithHooks`.
//
// Which actions the deal offers is `allowedActions(deal)` (lib/sponsor-deals.ts, the engine's answer), drawn in `DEAL_ACTIONS` order
// (F27); there is no client copy of the rules it reads. Evidence pack is the one control that is not a DealAction: it is a download,
// and it comes after the actions, only while a dispute is open. The timeline is `dealTimeline` (the engine's steps and their states);
// this file only words them.
//
// Layout: ONE column in both wrappers. The mockup's two-column desktop (timeline beside the facts) is a VIEWPORT query, and the same
// body also sits in a 360px side panel at 1280, so the columns would be squeezed exactly where there is least room.
import type { ReactNode } from "react";
import { Check, X } from "lucide-react";
import { useLocaleOrDefault, useMsg } from "@/components/i18n/dict-provider";
import { DealChip } from "@/components/sponsors/deal-chip";
import { PayLinkBanner } from "@/components/sponsors/pay-link-banner";
import { CARD, SECTION_TITLE, SMALL_BTN } from "@/components/sponsors/sponsor-sheet";
import { dealPrice } from "@/components/sponsors/sponsor-list";
import { TIER_BADGE, TIER_MSG } from "@/components/sponsors/tier-labels";
import { CHIP_BASE } from "@/components/ui/status-chip-style";
import { fmtPublicDate } from "@/lib/format";
import type { MessageKey } from "@/lib/messages";
import {
  allowedActions, DEAL_ACTIONS, dealTimeline, type DealAction, type EndReason, type GoLiveRule, type PaymentMethod, type SponsorDeal,
  type TimelineStep,
} from "@/lib/sponsor-deals";

const ACTION_MSG: Record<DealAction, MessageKey> = {
  send_invoice: "sponsors.deal.action.sendInvoice",
  resend_invoice: "sponsors.deal.action.resendInvoice",
  mark_paid: "sponsors.deal.action.markPaid",
  approve: "sponsors.deal.action.approve",
  refund: "sponsors.deal.action.refund",
  end_now: "sponsors.deal.action.endNow",
};

/** Why a deal ended, in words. A Record, so a reason the engine grows without words does not compile. */
const REASON_MSG: Record<EndReason, MessageKey> = {
  refunded: "sponsors.deal.timeline.reason.refunded",
  dispute_lost: "sponsors.deal.timeline.reason.disputeLost",
  ended_now: "sponsors.deal.timeline.reason.endedNow",
  expired: "sponsors.deal.timeline.reason.expired",
  competition_finished: "sponsors.deal.timeline.reason.competitionFinished",
  legacy: "sponsors.deal.timeline.reason.legacy",
  duplicate_payment: "sponsors.deal.timeline.reason.duplicatePayment",
};

const PAYMENT_MSG: Record<PaymentMethod, MessageKey> = {
  online: "sponsors.dealSheet.pay.online.title",
  offline: "sponsors.dealSheet.pay.offline.title",
  complimentary: "sponsors.dealSheet.pay.complimentary.title",
};

const GO_LIVE_MSG: Record<GoLiveRule, MessageKey> = {
  on_payment: "sponsors.dealSheet.live.onPayment.title",
  immediate: "sponsors.dealSheet.live.immediate.title",
  on_approval: "sponsors.dealSheet.live.onApproval.title",
};

/** The dot, the title and the rail of each timeline state. `next` is the page's one loud thing: the step the deal is waiting on. */
const STEP_STYLE: Record<TimelineStep["state"], { dot: string; title: string; rail: string }> = {
  done: { dot: "bg-emerald-500 text-white", title: "font-semibold text-slate-800", rail: "bg-emerald-200" },
  next: { dot: "border-[5px] border-purple-600 bg-white ring-4 ring-purple-100", title: "font-semibold text-purple-700", rail: "bg-slate-200" },
  not_yet: { dot: "border-2 border-dashed border-slate-300 bg-white", title: "font-medium text-slate-500", rail: "bg-slate-200" },
  missed: { dot: "bg-slate-200 text-slate-500", title: "font-medium text-slate-500", rail: "bg-slate-200" },
  // Never drawn (the timeline filters it out); a Record, so a state without a style does not compile.
  skipped: { dot: "", title: "", rail: "" },
};

const DATE = { day: "numeric", month: "short", year: "numeric" } as const;

export interface DealPageBodyProps {
  deal: SponsorDeal;
  /** The sponsor's current name: it heads the page and names the sponsor in the timeline's sentences. */
  sponsorName: string;
  orgId: string;
  canEdit: boolean;
  /** A write is in flight: every control that would start another is disabled. */
  busy: boolean;
  /** The zone dates are read in (the viewer's). */
  tz: string;
  /** `ends_on`: a competition's end date (YYYY-MM-DD) or null, shown beside "ends with the competition". */
  competitions: { id: string; name: string; ends_on?: string | null }[];
  /** The creator's display name, or null when it could not be resolved (a removed member, a deleted user). */
  createdBy: string | null;
  /** The desk's answer (the competition's derived phase), never the date: this deal's competition has finished. */
  competitionFinished: boolean;
  /** The pay link the console last made for THIS deal, while it can still be paid; null shows none. */
  payLink: string | null;
  /** The last refusal and the last "it was sent" - the page-level ones sit behind a side panel's backdrop, so the body shows them. */
  error: string | null;
  notice: string | null;
  onAction: (deal: SponsorDeal, action: DealAction) => void;
}

export function DealPageBody(props: DealPageBodyProps) {
  const { deal, sponsorName, orgId, canEdit, busy, tz, competitions, createdBy, competitionFinished, payLink, error, notice, onAction } = props;
  const msg = useMsg();
  const locale = useLocaleOrDefault();

  const day = (iso: string | null) => (iso === null ? null : fmtPublicDate(locale, tz, iso, DATE));
  // A competition's end date is a calendar day, not an instant: read it at noon UTC in UTC so no zone moves it.
  const calendarDay = (ymd: string) => fmtPublicDate(locale, "UTC", `${ymd}T12:00:00Z`, DATE);
  const scopeName = (competitionId: string | null) =>
    competitionId ? (competitions.find((c) => c.id === competitionId)?.name ?? "…") : msg("sponsors.scopeAll");
  const join = (...parts: (string | null)[]) => parts.filter((p): p is string => Boolean(p)).join(" · ");

  const complimentary = deal.payment_method === "complimentary";
  const amount = dealPrice(deal, locale);
  const price = complimentary ? msg("sponsors.deal.subline.complimentary") : amount;
  const nameId = `deal-page-name-${deal.id}`;

  const offered = canEdit ? allowedActions(deal) : [];
  const buttons = DEAL_ACTIONS.filter((a) => offered.includes(a));
  const showEvidence = canEdit && Boolean(deal.disputed_at);
  const disputed = Boolean(deal.disputed_at);
  const disputeLost = deal.ended_reason === "dispute_lost";

  /** One timeline step, in words: its title and its line. The step's state picks the wording; the engine decided the state. */
  function words(s: TimelineStep): { title: string; line: string } {
    const at = day(s.at);
    switch (s.key) {
      case "created":
        return { title: msg("sponsors.deal.timeline.created"), line: join(at, s.detail?.by ?? null) };
      case "invoice_sent":
        if (s.state === "done") return { title: msg("sponsors.deal.timeline.invoiceSent"), line: join(at, s.detail?.to ?? null) };
        if (s.state === "next") {
          return {
            title: msg("sponsors.deal.timeline.invoiceNext"),
            line: deal.sponsor_email
              ? msg("sponsors.deal.timeline.line.invoiceNext", { email: deal.sponsor_email })
              : msg("sponsors.deal.timeline.line.invoiceNextNoEmail"),
          };
        }
        return {
          title: msg("sponsors.deal.timeline.invoiceSent"),
          line: msg(s.state === "missed" ? "sponsors.deal.timeline.line.neverSent" : "sponsors.deal.timeline.line.notYet"),
        };
      case "paid":
        if (s.state === "done") {
          // Only what is true of the money: a card payment at Stripe is `has_payment_intent` (the fact refundDeal decides on); a
          // payment the club marked by hand is recorded, not "by card"; once refunded the amount stands alone.
          const how =
            deal.payment_status === "refunded"
              ? amount
              : deal.has_payment_intent
                ? msg("sponsors.deal.timeline.line.paidCard", { amount })
                : msg("sponsors.deal.timeline.line.paidRecorded", { amount });
          return { title: msg("sponsors.deal.timeline.paid"), line: join(at, how) };
        }
        if (s.state === "next") {
          return {
            title: msg("sponsors.deal.timeline.paidNext"),
            line:
              deal.payment_method === "online"
                ? msg("sponsors.deal.timeline.line.awaitingOnline", { name: sponsorName, amount })
                : msg("sponsors.deal.timeline.line.awaitingOffline", { amount }),
          };
        }
        return {
          title: msg("sponsors.deal.timeline.paid"),
          line: msg(s.state === "missed" ? "sponsors.deal.timeline.line.notPaid" : "sponsors.deal.timeline.line.notYet"),
        };
      case "approved":
        if (s.state === "done") return { title: msg("sponsors.deal.timeline.approved"), line: at ?? "" };
        if (s.state === "next") {
          return {
            title: msg("sponsors.deal.timeline.approvedNext"),
            line: msg(deal.payment_status === "paid" ? "sponsors.deal.timeline.line.approveReady" : "sponsors.deal.timeline.line.approveOnly"),
          };
        }
        return {
          title: msg("sponsors.deal.timeline.approval"),
          line: msg(s.state === "missed" ? "sponsors.deal.timeline.line.neverApproved" : "sponsors.deal.timeline.line.notYet"),
        };
      case "live":
        if (s.state === "done") {
          return {
            title: msg("sponsors.deal.timeline.live"),
            line: join(at ?? msg("sponsors.deal.timeline.line.liveNow"), deal.parked_at ? msg("sponsors.deal.timeline.line.liveHeld") : null),
          };
        }
        if (s.state === "next" && deal.deal_status === "scheduled") {
          return { title: msg("sponsors.deal.timeline.queued"), line: msg("sponsors.deal.timeline.line.queued", { name: sponsorName }) };
        }
        if (s.state === "missed") return { title: msg("sponsors.deal.timeline.live"), line: msg("sponsors.deal.timeline.line.neverLive") };
        return {
          title: msg("sponsors.deal.timeline.live"),
          line:
            deal.go_live === "on_payment"
              ? msg(deal.payment_method === "online" ? "sponsors.deal.timeline.line.liveWhenPaid" : "sponsors.deal.timeline.line.liveWhenMarked")
              : msg("sponsors.deal.timeline.line.notYet"),
        };
      case "ends": {
        if (at !== null) return { title: msg("sponsors.deal.timeline.ends"), line: at };
        if (deal.competition_id === null) return { title: msg("sponsors.deal.timeline.ends"), line: msg("sponsors.deal.timeline.line.noEnd") };
        const name = scopeName(deal.competition_id);
        const scheduled = s.detail?.competitionEndsOn;
        return {
          title: msg("sponsors.deal.timeline.ends"),
          line: s.detail?.competitionFinished
            ? msg("sponsors.deal.timeline.line.competitionFinished", { name })
            : scheduled
              ? msg("sponsors.deal.timeline.line.endsWithCompetitionDue", { name, date: calendarDay(scheduled) })
              : msg("sponsors.deal.timeline.line.endsWithCompetition", { name }),
        };
      }
      case "ended":
        return { title: msg("sponsors.deal.timeline.ended"), line: join(at, deal.ended_reason ? msg(REASON_MSG[deal.ended_reason]) : null) };
    }
  }

  const competition = deal.competition_id === null ? undefined : competitions.find((c) => c.id === deal.competition_id);
  const steps = dealTimeline(deal, {
    competitionEndsOn: competition?.ends_on ?? null,
    competitionFinished,
    createdBy,
  }).filter((s) => s.state !== "skipped");

  // "Going live will": what this deal switches on. An ended deal switches nothing on, so it has no box; a live deal is in the
  // present tense; a deal held by a dispute is off the pages and the stream until the dispute is resolved.
  const ended = deal.deal_status === "ended";
  const live = deal.deal_status === "live";
  const held = live && Boolean(deal.parked_at);
  const tier = msg(TIER_MSG[deal.tier]);
  const effects: { key: string; on: boolean; text: string }[] = held
    ? [
        { key: "tier", on: true, text: msg("sponsors.deal.goingLive.tierLive", { tier }) },
        { key: "held", on: false, text: msg("sponsors.deal.goingLive.held") },
      ]
    : [
        { key: "tier", on: true, text: msg(live ? "sponsors.deal.goingLive.tierLive" : "sponsors.deal.goingLive.tier", { tier }) },
        { key: "pages", on: true, text: msg(live ? "sponsors.deal.goingLive.pagesLive" : "sponsors.deal.goingLive.pages") },
        deal.includes_on_stream
          ? { key: "stream", on: true, text: msg(live ? "sponsors.deal.goingLive.streamLive" : "sponsors.deal.goingLive.stream") }
          : { key: "stream", on: false, text: msg("sponsors.deal.goingLive.noStream") },
      ];

  const facts: { key: string; label: string; value: ReactNode }[] = [
    {
      key: "package",
      label: msg("sponsors.dealSheet.package"),
      value: (
        <>
          <span>{deal.package_name}</span>{" "}
          <span className={`ml-1 rounded-full px-2 py-0.5 text-xs font-medium ${TIER_BADGE[deal.tier]}`}>{tier}</span>
        </>
      ),
    },
    { key: "scope", label: msg("sponsors.scopeLabel"), value: scopeName(deal.competition_id) },
    { key: "payment", label: msg("sponsors.dealSheet.payment"), value: msg(PAYMENT_MSG[deal.payment_method]) },
    ...(deal.sponsor_email ? [{ key: "invoice_to", label: msg("sponsors.deal.facts.invoiceTo"), value: deal.sponsor_email }] : []),
    { key: "goes_live", label: msg("sponsors.dealSheet.goLive"), value: msg(GO_LIVE_MSG[deal.go_live]) },
  ];

  return (
    <section data-testid="deal-page" data-deal-id={deal.id} data-deal-status={deal.deal_status} aria-labelledby={nameId} className="grid min-w-0 gap-4">
      {/* The page-level error and notice sit behind a side panel's backdrop, so while the page is open the page shows them. The
          status line is always mounted: a live region that appears WITH its text is not reliably announced. */}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <p role="status" data-testid="sponsor-notice" className="text-sm text-emerald-700 empty:sr-only">
        {notice}
      </p>
      {payLink !== null ? <PayLinkBanner url={payLink} /> : null}

      <header className="flex min-w-0 items-center gap-3">
        <span aria-hidden className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-slate-100 text-base font-semibold text-slate-500">
          {sponsorName.charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={nameId} data-testid="deal-page-name" className="min-w-0 break-words text-base font-semibold text-slate-900">
            {`${deal.package_name} · ${price}`}
          </h2>
          <p data-testid="deal-page-sponsor" className="min-w-0 break-words text-xs text-slate-500">
            {sponsorName}
          </p>
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
            <DealChip deal={deal} />
            {disputed ? (
              <span data-testid="deal-page-badge" data-badge="disputed" className={`${CHIP_BASE} bg-rose-100 text-rose-700`}>
                {msg("sponsors.deal.badge.disputed")}
              </span>
            ) : null}
            {disputeLost ? (
              <span data-testid="deal-page-badge" data-badge="dispute_lost" className={`${CHIP_BASE} bg-rose-200 text-rose-900`}>
                {msg("sponsors.deal.badge.disputeLost")}
              </span>
            ) : null}
          </div>
        </div>
      </header>

      {buttons.length > 0 || showEvidence ? (
        <div data-testid="deal-page-actions" className="flex min-w-0 flex-wrap items-center gap-2">
          {buttons.map((a) => (
            <button
              key={a}
              type="button"
              data-testid="deal-page-action"
              data-action={a}
              disabled={busy}
              aria-label={msg("sponsors.sheet.dealActionFor", { action: msg(ACTION_MSG[a]), package: deal.package_name })}
              onClick={() => onAction(deal, a)}
              className={`btn ${a === "approve" ? "btn-primary" : "btn-ghost"} px-3 py-1.5 text-xs max-md:min-h-11 ${a === "end_now" || a === "refund" ? "text-red-600" : ""}`}
            >
              {msg(ACTION_MSG[a])}
            </button>
          ))}
          {showEvidence ? (
            // Same rail as registrations: one document, mapped to Stripe's evidence fields, downloaded from the flagged deal.
            <a
              data-testid="deal-page-evidence"
              href={`/api/v1/orgs/${orgId}/sponsor-deals/${deal.id}/evidence`}
              download
              title={msg("sponsors.deal.evidenceTitle")}
              className={`${SMALL_BTN} inline-flex items-center font-medium text-rose-700`}
            >
              {msg("sponsors.deal.evidence")}
            </a>
          ) : null}
        </div>
      ) : null}

      <div data-testid="deal-page-timeline-card" className={CARD}>
        <h3 className={SECTION_TITLE}>{msg("sponsors.deal.section.timeline")}</h3>
        <ol data-testid="deal-page-timeline" className="mt-3 grid min-w-0">
          {steps.map((s, i) => {
            const w = words(s);
            const style = STEP_STYLE[s.state];
            return (
              <li
                key={s.key}
                data-testid="deal-page-step"
                data-step={s.key}
                data-state={s.state}
                aria-current={s.state === "next" ? "step" : undefined}
                className="relative min-w-0 pb-4 pl-8 last:pb-0"
              >
                {i < steps.length - 1 ? <span aria-hidden className={`absolute bottom-0 left-[8px] top-5 w-0.5 ${style.rail}`} /> : null}
                <span aria-hidden className={`absolute left-0 top-0.5 grid h-[18px] w-[18px] place-items-center rounded-full ${style.dot}`}>
                  {s.state === "done" ? <Check className="h-3 w-3" strokeWidth={3} /> : s.state === "missed" ? <X className="h-3 w-3" strokeWidth={3} /> : null}
                </span>
                <p data-testid="deal-page-step-title" className={`min-w-0 break-words text-sm ${style.title}`}>
                  {w.title}
                </p>
                <p data-testid="deal-page-step-line" className="min-w-0 break-words text-xs text-slate-500">
                  {w.line}
                </p>
              </li>
            );
          })}
        </ol>
      </div>

      <div data-testid="deal-page-deal" className={CARD}>
        <h3 className={SECTION_TITLE}>{msg("sponsors.deal.section.deal")}</h3>
        <dl className="mt-3 grid min-w-0 grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-sm">
          {facts.map((f) => (
            <div key={f.key} data-testid="deal-page-fact" data-fact={f.key} className="contents">
              <dt className="text-slate-500">{f.label}</dt>
              <dd data-testid="deal-page-fact-value" className="min-w-0 break-words text-slate-800">
                {f.value}
              </dd>
            </div>
          ))}
        </dl>
        {ended ? null : (
          <div data-testid="deal-page-going-live" className="mt-4 border-t border-slate-100 pt-3">
            <p data-testid="deal-page-going-live-title" className="text-xs font-semibold text-slate-700">
              {msg(live ? "sponsors.deal.goingLive.titleLive" : "sponsors.deal.goingLive.title")}
            </p>
            <ul className="mt-2 grid min-w-0 gap-1.5 text-sm">
              {effects.map((e) => (
                <li
                  key={e.key}
                  data-testid="deal-page-going-live-item"
                  data-effect={e.key}
                  data-on={e.on ? "yes" : "no"}
                  className={`flex min-w-0 items-start gap-2 ${e.on ? "text-slate-700" : "text-slate-500"}`}
                >
                  {e.on ? (
                    <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                  ) : (
                    <X aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                  )}
                  <span className="min-w-0 break-words">{e.text}</span>
                </li>
              ))}
            </ul>
            <p data-testid="deal-page-going-live-hint" className="mt-2 text-xs text-slate-500">
              {msg(live ? "sponsors.deal.goingLive.hintLive" : "sponsors.deal.goingLive.hint")}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
