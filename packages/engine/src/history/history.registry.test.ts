// The ReversibleOp registry, one row per declared type (Jul3/03 §3; engine
// mutation debt, history.ts). Every row walks the SEQUENCE a real division
// walks — the edit lands, Undo, Redo, a second Redo that has nothing left —
// and checks the fold, the exact event each step appends, and the
// results-guard on both directions, with its positive pair.
//
// Expected values are hand-derived from the registry's declared semantics and
// from what the app's executor (`execute()` in apps/web/src/server/usecases/
// history.ts) does with the same event — never from running this module.
// Sport: not applicable — the division ledger holds schedule ops only, no
// sport module is consulted anywhere in history.ts.
import { describe, expect, it } from "vitest";
import { REVERSIBLE, fold, isReversible, redo, undo } from "./history.ts";
import type { FixtureScheduleState, LedgerEvent } from "./types.ts";

type Payload = Record<string, unknown>;
type Fixtures = Record<string, FixtureScheduleState>;

const NONE: ReadonlySet<string> = new Set();

const ev = (seq: number, type: string, payload: Payload): LedgerEvent => ({ seq, type, payload });
const fx = (exists: boolean, at: string | null, court: string | null, locked = false): FixtureScheduleState => ({
  exists,
  at,
  court,
  locked,
});

const A = "2026-10-11T09:00:00.000Z";
const A30 = "2026-10-11T09:30:00.000Z";
const B = "2026-10-11T10:00:00.000Z";
const B30 = "2026-10-11T10:30:00.000Z";
const C = "2026-10-11T11:00:00.000Z";
const D = "2026-10-11T13:00:00.000Z";
const E = "2026-10-11T14:00:00.000Z";

// The documented registry (Jul3/03 §3 + the bulk shift of Jul3/04 §4), typed
// here rather than read off REVERSIBLE, so a dropped or renamed entry reds.
const REGISTRY = [
  "schedule_applied",
  "schedule_shifted",
  "schedule_edited",
  "schedule_cleared",
  "schedule_restored",
  "fixtures_generated",
  "fixtures_cleared",
  "pool_entrants_cleared",
  "pool_entrants_restored",
] as const;

// Generate s1 (three fixtures), place them, lock f3 — the state every row
// starts from unless it names its own prior.
const PRIOR: LedgerEvent[] = [
  ev(1, "fixtures_generated", { stage_id: "s1", fixture_ids: ["f1", "f2", "f3"] }),
  ev(2, "schedule_applied", {
    stage_id: "s1",
    moves: [
      { fixture: "f1", from: { at: null, court: null }, to: { at: A, court: "C1" } },
      { fixture: "f2", from: { at: null, court: null }, to: { at: B, court: "C2" } },
      { fixture: "f3", from: { at: null, court: null }, to: { at: C, court: "C1" } },
    ],
  }),
  ev(3, "schedule_edited", {
    fixture: "f3",
    from: { at: C, court: "C1", locked: false },
    to: { at: C, court: "C1", locked: true },
  }),
];
const S0: Fixtures = { f1: fx(true, A, "C1"), f2: fx(true, B, "C2"), f3: fx(true, C, "C1", true) };

const CLEARED_F1_F3 = [
  { id: "f1", at: A, court: "C1" },
  { id: "f3", at: C, court: "C1" },
];
const AFTER_CLEAR_F1_F3: Fixtures = { f1: fx(true, null, null), f2: S0.f2!, f3: fx(true, null, null, true) };

const POOL_A = [
  { id: "f1", pool_id: "pA", at: A, court: "C1" },
  { id: "f2", pool_id: "pA", at: B, court: "C2" },
];
const AFTER_POOL_A_CLEAR: Fixtures = { f1: fx(false, null, null), f2: fx(false, null, null), f3: S0.f3! };

interface Row {
  name: string;
  type: (typeof REGISTRY)[number];
  prior: LedgerEvent[];
  /** fold(prior) — hand-derived, checked first so a wrong prior cannot pass. */
  before: Fixtures;
  payload: Payload;
  after: Fixtures;
  /** The event Undo appends, without its `__undo_of` stamp. */
  inverse: { type: string; payload: Payload };
  /** fold at HEAD once Undo has appended the inverse: apply ∘ invert. `exists`
   *  = only each touched fixture's `exists` is asserted (see the row). */
  undoneHead: Fixtures | "exists";
  /** The fixtures the results-guard checks for this event (its `affected`). */
  touches: string[];
  /** A played fixture the event does NOT touch: Undo and Redo must go ahead. */
  untouched: string;
}

const ROWS: Row[] = [
  {
    name: "schedule_applied moves two fixtures and leaves the locked one",
    type: "schedule_applied",
    prior: PRIOR,
    before: S0,
    payload: {
      stage_id: "s1",
      moves: [
        { fixture: "f1", from: { at: A, court: "C1" }, to: { at: D, court: "C2" } },
        { fixture: "f2", from: { at: B, court: "C2" }, to: { at: E, court: "C1" } },
      ],
    },
    after: { f1: fx(true, D, "C2"), f2: fx(true, E, "C1"), f3: S0.f3! },
    inverse: {
      type: "schedule_applied",
      payload: {
        stage_id: "s1",
        moves: [
          { fixture: "f1", from: { at: D, court: "C2" }, to: { at: A, court: "C1" } },
          { fixture: "f2", from: { at: E, court: "C1" }, to: { at: B, court: "C2" } },
        ],
      },
    },
    undoneHead: S0,
    touches: ["f1", "f2"],
    untouched: "f3",
  },
  {
    name: "schedule_shifted pushes two fixtures by 30 minutes",
    type: "schedule_shifted",
    prior: PRIOR,
    before: S0,
    payload: {
      minutes: 30,
      moves: [
        { fixture: "f1", from: { at: A, court: "C1" }, to: { at: A30, court: "C1" } },
        { fixture: "f2", from: { at: B, court: "C2" }, to: { at: B30, court: "C2" } },
      ],
    },
    after: { f1: fx(true, A30, "C1"), f2: fx(true, B30, "C2"), f3: S0.f3! },
    inverse: {
      type: "schedule_shifted",
      payload: {
        minutes: 30,
        moves: [
          { fixture: "f1", from: { at: A30, court: "C1" }, to: { at: A, court: "C1" } },
          { fixture: "f2", from: { at: B30, court: "C2" }, to: { at: B, court: "C2" } },
        ],
      },
    },
    undoneHead: S0,
    touches: ["f1", "f2"],
    untouched: "f3",
  },
  {
    // A ledger row from before the lock column (no `locked` in from/to): the
    // executor writes `coalesce(to.locked, schedule_locked)`, so the lock stays.
    name: "schedule_edited without a lock flag moves the fixture and keeps its lock",
    type: "schedule_edited",
    prior: PRIOR,
    before: S0,
    payload: { fixture: "f3", from: { at: C, court: "C1" }, to: { at: D, court: "C2" } },
    after: { f1: S0.f1!, f2: S0.f2!, f3: fx(true, D, "C2", true) },
    inverse: {
      type: "schedule_edited",
      payload: { fixture: "f3", from: { at: D, court: "C2" }, to: { at: C, court: "C1" } },
    },
    undoneHead: S0,
    touches: ["f3"],
    untouched: "f1",
  },
  {
    // Today's emitter (schedule.ts) carries venue and locked on both sides.
    name: "schedule_edited with a lock flag moves and locks; its undo unlocks",
    type: "schedule_edited",
    prior: PRIOR,
    before: S0,
    payload: {
      fixture: "f1",
      from: { at: A, court: "C1", venue: "v1", locked: false },
      to: { at: D, court: "C2", venue: "v1", locked: true },
    },
    after: { f1: fx(true, D, "C2", true), f2: S0.f2!, f3: S0.f3! },
    inverse: {
      type: "schedule_edited",
      payload: {
        fixture: "f1",
        from: { at: D, court: "C2", venue: "v1", locked: true },
        to: { at: A, court: "C1", venue: "v1", locked: false },
      },
    },
    undoneHead: S0,
    touches: ["f1"],
    untouched: "f2",
  },
  {
    // clearSchedule with excludeLocked false: the slot goes, the lock flag stays
    // (the executor nulls scheduled_at/court_id and never touches schedule_locked).
    name: "schedule_cleared unplaces two fixtures, the locked one keeps its lock",
    type: "schedule_cleared",
    prior: PRIOR,
    before: S0,
    payload: { scope: { excludeLocked: false }, cleared: CLEARED_F1_F3 },
    after: AFTER_CLEAR_F1_F3,
    inverse: { type: "schedule_restored", payload: { restored: CLEARED_F1_F3 } },
    undoneHead: S0,
    touches: ["f1", "f3"],
    untouched: "f2",
  },
  {
    // An inverse becomes an Undo target once a fresh edit has moved the
    // watermark past it; here it is the newest registry event.
    name: "schedule_restored puts two cleared fixtures back in their slots",
    type: "schedule_restored",
    prior: [...PRIOR, ev(4, "schedule_cleared", { scope: { excludeLocked: false }, cleared: CLEARED_F1_F3 })],
    before: AFTER_CLEAR_F1_F3,
    payload: { restored: CLEARED_F1_F3 },
    after: S0,
    inverse: { type: "schedule_cleared", payload: { cleared: CLEARED_F1_F3 } },
    undoneHead: AFTER_CLEAR_F1_F3,
    touches: ["f1", "f3"],
    untouched: "f2",
  },
  {
    name: "fixtures_generated adds a second stage's fixtures, unscheduled",
    type: "fixtures_generated",
    prior: PRIOR,
    before: S0,
    payload: { stage_id: "s2", fixture_ids: ["g1", "g2"] },
    after: { ...S0, g1: fx(true, null, null), g2: fx(true, null, null) },
    // No `fixtures` key: a generation that carried no snapshot hands none on.
    inverse: { type: "fixtures_cleared", payload: { stage_id: "s2", fixture_ids: ["g1", "g2"] } },
    undoneHead: { ...S0, g1: fx(false, null, null), g2: fx(false, null, null) },
    touches: ["g1", "g2"],
    untouched: "f1",
  },
  {
    // The re-insert form (an Undo of a clear): the row snapshot rides along.
    name: "fixtures_generated carrying row snapshots hands them to its inverse",
    type: "fixtures_generated",
    prior: PRIOR,
    before: S0,
    payload: { stage_id: "s2", fixture_ids: ["g1"], fixtures: [{ id: "g1", stage_id: "s2", round_no: 1 }] },
    after: { ...S0, g1: fx(true, null, null) },
    inverse: {
      type: "fixtures_cleared",
      payload: { stage_id: "s2", fixture_ids: ["g1"], fixtures: [{ id: "g1", stage_id: "s2", round_no: 1 }] },
    },
    undoneHead: { ...S0, g1: fx(false, null, null) },
    touches: ["g1"],
    untouched: "f1",
  },
  {
    // Deleting rows unplaces them; the lock flag is the row's and is not read
    // again (a restore re-inserts from the snapshot).
    name: "fixtures_cleared deletes a stage's fixtures and hands their snapshots to its inverse",
    type: "fixtures_cleared",
    prior: PRIOR,
    before: S0,
    payload: {
      stage_id: "s1",
      fixture_ids: ["f1", "f2", "f3"],
      fixtures: [
        { id: "f1", stage_id: "s1", at: A, court: "C1" },
        { id: "f2", stage_id: "s1", at: B, court: "C2" },
        { id: "f3", stage_id: "s1", at: C, court: "C1", locked: true },
      ],
    },
    after: { f1: fx(false, null, null), f2: fx(false, null, null), f3: fx(false, null, null, true) },
    inverse: {
      type: "fixtures_generated",
      payload: {
        stage_id: "s1",
        fixture_ids: ["f1", "f2", "f3"],
        fixtures: [
          { id: "f1", stage_id: "s1", at: A, court: "C1" },
          { id: "f2", stage_id: "s1", at: B, court: "C2" },
          { id: "f3", stage_id: "s1", at: C, court: "C1", locked: true },
        ],
      },
    },
    // The app re-inserts these rows WITH their slots (restoreFixtures); the
    // fold's fixtures_generated only marks them existing and does not read the
    // snapshot's at/court. No production code reads the fold today
    // (scheduleStateAt has no caller), so that gap is recorded in the
    // mutation-debt report rather than frozen here: only `exists` is asserted.
    undoneHead: "exists",
    touches: ["f1", "f2", "f3"],
    untouched: "x9",
  },
  {
    // A legacy clear with no snapshot: the inverse re-runs the generator, which
    // makes unscheduled rows.
    name: "fixtures_cleared without snapshots hands none on",
    type: "fixtures_cleared",
    prior: PRIOR,
    before: S0,
    payload: { stage_id: "s1", fixture_ids: ["f1"] },
    after: { f1: fx(false, null, null), f2: S0.f2!, f3: S0.f3! },
    inverse: { type: "fixtures_generated", payload: { stage_id: "s1", fixture_ids: ["f1"] } },
    undoneHead: { f1: fx(true, null, null), f2: S0.f2!, f3: S0.f3! },
    touches: ["f1"],
    untouched: "f2",
  },
  {
    name: "pool_entrants_cleared drops a pool's fixtures",
    type: "pool_entrants_cleared",
    prior: PRIOR,
    before: S0,
    payload: { pool_id: "pA", fixtures: POOL_A },
    after: AFTER_POOL_A_CLEAR,
    inverse: { type: "pool_entrants_restored", payload: { pool_id: "pA", fixtures: POOL_A } },
    undoneHead: S0,
    touches: ["f1", "f2"],
    untouched: "f3",
  },
  {
    name: "pool_entrants_restored re-inserts a pool's fixtures in their slots",
    type: "pool_entrants_restored",
    prior: [...PRIOR, ev(4, "pool_entrants_cleared", { pool_id: "pA", fixtures: POOL_A })],
    before: AFTER_POOL_A_CLEAR,
    payload: { pool_id: "pA", fixtures: POOL_A },
    after: S0,
    inverse: { type: "pool_entrants_cleared", payload: { pool_id: "pA", fixtures: POOL_A } },
    undoneHead: AFTER_POOL_A_CLEAR,
    touches: ["f1", "f2"],
    untouched: "f3",
  },
];

function blocked(fn: () => unknown): void {
  expect(fn).toThrowError(expect.objectContaining({ code: "UNDO_BLOCKED_HAS_RESULTS" }));
}

describe("ReversibleOp registry — every declared type, edit → undo → redo (Jul3/03 §3)", () => {
  it("the rows cover the documented registry, and only it", () => {
    expect([...Object.keys(REVERSIBLE)].sort()).toEqual([...REGISTRY].sort());
    const covered = new Set(ROWS.map((r) => r.type));
    expect([...covered].sort(), "every registry type has a row").toEqual([...REGISTRY].sort());
    for (const t of REGISTRY) expect(isReversible(t), t).toBe(true);
    for (const t of ["participants_imported", "officials_assigned", "stage_created", ""]) {
      expect(isReversible(t), t).toBe(false);
    }
  });

  let checked = 0;
  for (const row of ROWS) {
    it(row.name, () => {
      const n = row.prior[row.prior.length - 1]!.seq + 1;
      expect(fold(row.prior, null).fixtures, "the prior folds to `before`").toStrictEqual(row.before);

      // The edit lands.
      const ledger = [...row.prior, ev(n, row.type, row.payload)];
      expect(fold(ledger, null).fixtures).toStrictEqual(row.after);
      expect(fold(ledger, n - 1).fixtures, "a watermark below the edit excludes it").toStrictEqual(row.before);

      // Undo: the exact inverse, stamped, and the watermark back on the prior.
      const step = undo(ledger, null, NONE);
      expect(step).toStrictEqual({
        event: { type: row.inverse.type, payload: { ...row.inverse.payload, __undo_of: n } },
        newWatermark: n - 1,
      });
      const undone = [...ledger, ev(n + 1, step.event.type, step.event.payload)];
      expect(fold(undone, step.newWatermark).fixtures).toStrictEqual(row.before);
      const head = fold(undone, null).fixtures;
      if (row.undoneHead === "exists") {
        for (const id of row.touches) expect(head[id]?.exists, `${id} exists again at head`).toBe(true);
      } else {
        expect(head, "apply ∘ invert at head").toStrictEqual(row.undoneHead);
      }

      // Redo: an audit copy of the ORIGINAL, and the watermark back on it.
      const again = redo(undone, step.newWatermark, NONE);
      expect(again).toStrictEqual({
        event: { type: row.type, payload: { ...row.payload, __redo_of: n } },
        newWatermark: n,
      });
      const redone = [...undone, ev(n + 2, again.event.type, again.event.payload)];
      expect(fold(redone, again.newWatermark).fixtures).toStrictEqual(row.after);
      expect(fold(redone, null).fixtures, "inverse + copy at head").toStrictEqual(row.after);

      // Second Redo: only the inverse and the copy lie beyond — neither is an
      // original edit.
      expect(() => redo(redone, again.newWatermark, NONE)).toThrowError(
        expect.objectContaining({ code: "NOTHING_TO_REDO" }),
      );

      // Results-guard, both directions, one played fixture at a time.
      expect(row.touches.length).toBeGreaterThan(0);
      for (const id of row.touches) {
        blocked(() => undo(ledger, null, new Set([id])));
        blocked(() => redo(undone, step.newWatermark, new Set([id])));
      }
      // ...and its positive pair: a played fixture the edit does not touch.
      expect(row.touches).not.toContain(row.untouched);
      expect(undo(ledger, null, new Set([row.untouched]))).toStrictEqual(step);
      expect(redo(undone, step.newWatermark, new Set([row.untouched]))).toStrictEqual(again);
      checked++;
    });
  }

  it("the sweep ran every row", () => {
    expect(checked).toBe(ROWS.length);
    expect(checked).toBeGreaterThanOrEqual(REGISTRY.length);
  });
});

describe("registry payloads with nothing in them", () => {
  // Each of these reads a LIST off its payload (moves / cleared / restored /
  // fixture_ids / fixtures). An absent list is no fixtures, never a crash and
  // never a phantom fixture. schedule_edited is not here: its payload names
  // its one fixture by construction (schedule.ts), it has no list to lack.
  const LIST_TYPES = REGISTRY.filter((t) => t !== "schedule_edited");

  it("folds to no fixtures and touches none", () => {
    expect(LIST_TYPES.length).toBe(REGISTRY.length - 1);
    for (const t of LIST_TYPES) {
      expect(fold([ev(1, t, {})], null), t).toStrictEqual({ fixtures: {} });
      expect(REVERSIBLE[t]!.affected({}), t).toEqual([]);
      // nothing touched, so a played fixture elsewhere does not block it
      expect(() => undo([ev(1, t, {})], null, new Set(["f1"])), t).not.toThrow();
    }
  });
});

describe("fold over a ledger that holds other division events", () => {
  it("skips non-registry events instead of failing on them", () => {
    const events = [
      ev(1, "participants_imported", { import_id: "x" }),
      ev(2, "schedule_edited", { fixture: "f1", from: { at: null, court: null }, to: { at: A, court: "C1" } }),
      ev(3, "officials_assigned", { applied: 4 }),
    ];
    expect(fold(events, null)).toStrictEqual({ fixtures: { f1: fx(true, A, "C1") } });
    expect(fold(events, 1)).toStrictEqual({ fixtures: {} });
  });

  it("a ledger of only non-registry events has nothing to undo or redo", () => {
    const events = [ev(1, "participants_imported", { import_id: "x" })];
    expect(() => undo(events, null, NONE)).toThrowError(expect.objectContaining({ code: "NOTHING_TO_UNDO" }));
    expect(() => redo(events, 0, NONE)).toThrowError(expect.objectContaining({ code: "NOTHING_TO_REDO" }));
  });
});
