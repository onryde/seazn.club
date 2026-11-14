// Pure view-model logic for the registrant status page (RS007 rebuild).
// Zero React, zero DB — every export is a plain function of plain data, so
// the money/roster/link rules that matter most (never dangle a debt with no
// route to settle; cancel must call the PUBLIC write path, never the
// organiser one) are provable without a render.
import { anyOptedOut, resolvePersonDisplayName } from "@/lib/name-display";
import { isTerminalRegistrationStatus } from "@/lib/registration-status";
import { joinLinkPath } from "@/lib/join-link";
import { zonedDateInput } from "@/lib/zoned-datetime";

export type EntryStatus =
  | "pending"
  | "paid"
  | "confirmed"
  | "waitlisted"
  | "withdrawn"
  | "expired"
  | "rejected";

/**
 * This entry's own pay-by deadline: its promotion clock if it was promoted
 * out of the waitlist, else the cart's shared deadline. Two different
 * columns on the server (registrations.promotion_expires_at vs
 * registration_groups.expires_at) because a promotion mints a checkout for
 * ONE entry — see promoteWaitlistedRow's doc comment in usecases/registrations/waitlist.ts —
 * so the cart's shared clock cannot govern it without also moving every
 * sibling's own deadline.
 */
export function effectivePayDeadline(
  entryPromotionExpiresAt: string | null,
  cartExpiresAt: string | null,
): string | null {
  return entryPromotionExpiresAt ?? cartExpiresAt;
}

export type MoneyState =
  | { kind: "none" }
  | { kind: "stripe_due"; deadline: string | null }
  /** A card fee is due but the org's Connect account cannot currently take a
   *  payment — resumeRegistrationCheckout would 503. Its own state rather
   *  than folding into stripe_due so the page never renders a "Pay now"
   *  button that is guaranteed to fail on click. `deadline` (B4 fix round 3):
   *  the expiry pass expires the entry at its pay-by date whatever the org's
   *  Stripe state, so the card names the date the person has to sort the
   *  payment with the organiser by. */
  | { kind: "stripe_unavailable"; deadline: string | null }
  | { kind: "offline_due"; deadline: string | null }
  /** RS007 review fix #8 ("pay-then-refund on a stale deadline"): the sweep
   *  that expires an overdue pending entry (and auto-refunds a Stripe one)
   *  runs hourly (cron "37 * * * *"), so a cart whose deadline passed at
   *  14:00 is still 'pending' at 14:36 — this entry's effectivePayDeadline
   *  has passed but the DB row has not caught up yet. Its own state (never
   *  folded into stripe_due/offline_due) so the page can never render a
   *  live "Pay now" button, or offline instructions under a "Pay by" date,
   *  that names a window already closed — resumeRegistrationCheckout
   *  carries the matching server-side re-check (usecases/registrations/checkout.ts), since a
   *  stale tab or a direct POST could otherwise still mint a real session
   *  in the exact window this state exists to close off.
   *
   *  B4 fix round 3 (re-review I1): only a NEVER-promoted entry, whose pay-by
   *  date is the cart's shared `expires_at`. The sweep's expiry pass expires
   *  it, so it has lost its place. */
  | { kind: "window_closed" }
  /** B4 fix round 3 (re-review I1): an entry promoted off the waitlist and
   *  past its OWN `promotion_expires_at`. The sweep's lapse puts it back at
   *  the END of the waitlist (sweep.ts → returnToWaitlist), and the expiry
   *  pass skips a promoted entry (`promoted_at is null`), so it has not lost
   *  its place in the competition: it is waiting again. Nothing to pay, and
   *  no Pay button for the same reason as window_closed. A non-null
   *  `promotion_expires_at` is the promoted half: promoteWaitlistedRow writes
   *  it with promoted_at, and returnToWaitlist clears the two together. */
  | { kind: "promotion_lapsed" };

/**
 * What, if anything, this entry currently owes and how to settle it — the
 * single source both the pay control and the offline-instructions panel
 * read, so the two can never disagree about whether money is due right now.
 */
export function resolveMoneyState(
  entry: {
    status: EntryStatus;
    amount_cents: number;
    promotion_expires_at: string | null;
    /** RS007 review fix #10 ("a lapse timer with no way to pay"): this
     *  entry's OWN division's payment method (registration_settings.
     *  payment_method), never registration_groups.payment_method (the
     *  cart's shared envelope column) — promoteWaitlistedRow only writes
     *  that column when no OTHER entry in the cart is still 'pending' (see
     *  its own doc comment), so it can stay null/stale forever past a
     *  promotion whose own division genuinely charges. buildGroupStatusView
     *  (usecases/registrations/group-status.ts) resolves this per entry now. */
    payment_method: "offline" | "stripe";
  },
  cart: {
    expires_at: string | null;
    charges_enabled: boolean;
  },
): MoneyState {
  const owes = entry.status === "pending" && entry.amount_cents > 0;
  if (!owes) return { kind: "none" };
  const deadline = effectivePayDeadline(entry.promotion_expires_at, cart.expires_at);
  // FIX #8: checked before either branch below, and takes priority over
  // stripe_unavailable too — "the window closed" is the more actionable,
  // more honest fact than "Connect isn't live" when both happen to be true.
  if (deadline && new Date(deadline).getTime() <= Date.now()) {
    return entry.promotion_expires_at !== null ? { kind: "promotion_lapsed" } : { kind: "window_closed" };
  }
  if (entry.payment_method === "stripe") {
    return cart.charges_enabled ? { kind: "stripe_due", deadline } : { kind: "stripe_unavailable", deadline };
  }
  return { kind: "offline_due", deadline };
}

/**
 * Gates the Cancel control. Mirrors withdrawCore's own write-side rules
 * (usecases/registrations/withdraw.ts) rather than the looser `status !== "withdrawn"` some
 * older public reads use: 'rejected' always 422s there ("This registration
 * was rejected and cannot be withdrawn"), and 'expired' already freed its
 * spot with nothing left to cancel — offering the button on either would be
 * exactly the "names an action with no real route" trap the money rules
 * exist to avoid.
 */
export function canCancelEntry(status: EntryStatus): boolean {
  return status !== "withdrawn" && status !== "rejected" && status !== "expired";
}

/**
 * Whether this entry's fee counts as live, current money — shown as this
 * entry's own figure on its card (entry-card.tsx), and used for the page's
 * Subtotal line until B4 T15 replaced it with the money line
 * (`cartMoneySummary`, by settlement). RS007 status-page review FIX 1: the
 * Subtotal used to sum every non-waitlisted entry, which silently included
 * a cancelled entry's stale fee forever — see below.
 *
 * True for pending/paid/confirmed. False for:
 *  - `waitlisted` — its `amount_cents` is always 0 by construction
 *    (registration-submit.ts sets `feeCents = waitlisted ? 0 :
 *    live.fee_cents` at insert; a promotion is the only writer that ever
 *    gives a waitlisted row a real fee, and it flips `status` to `pending`
 *    in that same write). Excluded here defensively rather than relied
 *    upon to always be zero.
 *  - `withdrawn` / `rejected` / `expired` — `withdrawCore`'s update
 *    (usecases/registrations/withdraw.ts), the rejection path (registration-approval.ts),
 *    and the expiry sweep (usecases/registrations/) all touch ONLY `status` and
 *    timestamp columns — NONE of them ever clears `amount_cents` — so a
 *    cancelled entry's `amount_cents` keeps naming its PRE-cancellation
 *    fee forever after. Folding that into a "what's live right now" total
 *    would overstate it: a registrant who cancels one of several entries
 *    would see the page's own Subtotal stay inflated by the dead entry's
 *    fee forever, representing nothing real (not owed, not paid, not
 *    live) — the exact "debt with no route to settle" shape this page's
 *    other money rules already guard against, just on the read side.
 */
export function entryCountsTowardTotal(status: EntryStatus): boolean {
  return status === "pending" || status === "paid" || status === "confirmed";
}

// ---------------------------------------------------------------------------
// Registration redesign B4 T15 (spec §5.1-5.3): what the page leads with. The headline, the money line and "What happens next"
// are three answers read off the same entries; each is a pure function here and the page only words what they return.
// ---------------------------------------------------------------------------

/** What the headline and the money line read off one entry. A `GroupEntryView` (usecases/registrations/group-status.ts) is one. */
export interface StatusEntry {
  status: EntryStatus;
  amount_cents: number;
  promotion_expires_at: string | null;
  payment_method: "offline" | "stripe";
}

/** The cart-level facts `resolveMoneyState` reads. A `GroupStatusView` is one. */
export interface CartPayFacts {
  expires_at: string | null;
  charges_enabled: boolean;
}

// ---------------------------------------------------------------------------
// Registration redesign B5 T18 (spec §6.3): which reference the page quotes where. The hero and the cart's mails keep the CART's
// reference; an entry card and a transfer that pays for one entry quote that entry's own (`GroupEntryView.entry_ref`).
// ---------------------------------------------------------------------------

/** What an entry card prints under its name: its own reference, only in a cart sent with two or more entries. A one-entry cart's reference
 *  is the hero's, so printing it again would say nothing new. `cart_size` is the cart's STORED size (`GroupStatusView.cart_size`), so a
 *  lone survivor of a cart sent with three still prints its `-3`. Null when there is nothing to print (the cart has no reference). */
export function cardEntryReference(entry: { entry_ref: string | null }, cart: { cart_size: number }): string | null {
  return cart.cart_size >= 2 ? entry.entry_ref : null;
}

/** The reference the offline instructions' `{{reference}}` is filled with. Every card that owes offline money shows the SAME rendered
 *  instructions, so one reference serves them all: when exactly ONE entry owes, that entry's own (the transfer pays one amount, and the
 *  organiser matches it to one entry); when several owe, or none does, the cart's, which finds every entry. Null for a cart with no
 *  reference. "Owes" is the card's own rule (`resolveMoneyState` → `offline_due`), so the reference and the instructions beside it can
 *  never disagree about which entries are due. */
export function offlineInstructionsReference(
  entries: readonly (StatusEntry & { entry_ref: string | null })[],
  cart: CartPayFacts & { ref_code: string | null },
): string | null {
  const due = entries.filter((e) => resolveMoneyState(e, cart).kind === "offline_due");
  return due.length === 1 ? due[0]!.entry_ref : cart.ref_code;
}

/** Whether the money line counts this entry's fee as due: a fee owed on an entry that still holds its place. That is `stripe_due`,
 *  `offline_due` and `stripe_unavailable` (the org cannot take a card today, and the person is told to contact the organiser: the fee
 *  is still owed). NOT `window_closed` (B4 fix round 2, controller ruling): the pay-by date has gone by, the place is lost and there is
 *  no way to pay, so "£X still due" beside the card's "it has lost its place" was false. NOT `promotion_lapsed` (round 3): the entry
 *  goes back to the waitlist, and nothing is owed there. The headline reads the money state itself (`entryHeadline`): only the two
 *  states with a way to pay here say "Pay to finish entering". */
function countsDue(entry: StatusEntry, cart: CartPayFacts): boolean {
  const kind = resolveMoneyState(entry, cart).kind;
  return kind === "stripe_due" || kind === "offline_due" || kind === "stripe_unavailable";
}

/** The page's outcome headline (spec §5.1). `payUnavailable` (B4 review m1, owner ruling 2026-11-13): a card fee is owed and the org
 *  cannot take a card today, so the page leads with the card notice ("contact the organiser"), never with Pay. `pool` (B4 review I1):
 *  a confirmed solo sign-up nobody has placed on a team yet ("You're in the player pool"), where `in` would add "Nothing else to do"
 *  above the card's own "Waiting for a team". */
export type HeadlineKind = "pay" | "payUnavailable" | "in" | "pool" | "received" | "waitlist" | "closed";

/** What the headline reads off one entry beyond the money: whether it is a solo sign-up still waiting for a team
 *  (`awaitingTeamAssignment`). A `GroupEntryView` is one. */
export interface HeadlineEntry extends StatusEntry {
  free_agent: boolean;
  assigned_team_name: string | null;
}

/** Most pressing first (0): the cart's headline is the most pressing kind any of its entries reads as (`entryHeadline`). A `Record`, so
 *  a kind added to `HeadlineKind` without a place here does not compile.
 *
 *  `pool` sits above `in` (B4 review I1 ruling): beside a confirmed team entry, "You're in" and its "Nothing else to do" would be
 *  false for the solo sign-up, while "You're in the player pool" and "The organiser places you on a team" stay true for the whole
 *  cart. It sits below `received`: an entry awaiting the organiser's decision comes first, and a solo one cannot be placed until
 *  it is confirmed or paid (assignSoloSignUp, registration-assign.ts). */
const HEADLINE_PRECEDENCE: Record<HeadlineKind, number> = {
  pay: 0,
  payUnavailable: 1,
  received: 2,
  pool: 3,
  in: 4,
  waitlist: 5,
  closed: 6,
};

/**
 * What ONE entry would put at the top of the page on its own. Money first, because an owed fee is the registrant's to act on:
 *  - `stripe_due` / `offline_due` → `pay` (spec §5.1 rule 2: a Pay button, or offline instructions)
 *  - `stripe_unavailable` → `payUnavailable` (owed, and no way to pay here: the card notice)
 *  - `window_closed` → `closed`: a never-promoted entry past the cart's pay-by date. The sweep's expiry pass expires it on its next
 *    run, so it has lost its place (B4 review m1). Never `pay` (nothing can be paid) and never `received` (nobody is reviewing it).
 *    Its card says so.
 *  - `promotion_lapsed` → `waitlist` (B4 fix round 3, re-review I1): a promoted entry past its own pay-by date. The sweep's lapse puts
 *    it back at the end of the waitlist, so the page says what the sweep is about to make true; its card says it goes back.
 *  - otherwise by status: `pending`/`paid` → `received` (owing nothing, so waiting on the organiser), `confirmed` → `pool` while it
 *    is a solo sign-up still waiting for a team (`awaitingTeamAssignment`), else `in`, `waitlisted` → `waitlist` (a waitlisted solo
 *    sign-up is waiting for a place before a team), withdrawn/expired/rejected → `closed`.
 */
function entryHeadline(entry: HeadlineEntry, cart: CartPayFacts): HeadlineKind {
  switch (resolveMoneyState(entry, cart).kind) {
    case "stripe_due":
    case "offline_due":
      return "pay";
    case "stripe_unavailable":
      return "payUnavailable";
    case "window_closed":
      return "closed";
    case "promotion_lapsed":
      return "waitlist";
    case "none":
      break;
  }
  switch (entry.status) {
    case "pending":
    case "paid":
      return "received";
    case "confirmed":
      return awaitingTeamAssignment(entry) ? "pool" : "in";
    case "waitlisted":
      return "waitlist";
    case "withdrawn":
    case "expired":
    case "rejected":
      return "closed";
  }
}

/**
 * The cart's headline. The empty cart first (no entries → `closed`), then the most pressing kind any entry reads as
 * (`entryHeadline`, in `HEADLINE_PRECEDENCE` order). That is spec §5.1's rule ladder: `pay`, then `in` only when nothing is
 * `received` (a confirmed entry beside one awaiting approval reads `received`), then `waitlist`, then `closed`. With the m1 ruling:
 * a card fee owed while cards are unavailable outranks everything but `pay`. An entry past its pay-by date adds only `closed` (never
 * promoted: it is expired) or `waitlist` (a lapsed promotion: it goes back), so beside a confirmed sibling the cart reads `in`.
 */
export function cartHeadline(entries: readonly HeadlineEntry[], cart: CartPayFacts): HeadlineKind {
  if (entries.length === 0) return "closed";
  let headline: HeadlineKind = "closed";
  for (const e of entries) {
    const kind = entryHeadline(e, cart);
    if (HEADLINE_PRECEDENCE[kind] < HEADLINE_PRECEDENCE[headline]) headline = kind;
  }
  return headline;
}

/** B4 fix round 2 (controller ruling): whether the page's h1 already says the card notice for the cart's ONLY live entry, so that
 *  entry's card does not say it again. A cart of two or more live entries keeps the notice on the card that owes: the h1 alone would
 *  not say which entry it is about. Round 3 (re-review m5): a withdrawn, expired or rejected entry is not counted. Its card cannot be
 *  what the notice is about. */
export function headlineCarriesUnavailableNotice(entries: readonly { status: EntryStatus }[], headline: HeadlineKind): boolean {
  return headline === "payUnavailable" && entries.filter((e) => !isTerminalRegistrationStatus(e.status)).length === 1;
}

/** Walk-fix F11: whether the page offers "Resend confirmation email". Not when nothing in the registration is live any more - every
 *  entry rejected, expired, withdrawn or past its pay-by date, which is exactly when the cart's headline reads `closed`
 *  (`cartHeadline`: any live entry outranks it). A confirmation of an entry that has gone is moot, and a mail the player asks for
 *  about it only confuses. One dead entry beside a live one keeps it: the confirmation still covers the live one. */
export function offersResendConfirmation(headline: HeadlineKind): boolean {
  return headline !== "closed";
}

/** Walk-fix A fix round 1: the line under the headline. "Confirmation sent to {email}" states the submit's confirmation; under a
 *  `closed` headline (nothing live - the carts that lose Resend, above) it confirmed nothing, so it says where the registration's
 *  mail goes instead. */
export function contactLineKey(headline: HeadlineKind): "register.status.sentTo" | "register.status.mailTo" {
  return offersResendConfirmation(headline) ? "register.status.sentTo" : "register.status.mailTo";
}

/** How many entries are waiting on the organiser's decision: the count the `received` headline and step are worded for. An entry that
 *  owes a fee is never one of them, including one owed with no way to pay here (B4 review m1). */
export function receivedCount(entries: readonly HeadlineEntry[], cart: CartPayFacts): number {
  return entries.filter((e) => entryHeadline(e, cart) === "received").length;
}

/** What the money line reads off one entry beyond `StatusEntry`: how it was settled (T14, `GroupEntryView.settled_by`, history not
 *  status), what was sent back, and a waitlisted entry's would-be fee. */
export interface MoneyEntry extends StatusEntry {
  settled_by: "card" | "offline" | "waived" | null;
  refunded_cents: number;
  fee_if_promoted_cents: number | null;
}

/** All in the cart's one currency (`GroupStatusView.currency`, snapshotted on the cart at submit; entries carry none). */
export interface MoneySummary {
  paidCents: number;
  dueCents: number;
  waitlistedCents: number;
}

/**
 * The cart's money (spec §5.3).
 *  - `paidCents`: entries settled by `card` or `offline`, each `amount_cents − refunded_cents` floored at 0. By settlement, never by
 *    status: a fee waiver confirms the entry and keeps its `amount_cents` (FP11), so a status sum would show a comped entry as paid.
 *    Settlement is history, so a card-paid entry withdrawn past the refund line stays paid.
 *  - `dueCents`: the fees of entries that owe right now and still hold their place (`countsDue`): never a `window_closed` one.
 *  - `waitlistedCents`: what promotions would set (`fee_if_promoted_cents`), never paid and never due.
 * A `waived` entry adds to none of the three.
 */
export function cartMoneySummary(entries: readonly MoneyEntry[], cart: CartPayFacts): MoneySummary {
  let paidCents = 0;
  let dueCents = 0;
  let waitlistedCents = 0;
  for (const e of entries) {
    if (e.settled_by === "card" || e.settled_by === "offline") paidCents += Math.max(0, e.amount_cents - e.refunded_cents);
    if (countsDue(e, cart)) dueCents += e.amount_cents;
    if (e.status === "waitlisted") waitlistedCents += e.fee_if_promoted_cents ?? 0;
  }
  return { paidCents, dueCents, waitlistedCents };
}

/** Which sentence the money line is (spec §5.3's table): "Paid £X · £Y still due", "Paid £X", "£Y due", "£Z if a place opens — not
 *  due now", "Nothing to pay". */
export type MoneyLineKind = "paidDue" | "paid" | "due" | "waitlisted" | "nothing";

export function moneyLine(summary: MoneySummary): MoneyLineKind {
  if (summary.paidCents > 0 && summary.dueCents > 0) return "paidDue";
  if (summary.paidCents > 0) return "paid";
  if (summary.dueCents > 0) return "due";
  if (summary.waitlistedCents > 0) return "waitlisted";
  return "nothing";
}

/**
 * One line of "What happens next". `key` is the dictionary key; `count`, when present, makes it a `.one`/`.other` plural family.
 * `vars` are RAW values the page localises: `date`, `start`, `end` are 'YYYY-MM-DD' calendar dates and `deadline` an ISO instant.
 */
export type NextItem = { kind: "dates" | "venue" | "step"; key: string; vars: Record<string, string>; count?: number };

/** What "What happens next" reads. A `GroupStatusView` is one. */
export interface NextFacts extends CartPayFacts {
  competition_name: string;
  competition_starts_on: string | null;
  competition_ends_on: string | null;
  venue_name: string | null;
  /** The org's own zone (`GroupStatusView.org_timezone`): what "today" is for the dates line. */
  org_timezone: string;
  entries: readonly (HeadlineEntry & Parameters<typeof inviteLinks>[0])[];
}

/**
 * "What happens next" (spec §5.2), from real data only: the competition's own dates, the one venue the read model names, and one
 * step for the headline. At most three items, in that order. No item promises an email or invents a time (FP9). The empty case: no
 * dates, no venue and a `closed` cart give no items, and the page renders no section.
 *
 * The dates line is a step still ahead (B4 review m7): it goes once the competition's last day (`ends_on`, else `starts_on`) is
 * before today, and today is the calendar day `now` falls on in the org's own zone. A competition running today keeps it.
 */
export function whatHappensNext(view: NextFacts, headline: HeadlineKind, now: Date): NextItem[] {
  const items: NextItem[] = [];
  const start = view.competition_starts_on;
  const over = start !== null && (view.competition_ends_on ?? start) < zonedDateInput(now, view.org_timezone);
  if (start && !over) {
    const end = view.competition_ends_on;
    items.push(
      end && end !== start
        ? { kind: "dates", key: "register.status.next.runs", vars: { name: view.competition_name, start, end } }
        : { kind: "dates", key: "register.status.next.starts", vars: { name: view.competition_name, date: start } },
    );
  }
  if (view.venue_name) items.push({ kind: "venue", key: "register.status.next.venue", vars: { venue: view.venue_name } });
  const step = nextStep(view, headline);
  if (step) items.push(step);
  return items;
}

function nextStep(view: NextFacts, headline: HeadlineKind): NextItem | null {
  const step = (key: string, vars: Record<string, string> = {}): NextItem => ({ kind: "step", key, vars });
  switch (headline) {
    case "pay": {
      const deadline = earliestPayDeadline(view.entries, view);
      return deadline ? step("register.status.next.payBy", { deadline }) : step("register.status.next.pay");
    }
    case "payUnavailable":
      // The headline already says what to do (contact the organiser); nothing can be paid here, so no step names paying.
      return null;
    case "received":
      return { ...step("register.status.next.received"), count: receivedCount(view.entries, view) };
    case "pool":
      return step("register.status.next.pool");
    case "waitlist":
      return step("register.status.next.waitlist");
    case "in":
      // A teammate still to join is the one thing left to do. `inviteLinks` is the invite block's own gate, so this asks for
      // exactly the links the block below offers (a withdrawn entry's dead link asks for nothing).
      return view.entries.some((e) => inviteLinks(e)?.slots.some((slot) => !slot.joined))
        ? step("register.status.next.invite")
        : step("register.status.next.done");
    case "closed":
      return null;
  }
}

/** The soonest pay-by date among the entries that can still be paid. A `window_closed` entry's date has gone by and is never named. */
function earliestPayDeadline(entries: readonly StatusEntry[], cart: CartPayFacts): string | null {
  let soonest: string | null = null;
  for (const e of entries) {
    const money = resolveMoneyState(e, cart);
    if ((money.kind === "stripe_due" || money.kind === "offline_due") && money.deadline) {
      if (soonest === null || Date.parse(money.deadline) < Date.parse(soonest)) soonest = money.deadline;
    }
  }
  return soonest;
}

/** Which words the roster's chips and meter use.
 *  - `joined`: a live entry (pending, paid, confirmed) says who has JOINED it - claimed their place ("Joined", "Not joined yet",
 *    "2 of 3 joined"). "2 of 2 checked in" on an unpaid entry read as attendance at an entry nobody had confirmed (owner ruling on
 *    sign-off V7, 2026-11-12), and on a confirmed one as an attendance nobody gave: registration has no check-in, the count is of
 *    claimed places (walk-fix F10, 2026-11-14; the join success panel's meter says the same).
 *  - `registered`: a waitlisted entry has nothing to join yet (polish wave P3, W6/W10/W11): "Registered", "Not registered yet".
 *  - `ended`: a withdrawn, expired or rejected entry is over and its join links are dead (`canJoinEntry`), so an unclaimed place says
 *    "Not registered" - "yet" promised a registration that can no longer happen (walk-fix A fix round 1).
 *  One row per status, so a new status cannot compile without a ruling. */
export type RosterVocabulary = "joined" | "registered" | "ended";
const ROSTER_VOCABULARY: Record<EntryStatus, RosterVocabulary> = {
  pending: "joined",
  paid: "joined",
  confirmed: "joined",
  waitlisted: "registered",
  withdrawn: "ended",
  expired: "ended",
  rejected: "ended",
};
export function rosterVocabulary(status: EntryStatus): RosterVocabulary {
  return ROSTER_VOCABULARY[status];
}

/**
 * Gates the roster claim/invite affordances (the per-slot "Send {name}
 * their claim link" and the generic "Invite someone new to this entry").
 * Mirrors joinTeamEntry's and previewJoinEntry's own dead-entry gate
 * (registration-submit.ts: both refuse with
 * `["withdrawn", "rejected", "expired"].includes(reg.status)` — a 404 from
 * previewJoinEntry's read, a 422 from joinTeamEntry's write) — an entry in
 * any of those three states makes every claim/invite link this page could
 * construct for it a guaranteed dead link (RS007 status-page review FIX
 * 2). `entry.join_code` being non-null already rules out a free_agent
 * entry on its own (submitRegistrationGroup never mints one for a free
 * agent — registration-submit.ts) — that half of the backend gate is
 * covered by the existing `entry.join_code` check at the call site, not
 * repeated here.
 *
 * Coincides with `canCancelEntry`'s own three-status gate today, but is
 * its OWN rule sourced from a different backend contract
 * (registration-submit.ts, not `withdrawCore` in usecases/registrations/withdraw.ts) — kept as a
 * separate function rather than a call-through so the two can diverge
 * safely if either backend gate ever does.
 */
export function canJoinEntry(status: EntryStatus): boolean {
  return status !== "withdrawn" && status !== "rejected" && status !== "expired";
}

/**
 * RS009 handoff (2026-08-30) — gates the "Waiting for a team" notice.
 * RS012 (found by the walkthrough, not a unit test — a sweep-withdrawn
 * entry's card showed WITHDRAWN next to "Waiting for a team" and an
 * already-past refund date) narrowed it a second time.
 *
 * `free_agent` records this entry's ENTRY MODE (design §5: "an entry with
 * no team of its own yet"), not its current OUTCOME, and neither does
 * `assigned_team_name` on its own: an entry the Stage 2 sweep withdraws for
 * missing its place-by date is still `free_agent = true` and still has no
 * `assigned_team_name` (it was never placed) — `status` is the only column
 * that changes when that happens. Without this check, a withdrawn/rejected/
 * expired solo sign-up reads as "still waiting" forever, contradicting its
 * own status badge right above it.
 */
export function awaitingTeamAssignment(entry: {
  status: EntryStatus;
  free_agent: boolean;
  assigned_team_name?: string | null;
}): boolean {
  return (
    entry.free_agent === true &&
    !entry.assigned_team_name &&
    !isTerminalRegistrationStatus(entry.status)
  );
}

/** RS009 — the other half: the team they were placed on, or null.
 *
 *  Kept beside `awaitingTeamAssignment` deliberately. The two are the same
 *  question asked twice, and a reader who changes one must see the other; if
 *  they ever disagree, a solo sign-up's card says both "waiting for a team"
 *  and "on Riverside Rovers" at once. */
export function assignedTeamName(entry: {
  free_agent: boolean;
  assigned_team_name?: string | null;
}): string | null {
  return entry.free_agent ? (entry.assigned_team_name ?? null) : null;
}

/** RS012 — the other other half: when an unplaced solo sign-up will be
 *  auto-refunded if nobody places them, or null once they ARE placed (or
 *  were never a solo sign-up). Reuses awaitingTeamAssignment's own
 *  predicate rather than re-deriving it, so the two can never disagree
 *  about whether this entry is still waiting. */
export function poolPlaceByDate(entry: {
  status: EntryStatus;
  free_agent: boolean;
  assigned_team_name?: string | null;
  pool_place_by_at?: string | null;
}): string | null {
  return awaitingTeamAssignment(entry) ? (entry.pool_place_by_at ?? null) : null;
}

export interface RosterCounts {
  claimed: number;
  total: number;
}

/** granted/guardian both mean a real person has confirmed the slot; pending
 *  is a captain-entered placeholder still awaiting its own claim. Claiming
 *  flips consent_status in place — it never adds or removes a row — so
 *  `total` is stable across a claim and only `claimed` moves. */
export function rosterCounts(
  players: { consent_status: "pending" | "granted" | "guardian" }[],
): RosterCounts {
  return {
    total: players.length,
    claimed: players.filter((p) => p.consent_status !== "pending").length,
  };
}

/**
 * RS008 — this roster row's own display name, masked by the entry's OWN
 * division youth/player_name_display policy OR the linked person's own
 * consent opt-out, whichever is stricter. A pure pass-through to the single
 * canonical resolver (`lib/name-display.ts`) so this page never grows a
 * second masking rule to drift from it — kept here (rather than called
 * directly from `entry-card.tsx`) only so it sits alongside this file's
 * other roster-shaped pure logic (`rosterCounts`) and is provable without a
 * render, matching this file's own stated convention.
 */
export function rosterPlayerDisplayName(
  player: { full_name: string; consent: { public_name?: boolean } | null },
  division: { youth: boolean; player_name_display: string | null },
): string {
  return resolvePersonDisplayName(
    player.full_name,
    player.consent,
    division.player_name_display,
    division.youth,
  );
}

/**
 * RS008 review fix #1 (Critical) — the entry-card HEADING (this entry's own
 * `display_name`) had ZERO masking, even though the roster rows right below
 * it (`rosterPlayerDisplayName` above) already did. For an `individual`/
 * `pair` entrant `display_name` IS a person's (or a pair's compound) name;
 * `anyOptedOut` aggregates every CURRENT roster member's consent the same
 * "stricter wins across several people sharing one display_name string" way
 * `publicRegistrationStatusByRef`/`buildAdmitTicketsDoc`/`buildDivisionSlides`
 * already do elsewhere in this session — this page has a per-person
 * breakdown available (`entry.players`) but the HEADING itself is one
 * string with no single person it belongs to (a pair's is a compound of
 * two), so it uses the aggregate helper rather than resolving one row.
 *
 * A `team`'s own declared name never takes the consent axis — same bypass
 * established at every other RS008 site (public.ts/public_entrants_v
 * precedent) — checked FIRST and unconditionally, regardless of what the
 * roster's own consents say.
 */
export function entryDisplayName(
  entry: {
    display_name: string;
    entrant_kind: "team" | "individual" | "pair";
    players: { consent: { public_name?: boolean } | null }[];
  },
  division: { youth: boolean; player_name_display: string | null },
): string {
  if (entry.entrant_kind === "team") return entry.display_name;
  return resolvePersonDisplayName(
    entry.display_name,
    anyOptedOut(entry.players.map((p) => p.consent)) ? { public_name: false } : null,
    division.player_name_display,
    division.youth,
  );
}

/**
 * The captain's claim link. The join PAGE itself is a later wave's build
 * (not this one's), so this only mints the href — using the register/join
 * API's own field names (`join_code`, `player_id`, PublicJoinRequest in
 * api-v1/schemas/registration.ts) so that page can read the query string with no remapping.
 * Omitting `playerId` is the generic entry-level link (previewJoinEntry/
 * joinTeamEntry's own "no player_id → insert a new player" fallback).
 */
export function claimHref(
  orgSlug: string,
  competitionSlug: string,
  joinCode: string,
  playerId?: string,
): string {
  return joinLinkPath(orgSlug, competitionSlug, joinCode, playerId);
}

/** What a captain can hand out to bring people onto an entry (polish wave P6): one link per UNCLAIMED roster slot (opens the join page
 *  with that slot already chosen) and, for a team, the general link anyone joining can use. Every slot is listed with whether its
 *  person has joined (polish wave K): the block names the whole roster, and only a slot still to join carries a link. A pair has no general link (its roster is
 *  fixed at two: `joinTeamEntry` 422s the insert-a-new-person path), so only its partner's slot link is real. The URLs are written by
 *  the block that shows them (`joinLinkPath`, lib/join-link.ts); this says WHICH exist. */
export interface InviteLinks {
  /** The code the links are built from, narrowed to non-null by the gate below. */
  joinCode: string;
  /** Every roster slot, in roster order. `joined`: the person has taken the place (granted or guardian consent), so the slot has no
   *  link to hand out. */
  slots: { id: string; joined: boolean }[];
  generic: boolean;
}

/**
 * Which invite links this entry offers, or null when it offers none. The gate the card used to hold inline: a join code to build from
 * (a free agent never mints one), a status that can still be joined (`canJoinEntry`), and something to offer (an unclaimed slot, or
 * a team that may still grow). A link to an entry `joinTeamEntry` would refuse is a dead link, so a withdrawn, rejected or expired
 * entry offers nothing even though its join code is never cleared.
 */
export function inviteLinks(entry: {
  status: EntryStatus;
  join_code: string | null;
  allows_new_joiner: boolean;
  players: { id: string; consent_status: "pending" | "granted" | "guardian" }[];
}): InviteLinks | null {
  if (!entry.join_code || !canJoinEntry(entry.status)) return null;
  const slots = entry.players.map((p) => ({ id: p.id, joined: p.consent_status !== "pending" }));
  // Something to hand out: a slot still to join, or a team that may still grow. A complete pair has no link left.
  if (!slots.some((slot) => !slot.joined) && !entry.allows_new_joiner) return null;
  return { joinCode: entry.join_code, slots, generic: entry.allows_new_joiner };
}

/**
 * Classifies a write-action failure (cancel/pay/resend) by HTTP status alone
 * — never the raw server string — the same "map from HTTP status" contract
 * join-form.tsx's own `classifyJoinFailure` established. This is a SEPARATE
 * classifier from both `classifyJoinFailure` (join/view-model.ts) and
 * `classifySubmitFailure` (register-stepper's submit.ts): neither has a
 * rate-limited bucket (all three of THIS page's write routes now call
 * `publicRateLimit` — `checkout`/`withdraw`/`groups/{id}/resend` route.ts
 * files, verified directly), and 409 does not mean the same thing on every
 * surface either — see `resumeRegistrationCheckout`'s own
 * `REGISTRATION_CHECKOUT_CONFLICT` (a losing compare-and-swap on a
 * concurrent checkout mint — usecases/registrations/) vs. withdraw/resend, which
 * never emit a 409 at all today (only 404/422/503). One shared function
 * rather than three copies since all three write actions need the exact
 * same four-way split; each caller supplies its own action-specific copy
 * for the reachable buckets via its own `Record<StatusActionFailureKind,
 * string>` (mirrors `FAILURE_KEY` in join-form.tsx).
 *
 * Audit finding this fixes (RS007 follow-up): `err.message` — the server's
 * OWN un-localized English text (`apiV1`, client-v1.ts, reads
 * `payload.error.message` verbatim) — used to be the ONLY thing a public
 * visitor saw on any of these three buttons' failure paths. There is no
 * server-side i18n in this repo (deliberate), so that string can never be
 * the PRIMARY user-facing message on an otherwise fully localized page.
 *
 *  - notFound (404): the token/entryId/groupId no longer resolves — same
 *    "regByToken"/"group not found" shape `register.status.notFound`
 *    already covers for the page's own initial load, so failures here
 *    reuse that exact key rather than mint a near-duplicate.
 *  - conflict (409): a genuine concurrency race — "refresh and try again"
 *    is the honest advice (matches the checkout-mint race's own server
 *    message), never "click the exact same thing again blindly".
 *  - rateLimited (429): `publicRateLimit` tripped — transient, caused by
 *    request VOLUME rather than anything about this request's content.
 *  - generic: everything else (422 content-refused — e.g. "already
 *    rejected, cannot withdraw", "nothing to pay", "cart already
 *    terminal"; 503 Connect-not-live; 5xx; no response at all). These read
 *    fine under one honest "try again, or contact the organiser" fallback
 *    — the raw detail (kept as SECONDARY text, register-stepper's FIX 3
 *    convention — none of these three usecases' thrown messages interpolate
 *    the access token or any other secret, verified by reading
 *    withdrawCore/resumeRegistrationCheckout/resendRegistrationConfirmationPublic
 *    directly) still supplies whatever extra color the classification
 *    can't.
 */
export type StatusActionFailureKind = "notFound" | "conflict" | "rateLimited" | "generic";

export function classifyStatusActionFailure(status: number | undefined): StatusActionFailureKind {
  if (status === 404) return "notFound";
  if (status === 409) return "conflict";
  if (status === 429) return "rateLimited";
  return "generic";
}

// ---------------------------------------------------------------------------
// Public write-path URLs. Named constants, not inlined into the client
// components that call them, so the regression test proving "cancel calls
// withdrawRegistrationPublic, never withdrawRegistrationOrganiser" pins the
// SAME string the button actually fetches, not a hand-typed lookalike.
// ---------------------------------------------------------------------------

/** withdrawRegistrationPublic (usecases/registrations/public-status.ts) — actorId is always null on
 *  this path, unlike /api/v1/registrations/{id}/withdraw
 *  (withdrawRegistrationOrganiser, session-authenticated). The `/public/`
 *  segment is the entire difference and the entire risk. */
export const publicWithdrawPath = (entryId: string): string =>
  `/api/v1/public/registrations/${entryId}/withdraw`;

/** resumeRegistrationCheckout — mints/resumes a Stripe session for exactly
 *  this one entry (works the same for a fresh pending entry or a
 *  waitlist-promoted one). */
export const publicCheckoutPath = (entryId: string): string =>
  `/api/v1/public/registrations/${entryId}/checkout`;

/** resendRegistrationConfirmationPublic — GROUP-scoped (the confirmation
 *  mail is cart-shaped), so this is keyed by rid, not by one entry id. */
export const publicResendPath = (groupId: string): string =>
  `/api/v1/public/registrations/groups/${groupId}/resend`;
