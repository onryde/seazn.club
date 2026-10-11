// The history module's declared shapes (engine mutation debt, types.ts).
// ClearScope is parsed at runtime by the app (ClearScheduleInput in
// apps/web/src/server/usecases/history.ts wraps it); the other three schemas
// are exported contracts the engine's types are inferred from, pinned here so
// a loosened or emptied schema is seen. Expected values come from the shapes'
// own documentation, not from parsing with the code under test.
// Sport: not applicable — no sport module is involved.
import { describe, expect, it } from "vitest";
import { ClearScope, FixtureSnapshot, HistoryError, LedgerEvent, Placement } from "./types.ts";

describe("HistoryError", () => {
  it("is an Error named HistoryError carrying its code and message", () => {
    const err = new HistoryError("NOTHING_TO_UNDO", "no reversible edits before the watermark");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HistoryError);
    // The name is what an error tracker groups and titles the event by.
    expect(err.name).toBe("HistoryError");
    expect(String(err)).toBe("HistoryError: no reversible edits before the watermark");
    expect(err.code).toBe("NOTHING_TO_UNDO");
    expect(err.message).toBe("no reversible edits before the watermark");
  });
});

describe("ClearScope — the scoped-clear request (Jul3/03 §5)", () => {
  it("an empty scope skips locked fixtures by default", () => {
    // clearSchedule's contract: "always skipping locked (default)".
    expect(ClearScope.parse({})).toStrictEqual({ excludeLocked: true });
  });

  it("keeps every filter it is given, and an explicit excludeLocked: false", () => {
    const scope = { stageId: "s1", poolIds: ["pA", "pB"], rounds: [1, 3], courts: ["c1"], excludeLocked: false };
    expect(ClearScope.parse(scope)).toStrictEqual(scope);
  });

  it("refuses a fractional round and a non-string pool", () => {
    expect(ClearScope.safeParse({ rounds: [1.5] }).success).toBe(false);
    expect(ClearScope.safeParse({ poolIds: [7] }).success).toBe(false);
  });
});

describe("LedgerEvent — one division_events row", () => {
  it("keeps seq, type and payload", () => {
    const row = { seq: 4, type: "schedule_edited", payload: { fixture: "f1" } };
    expect(LedgerEvent.parse(row)).toStrictEqual(row);
  });

  it("refuses seq 0 and a fractional seq", () => {
    // Watermark 0 means "before every event" (effectiveWatermark on an empty
    // ledger; undo of the first edit), so no row may sit at 0.
    expect(LedgerEvent.safeParse({ seq: 0, type: "x", payload: {} }).success).toBe(false);
    expect(LedgerEvent.safeParse({ seq: 1.5, type: "x", payload: {} }).success).toBe(false);
    expect(LedgerEvent.safeParse({ seq: 1, type: "x" }).success).toBe(false);
  });
});

describe("Placement — a fixture's slot", () => {
  it("keeps a slot and an unscheduled (null) slot", () => {
    expect(Placement.parse({ at: "2026-10-11T09:00:00.000Z", court: "c1" })).toStrictEqual({
      at: "2026-10-11T09:00:00.000Z",
      court: "c1",
    });
    expect(Placement.parse({ at: null, court: null })).toStrictEqual({ at: null, court: null });
  });

  it("refuses a slot with no court key", () => {
    expect(Placement.safeParse({ at: null }).success).toBe(false);
  });
});

describe("FixtureSnapshot — a row a destructive op can re-insert", () => {
  it("an id-only snapshot (one a ledger held before the restore-fidelity fields) parses as it is", () => {
    expect(FixtureSnapshot.parse({ id: "f1" })).toStrictEqual({ id: "f1" });
  });

  it("a full restore-fidelity snapshot keeps every column", () => {
    const row = {
      id: "f1",
      stage_id: "s1",
      pool_id: null,
      round_no: 2,
      seq_in_round: 1,
      home_entrant_id: "e1",
      away_entrant_id: null,
      at: "2026-10-11T09:00:00.000Z",
      court: "c1",
      locked: true,
      schedule_source: "solver",
      fixture_no: 7,
      ext_key: "s1:r2:1",
      lane: null,
      is_final: false,
      third_place: false,
      conditional: false,
      home_slot_label: { kind: "seed", n: 1 },
      away_slot_label: null,
      winner_to_fixture: "f9",
      winner_to_slot: 0,
      loser_to_fixture: null,
      loser_to_slot: null,
      status: "scheduled",
      outcome: null,
      scored: false,
      finished_at: null,
    };
    expect(FixtureSnapshot.parse(row)).toStrictEqual(row);
  });

  it("refuses a snapshot with no id", () => {
    expect(FixtureSnapshot.safeParse({ stage_id: "s1" }).success).toBe(false);
  });
});
