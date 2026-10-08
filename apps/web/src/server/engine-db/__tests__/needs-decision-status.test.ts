// W2a Task 7 — the stage-aware status rule (spec §5.4.2, rulings 72 and 79). Pure: no DB. The expected statuses
// come from the spec's ordered rule (settle → abandon → level-in-bracket → as before) and the engine's declarations
// (`StageKind.options`, `BRACKET_KINDS`), never from the function under test.
import { describe, expect, it } from "vitest";
import { BRACKET_KINDS, StageKind, type EventEnvelope, type MatchOutcome } from "@seazn/engine/core";
import { fixtureStatusFromFold, nextStatus } from "../append-event";

const ev = (type: string, i = 1): EventEnvelope =>
  ({ id: `e-${i}`, seq: i, type, payload: {}, recordedAt: "2026-10-08T00:00:00Z", recordedBy: null }) as EventEnvelope;
/** The three level outcome kinds of ruling 72, each a full MatchOutcome. */
const LEVEL: readonly MatchOutcome[] = [{ kind: "draw" }, { kind: "tie" }, { kind: "no_result" }];
const WIN: MatchOutcome = { kind: "win", winner: "H", loser: "A" };

describe("X-BR-2: the status rule (spec §5.4.2, D3)", () => {
  it("empty case first: no events and no outcome is scheduled, in any stage kind or none", () => {
    let checked = 0;
    for (const k of [...StageKind.options, null]) {
      expect(fixtureStatusFromFold(null, [], k), String(k)).toBe("scheduled");
      checked++;
    }
    expect(checked).toBe(StageKind.options.length + 1);
  });

  it("X-BR-2: every level outcome kind in every bracket kind is needs_decision; outside brackets it is decided", () => {
    let checked = 0;
    let held = 0;
    for (const outcome of LEVEL)
      for (const k of StageKind.options) {
        const status = fixtureStatusFromFold(outcome, [ev("core.start")], k);
        expect(status, `${outcome.kind} ${k}`).toBe(BRACKET_KINDS.has(k) ? "needs_decision" : "decided");
        if (status === "needs_decision") held++;
        checked++;
      }
    expect(checked).toBe(LEVEL.length * StageKind.options.length);
    expect(held).toBe(LEVEL.length * BRACKET_KINDS.size); // both halves were reached, not one
  });

  it("a win in a bracket is decided (right answer differs from needs_decision's constant)", () => {
    expect(fixtureStatusFromFold(WIN, [ev("core.start")], "knockout")).toBe("decided");
  });

  it("a level outcome with an active forfeit in a bracket is still held — the forfeit names no winner it can seat", () => {
    expect(fixtureStatusFromFold({ kind: "no_result" }, [ev("core.start", 1), ev("core.forfeit", 2)], "knockout")).toBe("needs_decision");
  });

  it("D3 order 1: an active settle is decided even over an active abandon", () => {
    expect(fixtureStatusFromFold(WIN, [ev("core.start", 1), ev("core.abandon", 2), ev("core.settle", 3)], "knockout")).toBe("decided");
  });

  it("D3 order 2: an active abandon stays abandoned, even with a level outcome in a bracket (stuck and visible)", () => {
    let checked = 0;
    for (const outcome of [...LEVEL, null]) {
      expect(fixtureStatusFromFold(outcome, [ev("core.start", 1), ev("core.abandon", 2)], "knockout"), String(outcome?.kind)).toBe("abandoned");
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("finalize still wins in nextStatus; a void of the settle (settle absent from active) returns to needs_decision", () => {
    expect(nextStatus("core.finalize", WIN, [ev("core.settle")], "knockout")).toBe("finalized");
    expect(nextStatus("core.void", { kind: "draw" }, [ev("core.start")], "knockout")).toBe("needs_decision");
    expect(nextStatus("core.void", { kind: "draw" }, [ev("core.start")], "league")).toBe("decided"); // the negative pair
  });

  it("a null stage kind (a fixture outside any stage) behaves as today", () => {
    expect(fixtureStatusFromFold({ kind: "draw" }, [ev("core.start")], null)).toBe("decided");
  });
});
