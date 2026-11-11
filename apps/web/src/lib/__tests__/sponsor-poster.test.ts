// Title sponsor poster, Task 3: the pure rules behind the poster panel and the editor's crop warning.
// Spec: docs/superpowers/specs/2026-11-11-title-sponsor-hero-poster-design.md §7.6 (rotation) and §11 (crop geometry).
//
// Sport-agnostic: nothing here reads a sport, so there is no sport sweep (one reason, stated once).
//
// Expected values come from the SPEC, never from the functions under test: the §11 geometry table below is typed from the
// document, the property test carries a second implementation written from §11's own formula (a lost FRACTION, not the
// integer predicates the code uses), and the rotation table is §7.6's sentence ("true only when count >= 2, reduced motion is
// off, not paused, not stopped") enumerated over every input combination. Every sweep reports how many items it checked, and
// zero checked is a FAILURE (TEST-STRATEGY: anti-vacuity).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  POSTER_HEIGHT,
  POSTER_WIDTH,
  TITLE_ROTATE_MS,
  autoRotates,
  nextSlide,
  posterCrop,
  type RotationState,
} from "../sponsor-poster";

// ---- spec §11: the geometry table [w, h, side, percent, warn] ------------------------------------------------------------
const TABLE = [
  [1080, 1350, null, 0, false],
  [1080, 1080, "width", 20, false],
  [1600, 1500, "width", 25, false], // the 25 % boundary on the width: no warning
  [1601, 1500, "width", 26, true],
  [1920, 1080, "width", 55, true],
  [1080, 1800, "height", 25, false], // the 25 % boundary on the height: no warning
  [1080, 1801, "height", 26, true],
  [1080, 1920, "height", 30, true],
] as const;

describe("the declared constants (spec §2 G1, §7.6)", () => {
  it("the poster is 1080 x 1350 (4:5) and the rotation is 6 s", () => {
    expect(POSTER_WIDTH).toBe(1080);
    expect(POSTER_HEIGHT).toBe(1350);
    expect(POSTER_WIDTH * 5).toBe(POSTER_HEIGHT * 4); // 4:5 exactly, so the recommended size loses nothing
    expect(TITLE_ROTATE_MS).toBe(6000);
  });
});

describe("posterCrop: spec §11", () => {
  it("matches the spec's geometry table, both 25 % boundaries included (count reported)", () => {
    let checked = 0;
    for (const [w, h, side, percent, warn] of TABLE) {
      expect(posterCrop(w, h), `${w} x ${h}`).toEqual({ side, percent, warn });
      checked++;
    }
    expect(checked).toBe(8);
    expect(checked).toBe(TABLE.length);
  });

  it("an exact 4:5 at any size loses nothing (540 x 675, 1080 x 1350, 2160 x 2700)", () => {
    let checked = 0;
    for (const [w, h] of [[540, 675], [1080, 1350], [2160, 2700]] as const) {
      expect(posterCrop(w, h), `${w} x ${h}`).toEqual({ side: null, percent: 0, warn: false });
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("unknown dimensions answer null and never throw (0, -1, NaN and both infinities on either side)", () => {
    const BAD = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    let checked = 0;
    for (const bad of BAD) {
      expect(() => posterCrop(bad, 1350), `width ${bad}`).not.toThrow();
      expect(posterCrop(bad, 1350), `width ${bad}`).toBeNull();
      expect(posterCrop(1080, bad), `height ${bad}`).toBeNull();
      checked += 2;
    }
    expect(posterCrop(0, 0), "both unknown").toBeNull();
    expect(checked).toBe(BAD.length * 2);
    expect(checked).toBe(10);
  });

  it("the twin of the unknown case: the smallest real picture is known, so it answers an object", () => {
    expect(posterCrop(1, 1)).not.toBeNull();
    expect(posterCrop(1, 1)).toEqual({ side: "width", percent: 20, warn: false }); // 5w=5 > 4h=4: 1/5 of the width
  });

  it("the 25 % boundary holds at every scale, on both sides (count reported)", () => {
    // Width side: 15w = 16h is exactly 25 % lost, so w = 16k, h = 15k never warns and one more pixel of width always does.
    // Height side: 3h = 5w is exactly 25 % lost, so h = 5m, w = 3m never warns and one more pixel of height always does.
    let checked = 0;
    for (let k = 1; k <= 300; k++) {
      expect(posterCrop(16 * k, 15 * k), `width edge k=${k}`).toEqual({ side: "width", percent: 25, warn: false });
      expect(posterCrop(16 * k + 1, 15 * k), `width edge + 1, k=${k}`)!.toMatchObject({ side: "width", warn: true });
      expect(posterCrop(3 * k, 5 * k), `height edge k=${k}`).toEqual({ side: "height", percent: 25, warn: false });
      expect(posterCrop(3 * k, 5 * k + 1), `height edge + 1, k=${k}`)!.toMatchObject({ side: "height", warn: true });
      checked += 4;
    }
    expect(checked).toBe(1200);
  });

  it("property: warn <=> percent > 25, and both agree with an independent reading of §11's lost fraction, over 1..5000 x 1..5000 (numRuns reported)", () => {
    const NUM_RUNS = 2000;
    let ran = 0;
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5000 }), fc.integer({ min: 1, max: 5000 }), (w, h) => {
        ran++;
        const crop = posterCrop(w, h)!;
        expect(crop, `${w} x ${h}`).not.toBeNull();
        // The spec's formula as a FRACTION num/den (§11), with an integer ceil: not the code's 15w > 16h predicates.
        const width = 5 * w > 4 * h;
        const height = 5 * w < 4 * h;
        const num = width ? 5 * w - 4 * h : height ? 4 * h - 5 * w : 0;
        const den = width ? 5 * w : 4 * h;
        const percent = Math.floor((100 * num + den - 1) / den);
        expect(crop.side, `${w} x ${h} side`).toBe(width ? "width" : height ? "height" : null);
        expect(crop.percent, `${w} x ${h} percent`).toBe(percent);
        expect(crop.warn, `${w} x ${h} warn <=> more than 25 % lost`).toBe(4 * num > den);
        expect(crop.warn, `${w} x ${h} warn <=> percent > 25`).toBe(crop.percent > 25);
      }),
      { numRuns: NUM_RUNS },
    );
    expect(ran, "anti-vacuity: the property ran").toBe(NUM_RUNS);
  });
});

describe("autoRotates: spec §7.6", () => {
  const base: RotationState = { count: 2, reducedMotion: false, paused: false, stopped: false };

  it("EMPTY FIRST: no slides never rotate, nor does one", () => {
    expect(autoRotates({ ...base, count: 0 })).toBe(false);
    expect(autoRotates({ ...base, count: 1 })).toBe(false);
  });

  it("then the full table (count 0..3 x reduced x paused x stopped = 32 rows) rotates on exactly two rows: count 2 and 3, everything else off", () => {
    const rotating: RotationState[] = [];
    let rows = 0;
    for (const count of [0, 1, 2, 3]) {
      for (const reducedMotion of [false, true]) {
        for (const paused of [false, true]) {
          for (const stopped of [false, true]) {
            const row = { count, reducedMotion, paused, stopped };
            rows++;
            if (autoRotates(row)) rotating.push(row);
          }
        }
      }
    }
    expect(rows).toBe(32);
    // §7.6: true only when count >= 2, reduced motion is off, the showcase is not paused and the rotation has not been stopped.
    expect(rotating).toEqual([
      { count: 2, reducedMotion: false, paused: false, stopped: false },
      { count: 3, reducedMotion: false, paused: false, stopped: false },
    ]);
  });

  it("each blocker alone stops a rotation that would otherwise run (reduced motion, paused, stopped), and a larger count still rotates", () => {
    expect(autoRotates(base), "premise: the base row rotates").toBe(true);
    let checked = 0;
    for (const blocker of ["reducedMotion", "paused", "stopped"] as const) {
      expect(autoRotates({ ...base, [blocker]: true }), blocker).toBe(false);
      checked++;
    }
    expect(checked).toBe(3);
    expect(autoRotates({ ...base, count: 50 })).toBe(true);
  });
});

describe("nextSlide", () => {
  it("advances and wraps: (0,3) -> 1, (2,3) -> 0, (0,1) -> 0", () => {
    expect(nextSlide(0, 3)).toBe(1);
    expect(nextSlide(1, 3)).toBe(2);
    expect(nextSlide(2, 3)).toBe(0);
    expect(nextSlide(0, 1)).toBe(0);
  });

  it("a full cycle visits every slide once and returns to the start, for 1..6 slides (count reported)", () => {
    let checked = 0;
    for (let count = 1; count <= 6; count++) {
      const seen: number[] = [];
      let i = 0;
      for (let step = 0; step < count; step++) {
        seen.push(i);
        i = nextSlide(i, count);
        checked++;
      }
      expect(i, `${count} slides: back at the start`).toBe(0);
      expect(seen, `${count} slides: each once, in order`).toEqual(Array.from({ length: count }, (_, n) => n));
    }
    expect(checked).toBe(1 + 2 + 3 + 4 + 5 + 6);
  });

  it("no slides is refused by name, not answered with NaN: count 0, a negative count and NaN throw RangeError('no slides')", () => {
    let checked = 0;
    for (const count of [0, -1, -3, Number.NaN]) {
      expect(() => nextSlide(0, count), `count ${count}`).toThrow(RangeError);
      expect(() => nextSlide(0, count), `count ${count}`).toThrow("no slides");
      checked++;
    }
    expect(checked).toBe(4);
  });
});
