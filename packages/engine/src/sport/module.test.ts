// S6/#416 (W5) — the two pure helpers PadSpec's gate DSL and action payload
// assembly are built on: `evalPadGate` (shared by this engine's own
// conformance property test and, from S10, the browser renderer — so the two
// sides can never compute "should this panel show" differently) and
// `buildPathObject` (the inverse of `resolvePayloadPath`, shared the same
// way for turning collected field values into a real event payload).
import { describe, expect, it } from "vitest";
import { buildPathObject, evalPadGate, type PadGate } from "./module.ts";

describe("evalPadGate", () => {
  const ctx = { state: { phase: "super_over", cfg: { dls: { enabled: true } } }, summary: { headline: "H — A" } };

  it("always is always true", () => {
    expect(evalPadGate({ op: "always" }, ctx)).toBe(true);
  });

  it("path-truthy reads a nested path under state", () => {
    expect(evalPadGate({ op: "path-truthy", path: "state.cfg.dls.enabled" }, ctx)).toBe(true);
    expect(evalPadGate({ op: "path-truthy", path: "state.cfg.dls.disabled" }, ctx)).toBe(false);
  });

  it("path-truthy reads under summary too", () => {
    expect(evalPadGate({ op: "path-truthy", path: "summary.headline" }, ctx)).toBe(true);
  });

  it("path-truthy on a missing path is false, never throws", () => {
    expect(evalPadGate({ op: "path-truthy", path: "state.does.not.exist" }, ctx)).toBe(false);
  });

  it("path-equals compares the resolved value by ===", () => {
    expect(evalPadGate({ op: "path-equals", path: "state.phase", value: "super_over" }, ctx)).toBe(true);
    expect(evalPadGate({ op: "path-equals", path: "state.phase", value: "live" }, ctx)).toBe(false);
  });

  it("path-equals against a missing path only matches value: null semantics via undefined !== null", () => {
    // resolvePayloadPath returns `undefined` for a miss; `undefined === null` is
    // false, so a gate cannot be accidentally satisfied by a typo'd path.
    expect(evalPadGate({ op: "path-equals", path: "state.nope", value: null }, ctx)).toBe(false);
  });

  it("and is true when every sub-gate is true", () => {
    const gate: PadGate = {
      op: "and",
      of: [
        { op: "path-equals", path: "state.phase", value: "super_over" },
        { op: "path-truthy", path: "state.cfg.dls.enabled" },
      ],
    };
    expect(evalPadGate(gate, ctx)).toBe(true);
  });

  it("and is false when one sub-gate fails", () => {
    const gate: PadGate = {
      op: "and",
      of: [
        { op: "path-equals", path: "state.phase", value: "super_over" },
        { op: "path-equals", path: "state.phase", value: "live" },
      ],
    };
    expect(evalPadGate(gate, ctx)).toBe(false);
  });

  it("or requires at least one sub-gate", () => {
    const gate: PadGate = {
      op: "or",
      of: [
        { op: "path-equals", path: "state.phase", value: "live" },
        { op: "path-equals", path: "state.phase", value: "super_over" },
      ],
    };
    expect(evalPadGate(gate, ctx)).toBe(true);
  });

  it("or is false when every sub-gate fails", () => {
    const gate: PadGate = {
      op: "or",
      of: [
        { op: "path-equals", path: "state.phase", value: "live" },
        { op: "path-equals", path: "state.phase", value: "done" },
      ],
    };
    expect(evalPadGate(gate, ctx)).toBe(false);
  });

  it("not inverts its sub-gate", () => {
    expect(evalPadGate({ op: "not", of: { op: "always" } }, ctx)).toBe(false);
    expect(
      evalPadGate({ op: "not", of: { op: "path-equals", path: "state.phase", value: "live" } }, ctx),
    ).toBe(true);
  });

  it("nests and/or/not arbitrarily deep", () => {
    const gate: PadGate = {
      op: "and",
      of: [
        { op: "not", of: { op: "path-equals", path: "state.phase", value: "live" } },
        { op: "or", of: [{ op: "always" }, { op: "path-truthy", path: "nope" }] },
      ],
    };
    expect(evalPadGate(gate, ctx)).toBe(true);
  });
});

describe("buildPathObject", () => {
  it("assembles a flat object from single-segment paths", () => {
    expect(buildPathObject([["runs", 4]])).toEqual({ runs: 4 });
  });

  it("nests dotted paths into a plain object tree", () => {
    expect(
      buildPathObject([
        ["runs.bat", 0],
        ["runs.extras.kind", "wide"],
        ["runs.extras.runs", 1],
      ]),
    ).toEqual({ runs: { bat: 0, extras: { kind: "wide", runs: 1 } } });
  });

  it("omits undefined values instead of writing the key", () => {
    const built = buildPathObject([
      ["wicket.out", "p1"],
      ["wicket.fielder", undefined],
    ]);
    expect(built).toEqual({ wicket: { out: "p1" } });
    expect(Object.hasOwn(built.wicket as object, "fielder")).toBe(false);
  });

  it("keeps falsy-but-defined values (0, false, empty string)", () => {
    expect(buildPathObject([["runs.bat", 0]])).toEqual({ runs: { bat: 0 } });
    expect(buildPathObject([["freeHit", false]])).toEqual({ freeHit: false });
  });

  it("shares an intermediate object across two entries at the same prefix", () => {
    // Order independence: whichever entry creates "wicket" first, the second
    // must land on the SAME object rather than clobbering it.
    const a = buildPathObject([
      ["wicket.kind", "bowled"],
      ["wicket.out", "p1"],
    ]);
    const b = buildPathObject([
      ["wicket.out", "p1"],
      ["wicket.kind", "bowled"],
    ]);
    expect(a).toEqual(b);
    expect(a).toEqual({ wicket: { kind: "bowled", out: "p1" } });
  });

  it("round-trips through JSON unchanged (pure data, no surprises)", () => {
    const built = buildPathObject([
      ["over", 3],
      ["wicket.kind", "caught"],
      ["wicket.bowlerCredited", true],
    ]);
    expect(JSON.parse(JSON.stringify(built))).toEqual(built);
  });

  it("an empty entry list builds an empty object", () => {
    expect(buildPathObject([])).toEqual({});
  });
});
