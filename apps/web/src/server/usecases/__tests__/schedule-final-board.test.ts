// How an auto pass takes placements back until the write gate accepts the proposal (`schedule/final-board.ts`).
// The gate is a stand-in here, so each shape of refusal can be put to it, including the ones a real board
// rarely produces. The real gate is driven by `schedule-auto-start-floor.test.ts`. No database, no solver.
import { describe, expect, it } from "vitest";
import type { Assignment, Conflict } from "@seazn/engine/scheduling";
import { settleProposal } from "../schedule/final-board";

const at = (fixtureId: string, startAt: number, court = "C1"): Assignment => ({
  fixtureId,
  court,
  startAt,
  endAt: startAt + 30,
  entrants: [],
  people: [],
});

const clash = (fixtureId: string, otherFixtureId?: string): Conflict =>
  ({
    fixtureId,
    reason: "court",
    details: { kind: "court_double_booking", ...(otherFixtureId !== undefined ? { otherFixtureId } : {}) },
  }) as unknown as Conflict;

/** A gate that refuses any two rows on one court at one start, filing the conflict on the card `blame` picks. */
const oneCardPerSlot =
  (blame: (ids: [string, string]) => [string, string] = (ids) => ids) =>
  (rows: readonly Assignment[]): Conflict[] => {
    const found: Conflict[] = [];
    for (const [i, a] of rows.entries()) {
      for (const b of rows.slice(i + 1)) {
        if (a.court === b.court && a.startAt === b.startAt) found.push(clash(...blame([a.fixtureId, b.fixtureId])));
      }
    }
    return found;
  };

const ids = (rows: readonly Assignment[]) => rows.map((r) => r.fixtureId).sort();
const settle = (over: Partial<Parameters<typeof settleProposal>[0]>) =>
  settleProposal({ proposed: [], held: [], stored: new Map(), keepStored: false, refuses: () => [], ...over });

describe("settleProposal", () => {
  it("has nothing to do for an empty proposal", () => {
    expect(settle({ keepStored: true })).toEqual({ fresh: [], kept: [], refused: new Map() });
  });

  it("returns a proposal the gate accepts as it came", () => {
    const proposed = [at("a", 100), at("b", 200)];
    const out = settle({ proposed, refuses: oneCardPerSlot() });
    expect(out.fresh).toEqual(proposed);
    expect(out.refused.size).toBe(0);
  });

  // `b` is not on the pass's board, so it keeps its stored slot, where the pass put `a`.
  it("takes back the card that moved onto a card the pass did not place", () => {
    const stored = new Map([["b", at("b", 100)]]);
    for (const keepStored of [true, false]) {
      // Without `keepStored` the gate sees `b` only as part of the standing board.
      const refuses = (rows: readonly Assignment[]) =>
        oneCardPerSlot()(keepStored ? rows : [...rows, stored.get("b")!]);
      const out = settle({ proposed: [at("a", 100), at("c", 300)], stored, keepStored, refuses });
      expect(ids(out.fresh)).toEqual(["c"]);
      expect(ids(out.kept)).toEqual(keepStored ? ["b"] : []);
      expect([...out.refused.keys()]).toEqual(["a"]);
    }
  });

  it("takes back the other card of a conflict filed on a card that did not move, and says why on it", () => {
    const stored = new Map([["b", at("b", 100)]]);
    const out = settle({
      proposed: [at("a", 100)],
      stored,
      keepStored: true,
      refuses: oneCardPerSlot(([x, y]) => (x === "b" ? [x, y] : [y, x])),
    });
    expect(out.fresh).toEqual([]);
    expect(out.refused.get("a")).toMatchObject({ fixtureId: "a", details: { otherFixtureId: "b" } });
  });

  it("repeats: a card sent back to its stored slot takes back the card placed there", () => {
    // `a` falls back onto the slot `b` was moved to, and `b` back onto the one `c` was moved to.
    const stored = new Map([
      ["a", at("a", 200)],
      ["b", at("b", 300)],
      ["blocker", at("blocker", 100)],
    ]);
    const out = settle({
      proposed: [at("a", 100), at("b", 200), at("c", 300), at("d", 400)],
      stored,
      keepStored: true,
      refuses: oneCardPerSlot(),
    });
    expect(ids(out.fresh)).toEqual(["d"]);
    expect(ids(out.kept)).toEqual(["a", "b", "blocker"]);
    expect([...out.refused.keys()].sort()).toEqual(["a", "b", "c"]);
  });

  it("takes every move back when a refusal names no card it moved", () => {
    const stored = new Map([["same", at("same", 500)]]);
    const out = settle({
      proposed: [at("a", 100), at("same", 500)],
      stored,
      keepStored: true,
      // Refused for as long as anything has moved, naming a card the proposal does not hold.
      refuses: (rows) => (rows.some((r) => r.fixtureId === "a") ? [clash("elsewhere")] : []),
    });
    expect(ids(out.fresh)).toEqual(["same"]);
    expect(ids(out.kept)).toEqual([]);
    expect([...out.refused.keys()]).toEqual(["a"]);
  });

  it("throws rather than loop when a proposal that moves nothing is refused", () => {
    const stored = new Map([["a", at("a", 100)]]);
    expect(() =>
      settle({ proposed: [at("a", 100)], stored, keepStored: true, refuses: () => [clash("a")] }),
    ).toThrow("moves no card");
  });
});
