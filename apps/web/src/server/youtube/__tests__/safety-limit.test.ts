// Phase 0 fix round 2: the safety read's in-process limit stays bounded — expired windows are pruned, and live ones never exceed the cap.
// Pure (no DB). Sport: not applicable.
import { afterEach, describe, expect, it } from "vitest";
import { __resetSafetyReadsForTests, __trackedSafetyReadsForTests, takeSafetyRead } from "@/server/youtube/safety-limit";

const CAP = 10_000;   // safety-limit.ts MAX_TRACKED
const LIMIT = { max: 6, windowSeconds: 60 };
afterEach(() => __resetSafetyReadsForTests());

describe("takeSafetyRead's map is bounded", () => {
  it("expired windows are pruned once the map is full; live windows never exceed the cap", () => {
    const T0 = new Date("2026-11-21T12:00:00Z");
    for (let i = 0; i < CAP; i++) takeSafetyRead(`c-${i}`, T0, LIMIT);
    expect(__trackedSafetyReadsForTests(), "PREMISE: full").toBe(CAP);
    takeSafetyRead("live-extra", T0, LIMIT);   // all live: the oldest goes
    expect(__trackedSafetyReadsForTests()).toBe(CAP);
    takeSafetyRead("later", new Date(T0.getTime() + LIMIT.windowSeconds * 1000), LIMIT);   // every earlier window has expired
    expect(__trackedSafetyReadsForTests()).toBe(1);
  });
});
