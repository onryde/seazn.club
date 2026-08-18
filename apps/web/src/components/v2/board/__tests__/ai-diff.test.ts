// Client-side schedule diff (v4 Task 13). The engine's verified proposal ships a
// server `diff` (id arrays); the panel needs the same buckets enriched with
// from→to provenance to render the "why it did that" list and colour the grid
// ghosts. computeAiDiff is the pure recomputation — asserted here to bucket the
// same ids the server did (a regression guard on the client/server contract) and
// to carry the correct current→proposed slots.
import { describe, expect, it } from "vitest";
import type { AiPlanResponse } from "@/server/api-v1/schemas";
import { computeAiDiff, ghostToneFor, type AiFixtureRef } from "../ai-diff";

// Four fixtures, one per bucket:
//  - MOVE  was Court B · 13:30  → Court A · 14:00
//  - PLACE was unscheduled (tray) → Court B · 13:30
//  - DROP  was Court A · 15:00  → not in proposal (falls to the tray)
//  - KEEP  Court A · 13:00 unchanged
const MOVE = "11111111-1111-1111-1111-111111111111";
const PLACE = "22222222-2222-2222-2222-222222222222";
const DROP = "33333333-3333-3333-3333-333333333333";
const KEEP = "44444444-4444-4444-4444-444444444444";
// Real court identities (P9 review finding 3). `AiFixtureRef.court_label` is
// FROZEN and always null on a board-sourced fixture (consoleFixtures,
// schedule-board.tsx sets `court_label: f.court_label ?? null`
// unconditionally) — `court_id` is the only real identity the board side
// carries. The plan's `court_label` field, despite the legacy name, carries
// this SAME kind of court uuid: the model's picked label is resolved back to
// a real id before the response leaves the server
// (resolveModelCourtLabels). A fixture data set that uses matching plain
// strings on both sides (e.g. "Court 1") never reproduces the bug — it
// happens to compare equal by accident.
const COURT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const COURT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const current: AiFixtureRef[] = [
  { id: MOVE, scheduled_at: "2026-08-01T13:30:00+01:00", court_label: null, court_id: COURT_B },
  { id: PLACE, scheduled_at: null, court_label: null, court_id: null },
  { id: DROP, scheduled_at: "2026-08-01T15:00:00+01:00", court_label: null, court_id: COURT_A },
  { id: KEEP, scheduled_at: "2026-08-01T13:00:00+01:00", court_label: null, court_id: COURT_A },
];

const plan: AiPlanResponse = {
  proposal: [
    { fixture_id: MOVE, scheduled_at: "2026-08-01T14:00:00+01:00", court_label: COURT_A },
    { fixture_id: PLACE, scheduled_at: "2026-08-01T13:30:00+01:00", court_label: COURT_B },
    { fixture_id: KEEP, scheduled_at: "2026-08-01T13:00:00+01:00", court_label: COURT_A },
  ],
  unschedulable: [],
  warnings: [],
  blocking: [],
  // Server truth — computeAiDiff must bucket exactly these ids.
  diff: { moved: [MOVE], placed: [PLACE], unscheduled: [DROP], unchanged: [KEEP] },
  explanations: [],
  summary: "Placed the tray fixture and nudged the semi to keep the court clear.",
  // W5 (#400): the architect's own assumptions, always an array.
  assumptions: [],
  usage: { input_tokens: 1240, output_tokens: 860, repair_rounds: 1 },
  repair: { engine: "none" as const, solver_ran: false },
  officials_coverage: null,
};

describe("computeAiDiff", () => {
  const diff = computeAiDiff(plan, current);

  it("puts each fixture in exactly one bucket", () => {
    expect(diff.moved.map((m) => m.fixture_id)).toEqual([MOVE]);
    expect(diff.placed.map((p) => p.fixture_id)).toEqual([PLACE]);
    expect(diff.unscheduled.map((u) => u.fixture_id)).toEqual([DROP]);
    expect(diff.unchanged.map((u) => u.fixture_id)).toEqual([KEEP]);
  });

  it("bucket membership matches the server diff exactly", () => {
    expect(diff.moved.map((m) => m.fixture_id).sort()).toEqual([...plan.diff.moved].sort());
    expect(diff.placed.map((p) => p.fixture_id).sort()).toEqual([...plan.diff.placed].sort());
    expect(diff.unscheduled.map((u) => u.fixture_id).sort()).toEqual([...plan.diff.unscheduled].sort());
    expect(diff.unchanged.map((u) => u.fixture_id).sort()).toEqual([...plan.diff.unchanged].sort());
  });

  it("carries from→to provenance on a move", () => {
    expect(diff.moved[0]).toEqual({
      fixture_id: MOVE,
      from: { scheduled_at: "2026-08-01T13:30:00+01:00", court_label: null },
      to: { scheduled_at: "2026-08-01T14:00:00+01:00", court_label: COURT_A },
    });
  });

  it("a placed fixture carries only its destination", () => {
    expect(diff.placed[0]).toEqual({
      fixture_id: PLACE,
      to: { scheduled_at: "2026-08-01T13:30:00+01:00", court_label: COURT_B },
    });
  });

  it("an unscheduled fixture carries only where it left", () => {
    expect(diff.unscheduled[0]).toEqual({
      fixture_id: DROP,
      from: { scheduled_at: "2026-08-01T15:00:00+01:00", court_label: null },
    });
  });

  it("treats a same-instant / same-court proposal as unchanged even if the ISO string differs", () => {
    const restated: AiPlanResponse = {
      ...plan,
      proposal: [{ fixture_id: KEEP, scheduled_at: "2026-08-01T12:00:00Z", court_label: COURT_A }],
      diff: { moved: [], placed: [], unscheduled: [MOVE, DROP], unchanged: [KEEP] },
    };
    const d = computeAiDiff(restated, current);
    expect(d.moved).toEqual([]);
    expect(d.unchanged.map((u) => u.fixture_id)).toEqual([KEEP]);
  });
});

// P9 review wave 1, finding 3 (HIGH): `sameSlot` used to compare the board's
// `court_label` (always null — the field is frozen, consoleFixtures never
// sets it) against the plan's `court_label` (a real court uuid). Those two
// values can never be equal, so a plan that changed NOTHING still bucketed
// every scheduled fixture as "moved" — a full reshuffle read on every run.
// Fails on a reverted `sameSlot` (compares `court_label` on both sides).
describe("computeAiDiff — no-op plan (P9 review wave 1, finding 3)", () => {
  it("produces zero moved rows when the proposal repeats today's board exactly", () => {
    const board: AiFixtureRef[] = [
      { id: MOVE, scheduled_at: "2026-08-01T13:00:00+01:00", court_label: null, court_id: COURT_A },
      { id: KEEP, scheduled_at: "2026-08-01T14:00:00+01:00", court_label: null, court_id: COURT_B },
    ];
    const noOp: AiPlanResponse = {
      ...plan,
      proposal: [
        { fixture_id: MOVE, scheduled_at: "2026-08-01T13:00:00+01:00", court_label: COURT_A },
        { fixture_id: KEEP, scheduled_at: "2026-08-01T14:00:00+01:00", court_label: COURT_B },
      ],
      diff: { moved: [], placed: [], unscheduled: [], unchanged: [MOVE, KEEP] },
    };
    const d = computeAiDiff(noOp, board);
    expect(d.moved).toEqual([]);
    expect(d.unchanged.map((u) => u.fixture_id).sort()).toEqual([KEEP, MOVE].sort());
  });
});

describe("ghostToneFor", () => {
  const diff = computeAiDiff(plan, current);
  const blocking = new Set<string>();

  it("maps each bucket to its state-palette tone", () => {
    expect(ghostToneFor(MOVE, diff, blocking)).toBe("moved");
    expect(ghostToneFor(PLACE, diff, blocking)).toBe("placed");
    expect(ghostToneFor(KEEP, diff, blocking)).toBe("unchanged");
  });

  it("blocking wins over the diff bucket (red trumps amber/teal)", () => {
    expect(ghostToneFor(MOVE, diff, new Set([MOVE]))).toBe("blocking");
  });
});
