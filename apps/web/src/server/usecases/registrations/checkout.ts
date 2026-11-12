import "server-only";
// Minting and resuming a Stripe checkout for a registration or a cart (see ./index.ts).
import type Stripe from "stripe";
import { sql, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { getStripe } from "@/lib/stripe";
import { isRegistrationCurrency } from "@/lib/currency";
import { routes } from "@/lib/routes";
import { log } from "@/server/logger";
import type { RegistrationWithGroupRow, DivisionCtx } from "./types";
import { effectiveFeePercentFor, applicationFeeCents } from "./helpers";
import { regGroupCols, loadSettings, divisionCtx, regByToken } from "./lookups";

// ---------------------------------------------------------------------------
// Public: submit — REMOVED (RS001 registration demolition)
// ---------------------------------------------------------------------------
//
// `submitRegistration` and its `SubmitResult` return shape inserted a single
// `registrations` row carrying the whole old per-entry payment/contact/roster
// envelope in one INSERT — exactly the shape V363/V364 split across
// `registration_groups` (cart) and `registration_players` (per-player rows).
// There is no mechanical translation of a single-row INSERT into "create a
// cart, then one-or-more entries, then their players" — that is a new group
// submit flow, not a re-pointed query, so it is out of this session's
// "mechanical re-pointing" scope. RS002/RS003 own it (design §4, §7 P1);
// until that PR merges the public register route stays deleted and the
// public pages show the closed state (see the three rewritten pages).
//
// Pure helpers this function used stay exported for RS002 to reuse verbatim:
// `validateAnswers`, `deriveLinkUserId`, `isMinor`, `ageAt`,
// `hashRegistrationToken`. `mintRegistrationToken` (private, token-minting
// only) and `generateRefCode`'s only call site here went with it.
// `eligibilityIssues` was ALSO in this list originally, but the legacy
// string[] wrapper it named was deleted at its source (RS002 W5
// whole-branch review — zero production callers repo-wide, dead since W2).

/**
 * Payment-integrity fix: `createRegistrationCheckout` overwrites
 * `registration_groups.checkout_session_id` every time it mints — nothing
 * expired the session it replaced, so a registrant who clicks "Pay now"
 * twice (an abandoned tab resumed, a reminder email re-minting the same
 * still-open session) leaves a SECOND live, payable Stripe session behind
 * for ~24h. Paying both is already handled (confirmPaidRegistration's
 * `kind: "duplicate"` auto-refund), but preventing the second charge is
 * better than reversing it days later.
 *
 * Design correction: this used to expire the prior session on ANY
 * INTERSECTION between its `registration_ids` and the ids being minted now —
 * wrong, because it also fires on a PARTIAL overlap and strands whatever the
 * prior session covered that the new mint doesn't. Concretely: session S1
 * covers {A,B}; entry A is promoted off the waitlist and S2 is minted for
 * {A} alone; the old intersection check expired S1 outright, so B lost its
 * only payable link and that money was never collected. The correct
 * predicate is SUBSUMPTION: expire the prior session only when the new
 * mint's id set is a superset of (or equal to) the prior session's own ids —
 * every entry the old session could still pay for is also payable through
 * the new one, so nothing is stranded.
 *
 * Must NOT fire for a DISJOINT (or partially-overlapping) prior session:
 * `registrationIds` is an explicit subset (a waitlist promotion pays one
 * entry while its siblings stay separately payable), but
 * `registration_groups` has only ONE `checkout_session_id` column shared by
 * the whole cart — so the "prior" session this reads back could belong to a
 * sibling entry's own, still-legitimate mint. Expired ONLY when BOTH: the
 * prior session is still `open` (a `complete` session is a paid session —
 * never touch it), AND its own `registration_ids` metadata is FULLY covered
 * by the ids being minted now (a prior session with no readable
 * `registration_ids` at all — foreign or malformed — can never be proven
 * covered, so it is left alone too).
 *
 * Best-effort, like every other Stripe side-call in this file: never blocks
 * minting the new session, never surfaces to the registrant.
 */
async function expireSupersededCheckoutSession(
  priorSessionId: string,
  newRegistrationIds: string[],
): Promise<void> {
  try {
    const prior = await getStripe().checkout.sessions.retrieve(priorSessionId);
    if (prior.status !== "open") return; // paid/expired/foreign — never touch it
    const priorIds = checkoutRegistrationIds(prior);
    // Subsumption, not intersection (see doc comment above): expire only
    // when EVERY id the prior session covered is also covered by the new
    // mint. `.every` on an empty array is vacuously true, so priorIds.length
    // is checked explicitly — an unreadable prior coverage set must never
    // read as "fully covered".
    if (priorIds.length === 0) return; // unreadable metadata — can't prove subsumption
    if (!priorIds.every((id) => newRegistrationIds.includes(id))) return; // partial/disjoint — a legitimate sibling session
    await getStripe().checkout.sessions.expire(priorSessionId);
    log.info(
      { priorSessionId, newRegistrationIds },
      "registration: expired a superseded checkout session on re-mint",
    );
  } catch (err) {
    log.error(
      { err, priorSessionId },
      "registration: failed to expire a superseded checkout session — the new session still mints",
    );
  }
}

/**
 * Runs a Checkout Session create and translates Stripe's `amount_too_small`
 * refusal into a clean 422 with a stable code. Every OTHER Stripe failure is
 * now sanitized into a generic 502 (RS007 review finding) instead of
 * rethrown untouched: v1()'s catch-all (http.ts) forwards a non-HttpError's
 * `.message` to the client verbatim, and a Stripe-authored message can name
 * the connected account, a session id, or another identifier that must never
 * reach a registrant (concrete leak: a disconnected/restricted Connect
 * account makes transfer_data.destination invalid below, and Stripe's
 * invalid-request message echoes the account id). Logged server-side at
 * error level before being replaced, so diagnosis stays possible while
 * nothing Stripe-authored is ever rendered.
 */
async function mintOrTranslate(
  create: () => Promise<Stripe.Checkout.Session>,
): Promise<Stripe.Checkout.Session> {
  try {
    return await create();
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "amount_too_small") {
      throw new HttpError(
        422,
        "This entry fee is below the minimum a card payment can charge",
        "REGISTRATION_AMOUNT_TOO_SMALL",
      );
    }
    log.error({ err }, "registration: checkout session create failed (Stripe)");
    throw new HttpError(502, "Stripe was unable to start this checkout — please try again shortly.");
  }
}

/** One Checkout line item per entry. Its narrow return type is assignable to Stripe's `LineItem` (checked by `satisfies` below) and
 *  promises what Stripe's own type leaves optional - a quantity, a unit amount and a name on every line - so a reader that shows
 *  what Checkout will charge (the player payment page, `./pay-page.ts`) reads the SAME lines without an "absent" branch. */
export interface RegistrationLineItem {
  quantity: number;
  price_data: { currency: string; unit_amount: number; product_data: { name: string } };
}

/** The line items `createRegistrationCheckout` sends Stripe for `entries`: the single source of what a registration's Checkout
 *  charges. Pure; the player payment page renders its amount from this, never from `amount_cents` read separately. */
export function registrationLineItems(
  entries: Pick<RegistrationWithGroupRow, "amount_cents" | "currency" | "display_name">[],
  compName: string,
): RegistrationLineItem[] {
  return entries.map((reg) => ({
    quantity: 1,
    price_data: {
      currency: reg.currency,
      unit_amount: reg.amount_cents,
      product_data: { name: `${compName} — entry fee (${reg.display_name})` },
    },
  })) satisfies Stripe.Checkout.SessionCreateParams.LineItem[];
}

/**
 * ONE Stripe checkout session for a SET of a cart's entries (RS003 W3a,
 * owner ruling 1) — not necessarily the whole cart: a waitlist promotion
 * pays for a single entry while its siblings may already be paid, so the
 * unit this function takes is an explicit list of registration ids, always
 * scoped to one `groupId`. One line item per entry (kept the existing
 * per-entry product-name style); charged amount = sum of those entries'
 * `amount_cents`; `application_fee_amount` computed over that SAME sum.
 * Destination charge on the org's Connect account; the platform keeps
 * application_fee_amount (doc 16 §1.1). `token` builds the status-page
 * return URLs (now keyed by the GROUP, since a session can cover more than
 * one entry); null falls back to the token-free /r/[ref] pair (email-minted
 * sessions — the reminder can't recover the hashed token).
 *
 * Currency is validated BEFORE any Stripe call (owner ruling 4): the
 * group's snapshot must both be an allowlisted registration currency and
 * match the org's CURRENT currency (`ctx.currency`, read fresh by the
 * caller's `divisionCtx` call) — a snapshot gone stale since submit 422s
 * here, never as a Stripe-side error on a registrant's pay page.
 *
 * Greenfield conversion (owner ruling 3): this used to key its metadata by
 * one entry alone, singular-registration-id shaped, until this session;
 * there is no compat branch for that old shape — every caller now passes an
 * explicit id list, even when that list has exactly one element.
 */
export async function createRegistrationCheckout(
  groupId: string,
  registrationIds: string[],
  ctx: DivisionCtx,
  origin: string,
  token: string | null,
  opts: RegistrationCheckoutOpts = {},
): Promise<string> {
  return (await mintRegistrationCheckout(groupId, registrationIds, ctx, origin, token, opts)).url;
}

/** `createRegistrationCheckout`'s optional sixth argument. `returnBase` replaces the computed return base (the in-app status
 *  page for a token, else `/r/<ref>?src=email`); it must already carry its query string, since `&checkout=…` is appended to it. */
export interface RegistrationCheckoutOpts {
  returnBase?: string;
}

/** The player payment page's mint (plan 2026-11-11-player-payment-page, Task 3): `entryPointer` claims the entry's own
 *  `registrations.pay_session_id` in the SAME transaction as the cart stamp, conditional on the value the caller read. */
interface MintOpts extends RegistrationCheckoutOpts {
  entryPointer?: { registrationId: string; read: string | null };
}

/** Thrown inside the stamp transaction to roll the cart stamp back when the entry pointer moved since it was read. */
class EntryPointerMoved extends Error {}

/**
 * Mints one session for one entry from its payment page, claiming the entry's `pay_session_id` (read as `read` before minting).
 * One transaction stamps the cart AND the entry pointer, both conditional, BEFORE the prior session is considered for
 * expiry: a press that read the page before another press stamped must lose WITHOUT moving the cart pointer, or its
 * supersede step would expire the session the other press already handed out (both presses would then end with nothing
 * payable). A loser expires its own session and answers 409 `REGISTRATION_CHECKOUT_CONFLICT`, like a lost cart race.
 */
export async function mintEntryPayPageCheckout(
  groupId: string,
  registrationId: string,
  ctx: DivisionCtx,
  origin: string,
  returnBase: string,
  read: string | null,
): Promise<string> {
  const session = await mintRegistrationCheckout(groupId, [registrationId], ctx, origin, null, {
    returnBase,
    entryPointer: { registrationId, read },
  });
  return session.url;
}

async function mintRegistrationCheckout(
  groupId: string,
  registrationIds: string[],
  ctx: DivisionCtx,
  origin: string,
  token: string | null,
  opts: MintOpts,
): Promise<{ id: string; url: string }> {
  // An assumption held as a guard: the base is suffixed with `&checkout=…`, so one without a query string would build a
  // return URL whose first parameter hides inside the path.
  if (opts.returnBase !== undefined && !opts.returnBase.includes("?")) {
    throw new Error("createRegistrationCheckout: returnBase must already carry its query string");
  }
  const entries = await sql<RegistrationWithGroupRow[]>`
    select ${regGroupCols(sql)}
    from registrations r join registration_groups g on g.id = r.group_id
    where r.group_id = ${groupId} and r.id in ${sql(registrationIds)}
    order by r.created_at`;
  if (entries.length === 0) throw new HttpError(422, "No registrations to pay for");
  const firstEntry = entries[0]!;
  const subtotal = entries.reduce((sum, e) => sum + e.amount_cents, 0);
  if (subtotal <= 0) throw new HttpError(422, "This registration has no entry fee");
  // Owner ruling 4: validate the group's currency snapshot BEFORE any Stripe
  // call. Both conditions below share one machine-readable code — "this
  // cart cannot be charged in the currency it quoted right now" is one
  // failure class whether the snapshot was delisted or the org's currency
  // has since moved (same-currency lock pins it to the connected account's
  // settlement currency) — never a Stripe-side error on a registrant's pay
  // page. Every entry shares one currency (a group column), so the first
  // entry's is authoritative.
  if (!isRegistrationCurrency(firstEntry.currency)) {
    throw new HttpError(
      422,
      "This organiser no longer accepts payment in this cart's currency",
      "REGISTRATION_CURRENCY_UNAVAILABLE",
    );
  }
  if (firstEntry.currency !== ctx.currency) {
    throw new HttpError(
      422,
      "This organiser's currency has changed since this cart was created",
      "REGISTRATION_CURRENCY_UNAVAILABLE",
    );
  }
  const [org] = await sql<{ stripe_account_id: string | null }[]>`
    select stripe_account_id from organizations where id = ${ctx.org_id}`;
  if (!org?.stripe_account_id) {
    throw new HttpError(503, "Payments are not set up for this organiser yet");
  }
  // Bound to a const because the session params are now built inside a closure
  // (`mintOrTranslate`): TypeScript's narrowing from the guard above does not
  // survive into a callback, since it cannot prove `org` is not reassigned
  // meanwhile. Caught by `next build`'s type check, which runs the whole app —
  // not by the vitest suites, which never typecheck.
  const destination = org.stripe_account_id;
  const returnBase = opts.returnBase ?? (token
    ? `${origin}${routes.publicRegisterStatus(ctx.org_slug, ctx.comp_slug)}` +
      `?rid=${groupId}&token=${encodeURIComponent(token)}`
    : `${origin}/r/${firstEntry.ref_code}?src=email`);
  // The rate this charge uses: the competition's locked rate if it has one,
  // otherwise the live plan rate. Resolved ONCE and both charged and frozen onto
  // the registration, so the paid transition can stamp the competition with the
  // exact percent this payer was billed — never a re-resolved one that a
  // mid-competition plan change could have moved.
  const feePercent = await effectiveFeePercentFor(ctx.competition_id, ctx.org_id);
  const idsJoined = registrationIds.join(",");
  // Stripe refuses a session whose total converts to less than its minimum
  // charge in the PLATFORM's currency (~30p on this GB platform). That is an
  // organiser misconfiguration — an entry fee set too low — but it lands here,
  // at the moment a registrant tries to pay, and an unmapped Stripe error on a
  // public pay page is precisely what owner ruling 4's currency check exists to
  // prevent. Found by the live per-currency probe: a 500+700 cart is £12.00 in
  // gbp but ₹12.00 in inr, which converts to about 9p and is rejected outright.
  // Mapped narrowly: only `amount_too_small` becomes a clean 422, so any other
  // Stripe failure still surfaces as itself rather than being swallowed.
  const session = await mintOrTranslate(() => getStripe().checkout.sessions.create({
    mode: "payment",
    customer_email: firstEntry.contact_email,
    // fee_percent rides the session so the paid transition can stamp the
    // competition with the rate THIS session was billed at — not
    // reg.fee_percent, which a later re-mint (resume, reminder) overwrites.
    // Without it, paying a stale still-open session after a plan change
    // would lock the competition at a rate no entrant was ever charged.
    //
    // Re-keyed to the GROUP (owner ruling 2): kind:"registration_group",
    // an explicit registration_ids list (comma-joined — Stripe metadata
    // values cap at 500 chars; a maximal 10-entry cart of 36-char uuids
    // joins to ~370, proven in registrations.test.ts) rather than a single
    // registration_id. Wave 3b's webhook rework reads this to flip exactly
    // the listed entries.
    //
    // destination_account rides the session the same way fee_percent does
    // (payment-integrity fix): the Connect account THIS charge's
    // transfer_data.destination is frozen to, right now, at mint time. If
    // the org reconnects a DIFFERENT account before this still-open session
    // is paid, fulfilment compares this stamped value against the org's
    // CURRENT stripe_account_id to detect the drift — see
    // checkDestinationAccountDrift below. A short value (an account id),
    // so it never threatens registration_ids' own near-budget cap above.
    metadata: {
      kind: "registration_group",
      registration_group_id: groupId,
      registration_ids: idsJoined,
      org_id: ctx.org_id,
      fee_percent: String(feePercent),
      destination_account: destination,
    },
    line_items: registrationLineItems(entries, ctx.comp_name),
    payment_intent_data: {
      application_fee_amount: applicationFeeCents(subtotal, feePercent),
      transfer_data: { destination },
      metadata: { registration_group_id: groupId, registration_ids: idsJoined, org_id: ctx.org_id },
    },
    success_url: `${returnBase}&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${returnBase}&checkout=cancelled`,
  }));
  if (!session.url) throw new HttpError(502, "Stripe did not return a checkout URL");
  // checkout_session_id/fee_percent live on the cart (V364) — one row to
  // stamp regardless of how many entries this session covers.
  //
  // Ordering fix: stamped BEFORE expiring the prior session below (used to
  // run the other way round). If this update throws (DB failover, statement
  // timeout, lock wait) the group must still name the OLD, still-open
  // session rather than one this call has already told Stripe to expire —
  // every reader (organiser console, reconcile-by-session, resume) would
  // otherwise be looking at a dead session with no live successor on
  // record.
  //
  // Concurrency fix: the update is conditional on `checkout_session_id`
  // still being the exact value THIS call observed before minting
  // (`firstEntry.checkout_session_id`, read at the top of this function).
  // Two concurrent calls for the same group (a double-clicked "Pay now", two
  // open tabs) each mint a real Stripe session before either commits;
  // without this guard neither would expire the other and the later
  // `update` would silently overwrite the earlier mint's stamp, leaving TWO
  // live, payable sessions — a real double-charge risk (the
  // `kind:"duplicate"` auto-refund path only reverses it after the fact).
  // `is not distinct from` treats a still-null prior value as a match,
  // unlike `=`, so this also protects a cart's very first mint. Deliberately
  // NOT a row lock held across the Stripe call above — serialising every
  // checkout mint on one row for the length of a network round-trip is worse
  // than the race it closes.
  //
  // The payment page's entry pointer (`opts.entryPointer`) is claimed in the same transaction, on the same "is not distinct
  // from the value read" terms; either condition failing rolls both back (see `mintEntryPayPageCheckout`).
  const stampGroup = async (db: typeof sql | Tx) => {
    const [row] = await db<{ id: string }[]>`
      update registration_groups
      set checkout_session_id = ${session.id}, fee_percent = ${feePercent}, updated_at = now()
      where id = ${groupId}
        and checkout_session_id is not distinct from ${firstEntry.checkout_session_id}
      returning id`;
    return row !== undefined;
  };
  const pointer = opts.entryPointer;
  let stamped: boolean;
  if (!pointer) {
    stamped = await stampGroup(sql);
  } else {
    try {
      stamped = await sql.begin(async (tx) => {
        // Gap wave G2: the ENTRY row first, then the cart. Checkout completion (`confirmPaidRegistration`) locks the two in that
        // order in one statement (`select … from registrations r join registration_groups g … for update`), so stamping the cart
        // first here could deadlock against a webhook landing for the same entry mid-mint.
        await tx`select 1 from registrations where id = ${pointer.registrationId} for update`;
        if (!(await stampGroup(tx))) return false;
        const [claimed] = await tx<{ id: string }[]>`
          update registrations
          set pay_session_id = ${session.id}, updated_at = now()
          where id = ${pointer.registrationId} and group_id = ${groupId}
            and pay_session_id is not distinct from ${pointer.read}
          returning id`;
        if (!claimed) throw new EntryPointerMoved();
        return true;
      });
    } catch (err) {
      if (!(err instanceof EntryPointerMoved)) throw err;
      stamped = false;
    }
  }
  if (!stamped) {
    // Lost the race: a concurrent mint already stamped a DIFFERENT session
    // in between this call's read and this update. Nobody has THIS
    // session's URL yet (it is only ever returned below), so it can't be
    // paid — best-effort expire it so it doesn't sit open on Stripe for
    // ~24h, then surface a clean, retryable error. The registrant's own
    // retry re-reads the now-current checkout_session_id and mints cleanly
    // against it.
    try {
      await getStripe().checkout.sessions.expire(session.id);
    } catch (err) {
      log.error(
        { err, sessionId: session.id, groupId },
        "registration: failed to expire our own session after losing the checkout re-mint race",
      );
    }
    throw new HttpError(
      409,
      "Another checkout was just started for this registration — please refresh and try again",
      "REGISTRATION_CHECKOUT_CONFLICT",
    );
  }
  // Payment-integrity fix: best-effort; never blocks the mint that already
  // committed above even if the expire attempt below fails.
  if (firstEntry.checkout_session_id) {
    await expireSupersededCheckoutSession(firstEntry.checkout_session_id, registrationIds);
  }
  return { id: session.id, url: session.url };
}

/**
 * Mints the group's checkout session right after submit, when the cart has
 * at least one payable (`pending`, `amount_cents > 0`) entry priced through
 * Stripe. Called by the public register route so `submitRegistrationGroup`
 * itself (registration-submit.ts, RS002) stays payment-agnostic — it never
 * imports Stripe. Re-reads `payment_method` and the payable entry ids
 * straight from the DB rather than trusting the caller's copy of
 * `SubmitGroupResult` (which has no `payment_method` field at all — it
 * predates this session, when the submit path had no Stripe concern to
 * expose): this keeps "should this mint, and for which entries" logic in
 * exactly one place. Returns null, never throws, for a
 * zero-payable or non-stripe cart (owner ruling 5: an all-waitlisted,
 * all-free, or offline-payment-method group mints nothing) — it only
 * throws for a genuine failure (Connect not live, currency gone stale, a
 * real Stripe error).
 */
export async function mintGroupCheckout(
  groupId: string,
  divisionId: string,
  origin: string,
  token: string,
): Promise<string | null> {
  const [group] = await sql<{ payment_method: string | null }[]>`
    select payment_method from registration_groups where id = ${groupId}`;
  if (!group || group.payment_method !== "stripe") return null;
  const payable = await sql<{ id: string }[]>`
    select id from registrations
    where group_id = ${groupId} and status = 'pending' and amount_cents > 0
    order by created_at`;
  if (payable.length === 0) return null;
  const ctx = await divisionCtx(sql, divisionId);
  if (!ctx.charges_enabled) {
    throw new HttpError(503, "Payments are not set up for this organiser yet");
  }
  return createRegistrationCheckout(
    groupId,
    payable.map((r) => r.id),
    ctx,
    origin,
    token,
  );
}

// ---------------------------------------------------------------------------
// Payment completion (webhook + reconcile-on-return)
// ---------------------------------------------------------------------------

/**
 * checkout.session.completed for a registration (webhook path — reuses the
 * billing_events idempotency shell in the stripe route). Marks paid, then
 * confirms + materialises in one tx. Safe to re-run: paid/confirmed short-
 * circuit, entrant_id is set once.
 */
/** A group checkout session's comma-joined registration_ids metadata (W3a),
 *  parsed to a clean id list — a stray/foreign session with no such field
 *  becomes `[]`, never a false-positive single blank id. */
export function checkoutRegistrationIds(session: Stripe.Checkout.Session): string[] {
  return (session.metadata?.registration_ids ?? "").split(",").filter(Boolean);
}

/** Stripe could not be read or written while deciding whether a stored session still pays. */
const storedSessionUnreadable = () =>
  new HttpError(502, "Stripe was unable to start this checkout — please try again shortly.");

/**
 * Whether a `complete` session still stands for money: `payment_status` `paid`, or `unpaid` behind a PaymentIntent that can still
 * collect. Fail CLOSED: a session is dead only when it has no PaymentIntent, or the intent is `requires_payment_method` (a
 * failed debit sent it back) or `canceled`. Every other status keeps the session alive - `processing` (a delayed method between
 * the customer's confirmation and the bank's answer), `requires_action` (a voucher / bank-transfer method - customer_balance,
 * OXXO, Boleto, Konbini - waiting for the customer to pay), `requires_confirmation`, `requires_capture`, and `succeeded` (the
 * intent can settle before the session's own `payment_status` flips to `paid`) - because minting a second payable session beside
 * one that can still land money is a double charge. An intent that cannot be read refuses (502).
 *
 * The one rule for both Pay buttons: the player payment page's (`payFromPayPage`, on the entry's `pay_session_id`) and the cart
 * status page's (`resumeRegistrationCheckout`, on the cart's `checkout_session_id`).
 */
export async function completedSessionStillPays(stored: Stripe.Checkout.Session, registrationId: string): Promise<boolean> {
  if (stored.payment_status === "paid") return true;
  if (stored.payment_status !== "unpaid") return false;
  const pi = stored.payment_intent;
  if (pi === null) return false;
  if (typeof pi !== "string") return intentCanStillCollect(pi.status);
  try {
    return intentCanStillCollect((await getStripe().paymentIntents.retrieve(pi)).status);
  } catch (err) {
    log.error({ err, registrationId }, "registration: could not read a completed session's payment");
    throw storedSessionUnreadable();
  }
}

function intentCanStillCollect(status: Stripe.PaymentIntent.Status): boolean {
  return status !== "requires_payment_method" && status !== "canceled";
}

/**
 * Refuses (409 `REGISTRATION_PAID_ONLINE`) while a stored session names this entry and can still land money
 * (`completedSessionStillPays`) - a delayed debit still `processing`, a voucher waiting at `requires_action`, or a paid session
 * whose webhook has not landed. Minting beside it would be a second payable session for the entry. Any other stored session -
 * open (superseded after the mint, `expireSupersededCheckoutSession`), expired, a dead `complete` one, or a sibling's - is minted
 * past. A read failure refuses (502) rather than mint beside a session that may still pay.
 *
 * Gap wave G1 (2026-11-12): the cart status page's Pay, on the cart's pointer. Fix round 1 (F2): each Pay button also puts the
 * OTHER button's pointer through it - the status page the entry's `pay_session_id`, the payment page the cart's
 * `checkout_session_id` - so a payment still landing through one button stops the other from minting a second.
 */
export async function refuseWhileSessionPays(
  sessionId: string | null,
  registrationId: string,
): Promise<Stripe.Checkout.Session | null> {
  if (!sessionId) return null;
  let stored: Stripe.Checkout.Session;
  try {
    stored = await getStripe().checkout.sessions.retrieve(sessionId);
  } catch (err) {
    log.error({ err, registrationId }, "registration: could not read a stored checkout session");
    throw storedSessionUnreadable();
  }
  if (stored.status !== "complete" || !checkoutRegistrationIds(stored).includes(registrationId)) return stored;
  if (await completedSessionStillPays(stored, registrationId)) {
    throw new HttpError(409, "A payment for this entry is already on its way", "REGISTRATION_PAID_ONLINE");
  }
  return stored;
}

/** A stored session is handed out again only while more than this is left of it (the sponsor rule's value, sponsors.ts). */
export const PAY_SESSION_REUSE_MARGIN_MS = 10 * 60_000;

/**
 * The URL to hand out again instead of minting, or null: the stored session is still `open`, covers exactly this one entry, and
 * has more than `PAY_SESSION_REUSE_MARGIN_MS` left. The one reuse rule for both Pay buttons (the payment page's, on the entry's
 * `pay_session_id`; the cart status page's, on the cart's `checkout_session_id` and the entry's own).
 *
 * Polish wave W5 (walkthrough S05): Stripe keeps a Checkout session `open` through a declined card, a failed 3-D Secure challenge
 * and the player backing out of Checkout (observed: `status: open`, PaymentIntent `requires_payment_method`), and the same URL
 * takes another card - none of those is a reason to mint a new session.
 */
export function reusableSessionUrl(stored: Stripe.Checkout.Session, registrationId: string, now: Date): string | null {
  if (stored.status !== "open" || !stored.url) return null;
  const ids = checkoutRegistrationIds(stored);
  if (ids.length !== 1 || ids[0] !== registrationId) return null;
  return stored.expires_at * 1000 > now.getTime() + PAY_SESSION_REUSE_MARGIN_MS ? stored.url : null;
}

/** The stored session as Stripe holds it now; a read failure refuses (502). */
export async function readStoredSession(id: string, registrationId: string): Promise<Stripe.Checkout.Session> {
  try {
    return await getStripe().checkout.sessions.retrieve(id);
  } catch (err) {
    log.error({ err, registrationId }, "registration: could not read the stored session");
    throw storedSessionUnreadable();
  }
}

/**
 * Expires an open stored session and answers it as Stripe then holds it. Gap wave G3: Stripe refuses to expire a session that is
 * no longer `open` (it timed out, or was paid in another tab, between the read and this call), which used to be a transient 502.
 * On ANY expire failure the session is read again and that read decides - never the error text: no longer open → returned (the
 * caller mints past an expired one, and puts a complete one through `completedSessionStillPays`); still open → a real failure,
 * 502, since minting beside a session that can still pay is a double charge.
 */
export async function expireStoredSession(id: string, registrationId: string): Promise<Stripe.Checkout.Session> {
  try {
    return await getStripe().checkout.sessions.expire(id);
  } catch (err) {
    const current = await readStoredSession(id, registrationId);
    if (current.status !== "open") {
      // Fix round 1 (F6): the re-read settles it, but the refusal itself is kept - it is the only trace of why the expire failed.
      log.info({ err, registrationId, status: current.status }, "registration: expire refused, the stored session had stopped being open");
      return current;
    }
    log.error({ err, registrationId }, "registration: could not expire the stored session");
    throw storedSessionUnreadable();
  }
}

/** Resume/complete payment from the status page (pending paid regs — fresh
 *  submissions whose checkout was abandoned, and waitlist promotions). Hands an
 *  open session for this entry alone out again (`reusableSessionUrl`, on the
 *  cart's pointer and the entry's own) before minting (polish wave W5). */
export async function resumeRegistrationCheckout(
  regId: string,
  token: string,
  origin: string,
  now: Date = new Date(),
): Promise<{ checkout_url: string }> {
  const reg = await regByToken(regId, token);
  if (reg.status !== "pending") {
    throw new HttpError(422, `Nothing to pay — registration is ${reg.status}`);
  }
  // PR #677 finding M1: #10 fixed the READ side (buildGroupStatusView /
  // resolveMoneyState resolve payment_method per DIVISION) and left this,
  // the write side, still reading the CART column. `promoteWaitlistedRow`
  // only overwrites that column when no other entry in the cart is still
  // 'pending', so a promoted stripe entry sharing a cart with a pending
  // sibling kept a live "Pay now" button whose POST 422'd with the message
  // below — the same dead end #10 was raised for, moved from the button to
  // the click. Resolve it the way the read side does: the DIVISION's
  // setting, falling back to the cart's only when a division has no
  // settings row at all.
  const divSettings = await loadSettings(sql, reg.division_id);
  const effectiveMethod = divSettings?.payment_method ?? reg.payment_method;
  if (effectiveMethod !== "stripe") {
    throw new HttpError(422, "This entry fee is paid directly to the organiser");
  }
  if (reg.amount_cents <= 0) {
    throw new HttpError(422, "This registration has no entry fee");
  }
  // REVIEW FIX (#8, "pay-then-refund on a stale deadline"): the sweep that
  // expires an overdue pending entry (and auto-refunds a paid Stripe one) is
  // hourly (cron "37 * * * *"), so a cart whose deadline passed at 14:00 is
  // still 'pending' at 14:36 — without this check a stale tab or a direct
  // POST in that window would mint a REAL Stripe session, the registrant
  // would pay, and the next sweep expires the row and auto-refunds it
  // straight back out. Same precedence as the client's own
  // effectivePayDeadline (register/status/view-model.ts): this entry's own
  // promotion window if it was promoted out of the waitlist, else the
  // cart's shared window — this is the LOAD-BEARING half; the client-side
  // window_closed state is cosmetic without this.
  const deadline = reg.promotion_expires_at ?? reg.expires_at;
  if (deadline && deadline.getTime() <= now.getTime()) {
    throw new HttpError(422, "This payment window has closed");
  }
  const ctx = await divisionCtx(sql, reg.division_id);
  if (!ctx.charges_enabled) {
    throw new HttpError(503, "Payments are not set up for this organiser yet");
  }
  const cart = await refuseWhileSessionPays(reg.checkout_session_id, reg.id);
  // Fix round 1 (F2): the payment page's session too, when the cart pointer has moved past it (a sibling's mint).
  const [own] = await sql<{ pay_session_id: string | null }[]>`select pay_session_id from registrations where id = ${reg.id}`;
  const pageId = own?.pay_session_id && own.pay_session_id !== reg.checkout_session_id ? own.pay_session_id : null;
  let page = await refuseWhileSessionPays(pageId, reg.id);
  // Polish wave W5 (walkthrough S05: sign-up, decline, Pay now, Pay now opened three sessions): hand an open session for this
  // entry out again rather than mint. Checked after the deadline and Connect refusals above, so a closed window or a disabled
  // account hands out nothing.
  for (const stored of [cart, page]) {
    const reuse = stored ? reusableSessionUrl(stored, reg.id, now) : null;
    if (reuse) return { checkout_url: reuse };
  }
  // The mint below supersedes only the CART pointer's session. The payment page's own session, when the cart pointer has moved
  // past it, would stay payable beside the new one: expire it first (fail-closed, as the payment page expires its own). It is this
  // entry's own pointer - only ever minted for this entry alone (`mintEntryPayPageCheckout`) - so no coverage check is owed.
  if (pageId && page?.status === "open") {
    page = await expireStoredSession(pageId, reg.id);
    if (page.status === "complete" && (await completedSessionStillPays(page, reg.id))) {
      throw new HttpError(409, "A payment for this entry is already on its way", "REGISTRATION_PAID_ONLINE");
    }
  }
  const url = await createRegistrationCheckout(reg.group_id, [reg.id], ctx, origin, token);
  return { checkout_url: url };
}
