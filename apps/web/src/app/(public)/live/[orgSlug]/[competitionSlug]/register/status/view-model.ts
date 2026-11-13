// Pure view-model logic for the registrant status page (RS007 rebuild).
// Zero React, zero DB — every export is a plain function of plain data, so
// the money/roster/link rules that matter most (never dangle a debt with no
// route to settle; cancel must call the PUBLIC write path, never the
// organiser one) are provable without a render.
import { anyOptedOut, resolvePersonDisplayName } from "@/lib/name-display";
import { isTerminalRegistrationStatus } from "@/lib/registration-status";
import { joinLinkPath } from "@/lib/join-link";

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
   *  button that is guaranteed to fail on click. */
  | { kind: "stripe_unavailable" }
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
   *  in the exact window this state exists to close off. */
  | { kind: "window_closed" };

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
    return { kind: "window_closed" };
  }
  if (entry.payment_method === "stripe") {
    return cart.charges_enabled ? { kind: "stripe_due", deadline } : { kind: "stripe_unavailable" };
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

/** Whether this entry owes its fee right now: every money state but `none`. That includes `stripe_unavailable` (the org cannot take a
 *  card today) and `window_closed` (the pay-by date has gone by, the sweep has not run yet): neither shows a Pay button, and both are
 *  still owed (spec §5.3), so the money line counts them due. The headline reads the money state itself (`entryHeadline`): only the
 *  two states with a way to pay here say "Pay to finish entering". */
function owesFee(entry: StatusEntry, cart: CartPayFacts): boolean {
  return resolveMoneyState(entry, cart).kind !== "none";
}

/** The page's outcome headline (spec §5.1). `payUnavailable` (B4 review m1, owner ruling 2026-11-13): a card fee is owed and the org
 *  cannot take a card today, so the page leads with the card notice ("contact the organiser"), never with Pay. */
export type HeadlineKind = "pay" | "payUnavailable" | "in" | "received" | "waitlist" | "closed";

/** Most pressing first (0): the cart's headline is the most pressing kind any of its entries reads as (`entryHeadline`). A `Record`, so
 *  a kind added to `HeadlineKind` without a place here does not compile. */
const HEADLINE_PRECEDENCE: Record<HeadlineKind, number> = { pay: 0, payUnavailable: 1, received: 2, in: 3, waitlist: 4, closed: 5 };

/**
 * What ONE entry would put at the top of the page on its own. Money first, because an owed fee is the registrant's to act on:
 *  - `stripe_due` / `offline_due` → `pay` (spec §5.1 rule 2: a Pay button, or offline instructions)
 *  - `stripe_unavailable` → `payUnavailable` (owed, and no way to pay here: the card notice)
 *  - `window_closed` → `closed`: the pay-by date has gone by and the sweep expires the entry on its next run, so it has lost its
 *    place (B4 review m1). Never `pay` (nothing can be paid) and never `received` (nobody is reviewing it). Its card says so.
 *  - otherwise by status: `pending`/`paid` → `received` (owing nothing, so waiting on the organiser), `confirmed` → `in`,
 *    `waitlisted` → `waitlist`, withdrawn/expired/rejected → `closed`.
 */
function entryHeadline(entry: StatusEntry, cart: CartPayFacts): HeadlineKind {
  switch (resolveMoneyState(entry, cart).kind) {
    case "stripe_due":
    case "offline_due":
      return "pay";
    case "stripe_unavailable":
      return "payUnavailable";
    case "window_closed":
      return "closed";
    case "none":
      break;
  }
  switch (entry.status) {
    case "pending":
    case "paid":
      return "received";
    case "confirmed":
      return "in";
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
 * a card fee owed while cards are unavailable outranks everything but `pay`, and an entry past its pay-by date adds only `closed`,
 * so beside a confirmed sibling the cart reads `in`.
 */
export function cartHeadline(entries: readonly StatusEntry[], cart: CartPayFacts): HeadlineKind {
  if (entries.length === 0) return "closed";
  let headline: HeadlineKind = "closed";
  for (const e of entries) {
    const kind = entryHeadline(e, cart);
    if (HEADLINE_PRECEDENCE[kind] < HEADLINE_PRECEDENCE[headline]) headline = kind;
  }
  return headline;
}

/** How many entries are waiting on the organiser's decision: the count the `received` headline and step are worded for. An entry that
 *  owes a fee is never one of them, including one owed with no way to pay here (B4 review m1). */
export function receivedCount(entries: readonly StatusEntry[], cart: CartPayFacts): number {
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
 *  - `dueCents`: the fees of entries that owe right now (`owesFee`), including the two owed states with no Pay button.
 *  - `waitlistedCents`: what promotions would set (`fee_if_promoted_cents`), never paid and never due.
 * A `waived` entry adds to none of the three.
 */
export function cartMoneySummary(entries: readonly MoneyEntry[], cart: CartPayFacts): MoneySummary {
  let paidCents = 0;
  let dueCents = 0;
  let waitlistedCents = 0;
  for (const e of entries) {
    if (e.settled_by === "card" || e.settled_by === "offline") paidCents += Math.max(0, e.amount_cents - e.refunded_cents);
    if (owesFee(e, cart)) dueCents += e.amount_cents;
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
  entries: readonly (StatusEntry & Parameters<typeof inviteLinks>[0])[];
}

/**
 * "What happens next" (spec §5.2), from real data only: the competition's own dates, the one venue the read model names, and one
 * step for the headline. At most three items, in that order. No item promises an email or invents a time (FP9). The empty case: no
 * dates, no venue and a `closed` cart give no items, and the page renders no section.
 */
export function whatHappensNext(view: NextFacts, headline: HeadlineKind): NextItem[] {
  const items: NextItem[] = [];
  const start = view.competition_starts_on;
  if (start) {
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
 *  - `checkin`: a CONFIRMED entry asks its players to check in ("Checked in", "Not checked in", "2 of 3 checked in").
 *  - `joined`: a live entry that is not confirmed yet (pending, paid: awaiting payment, approval or both) says who has JOINED
 *    ("Joined", "Not joined yet", "2 of 3 joined") - "2 of 2 checked in" on an unpaid entry read as attendance at an entry nobody had
 *    confirmed (owner ruling on sign-off V7, 2026-11-12; the join success panel's meter says the same).
 *  - `registered`: a waitlisted, withdrawn, expired or rejected entry has nothing to check in to (polish wave P3, W6/W10/W11).
 *  Only `confirmed` says "checked in": a live status added later lands on `joined`, never on the check-in words. */
export type RosterVocabulary = "checkin" | "joined" | "registered";
export function rosterVocabulary(status: EntryStatus): RosterVocabulary {
  if (status === "confirmed") return "checkin";
  return entryCountsTowardTotal(status) ? "joined" : "registered";
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
