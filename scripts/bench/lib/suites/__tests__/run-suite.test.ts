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
import { expectedQualifierOrder, formatAdaptation, runPackSuite } from "../run-suite.ts";
import { TINY_PACK_PATH } from "../tiny.ts";
import type { QualifierTable } from "../../qualifiers.ts";

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

// ---------------------------------------------------------------------------
// B07a T5 — which derivation the advance step actually uses.
//
// `expectedQualifierOrder` IS the branch: pooled source stage => the
// progression rule decides the seat order (lib/qualifiers.ts); unpooled source
// stage => the long-standing flat rank sort of the one stage-wide table, which
// is what `_tiny`'s league -> playoff advance has always used and must keep
// using. Testing only the pure `expectedQualifierRefs` would leave THIS
// decision — the part that can silently pick the wrong path — untested
// (AGENTS.md failure class 1).
//
// Every refusal below returns NO seats and NAMES what it saw. That is
// deliberate: an empty expected list is length-compared against the product's
// real proposal and reds loudly, whereas guessing a rule would assert a
// confident wrong order.
// ---------------------------------------------------------------------------
describe("expectedQualifierOrder — pooled derivation vs the flat table", () => {
  const pooled: QualifierTable[] = [
    {
      poolKey: "B",
      rows: [
        { entrant: "e-b1", rank: 1 },
        { entrant: "e-b2", rank: 2 },
      ],
    },
    {
      poolKey: "A",
      rows: [
        { entrant: "e-a1", rank: 1 },
        { entrant: "e-a2", rank: 2 },
      ],
    },
  ];

  const topTwo = {
    sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 2 }] }],
    placement: "rank_order",
    timing: "setup",
  };

  it("keeps the flat rank sort for an UNPOOLED source stage", () => {
    // `_tiny`'s own shape: one stage-wide table, a rankRange take. Rows are
    // declared out of order here so a path that echoed declaration order
    // rather than sorting by rank would be caught.
    const flat: QualifierTable[] = [
      {
        poolKey: undefined,
        rows: [
          { entrant: "e-bravo", rank: 2 },
          { entrant: "e-alpha", rank: 1 },
        ],
      },
    ];
    const out = expectedQualifierOrder(flat, {
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
      placement: "rank_order",
    });
    expect(out.refs).toEqual(["e-alpha", "e-bravo"]);
    expect(out.pooled).toBe(false);
    expect(out.warning).toBeUndefined();
  });

  it("derives rank-before-group for a POOLED source stage", () => {
    const out = expectedQualifierOrder(pooled, topTwo);
    expect(out.pooled).toBe(true);
    expect(out.warning).toBeUndefined();
    // Rank before group, and the pack's B-then-A declaration order does not
    // move a seat.
    expect(out.refs).toEqual(["e-a1", "e-b1", "e-a2", "e-b2"]);
  });

  it("is an ORDERING-differential: the pooled answer is not the pool-major one", () => {
    const out = expectedQualifierOrder(pooled, topTwo);
    expect([...out.refs].sort()).toEqual(["e-a1", "e-a2", "e-b1", "e-b2"]);
    expect(out.refs).not.toEqual(["e-a1", "e-a2", "e-b1", "e-b2"]);
  });

  it("refuses a pooled stage whose take rule is not topNPerGroup, naming it", () => {
    const out = expectedQualifierOrder(pooled, {
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
      placement: "rank_order",
    });
    expect(out.refs).toEqual([]);
    expect(out.warning ?? "").toContain("rankRange");
  });

  it("refuses a placement that does not consume the list verbatim, naming it", () => {
    // `rank_order` is a plain pots.flat(); `snake` REVERSES alternate waves,
    // so the derived order would be wrong rather than merely unverified.
    const out = expectedQualifierOrder(pooled, { ...topTwo, placement: "snake" });
    expect(out.refs).toEqual([]);
    expect(out.warning ?? "").toContain("snake");
  });

  it("refuses a pooled stage that combines several take rules, naming them", () => {
    const out = expectedQualifierOrder(pooled, {
      sources: [
        {
          stage: "previous",
          take: [
            { kind: "topNPerGroup", n: 1 },
            { kind: "bestNth", nth: 2, count: 2 },
          ],
        },
      ],
      placement: "rank_order",
    });
    expect(out.refs).toEqual([]);
    expect(out.warning ?? "").toContain("bestNth");
  });

  it("refuses a pooled stage with no progression at all", () => {
    const out = expectedQualifierOrder(pooled, undefined);
    expect(out.refs).toEqual([]);
    expect(out.warning ?? "").not.toBe("");
  });

  it("refuses a topNPerGroup whose n is not a positive integer", () => {
    const out = expectedQualifierOrder(pooled, {
      sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 0 }] }],
      placement: "rank_order",
    });
    expect(out.refs).toEqual([]);
    expect(out.warning ?? "").toContain("0");
  });

  it("returns nothing, and no warning, when the stage has no expected table", () => {
    // The caller owns that error (it already names the missing table); this
    // must not add a second, different complaint about the same fact.
    const out = expectedQualifierOrder([], topTwo);
    expect(out.refs).toEqual([]);
    expect(out.pooled).toBe(false);
    expect(out.warning).toBeUndefined();
  });
});
