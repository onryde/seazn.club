import "server-only";
// Minting and resuming a Stripe checkout for a registration or a cart (see ./index.ts).
import type Stripe from "stripe";
import { sql } from "@/lib/db";
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
): Promise<string> {
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
  const returnBase = token
    ? `${origin}${routes.publicRegisterStatus(ctx.org_slug, ctx.comp_slug)}` +
      `?rid=${groupId}&token=${encodeURIComponent(token)}`
    : `${origin}/r/${firstEntry.ref_code}?src=email`;
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
    line_items: entries.map((reg) => ({
      quantity: 1,
      price_data: {
        currency: reg.currency,
        unit_amount: reg.amount_cents,
        product_data: { name: `${ctx.comp_name} — entry fee (${reg.display_name})` },
      },
    })),
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
  const [stamped] = await sql<{ id: string }[]>`
    update registration_groups
    set checkout_session_id = ${session.id}, fee_percent = ${feePercent}, updated_at = now()
    where id = ${groupId}
      and checkout_session_id is not distinct from ${firstEntry.checkout_session_id}
    returning id`;
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
  return session.url;
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

/** Resume/complete payment from the status page (pending paid regs — fresh
 *  submissions whose checkout was abandoned, and waitlist promotions). */
export async function resumeRegistrationCheckout(
  regId: string,
  token: string,
  origin: string,
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
  if (deadline && deadline.getTime() <= Date.now()) {
    throw new HttpError(422, "This payment window has closed");
  }
  const ctx = await divisionCtx(sql, reg.division_id);
  if (!ctx.charges_enabled) {
    throw new HttpError(503, "Payments are not set up for this organiser yet");
  }
  const url = await createRegistrationCheckout(reg.group_id, [reg.id], ctx, origin, token);
  return { checkout_url: url };
}
