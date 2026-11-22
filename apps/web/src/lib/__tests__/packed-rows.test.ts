// W5 follow-ups B3/B4: `packRows` / `unpackRows` (lib/packed-rows.ts) carry the public schedule's fixtures and the hub's
// matches to the browser as columns. They must be LOSSLESS for what the wire carries - the same rows, keys and values, in
// the same row order - for any rows, which is a property, so it is checked over generated rows (fast-check) as well as the
// shapes that matter: nulls beside absent keys, a key only some rows carry, nested values, the empty list and rows with no
// key at all. The comparison is against the rows' own JSON, the thing both wires (unstable_cache, the RSC flight) keep.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { packRows, unpackRows } from "../packed-rows";

const wire = (x: unknown) => JSON.parse(JSON.stringify(x));

describe("packRows / unpackRows", () => {
  it("round-trips generated rows exactly as JSON carries them (property, 300 runs)", () => {
    const value = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.boolean(),
      fc.integer(),
      fc.constantFrom("a", "b", "live", "decided", ""),
      fc.string(),
      fc.record({ kind: fc.constantFrom("win", "draw"), sets: fc.array(fc.integer(), { maxLength: 3 }) }),
      fc.array(fc.string(), { maxLength: 3 }),
    );
    const row = fc.dictionary(fc.constantFrom("id", "status", "home", "away", "summary", "round", "x"), value, { maxKeys: 7 });
    let runs = 0;
    fc.assert(
      fc.property(fc.array(row, { maxLength: 40 }), (rows) => {
        runs += 1;
        expect(wire(unpackRows(wire(packRows(rows))))).toEqual(wire(rows));
      }),
      { numRuns: 300 },
    );
    expect(runs, "anti-vacuity: the property ran").toBe(300);
  });

  it("keeps null apart from absent, a key only some rows carry, nested values by value, and row order", () => {
    const rows = [
      { id: "f1", status: "decided", pool: null, summary: { headline: "2-0" } },
      { id: "f2", status: "decided", pool: "A" },
      { id: "f3", status: "scheduled", pool: null, late: true },
      { id: "f4", status: "decided", pool: "A" },
    ];
    const back = unpackRows(wire(packRows(rows)));
    expect(back).toEqual(rows);
    expect(Object.hasOwn(back[1]!, "summary"), "absent stays absent").toBe(false);
    expect(back[0]!.pool, "null stays null").toBeNull();
    expect(back.map((r) => r.id)).toEqual(["f1", "f2", "f3", "f4"]);
  });

  it("a repeating string column is a dictionary and a column of unique strings is not; the packed rows are smaller", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: `fixture-${i}-${"x".repeat(30)}`, status: i % 3 === 0 ? "decided" : "scheduled", tz: "Europe/London" }));
    const packed = packRows(rows);
    const byKey = new Map(packed.c.map((c) => [c.k, c]));
    expect("d" in byKey.get("status")!, "status: a dictionary").toBe(true);
    expect("d" in byKey.get("id")!, "unique ids: raw").toBe(false);
    expect(JSON.stringify(packed).length).toBeLessThan(JSON.stringify(rows).length * 0.75);
  });

  it("the empty cases: no rows, and rows with no key at all, keep their length", () => {
    expect(unpackRows(packRows([]))).toEqual([]);
    expect(unpackRows(wire(packRows([{}, {}, {}])))).toEqual([{}, {}, {}]);
  });
});
