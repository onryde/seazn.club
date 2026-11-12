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
import { formatMoneyExact } from "@/lib/currency";
import { fmtPublicDeadline } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { entryWaitingOn } from "@/lib/registration-status";
import { CompetitionProse } from "@/components/public-site/competition-prose";
import { PayButton } from "./pay-button";
import { CancelEntry } from "./cancel-entry";
import {
  assignedTeamName,
  awaitingTeamAssignment,
  canCancelEntry,
  canJoinEntry,
  claimHref,
  entryCountsTowardTotal,
  entryDisplayName,
  poolPlaceByDate,
  resolveMoneyState,
  rosterCounts,
  rosterPlayerDisplayName,
  rosterVocabulary,
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
    /** RS008 review fix #1: which consent rule the HEADING itself follows —
     *  a `team`'s own declared name never takes the consent axis, but an
     *  `individual`/`pair`'s `display_name` IS a person's (or a pair's
     *  compound) name. See `entryDisplayName` (view-model.ts). */
    entrant_kind: "team" | "individual" | "pair";
    status: EntryStatus;
    amount_cents: number;
    free_agent: boolean;
    /** RS009 — the team an organiser placed this solo sign-up on, null while
     *  they are still in the pool. REQUIRED here even though
     *  `awaitingTeamAssignment`/`assignedTeamName` both accept it as
     *  optional: those signatures are permissive so they can be called on
     *  narrower shapes, which means nothing would have told a caller that
     *  omitted it — and a card built without it shows "waiting for a team"
     *  forever on a player who has been placed. */
    assigned_team_name: string | null;
    /** RS012 — the effective place-by date for a solo sign-up STILL in the
     *  pool (division place_by_at, else its closes_at fallback), or null
     *  once assigned/never a solo sign-up. REQUIRED here for the same reason
     *  `assigned_team_name` is: `poolPlaceByDate` accepts it as optional so
     *  it can be called on narrower shapes, which means nothing would have
     *  told a caller that omitted it — and a card built without it silently
     *  shows "waiting for a team" with no deadline, forever. */
    pool_place_by_at: string | null;
    join_code: string | null;
    /** False for a `pair` — its fixed two-person roster leaves no room for
     *  a new joiner, so only its per-slot partner link is real. */
    allows_new_joiner: boolean;
    promotion_expires_at: string | null;
    /** RS007 review fix #10: this entry's OWN division's payment method —
     *  see resolveMoneyState's own doc comment (view-model.ts) for why this
     *  moved off the cart. */
    payment_method: "offline" | "stripe";
    /** Polish wave P3 (W2, W12): this entry's OWN division's review mode, so a pending card can say whether it is waiting on the
     *  organiser's approval as well as (or instead of) payment. REQUIRED for the same reason `assigned_team_name` is: an
     *  omitted value would silently read as "no review" and the card would name only the payment. */
    approval: "auto" | "manual";
    /** Polish wave P5 (W12): the organiser approved this entry while its fee was still owed (V511), so it waits on payment alone.
     *  REQUIRED for the reason `approval` is: an omitted value would read "awaiting approval" about an entry already approved. */
    approved: boolean;
    /** Polish wave P3 (W6): the fee a promotion off the waitlist WOULD set (the division's own fee), null on every other status.
     *  The card itself does not print it; the page's Subtotal does (`cartSubtotal`). Carried on the entry so one shape
     *  travels from the read model to both. */
    fee_if_promoted_cents: number | null;
    /** RS008: this entry's OWN division's youth/player_name_display policy —
     *  see `rosterPlayerDisplayName` (view-model.ts) for why it travels with
     *  the entry rather than the cart. */
    division_youth: boolean;
    division_player_name_display: string | null;
    players: {
      id: string;
      full_name: string;
      consent_status: "pending" | "granted" | "guardian";
      /** RS008: null when this row has no linked person yet (unclaimed,
       *  entry never materialised) — masked by youth alone in that case. */
      consent: { public_name?: boolean } | null;
    }[];
    refund_policy: {
      refundable: boolean;
      deadline: string | null;
      amount_cents: number;
      /** FIX 3 (RS007 status-page review): set only when `refundable` is
       *  false because NO deadline could be derived at all
       *  (resolveRefundPolicy, usecases/registrations/refunds.ts) — optional so every
       *  existing hand-built fixture that predates this field still
       *  type-checks; a missing/undefined reason renders nothing extra,
       *  same as an explicit null. */
      reason?: "no_deadline" | null;
    };
  };
  cart: {
    expires_at: string | null;
    charges_enabled: boolean;
    /** Pre-rendered offline instructions (renderProse + fillPaymentInstructions
     *  already applied, once, in page.tsx) — null for a stripe-method cart or
     *  a cart with no instructions configured. */
    instructionsHtml: string | null;
    currency: string;
    /** RS007 review fix #13(a): the org's own timezone (already resolved as
     *  `refundTz` in buildGroupStatusView, usecases/registrations/group-status.ts) — every deadline
     *  rendered below uses THIS, never the hardcoded UTC the page used to
     *  render every pay-by date in regardless of where the org actually
     *  runs. */
    timezone: string;
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
  // Polish wave P3 (W6, W10, W11): a waitlisted, withdrawn, expired or rejected entry has nothing to check in to, so its roster
  // never says "Checked in". `rosterVocabulary` picks the key family once; the chips and the meter both read it.
  const rosterWords = rosterVocabulary(entry.status) === "checkin"
    ? { meter: "register.status.roster.meter", claimed: "register.status.roster.claimed", pending: "register.status.roster.pending" }
    : { meter: "register.status.roster.meterRegistered", claimed: "register.status.roster.registered", pending: "register.status.roster.notRegistered" };
  // Polish wave P3 (W2, W12): WHY a pending entry is not confirmed. Suppressed once the payment window has closed: the
  // window-closed message below is the true and more actionable statement, and "waiting for payment" beside it would read as
  // an invitation to pay a window that no longer accepts payment.
  const waitingOn = money.kind === "window_closed" ? null : entryWaitingOn(entry.status, entry.amount_cents, entry.approval, entry.approved);
  const unclaimed = entry.players.filter((p) => p.consent_status === "pending");
  // RS008: every roster row's name, masked by division youth policy OR the
  // linked person's own consent opt-out. Resolved ONCE, by id, so the
  // roster list below and the claim-link text (which names the SAME person
  // to the captain deciding who to invite) can never show two different
  // spellings of "masked" for one player. A plain for-of over the roster,
  // not a `.map` call, so the literal source text this file's own layout
  // test anchors its wrap-class search on stays unique to the JSX render
  // further down.
  const displayNameById = new Map<string, string>();
  for (const p of entry.players) {
    displayNameById.set(
      p.id,
      rosterPlayerDisplayName(p, {
        youth: entry.division_youth,
        player_name_display: entry.division_player_name_display,
      }),
    );
  }
  // RS008 review fix #1: the card's own HEADING, same stricter-wins rule as
  // the roster rows above — a team's own name is exempt, an individual/pair
  // entrant's is not.
  const headingName = entryDisplayName(entry, {
    youth: entry.division_youth,
    player_name_display: entry.division_player_name_display,
  });

  // FIX 1 (RS007 status-page review): the entry's fee figure
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
      : formatMoneyExact(entry.amount_cents, cart.currency, locale);
  const showsFeeLine = entryCountsTowardTotal(entry.status) && money.kind !== "stripe_due";

  // FIX #13(a): org-zone-aware, zone-labelled ("1 Sept 2026, 00:30 IST", not
  // hardcoded-UTC "01/09/2026, 19:00" with no label at all), in the page's
  // locale (owner ruling 2026-09-16: public dates follow the copy's locale,
  // English day-month; it was en-GB in all four). The zone label follows the
  // same locale (Task 16): en keeps "IST", es/fr/nl read Intl's own "GMT+5:30"
  // / "UTC+5:30" rather than an English abbreviation. dateStyle/
  // timeStyle cannot be combined with timeZoneName in one Intl.DateTimeFormat
  // call (throws), so the two are composed by hand — same convention
  // officials-panel.tsx/timezone-preference.tsx already use elsewhere in
  // this codebase.
  const deadlineLabel = (deadline: string) => fmtPublicDeadline(locale, cart.timezone, deadline);

  // RS012 review cleanup: computed once here rather than calling
  // `poolPlaceByDate(entry)` a second time inside the JSX below, which used
  // to force a redundant `as string` cast on the second call.
  const poolPlaceBy = poolPlaceByDate(entry);

  let moneyNode: ReactNode = null;
  if (money.kind === "stripe_due") {
    const label = t(ui, "register.status.pay.cta", { amount: feeLabel });
    moneyNode = (
      <div className="space-y-1.5">
        <PayButton entryId={entry.id} token={token} label={label} />
        {money.deadline && (
          <p className="text-xs text-ink-muted">
            {t(ui, "register.status.money.deadline", { date: deadlineLabel(money.deadline) })}
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
            {t(ui, "register.status.money.deadline", { date: deadlineLabel(money.deadline) })}
          </p>
        )}
      </div>
    );
  } else if (money.kind === "window_closed") {
    // FIX #8: the pay-by deadline has passed but the hourly sweep has not
    // caught up yet (status is still 'pending') — no Pay button (it would
    // mint a real Stripe session the very next sweep expires and
    // auto-refunds) and no "Pay by" date (it has already gone by).
    moneyNode = (
      <div className="space-y-1">
        <p className="text-sm font-semibold text-ink">{feeLabel}</p>
        <p className="text-sm text-amber-800">{t(ui, "register.status.pay.windowClosed")}</p>
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
          <div className="min-w-0 grow basis-48">
            <p className="truncate text-xs font-semibold tracking-wide text-ink-muted uppercase">
              {entry.division_name}
            </p>
            <p className="truncate font-display text-lg font-semibold text-ink">{headingName}</p>
          </div>
          <span
            data-testid="reg-status-outcome"
            data-status={entry.status}
            /* The entry's own id, alongside its status. The bench reads both
             * off this badge because the submit RESPONSE is unreadable by then:
             * the stepper navigates here on success, and Playwright's
             * `response.json()` then fails with "No resource with given
             * identifier found" — the browser has discarded the body. The
             * landing URL carries only the GROUP's rid/token, and the public
             * status API is entry-keyed (`publicRegistrationStatus` ->
             * `regByToken`), so without this the entry ids are unreachable from
             * the page the registrant is actually looking at. Mirrors the
             * hub's own `data-registration-id` convention. */
            data-registration-id={entry.id}
            className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold tracking-wide uppercase ${tone.badge}`}
          >
            {t(ui, STATUS_KEY[entry.status])}
          </span>
        </div>

        {waitingOn && (
          <p data-testid="reg-status-waiting" data-waiting-on={waitingOn} className="text-sm text-ink">
            {t(ui, `register.status.waiting.${waitingOn}`)}
          </p>
        )}

        {moneyNode}

        {/* RS009 handoff — see awaitingTeamAssignment's own doc comment
            (view-model.ts) for why this check is INCOMPLETE (free_agent
            records entry MODE, not outcome) and must not be extended here. */}
        {awaitingTeamAssignment(entry) && (
          <p className="text-sm text-ink-muted">{t(ui, "register.status.entry.awaitingTeam")}</p>
        )}
        {/* RS012 — the other other half: BY WHEN they'll be auto-refunded if
            nobody places them. Gated on the same poolPlaceByDate, which
            reuses awaitingTeamAssignment's own predicate, so this can never
            render once assigned even though pool_place_by_at is still
            carried on the entry. */}
        {poolPlaceBy && (
          <p className="text-xs text-ink-muted">
            {t(ui, "register.status.entry.awaitingTeamDeadline", { date: deadlineLabel(poolPlaceBy) })}
          </p>
        )}
        {/* RS009 — the receipt for the promise the stepper made at sign-up.
            Mutually exclusive with the notice above by construction: both
            read the same placement, so a card can never say "waiting for a
            team" and name a team at the same time. */}
        {assignedTeamName(entry) && (
          <p className="text-sm text-ink-muted">
            {t(ui, "register.status.entry.assignedToTeam", {
              team: assignedTeamName(entry) as string,
            })}
          </p>
        )}

        {entry.players.length > 0 && (
          <div className="rounded-lg bg-canvas p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold tracking-wide text-ink-muted uppercase">
                {t(ui, "register.status.roster.heading")}
              </p>
              <p className="text-xs text-ink-muted">
                {t(ui, rosterWords.meter, { claimed: roster.claimed, total: roster.total })}
              </p>
            </div>
            {/* Each row wraps rather than letting the badge win. The badge is
                shrink-0 and the name truncates, so at 320px a long status
                label (originally "Awaiting confirmation" — renamed to "Not
                checked in" by RS007 #20, see register.status.roster.pending)
                took the whole row and crushed the name to a few characters —
                a roster that tells you a spot is unclaimed but not WHOSE it
                is. Wrapping drops the badge to its own line there and gives
                the name full width. Verified by screenshot at 320/768/1280;
                the no-horizontal-scroll e2e gate passed both before and
                after, so it could not see this. */}
            <ul className="mt-2 space-y-1.5">
              {entry.players.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-sm">
                  <span className="min-w-0 grow basis-40 truncate text-ink">{displayNameById.get(p.id)}</span>
                  <span
                    className={
                      p.consent_status === "pending"
                        ? "shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700"
                        : "shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700"
                    }
                  >
                    {t(ui, p.consent_status === "pending" ? rosterWords.pending : rosterWords.claimed)}
                  </span>
                </li>
              ))}
            </ul>
            {/* FIX 2 (RS007 status-page review): this used to gate on
                join_code + roster shape alone, with NO status check —
                withdrawCore never clears join_code, so a cancelled entry
                kept offering claim/invite links that
                joinTeamEntry/previewJoinEntry's own dead-entry gate 404s
                every time (canJoinEntry, view-model.ts). */}
            {canJoinEntry(entry.status) && entry.join_code && (unclaimed.length > 0 || entry.allows_new_joiner) && (
              <ul className="mt-2 space-y-1 border-t border-zinc-200 pt-2">
                {unclaimed.map((p) => (
                  <li key={p.id}>
                    <a
                      href={claimHref(orgSlug, competitionSlug, entry.join_code!, p.id)}
                      className="ph-no-capture text-xs font-medium text-accent-strong underline underline-offset-2"
                    >
                      {/* Code-review fix (2026-08-30, item 6): this used to
                          fall back to the RAW p.full_name on a miss — the
                          roster-name span above never has (it renders
                          blank), so a map lookup that should structurally
                          never miss (built from this same entry.players
                          array, just above) leaked the unmasked name instead
                          of failing the same safe way. Both now agree: blank
                          on a miss, never p.full_name. */}
                      {t(ui, "register.status.roster.claimLink", { name: displayNameById.get(p.id) ?? "" })}
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
                      className="ph-no-capture text-xs font-medium text-accent-strong underline underline-offset-2"
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
            {/* FIX 3 (RS007 status-page review): refund_policy carries a
                `reason` when a refund is fail-closed-declined because no
                deadline could be derived at all (resolveRefundPolicy,
                usecases/registrations/refunds.ts) — previously rendered nowhere, so a
                registrant saw a plain refusal with no explanation. Plain-
                English, says what the organiser will do, not what the
                system computed. */}
            {entry.refund_policy.reason === "no_deadline" && (
              <p className="mb-1.5 text-xs text-ink-muted">{t(ui, "register.status.cancel.refund.noDeadline")}</p>
            )}
            <CancelEntry
              entryId={entry.id}
              token={token}
              divisionName={entry.division_name}
              refundable={entry.refund_policy.refundable}
              refundAmountFormatted={formatMoneyExact(entry.refund_policy.amount_cents, cart.currency, locale)}
            />
          </div>
        )}
      </div>
    </li>
  );
}
