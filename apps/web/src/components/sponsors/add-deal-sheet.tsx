"use client";

// The Add deal sheet (sponsor deals PR 2, Task 16; mockup screen 3): a package, a competition or the whole organisation, how it is
// paid, when it goes live - and, above the button, one sentence that says what will happen (`dealSummary`). The button names the
// same thing (`primaryLabel`).
//
// A bottom sheet on a phone and a centred panel from sm (the house `Modal`); its footer holds the two buttons so they stay on screen
// while the choices scroll. ONE component, rendered inline (the choice cards are plain functions that return markup, not child
// components with their own hooks), so the element tree a test walks is the whole sheet.
//
// What it decides, and what it does not:
//  - It opens on the plan's best choice (D22): Online when the plan sells invoices FOR THAT SCOPE AND Stripe takes charges, else Offline;
//    "When paid";
//    the scope at the package's competition (locked) else the whole organisation; the email at the sponsor's last billing email.
//  - The server has the last word (every refusal comes back in the dictionary's words, `sponsorSaveErrorKey`); the sheet only refuses
//    what it can see: a package or a competition the plan does not place (the same predicate the server enforces,
//    `placementNeedsTiers`, spec §10 Q1 and F29), a package whose competition has finished (409 competition_finished), Online on a
//    scope the plan does not sell it on (an Event Pass lifts its own competition and never the whole organisation: 402), an online
//    deal with no billing email, a complimentary deal that waits for payment.
//  - Every derived value (method, go-live rule, scope, "another deal is live") is computed in render from what is on the sheet, never
//    stored beside it, so what is shown and what is sent cannot disagree.
//  - A second tap while the request is in flight sends nothing (a ref, not state: a double tap can beat a re-render).
import { useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "@/components/ui/console-link";
import { Modal } from "@/components/modal";
import { useLocaleOrDefault, useMsg } from "@/components/i18n/dict-provider";
import { useConfirm } from "@/components/ui/confirm-provider";
import type { SponsorItem } from "@/components/org-sponsors";
import { TIER_MSG } from "@/components/sponsors/tier-labels";
import { dupConfirmBodyKey, hasOpenDealOn, priceLabel } from "@/components/sponsors/deal-copy";
import { createDealWrite, sponsorSaveErrorKey } from "@/components/sponsors/save-error";
import { ApiV1Error } from "@/lib/client-v1";
import { fmtPublicDate } from "@/lib/format";
import type { MessageKey } from "@/lib/messages";
import { routes } from "@/lib/routes";
import { placementNeedsTiers } from "@/lib/sponsor-deal-policy";
import { dealSummary, goLiveRulesFor, nextScheduledDeal, primaryLabel, type GoLiveRule, type PaymentMethod, type SponsorDeal } from "@/lib/sponsor-deals";
import { sponsorsHref } from "@/lib/sponsors-hub";
import type { SponsorPackageRow } from "@/server/usecases/sponsors";

/** The body `POST /sponsors/{id}/deals` takes (server/api-v1/schemas/sponsors.ts `CreateSponsorDeal`, strict): `competition_id` null is
 *  the whole organisation; `ends_on` is a day (YYYY-MM-DD); `end_current` ends the sponsor's live deal in the same call. */
export interface CreateDealBody {
  package_id: string;
  competition_id: string | null;
  payment_method: PaymentMethod;
  go_live: GoLiveRule;
  sponsor_email?: string;
  ends_on?: string;
  end_current: boolean;
}

export interface AddDealSheetProps {
  sponsor: SponsorItem;
  /** The org's deals, for the "this sponsor already has one of these" question. */
  deals: readonly SponsorDeal[];
  packages: readonly SponsorPackageRow[];
  /** `ends_on`: the competition's end date (YYYY-MM-DD) or null. */
  competitions: readonly { id: string; name: string; ends_on?: string | null }[];
  /** `sponsors.tiers` is on for the whole organisation (a paid plan), and so for every competition. */
  tiersOrgWide: boolean;
  /** The competitions an Event Pass lifts `sponsors.tiers` on (the server gates placement per scope, deal-gates.ts `assertPlacementAllowed`). */
  tiersCompetitionIds: readonly string[];
  /** The plan sells online invoices (`sponsors.monetize`) on SOME scope: what separates "needs a plan" from "not for this scope". */
  hasMonetize: boolean;
  /** `sponsors.monetize` is on for the whole organisation (a paid plan), and so for every competition. */
  monetizeOrgWide: boolean;
  /** The competitions an Event Pass lifts `sponsors.monetize` on (the server gates online selling per scope, deal-gates.ts). */
  monetizeCompetitionIds: readonly string[];
  /** The org's Stripe account takes charges. */
  chargesEnabled: boolean;
  /** The competitions whose packages are no longer sold (finished): such a package is shown locked, with the reason, and never sent. */
  finishedCompetitionIds: readonly string[];
  orgSlug: string;
  /** Make the deal. RESOLVING means it is done (the sheet closes itself); a REJECTION with an ApiV1Error is shown on the sheet, in the
   *  dictionary's words, and the sheet stays open with every choice kept. */
  onCreate: (body: CreateDealBody) => Promise<void>;
  onClose: () => void;
}

/** Looks like an address; the server's `z.string().email()` is the real check. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The card chrome shared by every choice: a visually hidden radio first (so `peer-*` reaches the card and the dot after it, and the
 *  radio keeps its native keyboard and screen-reader behaviour), then the card, then the dot that marks the choice without colour
 *  alone. */
const CARD =
  "flex min-w-0 flex-1 flex-col gap-1 rounded-xl border border-slate-200 bg-white py-3 pl-3 pr-10 transition-colors hover:border-purple-300 " +
  "peer-checked:border-purple-500 peer-checked:bg-purple-50 peer-checked:ring-1 peer-checked:ring-purple-500 " +
  "peer-focus-visible:ring-2 peer-focus-visible:ring-purple-400 peer-disabled:opacity-60 peer-disabled:hover:border-slate-200";
const DOT =
  "pointer-events-none absolute right-3 top-3.5 h-4 w-4 rounded-full border border-slate-300 bg-white " +
  "peer-checked:border-purple-600 peer-checked:bg-purple-600 peer-checked:ring-3 peer-checked:ring-inset peer-checked:ring-white";
const PAY_TITLE: Record<PaymentMethod, MessageKey> = {
  online: "sponsors.dealSheet.pay.online.title",
  offline: "sponsors.dealSheet.pay.offline.title",
  complimentary: "sponsors.dealSheet.pay.complimentary.title",
};
const PAY_LINE: Record<PaymentMethod, MessageKey> = {
  online: "sponsors.dealSheet.pay.online.line",
  offline: "sponsors.dealSheet.pay.offline.line",
  complimentary: "sponsors.dealSheet.pay.complimentary.line",
};
const LOCK_LINK = "inline-flex items-center font-medium text-purple-700 underline max-md:min-h-11";

export function AddDealSheet({
  sponsor, deals, packages, competitions, tiersOrgWide, tiersCompetitionIds, hasMonetize, monetizeOrgWide, monetizeCompetitionIds, chargesEnabled, finishedCompetitionIds,
  orgSlug, onCreate, onClose,
}: AddDealSheetProps) {
  const msg = useMsg();
  const locale = useLocaleOrDefault();
  const confirm = useConfirm();
  const hintId = useId();

  const onSale = packages.filter((p) => p.active);
  /** The plan places tiers and competition deals FOR THIS SCOPE ("" is the whole organisation): org-wide covers every scope, an Event Pass
   *  only its own competition (the server's per-scope gate, deal-gates.ts `assertPlacementAllowed`; the `monetizeFor` mirror). */
  const tiersFor = (scopeId: string) => tiersOrgWide || (scopeId !== "" && tiersCompetitionIds.includes(scopeId));
  /** Tiers are reachable on SOME scope: what separates "needs a plan" from "not for this scope". */
  const hasTiers = tiersOrgWide || tiersCompetitionIds.length > 0;
  /** The plan does not place this package (spec §10 Q1: on the community plan every deal is Partner on the whole organisation). A package for
   *  one competition needs tiers on THAT competition; one for any competition needs them on some scope (the sheet then picks a placed one). */
  const packageLocked = (p: SponsorPackageRow) =>
    p.competition_id !== null ? !tiersFor(p.competition_id) : !hasTiers && placementNeedsTiers(p.tier, null);
  /** The package's competition has finished: it is not sold (the server refuses it, 409 `competition_finished`). */
  const packageFinished = (p: SponsorPackageRow) => p.competition_id !== null && finishedCompetitionIds.includes(p.competition_id);
  const packageOpen = (p: SponsorPackageRow) => !packageLocked(p) && !packageFinished(p);
  /** The plan sells online invoices FOR THIS SCOPE ("" is the whole organisation): org-wide covers every scope, an Event Pass only
   *  its own competition (the server's per-scope gate, deal-gates.ts `assertOnlineAllowed`). */
  const monetizeFor = (scopeId: string) => monetizeOrgWide || (scopeId !== "" && monetizeCompetitionIds.includes(scopeId));

  /** The scope a package places on: the one a competition package fixes, else the person's pick; while the pick is the whole organisation
   *  (the opening state) and that is not placed for this package, the first competition that is. A competition the person chose stays
   *  chosen (the submit guard `placementOk` then says whether it can be sent). Derived, never stored, so a package change re-asks. */
  const scopeOf = (p: SponsorPackageRow, picked: string) => {
    if (p.competition_id !== null) return p.competition_id;
    if (picked !== "" || tiersFor("") || !placementNeedsTiers(p.tier, null)) return picked;
    return competitions.find((c) => tiersFor(c.id))?.id ?? picked;
  };
  const firstOpen = onSale.find(packageOpen) ?? null;
  const [packageId, setPackageId] = useState<string | null>(() => firstOpen?.id ?? null);
  const [pickedScope, setPickedScope] = useState("");
  const [pickedMethod, setPickedMethod] = useState<PaymentMethod>(chargesEnabled && monetizeFor(firstOpen === null ? "" : scopeOf(firstOpen, "")) ? "online" : "offline");
  const [pickedRule, setPickedRule] = useState<GoLiveRule>("on_payment");
  const [email, setEmail] = useState(sponsor.last_billing_email ?? "");
  const [endsOn, setEndsOn] = useState("");
  const [endCurrent, setEndCurrent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  // --- everything below is DERIVED from the choices on the sheet ---------------------------------------------------------------
  const pkg = onSale.find((p) => p.id === packageId) ?? null;
  /** A package for one competition fixes the scope (the server refuses any other: 422 scope_outside_package). */
  const scopeFixed = pkg !== null && pkg.competition_id !== null;
  const scope = pkg === null ? pickedScope : scopeOf(pkg, pickedScope);
  /** Online is only for a scope the plan sells it on AND an account that can take the money; a stale choice falls to Offline. */
  const onlineOpen = chargesEnabled && monetizeFor(scope);
  const method: PaymentMethod = pickedMethod === "online" && !onlineOpen ? "offline" : pickedMethod;
  /** "When paid" is not offered for a complimentary deal: a choice that no longer exists reads as Straight away. */
  const rule: GoLiveRule = goLiveRulesFor(method).includes(pickedRule) ? pickedRule : "immediate";
  const sponsorLive = sponsor.locked_by_deal;
  const endsCurrent = sponsorLive && endCurrent;
  /** Another deal of this sponsor is live AND stays live: the new one queues behind it (§8a). */
  const otherLive = sponsorLive && !endCurrent;
  /** Ending the current deal now promotes the deal already waiting behind it (deal-apply step 2), which keeps the sponsor on the pages:
   *  the same head-of-queue question the server asks, over this sponsor's deals. */
  const promotesWaiting = endsCurrent && nextScheduledDeal(deals.filter((d) => d.sponsor_id === sponsor.id), new Date()) !== null;
  const emailTrim = email.trim();
  const emailValid = EMAIL_RE.test(emailTrim);
  const emailOk = method === "complimentary" || (method === "online" ? emailValid : emailTrim === "" || emailValid);
  /** The placement the plan allows - the same predicate the server enforces, so a community user never meets the 402. */
  const placementOk = pkg !== null && (tiersFor(scope) || !placementNeedsTiers(pkg.tier, scope === "" ? null : scope));
  const canSubmit = pkg !== null && packageOpen(pkg) && placementOk && emailOk && !busy;

  const scopeCompetition = scope === "" ? null : (competitions.find((c) => c.id === scope) ?? null);
  // Both places the name is used (the summary's "for {scope}" and the hint's "when {name} finishes") put it INSIDE a sentence, so the
  // fallback for a competition the page does not hold is the lower-case form.
  const scopeName = scope === "" ? null : (scopeCompetition?.name ?? msg("sponsors.dealSheet.scopeUnknownInline"));
  const label = primaryLabel(method, rule, otherLive);
  const labelKey: MessageKey =
    label === "send_invoice" ? "sponsors.deal.action.sendInvoice" : label === "save_and_go_live" ? "sponsors.dealSheet.primary.saveAndGoLive" : "sponsors.dealSheet.primary.saveDeal";

  function requestClose() {
    // Closing mid-request would leave a deal being made that nobody is watching.
    if (inFlight.current) return;
    onClose();
  }

  async function submit(): Promise<void> {
    if (inFlight.current || !canSubmit || pkg === null) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      // Each invoice is its own payable deal: ask before making a second one for the same sponsor and package.
      if (hasOpenDealOn(deals, sponsor.id, pkg.id)) {
        const ok = await confirm(
          method === "online"
            ? {
                title: msg("sponsors.deal.confirm.dup.title"),
                body: msg(dupConfirmBodyKey(deals, sponsor.id, pkg.id), { name: sponsor.name }),
                confirmLabel: msg("sponsors.deal.confirm.dup.label"),
                tone: "danger",
              }
            : {
                title: msg("sponsors.dealSheet.dup.title"),
                body: msg("sponsors.dealSheet.dup.body", { name: sponsor.name }),
                confirmLabel: msg("sponsors.dealSheet.dup.label"),
                tone: "danger",
              },
        );
        if (!ok) return;
      }
      const body: CreateDealBody = {
        package_id: pkg.id,
        competition_id: scope === "" ? null : scope,
        payment_method: method,
        go_live: rule,
        ...(method !== "complimentary" && emailTrim !== "" ? { sponsor_email: emailTrim } : {}),
        // The date belongs to the whole-organisation scope; a competition's deal ends with the competition.
        ...(scope === "" && endsOn !== "" ? { ends_on: endsOn } : {}),
        end_current: endsCurrent,
      };
      await onCreate(body);
      onClose();
    } catch (err) {
      setError(
        msg(
          err instanceof ApiV1Error
            ? sponsorSaveErrorKey(err, createDealWrite({ method, endCurrent: endsCurrent, rule, queued: otherLive }))
            : "settings.saveFailed",
        ),
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  // --- the markup --------------------------------------------------------------------------------------------------------------
  /** One radio card. `hint` sits BELOW the card, outside the label, so a link in it is its own tap target. */
  function choice(c: {
    testid: string; cardTestid?: string; group: string; value: string; checked: boolean; disabled?: boolean; onPick: () => void;
    title: ReactNode; line?: ReactNode; lineTestid?: string; chips?: ReactNode; hint?: ReactNode;
  }) {
    return (
      // A flex column all the way down, so a row of cards shares one height: the grid stretches this wrapper, the label grows into it
      // (flex-1) and the card fills the label (flex-1). A `block` label here let each card size to its own text (uneven rows).
      <div key={c.value} className="flex min-w-0 flex-col">
        <label data-testid={c.cardTestid ?? `${c.testid}-card`} className={`relative flex min-w-0 flex-1 flex-col ${c.disabled ? "cursor-not-allowed" : "cursor-pointer"}`}>
          <input
            type="radio"
            name={c.group}
            value={c.value}
            data-testid={c.testid}
            checked={c.checked}
            disabled={c.disabled}
            onChange={c.onPick}
            className="peer sr-only"
          />
          <span className={CARD}>
            <span className="min-w-0 break-words font-semibold text-slate-900 [overflow-wrap:anywhere]">{c.title}</span>
            {c.line ? <span data-testid={c.lineTestid} className="min-w-0 break-words text-xs text-slate-600">{c.line}</span> : null}
            {c.chips}
          </span>
          <span aria-hidden className={DOT} />
        </label>
        {c.hint}
      </div>
    );
  }

  const upgradeLink = (testid: string, text: string, href: string) => (
    <Link data-testid={testid} href={href} className={LOCK_LINK}>
      {text}
    </Link>
  );

  const packageCards = onSale.map((p) => {
    const locked = packageLocked(p);
    const finished = packageFinished(p);
    const competition = p.competition_id === null ? null : (competitions.find((c) => c.id === p.competition_id) ?? null);
    return choice({
      testid: `add-deal-package-${p.id}`,
      cardTestid: `add-deal-package-card-${p.id}`,
      group: "add-deal-package",
      value: p.id,
      checked: p.id === packageId,
      disabled: locked || finished,
      onPick: () => setPackageId(p.id),
      title: (
        <span className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3">
          <span className="min-w-0">{p.name}</span>
          <span className="shrink-0 font-semibold text-slate-900">{priceLabel(locale, p.price_cents, p.currency)}</span>
        </span>
      ),
      line: (
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">{msg(TIER_MSG[p.tier])}</span>
          <span className="min-w-0 break-words">
            {p.competition_id === null ? msg("sponsors.dealSheet.packageScopeAny") : (competition?.name ?? msg("sponsors.dealSheet.scopeUnknown"))}
          </span>
          {p.includes_on_stream ? (
            <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[11px] font-medium text-purple-800">{msg("sponsors.sheet.onStream")}</span>
          ) : null}
        </span>
      ),
      hint: finished ? (
        // Checked first: an upgrade does not bring a finished competition back, so it offers no way out but another package.
        <p data-testid={`add-deal-package-finished-${p.id}`} className="mt-1 text-xs text-slate-600">
          {msg("sponsors.dealSheet.packageFinished")}
        </p>
      ) : locked ? (
        <p data-testid={`add-deal-package-lock-${p.id}`} className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-slate-600">
          <span>{msg("sponsors.dealSheet.packageLocked")}</span>
          {upgradeLink(`add-deal-package-upgrade-${p.id}`, msg("sponsors.dealSheet.upgrade"), routes.billing(orgSlug))}
        </p>
      ) : undefined,
    });
  });

  const paymentCards = (["online", "offline", "complimentary"] as const).map((m) => {
    const lockedOnline = m === "online" && !onlineOpen;
    return choice({
      testid: `add-deal-payment-${m}`,
      group: "add-deal-payment",
      value: m,
      checked: m === method,
      disabled: lockedOnline,
      onPick: () => setPickedMethod(m),
      title: msg(PAY_TITLE[m]),
      line: msg(PAY_LINE[m]),
      hint: lockedOnline ? (
        <p data-testid="add-deal-payment-lock-online" className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-slate-600">
          {/* Why, most fundamental first: no plan for online at all; a plan that sells it elsewhere (an Event Pass covers its own
              competition, never the whole organisation); then, with the scope covered, the account that cannot take charges. */}
          {!hasMonetize ? (
            <>
              <span>{msg("sponsors.dealSheet.pay.lockedPlan")}</span>
              {upgradeLink("add-deal-payment-link-online", msg("sponsors.dealSheet.pay.lockedPlanLink"), routes.billing(orgSlug))}
            </>
          ) : !monetizeFor(scope) ? (
            <>
              <span data-testid="add-deal-payment-lock-scope">
                {msg(scope === "" ? "sponsors.dealSheet.pay.lockedScopeWhole" : "sponsors.dealSheet.pay.lockedScopeCompetition")}
              </span>
              {upgradeLink("add-deal-payment-link-online", msg("sponsors.dealSheet.upgrade"), routes.billing(orgSlug))}
            </>
          ) : (
            upgradeLink("add-deal-payment-link-online", msg("sponsors.dealSheet.pay.connectLink"), routes.connect(orgSlug))
          )}
        </p>
      ) : undefined,
    });
  });

  const liveTitle: Record<GoLiveRule, MessageKey> = {
    on_payment: "sponsors.dealSheet.live.onPayment.title",
    immediate: "sponsors.dealSheet.live.immediate.title",
    on_approval: "sponsors.dealSheet.live.onApproval.title",
  };
  const liveLine = (r: GoLiveRule): MessageKey =>
    r === "on_payment"
      ? method === "online" ? "sponsors.dealSheet.live.onPayment.online" : "sponsors.dealSheet.live.onPayment.offline"
      : r === "immediate"
        ? method === "complimentary" ? "sponsors.dealSheet.live.immediate.free" : "sponsors.dealSheet.live.immediate.unpaid"
        : "sponsors.dealSheet.live.onApproval.line";
  const liveCards = goLiveRulesFor(method).map((r) =>
    choice({
      testid: `add-deal-golive-${r}`,
      group: "add-deal-golive",
      value: r,
      checked: r === rule,
      onPick: () => setPickedRule(r),
      title: msg(liveTitle[r]),
      line: msg(liveLine(r)),
      lineTestid: `add-deal-golive-sub-${r}`,
    }),
  );

  // The scope select. On a plan without tiers every competition is disabled (F29); the hint says why, with the way out.
  const competitionBlocked = (id: string) => !tiersFor(id) && pkg !== null && placementNeedsTiers(pkg.tier, id);
  const wholeBlocked = !tiersFor("") && pkg !== null && placementNeedsTiers(pkg.tier, null);
  const anyBlocked = competitions.some((c) => competitionBlocked(c.id));
  const pkgCompetition = pkg === null ? null : pkg.competition_id;
  const scopeInList = pkgCompetition === null || competitions.some((c) => c.id === pkgCompetition);

  const summary =
    pkg === null
      ? null
      : dealSummary({
          sponsorName: sponsor.name,
          packageName: pkg.name,
          scopeName,
          method,
          rule,
          amount: priceLabel(locale, pkg.price_cents, pkg.currency),
          email: method === "online" && emailTrim !== "" ? emailTrim : null,
          otherLive,
          promotesWaiting,
          currentlyShown: sponsor.status === "active",
        });

  return (
    <Modal
      title={msg("sponsors.dealSheet.title", { name: sponsor.name })}
      size="lg"
      onClose={requestClose}
      closeSize="lg"
      footer={
        <>
          <button type="button" data-testid="add-deal-cancel" onClick={requestClose} className="btn btn-ghost max-md:min-h-11">
            {msg("confirm.cancel")}
          </button>
          <button
            type="button"
            data-testid="add-deal-submit"
            disabled={!canSubmit}
            onClick={submit}
            className="btn btn-primary min-w-0 whitespace-normal text-center leading-tight max-md:min-h-11 max-md:flex-1"
          >
            {busy ? "…" : msg(labelKey)}
          </button>
        </>
      }
    >
      <div data-testid="add-deal-sheet" className="min-w-0 space-y-5 text-slate-700">
        {onSale.length === 0 ? (
          <div data-testid="add-deal-no-packages" className="space-y-2 rounded-xl border border-dashed border-slate-200 p-4 text-center">
            <p>{msg("sponsors.dealSheet.noPackages")}</p>
            <Link data-testid="add-deal-packages-link" href={sponsorsHref(orgSlug, "packages")} className={LOCK_LINK}>
              {msg("sponsors.dealSheet.noPackagesLink")}
            </Link>
          </div>
        ) : (
          <>
            <fieldset className="min-w-0">
              <legend className="label">{msg("sponsors.dealSheet.package")}</legend>
              <div className="grid min-w-0 gap-2 sm:grid-cols-2">{packageCards}</div>
            </fieldset>

            <div className="min-w-0 space-y-1.5">
              <label className="block min-w-0">
                <span className="label">{msg("sponsors.dealSheet.scope")}</span>
                <select
                  data-testid="add-deal-scope"
                  value={scope}
                  disabled={scopeFixed}
                  onChange={(e) => setPickedScope(e.target.value)}
                  className="input min-w-0 max-md:min-h-11"
                >
                  <option data-testid="add-deal-scope-option-whole" value="" disabled={wholeBlocked}>
                    {msg("sponsors.dealSheet.scopeWhole")}
                  </option>
                  {competitions.map((c) => (
                    <option key={c.id} data-testid={`add-deal-scope-option-${c.id}`} value={c.id} disabled={competitionBlocked(c.id)}>
                      {c.name}
                    </option>
                  ))}
                  {scopeInList || pkgCompetition === null ? null : (
                    <option data-testid={`add-deal-scope-option-${pkgCompetition}`} value={pkgCompetition}>
                      {msg("sponsors.dealSheet.scopeUnknown")}
                    </option>
                  )}
                </select>
              </label>
              {scopeFixed || anyBlocked ? (
                <p data-testid="add-deal-scope-hint" className="flex flex-wrap items-center gap-x-1.5 text-xs text-slate-600">
                  <span>{scopeFixed ? msg("sponsors.dealSheet.scopeFixed") : msg("sponsors.dealSheet.scopeTiersHint")}</span>
                  {!scopeFixed && anyBlocked ? upgradeLink("add-deal-scope-upgrade", msg("sponsors.dealSheet.upgrade"), routes.billing(orgSlug)) : null}
                </p>
              ) : null}
              {scope !== "" ? (
                <p data-testid="add-deal-runs-hint" className="text-xs text-slate-600">
                  {scopeCompetition?.ends_on
                    ? msg("sponsors.dealSheet.scopeRuns", {
                        name: scopeCompetition.name,
                        date: fmtPublicDate(locale, "UTC", `${scopeCompetition.ends_on}T00:00:00.000Z`, { day: "numeric", month: "short", year: "numeric" }),
                      })
                    : msg("sponsors.dealSheet.scopeRunsNoDate", { name: scopeName ?? "" })}
                </p>
              ) : (
                <label className="block min-w-0">
                  <span className="label">{msg("sponsors.dealSheet.endsOn")}</span>
                  <input
                    data-testid="add-deal-ends-on"
                    type="date"
                    value={endsOn}
                    aria-describedby={hintId}
                    onChange={(e) => setEndsOn(e.target.value)}
                    className="input min-w-0 max-md:min-h-11"
                  />
                  <span id={hintId} className="mt-1 block text-xs text-slate-600">{msg("sponsors.dealSheet.endsOnHint")}</span>
                </label>
              )}
            </div>

            <fieldset className="min-w-0">
              <legend className="label">{msg("sponsors.dealSheet.payment")}</legend>
              <div className="grid min-w-0 gap-2 sm:grid-cols-3">{paymentCards}</div>
            </fieldset>

            {method !== "complimentary" ? (
              <label data-testid="add-deal-email-field" className="block min-w-0">
                <span className="label">{msg(method === "online" ? "sponsors.dealSheet.email.online" : "sponsors.dealSheet.email.offline")}</span>
                <input
                  data-testid="add-deal-email"
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  required={method === "online"}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="input min-w-0 max-md:min-h-11"
                />
              </label>
            ) : null}

            <fieldset className="min-w-0">
              <legend className="label">{msg("sponsors.dealSheet.goLive")}</legend>
              <div className="grid min-w-0 gap-2 sm:grid-cols-3">{liveCards}</div>
            </fieldset>

            {sponsorLive ? (
              <div className="min-w-0 space-y-1 rounded-xl border border-slate-200 bg-slate-50 p-3">
                {endCurrent ? null : (
                  <p data-testid="add-deal-queue-note" className="text-sm font-medium text-slate-800">{msg("sponsors.dealSheet.queueNote")}</p>
                )}
                <label data-testid="add-deal-end-current-label" className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm">
                  <input
                    data-testid="add-deal-end-current"
                    type="checkbox"
                    checked={endCurrent}
                    onChange={(e) => setEndCurrent(e.target.checked)}
                    className="h-5 w-5 shrink-0 accent-purple-600"
                  />
                  <span className="min-w-0 break-words">{msg("sponsors.dealSheet.endCurrent")}</span>
                </label>
              </div>
            ) : null}

            {summary ? (
              <section aria-label={msg("sponsors.dealSheet.summaryLabel")} className="min-w-0 rounded-xl border border-purple-200 border-l-4 border-l-purple-500 bg-purple-50 p-4">
                <p className="text-xs font-medium text-purple-700">{msg("sponsors.dealSheet.summaryLabel")}</p>
                <p data-testid="add-deal-summary" className="mt-1 break-words text-base leading-relaxed text-slate-900">
                  {summary.map((part) => msg(part.key, part.params)).join(" ")}
                </p>
              </section>
            ) : null}
          </>
        )}
        {error ? (
          <p role="alert" data-testid="add-deal-error" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
