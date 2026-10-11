// Goldens + rule units for the history module (Jul3/03, PROMPT-23 acceptance).
import { describe, expect, it } from "vitest";
import {
  clearSchedule,
  fold,
  redo,
  removeEntrantsFromPool,
  undo,
} from "./history.ts";
import { HistoryError, type ClearableFixture, type LedgerEvent } from "./types.ts";

const NONE: ReadonlySet<string> = new Set();

function ev(seq: number, type: string, payload: Record<string, unknown>): LedgerEvent {
  return { seq, type, payload };
}

function move(fixture: string, fromAt: string | null, toAt: string, court = "C1") {
  return {
    fixture,
    from: { at: fromAt, court: fromAt === null ? null : court },
    to: { at: toAt, court },
  };
}

// 8-team single RR stage = 28 fixtures; we track 3 that get moved.
function goldenLedger(): LedgerEvent[] {
  const ids = Array.from({ length: 28 }, (_, i) => `f${i + 1}`);
  const events: LedgerEvent[] = [
    ev(1, "fixtures_generated", { stage_id: "s1", fixture_ids: ids }),
    ev(2, "schedule_applied", {
      stageId: "s1",
      moves: ids.map((id, i) => move(id, null, `T${i}`)),
    }),
  ];
  // move 3 fixtures, one event each (board drags)
  events.push(ev(3, "schedule_edited", { fixture: "f1", from: { at: "T0", court: "C1" }, to: { at: "T90", court: "C2" } }));
  events.push(ev(4, "schedule_edited", { fixture: "f2", from: { at: "T1", court: "C1" }, to: { at: "T91", court: "C2" } }));
  events.push(ev(5, "schedule_edited", { fixture: "f3", from: { at: "T2", court: "C1" }, to: { at: "T92", court: "C2" } }));
  return events;
}

function stepAppend(events: LedgerEvent[], step: { event: { type: string; payload: Record<string, unknown> } }): LedgerEvent[] {
  const head = events[events.length - 1]?.seq ?? 0;
  return [...events, ev(head + 1, step.event.type, step.event.payload)];
}

describe("history golden (Jul3/03 §3)", () => {
  it("generate → move ×3 → undo ×3 = original; redo ×3 = moved", () => {
    let events = goldenLedger();
    const moved = fold(events, null);
    let wm: number | null = null;

    // undo ×3
    for (let i = 0; i < 3; i++) {
      const step = undo(events, wm, NONE);
      events = stepAppend(events, step);
      wm = step.newWatermark;
    }
    const original = fold(events, wm);
    expect(original.fixtures.f1).toMatchObject({ at: "T0", court: "C1" });
    expect(original.fixtures.f2).toMatchObject({ at: "T1", court: "C1" });
    expect(original.fixtures.f3).toMatchObject({ at: "T2", court: "C1" });

    // redo ×3
    for (let i = 0; i < 3; i++) {
      const step = redo(events, wm, NONE);
      events = stepAppend(events, step);
      wm = step.newWatermark;
    }
    expect(fold(events, wm)).toEqual(moved);
  });

  it("scoped clear of pool A leaves pool B and locked fixtures intact", () => {
    const fixtures: ClearableFixture[] = [
      { id: "a1", stageId: "s1", poolId: "pA", roundNo: 1, court: "C1", at: "T1", locked: false, decided: false },
      { id: "a2", stageId: "s1", poolId: "pA", roundNo: 1, court: "C1", at: "T2", locked: true, decided: false },
      { id: "b1", stageId: "s1", poolId: "pB", roundNo: 1, court: "C2", at: "T1", locked: false, decided: false },
    ];
    const { event, cleared, skipped } = clearSchedule(fixtures, {
      poolIds: ["pA"],
      excludeLocked: true,
    });
    expect(cleared).toEqual(["a1"]);
    expect(skipped).toEqual({ locked: 1, decided: 0 });
    // the emitted event is fully undoable
    const events = [ev(1, event.type, event.payload)];
    const state = fold(events, null);
    expect(state.fixtures.a1).toMatchObject({ at: null, court: null });
    const step = undo(events, null, NONE);
    const restored = fold(stepAppend(events, step), step.newWatermark);
    expect(restored.fixtures.a1 ?? { at: null }).toMatchObject({ at: null }); // watermark 0 = before the clear
  });
});

describe("history rules", () => {
  it("results-guard blocks undoing a generation with decided fixtures beneath it", () => {
    const events = [ev(1, "fixtures_generated", { stage_id: "s1", fixture_ids: ["f1", "f2"] })];
    expect(() => undo(events, null, new Set(["f2"]))).toThrowError(
      expect.objectContaining({ code: "UNDO_BLOCKED_HAS_RESULTS" }),
    );
    expect(undo(events, null, NONE).event.type).toBe("fixtures_cleared");
  });

  it("undo/redo across non-registry events skips them", () => {
    const events = [
      ev(1, "schedule_edited", { fixture: "f1", from: { at: null, court: null }, to: { at: "T1", court: "C1" } }),
      ev(2, "participants_imported", { import_id: "x" }),
      ev(3, "officials_assigned", { applied: 4 }),
    ];
    const step = undo(events, null, NONE);
    expect(step.event.payload.__undo_of).toBe(1);
    expect(step.newWatermark).toBe(0);
  });

  it("a fresh edit after undo truncates the redo branch (Word-like linear history)", () => {
    let events = [
      ev(1, "schedule_edited", { fixture: "f1", from: { at: null, court: null }, to: { at: "T1", court: "C1" } }),
      ev(2, "schedule_edited", { fixture: "f1", from: { at: "T1", court: "C1" }, to: { at: "T2", court: "C1" } }),
    ];
    const step = undo(events, null, NONE); // undo the T2 move → wm 1
    events = stepAppend(events, step);
    // new edit at head → watermark jumps to head
    events = stepAppend(events, {
      event: {
        type: "schedule_edited",
        payload: { fixture: "f1", from: { at: "T1", court: "C1" }, to: { at: "T5", court: "C2" } },
      },
    });
    const head = events[events.length - 1]!.seq;
    expect(() => redo(events, head, NONE)).toThrowError(
      expect.objectContaining({ code: "NOTHING_TO_REDO" }),
    );
    // and the fold at head is coherent: T2-move applied, inverted, then T5
    expect(fold(events, head).fixtures.f1).toMatchObject({ at: "T5", court: "C2" });
  });

  it("nothing to undo / redo → typed errors", () => {
    expect(() => undo([], null, NONE)).toThrowError(HistoryError);
    expect(() => redo([], null, NONE)).toThrowError(
      expect.objectContaining({ code: "NOTHING_TO_REDO" }),
    );
  });

  it("removeEntrantsFromPool keeps the pool, blocks on decided fixtures", () => {
    const mk = (id: string, poolId: string, decided = false) => ({
      id, stageId: "s1", poolId, roundNo: 1, court: null, at: null, locked: false, decided,
      snapshot: { id, pool_id: poolId },
    });
    const ok = removeEntrantsFromPool([mk("a1", "pA"), mk("b1", "pB")], "pA");
    expect(ok.removed).toEqual(["a1"]);
    expect(ok.event.type).toBe("pool_entrants_cleared");
    expect(() =>
      removeEntrantsFromPool([mk("a1", "pA", true)], "pA"),
    ).toThrowError(expect.objectContaining({ code: "UNDO_BLOCKED_HAS_RESULTS" }));
  });
});

// Engine mutation debt (history.ts): the scoped clear's filters one at a
// time, the refusals' exact words, and the sequences around them. Expected
// values are hand-derived from the documented rules (Jul3/03 §3, §5). Sport:
// not applicable — the history module consults no sport module.
function thrown(fn: () => unknown): HistoryError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HistoryError);
    return err as HistoryError;
  }
  throw new Error("expected a HistoryError, nothing was thrown");
}

describe("clearSchedule — scope filters (Jul3/03 §5)", () => {
  const T = "2026-10-11T09:00:00.000Z";
  const fx = (
    id: string,
    stageId: string,
    poolId: string | null,
    roundNo: number | null,
    court: string | null,
    at: string | null,
    extra: Partial<Pick<ClearableFixture, "locked" | "decided">> = {},
  ): ClearableFixture => ({ id, stageId, poolId, roundNo, court, at, locked: false, decided: false, ...extra });
  const FIXTURES: ClearableFixture[] = [
    fx("a", "s1", "pA", 1, "C1", T),
    fx("b", "s1", "pB", 2, "C2", T),
    fx("c", "s2", null, 1, "C1", T), // no pool
    fx("d", "s1", "pA", null, null, T), // a time, no court, no round
    fx("e", "s1", "pA", 1, "C1", null), // a court, no time
    fx("u", "s1", "pA", 1, null, null), // unplaced: nothing to clear, not counted
    fx("x", "s1", "pA", 1, "C1", T, { decided: true }),
    fx("l", "s1", "pA", 1, "C2", T, { locked: true }),
  ];

  it("an empty fixture list clears nothing and skips nothing", () => {
    const scope = { excludeLocked: true };
    expect(clearSchedule([], scope)).toStrictEqual({
      event: { type: "schedule_cleared", payload: { scope, cleared: [] } },
      cleared: [],
      skipped: { locked: 0, decided: 0 },
    });
  });

  const TABLE: { name: string; scope: Parameters<typeof clearSchedule>[1]; cleared: string[]; locked: number; decided: number }[] = [
    { name: "no filter", scope: { excludeLocked: true }, cleared: ["a", "b", "c", "d", "e"], locked: 1, decided: 1 },
    { name: "stage s1", scope: { stageId: "s1", excludeLocked: true }, cleared: ["a", "b", "d", "e"], locked: 1, decided: 1 },
    { name: "pool pA (a pool-less fixture is outside every pool)", scope: { poolIds: ["pA"], excludeLocked: true }, cleared: ["a", "d", "e"], locked: 1, decided: 1 },
    { name: "round 1 (a round-less fixture is outside every round)", scope: { rounds: [1], excludeLocked: true }, cleared: ["a", "c", "e"], locked: 1, decided: 1 },
    // l sits on C2: outside the scope, so it is not counted as skipped-locked
    { name: "court C1 (a court-less fixture is outside every court)", scope: { courts: ["C1"], excludeLocked: true }, cleared: ["a", "c", "e"], locked: 0, decided: 1 },
    { name: "locked fixtures included", scope: { excludeLocked: false }, cleared: ["a", "b", "c", "d", "e", "l"], locked: 0, decided: 1 },
    { name: "every filter at once", scope: { stageId: "s1", poolIds: ["pA"], rounds: [1], courts: ["C1"], excludeLocked: true }, cleared: ["a", "e"], locked: 0, decided: 1 },
  ];
  for (const row of TABLE) {
    it(`${row.name} clears ${row.cleared.join(",")}`, () => {
      const out = clearSchedule(FIXTURES, row.scope);
      expect(out.cleared, row.name).toEqual(row.cleared);
      expect(out.skipped, row.name).toStrictEqual({ locked: row.locked, decided: row.decided });
      const byId = new Map(FIXTURES.map((f) => [f.id, f]));
      expect(out.event, row.name).toStrictEqual({
        type: "schedule_cleared",
        payload: {
          scope: row.scope,
          cleared: row.cleared.map((id) => ({ id, at: byId.get(id)!.at, court: byId.get(id)!.court })),
        },
      });
    });
  }

  it("a second clear of the same scope finds nothing left to clear", () => {
    const scope = { excludeLocked: true };
    const first = clearSchedule(FIXTURES, scope);
    expect(first.cleared.length).toBeGreaterThan(0);
    const gone = new Set(first.cleared);
    const after = FIXTURES.map((f) => (gone.has(f.id) ? { ...f, at: null, court: null } : f));
    const second = clearSchedule(after, scope);
    expect(second.cleared).toEqual([]);
    // the played and the locked fixtures are still placed, and still skipped
    expect(second.skipped).toStrictEqual({ locked: 1, decided: 1 });
  });
});

describe("undo / redo — sequences and refusals", () => {
  const edit = (seq: number, fixture: string, from: string | null, to: string): LedgerEvent =>
    ev(seq, "schedule_edited", {
      fixture,
      from: { at: from, court: from === null ? null : "C1" },
      to: { at: to, court: "C1" },
    });

  it("undo ×2, redo ×2, then a third redo has nothing left", () => {
    let events = [edit(1, "f1", null, "T1"), edit(2, "f2", null, "T2")];
    let wm: number | null = null;
    for (const expected of [1, 0]) {
      const step = undo(events, wm, NONE);
      expect(step.newWatermark).toBe(expected);
      events = stepAppend(events, step);
      wm = step.newWatermark;
    }
    expect(fold(events, wm)).toStrictEqual({ fixtures: {} });
    for (const expected of [1, 2]) {
      const step = redo(events, wm, NONE);
      expect(step.newWatermark).toBe(expected);
      expect(step.event.payload.__redo_of).toBe(expected);
      events = stepAppend(events, step);
      wm = step.newWatermark;
    }
    // beyond wm 2: two inverses and one redo copy — none is an original edit
    expect(events.slice(2).map((e) => [e.payload.__undo_of, e.payload.__redo_of])).toEqual([
      [2, undefined],
      [1, undefined],
      [undefined, 1],
      [undefined, 2],
    ]);
    expect(thrown(() => redo(events, wm, NONE)).code).toBe("NOTHING_TO_REDO");
  });

  it("undo at watermark 0 has nothing to undo", () => {
    const events = [edit(1, "f1", null, "T1")];
    expect(thrown(() => undo(events, 0, NONE)).code).toBe("NOTHING_TO_UNDO");
  });

  // These sentences are painted as they are by the history panel and the
  // stages-panel Undo (their fallback keeps an unrecognised refusal's own
  // message, "the one an organiser can quote") and returned by API v1.
  it("nothing to undo says so, with its code", () => {
    const err = thrown(() => undo([], null, NONE));
    expect(err.code).toBe("NOTHING_TO_UNDO");
    expect(err.message).toBe("no reversible edits before the watermark");
  });

  it("nothing to redo says so, with its code", () => {
    const err = thrown(() => redo([edit(1, "f1", null, "T1")], null, NONE));
    expect(err.code).toBe("NOTHING_TO_REDO");
    expect(err.message).toBe("already at the newest edit");
  });

  it("a played fixture's refusal names no fixture and offers no remedy", () => {
    // API v1 returns this sentence (ALREADY_DECIDED); the panels say their own
    // off the code. It must not leak the fixture id.
    const err = thrown(() => undo([edit(1, "fixture-7f3a", null, "T1")], null, new Set(["fixture-7f3a"])));
    expect(err.code).toBe("UNDO_BLOCKED_HAS_RESULTS");
    expect(err.message).toBe("a match this change touches has started or finished, so it can't be undone or redone");
    expect(err.message).not.toContain("fixture-7f3a");
  });
});

describe("removeEntrantsFromPool — the event it returns", () => {
  const mk = (id: string, poolId: string, decided = false) => ({
    id, stageId: "s1", poolId, roundNo: 1, court: "C1", at: "T1", locked: false, decided,
    snapshot: { id, pool_id: poolId, at: "T1", court: "C1" },
  });

  it("snapshots every fixture of the pool, in order, and only that pool", () => {
    const out = removeEntrantsFromPool([mk("a1", "pA"), mk("b1", "pB"), mk("a2", "pA")], "pA");
    expect(out).toStrictEqual({
      event: {
        type: "pool_entrants_cleared",
        payload: {
          pool_id: "pA",
          fixtures: [
            { id: "a1", pool_id: "pA", at: "T1", court: "C1" },
            { id: "a2", pool_id: "pA", at: "T1", court: "C1" },
          ],
        },
      },
      removed: ["a1", "a2"],
    });
  });

  it("a pool with no fixtures removes nothing", () => {
    expect(removeEntrantsFromPool([mk("b1", "pB")], "pA")).toStrictEqual({
      event: { type: "pool_entrants_cleared", payload: { pool_id: "pA", fixtures: [] } },
      removed: [],
    });
  });

  it("a played fixture in ANOTHER pool does not block; one in this pool does, in words", () => {
    expect(removeEntrantsFromPool([mk("a1", "pA"), mk("b1", "pB", true)], "pA").removed).toEqual(["a1"]);
    const err = thrown(() => removeEntrantsFromPool([mk("a1", "pA"), mk("a2", "pA", true)], "pA"));
    expect(err.code).toBe("UNDO_BLOCKED_HAS_RESULTS");
    expect(err.message).toBe("a match in this pool has started or finished, so its entrants can't be removed");
  });
});
