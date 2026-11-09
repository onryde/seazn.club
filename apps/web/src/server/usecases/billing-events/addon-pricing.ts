import "server-only";
// Stripe event processing: extra-org rider re-pricing and its reconciliation sweep (see ./index.ts).
import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import {
  ORG_ADDON_FEATURE_KEY,
  isOrgAddonItem,
  orgAddonForPlan,
  resolveOrgAddonPriceId,
} from "@/lib/org-addons";
import { LIVE_SUBSCRIPTION_STATUSES } from "@/lib/subscription-status";
import { getStripe } from "@/lib/stripe";
import { staffAlertsOn } from "@/server/usecases/staff-alert";
import { maybeAlertOrgRepriceFailed } from "./staff-alerts";
import { isLiveStripeStatus } from "./group-resolution";

/**
 * Move this subscription's extra-ORGANISATION items onto the price of the
 * group's CURRENT plan (v17 gap #293, Task 4b).
 *
 * WHY THIS EXISTS. The rider is sold at two rates that depend on the plan
 * ($9/mo on Pro, $19/mo on Pro Plus). `setExtraOrgs` re-prices on a PURCHASE,
 * but the common case is not a purchase: a group that upgrades pro -> pro_plus
 * never calls it, and the row sync below reconciles ROWS only — it never looks
 * at an item's price. So an upgraded Pro Plus group kept paying $9/rider for
 * ever (the "Pro + riders undercuts Pro Plus" arbitrage the two rates exist to
 * close) and a downgraded Pro group kept paying $19 (the overcharge mirror).
 *
 * WHY THE WEBHOOK. It is the single convergence point: it fires for an in-app
 * plan change, a Stripe Dashboard edit and a Customer Portal change alike.
 * Fixing only the in-app path would leave the other two open.
 *
 * COMPARED BY PRICE ID, NOT LOOKUP KEY. After a drift replacement with
 * `transfer_lookup_key: true` the superseded price object reports
 * `lookup_key: null`, so a lookup-key comparison cannot tell "wrong tier" from
 * "right tier, superseded price object". Both want the SAME action — move to
 * the price the catalog resolves today — and an id comparison gives exactly
 * that, while being a clean no-op once converged. It also agrees with what
 * setExtraOrgs's survivor match does with each case, which is the property
 * that keeps the active and passive halves from fighting.
 *
 * IN-PLACE UPDATE, NOT DELETE+CREATE. `subscriptionItems.update(id, { price })`
 * is Stripe's documented way to replace the price of an item
 * (billing/subscriptions/change-price, "Update the subscription item"). It
 * preserves `stripe_item_id`, so every org_addons row keyed on it stays valid,
 * there is no window in which the group has no rider, and no row is orphaned.
 * `quantity` is passed EXPLICITLY because that doc is also explicit that
 * changing a price "automatically reverts the quantity to the default value of
 * 1" — omitting it would silently cut a 5-rider group to 1 and revoke four
 * organisations' worth of capacity it is still entitled to.
 *
 * PRORATION: the default, stated explicitly. An upgrade mid-cycle should pay
 * the higher rider rate from the moment of the change and a downgrade should
 * credit the unused remainder — which is exactly what the plan item itself
 * does on the same event, and what setExtraOrgs already does for a tier swap.
 * `create_prorations` books those adjustments onto the next invoice rather than
 * charging immediately (`always_invoice`), so a webhook can never trigger a
 * surprise off-session payment.
 *
 * CONVERGENCE, NOT A LOOP. This update itself produces another
 * `customer.subscription.updated`; on that event every id already matches and
 * nothing is written. The `no write when already correct` tests pin it.
 *
 * NEVER THROWS. The reachable failures are an unsynced catalog
 * (`resolveOrgAddonPriceId` 503) and a Stripe rejection of the item update
 * (notably a subscription in a currency the rider price does not define — the
 * #191 class of problem). A throw here would fail the whole webhook, which
 * Stripe then retries for ever and which would block every handler after it —
 * including the row sync, which is the thing the entitlement resolver actually
 * reads. So a failure is logged AND STAFF-ALERTED and processing continues:
 * rows still reconcile, only the PRICE stays stale.
 *
 * A FAILURE IS OBSERVABLE, NOT REPAIRED. There is no retry here: this runs only
 * when a `customer.subscription.created`/`.updated` event arrives, so "the next
 * event re-converges it" is worth nothing for a group Stripe has no reason to
 * emit another event about.
 * That group bills the wrong rate indefinitely, which is why every failure path
 * raises a staff alert rather than only a log.
 *
 * `sweepStaleOrgAddonPrices` (#332, below) is the second half of that net: it
 * finds a group that went stale before the alert existed, or whose alert was
 * missed. It REPORTS ONLY — it re-prices nothing — so this alert is still what
 * a responder acts on, and the sweep is still not a repair. Note also that it
 * is not yet SCHEDULED: the cron step and the /admin mismatch list that read it
 * are the remaining halves of #332.
 */
export async function convergeOrgAddonPrices(
  stripeSub: Stripe.Subscription,
  subscriptionId: string,
): Promise<void> {
  const items = stripeSub.items?.data ?? [];
  const orgItems = items.filter(isOrgAddonItem);
  // Nothing to converge: spend NO database read and NO Stripe round trip. This
  // handler runs on every dunning retry, seat change and plan edit for every
  // group we bill, and the overwhelming majority carry no rider at all — this
  // guard is what stops `subscription.updated` becoming a `prices.list`.
  if (orgItems.length === 0) return;
  // Stripe emits a final `customer.subscription.updated` carrying
  // status: "canceled" just before `deleted`. There is nothing to re-price on a
  // dead subscription — an item update against one is rejected — so skip it
  // rather than spend a round trip, fail, and alert staff about a group that is
  // leaving anyway. handleSubscriptionDeleted owns what happens next.
  if (!isLiveStripeStatus(stripeSub.status)) return;
  // Declared OUT here so the failure alert can name it. The overwhelmingly
  // common failure below is resolveOrgAddonPriceId's 503, which throws AFTER
  // this has been read — so scoping it to the try would make the alert say
  // "unknown" for the one case it was written for, and a responder could not
  // tell whether to expect the $9 or the $19 SKU. It stays "unknown" only when
  // the plan read itself is what failed, which is what the default is for.
  let planKey = "unknown";
  try {
    // The group's plan AFTER syncSubscriptionForGroup has written this event,
    // which is why this call sits downstream of it. Read from the row rather
    // than re-derived from the payload: the row is what the entitlement
    // resolver uses, and it already encodes syncSubscription's "unknown price
    // keeps the current plan" rule, so the price we bill for and the plan we
    // entitle can never disagree.
    const [row] = await sql<{ plan_key: string }[]>`
      select plan_key from subscriptions where id = ${subscriptionId}`;
    planKey = row?.plan_key ?? "community";
    // A plan with no rider SKU (community, or a future tier not yet seeded).
    // Do NOTHING — not a re-price, and deliberately not a cancel either. The
    // cancel paths own removal (handleSubscriptionDeleted for churn,
    // setExtraOrgs for a customer choosing to stop), and silently deleting a
    // paid subscription item from inside a webhook — on a plan reading we may
    // have inferred from an unknown price — is not a call this function gets
    // to make. A group that lands here keeps its rider until one of those runs.
    if (!orgAddonForPlan(planKey)) return;

    const expectedPriceId = await resolveOrgAddonPriceId(planKey);
    // Stripe will not accept two items on one subscription carrying the same
    // price, and duplicates ARE reachable (two concurrent creates — see
    // setExtraOrgs' FILTER-not-find comment). So the target price is claimed at
    // most once: if some item already holds it, no other item is moved onto it.
    // Consolidating duplicates is setExtraOrgs' job, not a webhook's — the
    // webhook's contract here is "the rate is right", not "the shape is tidy".
    // The OPENING claim, read from PAYLOAD prices — `orgItems` holds the event's
    // objects and is NOT rewritten by the publish below (only `items`, the array
    // the row sync reads, is). So this scan can be wrong in one direction: it
    // can claim the target from an item that has since moved off it, which makes
    // every other item take the duplicate exit and alert instead of converging.
    //
    // That fails SAFE in the sense that matters most — an alert and no write,
    // rather than a write Stripe would reject for a duplicate price. And it is
    // not sticky: `handleSubscriptionChanged` calls this on EVERY
    // `customer.subscription.created`/`.updated` delivery THIS GROUP IS WRITTEN
    // FOR (two gates stand in front of it: a subscription that resolves to no
    // group, and an out-of-order delivery `mayWriteGroup` refuses), not only on
    // a plan change, and each one carries a fresh payload — so the next
    // subscription event of any kind (a dunning retry, a seat purchase, a plan
    // edit) that clears those gates re-reads the claim and converges the item
    // then. What does not exist is anything
    // that SCHEDULES such an event: no retry, and #332's sweep REPORTS rather
    // than re-converging (and is not wired to a cron yet), which is the header's
    // point. A group nothing else touches keeps billing the wrong rate until
    // something touches it.
    //
    // And the alert it sends is MISLEADING in this case specifically: `reason`
    // reads "another subscription item already holds the target price (duplicate
    // rider)", which is what a responder will go looking for — on a subscription
    // that may have no duplicate at all, only a stale payload. The branch below
    // narrows this by re-checking against LIVE state first, so an item Stripe has
    // already moved onto the target claims it there rather than being alerted;
    // what survives is the case where the payload's claimant has moved OFF.
    //
    // Making the opening scan live would mean retrieving every rider up front,
    // i.e. paying the duplicate case's cost on every subscription that has one
    // rider.
    //
    // Scanned over EVERY org-addon item, including a quantity-0 one. That is
    // deliberate and is why this predicate differs from the `qty <= 0` skip
    // below: a zero-quantity subscription item still EXISTS in Stripe and still
    // occupies its price, so it still blocks another item from moving onto it.
    // The skip below is about not paying to re-rate something on its way out;
    // this is about what Stripe will accept. They are different questions.
    let targetClaimed = orgItems.some((it) => it.price?.id === expectedPriceId);
    for (const item of orgItems) {
      // EXACTLY TWO EXITS LEAVE BEFORE THE LIVE READ, and both are therefore
      // payload-trust windows: this one and the `qty <= 0` check under it.
      //
      // The other SIX leave after it: already converged, duplicate rider,
      // quantity emptied, update succeeded, update rejected, and the vanished
      // item (`isStripeResourceMissing`). FOUR of those six ALWAYS leave after
      // the PUBLISH too, so the row sync sees what Stripe holds: already
      // converged, duplicate rider, quantity emptied, update succeeded.
      //
      // The remaining two are the catch exits (update rejected, vanished item),
      // and they are CONDITIONAL rather than exceptions: reached from a failed
      // UPDATE they are after the publish like the rest, because the retrieve
      // had already run; reached from a failed RETRIEVE they are not — `live` is
      // still null, the publish never ran, and the sync reads the snapshot. That
      // second case is unavoidable (there is no live state to publish) and is
      // why the vanished item deliberately keeps its row: see the `let live`
      // declaration below.
      //
      // Four-plus-two, not five-plus-one. An earlier version of this list said
      // five, which is exactly the drift the paragraph below warns about.
      //
      // If you add an exit, put it after the publish AND extend this list. A
      // completeness claim that has drifted from the code is how four of these
      // bugs survived review — including one where this very comment said
      // "two windows" and the code had three.
      //
      // Already on the current plan's price: the converged steady state, and
      // the reason a second identical event writes nothing.
      //
      // THE COMMON WINDOW of the two, and deliberately open. It never reads live
      // state at all, so a payload whose PRICE is right but whose QUANTITY is
      // stale passes straight through to the row sync. It is by far the more
      // reachable, because it IS the steady state — every converged group takes
      // it on every event. Closing it means a `subscriptionItems.retrieve` for
      // every rider on every `subscription.updated`, which is exactly the
      // per-event round trip the early return at the top of this function exists
      // to avoid. That trade belongs to #332's scheduled reconciliation, which
      // pays it once a day per group instead of once an event per rider — and
      // note the sweep as shipped does NOT close this window: it compares PRICE
      // ids only, so a converged price hiding a stale QUANTITY is still invisible
      // to both halves. Widening it to quantity is a change to that function.
      if (item.price?.id === expectedPriceId) continue;
      // A quantity-0 item is a removal in disguise; the row sync below flips
      // its row to canceled. Re-pricing it would be paying a Stripe write to
      // correct the rate of something that is on its way out.
      //
      // THE RARER of the two windows. This check reads the EVENT and sits
      // before the live re-read below, so a payload saying qty 0 while Stripe
      // holds a re-bought rider skips convergence and the row sync then cancels
      // a row the customer is paying for. Much less reachable than the
      // steady-state exit above: no app path produces a qty-0 rider item at all
      // — setExtraOrgs removes via `subscriptionItems.del` — so it takes a
      // Dashboard edit AND an out-of-order delivery. Same owner, #332, but NOT
      // yet the same remedy: the shipped sweep skips a qty-0 row (it reads
      // `status = 'active'` org_addons rows, and the sync has already canceled
      // this one) and compares prices, not quantities.
      if ((item.quantity ?? 0) <= 0) continue;
      // Hoisted so the catch below can report the price Stripe ACTUALLY holds
      // rather than the payload's, which may be superseded. Null only if the
      // read itself is what threw, which is exactly when the payload is the
      // best we have.
      let live: Stripe.SubscriptionItem | null = null;
      try {
        // RE-READ THE ITEM LIVE before mutating it. The quantity we are about
        // to send back to Stripe must not come from this event's snapshot:
        // webhook deliveries are not ordered, and runEvent's lease dedupes only
        // the SAME event, so an older `updated` can be processed after a newer
        // purchase. Concretely — a Pro group with 2 riders upgrades (E1, qty 2),
        // then buys 3 more (qty 5, E2); if E1 lands after E2 it would write
        // `quantity: 2` and silently revoke three organisations of paid
        // capacity, which the row sync would then faithfully record.
        //
        // That is strictly worse than the ordinary stale-payload bug this
        // codebase already tolerates: before this function existed a stale
        // payload corrupted only ROWS, and the next event repaired them. This
        // one corrupts STRIPE, which is authoritative, and nothing repairs it.
        // Every sibling that mutates a subscription re-reads first for the same
        // reason (syncGroupQuantity, setExtraOrgs, setExtraSeats); this is the
        // mismatch branch only, which is rare and already spending a round trip.
        live = await getStripe().subscriptionItems.retrieve(item.id);
        // PUBLISH IT IMMEDIATELY, at the read rather than at each exit. From
        // here on this loop has SIX ways out — already converged, the duplicate
        // rider, quantity gone to zero, the update succeeded, the update was
        // rejected, and the vanished item — and EVERY one of them must leave the
        // row sync looking at what Stripe actually holds, not at this event's
        // snapshot. (Keep this list and the exit census above it in step; the
        // two are the same claim counted from two places, and this one had gone
        // stale at four while the duplicate and vanished exits were added.)
        //
        // Doing it per-exit made that a rule each future exit has to remember,
        // and two of them had already forgotten: a stale payload then wrote the
        // OLD quantity into org_addons, handing out capacity nobody is paying
        // for (or withholding capacity that is). Doing it here makes the
        // property STRUCTURAL — an exit added later inherits it by construction.
        //
        // "The next event repairs it" is worth nothing here: convergence fires
        // only on an event Stripe has a reason to emit for this group, and
        // #332's sweep only reports — it never writes a row back.
        const idx = items.indexOf(item);
        if (idx >= 0) items[idx] = live;
        // Someone got there first — a purchase (setExtraOrgs re-prices AND
        // changes quantity in one go) or an earlier delivery of this same
        // convergence. No Stripe write to make, and the price is now claimed.
        if (live?.price?.id === expectedPriceId) {
          targetClaimed = true;
          continue;
        }
        // The duplicate-rider exit. Stripe will not hold two items on one
        // subscription at the same price, and duplicates ARE reachable (two
        // concurrent creates — see setExtraOrgs' FILTER-not-find comment), so
        // the target price is claimed at most once and the losers are left for
        // setExtraOrgs to consolidate: the webhook's contract here is "the rate
        // is right", not "the shape is tidy".
        //
        // Deliberately sited AFTER the read and the publish, not before them.
        // It used to sit with the payload-trust skips above, which meant the
        // LOSER's row was written from the event snapshot — the same leak as
        // the two exits closed in round 3, and reachable the same way. The
        // usual argument for tolerating a pre-read exit (a retrieve on every
        // event is a hot-path cost) does not apply: this branch runs only for
        // duplicates, is already inside the round trips, and already sends a
        // staff alert. Moving it is a relocation, not a new cost.
        //
        // It also makes the claim answer to LIVE state: an item whose payload
        // price looked stale but which Stripe already has on the target now
        // claims it at the branch above, so a genuine duplicate is alerted
        // instead of being sent into an update Stripe would reject.
        if (targetClaimed) {
          log.error(
            {
              itemId: item.id,
              stripeSubscriptionId: stripeSub.id,
              subscriptionId,
              currentPriceId: live?.price?.id ?? item.price?.id,
              expectedPriceId,
            },
            "billing: extra-org rider is on a price already held by another item — leaving it for setExtraOrgs to consolidate",
          );
          // Alerted, not just logged: this group bills the wrong rate on this
          // item until a human or a purchase consolidates the duplicate, and
          // nothing here will try again.
          await maybeAlertOrgRepriceFailed({
            subscriptionId,
            stripeSubscriptionId: stripeSub.id,
            planKey,
            itemId: item.id,
            currentPriceId: live?.price?.id ?? item.price?.id ?? null,
            expectedPriceId,
            reason: "another subscription item already holds the target price (duplicate rider)",
          });
          continue;
        }
        const qty = live?.quantity ?? item.quantity ?? 0;
        if (qty <= 0) continue;
        const updated = await getStripe().subscriptionItems.update(item.id, {
          price: expectedPriceId,
          // NOT optional — see the doc comment. Stripe resets quantity to 1 on
          // a price change unless it is restated.
          quantity: qty,
          proration_behavior: "create_prorations",
        });
        targetClaimed = true;
        log.warn(
          {
            itemId: item.id,
            qty,
            fromPriceId: live?.price?.id ?? item.price?.id,
            expectedPriceId,
            planKey,
            stripeSubscriptionId: stripeSub.id,
            subscriptionId,
          },
          "billing: re-priced extra-org rider",
        );
        // Upgrade the published item from LIVE to POST-UPDATE. The publish at
        // the read already put a truthful item here; this replaces it with the
        // newer truth, which is the only one of the six exits that has one.
        if (updated && idx >= 0) items[idx] = updated;
      } catch (err) {
        // An item that vanished between this event being emitted and being
        // processed is a benign race, not something to page anyone about —
        // there is nothing left to re-price.
        if (isStripeResourceMissing(err)) {
          log.warn(
            { itemId: item.id, stripeSubscriptionId: stripeSub.id, subscriptionId },
            "billing: extra-org rider is gone from subscription — nothing to re-price",
          );
          continue;
        }
        log.error(
          {
            itemId: item.id,
            expectedPriceId,
            planKey,
            stripeSubscriptionId: stripeSub.id,
            subscriptionId,
            err,
          },
          "billing: could not re-price extra-org rider — the row still reconciles, only the rate stays stale",
        );
        await maybeAlertOrgRepriceFailed({
          subscriptionId,
          stripeSubscriptionId: stripeSub.id,
          planKey,
          itemId: item.id,
          // What Stripe HOLDS, not what the event said — this is the field a
          // responder acts on, and the payload's may be superseded.
          currentPriceId: live?.price?.id ?? item.price?.id ?? null,
          expectedPriceId,
          reason: `Stripe rejected the item update: ${errText(err)}`,
        });
      }
    }
  } catch (err) {
    // Almost always resolveOrgAddonPriceId's 503: `stripe:sync` has not been
    // run for this account, so the catalog cannot name a price to move to.
    log.error(
      { subscriptionId, stripeSubscriptionId: stripeSub.id, err },
      "billing: could not resolve the extra-org rider price for group — rows still reconcile, rates stay stale",
    );
    await maybeAlertOrgRepriceFailed({
      subscriptionId,
      stripeSubscriptionId: stripeSub.id,
      // Real whenever the plan read got that far — which is the 503 case, i.e.
      // nearly always. "unknown" survives only if the read itself threw.
      planKey,
      itemId: null,
      currentPriceId: null,
      expectedPriceId: null,
      reason: `could not resolve the rider price for this group's plan: ${errText(err)}`,
    });
  }
}

/** Stripe's "you asked for something that isn't there" code, read defensively —
 *  the error may be a StripeError, a plain Error, or anything a mock threw. */
function isStripeResourceMissing(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "resource_missing"
  );
}

/** A short, safe rendering of an unknown throw for an OPS-ONLY alert body.
 *  Never rendered to a customer — this file's alerts are staff email. */
function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** One live extra-org rider found on a price that is NOT its group's plan rate
 *  — or one the sweep could not price at all. The shape a staff list renders
 *  and a manual Dashboard fix acts on. */
export interface OrgAddonPriceMismatch {
  /** The billing GROUP (subscriptions.id) — what a human looks up first. */
  subscriptionId: string;
  stripeSubscriptionId: string;
  planKey: string;
  /** The Stripe subscription ITEM. Always known here: the sweep starts from
   *  org_addons rows, which are keyed on it. */
  itemId: string;
  /** What Stripe HOLDS. Null when the expected price could not be resolved, in
   *  which case the item was never read — there was nothing to compare it to. */
  currentPriceId: string | null;
  /** The current plan's rider price, or null when the catalog could not name
   *  one (unsynced) or the plan has no rider SKU at all. */
  expectedPriceId: string | null;
  /** How many organisations are riding at the wrong rate — the blast radius. */
  qty: number;
  reason: string;
}

/** How many mismatches one pass will EMAIL about. The full list is always
 *  returned in `mismatches`, so nothing is lost by capping here; this only
 *  bounds the inbox when a single systemic fault (an unsynced catalog) makes
 *  every group in the database report at once. */
export const ORG_PRICE_SWEEP_ALERT_CAP = 10;

/**
 * Periodic backstop for the extra-organisation rider's two rates (v17 gap
 * #332). REPORTS, never repairs.
 *
 * WHY IT EXISTS. `convergeOrgAddonPrices` is the only thing that moves a rider
 * onto its group's current rate, it runs ONLY on a
 * `customer.subscription.created`/`.updated` delivery, and it deliberately
 * never throws — so each of its reachable failures (an unsynced catalog, a
 * currency outside the rider price's `currency_options` (the #191 class), a
 * duplicate rider losing the target-price claim) ends in a log, a staff alert
 * and a group left on the wrong price. Nothing SCHEDULES another event for that
 * group, so "the next event re-converges it" buys nothing for a customer who
 * never changes plan again. The alert covers the moment of failure; it does not
 * cover a group that went stale before the alert existed, or one whose alert
 * was missed. This is what covers those.
 *
 * The invariant is load-bearing rather than cosmetic, though not for the reason
 * originally written here. That reason was a TIER ARBITRAGE — $9 on pro against
 * $19 on pro_plus, with a rider stuck on the cheaper price letting "Pro +
 * riders" undercut Pro Plus. Entitlements v18 (V393) retired `pro_plus`, so
 * there is one purchasable plan and one rider rate, and no arbitrage is
 * reachable.
 *
 * What remains is the plainer fault and it is still money: a rider left on a
 * price its plan no longer charges bills that rate for as long as nobody looks,
 * over- or under-charging by whatever the two prices differ by. Nothing
 * schedules a retry, so "for as long as nobody looks" is the operative clause.
 *
 * IT DOES NOT RE-PRICE, and that is the deliberate half of #332's third
 * question. A sweep that repaired would be a BULK billing mutation — every
 * fixed item bills a proration, unattended, against subscriptions whose owners
 * are not present — and the fault that made them stale (an unsynced catalog, an
 * unsupported currency) is very likely still present, so the repair would
 * mostly fail and the successes would be the ones nobody vetted. Report first,
 * read the list, then decide. Making it repair later is a change to this
 * function, not to its callers.
 *
 * IT COMPARES PRICE IDS AGAINST LIVE STRIPE STATE, for two reasons. The DB
 * records the rider's `stripe_item_id` and never its price, so there is nothing
 * local to compare; and the whole failure class is "our idea of this
 * subscription and Stripe's disagree", which a read of our own tables cannot
 * see by construction. By ID and not by lookup key — the same comparison
 * `convergeOrgAddonPrices` makes, and for the reason recorded there: a price
 * REPLACED under the same lookup key is a genuinely different price that a
 * key-wise comparison would call converged.
 *
 * COST is one `prices.list` per DISTINCT PLAN in the pass (memoised, not once
 * per rider) plus one `subscriptionItems.retrieve` per live rider — and the
 * working set is only groups that have BOUGHT an extra organisation, which is a
 * small minority of subscriptions. `limit` bounds it hard.
 *
 * `total` IS NOT `checked`, AND THE GAP IS THE POINT. `limit` truncates a
 * STABLE ordering (`a.created_at`), and unlike sweepStuckEvents' working set —
 * which DRAINS, because a replayed row stops being stuck — this one does not: a
 * rider stays live and re-selectable for ever, converged or not. So once the
 * estate exceeds `limit`, the same oldest N are re-examined every pass and the
 * NEWEST riders are never looked at, silently. Returning the unlimited count
 * beside the examined one makes that visible (`checked < total` means this pass
 * did not cover the estate) rather than leaving a backstop that has quietly
 * stopped backing anything up. Both counts are read through ONE predicate
 * builder for the same reason: a duplicated WHERE clause that drifted would make
 * `total` a lie about the very thing it exists to police.
 *
 * NEVER THROWS ON A SINGLE ROW. One unreadable item must not abandon the rest
 * of the sweep, so each Stripe read is caught and classified:
 *  - `vanished`   — the item is gone from Stripe (`resource_missing`). Not a
 *                   price fault and not alerted; the org_addons row outliving
 *                   its item is a different bug with a different owner (#329).
 *  - `unreadable` — any other Stripe failure. Explicitly NOT reported as a
 *                   mismatch: a transient outage that rendered as "this group
 *                   is billing the wrong rate" is exactly the false positive
 *                   that teaches a responder to ignore the list.
 *  - `unresolved` — we could not name the expected price (catalog unsynced, or
 *                   a plan with no rider SKU at all). Reported and alerted,
 *                   because a rider nobody can price is stale by definition.
 *
 * The DB read is deliberately gated on `LIVE_SUBSCRIPTION_STATUSES` and a
 * non-null `stripe_subscription_id`: a canceled group keeps its Stripe id
 * forever, and re-pricing (or paging anyone about) a departed customer's rider
 * is noise. `status = 'active'` on the org_addons row excludes both the
 * `canceled` freeze-not-delete rows and admin `granted` rows, which have no
 * Stripe item and therefore no price to be wrong.
 *
 * REPEATS ITS ALERTS. There is no attempt counter to park a row with (unlike
 * sweepStuckEvents, which has `replay_attempts`), so a group that stays broken
 * is alerted again on the next pass. That is the intended behaviour for a money
 * fault — it should nag until someone acts — and it is bounded by
 * ORG_PRICE_SWEEP_ALERT_CAP per pass. The de-duplicated read is the /admin
 * mismatch list (#332's second half), which renders `mismatches` directly.
 */
export async function sweepStaleOrgAddonPrices(limit = 500): Promise<{
  total: number;
  checked: number;
  mismatched: number;
  unresolved: number;
  vanished: number;
  unreadable: number;
  alerted: number;
  mismatches: OrgAddonPriceMismatch[];
}> {
  const mismatches: OrgAddonPriceMismatch[] = [];
  let total = 0,
    checked = 0,
    mismatched = 0,
    unresolved = 0,
    vanished = 0,
    unreadable = 0,
    alerted = 0;
  const done = () => ({
    total,
    checked,
    mismatched,
    unresolved,
    vanished,
    unreadable,
    alerted,
    mismatches,
  });
  // No Stripe account configured (CI, a local shell): there is nothing to
  // compare against, and pretending otherwise would report every rider in the
  // database as broken. Same guard, same reason, as sweepStuckEvents. `total`
  // stays 0 rather than being counted anyway — nothing was examined, and a
  // non-zero total beside a zero checked would read as a coverage failure.
  if (!process.env.STRIPE_SECRET_KEY) return done();

  // The ONE definition of "a rider whose price could be wrong", so the counted
  // set and the examined set cannot drift. A fresh fragment per call rather than
  // one shared value: each embedding binds its own parameters.
  //
  // `wallet_id` is TEXT with no FK (V323) — coalesce(group_subscription_id,
  // org_id) — so the join casts rather than the column. An org-addon row for a
  // GROUP always carries the subscription id, so an org-id wallet simply finds
  // no row here and is skipped, which is correct: an ungrouped org has no
  // Stripe subscription for a rider to ride.
  const liveRiders = () => sql`
      from org_addons a
      join subscriptions s on s.id::text = a.wallet_id
     where a.status = 'active'
       and a.feature_key = ${ORG_ADDON_FEATURE_KEY}
       and a.stripe_item_id is not null
       and s.stripe_subscription_id is not null
       and s.status in ${sql([...LIVE_SUBSCRIPTION_STATUSES])}`;

  const [counted] = await sql<{ n: number }[]>`
    select count(*)::int as n ${liveRiders()}`;
  total = counted?.n ?? 0;

  const rows = await sql<
    {
      subscription_id: string;
      plan_key: string;
      stripe_subscription_id: string;
      stripe_item_id: string;
      qty: number;
    }[]
  >`
    select s.id::text as subscription_id, s.plan_key, s.stripe_subscription_id,
           a.stripe_item_id, a.qty
     ${liveRiders()}
     order by a.created_at
     limit ${limit}`;
  if (total > rows.length) {
    log.warn(
      { examined: rows.length, total, limit },
      "billing: extra-org rider sweep is TRUNCATED — the newest riders are never reached",
    );
  }

  // One catalog lookup per DISTINCT plan, not per rider: every group on pro
  // resolves the same price id, and `prices.list` is a network call. Memoised
  // ACROSS FAILURES too — an unsynced catalog fails identically for every row,
  // and retrying it per row would turn one outage into `limit` round trips.
  const expectedByPlan = new Map<string, { priceId: string | null; reason: string }>();
  async function expectedFor(planKey: string): Promise<{ priceId: string | null; reason: string }> {
    const hit = expectedByPlan.get(planKey);
    if (hit) return hit;
    let result: { priceId: string | null; reason: string };
    if (!orgAddonForPlan(planKey)) {
      // Not a resolution failure — this plan HAS no rider SKU. Reachable
      // because convergeOrgAddonPrices deliberately declines to cancel a rider
      // on such a plan (removal belongs to the cancel paths), so a downgrade to
      // community leaves a paid rider riding a plan that cannot price it. Today
      // that state is invisible; naming it is the point of the sweep.
      result = {
        priceId: null,
        reason:
          `this group is on ${planKey}, which has no extra-organisation rider SKU, yet it is ` +
          `still billed for one — nothing prices this item`,
      };
    } else {
      try {
        result = { priceId: await resolveOrgAddonPriceId(planKey), reason: "" };
      } catch (err) {
        result = {
          priceId: null,
          reason:
            `the sweep could not resolve the ${planKey} rider price from the catalog — run ` +
            `stripe:sync for this account: ${errText(err)}`,
        };
      }
    }
    expectedByPlan.set(planKey, result);
    return result;
  }

  for (const row of rows) {
    checked++;
    const expected = await expectedFor(row.plan_key);
    const base = {
      subscriptionId: row.subscription_id,
      stripeSubscriptionId: row.stripe_subscription_id,
      planKey: row.plan_key,
      itemId: row.stripe_item_id,
      qty: row.qty,
    };
    if (!expected.priceId) {
      // Nothing to compare against, so the item is deliberately NOT read: a
      // round trip whose answer could not change the verdict.
      unresolved++;
      mismatches.push({
        ...base,
        currentPriceId: null,
        expectedPriceId: null,
        reason: expected.reason,
      });
      continue;
    }
    let live: Stripe.SubscriptionItem;
    try {
      live = await getStripe().subscriptionItems.retrieve(row.stripe_item_id);
    } catch (err) {
      if (isStripeResourceMissing(err)) {
        vanished++;
        log.warn(
          { itemId: row.stripe_item_id, subscriptionId: row.subscription_id },
          "billing: extra-org rider is gone from Stripe but its org_addons row is still active — no price to check",
        );
        continue;
      }
      unreadable++;
      log.error(
        { itemId: row.stripe_item_id, subscriptionId: row.subscription_id, err },
        "billing: could not read extra-org rider — its rate is UNKNOWN this pass, not wrong",
      );
      continue;
    }
    if (live?.price?.id === expected.priceId) continue;
    mismatched++;
    mismatches.push({
      ...base,
      currentPriceId: live?.price?.id ?? null,
      expectedPriceId: expected.priceId,
      reason:
        `reconciliation sweep: this rider is on ${live?.price?.id ?? "an unknown price"} but the ` +
        `group's ${row.plan_key} plan bills ${expected.priceId} — convergence never completed and ` +
        `nothing will retry it`,
    });
  }

  // Logged for EVERY mismatch (the record when staff email is not configured);
  // paged for the first ORG_PRICE_SWEEP_ALERT_CAP only.
  for (const m of mismatches) {
    log.error(
      {
        itemId: m.itemId,
        qty: m.qty,
        stripeSubscriptionId: m.stripeSubscriptionId,
        subscriptionId: m.subscriptionId,
        planKey: m.planKey,
        currentPriceId: m.currentPriceId,
        expectedPriceId: m.expectedPriceId,
        reason: m.reason,
      },
      "billing: stale extra-org rider",
    );
  }
  // The writer's own question (`staffAlertsOn`: the address, trimmed, blank is
  // unset) is asked here too, rather than left to the writer's gate, so the
  // returned `alerted` counts what was actually attempted; a counter that
  // incremented on a call the callee no-ops would report alerts that were never
  // attempted, and this number is what a cron response is judged on. It counts
  // ATTEMPTS: a same-day pass whose rider was already paged today attempts again
  // and the once-key holds (Q2).
  if (staffAlertsOn()) {
    for (const m of mismatches.slice(0, ORG_PRICE_SWEEP_ALERT_CAP)) {
      await maybeAlertOrgRepriceFailed({
        subscriptionId: m.subscriptionId,
        stripeSubscriptionId: m.stripeSubscriptionId,
        planKey: m.planKey,
        itemId: m.itemId,
        currentPriceId: m.currentPriceId,
        expectedPriceId: m.expectedPriceId,
        reason: m.reason,
      });
      alerted++;
    }
  }
  return done();
}
