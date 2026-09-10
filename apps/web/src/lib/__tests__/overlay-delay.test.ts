// Task 5d — the `?delay=` parse table. Pins what EACH input class RESOLVES
// TO (AGENTS.md rule: "a reachability test is satisfied by any value"), not
// merely that `resolveDelayMs` accepts it without throwing. `?delay=5000`/
// `?delay=2500.9` are the required "right answer differs from the wrong
// one's constant" witnesses — every OTHER row resolves to `DEFAULT_DELAY_MS`
// (0), so a mutant that always returns 0 would pass every row except those
// two.
import { describe, expect, it } from "vitest";
import { DEFAULT_DELAY_MS, DELAY_MAX_MS, resolveDelayMs } from "../overlay-delay";

describe("resolveDelayMs — the full parse table (Task 5d)", () => {
  it("absent (undefined) resolves to the default", () => {
    expect(resolveDelayMs(undefined)).toBe(DEFAULT_DELAY_MS);
  });

  it("empty (?delay=) resolves to the default", () => {
    expect(resolveDelayMs("")).toBe(DEFAULT_DELAY_MS);
  });

  it("whitespace-only resolves to the default", () => {
    expect(resolveDelayMs("   ")).toBe(DEFAULT_DELAY_MS);
  });

  it("zero resolves to zero", () => {
    expect(resolveDelayMs("0")).toBe(0);
  });

  it("negative resolves to the default, never a negative delayMs", () => {
    expect(resolveDelayMs("-500")).toBe(DEFAULT_DELAY_MS);
  });

  it('the literal string "NaN" resolves to the default', () => {
    expect(resolveDelayMs("NaN")).toBe(DEFAULT_DELAY_MS);
  });

  it("non-numeric junk resolves to the default", () => {
    expect(resolveDelayMs("banana")).toBe(DEFAULT_DELAY_MS);
  });

  it("trailing junk after a numeric prefix resolves to the default (Number(), not parseFloat)", () => {
    expect(resolveDelayMs("5000abc")).toBe(DEFAULT_DELAY_MS);
  });

  it("an absurd value past the bound resolves to the default, never the raw value", () => {
    expect(resolveDelayMs("99999999")).toBe(DEFAULT_DELAY_MS);
  });

  it("fractional truncates toward zero — the non-zero witness (right answer 2500, wrong constant 0)", () => {
    expect(resolveDelayMs("2500.9")).toBe(2500);
  });

  it("a plain valid delay passes through unchanged — the second non-zero witness", () => {
    expect(resolveDelayMs("5000")).toBe(5000);
  });

  it("exactly at the bound is still accepted (inclusive)", () => {
    expect(resolveDelayMs(String(DELAY_MAX_MS))).toBe(DELAY_MAX_MS);
  });

  it("one millisecond past the bound falls back to the default", () => {
    expect(resolveDelayMs(String(DELAY_MAX_MS + 1))).toBe(DEFAULT_DELAY_MS);
  });
});
