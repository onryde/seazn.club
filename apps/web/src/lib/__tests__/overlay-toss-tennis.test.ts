// S2-7 (TN-TS-1) — `tennisTossOf`: the fold's `opener` belongs to the shared nested kernel, so it is read as a TENNIS toss
// only while the void-resolved stream still holds a `tennis.toss`. The end-to-end fold (real toss, voided toss) is swept
// by `server/overlay/__tests__/toss-warming-line.test.ts`; this pins the gate itself, both directions.
import { describe, expect, it } from "vitest";
import { overlayTossOf, tennisTossOf } from "../overlay-toss";

const TOSS = [{ type: "tennis.toss" }, { type: "core.start" }];

describe("tennisTossOf", () => {
  it("reads the side off the fold's opener when a tennis.toss survives", () => {
    expect(tennisTossOf({ opener: "away" }, TOSS)).toEqual({ servesFirstSide: 1 });
    expect(tennisTossOf({ opener: "home" }, TOSS)).toEqual({ servesFirstSide: 0 });
  });

  it("an opener with no tennis.toss in the stream is not a toss (another sport's kernel, or a voided toss)", () => {
    expect(tennisTossOf({ opener: "away" }, [{ type: "core.start" }])).toBeNull();
    expect(tennisTossOf({ opener: "home" }, [])).toBeNull();
  });

  it("a toss in the stream with no readable opener answers null, never a guessed side", () => {
    expect(tennisTossOf({}, TOSS)).toBeNull();
    expect(tennisTossOf(null, TOSS)).toBeNull();
    expect(tennisTossOf({ opener: "left" }, TOSS)).toBeNull();
  });

  it("overlayTossOf picks the tennis arm from its own field", () => {
    expect(overlayTossOf({ tennisToss: { servesFirstSide: 1 } })).toEqual({ sport: "tennis", toss: { servesFirstSide: 1 } });
    expect(overlayTossOf({ tennisToss: null })).toBeNull();
  });
});
