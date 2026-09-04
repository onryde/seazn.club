// The pass/Pro crossover, derived — never typed.
//
// The figure this computes is the one thing /pricing never said: the pass is
// cheaper up front and dearer per pound of entry fees, so for a one-month
// competition the two offers cross exactly once. The page read as "the pass is
// cheaper", full stop, which pushes volume at the one-time sku.
//
// Both halves are pinned here: the ARITHMETIC against hand-worked cases, and
// the LIVE figure against the catalogue and `plan_entitlements` — so a reprice
// or a fee re-cut moves the test with the product instead of leaving it
// asserting yesterday's number.
import { afterAll, describe, expect, it } from "vitest";
import { feeCrossoverMinor, readableMinor } from "../pricing-crossover";
import { SUPPORTED_CURRENCIES, formatMinor, passPrice, proPrice } from "../currency";
import { sql } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe("feeCrossoverMinor — where a month of Pro overtakes the pass", () => {
  it("solves the crossing, not an approximation of it", () => {
    // $11.99 pass at 4% vs $14.99/mo Pro at 2%: the $3.00 sticker gap is
    // recovered by the 2-point fee gap at $150 of entry fees.
    const at = feeCrossoverMinor({
      passMinor: 1199,
      proMonthlyMinor: 1499,
      passFeePercent: 4,
      proFeePercent: 2,
    });
    expect(at).toBe(15000);
    // …and it really is a crossing: check both totals AT the point, and that
    // the ordering flips either side of it. A formula that merely returns a
    // plausible number passes an equality check on itself; this does not.
    const cost = (fees: number, sticker: number, fee: number) => sticker + (fees * fee) / 100;
    expect(cost(15000, 1199, 4)).toBe(cost(15000, 1499, 2));
    expect(cost(14000, 1199, 4)).toBeLessThan(cost(14000, 1499, 2));
    expect(cost(16000, 1199, 4)).toBeGreaterThan(cost(16000, 1499, 2));
  });

  it("moves with the fee ladder rather than staying put", () => {
    // Halving the fee GAP doubles the volume it takes to recover the sticker
    // gap — the property a hardcoded threshold cannot have.
    expect(
      feeCrossoverMinor({ passMinor: 1199, proMonthlyMinor: 1499, passFeePercent: 3, proFeePercent: 2 }),
    ).toBe(30000);
    // …and widening the sticker gap moves it the other way.
    expect(
      feeCrossoverMinor({ passMinor: 999, proMonthlyMinor: 1499, passFeePercent: 4, proFeePercent: 2 }),
    ).toBe(25000);
  });

  it("says nothing when the two offers never cross", () => {
    // Pro cheaper up front: it already wins everywhere, so there is no
    // threshold — and the line must vanish rather than reverse its meaning.
    expect(
      feeCrossoverMinor({ passMinor: 1999, proMonthlyMinor: 1499, passFeePercent: 4, proFeePercent: 2 }),
    ).toBeNull();
    // Equal stickers: same thing, from the other side.
    expect(
      feeCrossoverMinor({ passMinor: 1499, proMonthlyMinor: 1499, passFeePercent: 4, proFeePercent: 2 }),
    ).toBeNull();
    // Same fee on both: the pass is simply cheaper, for ever. (Also the
    // division by zero this guard stands in front of.)
    expect(
      feeCrossoverMinor({ passMinor: 1199, proMonthlyMinor: 1499, passFeePercent: 2, proFeePercent: 2 }),
    ).toBeNull();
    // Pass fee LOWER than Pro's: it dominates on both axes.
    expect(
      feeCrossoverMinor({ passMinor: 1199, proMonthlyMinor: 1499, passFeePercent: 1, proFeePercent: 2 }),
    ).toBeNull();
  });

  it("says nothing when a rate could not be read", () => {
    // A missing `plan_entitlements` row must not be rendered as a rate. Same
    // rule lib/pass-comparison.ts applies to this exact column.
    for (const missing of [null, undefined]) {
      expect(
        feeCrossoverMinor({ passMinor: 1199, proMonthlyMinor: 1499, passFeePercent: missing, proFeePercent: 2 }),
      ).toBeNull();
      expect(
        feeCrossoverMinor({ passMinor: 1199, proMonthlyMinor: 1499, passFeePercent: 4, proFeePercent: missing }),
      ).toBeNull();
    }
  });
});

describe("readableMinor — a threshold a person can hold in their head", () => {
  it("keeps two significant figures of the major unit", () => {
    expect(readableMinor(15000)).toBe(15000); // $150
    expect(readableMinor(10000)).toBe(10000); // £100
    expect(readableMinor(500000)).toBe(500000); // ₹5,000
    expect(readableMinor(15037)).toBe(15000); // not $150.37
    expect(readableMinor(123456)).toBe(120000); // $1,200, not $1,234.56
  });

  it("never rounds a small figure away to nothing", () => {
    expect(readableMinor(742)).toBe(700); // $7
    expect(readableMinor(149)).toBe(100); // $1, not $0
  });

  it("returns 0 for a figure there is nothing to render", () => {
    expect(readableMinor(0)).toBe(0);
    expect(readableMinor(-5000)).toBe(0);
  });
});

// ── The live figure ─────────────────────────────────────────────────────────
//
// Real Postgres required; skipped without DATABASE_URL (CI sets it).
describe.skipIf(!HAS_DB)("the crossing the page will actually print", () => {
  const feeFor = async (plan: string): Promise<number | null> => {
    const [row] = await sql<{ int_value: number | null }[]>`
      select int_value from plan_entitlements
       where plan_key = ${plan} and feature_key = 'registration.fee_percent'`;
    expect(row, `plan_entitlements has no ${plan}/registration.fee_percent row`).toBeDefined();
    return row!.int_value;
  };

  it("is a real crossing in EVERY currency we sell in", async () => {
    const passFeePercent = await feeFor("event_pass");
    const proFeePercent = await feeFor("pro");
    // The premise of the line: the pass costs more per pound of entry fees.
    // If a re-cut ever ends that, the copy is wrong, not merely stale.
    expect(passFeePercent!).toBeGreaterThan(proFeePercent!);

    for (const currency of SUPPORTED_CURRENCIES) {
      const at = feeCrossoverMinor({
        passMinor: passPrice(currency, "event_pass"),
        proMonthlyMinor: proPrice("monthly", currency),
        passFeePercent,
        proFeePercent,
      });
      expect(at, `${currency} has no crossing`).not.toBeNull();
      expect(readableMinor(at!), `${currency} rounds away to nothing`).toBeGreaterThan(0);
    }
  });

  it("puts the usd crossing at $150 — derived from the catalogue and the matrix", async () => {
    const at = feeCrossoverMinor({
      passMinor: passPrice("usd", "event_pass"),
      proMonthlyMinor: proPrice("monthly", "usd"),
      passFeePercent: await feeFor("event_pass"),
      proFeePercent: await feeFor("pro"),
    });
    // Spelled out so a reprice that moves it is visible as a number, not just
    // as a green test. $11.99 pass / $14.99 Pro / 4% vs 2%.
    expect(formatMinor(readableMinor(at!), "usd")).toBe("$150");
  });
});
