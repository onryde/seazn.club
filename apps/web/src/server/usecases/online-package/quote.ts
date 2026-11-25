import "server-only";
// server/usecases/online-package/quote.ts — the Online Chess quote (spec 2026-11-23-online-chess-credits-design.md §7.4 item 1; P9,
// P10, P13, P15, P17, P19 (amended 2026-11-25, Task 15), P21). One answer for the size select's price line, the amber line and the receipt: what a size costs,
// what is owed (positive to pay, negative to return), how it would split over the org's two buckets, and whether the size is
// refused at all. The payment and refund usecases (Tasks 5, 6) and the open-round gate (Task 9) ask it under their locks and
// compare its `owed` with what the organiser confirmed; the read doors ask it with no lock.
//
//  * The SERVER derives everything but the size (§7.4): cameras (P9), counted rounds (P15) and places held come from the
//    division's own rows (`readPackageFacts`), the plan cap from the plan, the row from the division. The client sends a size,
//    and at most the organiser's Fair-play camera answer (`cameras`, Task 15). The answer is priced as given because paying WRITES
//    it to the division's own camera policy in the same transaction (pay.ts): a "No" is cheaper only because it turns the camera
//    off. An answer the division's own policy cannot carry (a stage that sets its own camera, which no door writes today) is
//    refused by name, never priced. With no answer, the camera state is the division's SETTING as it stands (P9) - never a camera
//    price a paid row holds (Task 15 fix I2): the receipt opens at the setting too, so the two quote alike.
//  * A quote WRITES and LOCKS nothing. In particular it does not roll the month: `debitForPackage` rolls under the money lock
//    when it pays. The balance and the split a quote shows are therefore what the org WILL hold once that roll has run, projected
//    read-only by the stream ledger's own rule (`projectMonthlyRollDelta`, the Settings rail's projection): an org that has not
//    touched the ledger this month is shown this month's included credits, not last month's expiring leftover, and not an empty
//    ledger — the debit would grant them first. `rate` is the org's resolved plan rate (`streamMonthlyRate`), read before the
//    caller's transaction (lib/db.ts forbids a pooled read inside one).
//  * ONE clock, the database's: "this month" and the month's last day come from the transaction's own `now()`, the instant every
//    ledger row would be dated by, never from a JS Date.
//  * A refusal carries no split: when a size is refused nothing will be written, so `take` and `back` are null; `owed` still
//    says the arithmetic. The refusals are decided in ONE order, the first that holds:
//    frozen, below_held, plan, rounds_above_max, rounds.
import { sql, type Tx } from "@/lib/db";
import { getLimit } from "@/lib/entitlements";
import { HttpError } from "@/lib/errors";
import {
  ONLINE_SIZES, includedRounds, isOnlineSize, packagePrice, sizeAllowedByPlan, sizeForRounds, type OnlineSize,
} from "@/lib/online-chess-package";
import type { AuthCtx } from "@/server/api-v1/auth";
import { countOnlineHeld } from "@/server/external-play/online-entrant-cap";
import {
  creditBreakdown, projectMonthlyRollDelta, streamMonthlyRate, type StreamCreditBreakdown,
} from "@/server/usecases/stream-credits";
import { CAMERA_CHOICE_ON } from "@/server/usecases/division-camera-policy";
import { planDebit, planReturn, returnableFor, transactionNow } from "./ledger";
import { countedRounds, derivedCameras, livePackage } from "./read";
import type { BucketSplit, PackageFacts, PackageRow, ReturnPlan } from "./types";

export type PackageQuote = {
  /** The size asked about (not the row's: a quote can be asked about any size on the ladder). */
  size: OnlineSize;
  /** What the price assumes: the organiser's answer (`cameras`) when one was given; otherwise the policy's cameras, or a camera price
   *  already paid. */
  cameras: boolean;
  /** Credits to buy `size` at `cameras`. */
  price: number;
  /** price − the price already paid for the row's own size and cameras (a paid row), else the full price. > 0 to pay, < 0 to
   *  return, 0 nothing. */
  owed: number;
  /** When `owed` > 0, no refusal, and the balance covers it: how the debit splits (the included credits first, P4). Null otherwise
   *  — including a SHORT balance (`owed` > 0, `take` null, no refusal: the receipt offers Buy credits, and `shortBy` says how many). */
  take: BucketSplit | null;
  /** The credits the balance is missing: `owed` − `balance` when `owed` > 0, there is no refusal and the balance is short; null
   *  otherwise. Exactly one of `take` and `shortBy` is set for a payable quote, and neither for anything else. */
  shortBy: number | null;
  /** When `owed` < 0 and no refusal: how the return splits (P21): bought credits, included credits of this month, and included
   *  credits of an earlier month, which are forfeited (counted on the row, never written). Null otherwise. */
  back: ReturnPlan | null;
  /** The last day of the database's UTC month, ISO `YYYY-MM-DD`: when this month's included credits expire. */
  monthlyExpiresOn: string;
  /** What the org holds once the month's rollover has run (the sum of the two buckets). */
  balance: number;
  /** Places held, and Swiss rounds counted, as the quote judged them. */
  held: number;
  rounds: number;
  refusal: null | "below_held" | "plan" | "rounds" | "rounds_above_max" | "frozen";
  /** Whether the row's PAID package covers the division as it stands (spec §7.6: places held, counted rounds and cameras, and
   *  nothing else): a live paid row, not frozen, whose own size holds the places and includes the rounds, and whose camera price
   *  is paid when the policy needs cameras. A fact about the package, not about the size asked: it is the same for every `size`
   *  and ignores the `cameras` answer, which says what a payment WOULD make the package. The PLAN does not enter it: a paid organiser
   *  whose plan was downgraded can still open round 1, so a `plan` refusal never breaks it (and, `plan` coming before the rounds
   *  refusals in the order, it is not derived from `refusal`). */
  covers: boolean;
};

/** 409 online_camera_set_by_stage: the organiser's Fair-play camera answer cannot be carried by the division's OWN camera policy,
 *  because a stage of the division sets its own (nearest level wins). No door writes a stage's camera policy today (the writers
 *  tripwire, camera-writers-tripwire.test.ts, keeps it so), so this is a guard on that premise, not a screen anyone meets. */
export function cameraSetByStage(divisionId: string, cameras: boolean): HttpError {
  return new HttpError(
    409,
    `The Fair-play camera of division ${divisionId} is set by one of its stages, so it cannot be turned ${cameras ? "on" : "off"} from the receipt; nothing was quoted or paid`,
    "online_camera_set_by_stage",
  );
}

/** The answer `cameras` fits the division when setting its OWN policy to it (Yes: on; No: off) makes the division say it, judged as P9
 *  judges it (`derivedCameras`). Throws `cameraSetByStage` otherwise. */
export async function assertCameraChoiceFits(db: Tx | typeof sql, divisionId: string, cameras: boolean): Promise<void> {
  if ((await derivedCameras(db, divisionId, cameras ? CAMERA_CHOICE_ON : "off")) !== cameras) throw cameraSetByStage(divisionId, cameras);
}

/** The last day of the UTC month of `now`, as an ISO date. UTC on purpose: the ledger's month is the UTC month
 *  (`streamMonthlyPeriod`), and the database runs in Europe/London. */
export function lastDayOfUtcMonth(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

/** The first refusal that holds for `size`, in ONE order: frozen, below_held, plan, rounds_above_max, rounds. A caller that must
 *  judge the places and rounds without the plan passes `planCap: null` (the plan allows every size). */
export function refusalFor(size: OnlineSize, facts: PackageFacts, frozen: boolean): PackageQuote["refusal"] {
  if (frozen) return "frozen";
  if (size < facts.held) return "below_held";
  if (!sizeAllowedByPlan(size, facts.planCap)) return "plan";
  if (sizeForRounds(facts.rounds) === null) return "rounds_above_max";
  if (facts.rounds > includedRounds(size)) return "rounds";
  return null;
}

/** A count the caller passed in must be a whole number of at least 0: a NaN or a negative reaching a money quote is a bug upstream
 *  (NaN would compare false against every limit and quote a size nobody checked). */
function assertWhole(n: number, what: string): void {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`${what} must be a whole number of at least 0, got ${String(n)}`);
}

/** The org's two buckets as they will stand once the month's rollover has run, read without writing it. Whatever the roll does
 *  (a new month expires the included leftover and grants the plan's rate; a plan upgraded mid-month tops the month up; a rolled
 *  month does nothing) the bought bucket is untouched and the included bucket moves by exactly the change in the TOTAL, which
 *  is what `projectMonthlyRollDelta` answers. */
async function projectedSplit(tx: Tx, orgId: string, rate: number, now: Date): Promise<StreamCreditBreakdown> {
  const split = await creditBreakdown(tx, orgId);
  const monthly = split.monthly + (await projectMonthlyRollDelta(tx, orgId, rate, split, now));
  return { monthly, pack: split.pack, total: monthly + split.pack };
}

/** What a move down returns, from the package's OWN ledger rows (spec §7.4): bought credits, then included credits debited in
 *  this month, then an earlier month's, which are forfeited. The row's `credits_forfeited` is netted out of the earlier months
 *  first: the ledger keeps the consume rows of credits a previous move down already forfeited, and they are not forfeited twice.
 *  A row that has forfeited more than the ledger shows expired is refused by name (no forfeit can come from this month's credits). */
export async function backFor(tx: Tx, row: PackageRow, credits: number): Promise<ReturnPlan> {
  const can = await returnableFor(tx, { orgId: row.orgId, packageId: row.id });
  if (row.creditsForfeited > can.monthlyExpired) {
    throw new HttpError(
      500,
      `Online Chess package ${row.id} has forfeited ${row.creditsForfeited} included credits, but its ledger shows ${can.monthlyExpired} from an earlier month`,
      "online_package_forfeited_exceeds_expired",
    );
  }
  return planReturn({ ...can, monthlyExpired: can.monthlyExpired - row.creditsForfeited }, credits);
}

/** The quote for `size`, under the caller's transaction (and, for a writer, its locks: the `division:` lock, the org money lock
 *  and the package row, spec §7.3 — the quote takes none of them itself). `facts` are the division's, read in the same
 *  transaction (`readPackageFacts`); `rate` is the org's plan rate, read before it. The division must belong to `orgId` (a
 *  foreign or unknown division is a 404) and so must its package row (a mismatch is a named 500: "cannot happen", and money
 *  must never be quoted across tenants). A size off the ladder and facts that are not counts are RangeErrors: bugs upstream,
 *  never priced. */
export async function quoteLocked(
  tx: Tx,
  a: { orgId: string; divisionId: string; size: OnlineSize; cameras?: boolean; rate: number },
  facts: PackageFacts,
): Promise<PackageQuote> {
  if (!isOnlineSize(a.size)) throw new RangeError(`size ${String(a.size)} is not on the ladder (${ONLINE_SIZES.join(", ")})`);
  assertWhole(facts.held, "places held");
  assertWhole(facts.rounds, "counted rounds");

  const orgId = a.orgId.toLowerCase();
  const [division] = await tx<{ org_id: string }[]>`select org_id from divisions where id = ${a.divisionId}`;
  if (!division || division.org_id !== orgId) throw new HttpError(404, "division not found");
  const row = await livePackage(tx, a.divisionId);
  if (row && row.orgId !== orgId) {
    throw new HttpError(500, `Online Chess package ${row.id} does not belong to organisation ${a.orgId}; nothing was quoted`, "online_package_not_of_org");
  }

  const now = await transactionNow(tx);
  // Task 15: the organiser's answer, when given, is the camera state the payment would leave (and write to the division's policy);
  // the division must be able to carry it. No answer: the division's camera SETTING as it stands (P9) - never the camera price a
  // paid row holds (fix I2): a camera paid for and then turned off in Division settings is quoted off, so paying at the setting
  // returns its price, exactly as the receipt (which opens at the setting) quotes "No".
  if (a.cameras !== undefined) await assertCameraChoiceFits(tx, a.divisionId, a.cameras);
  const cameras = a.cameras ?? facts.cameras;
  const price = packagePrice(a.size, cameras);
  const paid = row !== null && row.paidAt !== null ? row : null;
  // Paid: the difference to what the row's own size and camera state cost (P13, P19). V560's CHECK ties `cameras_paid` to
  // `paid_at`: a paid row always says whether its cameras were paid.
  const owed = paid === null ? price : price - packagePrice(paid.size, paid.camerasPaid === true);

  const frozen = row !== null && row.frozenAt !== null;
  const refusal = refusalFor(a.size, facts, frozen);
  // Covers: the PAID package at ITS OWN size, whatever size is asked, judged without the plan and without the answer: the
  // places and rounds the size holds, and the camera price when the policy needs it (the same arithmetic as `owed`, at the row's
  // own size and the policy's cameras alone).
  const covers =
    paid !== null &&
    refusalFor(paid.size, { ...facts, planCap: null }, frozen) === null &&
    packagePrice(paid.size, facts.cameras || paid.camerasPaid === true) - packagePrice(paid.size, paid.camerasPaid === true) <= 0;

  const balance = await projectedSplit(tx, a.orgId, a.rate, now);
  let take: BucketSplit | null = null;
  let back: ReturnPlan | null = null;
  let shortBy: number | null = null;
  if (refusal === null) {
    if (owed > 0) {
      if (balance.total >= owed) take = planDebit(balance, owed);
      else shortBy = owed - balance.total;
    } else if (owed < 0 && paid !== null) back = await backFor(tx, paid, -owed);
  }

  return {
    size: a.size,
    cameras,
    price,
    owed,
    take,
    shortBy,
    back,
    monthlyExpiresOn: lastDayOfUtcMonth(now),
    balance: balance.total,
    held: facts.held,
    rounds: facts.rounds,
    refusal,
    covers,
  };
}

/** The four facts of a division, in the caller's transaction: cameras (P9), counted rounds (P15), places held, and the plan cap
 *  the caller read before it. ONE reader, so the quote, the pay door and the open-round gate cannot judge different facts. */
export async function readPackageFacts(db: Tx | typeof sql, divisionId: string, planCap: number | null): Promise<PackageFacts> {
  return {
    cameras: await derivedCameras(db, divisionId),
    rounds: await countedRounds(db, divisionId),
    held: await countOnlineHeld(db, divisionId),
    planCap,
  };
}

/** The read the price line and the receipt make: the quote for `size` on a division of the caller's org, in a READ-ONLY
 *  transaction with no lock (the database refuses a write in it). Organisers only: a device link or a Match Day code is 403, and
 *  a division of another org reads as not found. The plan cap and the plan's monthly rate are read before the transaction. */
export async function onlinePackageQuote(auth: AuthCtx, divisionId: string, size: OnlineSize, cameras?: boolean): Promise<PackageQuote> {
  if (auth.via === "device_link" || auth.via === "match_day_code") {
    throw new HttpError(403, "A device link or a Match Day code cannot read an Online Chess quote");
  }
  const [division] = await sql<{ org_id: string; competition_id: string }[]>`
    select org_id, competition_id from divisions where id = ${divisionId}`;
  if (!division || division.org_id !== auth.orgId.toLowerCase()) throw new HttpError(404, "division not found");
  const planCap = await getLimit(division.org_id, "entrants.per_division.max", division.competition_id);
  const rate = await streamMonthlyRate(division.org_id, { quiet: true });
  return sql.begin("read only", async (tx) =>
    quoteLocked(tx, { orgId: division.org_id, divisionId, size, cameras, rate }, await readPackageFacts(tx, divisionId, planCap)),
  ) as Promise<PackageQuote>;
}
