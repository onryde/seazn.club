// The permanent guard for the platform-fee decoder. Pure — no DATABASE_URL, no
// Redis, no skipIf — so it runs in every suite on every machine. Its sibling
// `platform-settings.test.ts` proves the same rule through real Postgres and
// skips without a DB; the wave that wrote this rule had it living only in
// `e2e/helpers.ts`, which vitest excludes, so nothing ran it by default at all.
import { describe, expect, it } from "vitest";
import { decodeFeePercent } from "@/lib/platform-fee";

describe("decodeFeePercent", () => {
  it("accepts a JSON number across the whole 0..100 band", () => {
    expect(decodeFeePercent(5)).toBe(5);
    expect(decodeFeePercent(7.5)).toBe(7.5);
    // Both bounds are INCLUSIVE, and each is asserted against a neighbour that
    // is not, so a `<`/`<=` flip cannot pass by landing on the other's verdict.
    expect(decodeFeePercent(0)).toBe(0);
    expect(decodeFeePercent(-0.01)).toBeNull();
    expect(decodeFeePercent(100)).toBe(100);
    expect(decodeFeePercent(100.01)).toBeNull();
  });

  /**
   * The defect this decoder exists for, stated as its own case because the
   * value it rejects is not obviously wrong — it is a *valid, in-range* 0.
   *
   * `platform_settings.value` is jsonb (V273:57), and postgres.js hands back
   * whatever JSON.parse says. A row holding jsonb `null`, `false`, `""` or `[]`
   * therefore arrives as a JS value that `Number()` maps to a finite `0`, which
   * clears every bounds check the old code did and is served as a 0% platform
   * cut — silently overriding the PLATFORM_FEE_PERCENT/5 fallback that an
   * ABSENT row correctly reaches. Zero revenue on entry fees, no error anywhere.
   *
   * The `Number()` assertion beside each input is the positive control: it
   * proves the trap is real rather than asserting the fix against a hazard that
   * may have stopped existing. Delete the decoder and this block still shows
   * exactly why four "empty" rows all become a legitimate-looking zero.
   */
  it("rejects the jsonb shapes Number() would read as a finite, in-range 0", () => {
    for (const empty of [null, false, "", []]) {
      expect(Number(empty), `Number(${JSON.stringify(empty)}) is the hazard`).toBe(0);
      expect(
        decodeFeePercent(empty),
        `jsonb ${JSON.stringify(empty)} must fall through to the env/5 fallback, not serve 0%`,
      ).toBeNull();
    }
    // ...while a row that genuinely SAYS zero is honoured. Without this line a
    // decoder that rejected every zero would pass the loop above, and a
    // deliberate 0% promotional cut would be silently overwritten by 5%.
    expect(decodeFeePercent(0)).toBe(0);
  });

  it("rejects a numeric string — only a JSON number is a fee", () => {
    // Every legitimate writer produces a JSON number: the seed is `'5'::jsonb`
    // (V273:61) and setPlatformFeeDefault writes `sql.json(pct)`. A string in
    // this column is a hand-edit, and Number("7e3") is 7000 — guessing at a
    // hand-edit's intent is how a typo becomes a billing rate.
    expect(decodeFeePercent("7")).toBeNull();
    expect(decodeFeePercent("nonsense")).toBeNull();
  });

  it("rejects an absent row and non-finite numbers", () => {
    expect(decodeFeePercent(undefined)).toBeNull(); // `row?.value` with no row
    expect(decodeFeePercent(NaN)).toBeNull();
    expect(decodeFeePercent(Infinity)).toBeNull();
    expect(decodeFeePercent({ percent: 5 })).toBeNull();
  });
});
