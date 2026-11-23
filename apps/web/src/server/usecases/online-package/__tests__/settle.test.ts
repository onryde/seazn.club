// A refunded card payment and a refunded package (spec 2026-11-23-online-chess-credits-design.md §7.5, review C1; plan Task 6).
// Without the change, a club keeps credits its card payment no longer covers: buy a 20 pack, pay 16 for a package, refund the card
// (the claw-back takes the 4 that are left), then delete the division (16 pack credits return). Two changes close it, in BOTH
// orders, and every case here drives the REAL writers against a REAL database (skipped without DATABASE_URL):
//   * the purchase (`recordPurchase`, with its payment intent), the payment (`payOnlinePackage`, no deps: the route's own call),
//     the card refund (`recordStreamPackRefund`, the webhook arm's call), the delete (`deleteDivision`, the tenant door: withTenant
//     as app_user, the refund in its privileged epilogue), and the move down (`payOnlinePackage` with a smaller size).
//
// Where the expected numbers come from — never from settle.ts, reversals.ts or stream-credits.ts:
//   * a package's price is the Global Constraints' table (`gcPrice`; 256 without cameras = 16, 128 = 8), held against the leaf;
//   * the claw-back, the settle row and the balance are §7.5's arithmetic over the buckets the case PUT there: the month's included
//     credits are spent to 0 first, so every payment draws bought credits, and worked examples 1 and 2 are typed from the spec.
//
// single-sport: Online Chess is boardgame only (online-play.ts `supportsOnlinePlay`).
//
// Mutant table (each run once by hand; results in the commit message):
//   S1 the claw-back's netting dropped (consumes only)               -> "other order", "card refund AFTER a move down"
//   S2 the attribution replaced by purchased − revoked                -> "worked example 2", "a package that froze"
//   S3 the settle step not run by the full refund                     -> "worked example 1"
//   S4 the settle default in pay.ts restored to the no-op             -> "move down runs settle, with NO deps"
//   S5 the marker not written on a zero claw-back                     -> "a zero claw-back still writes a reversal marker"
//   S6 the per-package bound on the netting dropped (spec's raw sum)  -> "a package paid BEFORE the pack was bought"
//   S7 the claw-back's already-revoked term dropped                   -> "a dispute after a settled reversal"
//   I1 the bound read as "held before `since`" (round-1 formula)      -> both "a package straddling the purchase" cases
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return { ...actual, isServerFeatureEnabled: vi.fn(async () => false) };
});

import { sql, type Tx } from "@/lib/db";
import { deleteDivision } from "@/server/usecases/divisions";
import { forgetOnlineChessFlagCache } from "@/server/usecases/external-play/online-chess-flag";
import { recordStreamPackRefund } from "@/server/usecases/stream-credits";
import { settleReversals } from "@/server/usecases/online-package";
import {
  balance, buy, cardRefund, expectBooks, expectLeafPrices, freeze, gcPrice, liveOf, ocCompetition, ocDivision, ocOrg, pay,
  reversalsOf, revokes, spendTheMonth, streamSpend, type Org,
} from "./_oc-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const ALWAYS = process.env.ONLINE_CHESS_ALWAYS;
/** §7.5's worked examples: the pack, and the package it pays (256 without cameras, 16 credits — the table's, asserted below). */
const PACK = 20;
const PAID = 16;

beforeAll(() => {
  if (!HAS_DB) return;
  process.env.ONLINE_CHESS_ALWAYS = "1";
  forgetOnlineChessFlagCache();
  expectLeafPrices();
  expect(gcPrice(256), "premise: a 256 package without cameras is §7.5's 16").toBe(PAID);
});
afterAll(async () => {
  if (ALWAYS === undefined) delete process.env.ONLINE_CHESS_ALWAYS;
  else process.env.ONLINE_CHESS_ALWAYS = ALWAYS;
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

/** An org whose month is spent, one online division in a competition of its own, and its unpaid package (the create door's). */
async function rig(): Promise<{ o: Org; divisionId: string }> {
  const o = await ocOrg();
  await spendTheMonth(o.orgId);
  const d = await ocDivision(o, await ocCompetition(o));
  return { o, divisionId: d.id };
}

const inTx = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => sql.begin(fn) as unknown as Promise<T>;

describe.skipIf(!HAS_DB)("a card refund and a package refund settle in both orders (§7.5)", () => {
  it("worked example 1: buy 20, pay 16, card refund (claws 4), delete division → settle revokes 16; balance 0", async () => {
    const { o, divisionId } = await rig();
    const a = await buy(o.orgId, PACK);
    await pay(o, divisionId, 256);
    const pkg = await liveOf(divisionId);
    expect(await balance(o.orgId), "premise: 16 drawn from the pack").toMatchObject({ monthly: 0, pack: PACK - PAID });

    const claw = await cardRefund(a);
    expect(claw).toMatchObject({ matched: true, clawedBack: PACK - PAID, purchased: PACK, applied: true });
    expect((await balance(o.orgId)).total).toBe(0);

    await deleteDivision(o.auth, divisionId);
    expect(await revokes(o.orgId), "the claw-back's keyed row, then the settle row: no key, the intent").toEqual([
      { delta: -(PACK - PAID), idempotency_key: `stream_pack_refund:${a}`, stripe_payment_intent_id: a },
      { delta: -PAID, idempotency_key: null, stripe_payment_intent_id: a },
    ]);
    expect(await balance(o.orgId), "the club has its money back and no credits").toEqual({ monthly: 0, pack: 0, total: 0 });
    expect(await expectBooks(pkg.id, "the refunded package")).toBe(1);
  });

  it("other order: buy 20, pay 16, delete division (16 back), card refund → claws 20; balance 0", async () => {
    const { o, divisionId } = await rig();
    const a = await buy(o.orgId, PACK);
    await pay(o, divisionId, 256);
    await deleteDivision(o.auth, divisionId);
    expect(await balance(o.orgId), "premise: the package returned its 16").toMatchObject({ pack: PACK });
    expect(await revokes(o.orgId), "no reversal yet: the settle step had nothing to do").toEqual([]);

    const claw = await cardRefund(a);
    // The refunded package is not spent: the claw-back takes all 20, not the 4 a consumes-only count would.
    expect(claw).toMatchObject({ matched: true, clawedBack: PACK, purchased: PACK, applied: true });
    expect(await balance(o.orgId)).toEqual({ monthly: 0, pack: 0, total: 0 });
  });

  it("worked example 2: pack A 5 spent on streams and reversed; pack B 20 pays 16, refunded → settle revokes 0; balance 20", async () => {
    const { o, divisionId } = await rig();
    const a = await buy(o.orgId, 5);
    await streamSpend(o.orgId, 5);
    const claw = await cardRefund(a);
    expect(claw, "A was fully spent: nothing to take").toMatchObject({ matched: true, clawedBack: 0, purchased: 5, applied: false });
    expect(await reversalsOf(o.orgId), "…and the reversal is recorded all the same").toEqual([{ intent: a, purchased: 5 }]);

    await buy(o.orgId, PACK);
    await pay(o, divisionId, 256);
    await deleteDivision(o.auth, divisionId);
    expect(await revokes(o.orgId), "A's streams were spent for good; B's credits are B's").toEqual([]);
    expect(await balance(o.orgId)).toEqual({ monthly: 0, pack: PACK, total: PACK });
  });

  it("a package that froze is never reversed: buy 20, pay 16, open round, card refund → claws 4 only; a delete then leaves it", async () => {
    const { o, divisionId } = await rig();
    const a = await buy(o.orgId, PACK);
    await pay(o, divisionId, 256);
    const pkg = await liveOf(divisionId);
    await freeze(pkg.id);

    const claw = await cardRefund(a);
    expect(claw).toMatchObject({ matched: true, clawedBack: PACK - PAID, applied: true });
    expect(await balance(o.orgId)).toEqual({ monthly: 0, pack: 0, total: 0 });
    // The division is deleted after round 1 opened (the delete door allows a setup division whose package froze): no refund, no
    // settle — the package ran, so its 16 stay spent.
    await deleteDivision(o.auth, divisionId);
    expect(await revokes(o.orgId), "one claw-back row, no settle row").toHaveLength(1);
    expect(await balance(o.orgId)).toEqual({ monthly: 0, pack: 0, total: 0 });
  });

  it("a zero claw-back still writes a reversal marker, and a replayed webhook writes no second and raises nothing", async () => {
    const o = await ocOrg();
    const a = await buy(o.orgId, 5);
    await streamSpend(o.orgId, 5);
    expect(await reversalsOf(o.orgId), "premise: no marker before the refund").toEqual([]);
    let deliveries = 0;
    for (const via of ["refund", "refund", "dispute"] as const) {
      const r = await recordStreamPackRefund({ paymentIntentId: a, via, reference: `ch_${deliveries}` });
      expect(r, `delivery ${deliveries + 1} (${via})`).toMatchObject({ matched: true, clawedBack: 0, applied: false });
      deliveries += 1;
    }
    expect(deliveries).toBe(3);
    expect(await reversalsOf(o.orgId), "one marker for the intent").toEqual([{ intent: a, purchased: 5 }]);
    expect(await revokes(o.orgId)).toEqual([]);
  });

  it("move down runs settle, with NO deps: example 1 with a move down (256 → 128) in place of the delete → settle revokes 8", async () => {
    const { o, divisionId } = await rig();
    const a = await buy(o.orgId, PACK);
    await pay(o, divisionId, 256);
    await cardRefund(a); // claws 4
    const back = gcPrice(256) - gcPrice(128);
    const down = await pay(o, divisionId, 128); // the route's call: no deps, so the default settle runs
    expect(down.quote.owed, "the move down returns the difference").toBe(-back);
    expect(await revokes(o.orgId)).toEqual([
      { delta: -(PACK - PAID), idempotency_key: `stream_pack_refund:${a}`, stripe_payment_intent_id: a },
      { delta: -back, idempotency_key: null, stripe_payment_intent_id: a },
    ]);
    expect(await balance(o.orgId)).toEqual({ monthly: 0, pack: 0, total: 0 });
    expect(await expectBooks(down.package.id, "after the move down")).toBe(2);
  });

  it("card refund AFTER a move down: the credits the move down returned are taken (20 − (16 − 8) = 12)", async () => {
    const { o, divisionId } = await rig();
    const a = await buy(o.orgId, PACK);
    await pay(o, divisionId, 256);
    await pay(o, divisionId, 128);
    const spent = gcPrice(128);
    expect(await balance(o.orgId), "premise: 8 of the pack still pay for the 128").toMatchObject({ pack: PACK - spent });
    const claw = await cardRefund(a);
    expect(claw).toMatchObject({ clawedBack: PACK - spent, applied: true });
    expect(await balance(o.orgId)).toEqual({ monthly: 0, pack: 0, total: 0 });
  });

  it("a package paid BEFORE the pack was bought, refunded after it: its returned credits are not the pack's to take", async () => {
    const { o, divisionId } = await rig();
    await buy(o.orgId, PAID); // pack X
    await pay(o, divisionId, 256); // 16 from X
    const a = await buy(o.orgId, PACK); // pack A, bought later
    await deleteDivision(o.auth, divisionId); // X's 16 return
    expect(await balance(o.orgId), "premise: A's 20 and X's 16").toMatchObject({ pack: PACK + PAID });
    const claw = await cardRefund(a);
    expect(claw, "A spent nothing: all of A, and none of X").toMatchObject({ clawedBack: PACK, applied: true });
    expect(await balance(o.orgId)).toEqual({ monthly: 0, pack: PAID, total: PAID });
  });

  // Review I1: a package that STRADDLES the purchase. Pack X (16) pays the 128 (8) before pack A is bought; the upgrade to 256 draws
  // 8 more from the pack after A; the move down returns 8. Those 8 were drawn from the pack since A was bought and came back, so
  // they are not spent: A's claw-back takes them, in either order. X's other 8 are the club's, and the frozen 128 keeps its own.
  const UPGRADE = gcPrice(256) - gcPrice(128);
  async function straddle(): Promise<{ o: Org; divisionId: string; a: string }> {
    const { o, divisionId } = await rig();
    await buy(o.orgId, PAID); // pack X
    await pay(o, divisionId, 128); // 8 from X, before A
    const a = await buy(o.orgId, PACK);
    await pay(o, divisionId, 256); // the upgrade: 8 from the pack, after A
    expect(await balance(o.orgId), "premise: X's 8 left and A's 20, less the upgrade's 8").toMatchObject({
      monthly: 0, pack: PAID - gcPrice(128) + PACK - UPGRADE,
    });
    return { o, divisionId, a };
  }
  async function endsFrozenAtX(o: Org, packageId: string): Promise<void> {
    await freeze(packageId);
    expect(await inTx((tx) => settleReversals(tx, o.orgId)), "nothing left to settle").toBe(0);
    expect(await balance(o.orgId), "X's unspent 8, and none of A").toEqual({
      monthly: 0, pack: PAID - gcPrice(128), total: PAID - gcPrice(128),
    });
    expect(await expectBooks(packageId, "the frozen 128")).toBe(2);
  }

  it("a package straddling the purchase, card refund AFTER the move down: the 8 it returned are A's (claws all 20)", async () => {
    const s = await straddle();
    const down = await pay(s.o, s.divisionId, 128);
    expect(down.quote.owed, "the move down returns the upgrade").toBe(-UPGRADE);
    const claw = await cardRefund(s.a);
    expect(claw, "A spent nothing it kept: the upgrade's 8 came back").toMatchObject({ clawedBack: PACK, applied: true });
    await endsFrozenAtX(s.o, down.package.id);
  });

  it("a package straddling the purchase, card refund BEFORE the move down: claws 12, then the move down's settle takes the 8", async () => {
    const s = await straddle();
    const claw = await cardRefund(s.a);
    expect(claw, "the upgrade's 8 are spent while the package holds them").toMatchObject({ clawedBack: PACK - UPGRADE, applied: true });
    const down = await pay(s.o, s.divisionId, 128);
    expect(await revokes(s.o.orgId), "the claw-back's 12, then the settle row's 8").toEqual([
      { delta: -(PACK - UPGRADE), idempotency_key: `stream_pack_refund:${s.a}`, stripe_payment_intent_id: s.a },
      { delta: -UPGRADE, idempotency_key: null, stripe_payment_intent_id: s.a },
    ]);
    await endsFrozenAtX(s.o, down.package.id);
  });

  it("settle is bounded by the attribution: a second run writes nothing; a dispute after a settled reversal claws nothing more", async () => {
    const { o, divisionId } = await rig();
    const a = await buy(o.orgId, PACK);
    await pay(o, divisionId, 256);
    await buy(o.orgId, 1); // a later pack: the settle step must never reach it
    expect(await balance(o.orgId), "premise: 4 of A and 1 later").toMatchObject({ pack: PACK - PAID + 1 });
    await streamSpend(o.orgId, PACK - PAID); // A's other 4 go on streams: all of A is spent or held by the package
    // A zero-claw first delivery, then the delete returns 16 and the settle step takes them.
    const first = await cardRefund(a);
    expect(first, "nothing of A is left in the balance that is A's").toMatchObject({ clawedBack: 0, applied: false });
    await deleteDivision(o.auth, divisionId);
    expect(await revokes(o.orgId), "the settle row takes A's 16 back").toEqual([{ delta: -PAID, idempotency_key: null, stripe_payment_intent_id: a }]);
    expect(await inTx((tx) => settleReversals(tx, o.orgId)), "a second run").toBe(0);
    const again = await recordStreamPackRefund({ paymentIntentId: a, via: "dispute", reference: "dp_after" });
    expect(again, "the dispute counts what is already revoked: 16 in total, nothing new").toMatchObject({ clawedBack: PAID, applied: false });
    expect(await revokes(o.orgId)).toHaveLength(1);
    expect(await balance(o.orgId), "the later pack's 1 credit is untouched").toEqual({ monthly: 0, pack: 1, total: 1 });
  });
});
