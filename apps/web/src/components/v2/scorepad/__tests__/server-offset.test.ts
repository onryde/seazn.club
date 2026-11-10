// S2-5 ruling 107: the server-time offset the pad's transport keeps, from the `Date` header of its /events calls. Every
// expected value is a literal worked from the rule (header second + 500 ms − the local midpoint; the median of the last
// five), never computed by the code under test.
import { describe, expect, it } from "vitest";
import { createServerOffset, offsetSampleOf } from "../server-offset";

const S = Date.UTC(2026, 10, 7, 12, 0, 0); // the server's whole second
const DATE = "Sat, 07 Nov 2026 12:00:00 GMT";

describe("offsetSampleOf", () => {
  it("a sample is the header's second plus 500 ms, against the local midpoint", () => {
    expect(offsetSampleOf(DATE, S - 300_100, S - 299_900)).toBe(300_500); // device 5 min slow
    expect(offsetSampleOf(DATE, S + 1_400, S + 1_600)).toBe(-1_000); // device a second fast
  });

  it("no header, a garbage header, a negative or a >5 s round trip give no sample", () => {
    expect(offsetSampleOf(null, S, S + 100)).toBeUndefined();
    expect(offsetSampleOf("soon", S, S + 100)).toBeUndefined();
    expect(offsetSampleOf("", S, S + 100)).toBeUndefined();
    expect(offsetSampleOf(DATE, S, S - 1)).toBeUndefined();
    expect(offsetSampleOf(DATE, S, S + 5_001)).toBeUndefined();
    expect(offsetSampleOf(DATE, S, S + 5_000)).toBeDefined();
    expect(offsetSampleOf(DATE, S, S)).toBe(500); // a zero round trip is a sample
  });
});

describe("createServerOffset", () => {
  it("the offset is the median of the last five, so one outlier cannot move it", () => {
    const o = createServerOffset();
    expect(o.offsetMs()).toBeNull();
    for (const s of [100, 9_000_000, 200, 300, 400]) o.add(s);
    expect(o.offsetMs()).toBe(300);
    for (const s of [500, 600, 700, 800, 900]) o.add(s); // the outlier has left the window
    expect(o.offsetMs()).toBe(700);
    const two = createServerOffset();
    two.add(1_000);
    two.add(3_000);
    expect(two.offsetMs()).toBe(2_000);
  });

  it("one sample is the offset; an even count rounds the mean of the middle two", () => {
    const o = createServerOffset();
    o.add(-250);
    expect(o.offsetMs()).toBe(-250);
    o.add(0);
    o.add(20);
    o.add(10);
    expect(o.offsetMs()).toBe(5); // sorted −250, 0, 10, 20: the middle two 0 and 10 → 5
    const half = createServerOffset();
    half.add(1);
    half.add(2);
    expect(half.offsetMs()).toBe(2); // 1.5 rounds to 2
  });

  it("the window is exactly five: a sixth sample pushes the oldest out", () => {
    const o = createServerOffset();
    for (const s of [1_000, 1_000, 1_000, 0, 0]) o.add(s);
    expect(o.offsetMs()).toBe(1_000);
    o.add(0); // the first 1 000 leaves: [1 000, 1 000, 0, 0, 0]
    expect(o.offsetMs()).toBe(0);
  });
});
