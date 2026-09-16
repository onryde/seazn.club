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
//
// B07a T7 fix round 2 — I1(b)/(c): the round-1 tests above proved
// `runSuite11` itself forwards `play`, but nothing drove `bench.ts`'s own
// `runSuite` or the REAL registry row's `run: runSuite11` binding — both
// M1 (`bench.ts:209`'s forwarding line reverted) and M3 (the row's `run`
// replaced by a wrapper that drops `play`) survived a mutation re-review
// unnoticed. The second describe block below closes that: it mocks
// `../registry.ts` (keeping the row's REAL `run` binding, injecting only
// `play`) ALONGSIDE the `run-suite.ts` mock above, then drives the REAL
// exported `runSuite("suite11", ...)` from `bench.ts` and asserts the
// options that reach the (still-mocked) `runPackSuite` carry the injected
// `play`. `run-suite.ts` staying mocked here is why this test proves the
// FORWARDING chain (`runSuite` -> the seam -> the row's real `run` ->
// `runPackSuite`'s options) rather than a live dispatch — see this file's
// own header for why no live suite11 dispatch test exists.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";

const seen: { opts?: unknown; called: number } = { called: 0 };

vi.mock("../run-suite.ts", () => ({
  runPackSuite: vi.fn(async (_input: unknown, opts: unknown) => {
    seen.called += 1;
    seen.opts = opts;
    return { key: "suite11", gate: "green", steps: [] };
  }),
}));

// Mocks ONLY `lookupSuite`, injecting `play` onto the REAL `suite11` row
// returned by `importOriginal()` — the spread (`{ ...real, play: {...} }`)
// keeps that row's own `run: runSuite11` binding untouched, so it is the
// REAL forwarding code that runs when `bench.ts`'s `runSuite("suite11", ...)`
// resolves it (not a test-built fixture). `importOriginal()` resolves
// `registry.ts`'s own imports (`tiny.ts`/`suite11.ts`) through the SAME
// module registry as the `run-suite.ts` mock above, so the real
// `runSuite11`/`runTinySuite` bindings it returns both route into the
// mocked `runPackSuite` too — exactly what this file needs.
//
// R34(c) (fix round 3) — OPT-IN, same as `tiny-suite-simulate.test.ts`'s own
// registry mock: read at call time from `injectedPlay`, unset by default and
// reset `afterEach`. Before this, EVERY `"suite11"` lookup in this file
// carried `play: { "d-worlds": "tap" }` — harmless today (only the one test
// below ever calls `runSuite("suite11", ...)`), but a latent trap for any
// future test here that expects a normal `suite11` run.
let injectedPlay: Record<string, "tap" | "api" | "import"> | undefined;

vi.mock("../registry.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../registry.ts")>();
  return {
    ...actual,
    lookupSuite: (key: string) => {
      const real = actual.lookupSuite(key);
      if (real === undefined) return real;
      if (key === "suite11" && injectedPlay !== undefined) {
        return { ...real, play: injectedPlay };
      }
      return real;
    },
  };
});

afterEach(() => {
  injectedPlay = undefined;
});

const { runSuite11, SUITE11_PACK_PATH } = await import("../suite11.ts");
const { parseCliArgs, runSuite } = await import("../../../bench.ts");

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

describe("bench.ts's REAL runSuite drives the REAL `suite11` registry row (B07a T7 fix round 2, I1(b)/(c))", () => {
  beforeEach(() => {
    seen.called = 0;
    seen.opts = undefined;
  });

  it("the row's own `play` (injected by the registry mock above) reaches runPackSuite's options", async () => {
    // Opt-in (R34(c)): set here, reset `afterEach` above.
    injectedPlay = { "d-worlds": "tap" };
    // No `--suite` needed — `runSuite`'s `key` argument is independent of
    // `config.suites`. `sql` is a bare stub: `runPackSuite` itself is
    // mocked, so nothing ever reads it for real.
    const config = parseCliArgs(["--base", "http://bench.example", "--wipe"]);
    const stubSql = {} as Parameters<typeof runSuite>[3];

    const report = await runSuite("suite11", config, "fix-round-2-i1bc-suite11", stubSql);

    expect(report).toEqual({ key: "suite11", gate: "green", steps: [] });
    expect(seen.called).toBe(1);
    expect(seen.opts).toMatchObject({
      suiteKey: "suite11",
      packPath: SUITE11_PACK_PATH,
      play: { "d-worlds": "tap" },
    });
  });

  // ---------------------------------------------------------------------------
  // Minors row 29 (task-7-re-review.md:343 m4). `injectedPlay` (`:62`) is
  // read by the `registry.ts` mock (`:64-77`) AT CALL TIME, and the ONLY
  // thing that stops the test above from leaking its `{"d-worlds":"tap"}`
  // into every OTHER `runSuite("suite11", ...)` call for the rest of this
  // file's run is the top-level `afterEach` (`:79-81`). The REAL `suite11`
  // registry row declares NO `play` at all (`registry.ts:21-25`, unlike
  // `_tiny`'s row), so a leaked injection is directly visible on `seen.opts`
  // rather than coinciding with a real declared value.
  //
  // Runs deliberately AFTER the injecting test, in the same file, same
  // module — vitest executes a file's tests top to bottom by default, which
  // is the ordering this guards. Deleting the `afterEach` leaves this red.
  // ---------------------------------------------------------------------------
  it("a later run through the SAME registry row carries no injected play once the mock resets (guards the afterEach, row 29)", async () => {
    const config = parseCliArgs(["--base", "http://bench.example", "--wipe"]);
    const stubSql = {} as Parameters<typeof runSuite>[3];

    await runSuite("suite11", config, "fix-round-2-i1bc-suite11-guard", stubSql);

    expect(seen.called).toBe(1);
    expect(seen.opts).not.toHaveProperty("play");
  });
});
