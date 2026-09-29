// Parked (b), Task 14 re-review 3 N2: the key-sorted JSON both checkout idempotency keys hash was two private copies
// (lib/relay-checkout.ts, lib/credit-packs.ts) — two derivations meant to follow one rule, free to drift apart. One
// helper now. The expected strings are written out here, never produced by the helper under test.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../canonical-json";

describe("canonicalJson", () => {
  it("sorts object keys at every depth, keeps array order, and is equal for equal values built in any order", () => {
    const cases: [unknown, string][] = [
      [{ b: 1, a: 2 }, '{"a":2,"b":1}'],
      [{ z: { y: 1, x: [3, { d: 1, c: 2 }] }, a: null }, '{"a":null,"z":{"x":[3,{"c":2,"d":1}],"y":1}}'],
      [[{ b: 1, a: 1 }, 2, "s"], '[{"a":1,"b":1},2,"s"]'],
      ["plain", '"plain"'],
      [42, "42"],
      [null, "null"],
      [{}, "{}"],
      [[], "[]"],
      // JSON.stringify's own rules still hold: an undefined member is dropped, not written.
      [{ b: undefined, a: 1 }, '{"a":1}'],
    ];
    let checked = 0;
    for (const [value, want] of cases) {
      expect(canonicalJson(value), JSON.stringify(value)).toBe(want);
      checked++;
    }
    expect(checked).toBe(cases.length);
    // Insertion order is exactly what it must not see.
    expect(canonicalJson({ a: 1, b: { d: 1, c: 2 } })).toBe(canonicalJson({ b: { c: 2, d: 1 }, a: 1 }));
    // …while array order is data, and must.
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("is the ONE copy: both checkout idempotency keys import it and neither defines its own", () => {
    let checked = 0;
    for (const file of ["relay-checkout.ts", "credit-packs.ts"]) {
      const src = readFileSync(join(__dirname, "..", file), "utf8");
      expect(src, `${file} imports the shared helper`).toMatch(/import \{ canonicalJson \} from "@\/lib\/canonical-json";/);
      expect(src, `${file} keeps a private copy`).not.toMatch(/function canonicalJson\b/);
      checked++;
    }
    expect(checked).toBe(2);
  });
});
