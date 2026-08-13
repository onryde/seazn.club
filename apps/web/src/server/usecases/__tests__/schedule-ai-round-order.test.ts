// C1 gap B — the AI planning path could not see round order at all.
//
// `toEngineAssignments(plan, pack)` used to build its `Assignment`s with
// exactly `fixtureId`/`court`/`startAt`/`endAt`/`entrants`/`people`/`poolId`/
// `divisionId` — no `roundNo`, no `stageId`. `calendar.ts`'s round-order pair
// scan groups by `(divisionId, stageId, poolId)` and skips any assignment
// missing `roundNo` outright, so every AI-plan assignment landed in one
// anonymous, round-blind bucket: an AI-drafted board could schedule a final
// before its group stage finished and the referee would say nothing.
//
// No database: `toEngineAssignments`/`verifyConfig` are pure over a
// `SchedulePack`, exactly like `schedule-group-targeting.test.ts`'s
// `poolIds` coverage this file is modelled on. The pack-BUILD side (does
// `buildSchedulePack` populate `stageIds`/`roundNos` correctly off real DB
// rows, gated on a real `roundRobinStageIds` lookup?) is covered separately,
// against a real division, in `schedule-ai-pack.test.ts`.
import { describe, expect, it } from "vitest";
import { makeClock, validateAssignments, type Conflict } from "@seazn/engine/scheduling";
import type { AiSchedulePlan } from "../schedule-ai-prompt";
import { toEngineAssignments, verifyConfig, type PackFixture, type SchedulePack } from "../schedule-ai";

const MIN = 60_000;
const T0 = Date.parse("2026-08-10T09:00:00.000Z");
const iso = (t: number) => new Date(t).toISOString();

const DIV_A = "11111111-1111-4111-8111-111111111111";

interface FixtureSpec {
  id: string;
  round: number;
  stageId: string;
  /** Whether THIS fixture's stage is round-robin-kind — i.e. whether
   *  `buildSchedulePack`'s `roundRobin.has(f.stage_id)` gate would have let
   *  it into `pack.roundNos`. Modelled here as an explicit per-fixture flag
   *  rather than a derived stage-kind lookup, matching how these hand-built
   *  packs stand in for the DB row shape throughout this file's sibling
   *  suites (`schedule-group-targeting.test.ts`'s `poolIds`). */
  roundRobin: boolean;
  home: string | null;
  away: string | null;
}

// A hand-built pack, exactly the shape `buildSchedulePack` produces, but
// authored directly rather than built off DB rows — see the file header.
function pack(fixtures: FixtureSpec[]): SchedulePack {
  const movable: PackFixture[] = fixtures.map((f, i) => ({
    id: f.id,
    ext_key: null,
    round: f.round,
    seq: i,
    pool: null,
    home: f.home,
    away: f.away,
    feeds: { winner_to: null, after: [] },
    current: { at: null, court: null },
    pinned: false,
  }));
  return {
    mode: "generate",
    division: { id: DIV_A, name: "Div A", sport: "generic", tz: "UTC" },
    tz: "UTC",
    clock: makeClock(T0, "UTC"),
    window: { start: "2026-08-10", end: "2026-08-17" },
    sessionHours: { start: "08:00", end: "22:00" },
    settings: {
      matchMinutes: 30,
      gapMinutes: 0,
      perEntrantMinRest: 0,
      courts: ["Court 1", "Court 2", "Court 3", "Court 4"],
      sessionWindows: [],
      blackouts: [],
      constraints: {
        noBackToBack: false,
        startWindows: [],
        fieldFairness: "off",
        parallelism: "mixed",
        crossPersonClash: "warn",
      },
    },
    entrants: [],
    people: [],
    participants: Object.fromEntries(fixtures.map((f) => [f.id, [] as string[]])),
    poolIds: {},
    // THE POINT OF THIS FILE. `stageIds` unconditional — mirrors
    // `buildSchedulePack`'s own map, total over every movable fixture.
    // `roundNos` gated on `f.roundRobin` — mirrors `roundRobin.has(f.
    // stage_id)`, the gate a bracket/swiss/stepladder fixture must NOT pass.
    stageIds: Object.fromEntries(fixtures.map((f) => [f.id, f.stageId] as const)),
    roundNos: Object.fromEntries(
      fixtures.filter((f) => f.roundRobin).map((f) => [f.id, f.round] as const),
    ),
    assumptions: [],
    parsed: { hard: [], soft: [], unparsed: [] },
    fixtures: { movable, obstacles: [] },
    draft: [],
    instruction: "",
    prior: null,
    officials: [],
  };
}

function plan(
  assignments: { fixture_id: string; scheduled_at: string; court_label: string }[],
): AiSchedulePlan {
  return { assignments, unschedulable: [], explanations: [], summary: "" };
}

function conflictsFor(
  fixtures: FixtureSpec[],
  assignments: { fixture_id: string; scheduled_at: string; court_label: string }[],
): Conflict[] {
  const p = pack(fixtures);
  return validateAssignments(toEngineAssignments(plan(assignments), p), verifyConfig(p));
}

describe("round order through the single-division AI adapter (C1 gap B)", () => {
  const RR_STAGE = "stage-rr";
  const RR_FIXTURES: FixtureSpec[] = [
    { id: "f-1", round: 1, stageId: RR_STAGE, roundRobin: true, home: "e1", away: "e2" },
    { id: "f-2", round: 2, stageId: RR_STAGE, roundRobin: true, home: "e3", away: "e4" },
  ];

  it("flags an AI plan that schedules a later round before an earlier one", () => {
    // f-2 (round 2) at 09:00, f-1 (round 1) an hour later — the AI plan
    // schedules the later round first. Different entrants and courts, zero
    // rest floor: nothing else can produce a conflict here, so any conflict
    // at all is the round-order scan.
    const conflicts = conflictsFor(RR_FIXTURES, [
      { fixture_id: "f-1", scheduled_at: iso(T0 + 60 * MIN), court_label: "Court 1" },
      { fixture_id: "f-2", scheduled_at: iso(T0), court_label: "Court 2" },
    ]);
    expect(conflicts.map((c) => c.reason)).toContain("order");
    // Blamed on the LATER round (calendar.ts's own convention: the side with
    // a "must not start before" obligation) — f-2, not f-1.
    expect(conflicts.find((c) => c.reason === "order")?.fixtureId).toBe("f-2");
  });

  it("does not flag an AI plan that respects round order", () => {
    const conflicts = conflictsFor(RR_FIXTURES, [
      { fixture_id: "f-1", scheduled_at: iso(T0), court_label: "Court 1" },
      { fixture_id: "f-2", scheduled_at: iso(T0 + 60 * MIN), court_label: "Court 2" },
    ]);
    expect(conflicts.map((c) => c.reason)).not.toContain("order");
  });

  it("does not treat a non-round-robin stage's round_no as round-robin order", () => {
    // Same shape as the violation test above — f-br-2 (round 2) scheduled
    // BEFORE f-br-1 (round 1) — but this is a bracket stage: round_no here
    // is `stages.ts`'s display numbering (semis are "round 2" for the
    // bracket panel), never round-robin sequence. Forwarding it ungated is
    // the exact regression this feature exists to prevent.
    const BRACKET_FIXTURES: FixtureSpec[] = [
      { id: "f-br-1", round: 1, stageId: "stage-bracket", roundRobin: false, home: "e1", away: "e2" },
      { id: "f-br-2", round: 2, stageId: "stage-bracket", roundRobin: false, home: "e3", away: "e4" },
    ];
    const conflicts = conflictsFor(BRACKET_FIXTURES, [
      { fixture_id: "f-br-1", scheduled_at: iso(T0 + 60 * MIN), court_label: "Court 1" },
      { fixture_id: "f-br-2", scheduled_at: iso(T0), court_label: "Court 2" },
    ]);
    expect(conflicts.map((c) => c.reason)).not.toContain("order");
  });

  it("does not collide two independent round-robin stages in the same division", () => {
    // Two DIFFERENT round-robin stages (both unpooled, so poolId is absent on
    // every fixture — the shape that made `stageId` necessary in the key at
    // all: `(divisionId, poolId)` alone would collapse them into one bucket).
    // Stage A runs in the morning, Stage B in the afternoon; each is clean
    // internally. Stage B's round 1 (15:00) sits AFTER Stage A's round 2
    // (10:00) — if the two stages were compared as one sequence (stageId
    // dropped or ignored), that pair reads as "round 2 starts before round
    // 1" and would be flagged. They must not be, because they are different
    // sequences.
    const STAGE_A = "stage-rr-a";
    const STAGE_B = "stage-rr-b";
    const FIXTURES: FixtureSpec[] = [
      { id: "f-a1", round: 1, stageId: STAGE_A, roundRobin: true, home: "e1", away: "e2" },
      { id: "f-a2", round: 2, stageId: STAGE_A, roundRobin: true, home: "e3", away: "e4" },
      { id: "f-b1", round: 1, stageId: STAGE_B, roundRobin: true, home: "e5", away: "e6" },
      { id: "f-b2", round: 2, stageId: STAGE_B, roundRobin: true, home: "e7", away: "e8" },
    ];
    const assignments = [
      { fixture_id: "f-a1", scheduled_at: iso(T0), court_label: "Court 1" }, // 09:00
      { fixture_id: "f-a2", scheduled_at: iso(T0 + 60 * MIN), court_label: "Court 2" }, // 10:00
      { fixture_id: "f-b1", scheduled_at: iso(T0 + 6 * 60 * MIN), court_label: "Court 3" }, // 15:00
      { fixture_id: "f-b2", scheduled_at: iso(T0 + 7 * 60 * MIN), court_label: "Court 4" }, // 16:00
    ];
    expect(conflictsFor(FIXTURES, assignments).map((c) => c.reason)).not.toContain("order");

    // Non-vacuous: `toEngineAssignments` must actually be carrying the two
    // stages as DISTINCT `stageId`s, not just happening to produce no
    // conflict for some other reason (e.g. a config that skips the scan
    // outright — see the gating test above for that guard from a different
    // angle).
    const p = pack(FIXTURES);
    const out = toEngineAssignments(plan(assignments), p);
    const stageIdOf = (id: string) => out.find((a) => a.fixtureId === id)?.stageId;
    expect(stageIdOf("f-a1")).toBe(STAGE_A);
    expect(stageIdOf("f-b1")).toBe(STAGE_B);
    expect(stageIdOf("f-a1")).not.toBe(stageIdOf("f-b1"));
  });

  it("toEngineAssignments carries stageId unconditionally and roundNo only when round-robin", () => {
    // Direct field-forwarding assertion — asserted so a future regression
    // fails here with a readable message, matching
    // `schedule-group-targeting.test.ts`'s "toEngineAssignments carries the
    // pool and division the pack already holds".
    const FIXTURES: FixtureSpec[] = [
      { id: "f-rr", round: 3, stageId: "stage-rr", roundRobin: true, home: "e1", away: "e2" },
      { id: "f-br", round: 3, stageId: "stage-bracket", roundRobin: false, home: "e3", away: "e4" },
    ];
    const p = pack(FIXTURES);
    const [rr, br] = toEngineAssignments(
      plan([
        { fixture_id: "f-rr", scheduled_at: iso(T0), court_label: "Court 1" },
        { fixture_id: "f-br", scheduled_at: iso(T0), court_label: "Court 2" },
      ]),
      p,
    );
    expect(rr!.stageId).toBe("stage-rr");
    expect(rr!.roundNo).toBe(3);
    expect(br!.stageId).toBe("stage-bracket");
    // Absent, not `undefined` written explicitly — the convention every
    // other gated field in this codebase uses (see `SchedulableFixture`'s
    // own `poolId`/`roundNo` spreads), and what keeps a `"roundNo" in a`
    // check meaningful.
    expect("roundNo" in br!).toBe(false);
  });
});
