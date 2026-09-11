// B06a Task 2 — the pipeline is a SHARED runner, not `_tiny`'s own function.
//
// The move it came from (tiny.ts -> run-suite.ts) is behaviour-preserving, so
// every existing tiny-suite test passing proves nothing about the thing the
// move exists for: that a SECOND suite can drive the same pipeline and be
// reported under its own name. These tests drive `runPackSuite` directly with
// a key that is not `_tiny`, which is the only way to catch a suite key that
// was moved but left hardcoded somewhere downstream.
//
// They deliberately stop at stage 0 (a pack path that cannot load), because
// that path needs no transport, no SQL and no server, and it is already past
// the two places the key is written: the log line and the returned report.
import { describe, expect, it } from "vitest";
import pino from "pino";
import { formatAdaptation, runPackSuite } from "../run-suite.ts";
import { TINY_PACK_PATH } from "../tiny.ts";

const silent = pino({ level: "silent" });

function input(overrides: Record<string, unknown> = {}) {
  return {
    base: "http://bench.example",
    engine: "optimized" as const,
    keep: false,
    log: silent,
    ...overrides,
  } as Parameters<typeof runPackSuite>[0];
}

describe("runPackSuite is suite-agnostic", () => {
  it("reports under the key it was given, not under _tiny", async () => {
    const report = await runPackSuite(input(), {
      suiteKey: "_probe",
      packPath: "/nonexistent/pack-that-cannot-load.json",
    });
    expect(report.suite).toBe("_probe");
    expect(report.gate).toBe("red");
  });

  it("falls back to the definition's pack when the input names none", async () => {
    // `input.packPath` absent ⇒ the pack comes from the suite definition. This
    // used to default to `TINY_PACK_PATH` inside the runner, so a suite that
    // forgot to pass one folded the proof pack while reporting its own name.
    const report = await runPackSuite(input(), {
      suiteKey: "_probe",
      packPath: "/nonexistent/definition-pack.json",
    });
    expect(report.gate).toBe("red");
    expect((report.errors ?? []).join(" ")).toMatch(/pack:/);
  });

  it("formats an adaptation with what, why AND its where locator", () => {
    // B07a T3 fix round 1. Both required fields and the optional locator, in
    // one asserted string rather than three `toContain`s — a swapped pair or
    // a dropped separator lands on a wrong whole line, which is the point.
    expect(
      formatAdaptation({
        what: "team and doubles events dropped",
        why: "the product models no team tie",
        where: "divisions[1].stages[0]",
      }),
    ).toBe(
      "team and doubles events dropped — WHY: the product models no team tie [divisions[1].stages[0]]",
    );
  });

  it("omits the bracket entirely for an adaptation that declares no where", () => {
    // The branch this test exists for. `where` is OPTIONAL in the schema, and
    // NEITHER shipped pack leaves it out — `_tiny` declares it on all 15 rows
    // and `suite11` on all 13 — so no pack in the tree witnesses this side.
    // Delete the `=== undefined` guard and every report silently grows a
    // literal "[undefined]"; nothing else in the suite would notice.
    const line = formatAdaptation({
      what: "no leaderboards for three-dart average",
      why: "not representable by the generic module at any fidelity tier",
    });
    expect(line).toBe(
      "no leaderboards for three-dart average — WHY: not representable by the generic module at any fidelity tier",
    );
    expect(line).not.toContain("[");
    expect(line).not.toContain("undefined");
  });

  it("an explicit input packPath still wins over the definition's", async () => {
    // The real pack loads, so stage 0 does NOT refuse — proving the override
    // reached the loader rather than being ignored. The run then fails later,
    // against a base that does not exist, which is not what this asserts.
    const report = await runPackSuite(input({ packPath: TINY_PACK_PATH }), {
      suiteKey: "_probe",
      packPath: "/nonexistent/definition-pack.json",
    });
    expect((report.errors ?? []).join(" ")).not.toMatch(/pack: /);
    expect(report.suite).toBe("_probe");
  });
});
