// Lane-close re-review M-3 (the m10 residual): the match-credit pack prices are PLACEHOLDERS while
// `STREAM_PACK_PRICES_FINAL` is false (lib/stream-credit-packs.ts). Until then the GBP amounts and `STREAM_PACK_FX` are
// the code's own table, which the house rules allow for a placeholder. The day the owner rules the real prices, the flag
// flips, and from then on the table is money the owner ruled: it must equal owner literals DECLARED HERE, never read back
// from the module under test.
//
// This is the tripwire. While the flag is false it passes and says why. Flip the flag without filling
// `OWNER_FINAL_PRICES` below and it fails loudly, naming what to add; fill it with anything but the table and it fails
// naming each difference.
import { describe, expect, it } from "vitest";
import {
  STREAM_CREDIT_PACKS,
  STREAM_PACK_FX,
  STREAM_PACK_PRICES_FINAL,
  type StreamPackSize,
} from "../stream-credit-packs";

interface OwnerFinalPrices {
  /** The owner-ruled GBP price of each pack, in pence. */
  gbpPence: Readonly<Record<StreamPackSize, number>>;
  /** The owner-ruled multiplier for every non-GBP currency a pack's price carries. */
  fx: Readonly<Record<string, number>>;
}

/**
 * THE OWNER'S FINAL PRICES. `null` until the owner rules them. When you flip `STREAM_PACK_PRICES_FINAL` to true, write
 * the ruled values here AS LITERALS, in the same change. Do not copy them from `stream-credit-packs.ts`: typing them
 * from the ruling is the whole check.
 */
const OWNER_FINAL_PRICES: OwnerFinalPrices | null = null;

/** Every problem with the table, given the flag and the declared literals. Empty means the tripwire holds. `checked`
 *  counts the comparisons made, so a flipped flag that compared nothing cannot pass. */
function finalPriceProblems(
  final: boolean,
  declared: OwnerFinalPrices | null,
  table: { packs: readonly { size: StreamPackSize; gbpPence: number }[]; fx: Readonly<Record<string, number>> },
): { problems: string[]; checked: number } {
  if (!final) return { problems: [], checked: 0 };
  if (declared === null) {
    return {
      problems: [
        "STREAM_PACK_PRICES_FINAL is true, but stream-pack-prices-final.test.ts declares no owner-ruled prices: " +
          "write the ruled GBP pence per pack and the FX rate per currency into OWNER_FINAL_PRICES, as literals from the ruling",
      ],
      checked: 0,
    };
  }
  const problems: string[] = [];
  let checked = 0;
  for (const pack of table.packs) {
    const want = declared.gbpPence[pack.size];
    if (pack.gbpPence !== want) problems.push(`the ${pack.size}-pack charges ${pack.gbpPence} pence; the owner ruled ${want}`);
    checked++;
  }
  const codes = new Set([...Object.keys(table.fx), ...Object.keys(declared.fx)]);
  for (const code of codes) {
    if (table.fx[code] !== declared.fx[code]) {
      problems.push(`STREAM_PACK_FX.${code} is ${table.fx[code]}; the owner ruled ${declared.fx[code]}`);
    }
    checked++;
  }
  if (checked === 0) problems.push("the tripwire compared nothing");
  return { problems, checked };
}

describe("match-credit pack prices: the FINAL tripwire (M-3)", () => {
  it("the live table: passes while the prices are placeholders; once final, equals the owner's declared literals", ({ annotate }) => {
    const { problems, checked } = finalPriceProblems(STREAM_PACK_PRICES_FINAL, OWNER_FINAL_PRICES, {
      packs: STREAM_CREDIT_PACKS,
      fx: STREAM_PACK_FX,
    });
    // Failed as a message, so a red prints every problem IN FULL, remedy included — an equality diff truncates it.
    if (problems.length > 0) expect.fail(`the FINAL tripwire:\n${problems.join("\n")}`);
    if (STREAM_PACK_PRICES_FINAL) {
      expect(checked, "one comparison per pack and per currency").toBe(STREAM_CREDIT_PACKS.length + Object.keys(STREAM_PACK_FX).length);
    } else {
      void annotate(
        "STREAM_PACK_PRICES_FINAL is false: the pack prices are placeholders and are not pinned. Flipping it to true " +
          "forces the pin: this test then fails until OWNER_FINAL_PRICES holds the owner's ruled literals.",
      );
    }
  });

  it("the tripwire itself fires: flipped with no literals, flipped with a wrong price or rate, and holds when they match", () => {
    const table = {
      packs: [
        { size: 1 as const, gbpPence: 600 },
        { size: 5 as const, gbpPence: 2500 },
      ],
      fx: { eur: 1.17, usd: 1.33 },
    };
    const exact: OwnerFinalPrices = { gbpPence: { 1: 600, 5: 2500, 20: 8000 }, fx: { eur: 1.17, usd: 1.33 } };
    const cases: [string, boolean, OwnerFinalPrices | null, RegExp[]][] = [
      ["not final: nothing is pinned", false, null, []],
      ["flipped, nothing declared: fails loudly", true, null, [/declares no owner-ruled prices/]],
      ["flipped, a pack price differs", true, { ...exact, gbpPence: { 1: 700, 5: 2500, 20: 8000 } }, [/1-pack charges 600 pence; the owner ruled 700/]],
      ["flipped, an FX rate differs", true, { ...exact, fx: { eur: 1.2, usd: 1.33 } }, [/STREAM_PACK_FX\.eur is 1\.17; the owner ruled 1\.2/]],
      ["flipped, a currency is missing from the table", true, { ...exact, fx: { eur: 1.17, usd: 1.33, inr: 111 } }, [/STREAM_PACK_FX\.inr is undefined/]],
      ["flipped, and the table matches", true, exact, []],
    ];
    let checked = 0;
    for (const [name, final, declared, want] of cases) {
      const { problems } = finalPriceProblems(final, declared, table);
      expect(problems.length, name).toBe(want.length);
      want.forEach((re, i) => expect(problems[i], name).toMatch(re));
      checked++;
    }
    expect(checked).toBe(cases.length);
  });
});
