import "server-only";
// server/usecases/online-package/pay.ts — pay, upgrade, add cameras and move down (spec 2026-11-23-online-chess-credits-design.md
// §7.3, §7.4 item 3; decisions 7, 14, 16; P6, P13, P19, P21). The money-moving door: the organiser confirmed a quote (Task 4's
// `PackageQuote`); this re-asks it under the locks and turns it into ledger rows and package-row state, exactly once.
//
//  * THE LOCKS, in the spec's order (§7.3, §7.4): the `division:` advisory lock, then the org money lock (`lockOrg`), then the
//    package row `for update`. On the privileged `sql.begin`, as every ledger writer runs (§7.3's table: "Pay, upgrade: its own
//    usecase on the privileged sql.begin. Never inside withTenant"): no grant is widened and no epilogue is added.
//  * EXACTLY ONCE, by STATE under those locks plus the client's `expectedOwed` (no idempotency key, by design):
//      1. the row is already at the target (paid, at this size, with this camera state) → nothing is written, `applied: false`.
//         The second of two tabs confirming the same receipt lands here, whatever total it confirmed.
//      2. the fresh quote is refused, or its owed is not the `expectedOwed` the organiser confirmed, or (a move down) its forfeit
//         is not the `expectedForfeited` they confirmed → 409 ONLINE_QUOTE_CHANGED carrying the fresh quote, nothing written; the
//         receipt redraws. A refusal is a changed quote here: the route is session-only and the receipt offers a confirm only on
//         a quote that is not refused, so a refused fresh quote means the division moved under it (a round opened, the rounds were
//         raised, the field grew, the plan changed) — spec §11 "Receipt open while someone changes the cameras or the rounds".
//         `expectedForfeited` exists because a UTC month turning between the receipt and the confirm changes WHICH credits a
//         move down returns without changing `owed` (controller ruling, Task 4 review M3).
//      3. owed > 0: one debit (`debitForPackage`, which rolls the month on the DB clock under the money lock first; 402
//         ONLINE_CHESS_NO_CREDITS when short, AFTER the compare). owed < 0: a move down, returned in P21's order by the quote's
//         `back` (`refundForPackage`; an earlier month's included credits are forfeited — counted, never written). owed 0 with the
//         row not at the target (a smaller size bought with cameras for what a larger one cost without): the row moves, the
//         ledger does not.
//  * A charge (owed > 0) also passes `beforeCharge`: the door's flag, billing-freeze and format gates. A move down never does:
//    refunds are never flag-gated, and the billing freeze keeps writes that cost nothing.
//  * After the write, the row's books are CHECKED, both invariants of §7.1, so a corrupt row is a named 500 that rolls the whole
//    payment back rather than a payment that compounds it.
//  * Then the stored registration capacity follows the size down (§7.4 item 2, §11), and a move down runs the settle step (§7.5)
//    on the same transaction, under the same money lock.
import { sql, type Tx } from "@/lib/db";
import { captureError } from "@/lib/sentry";
import { getLimit } from "@/lib/entitlements";
import { HttpError } from "@/lib/errors";
import { ONLINE_ALLOWED_STAGE_KINDS, ONLINE_PACKAGE_CODES, packagePrice, type OnlineSize } from "@/lib/online-chess-package";
import { isEditorRole } from "@/lib/types";
import type { AuthCtx } from "@/server/api-v1/auth";
import { lockDivisionForCap } from "@/server/external-play/online-entrant-cap";
import { divisionPlaysOnline } from "@/server/external-play/online-play";
import { assertNotFrozen, frozenCompetitionIds } from "@/server/usecases/entitlement-freeze";
import { onlineChessDisabled, onlineChessOffered } from "@/server/usecases/external-play/online-chess-flag";
import { log } from "@/server/logger";
import { lockOrg, streamMonthlyRate } from "@/server/usecases/stream-credits";
import { capturePackageEvent, payEvent } from "./events";
import { formatNotSupported } from "./format";
import { debitForPackage, refundForPackage } from "./ledger";
import { quoteLocked, readPackageFacts, type PackageQuote } from "./quote";
import { livePackage } from "./read";
import { settleReversals } from "./settle";
import type { PackageFacts, PackageRow } from "./types";

/** What the organiser confirmed: a size, the total the receipt showed (positive to pay, negative to return), and at most the one
 *  intent `addCameras` (which only ever raises the price, §7.4). On a move down, optionally the credits the receipt said would NOT
 *  come back (`back.forfeited`). The server derives everything else. */
export type PayInput = { size: OnlineSize; expectedOwed: number; addCameras?: boolean; expectedForfeited?: number };

/** `applied` false: the row was already at the target and nothing was written. `quote` is the quote the server acted on (asked
 *  under the locks, before the write). `capacityLoweredTo`: the size, when a stored registration capacity above it was lowered. */
export type PayResult = { applied: boolean; quote: PackageQuote; package: PackageRow; capacityLoweredTo: number | null };

/** The settle step of §7.5: re-runs the netted attribution of the org's reversed packs after a return, on the caller's
 *  transaction and under its money lock. `settleReversals` unless a test injects another (to watch it run, or make it fail). */
export type PayDeps = { settle?: (tx: Tx, orgId: string) => Promise<number> };

/** The money facts read BEFORE the transaction (lib/db.ts forbids a pooled read inside one): the org's plan rate
 *  (`streamMonthlyRate`), and the door's gates on a charge — thrown from `beforeCharge`, which runs only when the fresh quote
 *  owes credits. */
export type PayMoney = { rate: number; beforeCharge?: () => void };


/** 409 ONLINE_QUOTE_CHANGED with the fresh quote. One code for both ways the confirmed receipt went stale, and a message for
 *  each: the fresh quote REFUSES the size (its total may be unchanged, so "the total changed" would be false), or it no longer
 *  owes, or forfeits, what was confirmed. */
function quoteChanged(quote: PackageQuote): HttpError {
  return new HttpError(
    409,
    quote.refusal !== null
      ? `Online Chess cannot be bought at size ${quote.size}: ${quote.refusal}`
      : "The Online Chess total changed since it was shown; check the new total and confirm again",
    ONLINE_PACKAGE_CODES.quoteChanged,
    { quote },
  );
}

/** Both invariants of §7.1, on the row as it now stands: paid − refunded is the package's net ledger debit; and the VALUE
 *  (paid − refunded − forfeited) is the price of its size and camera state. Each a named 500: "cannot happen" when every
 *  writer keeps them, so a row that breaks one stops the payment (the whole transaction rolls back) instead of building on it. */
async function assertBooks(tx: Tx, row: PackageRow): Promise<void> {
  const [l] = await tx<{ net: number }[]>`
    select coalesce(-sum(delta), 0)::int as net from org_stream_credits where online_package_id = ${row.id}`;
  if (row.creditsPaid - row.creditsRefunded !== l!.net) {
    throw new HttpError(
      500,
      `Online Chess package ${row.id} records ${row.creditsPaid} paid and ${row.creditsRefunded} returned, but its ledger rows net ${l!.net}`,
      "online_package_ledger_mismatch",
    );
  }
  const value = row.creditsPaid - row.creditsRefunded - row.creditsForfeited;
  const price = packagePrice(row.size, row.camerasPaid === true);
  if (value !== price) {
    throw new HttpError(
      500,
      `Online Chess package ${row.id} holds ${value} credits of value, but size ${row.size} ${row.camerasPaid ? "with" : "without"} cameras costs ${price}`,
      "online_package_value_mismatch",
    );
  }
}

/** A stored registration capacity above the new size is lowered to it (§7.4 item 2, §11): the size is the entrant limit, and a
 *  capacity above it would promise places the division cannot hold. None stored (null) stays none. Answers the size when it
 *  lowered one. */
export async function clampCapacity(tx: Tx, divisionId: string, size: OnlineSize): Promise<number | null> {
  const lowered = await tx`
    update registration_settings set capacity = ${size}, updated_at = now()
     where division_id = ${divisionId} and capacity > ${size}
    returning capacity`;
  return lowered.length > 0 ? size : null;
}

/** The payment on the caller's transaction (Task 9's pay-and-open calls it inside `openRound`). The caller holds the
 *  `division:` lock and read `facts` under it (`readPackageFacts`); this takes the org money lock and the package row's lock,
 *  in that order, and does the rest. `money.rate` is the org's plan rate, read before the transaction. */
export async function payOnlinePackageInTx(
  tx: Tx,
  a: { orgId: string; divisionId: string; userId: string | null } & PayInput,
  facts: PackageFacts,
  money: PayMoney,
  deps: PayDeps = {},
): Promise<PayResult> {
  await lockOrg(tx, a.orgId);
  const row = await livePackage(tx, a.divisionId, { forUpdate: true });
  // An online division always has its live row (the migration wrote one for each, the online switch writes one): meeting none
  // is a bug upstream, never a reason to create one here with no size chosen.
  if (row === null) {
    throw new HttpError(500, `Online Chess division ${a.divisionId} has no live package; nothing was paid`, "online_package_missing");
  }
  const quote = await quoteLocked(
    tx, { orgId: a.orgId, divisionId: a.divisionId, size: a.size, addCameras: a.addCameras, rate: money.rate }, facts,
  );

  // 1. Already at the target: nothing to do, whatever was confirmed.
  if (row.paidAt !== null && row.size === a.size && row.camerasPaid === quote.cameras) {
    return { applied: false, quote, package: row, capacityLoweredTo: null };
  }
  if (quote.owed > 0) money.beforeCharge?.();
  // 2. The quote the organiser confirmed is not the quote the server holds now.
  if (quote.refusal !== null || quote.owed !== a.expectedOwed) throw quoteChanged(quote);
  const forfeited = quote.back?.forfeited ?? 0;
  if (a.expectedForfeited !== undefined && a.expectedForfeited !== forfeited) throw quoteChanged(quote);
  // paid_at and paid_by are set together (V560's CHECK): a first payment names who paid.
  if (row.paidAt === null && a.userId === null) {
    throw new HttpError(500, `Online Chess package ${row.id} cannot be paid without naming who paid`, "online_package_payer_missing");
  }

  // 3. The money.
  let paid = 0;
  let returned = 0;
  if (quote.owed > 0) {
    await debitForPackage(tx, { orgId: a.orgId, packageId: row.id, credits: quote.owed, rate: money.rate, size: a.size });
    paid = quote.owed;
  } else if (quote.owed < 0) {
    const back = quote.back;
    // Type narrowing, not a reachable refusal: the quote splits every return it does not refuse (`back` is non-null whenever
    // owed < 0 and `refusal` is null, both checked above), and `planReturn` already refuses a split that is not the return.
    if (back === null) {
      throw new HttpError(500, `Online Chess package ${row.id}: the quote returns ${-quote.owed} credits without a split`, "online_package_return_unplanned");
    }
    await refundForPackage(tx, { orgId: a.orgId, packageId: row.id, pack: back.pack, monthly: back.monthly, size: a.size });
    returned = back.pack + back.monthly;
  }
  // The row in ONE statement (V560's CHECKs hold per statement). `cameras_paid` is the quote's camera figure, which already
  // includes a camera price paid before (P19: never lowered). paid_at and paid_by keep the FIRST payment. Written only while
  // the row is still writable (not frozen, not refunded) and asserted to be exactly that one row: the row is locked and the
  // quote refused a frozen one, so a miss is a writer that changed it on this transaction — a named 500, never a silent payment.
  const written = await tx`
    update division_online_packages
       set size = ${a.size},
           cameras_paid = ${quote.cameras},
           credits_paid = credits_paid + ${paid},
           credits_refunded = credits_refunded + ${returned},
           credits_forfeited = credits_forfeited + ${forfeited},
           paid_at = coalesce(paid_at, now()),
           paid_by = coalesce(paid_by, ${a.userId}::uuid)
     where id = ${row.id} and frozen_at is null and refunded_at is null
    returning id`;
  if (written.length !== 1) {
    throw new HttpError(500, `Online Chess package ${row.id} was frozen or refunded under its payment; nothing was paid`, "online_package_not_writable");
  }
  // The row is locked, live and was just written: it is still the division's live package.
  const after = (await livePackage(tx, a.divisionId))!;
  await assertBooks(tx, after);

  const capacityLoweredTo = await clampCapacity(tx, a.divisionId, a.size);
  // The settle step (§7.5) on EVERY move down, the route's and Task 9's pay-and-open alike: the default is the real one.
  if (quote.owed < 0) await (deps.settle ?? settleReversals)(tx, a.orgId);
  return { applied: true, quote, package: after, capacityLoweredTo };
}

/** The first stage kind of the division that online play does not allow (P16), or null. The pay door's format gate on a charge, and
 *  the open-round gate's on a pay-and-open (gate.ts). */
export async function refusedStageKind(tx: Tx, divisionId: string): Promise<string | null> {
  const [s] = await tx<{ kind: string }[]>`
    select kind from stages where division_id = ${divisionId} and kind not in ${tx([...ONLINE_ALLOWED_STAGE_KINDS])} order by seq limit 1`;
  return s?.kind ?? null;
}

/** The pay door: an organiser of the division's org (owner or admin, signed in — the payment names who paid) pays for, upgrades,
 *  adds cameras to, or moves down the division's Online Chess package. Never an API key, a device link or a Match Day code. */
export async function payOnlinePackage(auth: AuthCtx, divisionId: string, input: PayInput, deps: PayDeps = {}): Promise<PayResult> {
  if (auth.via !== "session" || auth.userId === null) {
    throw new HttpError(403, "Paying for Online Chess needs a signed-in organiser");
  }
  if (!isEditorRole(auth.role)) throw new HttpError(403, "Only an owner or admin can pay for Online Chess");
  const userId = auth.userId;

  const [division] = await sql<{ org_id: string; competition_id: string }[]>`
    select org_id, competition_id from divisions where id = ${divisionId}`;
  if (!division || division.org_id !== auth.orgId.toLowerCase()) throw new HttpError(404, "division not found");

  // Before the transaction: the plan cap, the plan's monthly rate, the flag and the billing freeze (all pooled reads). Whether
  // the division plays online is asked once, INSIDE, under the division lock: a save switching it off takes the same lock.
  const orgId = division.org_id;
  const planCap = await getLimit(orgId, "entrants.per_division.max", division.competition_id);
  const rate = await streamMonthlyRate(orgId);
  const offered = await onlineChessOffered({ orgId, userId });
  const frozen = await frozenCompetitionIds(orgId);

  // Whether the payment moved the size UP, read under the division lock (a size write takes the same lock) before the payment writes.
  let sizeBefore: OnlineSize | null = null;
  // Whether the package was already paid when this payment came, read under the same lock: a first payment is `bought`, a later one `resized`.
  let paidBefore = false;
  const result = await sql.begin(async (tx) => {
    await lockDivisionForCap(tx, divisionId);
    // Under the division lock: the division plays online (a sport that can, set to Lichess).
    const [d] = await tx<{ sport_key: string; config: unknown }[]>`select sport_key, config from divisions where id = ${divisionId}`;
    if (!d || !divisionPlaysOnline(d)) throw formatNotSupported(null);
    const refusedKind = await refusedStageKind(tx, divisionId);
    const facts = await readPackageFacts(tx, divisionId, planCap);
    const live = await livePackage(tx, divisionId);
    sizeBefore = live?.size ?? null;
    paidBefore = live?.paidAt != null;
    return payOnlinePackageInTx(tx, { orgId, divisionId, userId, ...input }, facts, {
      rate,
      beforeCharge: () => {
        if (!offered) throw onlineChessDisabled();
        assertNotFrozen(frozen, division.competition_id);
        if (refusedKind !== null) throw formatNotSupported(refusedKind);
      },
    }, deps);
  }) as PayResult;
  // The analytics event (spec §14), AFTER the commit and only for a payment that wrote something; it never throws (events.ts).
  const event = payEvent(result, { orgId, actorId: userId, paidBefore, atRoundOne: false });
  if (event !== null) await capturePackageEvent(event.kind, event.fact);
  // P18: a move UP made room, and whoever is waiting for it is promoted - after the commit (the payment stands whatever happens
  // here: a failed promotion is logged and the organiser's own Promote still works). Imported where it is used: the promotion
  // reaches the registrations modules, whose own imports reach this package's barrel.
  if (result.applied && sizeBefore !== null && result.package.size > sizeBefore) {
    await promoteWaitlistAfterMoveUp(divisionId, userId);
  }
  return result;
}

/** The waitlist of `divisionId` promoted into the room a size that just moved up made, best-effort: the size change it follows has
 *  committed, so a failure here is reported (log + Sentry) and never thrown at the organiser who paid. Shared by the pay door and the
 *  unpaid size save (`patchDivision`). */
export async function promoteWaitlistAfterMoveUp(divisionId: string, actorId: string | null): Promise<void> {
  try {
    const { promoteIntoNewRoom } = await import("@/server/usecases/registrations/promote-into-room");
    await promoteIntoNewRoom(divisionId, actorId);
  } catch (err) {
    log.error({ err, divisionId }, "online package: the waitlist was not promoted into the room a bigger size made");
    captureError(err, { extra: { divisionId, where: "promoteWaitlistAfterMoveUp" } });
  }
}
