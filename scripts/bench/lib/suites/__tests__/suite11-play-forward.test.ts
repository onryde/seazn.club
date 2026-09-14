// B07a T7 fix round 1 — I1, mutant M-c: does `runSuite11` forward its own
// `play` parameter into `runPackSuite`'s options, the way `runTinySuite`
// does (proven end to end, against a real fake HTTP transport driving a real
// tap refusal, in `tiny-suite-simulate.test.ts`'s "a registry row's `play`
// reaches the dispatch" block)?
//
// No fake HTTP transport exists for suite11's real pack (`suite11.json`,
// "PDC Worlds") — building one from scratch, to the depth needed to reach a
// live tap refusal, is a substantial undertaking of its own (the fake in
// `tiny-suite-simulate.test.ts` answers ~20 different route families) and is
// out of scope for a two-finding fix round. This test instead mocks
// `run-suite.ts`'s `runPackSuite` and asserts the exact options object
// `runSuite11` builds for it. That proves the one-line forwarding change
// (mutant M-c) is present — it does NOT prove a declared `play` reaches the
// live dispatch inside `runPackSuite` the way the `_tiny` tests prove for
// `runTinySuite`. Recorded as a scope gap in the fix-round-1 report, not
// claimed as full coverage.
import { beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";

const seen: { opts?: unknown; called: number } = { called: 0 };

vi.mock("../run-suite.ts", () => ({
  runPackSuite: vi.fn(async (_input: unknown, opts: unknown) => {
    seen.called += 1;
    seen.opts = opts;
    return { key: "suite11", gate: "green", steps: [] };
  }),
}));

const { runSuite11, SUITE11_PACK_PATH } = await import("../suite11.ts");

const silent = pino({ level: "silent" });

const minimalInput = {
  base: "http://bench.example",
  engine: "optimized" as const,
  keep: false,
  log: silent,
};

describe("runSuite11 forwards its `play` parameter into runPackSuite's options (B07a T7 fix round 1, mutant M-c)", () => {
  beforeEach(() => {
    seen.called = 0;
    seen.opts = undefined;
  });

  it("forwards a declared play map", async () => {
    await runSuite11(minimalInput, { "d-worlds": "tap" });

    expect(seen.called).toBe(1);
    expect(seen.opts).toMatchObject({
      suiteKey: "suite11",
      packPath: SUITE11_PACK_PATH,
      play: { "d-worlds": "tap" },
    });
  });

  // The negative half. Without it, a forward hardcoded to always attach some
  // literal `play` value would satisfy the case above while changing the
  // meaning of every call that declares none.
  it("omits `play` entirely (never `play: undefined`) when the caller declares none", async () => {
    await runSuite11(minimalInput);

    expect(seen.called).toBe(1);
    expect(seen.opts).not.toHaveProperty("play");
  });
});
