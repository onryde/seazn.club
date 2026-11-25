import "server-only";
// server/usecases/online-package/events.ts - the package's analytics (spec 2026-11-23-online-chess-credits-design.md §14; plan Task 13
// step 6): ONE PostHog event per package action, with the eight facts the metrics table is read from.
//
//   online_chess_package_bought    a first payment: the pay door, or the first open's "Pay and open"
//   online_chess_package_resized   a later payment on a paid package: a bigger size, cameras added, a move down
//   online_chess_package_refunded  the full refund of a paid, unfrozen package: a division delete, a competition delete, online play
//                                  switched off (one event per package)
//
// Properties, exactly: `size`, `cameras`, `credits`, `monthly`, `pack`, `forfeited`, `plan`, `at_round_one`. `credits` is SIGNED, the
// ledger's own convention: positive is a debit, negative a return, so a move down reads as one. `monthly` and `pack` are the buckets
// the credits moved through (always magnitudes); `forfeited` the included credits given up on a return (P6). `at_round_one`: the
// payment was made at the open's gate rather than beforehand. Never an id, a division's name or an address.
//
// WHEN: AFTER the commit of the transaction that moved the money - never inside it - and never for a no-op (a payment that wrote
// nothing, a refund of nothing, a replay): the builders return nothing for those. Analytics NEVER throws into the money path and
// never holds it up: a builder that cannot make its event logs and returns nothing (`payEvent` is called inside the open's own
// transaction, where a throw would roll back a good "Pay and open"), PostHog failing is logged and swallowed, a failed plan lookup
// sends the event with the plan unknown, and a flush that does not come back is given up on after CAPTURE_TIMEOUT_MS.
import { EVENTS, type AnalyticsEvent } from "@/lib/analytics-events";
import { orgPlanKey } from "@/lib/entitlements";
import type { OnlineSize } from "@/lib/online-chess-package";
import { captureServer } from "@/lib/posthog-server";
import { log } from "@/server/logger";
import type { PayResult } from "./pay";
import type { RefundedPackage } from "./refund";

export type PackageEventKind = "bought" | "resized" | "refunded";

export const PACKAGE_EVENT_NAMES: Record<PackageEventKind, AnalyticsEvent> = {
  bought: EVENTS.ONLINE_CHESS_PACKAGE_BOUGHT,
  resized: EVENTS.ONLINE_CHESS_PACKAGE_RESIZED,
  refunded: EVENTS.ONLINE_CHESS_PACKAGE_REFUNDED,
};

/** What one event is made of, before the plan is looked up. `orgId` and `actorId` say whose funnel it joins and are not sent as
 *  properties (the org rides as the PostHog group, the actor as the distinct id). */
export type PackageEventFact = {
  orgId: string;
  /** Who acted: the signed-in user, or null for a door reached with no user (an API key's delete): then the org's own synthetic id. */
  actorId: string | null;
  size: OnlineSize;
  cameras: boolean;
  credits: number;
  monthly: number;
  pack: number;
  forfeited: number;
  atRoundOne: boolean;
};

/** An event ready to send: the kind and its facts. */
export type PackageEvent = { kind: "bought" | "resized"; fact: PackageEventFact };

/** A return as the ledger signs it: the negative of what came back, and a plain 0 (never `-0`, which PostHog would store as a
 *  different value from 0 in a sum of zero) when nothing did. */
const returned = (credits: number): number => 0 - credits;

/** The plan an event is sent with when the lookup fails: the event still counts, the plan cell reads unknown. */
const PLAN_UNKNOWN = "unknown";

/** The pay door's answer as an event, or null when it moved nothing (`applied` false: the second tab, a frozen row) - or when the
 *  event cannot be made (an answer whose bucket split is missing): that is logged and returns null, never a throw, because the
 *  pay door calls this after its money moved and the open's gate calls it INSIDE the open's transaction, where a throw would
 *  roll back a good "Pay and open". `paidBefore`: the package was already paid when the payment came (a first payment is
 *  `bought`, any later one `resized`). Reads the quote the door ACTED on (`PayResult.quote`), so the split is the one the ledger
 *  wrote. */
export function payEvent(
  result: PayResult,
  a: { orgId: string; actorId: string; paidBefore: boolean; atRoundOne: boolean },
): PackageEvent | null {
  try {
    return buildPayEvent(result, a);
  } catch (err) {
    log.error({ err, orgId: a.orgId }, "online package event: could not be built from the pay result; no event is sent and the payment stands");
    return null;
  }
}

function buildPayEvent(
  result: PayResult,
  a: { orgId: string; actorId: string; paidBefore: boolean; atRoundOne: boolean },
): PackageEvent | null {
  if (!result.applied) return null;
  const { quote } = result;
  let monthly = 0;
  let pack = 0;
  let forfeited = 0;
  if (quote.owed > 0) {
    // A charge that applied was debited, so the quote the door acted on split it (a short balance throws before the write).
    if (quote.take === null) throw new Error(`Online Chess package event: a charge of ${quote.owed} credits has no bucket split`);
    monthly = quote.take.monthly;
    pack = quote.take.pack;
  } else if (quote.owed < 0) {
    if (quote.back === null) throw new Error(`Online Chess package event: a return of ${-quote.owed} credits has no bucket split`);
    monthly = quote.back.monthly;
    pack = quote.back.pack;
    forfeited = quote.back.forfeited;
  }
  return {
    kind: a.paidBefore ? "resized" : "bought",
    fact: {
      orgId: a.orgId,
      actorId: a.actorId,
      size: result.package.size,
      cameras: result.package.camerasPaid === true,
      // What the LEDGER moved: the buckets' sum, positive for a debit, negative for a return. A move down's `owed` is the whole
      // reduction in value, which also counts what was forfeited (given up, never written); that is `forfeited`, beside it.
      credits: quote.owed > 0 ? monthly + pack : quote.owed < 0 ? returned(monthly + pack) : 0,
      monthly,
      pack,
      forfeited,
      atRoundOne: a.atRoundOne,
    },
  };
}

/** One `refunded` fact per package a door refunded (the doors collect them as they refund, `applyPackageDelete`): the credits
 *  that came back are negative, the forfeited ones counted beside them. Empty when nothing was refunded. */
export function refundEvents(refunded: readonly RefundedPackage[], a: { orgId: string; actorId: string | null }): PackageEventFact[] {
  return refunded.map((r) => ({
    orgId: a.orgId,
    actorId: a.actorId,
    size: r.size,
    cameras: r.cameras,
    credits: returned(r.back.pack + r.back.monthly),
    monthly: r.back.monthly,
    pack: r.back.pack,
    forfeited: r.back.forfeited,
    atRoundOne: false,
  }));
}

/** How long an event may hold the request that sent it. PostHog's `flush` has no timeout of its own, and the capture is awaited in
 *  the response path (a division delete, a payment): past this the event is given up on, the response goes out. */
export const CAPTURE_TIMEOUT_MS = 3000;

/** The plan the org is on, or "unknown" when the lookup fails (logged): the event still counts. One lookup per call. */
async function planOf(orgId: string): Promise<string> {
  try {
    return await orgPlanKey(orgId);
  } catch (err) {
    log.warn({ err, orgId }, "online package event: the plan lookup failed; the event is sent with the plan unknown");
    return PLAN_UNKNOWN;
  }
}

/** One capture, bounded by CAPTURE_TIMEOUT_MS. Throws what `captureServer` throws; the callers swallow it. */
async function send(kind: PackageEventKind, fact: PackageEventFact, plan: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new Promise<"gave-up">((resolve) => {
    timer = setTimeout(() => resolve("gave-up"), CAPTURE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([
      captureServer({
        event: PACKAGE_EVENT_NAMES[kind],
        distinctId: fact.actorId ?? `org:${fact.orgId}`,
        orgId: fact.orgId,
        properties: {
          size: fact.size,
          cameras: fact.cameras,
          credits: fact.credits,
          monthly: fact.monthly,
          pack: fact.pack,
          forfeited: fact.forfeited,
          plan,
          at_round_one: fact.atRoundOne,
        },
      }).then(() => "sent" as const),
      gaveUp,
    ]);
    if (outcome === "gave-up") {
      log.warn({ kind, orgId: fact.orgId, afterMs: CAPTURE_TIMEOUT_MS }, "online package event: the analytics flush did not come back in time; the response goes out without it");
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Send one package event. Call it AFTER the commit. Never throws and never holds the request past CAPTURE_TIMEOUT_MS: whatever
 *  goes wrong here is logged, and the money the event reports has already moved. */
export async function capturePackageEvent(kind: PackageEventKind, fact: PackageEventFact): Promise<void> {
  try {
    await send(kind, fact, await planOf(fact.orgId));
  } catch (err) {
    log.error({ err, kind, orgId: fact.orgId }, "online package event: the analytics capture failed; the payment stands");
  }
}

/** The `refunded` events of one door's refunds, sent after its commit: one per package the door refunded (none when it refunded
 *  nothing). `refunded` is what `applyPackageDelete` collected. The org's plan is looked up ONCE for the door, not once per package
 *  (a competition delete can refund many). The sends run together, so the door is held for one bound, not one per package. Never throws. */
export async function captureRefundEvents(refunded: readonly RefundedPackage[], a: { orgId: string; actorId: string | null }): Promise<void> {
  try {
    const facts = refundEvents(refunded, a);
    if (facts.length === 0) return;
    const plan = await planOf(a.orgId);
    // All at once: each send is bounded by CAPTURE_TIMEOUT_MS on its own clock, so the door waits for the slowest (one bound, ~3 s when
    // PostHog hangs), not for k packages in turn (k x 3 s). One failing send does not stop another.
    const settled = await Promise.allSettled(facts.map((fact) => send("refunded", fact, plan)));
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        log.error({ err: outcome.reason, kind: "refunded", orgId: a.orgId }, "online package event: the analytics capture failed; the refund stands");
      }
    }
  } catch (err) {
    log.error({ err, orgId: a.orgId }, "online package event: the refund events could not be sent; the refund stands");
  }
}
