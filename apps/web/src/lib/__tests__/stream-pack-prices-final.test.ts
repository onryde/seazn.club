// Lane-close re-review M-3 (the m10 residual): the match-credit pack prices are not yet cleared for LIVE Stripe while
// `STREAM_PACK_PRICES_FINAL` is false (lib/stream-credit-packs.ts). Until then the table (a GBP base and one typed
// amount per other currency, per pack) is the code's own. The day the owner calls the prices final, the flag flips, and
// from then on the table is money the owner ruled: it must equal owner literals DECLARED HERE, never read back from
// the module under test.
//
// This is the tripwire. While the flag is false it passes and says why. Flip the flag without filling
// `OWNER_FINAL_PRICES` below and it fails loudly, naming what to add; fill it with anything but the table and it fails
// naming each difference.
import { describe, expect, it } from "vitest";
import {
  STREAM_CREDIT_PACKS,
  STREAM_PACK_OPTION_CURRENCIES,
  STREAM_PACK_PRICES_FINAL,
  type StreamPackSize,
} from "../stream-credit-packs";

/** The owner-ruled price of each pack in every currency it is sold in, in that currency's minor unit (`gbp` included). */
type OwnerFinalPrices = Readonly<Record<StreamPackSize, Readonly<Record<string, number>>>>;

/**
 * THE OWNER'S FINAL PRICES. `null` until the owner calls them final. When you flip `STREAM_PACK_PRICES_FINAL` to true,
 * write the ruled values here AS LITERALS, in the same change. Do not copy them from `stream-credit-packs.ts`: typing
 * them from the ruling is the whole check.
 */
const OWNER_FINAL_PRICES: OwnerFinalPrices | null = null;

interface TablePack {
  size: StreamPackSize;
  gbpPence: number;
  options: Readonly<Record<string, number>>;
}

/** Every problem with the table, given the flag and the declared literals. Empty means the tripwire holds. `checked`
 *  counts the comparisons made, so a flipped flag that compared nothing cannot pass. */
function finalPriceProblems(
  final: boolean,
  declared: OwnerFinalPrices | null,
  packs: readonly TablePack[],
): { problems: string[]; checked: number } {
  if (!final) return { problems: [], checked: 0 };
  if (declared === null) {
    return {
      problems: [
        "STREAM_PACK_PRICES_FINAL is true, but stream-pack-prices-final.test.ts declares no owner-ruled prices: " +
          "write the ruled amount per pack and per currency into OWNER_FINAL_PRICES, as literals from the ruling",
      ],
      checked: 0,
    };
  }
  const problems: string[] = [];
  let checked = 0;
  for (const pack of packs) {
    const table: Record<string, number> = { gbp: pack.gbpPence, ...pack.options };
    const want = declared[pack.size] ?? {};
    for (const code of new Set([...Object.keys(table), ...Object.keys(want)])) {
      if (table[code] !== want[code]) {
        problems.push(`the ${pack.size}-pack charges ${table[code]} in ${code}; the owner ruled ${want[code]}`);
      }
      checked++;
    }
  }
  if (checked === 0) problems.push("the tripwire compared nothing");
  return { problems, checked };
}

describe("match-credit pack prices: the FINAL tripwire (M-3)", () => {
  it("the live table: passes while the prices are not final; once final, equals the owner's declared literals", ({ annotate }) => {
    const { problems, checked } = finalPriceProblems(STREAM_PACK_PRICES_FINAL, OWNER_FINAL_PRICES, STREAM_CREDIT_PACKS);
    // Failed as a message, so a red prints every problem IN FULL, remedy included — an equality diff truncates it.
    if (problems.length > 0) expect.fail(`the FINAL tripwire:\n${problems.join("\n")}`);
    if (STREAM_PACK_PRICES_FINAL) {
      expect(checked, "one comparison per pack and per currency").toBe(
        STREAM_CREDIT_PACKS.length * (1 + STREAM_PACK_OPTION_CURRENCIES.length),
      );
    } else {
      void annotate(
        "STREAM_PACK_PRICES_FINAL is false: the pack prices are not cleared for live Stripe and are not pinned here. " +
          "Flipping it to true forces the pin: this test then fails until OWNER_FINAL_PRICES holds the owner's ruled literals.",
      );
    }
  });

  it("the tripwire itself fires: flipped with no literals, flipped with a wrong or missing amount, and holds when they match", () => {
    const packs: TablePack[] = [
      { size: 1, gbpPence: 300, options: { eur: 350, usd: 399 } },
      { size: 5, gbpPence: 1200, options: { eur: 1400, usd: 1500 } },
    ];
    const exact = {
      1: { gbp: 300, eur: 350, usd: 399 },
      5: { gbp: 1200, eur: 1400, usd: 1500 },
      20: { gbp: 4000, eur: 4500, usd: 4900 },
    } satisfies OwnerFinalPrices;
    const cases: [string, boolean, OwnerFinalPrices | null, RegExp[]][] = [
      ["not final: nothing is pinned", false, null, []],
      ["flipped, nothing declared: fails loudly", true, null, [/declares no owner-ruled prices/]],
      ["flipped, a base price differs", true, { ...exact, 1: { ...exact[1], gbp: 400 } }, [/1-pack charges 300 in gbp; the owner ruled 400/]],
      ["flipped, another currency's amount differs", true, { ...exact, 5: { ...exact[5], eur: 1500 } }, [/5-pack charges 1400 in eur; the owner ruled 1500/]],
      ["flipped, a currency the ruling names is missing from the table", true, { ...exact, 1: { ...exact[1], inr: 19900 } }, [/1-pack charges undefined in inr; the owner ruled 19900/]],
      ["flipped, and the table matches", true, exact, []],
    ];
    let checked = 0;
    for (const [name, final, declared, want] of cases) {
      const { problems } = finalPriceProblems(final, declared, packs);
      expect(problems.length, name).toBe(want.length);
      want.forEach((re, i) => expect(problems[i], name).toMatch(re));
      checked++;
    }
    expect(checked).toBe(cases.length);
  });
});
