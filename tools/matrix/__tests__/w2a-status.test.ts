// The fakes' D3 status rule (w2a-status.ts), held to the RULE ROWS (X-BR-1, X-BR-2, X-ST-1) and to the engine's own
// declarations (StageKind.options, BRACKET_KINDS) — never to the function's own text. Needs loop D's `core` exports
// (BRACKET_KINDS, forbidsLevelResult, isLevelOutcome): red until D lands in the lane.
import { BRACKET_KINDS, StageKind } from "@seazn/engine/core";
import { describe, expect, it } from "vitest";
import { fixtureStatusFromFold } from "./w2a-status.ts";

const ev = (...types: string[]) => types.map((type) => ({ type }));
const LEVEL = [{ kind: "draw" }, { kind: "tie" }, { kind: "no_result" }];
const WIN = { kind: "win", winner: "a", loser: "b" };

describe("fixtureStatusFromFold — D3, in the product's order", () => {
  it("a level outcome is HELD (needs_decision) in exactly the bracket kinds and decided in every other kind — swept over StageKind.options", () => {
    let checked = 0;
    for (const kind of StageKind.options) {
      for (const outcome of LEVEL) {
        expect(fixtureStatusFromFold(outcome, ev("core.start"), kind), `${kind} ${outcome.kind}`).toBe(BRACKET_KINDS.has(kind) ? "needs_decision" : "decided");
        checked++;
      }
    }
    expect(checked).toBe(StageKind.options.length * LEVEL.length);
    expect(checked).toBeGreaterThan(0); // anti-vacuity
    // Both sides of the differing case exist.
    expect(StageKind.options.some((k) => BRACKET_KINDS.has(k))).toBe(true);
    expect(StageKind.options.some((k) => !BRACKET_KINDS.has(k))).toBe(true);
  });

  it("a win is decided in every kind (X-BR-1 holds a LEVEL result only), an award is forfeited, an empty ledger is scheduled, a started one in_play", () => {
    for (const kind of StageKind.options) expect(fixtureStatusFromFold(WIN, ev("core.start"), kind), kind).toBe("decided");
    expect(fixtureStatusFromFold({ kind: "award", winner: "a" }, ev("core.forfeit"), "knockout")).toBe("forfeited");
    expect(fixtureStatusFromFold(null, [], "knockout")).toBe("scheduled");
    expect(fixtureStatusFromFold(null, ev("core.start"), "knockout")).toBe("in_play");
    expect(fixtureStatusFromFold(null, ev("core.start"), null)).toBe("in_play"); // no stage kind: a plain fixture
  });

  it("an active settle decides — even over an abandon; an abandon with no settle stays abandoned, even over a level outcome (X-ST-1 precedence)", () => {
    expect(fixtureStatusFromFold(WIN, ev("core.start", "core.settle"), "knockout")).toBe("decided");
    expect(fixtureStatusFromFold(WIN, ev("core.start", "core.abandon", "core.settle"), "knockout")).toBe("decided");
    expect(fixtureStatusFromFold(null, ev("core.start", "core.abandon"), "knockout")).toBe("abandoned");
    expect(fixtureStatusFromFold({ kind: "draw" }, ev("core.start", "core.abandon"), "knockout")).toBe("abandoned");
  });
});
