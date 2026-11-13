import "server-only";
// Waitlist promotion: the queue order and a place in it, the seat gate, promote the oldest, the promoted notice (see ./index.ts).
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { SPOT_HOLDERS } from "@/lib/registration-status";
import { resolveVenueTz } from "@/lib/tz";
import { registrationPromotedEmail } from "@/lib/email";
import { deferred } from "@/lib/deferred";
import { dispatchNow, enqueueEmailOnce, expiryWithin, recipientLocale } from "@/server/email-outbox";
import type { AuthCtx } from "@/server/api-v1/auth";
import { log } from "@/server/logger";
import { audit } from "../audit";
import { isLichessRosterRefusal } from "../external-accounts";
import { openRegistrationSeatGate, type RegistrationSeatGate, type SeatGate } from "../online-seat-gate";
import { loadEntrantShape } from "../entrant-shape";
import { divisionTakesKind } from "@/lib/division-entrant-kinds";
import type { AnySql, Tx, RegistrationSettingsRow, RegistrationWithGroupRow, DivisionCtx } from "./types";
import { regGroupCols, loadSettings } from "./lookups";
import { materialise } from "./materialise";
import { issuePayLink, recordPayToken } from "./pay-token";

/** The waitlist's queue order, the ONE statement of it: oldest first by `coalesce(waitlisted_at, created_at)`, then `id` (V378/RS007 -
 *  see `promoteOldestWaitlisted`'s doc comment for why a lapsed promotion sorts by `waitlisted_at`). A comma list of `alias`'s keys,
 *  so it reads as an `order by` and, in parentheses, as a row value. `promoteOldestWaitlisted` takes the queue by it and
 *  `waitlistPositionSql` counts by it: the place a registrant is told is the place promotion takes. */
function waitlistQueueKey(db: AnySql, alias: string) {
  const r = db(alias);
  return db`coalesce(${r}.waitlisted_at, ${r}.created_at), ${r}.id`;
}

/** A registration's 1-based place in its division's waitlist, or null when it is not waitlisted - one SQL expression over the row
 *  aliased `alias` (registration redesign B3 T13). The count is of the waitlisted rows of the same division ahead of it in the queue
 *  order promotion takes (`waitlistQueueKey`), so #1 is the next `promoteOldestWaitlisted` picks. Read by every surface that states a
 *  place: the status page (`buildGroupStatusView`), the organiser list, the public status API and the confirmation mail. Before it,
 *  the list and the API counted by `(created_at, id)` and told a lapsed promotion it was first while promotion had put it last.
 *
 *  Promotion also passes over a row another transaction holds (`skip locked`) or the seat gate refuses (an online division); those
 *  keep their place here, as they do in the queue, which offers them the next freed spot. */
export function waitlistPositionSql(db: AnySql, alias: string) {
  const r = db(alias);
  return db`case when ${r}.status = 'waitlisted' then (
      select count(*)::int + 1 from registrations ahead
      where ahead.division_id = ${r}.division_id and ahead.status = 'waitlisted'
        and (${waitlistQueueKey(db, "ahead")}) < (${waitlistQueueKey(db, alias)})
    ) else null end`;
}

/** RS012 ruling 1 — a status leaving SPOT_HOLDERS only frees a TEAM slot
 *  when the entry itself was ever counted as one; a solo sign-up
 *  (`free_agent = true`) never was (registration-submit.ts's `taken` gate
 *  excludes it), so its own withdrawal/rejection/expiry must never trigger
 *  a waitlist promotion. Found by `/code-review high`: withdrawCore and
 *  rejectRegistration both promoted a waitlisted team off a pooled solo
 *  sign-up leaving SPOT_HOLDERS, pushing a division past its configured
 *  capacity with no re-check (promoteOldestWaitlisted trusts the caller
 *  that a slot is genuinely free). */
export function freesTeamSlot(row: { status: string; free_agent: boolean }): boolean {
  return (SPOT_HOLDERS as readonly string[]).includes(row.status) && !row.free_agent;
}

/**
 * Oldest waitlisted → pending (doc 16 §1.1 auto-promotion). Waitlisted rows
 * hold amount 0, so promotion SNAPSHOTS the current fee + method (spec §2);
 * card divisions get a fresh 48h pay window. Returns the promoted row.
 *
 * `currency` is NOT re-snapshotted (RS001b). It is org-level now and the group
 * captured it at submit; design §3 is explicit that a later org-currency change
 * never touches an existing group, and a promotion is not a new quote. Writing
 * the org's CURRENT currency here would silently re-denominate a cart the
 * registrant was already shown a price for.
 *
 * Exported for `registration-approval.ts` (RS002 W5) — `promoteFromWaitlist`'s
 * default (no explicit id) mode calls this directly rather than re-deriving
 * the oldest-first pick.
 *
 * "Oldest" is `coalesce(waitlisted_at, created_at)`, not bare `created_at`
 * (V378/RS007). A row that joined the waitlist at submit has
 * `waitlisted_at = null`, so it waits from its `created_at`. A row
 * `sweepRegistrations`' lapse branch just returned to the waitlist - or the
 * organiser just moved there (`waitlistRegistration`, B3 review I1) -
 * carries a fresh `waitlisted_at = now()`, which sorts it BEHIND
 * every row still waiting on its original `created_at` — the tail, not a
 * reclaimed place in line — even though its OWN `created_at` may be far
 * older than theirs. The order is `waitlistQueueKey`, the same one
 * `waitlistPositionSql` counts a registrant's place by.
 */
/**
 * REVIEW FIX (money-path defect #5) — `excludeId` is optional, additive, and
 * ONLY ever passed by `sweepRegistrations`' lapse branch. `for update skip
 * locked` skips rows locked by an OTHER transaction, never one this same
 * transaction already holds — so a call made in the SAME tx that just
 * flipped a row to 'waitlisted' can, when that row is the only (or oldest)
 * candidate, re-select and immediately re-promote the very row that just
 * lapsed, in the same instant it was returned to the queue. Every OTHER
 * caller (withdrawCore, the sweep's expiry branch, registration-approval.ts's
 * promoteFromWaitlist) omits it and is byte-for-byte unchanged: none of them
 * lock a waitlisted candidate ahead of this call the way the lapse branch
 * does.
 */
export async function promoteOldestWaitlisted(
  tx: Tx,
  divisionId: string,
  settings: RegistrationSettingsRow | null,
  excludeId?: string,
  seatGate?: RegistrationSeatGate,
): Promise<RegistrationWithGroupRow | null> {
  // FU1: where a promotion SEATS the next in line (free, auto approval), it seats them as the settings' kind - and a kind
  // the division no longer takes (Entrant kinds narrowed since they joined) would be refused by `materialise`, failing the
  // withdrawal / expiry / lapse that freed the spot. Nobody can be seated as that kind, so nobody is promoted: the queue
  // stays exactly as it is until the organiser fixes the kind. Asked once - every candidate here is seated as that kind.
  if (promotionSeats(settings) && !divisionTakesKind((await loadEntrantShape(tx, divisionId)).kinds, settings.entrant_kind)) {
    log.warn(
      { divisionId, entrantKind: settings.entrant_kind },
      "registrations: waitlist promotion held - the division no longer takes the registration kind",
    );
    return null;
  }
  // `skipped`: the candidates this call has passed over - `excludeId`, and (with a seat gate) every registrant whose seat the gate
  // refused. A passed-over entry is left exactly as it was: still waitlisted, in its place, picked again by the NEXT freed spot.
  const skipped: string[] = excludeId ? [excludeId] : [];
  for (;;) {
    const [picked] = await tx<{ id: string; group_id: string; free_agent: boolean }[]>`
      select r.id, r.group_id, r.free_agent from registrations r
      where r.division_id = ${divisionId} and r.status = 'waitlisted'
        ${skipped.length > 0 ? tx`and r.id <> all(${skipped})` : tx``}
      order by ${waitlistQueueKey(tx, "r")} limit 1
      for update skip locked`;
    if (!picked) return null;
    if (!seatGate) return promoteWaitlistedRow(tx, picked.id, picked.group_id, settings);
    // ONLINE division: the promotion seats the registrant at once (free, auto-approval - `promotionSeats`), and the seat gate may
    // refuse them (no Lichess link that plays). That must neither fail the withdrawal / sweep / organiser act that freed the spot
    // nor leave the head of the queue stuck: offer the spot to the next in line. Hold-and-notify is not an option - an entry
    // promoted to `pending` WITHOUT a seat can never be confirmed on this kind of division (see the RS010 note on `promoteWaitlistedRow`).
    //
    // Two nets, the cheap one first. The gate already read every waitlisted registrant's link in its prelude, so it can say from that
    // alone who would be turned away (`registrantRefusal`: one small read, no entrant, no person, no savepoint) - a queue of
    // registrants who cannot play yet is walked at that price, not at a full attempted seat each. A solo sign-up seats nobody
    // (`materialise` confirms it and returns), so there is nothing to refuse it for. The savepoint is the net under that one: the
    // seat itself is judged by `assertRoster`, and a registrant the pre-filter let through but the seat refuses rolls back just
    // their own attempt.
    const early = picked.free_agent || !promotionSeats(settings) ? null : await seatGate.registrantRefusal(tx, picked.id);
    if (early) {
      await recordSkippedPromotion(tx, divisionId, picked.id, early);
      skipped.push(picked.id);
      continue;
    }
    try {
      return await tx.savepoint((sp) => promoteWaitlistedRow(sp, picked.id, picked.group_id, settings, seatGate));
    } catch (err) {
      if (!isLichessRosterRefusal(err)) throw err;
      await recordSkippedPromotion(tx, divisionId, picked.id, err);
      skipped.push(picked.id);
    }
  }
}

/** A waitlisted registrant an automatic promotion passed over because the seat gate refused them: logged, and written to the
 *  competition's audit ledger (`registration.promotion_skipped`, with the gate's own code) so the organiser can see WHO was skipped
 *  and why, instead of finding a spot taken by someone behind them in the queue with nothing to explain it. No one is notified. */
async function recordSkippedPromotion(tx: Tx, divisionId: string, registrationId: string, refusal: HttpError): Promise<void> {
  log.warn(
    { registrationId, divisionId, code: refusal.code },
    "registrations: waitlist promotion skipped a registrant who cannot be seated on an online division yet",
  );
  const [division] = await tx<{ competition_id: string; org_id: string }[]>`
    select competition_id, org_id from divisions where id = ${divisionId}`;
  if (!division) return;
  await audit(tx, division.competition_id, division.org_id, "registration.promotion_skipped", {
    registration_id: registrationId,
    division_id: divisionId,
    code: refusal.code ?? null,
  }, null);
}

/** Whether promoting a waitlisted entry under these settings SEATS it at once: a free entry on an auto-approval division confirms
 *  (and so materialises) on the spot. Every other promotion only opens a pay window or waits for the organiser, and seats nobody -
 *  its seat is made later, by a door that carries its own seat gate. The one statement of the rule, read by `promoteWaitlistedRow`'s
 *  fail-closed check and by the callers that decide whether to open a gate. Whether the promoted row itself confirms is decided on its
 *  own price (`promotionConfirmsRow`); for a team row the two agree. */
export function promotionSeats(settings: RegistrationSettingsRow | null): settings is RegistrationSettingsRow {
  return settings?.approval === "auto" && (settings.fee_cents ?? 0) === 0;
}

/** Whether promoting ONE row confirms it on the spot (re-review N1): auto approval and nothing owed by THIS entry - its own price, the
 *  one the promotion just wrote (m3: a solo's `free_agent_fee_cents` when set, else the team fee). For a team row that is exactly
 *  `promotionSeats` (its price is the team fee); a solo's differs when the two fees differ. Deciding on the team fee confirmed a solo
 *  owing 5.00 in a free-for-teams division with the fee unpaid, and left a free solo in a paid-for-teams division pending with no door
 *  to confirm it. A solo seats nobody (`materialise` confirms it and returns), so the seat gate is not needed for one. */
function promotionConfirmsRow(settings: RegistrationSettingsRow | null, amountCents: number): settings is RegistrationSettingsRow {
  return settings?.approval === "auto" && amountCents === 0;
}

/** The seat gate for an AUTOMATIC promotion on `divisionId` (a withdrawal, an expiry, a lapsed pay window), or undefined when a
 *  promotion there seats nobody. Opened out here, before the transaction that promotes. No `auth`: there is no one to ask the
 *  online-chess flag as but the club. `settings` when the caller already has them. */
export async function openPromotionSeatGate(
  divisionId: string,
  settings?: RegistrationSettingsRow | null,
): Promise<RegistrationSeatGate | undefined> {
  const live = settings === undefined ? await loadSettings(sql, divisionId) : settings;
  return promotionSeats(live) ? openRegistrationSeatGate({ divisionId }) : undefined;
}

/** The seat gate for an organiser door that seats ONE named registration (approve, confirm, waive, mark-paid, an explicit promote),
 *  or undefined when there is no such registration (the door's own lookup answers 404). */
export async function openRegistrationSeatGateFor(auth: AuthCtx, regId: string): Promise<RegistrationSeatGate | undefined> {
  const [row] = await sql<{ division_id: string }[]>`select division_id from registrations where id = ${regId}`;
  return row ? openRegistrationSeatGate({ divisionId: row.division_id, registrationId: regId, auth }) : undefined;
}

/**
 * Mechanical promotion of ONE already-locked waitlisted row — factored out of
 * `promoteOldestWaitlisted` so `registration-approval.ts`'s explicit-id
 * override (`promoteFromWaitlist`) shares the identical write rather than
 * re-deriving it. Callers own locking the row and confirming it is actually
 * `waitlisted` first.
 *
 * ── ROUTED MAJOR FIX (RS002 W5, wave-4 finding; REFINED in review) ─────────
 * `payment_method`/`expires_at` live on the entry's CART (`registration_groups`),
 * shared by every entry in it — see the block comment above
 * `RegistrationWithGroupRow`. The pre-wave-5 code unconditionally overwrote
 * both on every promotion, which could null out or redirect a SIBLING
 * entry's live Stripe deadline/method.
 *
 * Both writes are folded into ONE atomic UPDATE (review MAJOR: a separate
 * SELECT-then-conditionally-UPDATE has a race window a lock alone does not
 * close cheaply — two concurrent promotions of DIFFERENT waitlisted siblings
 * in the same cart could each read "no pending sibling" before either
 * commits, reintroducing the clobber). Postgres's own row lock on the
 * `registration_groups` row serializes two transactions that both try to
 * update the SAME cart: the second one's `not exists` subquery only
 * evaluates once it acquires the lock, i.e. after the first commits, so it
 * correctly sees the first promotion's own `status = 'pending'` write — no
 * explicit `for update` needed here for that guarantee.
 *
 * `payment_method`: NOT-EXISTS-guarded exactly as before — only overwritten
 * when no OTHER entry in the cart is still `pending` (the same predicate
 * `sweepRegistrations`' own due/overdue queries use for "still watching this
 * envelope"). Skipped writes leave the cart's existing method untouched.
 * Wave 4's `assertUniformPaymentMethod` already makes every PAID division in
 * one cart agree on method at submit time, so a live divergence here can
 * only mean a division's `registration_settings.payment_method` changed
 * AFTER submit — this function does not attempt to reconcile that; it only
 * guarantees it never clobbers a still-`pending` sibling.
 *
 * `expires_at`: MONOTONIC, not conditional (review MAJOR — the conditional
 * skip above protected a SIBLING's deadline but left the newly-PROMOTED
 * entry with NO deadline of its own whenever it inherited an offline/null
 * envelope: a card-fee promotion into a cart whose only other write was
 * offline got no checkout link and no `expires_at`, and because
 * `sweepRegistrations`' overdue query requires `expires_at is not null`, it
 * could never expire — a permanently unpayable, permanently un-expirable
 * promotion). When THIS promotion itself needs a Stripe window, the
 * deadline can only ever EXTEND — `greatest(coalesce(expires_at, now()),
 * now() + 48h)` — never shorten or null a sibling's existing (possibly
 * later) deadline; same additive pattern the refund paths already use
 * (`greatest(refunded_cents, …)`). When it does not (free/offline
 * promotion), the column is left exactly as it was.
 *
 * ── promotion_expires_at (V378/RS007) — ADDITIVE, alongside the group write
 * above, not instead of it ────────────────────────────────────────────────
 * The group's `expires_at` is shared by every entry in the cart, so
 * `sweepRegistrations` cannot use it to decide THIS entry's own pay window
 * without also catching (or missing) its siblings — see the STRUCTURAL
 * finding in `_INDEX.md`'s RS007 section. `promotion_expires_at` is this
 * row's own clock: same window, same `stripeWindow` gate, but scoped to
 * `regId` alone via a plain overwrite rather than `greatest(...)` — unlike
 * the group's column, nothing else ever writes this one, so there is no
 * sibling deadline to protect from shortening. Left null on an
 * offline/free promotion, exactly like the group's would be if nothing else
 * in the cart needed it.
 * ───────────────────────────────────────────────────────────────────────── */
export async function promoteWaitlistedRow(
  tx: Tx,
  regId: string,
  groupId: string,
  settings: RegistrationSettingsRow | null,
  seatGate?: SeatGate,
): Promise<RegistrationWithGroupRow | null> {
  // FAIL CLOSED. Whether a promotion seats is decided from `settings` here, in the transaction; the caller decided whether to open a
  // seat gate from a read it made BEFORE it. A settings edit in the window between the two (a fee dropped to 0, approval set to auto)
  // would seat the registrant here with nobody having asked the gate. A seating promotion with no gate is refused, not allowed: the
  // act that freed the spot is retried and sees the settings as they are now.
  if (promotionSeats(settings) && !seatGate) {
    throw new HttpError(409, "Registration settings changed while this was being processed - try again");
  }
  // What THIS entry costs (final review m3): a solo sign-up promoted off the waitlist owes its own price, never the team's - the rule
  // submit priced it by and every organiser money gate reads (`entryPriceCents`, polish wave P5 H-2: `free_agent_fee_cents` for a solo
  // when the organiser set one, else `fee_cents`). Written in the UPDATE itself (the row's own `free_agent`), so the promotion stays
  // three statements (the envelope-atomicity pin in registration-approval.test.ts); the price it set comes back with `returning`.
  const teamFee = settings?.fee_cents ?? 0;
  const soloFee = settings?.free_agent_fee_cents ?? null;
  const method = settings?.payment_method ?? "offline";
  const price = tx`(case when free_agent then coalesce(${soloFee}::int, ${teamFee}::int) else ${teamFee}::int end)`;
  const [priced] = await tx<{ amount_cents: number }[]>`
    update registrations
    set status = 'pending', promoted_at = now(), updated_at = now(),
        amount_cents = ${price},
        promotion_expires_at = case
          when ${method === "stripe"} and ${price} > 0 then now() + interval '48 hours'
          else null
        end,
        -- REVIEW FIX (money-path defect #12): every promotion opens a FRESH
        -- reminder window — a re-promotion (lapsed once, re-offered later)
        -- must not carry its FIRST promotion's "already reminded" mark into
        -- this one. Unconditional: a row promoted for the first time already
        -- has this null, so the write is a no-op there.
        promotion_reminded_at = null,
        promotion_reminder_claimed_at = null
    where id = ${regId}
    returning amount_cents`;
  const stripeWindow = method === "stripe" && (priced?.amount_cents ?? 0) > 0;
  await tx`
    update registration_groups
    set payment_method = case
          when not exists (
            select 1 from registrations
            where group_id = ${groupId} and id <> ${regId} and status = 'pending'
          ) then ${method}
          else payment_method
        end,
        expires_at = case
          when ${stripeWindow} then greatest(coalesce(expires_at, now()), now() + interval '48 hours')
          else expires_at
        end,
        updated_at = now()
    where id = ${groupId}`;
  const [row] = await tx<RegistrationWithGroupRow[]>`
    select ${regGroupCols(tx)}
    from registrations r join registration_groups g on g.id = r.group_id
    where r.id = ${regId}`;
  if (!row) return null;

  // RS010 fix — moved HERE (not left to each caller) after `/code-review`
  // found the first attempt only patched `registration-approval.ts`'s
  // `promoteFromWaitlist`, leaving the identical gap live at every OTHER
  // caller of this function: `withdrawCore` (all three withdraw entry
  // points — public, by-ref, organiser) and both `sweepRegistrations` loops.
  // Every caller funnels through this one write, so fixing it here closes
  // all of them at once instead of requiring each call site to remember.
  //
  // Mirrors `submitRegistrationGroup`'s own inline auto-confirm shortcut
  // (`!waitlisted && live.approval === "auto" && feeCents === 0`,
  // registration-submit.ts ~line 850): a FREE entry on an AUTO-approval
  // division confirms immediately at submit, so a promotion out of the
  // waitlist onto that same division must confirm immediately too — leaving
  // it at `pending` here means NOTHING downstream can ever confirm it.
  // `approveRegistration` refuses a `pending` row on an `auto` division
  // ("nothing to approve manually"), and with feeCents === 0 there is no
  // payment webhook either. Before this fix a promoted entry on a free/auto
  // division sat at `pending` forever: no entrant materialised, never
  // counted toward the public entrant list, while `notifyPromoted` (below)
  // still emailed the registrant as if they were in.
  // Re-review N1: decided on the row's OWN price (above), not the team fee.
  if (promotionConfirmsRow(settings, row.amount_cents)) {
    await materialise(tx, row, settings.entrant_kind, seatGate, "waitlist");
    const [confirmed] = await tx<RegistrationWithGroupRow[]>`
      select ${regGroupCols(tx)}
      from registrations r join registration_groups g on g.id = r.group_id
      where r.id = ${regId}`;
    return confirmed ?? row;
  }
  return row;
}

/** Post-tx promoted email: an entry with a fee gets a link to its payment page (`/r/pay/<token>`, never a Checkout url) - card
 *  entries as the Pay button, offline entries beside the resolved instructions; a free promotion links nothing.
 *  Exported for `registration-approval.ts` (RS002 W5) — `promoteFromWaitlist`
 *  reuses this verbatim rather than re-deriving the promoted-email shape.
 *
 *  The mail is QUEUED on the email outbox (kind `registration_promoted`, ref `registration/<id>`, once-key `<id>:<promoted_at>`):
 *  the promotion has already committed, so the enqueue is on the pool AFTER it (P4), and the promotion email must never undo it;
 *  a refusal is logged and swallowed. The once-key is the promotion itself, so a replay of the same promotion queues nothing
 *  more while a re-promotion (a new `promoted_at`) is a new mail. `firstAttempt` says who makes the first attempt: `request`
 *  (a withdrawal or an organiser's action, a person is waiting on the response: it is made after the response) or `worker`
 *  (the cron sweep, which leaves it to the retry worker). */
export async function notifyPromoted(
  promoted: RegistrationWithGroupRow,
  ctx: DivisionCtx,
  settings: RegistrationSettingsRow | null,
  origin: string,
  opts: { firstAttempt: "request" | "worker" },
): Promise<void> {
  try {
    // A promotion always stamps `promoted_at` and the once-key is built from it: refuse by name, BEFORE the pay link is issued.
    if (promoted.promoted_at === null) throw new Error("notifyPromoted: a promoted registration has no promoted_at");
    // REVIEW FIX (#10): the DIVISION's own payment method — never
    // `promoted.payment_method` (registration_groups.payment_method, the
    // cart's shared envelope column). promoteWaitlistedRow only writes that
    // shared column when no OTHER entry in the cart is still 'pending' (see
    // its own doc comment), so it can stay null/stale forever past exactly
    // the promotion this function emails — reading it here silently dropped
    // BOTH the pay link (stripe divisions) and the instructions (offline
    // divisions). Same fallback convention promoteWaitlistedRow's own
    // `method` already uses.
    const method = settings?.payment_method ?? "offline";
    // P3: card or offline, an entry that owes a fee gets its payment page. Nothing external happens: the page mints a Checkout
    // session only when the player presses Pay (and answers Connect being off itself).
    const link = promoted.amount_cents > 0 ? issuePayLink(origin) : null;
    const locale = await recipientLocale(sql, { pick: promoted.locale, userId: promoted.user_id, orgDefault: ctx.default_locale });
    const content = await registrationPromotedEmail(
      {
        orgName: ctx.org_name,
        competitionName: ctx.comp_name,
        displayName: promoted.display_name,
        contactName: promoted.contact_name,
        feeCents: promoted.amount_cents,
        currency: promoted.currency,
        method: method === "stripe" ? "card" : "offline",
        payPageUrl: link?.url ?? null,
        // REVIEW FIX (#13b): this entry's OWN promotion_expires_at, never
        // `promoted.expires_at` (the GROUP's shared column, which a sibling's
        // own earlier/later promotion can leave disagreeing with this row) —
        // the lapse sweep enforces THIS entry's own clock (sweepRegistrations
        // pass 1b, keyed on `r.promotion_expires_at`), so emailing the
        // group's could tell a registrant they have longer than they
        // actually do. Same column pass (1b)'s own reminder mail already
        // uses. Null on an offline/free promotion, exactly as before.
        payDeadline: promoted.promotion_expires_at,
        timeZone: resolveVenueTz(null, ctx.org_timezone),
        paymentInstructions:
          method === "offline" && promoted.amount_cents > 0
            ? (settings?.payment_instructions ?? ctx.payment_instructions)
            : null,
        refCode: promoted.ref_code,
        refStatusUrl: promoted.ref_code ? `${origin}/r/${promoted.ref_code}` : null,
      },
      locale,
    );
    // The row and its link's token are ONE transaction: a token is recorded only for a mail that was queued (a replay queues
    // nothing, so it records nothing).
    const promotedAt = promoted.promoted_at;
    const id = await sql.begin(async (tx) => {
      const queued = await enqueueEmailOnce(tx, {
        kind: "registration_promoted",
        refType: "registration",
        refId: promoted.id,
        orgId: promoted.org_id,
        to: promoted.contact_email,
        ...content,
        transactional: false,
        expiresAt: expiryWithin(promoted.promotion_expires_at),
        dedupeKey: `${promoted.id}:${promotedAt.toISOString()}`,
      });
      if (queued !== null && link) {
        await recordPayToken(tx, { tokenHash: link.tokenHash, registrationId: promoted.id, orgId: promoted.org_id });
      }
      return queued;
    });
    // `null` = this promotion's mail is already queued (a replay): nothing more to attempt.
    if (opts.firstAttempt === "request" && id !== null) deferred(() => dispatchNow([id]));
  } catch (err) {
    log.error({ err, registrationId: promoted.id }, "registration: promotion email could not be queued");
  }
}
