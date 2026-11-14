import "server-only";
// The hourly pay-window sweep: reminders, expiries, promotions (see ./index.ts).
import { sql } from "@/lib/db";
import { SPOT_HOLDERS, ownPaymentRefundedCents } from "@/lib/registration-status";
import { enqueueEmailOnce } from "@/server/email-outbox";
import { log } from "@/server/logger";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
import { audit } from "../audit";
import type { RegistrationSettingsRow, RegistrationWithGroupRow, DivisionCtx } from "./types";
import { regGroupCols, loadSettings, divisionCtx } from "./lookups";
import { clearExpiresIfNoLongerNeeded } from "./materialise";
import { freesTeamSlot, promoteOldestWaitlisted, openPromotionSeatGate, notifyPromoted, returnToWaitlist } from "./waitlist";
import { paymentReminderMessage } from "./mail";
import { issuePayLink, recordPayToken } from "./pay-token";
import { refundEntryUnderLock } from "./refunds";
import { queueRegistrationExpiredMails, queueRegistrationPromotionLapsedMails } from "./lifecycle-mail";
import { releaseSoloSignUpPlacement } from "./withdraw";
import { effectivePoolDeadline } from "./list";

// ---------------------------------------------------------------------------
// Pay-window sweep (spec §6) — cron-shaped: /api/cron/registrations, hourly
// ---------------------------------------------------------------------------

/**
 * Four passes over card pendings: (1a) T-24h payment reminders for
 * never-promoted entries, keyed on the CART's shared deadline, carrying a
 * fresh link to the entry's payment page (`/r/pay/<token>`, never a Checkout
 * url — the page mints on Pay), exactly once per registration
 * (registration_groups.reminded_at); (1b) the same T-24h reminder for
 * PROMOTED entries, keyed on THEIR OWN deadline instead
 * (registrations.promotion_reminded_at — V379/RS007: a group-level mark
 * would silence a still-pending sibling's own, unrelated reminder the
 * moment either one fired); (2) expire never-paid submits past the CART's
 * deadline and promote the oldest waitlisted with a new window; (3) lapse
 * PROMOTED entries past their OWN deadline back to the waitlist tail and
 * re-offer the freed slot (V378/RS007). `r.promoted_at is null` vs
 * `is not null` scopes (1a) from (1b) and (2) from (3) identically, so a row
 * can only ever match one reminder pass and one expiry/lapse pass. Each
 * expiry/lapse runs in its own row-locked tx, so a racing webhook
 * serialises: webhook first → paid wins; sweep first → the late payment
 * auto-refunds (confirmPaidRegistration).
 */

// The reminder passes' claim window (V381) — long enough that a genuinely
// in-flight mint+send is never double-claimed, short enough that a crashed
// claim recovers well inside the sweep's own hourly cadence (registrations-
// sweep.yml). The Stripe client this call chain uses has a hard 10s timeout
// and zero retries (lib/stripe.ts's `timeout`/`maxNetworkRetries`), and the
// reminder email is a single, unretried fetch (lib/email.ts) — so one row's
// realistic worst-case mint+send is on the order of seconds, at most a
// couple dozen. 5 minutes leaves roughly an order of magnitude of headroom
// over that, while still being a twelfth of the hourly cadence, so an
// ungraceful death recovers on the very next scheduled sweep rather than
// sitting stale for hours.
const REMINDER_LEASE_MINUTES = 5;

export async function sweepRegistrations(
  origin: string,
): Promise<{
  reminded: number;
  expired: number;
  promoted: number;
  lapsed: number;
  poolDeadlinePassed: number;
}> {
  let reminded = 0;
  let expired = 0;
  let promotedCount = 0;
  let lapsedCount = 0;
  let poolDeadlinePassedCount = 0;

  // payment_method/expires_at live on the cart now (V364).
  // `r.promoted_at is null` (V379/RS007 — found while wiring the promoted-
  // reminder pass below): a promotion into a stripe window EXTENDS the
  // cart's shared expires_at too (promoteWaitlistedRow's `greatest(...)`
  // write, so a still-pending sibling's own deadline is never shortened),
  // which means a promoted entry's OWN clock and the cart's shared one can
  // land in the SAME 24h window at the SAME time — without this filter, a
  // promoted row would be reminded HERE (against the group's — possibly
  // sibling-driven, not this entry's own — deadline) AND by the dedicated
  // promoted pass below (against its real deadline), twice, from two marks.
  // Promoted rows are this query's business no longer; see (1b) below.
  //
  // REVIEW FIX (money-path defect #7, V383) — `submit_reminded_at` replaces
  // the old `g.reminded_at is null` filter. This pass iterates PER ENTRY but
  // used to claim/mark the GROUP row: a cart with two still-pending,
  // never-promoted entries produces two rows here sharing one group_id, and
  // whichever entry's iteration ran first won the group's shared claim —
  // permanently silencing the OTHER entry's own attempt from every future
  // sweep (same group-level filter, now non-null), even though its fee was
  // never presented to anyone (each reminder mints a checkout for the ONE
  // named entry, never the whole cart). V381's lease fix did not touch this
  // — the lease it added was on the SAME group columns. Fixed the same way
  // pass (1b) already scopes a promoted entry's own reminder: this entry's
  // OWN mark, so a still-pending sibling's own, unrelated reminder can never
  // be silenced by this one firing. See the V383 migration's own doc comment
  // for why this is named `submit_*`, not a bare `reminded_at`.
  //
  // Gap wave G5: the method is the DIVISION's (`registration_settings`, NOT NULL), the cart's snapshot only when the division has
  // no settings row - the page's own resolution (`settings?.payment_method ?? reg.payment_method`, pay-page.ts). An organiser who
  // switches a division to offline after a card entry was submitted leaves that cart saying `stripe`; asking the cart sent a card
  // reminder to a page that then shows offline instructions.
  const due = await sql<RegistrationWithGroupRow[]>`
    select ${regGroupCols(sql)}
    from registrations r join registration_groups g on g.id = r.group_id
    left join registration_settings rs on rs.division_id = r.division_id
    where r.status = 'pending' and r.promoted_at is null
      and coalesce(rs.payment_method, g.payment_method) = 'stripe'
      and g.expires_at is not null
      and g.expires_at < now() + interval '24 hours'
      and g.expires_at > now()
      and r.submit_reminded_at is null
    order by g.expires_at
    limit 200`;
  for (const reg of due) {
    let claimed = false;
    try {
      const ctx = await divisionCtx(sql, reg.division_id);
      if (!ctx.charges_enabled) continue; // Connect broke — the page's Pay could not take the card
      // RS007 follow-up (V381) — the claim is a LEASE, not a permanent mark: an ungraceful death (deploy, OOM, SIGKILL) between this
      // UPDATE committing and the queueing transaction below committing runs no `catch`, so a permanent claim would silence this
      // reminder forever. submit_reminder_claimed_at blocks a concurrent claim for REMINDER_LEASE_MINUTES, then goes stale and the
      // row is claimable again; submit_reminded_at — set only in the queueing transaction — stays the permanent record, and the
      // "due" SELECT above filters on THAT column alone.
      //
      // Player payment page (P1): the reminder links the entry's payment page, so nothing external happens here any more — no
      // Checkout session is minted (the page mints one when the player presses Pay). The token, the queued row and the mark are
      // ONE transaction, so any throw before it commits leaves nothing behind and simply releases the lease; the once-key makes a
      // second run of this pass (a lapsed lease, a double sweep) queue nothing more.
      const [row] = await sql<{ id: string }[]>`
        update registrations
        set submit_reminder_claimed_at = now(), updated_at = now()
        where id = ${reg.id} and submit_reminded_at is null
          and (submit_reminder_claimed_at is null
               or submit_reminder_claimed_at < now() - make_interval(mins => ${REMINDER_LEASE_MINUTES}))
        returning id`;
      if (!row) continue; // lease held by a concurrent sweep, or already sent
      claimed = true;
      const link = issuePayLink(origin);
      const message = await paymentReminderMessage(reg, ctx, {
        feeCents: reg.amount_cents,
        paymentInstructions: null,
        method: "card",
        payPageUrl: link.url,
        payDeadline: reg.expires_at,
      });
      await sql.begin(async (tx) => {
        // Gap wave G9: the token is recorded only for a mail this run queued. `null` = the once-key found this reminder already
        // queued (its mark was lost), so the link in THIS body is never sent: recording it would leave a payable link nobody holds.
        // Marked either way - the mail exists.
        const queued = await enqueueEmailOnce(tx, { ...message, dedupeKey: `${reg.id}:submit` });
        if (queued !== null) await recordPayToken(tx, { tokenHash: link.tokenHash, registrationId: reg.id, orgId: reg.org_id });
        await tx`update registrations set submit_reminded_at = now(), updated_at = now()
                 where id = ${reg.id}`;
      });
    } catch (err) {
      log.error({ err, registrationId: reg.id }, "registrations: the payment reminder could not be queued");
      if (claimed) {
        // Nothing committed: clear the LEASE (not the still-null sent mark) and the next sweep retries promptly.
        await sql`update registrations set submit_reminder_claimed_at = null, updated_at = now()
                  where id = ${reg.id}`;
      }
      continue; // submit_reminded_at stays null — a later sweep retries
    }
    reminded++;
  }

  // (1b) V379/RS007 — the promoted counterpart to the pass immediately
  // above: same T-24h window, same mailer, but keyed on THIS entry's own
  // `promotion_expires_at` and marked on THIS entry's own
  // `promotion_reminded_at` — never the group's `reminded_at`, which a cart
  // can share with a still-pending sibling (see (1a)'s comment and the
  // column's own doc comment on `registrations`, V379). `promotion_expires_at
  // is not null` scopes this to rows promoted with a stripe fee (the method check below covers a later switch):
  // `promoteWaitlistedRow` only ever sets it when the promotion itself
  // needed a stripe window (`amount_cents` > 0 at that moment), and nothing
  // else in the codebase writes it.
  // `r.promoted_at is not null` below is what makes `promoted_at` a Date here (the once-key names the promotion by it).
  //
  // Fix round 1 (F4): the window only proves the division took cards AT PROMOTION. An organiser who switches it to offline later
  // leaves the window standing, so the method is resolved now, exactly as pass (1a) (G5) and the page do: the division's settings
  // row, the cart's snapshot only when the division has none.
  const duePromoted = await sql<(RegistrationWithGroupRow & { promoted_at: Date })[]>`
    select ${regGroupCols(sql)}
    from registrations r join registration_groups g on g.id = r.group_id
    left join registration_settings rs on rs.division_id = r.division_id
    where r.status = 'pending' and r.promoted_at is not null
      and coalesce(rs.payment_method, g.payment_method) = 'stripe'
      and r.promotion_expires_at is not null
      and r.promotion_expires_at < now() + interval '24 hours'
      and r.promotion_expires_at > now()
      and r.promotion_reminded_at is null
    order by r.promotion_expires_at
    limit 200`;
  for (const reg of duePromoted) {
    let claimed = false;
    try {
      const ctx = await divisionCtx(sql, reg.division_id);
      if (!ctx.charges_enabled) continue; // Connect broke — the page's Pay could not take the card
      // RS007 follow-up (V381) — same lease as pass (1a) above, on this entry's OWN mark (never the group's, per this pass's own
      // doc comment on why).
      const [row] = await sql<{ id: string }[]>`
        update registrations
        set promotion_reminder_claimed_at = now(), updated_at = now()
        where id = ${reg.id} and promotion_reminded_at is null
          and (promotion_reminder_claimed_at is null
               or promotion_reminder_claimed_at < now() - make_interval(mins => ${REMINDER_LEASE_MINUTES}))
        returning id`;
      if (!row) continue; // lease held by a concurrent sweep, or already sent
      claimed = true;
      // As pass (1a) (P2): the entry's payment page, no Checkout session; the token, the row and this entry's OWN mark are one
      // transaction. The once-key names this PROMOTION (`promoted_at`), so a re-promoted entry, whose second window gets its own
      // reminder, is a new key.
      const link = issuePayLink(origin);
      const message = await paymentReminderMessage(reg, ctx, {
        feeCents: reg.amount_cents,
        paymentInstructions: null,
        method: "card",
        payPageUrl: link.url,
        payDeadline: reg.promotion_expires_at,
      });
      await sql.begin(async (tx) => {
        // Gap wave G9, as pass (1a): a token only for a mail this run queued; marked either way.
        const queued = await enqueueEmailOnce(tx, {
          ...message,
          dedupeKey: `${reg.id}:promotion:${reg.promoted_at.toISOString()}`,
        });
        if (queued !== null) await recordPayToken(tx, { tokenHash: link.tokenHash, registrationId: reg.id, orgId: reg.org_id });
        await tx`update registrations set promotion_reminded_at = now(), updated_at = now()
                 where id = ${reg.id}`;
      });
    } catch (err) {
      log.error({ err, registrationId: reg.id }, "registrations: the promotion payment reminder could not be queued");
      if (claimed) {
        // Nothing committed: clear the LEASE, not the (still-null) sent mark — see pass (1a).
        await sql`update registrations set promotion_reminder_claimed_at = null, updated_at = now()
                  where id = ${reg.id}`;
      }
      continue; // promotion_reminded_at stays null — a later sweep retries
    }
    reminded++;
  }

  // expires_at lives on the cart now (V364). RS002 W5 whole-branch review
  // BLOCKER: this used to filter only status + the CART-shared expires_at,
  // with no per-entry fee or payment-method check — while the reminder pass
  // immediately above DOES filter payment_method = 'stripe'. A cart can hold
  // a free, manual-approval entry alongside a paid stripe one (design allows
  // it; W4's assertUniformPaymentMethod only constrains PAID divisions); the
  // free sibling was never subject to any payment deadline of its own, but
  // shared the cart's expires_at and got silently swept to 'expired' the
  // moment the stripe entry's deadline passed. Same relevance filter the
  // reminder pass uses, PLUS the entry's own fee (a `pending` row can be
  // `amount_cents = 0` even when its cart's method is 'stripe', if a sibling
  // established that method).
  //
  // `r.promoted_at is null` (V378/RS007): a PROMOTED entry now has its own
  // clock (`promotion_expires_at`, checked by the lapse pass below) and must
  // not also fall off the cart's shared one — the STRUCTURAL finding in
  // `_INDEX.md`'s RS007 section is exactly this: promoting one entry in a
  // multi-entry cart used to extend (and later expire) every sibling's
  // deadline right along with it.
  const overdue = await sql<{ id: string; division_id: string; group_id: string }[]>`
    select r.id, r.division_id, r.group_id
    from registrations r join registration_groups g on g.id = r.group_id
    where r.status = 'pending' and r.promoted_at is null and r.amount_cents > 0
      and g.payment_method = 'stripe'
      and g.expires_at is not null and g.expires_at < now()
    order by g.expires_at
    limit 200`;
  for (const { id, division_id } of overdue) {
    const seatGate = await openPromotionSeatGate(division_id);
    const outcome = (await sql.begin(async (tx) => {
      if (seatGate) await seatGate.load(tx);
      const [locked] = await tx<RegistrationWithGroupRow[]>`
        select ${regGroupCols(tx)}
        from registrations r join registration_groups g on g.id = r.group_id
        where r.id = ${id} for update`;
      if (
        !locked ||
        locked.status !== "pending" ||
        !locked.expires_at ||
        new Date(locked.expires_at) > new Date()
      ) {
        return null; // a webhook won the race, or the deadline moved
      }
      await tx`update registrations set status = 'expired', updated_at = now()
               where id = ${id}`;
      // RS009 — same reason withdrawCore does it: expiry is a status change,
      // so V388's cascade never fires and the placement would outlive the
      // entry that created it.
      await releaseSoloSignUpPlacement(tx, id);
      // RS002 W5 whole-branch review MAJOR: expiring the cart's LAST
      // `pending` entry used to leave `expires_at` stale forever — same gap
      // as withdrawCore, same fix.
      await clearExpiresIfNoLongerNeeded(tx, locked.group_id, locked.id);
      const settings = await loadSettings(tx, division_id);
      const [div] = await tx<{ competition_id: string; org_id: string }[]>`
        select competition_id, org_id from divisions where id = ${division_id}`;
      // RS012 `/code-review high` finding 1 (Site C) — a pooled solo sign-up
      // (free_agent = true) never counted toward this division's TEAM
      // capacity in the first place (registration-submit.ts's `taken` gate
      // excludes it), so its own expiry here must never trigger a waitlist
      // promotion. See freesTeamSlot's own doc comment.
      const promoted = freesTeamSlot(locked)
        ? await promoteOldestWaitlisted(tx, division_id, settings, undefined, seatGate)
        : null;
      await audit(tx, div.competition_id, div.org_id, "registration.expired", {
        registration_id: id,
        promoted_registration_id: promoted?.id ?? null,
      }, null);
      if (promoted) {
        await audit(tx, div.competition_id, div.org_id, "registration.promoted", {
          registration_id: promoted.id,
          from: "waitlist",
        }, null);
      }
      // Polish wave P2 (W10): tell the registrant their unpaid place was released, in the transaction that releases it. The sweep has no
      // response to defer behind, so the retry worker makes the first attempt.
      await queueRegistrationExpiredMails(tx, { reg: locked, origin });
      return { promoted, settings, competitionId: div.competition_id };
    })) as unknown as {
      promoted: RegistrationWithGroupRow | null;
      settings: RegistrationSettingsRow | null;
      competitionId: string;
    } | null;
    if (!outcome) continue;
    expired++;
    fireDivisionRevalidate(division_id, outcome.competitionId);
    if (outcome.promoted) {
      promotedCount++;
      const ctx = await divisionCtx(sql, division_id);
      await notifyPromoted(outcome.promoted, ctx, outcome.settings, origin, { firstAttempt: "worker" });
    }
  }

  // Promotion lapse (V378/RS007) — the counterpart pass to the expiry loop
  // above, over the OTHER half of `pending`: rows `promoted_at is null`
  // never reaches. Falling off `promotion_expires_at` does not expire the
  // entry — owner ruling (see `_INDEX.md`'s RS007 section, "FALSE PREMISE —
  // verify RS002 shipped the lapse") is that it re-joins the waitlist TAIL
  // (`waitlisted_at = now()`, so `promoteOldestWaitlisted`'s
  // `coalesce(waitlisted_at, created_at)` sorts it behind anyone who has
  // been waiting since before this moment) and the freed slot is
  // immediately re-offered to the next candidate via the SAME
  // `promoteOldestWaitlisted` the expiry pass above uses — never a forked
  // copy. No join to `registration_groups` needed: every filter/order
  // column here is the entry's own.
  const lapsing = await sql<{ id: string; division_id: string }[]>`
    select r.id, r.division_id
    from registrations r
    where r.status = 'pending' and r.promoted_at is not null
      and r.promotion_expires_at is not null and r.promotion_expires_at < now()
    order by r.promotion_expires_at
    limit 200`;
  for (const { id, division_id } of lapsing) {
    const seatGate = await openPromotionSeatGate(division_id);
    const outcome = (await sql.begin(async (tx) => {
      if (seatGate) await seatGate.load(tx);
      const [locked] = await tx<RegistrationWithGroupRow[]>`
        select ${regGroupCols(tx)}
        from registrations r join registration_groups g on g.id = r.group_id
        where r.id = ${id} for update`;
      if (
        !locked ||
        locked.status !== "pending" ||
        !locked.promoted_at ||
        !locked.promotion_expires_at ||
        new Date(locked.promotion_expires_at) > new Date()
      ) {
        return null; // an organiser action won the race, or the deadline moved
      }
      // PR #677 finding L3, REJECTED after testing — `amount_cents` is
      // deliberately RETAINED here, and clearing it is a money defect.
      //
      // The finding reads the retained fee as breaking a "waitlisted rows
      // are 0 by construction" invariant. Two things are wrong with that.
      // First, the consumer it cites does not rely on the invariant:
      // `entryCountsTowardTotal`'s own comment says waitlisted is "excluded
      // here defensively rather than relied upon to always be zero".
      // Second, and decisively, this row's fee is still LOAD-BEARING after
      // the lapse: a checkout session minted before the deadline can still
      // complete afterwards, and `confirmPaidRegistration`'s `late` branch
      // refunds that payment using this very column. Zeroing it here makes
      // that refund £0.00 — the registrant pays, the entry stays
      // waitlisted, and the money is silently kept. Caught by
      // `registrations.test.ts`'s "a late payment against a promotion that
      // already LAPSED to waitlisted" (expected 500, got 0) while trying
      // the change; left here so the next reader does not retry it.
      //
      // The write is `returnToWaitlist` (waitlist.ts), shared with the organiser's move (B4 fix round 2). It also covers the same
      // stale-deadline gap as the expiry branch: if this was the cart's LAST pending entry, nothing else needs the group's shared clock.
      await returnToWaitlist(tx, locked);
      const settings = await loadSettings(tx, division_id);
      const [div] = await tx<{ competition_id: string; org_id: string }[]>`
        select competition_id, org_id from divisions where id = ${division_id}`;
      // REVIEW FIX (money-path defect #5): exclude the row THIS pass just
      // lapsed — see promoteOldestWaitlisted's own doc comment for why
      // `for update skip locked` alone cannot stop this call from
      // re-selecting it.
      const promoted = await promoteOldestWaitlisted(tx, division_id, settings, id, seatGate);
      await audit(tx, div.competition_id, div.org_id, "registration.promotion_lapsed", {
        registration_id: id,
        promoted_registration_id: promoted?.id ?? null,
      }, null);
      if (promoted) {
        await audit(tx, div.competition_id, div.org_id, "registration.promoted", {
          registration_id: promoted.id,
          from: "waitlist",
        }, null);
      }
      // Polish wave P5 (P2 carry): tell the registrant the held place went to the next in line and the entry is waiting again, in the
      // transaction that puts it back. `locked` still carries the promotion it lost (the once-key). The worker makes the first attempt.
      await queueRegistrationPromotionLapsedMails(tx, { reg: locked, origin });
      return { promoted, settings, competitionId: div.competition_id };
    })) as unknown as {
      promoted: RegistrationWithGroupRow | null;
      settings: RegistrationSettingsRow | null;
      competitionId: string;
    } | null;
    if (!outcome) continue;
    lapsedCount++;
    fireDivisionRevalidate(division_id, outcome.competitionId);
    if (outcome.promoted) {
      promotedCount++;
      const ctx = await divisionCtx(sql, division_id);
      await notifyPromoted(outcome.promoted, ctx, outcome.settings, origin, { firstAttempt: "worker" });
    }
  }

  // (5) RS012 ruling 2 — the pool's own deadline. A solo sign-up is promised
  // at sign-up that "the organiser will assign you to a team once one has
  // space" (register.details.freeAgent copy, RS006). If the place-by date
  // passes with nobody having placed them, that promise is broken and the
  // owner's ruling is that the registrant's money back is the only honest
  // outcome — reusing THIS sweep's own expiry machinery rather than a second
  // money path. `coalesce(rs.place_by_at, rs.closes_at)` is V389's own
  // default: an organiser who never sets an explicit place-by date still
  // gets the ruling's default, the division's own registration close.
  //
  // `not exists (... assigned_from_registration_id ...)` is the DERIVED pool
  // test (V388's own doc comment: "the pool is derived ... and cannot
  // disagree with the roster it is derived from") — an already-placed solo
  // sign-up is excluded here, before any row lock is even taken.
  const duePool = await sql<RegistrationWithGroupRow[]>`
    select ${regGroupCols(sql)}
    from registrations r
    join registration_groups g on g.id = r.group_id
    join registration_settings rs on rs.division_id = r.division_id
    where r.free_agent = true
      and r.status in ${sql([...SPOT_HOLDERS])}
      and coalesce(rs.place_by_at, rs.closes_at) < now()
      and not exists (
        select 1 from registration_players rp
        where rp.assigned_from_registration_id = r.id
      )
    order by coalesce(rs.place_by_at, rs.closes_at)
    limit 200`;
  for (const reg of duePool) {
    const outcome = (await sql.begin(async (tx) => {
      // The outer SELECT above is a stale snapshot the instant it returns:
      // an organiser could have assigned this person since (a race with
      // assignSoloSignUp) or extended place_by_at (ruling 2: "the organiser
      // may place them, or extend the date, right up to it"). Re-verify
      // everything under this row's OWN lock — `regGroupCols` does not even
      // select registration_settings columns, so there is no stale
      // deadline value carried on `reg` to accidentally trust here.
      const [locked] = await tx<RegistrationWithGroupRow[]>`
        select ${regGroupCols(tx)}
        from registrations r join registration_groups g on g.id = r.group_id
        where r.id = ${reg.id} for update`;
      if (!locked || !(SPOT_HOLDERS as readonly string[]).includes(locked.status)) return null;
      const [rs] = await tx<{ place_by_at: Date | null; closes_at: Date | null }[]>`
        select place_by_at, closes_at from registration_settings where division_id = ${locked.division_id}`;
      // RS012 `/code-review high` finding 2 — the ONE `effectivePoolDeadline`
      // copy; the cast narrows its Date | string | null return back to
      // Date | null (rs's own column types) for the `>=` comparison below.
      const deadline = effectivePoolDeadline(rs?.place_by_at ?? null, rs?.closes_at ?? null) as Date | null;
      if (!deadline || deadline >= new Date()) return null; // extended past now, or settings gone
      const [assigned] = await tx<{ id: string }[]>`
        select id from registration_players where assigned_from_registration_id = ${locked.id} limit 1`;
      if (assigned) return null; // placed between the outer select and this lock
      // A free agent never materialises into an entrant (materialise's own
      // RS009 doc comment: "a SOLO SIGN-UP is not a team of one ... simply
      // not seated yet") — there is no entrants row to mark withdrawn and,
      // per the `not exists` guard just above, nothing for
      // releaseSoloSignUpPlacement to release. Unlike withdrawCore, neither
      // is called.
      await tx`
        update registrations
        set status = 'withdrawn', withdrawn_at = now(), updated_at = now()
        where id = ${locked.id}`;
      // clearExpiresIfNoLongerNeeded's own doc comment: call whenever an
      // entry leaves `pending` for a reason that is not a fresh promotion —
      // withdrawCore and the (2)/(3) passes above already do; this pass
      // withdraws a `pending` free agent too (never charged, or offline/
      // free) and was missing it, leaving the cart's `expires_at` stale
      // forever when this was its last pending entry.
      await clearExpiresIfNoLongerNeeded(tx, locked.group_id, locked.id);
      const ctx = await divisionCtx(tx, locked.division_id);
      await audit(tx, ctx.competition_id, ctx.org_id, "registration.withdrawn", {
        registration_id: locked.id,
        by: "system",
        reason: "pool_deadline_unplaced",
      }, null);
      return { locked, ctx };
    })) as unknown as { locked: RegistrationWithGroupRow; ctx: DivisionCtx } | null;
    if (!outcome) continue;
    poolDeadlinePassedCount++;
    const { locked, ctx } = outcome;
    fireDivisionRevalidate(locked.division_id, ctx.competition_id);

    // Unconditional refund (ruling 2) — never gated on resolveRefundPolicy /
    // refund_lock_at. The ordinary cancellation policy answers "how
    // generous is the organiser being"; this is "the organiser broke the
    // promise made at sign-up", a different question with a different,
    // unconditional answer — resolveRefundPolicy could refuse (e.g.
    // refund_lock_at already passed for an unrelated reason) exactly the
    // case ruling 2 says must always refund. Mirrors withdrawCore's own
    // OUTSIDE-the-tx Stripe-call ordering; never CALLS withdrawCore itself,
    // for the same reason.
    if (
      (locked.status === "paid" || locked.status === "confirmed") &&
      locked.entry_payment_intent_id &&
      locked.amount_cents - ownPaymentRefundedCents(locked) > 0
    ) {
      // Polish wave P5 (carry b): the cap is THIS payment's - a late payment's refund in the history is not this one's. Final review
      // m6: moved, capped and booked under the entry's lock with the shared key (`refundEntryUnderLock`), like every other refund
      // path. The receipt is queued in the same transaction; a cron has no response to defer behind, so the first attempt is the
      // worker's. A failure is recorded and alerted there.
      await refundEntryUnderLock({
        regId: locked.id,
        ctx,
        capCents: locked.amount_cents - ownPaymentRefundedCents(locked),
        mode: "auto_pool_deadline",
        actorId: null,
        currency: locked.currency,
      });
    }
  }

  return {
    reminded,
    expired,
    promoted: promotedCount,
    lapsed: lapsedCount,
    poolDeadlinePassed: poolDeadlinePassedCount,
  };
}
