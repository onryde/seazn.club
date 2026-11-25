// The full refund of an Online Chess package (spec 2026-11-23-online-chess-credits-design.md §7.1, §7.4 item 4; P6, P7, P21;
// plan Task 6). REAL writers against a REAL database (skipped without DATABASE_URL): the package is opened by the create door,
// paid by the pay door with no deps, and refunded both by `refundOnlinePackageLocked` directly (the second call, the frozen and
// the unpaid refusals) and through the division delete (the door every organiser reaches).
//
// Where the expected numbers come from — never from refund.ts, quote.ts or ledger.ts:
//   * the price is the Global Constraints' table (`gcPrice`: 256 without cameras = 16, 64 = 4, 32 = 2), held against the leaf;
//   * the split of a debit (included first, then bought, P4) and of a return (bought first, then included of this month, then
//     forfeited, P21) is the spec's, over buckets the case PUT there: 4 included credits left this month, a 20 pack.
//
// single-sport: Online Chess is boardgame only (online-play.ts `supportsOnlinePlay`).
//
// Mutant table (each run once by hand; results in the commit message):
//   R1 `refunded_at` not stamped by the full refund                   -> "refund twice writes once", "full refund: …"
//   R2 the frozen check in refundOnlinePackageLocked dropped          -> "refund of a frozen row is refused" (409, not the ledger's 500)
//   R3 credits_forfeited not counted by the full refund (CHECK reds)  -> "full refund: … earlier month"
//   R4 the return split ignores a move down's forfeits (no netting)   -> "move down then full refund …"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return { ...actual, isServerFeatureEnabled: vi.fn(async () => false) };
});

import { sql, type Tx } from "@/lib/db";
import { deleteDivision } from "@/server/usecases/divisions";
import { forgetOnlineChessFlagCache } from "@/server/usecases/external-play/online-chess-flag";
import { livePackageById, refundOnlinePackageLocked } from "@/server/usecases/online-package";
import {
  backdateOrgLedger, balance, buy, expectBooks, expectLeafPrices, freeze, gcPrice, liveOf, ocCompetition, ocDivision, ocOrg,
  orgLedgerCount, packageById, packageLedger, pay, refusal, spendTheMonth,
} from "./_oc-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const ALWAYS = process.env.ONLINE_CHESS_ALWAYS;
/** The case's buckets: 4 included credits left this month, a 20 pack; the package is 256 without cameras (16). */
const INCLUDED = 4;
const PACK = 20;
const PAID = 16;

beforeAll(() => {
  if (!HAS_DB) return;
  process.env.ONLINE_CHESS_ALWAYS = "1";
  forgetOnlineChessFlagCache();
  expectLeafPrices();
  expect(gcPrice(256)).toBe(PAID);
});
afterAll(async () => {
  if (ALWAYS === undefined) delete process.env.ONLINE_CHESS_ALWAYS;
  else process.env.ONLINE_CHESS_ALWAYS = ALWAYS;
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

const inTx = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => sql.begin(fn) as unknown as Promise<T>;

/** An org with 4 included credits left and a 20 pack, an online division, its package PAID at 256 (4 included + 12 bought). */
async function paidRig() {
  const o = await ocOrg();
  await spendTheMonth(o.orgId, INCLUDED);
  await buy(o.orgId, PACK);
  const d = await ocDivision(o, await ocCompetition(o));
  await pay(o, d.id, 256);
  const pkg = await liveOf(d.id);
  expect(await packageLedger(pkg.id), "premise: included first, then bought (P4)").toEqual([
    { reason: "consume", bucket: "monthly", delta: -INCLUDED },
    { reason: "consume", bucket: "pack", delta: -(PAID - INCLUDED) },
  ]);
  return { o, d, pkg };
}

const refundNow = (id: string) =>
  inTx(async (tx) => refundOnlinePackageLocked(tx, (await livePackageById(tx, id, { includeRefunded: true }))!));

describe.skipIf(!HAS_DB)("the full refund of a package (§7.4 item 4)", () => {
  it("full refund: bought back in full; included back only inside its month; forfeited counted; refunded_at set", async () => {
    // Inside the month: everything comes back, each bucket to itself.
    const a = await paidRig();
    expect(await refundNow(a.pkg.id), "each bucket back to itself").toEqual({ pack: PAID - INCLUDED, monthly: INCLUDED, forfeited: 0 });
    expect(await packageById(a.pkg.id)).toMatchObject({ credits_paid: PAID, credits_refunded: PAID, credits_forfeited: 0 });
    expect((await packageById(a.pkg.id))!.refunded_at).not.toBeNull();
    expect(await balance(a.o.orgId), "the org holds what it held before paying").toEqual({ monthly: INCLUDED, pack: PACK, total: INCLUDED + PACK });
    expect(await expectBooks(a.pkg.id, "inside the month")).toBe(1);

    // The month turned: the 4 included credits expired with it, so they are forfeited (counted, never written); the 12 bought
    // come back.
    const b = await paidRig();
    await backdateOrgLedger(b.o.orgId);
    expect(await refundNow(b.pkg.id)).toEqual({ pack: PAID - INCLUDED, monthly: 0, forfeited: INCLUDED });
    expect(await packageById(b.pkg.id)).toMatchObject({ credits_paid: PAID, credits_refunded: PAID - INCLUDED, credits_forfeited: INCLUDED });
    expect((await packageById(b.pkg.id))!.refunded_at).not.toBeNull();
    expect(await packageLedger(b.pkg.id), "one bought return, no included one").toEqual([
      { reason: "consume", bucket: "monthly", delta: -INCLUDED },
      { reason: "consume", bucket: "pack", delta: -(PAID - INCLUDED) },
      { reason: "refund", bucket: "pack", delta: PAID - INCLUDED },
    ]);
    expect((await balance(b.o.orgId)).pack).toBe(PACK);
    expect(await expectBooks(b.pkg.id, "after the month turned")).toBe(1);
  });

  it("refund twice writes once; refund of a frozen row is refused; an unpaid row is not refundable", async () => {
    const a = await paidRig();
    expect(await refundNow(a.pkg.id)).toEqual({ pack: PAID - INCLUDED, monthly: INCLUDED, forfeited: 0 });
    const rows = await orgLedgerCount(a.o.orgId);
    const stamped = (await packageById(a.pkg.id))!.refunded_at;
    expect(await refundNow(a.pkg.id), "the second call").toEqual({ pack: 0, monthly: 0, forfeited: 0 });
    expect(await orgLedgerCount(a.o.orgId), "no row written").toBe(rows);
    expect((await packageById(a.pkg.id))!.refunded_at, "the stamp is the first call's").toEqual(stamped);

    // A round opened: never refunded, by name, and nothing written.
    const f = await paidRig();
    await freeze(f.pkg.id);
    const before = await orgLedgerCount(f.o.orgId);
    const err = await refusal(refundNow(f.pkg.id));
    expect({ status: err.status, code: err.code }).toEqual({ status: 409, code: "online_package_frozen" });
    expect(await orgLedgerCount(f.o.orgId)).toBe(before);
    expect(await packageById(f.pkg.id)).toMatchObject({ credits_refunded: 0, refunded_at: null });

    // Unpaid: there is nothing to refund (the doors delete such a row instead).
    const o = await ocOrg();
    const d = await ocDivision(o, await ocCompetition(o));
    const unpaid = await liveOf(d.id);
    const e2 = await refusal(refundNow(unpaid.id));
    expect({ status: e2.status, code: e2.code }).toEqual({ status: 500, code: "online_package_unpaid" });
    expect(await packageById(unpaid.id)).toMatchObject({ paid_at: null, refunded_at: null });
  });

  it("move down then full refund never return more than was paid — inside the month, and across it with a forfeit", async () => {
    // Inside the month: 256 → 64 returns 12 (bought first, P21), the refund the last 4 (included, this month).
    const a = await paidRig();
    const down = await pay(a.o, a.d.id, 64);
    expect(down.quote.owed).toBe(-(gcPrice(256) - gcPrice(64)));
    expect(await refundNow(a.pkg.id), "the move down took the bought first: the last 4 are included").toEqual({ pack: 0, monthly: gcPrice(64), forfeited: 0 });
    const p = (await packageById(a.pkg.id))!;
    expect(p.credits_refunded + p.credits_forfeited, "refunded + forfeited = paid").toBe(PAID);
    expect(p.credits_refunded).toBe(PAID);
    expect(await balance(a.o.orgId)).toEqual({ monthly: INCLUDED, pack: PACK, total: INCLUDED + PACK });

    // Across the month: 256 → 32 after the month turned returns the 12 bought and forfeits 2 of the 4 expired included
    // credits; the refund then forfeits the other 2 (never the same 2 twice) and returns nothing.
    const b = await paidRig();
    await backdateOrgLedger(b.o.orgId);
    const d2 = await pay(b.o, b.d.id, 32);
    expect(d2.quote.back, "the receipt's split").toEqual({ pack: PAID - INCLUDED, monthly: 0, forfeited: INCLUDED - gcPrice(32) });
    expect(await refundNow(b.pkg.id)).toEqual({ pack: 0, monthly: 0, forfeited: gcPrice(32) });
    const q = (await packageById(b.pkg.id))!;
    expect(q).toMatchObject({ credits_paid: PAID, credits_refunded: PAID - INCLUDED, credits_forfeited: INCLUDED });
    expect(q.refunded_at).not.toBeNull();
    const returned = (await packageLedger(b.pkg.id)).filter((r) => r.reason === "refund").reduce((s, r) => s + r.delta, 0);
    expect(returned, "never more than was paid in bought credits").toBe(PAID - INCLUDED);
    expect(await expectBooks(b.pkg.id, "after both")).toBe(1);
  });

  it("through the delete door: pay → delete before round 1 (bought in full, included in its month); pay → month turns → delete", async () => {
    const a = await paidRig();
    await deleteDivision(a.o.auth, a.d.id);
    expect(await packageById(a.pkg.id)).toMatchObject({ division_id: null, credits_refunded: PAID, credits_forfeited: 0 });
    expect(await balance(a.o.orgId)).toEqual({ monthly: INCLUDED, pack: PACK, total: INCLUDED + PACK });

    const b = await paidRig();
    await backdateOrgLedger(b.o.orgId);
    await deleteDivision(b.o.auth, b.d.id);
    expect(await packageById(b.pkg.id)).toMatchObject({ division_id: null, credits_refunded: PAID - INCLUDED, credits_forfeited: INCLUDED });
    expect((await balance(b.o.orgId)).pack).toBe(PACK);
    expect(await expectBooks(b.pkg.id, "deleted after the month turned")).toBe(1);
  });
});
