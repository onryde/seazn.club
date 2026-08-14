// Calendar slotting — spec 05 §2.6, doc 06 §4.3, doc 12.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  slotFixtures,
  validateAssignments,
  type Assignment,
  type SchedulableFixture,
  type SlotConfig,
} from "./calendar.ts";

const MIN = 60_000;
const baseConfig = (over: Partial<SlotConfig> = {}): SlotConfig => ({
  startAt: 0,
  matchMinutes: 30,
  gapMinutes: 5,
  courts: ["C1"],
  perEntrantMinRest: 0,
  ...over,
});

describe("slotFixtures — greedy placement (spec 05 §2.6)", () => {
  it("packs one court sequentially with the configured gap", () => {
    const fixtures: SchedulableFixture[] = [
      { id: "f1", roundNo: 1, home: "A", away: "B" },
      { id: "f2", roundNo: 1, home: "C", away: "D" },
      { id: "f3", roundNo: 1, home: "E", away: "F" },
    ];
    const { assignments, conflicts } = slotFixtures({ fixtures, config: baseConfig() });
    expect(conflicts).toHaveLength(0);
    const times = assignments.map((a) => a.startAt).sort((x, y) => x - y);
    // 30-min matches + 5-min gap ⇒ starts at 0, 35, 70 minutes.
    expect(times).toEqual([0, 35 * MIN, 70 * MIN]);
  });

  it("spreads across courts before stacking", () => {
    const fixtures: SchedulableFixture[] = [
      { id: "f1", roundNo: 1, home: "A", away: "B" },
      { id: "f2", roundNo: 1, home: "C", away: "D" },
    ];
    const { assignments } = slotFixtures({ fixtures, config: baseConfig({ courts: ["C1", "C2"] }) });
    // Both can start at 0 on different courts.
    expect(new Set(assignments.map((a) => a.court))).toEqual(new Set(["C1", "C2"]));
    expect(assignments.every((a) => a.startAt === 0)).toBe(true);
  });

  it("honours per-entrant rest between an entrant's matches", () => {
    const fixtures: SchedulableFixture[] = [
      { id: "f1", roundNo: 1, home: "A", away: "B" },
      { id: "f2", roundNo: 2, home: "A", away: "C" }, // A plays again
    ];
    const { assignments } = slotFixtures({
      fixtures,
      config: baseConfig({ courts: ["C1", "C2"], perEntrantMinRest: 60 }),
    });
    const f1 = assignments.find((a) => a.fixtureId === "f1") as Assignment;
    const f2 = assignments.find((a) => a.fixtureId === "f2") as Assignment;
    expect(f2.startAt - f1.endAt).toBeGreaterThanOrEqual(60 * MIN);
  });

  it("never schedules inside a blackout window", () => {
    const fixtures: SchedulableFixture[] = [{ id: "f1", roundNo: 1, home: "A", away: "B" }];
    const { assignments } = slotFixtures({
      fixtures,
      config: baseConfig({ blackouts: [{ from: 0, to: 45 * MIN }] }),
    });
    expect((assignments[0] as Assignment).startAt).toBeGreaterThanOrEqual(45 * MIN);
  });

  it("avoids court+time already taken by a sibling division (doc 06 §4.3)", () => {
    const existing: Assignment[] = [
      { fixtureId: "sib", court: "C1", startAt: 0, endAt: 30 * MIN, entrants: ["X"], people: [] },
    ];
    const fixtures: SchedulableFixture[] = [{ id: "f1", roundNo: 1, home: "A", away: "B" }];
    const { assignments } = slotFixtures({ fixtures, config: baseConfig(), existing });
    // C1 is busy 0–30 (+5 gap) ⇒ our fixture starts at 35.
    expect((assignments[0] as Assignment).startAt).toBe(35 * MIN);
  });

  it("moves a per-person overlap across divisions off the clash, rather than warning", () => {
    // Was "warns (does not block)" until #399 made the write gate absolute for
    // an INTRODUCED person overlap whatever `crossPersonClash` says. A placer
    // that took the free court here proposed a board the gate then refused, and
    // re-running Auto proposed it again. It now steps past the sibling card.
    // The warning still exists for an overlap the placer did not introduce —
    // see the locked case in calendar-person-clash-placement.test.ts.
    const existing: Assignment[] = [
      { fixtureId: "sib", court: "C9", startAt: 0, endAt: 30 * MIN, entrants: ["X"], people: ["kid1"] },
    ];
    const fixtures: SchedulableFixture[] = [
      { id: "f1", roundNo: 1, home: "A", away: "B", people: ["kid1"] },
    ];
    const { assignments, conflicts } = slotFixtures({
      fixtures,
      config: baseConfig({ courts: ["C1"] }),
      existing,
    });
    // C1 is free the whole time — only kid1 can move this card, so the start
    // time is the assertion that a court-only dodge would fail.
    expect(assignments).toHaveLength(1);
    expect((assignments[0] as Assignment).startAt).toBeGreaterThanOrEqual(30 * MIN);
    expect(conflicts.some((c) => c.reason === "person_overlap")).toBe(false);
  });

  it("honours a locked slot and reports a court clash rather than moving it", () => {
    const fixtures: SchedulableFixture[] = [
      { id: "lockA", roundNo: 1, home: "A", away: "B", locked: { court: "C1", startAt: 100 * MIN } },
      { id: "lockB", roundNo: 1, home: "C", away: "D", locked: { court: "C1", startAt: 100 * MIN } },
    ];
    const { assignments, conflicts } = slotFixtures({ fixtures, config: baseConfig() });
    expect(assignments.map((a) => a.startAt)).toEqual([100 * MIN, 100 * MIN]); // both kept as pinned
    expect(conflicts.some((c) => c.reason === "court")).toBe(true);
  });

  it("reports no_slot instead of silently dropping a constraint", () => {
    const fixtures: SchedulableFixture[] = [
      { id: "f1", roundNo: 1, home: "A", away: "B" },
      { id: "f2", roundNo: 1, home: "C", away: "D" },
    ];
    // One court, horizon shorter than the second match would need.
    const { assignments, conflicts } = slotFixtures({
      fixtures,
      config: baseConfig({ horizonMinutes: 10 }),
    });
    expect(assignments).toHaveLength(1);
    // `rule: "CAP"` since #399: nothing was placed because capacity ran out, and
    // no single rule was broken — CAP says exactly that.
    expect(conflicts).toEqual([
      { fixtureId: "f2", reason: "no_slot", details: { kind: "no_slot_horizon" }, rule: "CAP" },
    ]);
  });
});

describe("slotFixtures — session windows (doc 12 §2, PROMPT-17)", () => {
  it("schedules only inside session windows", () => {
    const fixtures: SchedulableFixture[] = [
      { id: "f1", roundNo: 1, home: "A", away: "B" },
      { id: "f2", roundNo: 1, home: "C", away: "D" },
      { id: "f3", roundNo: 2, home: "A", away: "C" },
    ];
    const windows = [
      { from: 10 * MIN, to: 45 * MIN }, // fits exactly one 30-min match
      { from: 120 * MIN, to: 300 * MIN },
    ];
    const { assignments, conflicts } = slotFixtures({
      fixtures,
      config: baseConfig({ sessionWindows: windows }),
    });
    expect(conflicts).toHaveLength(0);
    for (const a of assignments) {
      expect(windows.some((w) => a.startAt >= w.from && a.endAt <= w.to)).toBe(true);
    }
  });

  it("reports a locked slot outside every session window as a blackout", () => {
    const fixtures: SchedulableFixture[] = [
      { id: "pin", roundNo: 1, home: "A", away: "B", locked: { court: "C1", startAt: 50 * MIN } },
    ];
    const { assignments, conflicts } = slotFixtures({
      fixtures,
      config: baseConfig({ sessionWindows: [{ from: 0, to: 45 * MIN }] }),
    });
    expect(assignments).toHaveLength(1); // pin honoured, not moved
    expect(conflicts).toEqual([
      expect.objectContaining({ fixtureId: "pin", reason: "blackout" }),
    ]);
  });
});

describe("validateAssignments — board conflict report (doc 12 §2/§4)", () => {
  it("flags a court double-booking", () => {
    const a: Assignment[] = [
      { fixtureId: "x", court: "C1", startAt: 0, endAt: 30 * MIN, entrants: ["A"], people: [] },
      { fixtureId: "y", court: "C1", startAt: 10 * MIN, endAt: 40 * MIN, entrants: ["B"], people: [] },
    ];
    const conflicts = validateAssignments(a, { perEntrantMinRest: 0, gapMinutes: 0 });
    expect(conflicts.some((c) => c.reason === "court")).toBe(true);
  });

  it("flags an entrant playing two overlapping matches", () => {
    const a: Assignment[] = [
      { fixtureId: "x", court: "C1", startAt: 0, endAt: 30 * MIN, entrants: ["A"], people: [] },
      { fixtureId: "y", court: "C2", startAt: 10 * MIN, endAt: 40 * MIN, entrants: ["A"], people: [] },
    ];
    const conflicts = validateAssignments(a, { perEntrantMinRest: 0, gapMinutes: 0 });
    expect(conflicts.some((c) => c.reason === "person_overlap")).toBe(true);
  });

  it("flags a rest violation between an entrant's matches", () => {
    const a: Assignment[] = [
      { fixtureId: "x", court: "C1", startAt: 0, endAt: 30 * MIN, entrants: ["A"], people: [] },
      { fixtureId: "y", court: "C2", startAt: 40 * MIN, endAt: 70 * MIN, entrants: ["A"], people: [] },
    ];
    const conflicts = validateAssignments(a, { perEntrantMinRest: 60, gapMinutes: 0 });
    expect(conflicts.some((c) => c.reason === "rest")).toBe(true);
  });

  it("flags an assignment outside every session window", () => {
    const a: Assignment[] = [
      { fixtureId: "x", court: "C1", startAt: 50 * MIN, endAt: 80 * MIN, entrants: ["A"], people: [] },
    ];
    const conflicts = validateAssignments(a, {
      perEntrantMinRest: 0,
      gapMinutes: 0,
      sessionWindows: [{ from: 0, to: 45 * MIN }],
    });
    expect(conflicts).toEqual([
      expect.objectContaining({
        fixtureId: "x",
        reason: "blackout",
        details: { kind: "outside_session_windows" },
      }),
    ]);
  });

  it("flags a fixture scheduled before its feeder ends; direct feeds are marked", () => {
    const a: Assignment[] = [
      { fixtureId: "semi", court: "C1", startAt: 60 * MIN, endAt: 90 * MIN, entrants: [], people: [] },
      { fixtureId: "final", court: "C2", startAt: 0, endAt: 30 * MIN, entrants: [], people: [] },
    ];
    const conflicts = validateAssignments(a, { perEntrantMinRest: 0, gapMinutes: 0 }, [], [
      { fixtureId: "final", dependsOn: "semi", direct: true },
    ]);
    expect(conflicts).toEqual([
      expect.objectContaining({ fixtureId: "final", reason: "order", direct: true }),
    ]);
  });

  it("order check ignores dependencies whose feeder is not on the board", () => {
    const a: Assignment[] = [
      { fixtureId: "final", court: "C1", startAt: 0, endAt: 30 * MIN, entrants: [], people: [] },
    ];
    const conflicts = validateAssignments(a, { perEntrantMinRest: 0, gapMinutes: 0 }, [], [
      { fixtureId: "final", dependsOn: "semi", direct: true },
    ]);
    expect(conflicts).toHaveLength(0);
  });

  it("finds every seeded conflict class in one report (PROMPT-17 acceptance)", () => {
    // One board seeding all five classes: court, rest, blackout (window +
    // session), person_overlap, order.
    const a: Assignment[] = [
      { fixtureId: "c1", court: "C1", startAt: 0, endAt: 30 * MIN, entrants: ["A"], people: [] },
      { fixtureId: "c2", court: "C1", startAt: 10 * MIN, endAt: 40 * MIN, entrants: ["B"], people: [] }, // court clash
      { fixtureId: "r1", court: "C2", startAt: 35 * MIN, endAt: 65 * MIN, entrants: ["A"], people: [] }, // A rest < 60
      { fixtureId: "b1", court: "C3", startAt: 200 * MIN, endAt: 230 * MIN, entrants: ["C"], people: [] }, // blackout
      { fixtureId: "p1", court: "C4", startAt: 0, endAt: 30 * MIN, entrants: ["D"], people: ["kid"] },
      { fixtureId: "p2", court: "C5", startAt: 0, endAt: 30 * MIN, entrants: ["E"], people: ["kid"] }, // person overlap
      { fixtureId: "o1", court: "C6", startAt: 500 * MIN, endAt: 530 * MIN, entrants: [], people: [] },
      { fixtureId: "o2", court: "C7", startAt: 400 * MIN, endAt: 430 * MIN, entrants: [], people: [] }, // before feeder o1
    ];
    const conflicts = validateAssignments(
      a,
      { perEntrantMinRest: 60, gapMinutes: 0, blackouts: [{ from: 195 * MIN, to: 240 * MIN }] },
      [],
      [{ fixtureId: "o2", dependsOn: "o1", direct: true }],
    );
    const reasons = new Set(conflicts.map((c) => c.reason));
    expect(reasons).toEqual(new Set(["court", "rest", "blackout", "person_overlap", "order"]));
  });
});

// ---------------------------------------------------------------------------
// Properties — spec 05 §2.6 / §6
// ---------------------------------------------------------------------------

const fixtureArb = fc.array(
  fc.record({
    id: fc.string({ minLength: 1, maxLength: 4 }),
    roundNo: fc.integer({ min: 1, max: 5 }),
    home: fc.constantFrom("A", "B", "C", "D", "E", "F"),
    away: fc.constantFrom("A", "B", "C", "D", "E", "F"),
  }),
  { minLength: 1, maxLength: 20 },
);

describe("slotFixtures — invariants (spec 05 §6)", () => {
  it("no two assignments clash on a court (respecting the gap)", () => {
    fc.assert(
      fc.property(fixtureArb, fc.integer({ min: 1, max: 3 }), (raw, courtCount) => {
        const fixtures = dedupeIds(raw);
        const courts = Array.from({ length: courtCount }, (_, i) => `C${i}`);
        const { assignments } = slotFixtures({ fixtures, config: baseConfig({ courts, gapMinutes: 5 }) });
        for (let i = 0; i < assignments.length; i++) {
          for (let j = i + 1; j < assignments.length; j++) {
            const a = assignments[i] as Assignment;
            const b = assignments[j] as Assignment;
            if (a.court !== b.court) continue;
            const clash = a.startAt < b.endAt + 5 * MIN && b.startAt < a.endAt + 5 * MIN;
            expect(clash).toBe(false);
          }
        }
      }),
    );
  });

  it("every entrant's consecutive matches respect rest", () => {
    fc.assert(
      fc.property(fixtureArb, (raw) => {
        const fixtures = dedupeIds(raw).filter((f) => f.home !== f.away);
        const rest = 45;
        const { assignments } = slotFixtures({
          fixtures,
          config: baseConfig({ courts: ["C0", "C1", "C2"], perEntrantMinRest: rest }),
        });
        const byEntrant = new Map<string, Assignment[]>();
        for (const a of assignments) {
          for (const e of a.entrants) (byEntrant.get(e) ?? byEntrant.set(e, []).get(e)!).push(a);
        }
        for (const list of byEntrant.values()) {
          list.sort((x, y) => x.startAt - y.startAt);
          for (let i = 1; i < list.length; i++) {
            expect((list[i] as Assignment).startAt - (list[i - 1] as Assignment).endAt).toBeGreaterThanOrEqual(
              rest * MIN,
            );
          }
        }
      }),
    );
  });

  it("no assignment lands in a blackout window", () => {
    fc.assert(
      fc.property(fixtureArb, (raw) => {
        const fixtures = dedupeIds(raw);
        const blackouts = [{ from: 20 * MIN, to: 80 * MIN }];
        const { assignments } = slotFixtures({
          fixtures,
          config: baseConfig({ courts: ["C0", "C1"], blackouts }),
        });
        for (const a of assignments) {
          expect(a.startAt < 80 * MIN && 20 * MIN < a.endAt).toBe(false);
        }
      }),
    );
  });

  it("never silently drops a fixture — each is assigned or conflicted", () => {
    fc.assert(
      fc.property(fixtureArb, (raw) => {
        const fixtures = dedupeIds(raw);
        const { assignments, conflicts } = slotFixtures({ fixtures, config: baseConfig({ courts: ["C0", "C1"] }) });
        const assigned = new Set(assignments.map((a) => a.fixtureId));
        const noSlot = new Set(conflicts.filter((c) => c.reason === "no_slot").map((c) => c.fixtureId));
        for (const f of fixtures) expect(assigned.has(f.id) || noSlot.has(f.id)).toBe(true);
      }),
    );
  });

  it("re-run with all outputs locked = zero moves (PROMPT-17 acceptance)", () => {
    fc.assert(
      fc.property(fixtureArb, fc.integer({ min: 1, max: 3 }), (raw, courtCount) => {
        const fixtures = dedupeIds(raw).filter((f) => f.home !== f.away);
        const courts = Array.from({ length: courtCount }, (_, i) => `C${i}`);
        const cfg = baseConfig({ courts, perEntrantMinRest: 30 });
        const first = slotFixtures({ fixtures, config: cfg });
        const bySlot = new Map(first.assignments.map((a) => [a.fixtureId, a]));
        // Lock every placed fixture at its own output slot and re-run.
        const locked = fixtures
          .filter((f) => bySlot.has(f.id))
          .map((f) => {
            const a = bySlot.get(f.id) as Assignment;
            return { ...f, locked: { court: a.court, startAt: a.startAt } };
          });
        const second = slotFixtures({ fixtures: locked, config: cfg });
        const secondBySlot = new Map(second.assignments.map((a) => [a.fixtureId, a]));
        expect(secondBySlot.size).toBe(bySlot.size);
        for (const [id, a] of bySlot) {
          const b = secondBySlot.get(id) as Assignment;
          expect({ court: b.court, startAt: b.startAt, endAt: b.endAt }).toEqual({
            court: a.court,
            startAt: a.startAt,
            endAt: a.endAt,
          });
        }
        // A mutually consistent board re-locked must not report court clashes.
        expect(second.conflicts.filter((c) => c.reason === "court")).toHaveLength(0);
      }),
    );
  });

  it("every assignment sits fully inside a session window when windows are set", () => {
    fc.assert(
      fc.property(fixtureArb, (raw) => {
        const fixtures = dedupeIds(raw);
        const windows = [
          { from: 0, to: 90 * MIN },
          { from: 240 * MIN, to: 480 * MIN },
        ];
        const { assignments } = slotFixtures({
          fixtures,
          config: baseConfig({ courts: ["C0", "C1"], sessionWindows: windows }),
        });
        for (const a of assignments) {
          expect(windows.some((w) => a.startAt >= w.from && a.endAt <= w.to)).toBe(true);
        }
      }),
    );
  });

  it("is idempotent — identical inputs yield identical output", () => {
    fc.assert(
      fc.property(fixtureArb, (raw) => {
        const fixtures = dedupeIds(raw);
        const cfg = baseConfig({ courts: ["C0", "C1"], perEntrantMinRest: 30 });
        expect(slotFixtures({ fixtures, config: cfg })).toEqual(slotFixtures({ fixtures, config: cfg }));
      }),
    );
  });
});

// fast-check may repeat ids; the slotter keys on id, so keep them unique per case.
function dedupeIds(raw: SchedulableFixture[]): SchedulableFixture[] {
  return raw.map((f, i) => ({ ...f, id: `${f.id}-${i}` }));
}

// --- C1: round order (2026-08-12 round-order design) ------------------------
//
// For every same-division pair with round_i < round_j and at least one
// movable side: day_i <= day_j (unconditional) and, when they land on the
// same day, start_i <= start_j (ties legal). Mirrors
// `services/placement/tests/test_model.py`'s CP-SAT tests one for one — same
// day/round shapes, same expected verdicts — so the two sides can be read
// side by side even though nothing here calls into Python.
describe("validateAssignments — round order (C1, 2026-08-12 round-order design)", () => {
  const TZ = "America/Los_Angeles";
  // Sat 10:00 / 12:00 local, and Sun 10:00 local (a whole day later) — well
  // clear of any DST edge, chosen only to be two clearly distinct calendar
  // days plus two same-day ticks in the org zone.
  const DAY_A_T0 = Date.UTC(2026, 6, 11, 17, 0);
  const DAY_A_T1 = Date.UTC(2026, 6, 11, 19, 0);
  const DAY_B_T0 = Date.UTC(2026, 6, 12, 17, 0);
  const config = { perEntrantMinRest: 0, gapMinutes: 0, tz: TZ };

  const row = (over: Partial<Assignment> & Pick<Assignment, "fixtureId" | "startAt">): Assignment => ({
    court: "C1",
    endAt: over.startAt + 30 * MIN,
    entrants: [over.fixtureId], // distinct per row unless overridden — never the reason for a conflict here
    people: [],
    divisionId: "d1",
    ...over,
  });

  it("flags round order violated on the same day", () => {
    const a = [
      row({ fixtureId: "r2", startAt: DAY_A_T0, roundNo: 2, movable: true }),
      row({ fixtureId: "r1", startAt: DAY_A_T1, roundNo: 1, movable: true }),
    ];
    const conflicts = validateAssignments(a, config);
    expect(conflicts).toEqual([
      expect.objectContaining({ fixtureId: "r2", reason: "order", direct: true }),
    ]);
  });

  it("permits round order respected on the same day (ties legal)", () => {
    const a = [
      row({ fixtureId: "r2", startAt: DAY_A_T1, roundNo: 2, movable: true }),
      row({ fixtureId: "r1", startAt: DAY_A_T0, roundNo: 1, movable: true }),
    ];
    expect(validateAssignments(a, config).filter((c) => c.reason === "order")).toEqual([]);

    // Ties (identical start) are legal too, not merely "not yet checked".
    const tied = [
      row({ fixtureId: "r2", startAt: DAY_A_T0, roundNo: 2, movable: true, court: "C2" }),
      row({ fixtureId: "r1", startAt: DAY_A_T0, roundNo: 1, movable: true }),
    ];
    expect(validateAssignments(tied, config).filter((c) => c.reason === "order")).toEqual([]);
  });

  it("flags round order violated across days — the R8-on-day-1 symptom", () => {
    const a = [
      row({ fixtureId: "r2", startAt: DAY_A_T0, roundNo: 2, movable: true }),
      row({ fixtureId: "r1", startAt: DAY_B_T0, roundNo: 1, movable: true }),
    ];
    const conflicts = validateAssignments(a, config);
    expect(conflicts).toEqual([
      expect.objectContaining({ fixtureId: "r2", reason: "order", direct: true }),
    ]);
  });

  it("tolerates pin-pin round disorder", () => {
    const a = [
      row({ fixtureId: "r2", startAt: DAY_A_T0, roundNo: 2, movable: false }),
      row({ fixtureId: "r1", startAt: DAY_B_T0, roundNo: 1, movable: false }),
    ];
    expect(validateAssignments(a, config).filter((c) => c.reason === "order")).toEqual([]);
  });

  it("enforces a pin-movable round disorder", () => {
    const a = [
      row({ fixtureId: "r2-pin", startAt: DAY_A_T0, roundNo: 2, movable: false }),
      row({ fixtureId: "r1-movable", startAt: DAY_B_T0, roundNo: 1, movable: true }),
    ];
    const conflicts = validateAssignments(a, config);
    expect(conflicts).toEqual([
      expect.objectContaining({ fixtureId: "r2-pin", reason: "order", direct: true }),
    ]);
  });

  it("never constrains round-less assignments", () => {
    const a = [
      row({ fixtureId: "x", startAt: DAY_A_T0 }), // no roundNo
      row({ fixtureId: "y", startAt: DAY_B_T0 }), // no roundNo
    ];
    expect(validateAssignments(a, config).filter((c) => c.reason === "order")).toEqual([]);
  });

  it("scopes round order per division", () => {
    const a = [
      row({ fixtureId: "d1-r2", startAt: DAY_A_T0, roundNo: 2, movable: true, divisionId: "d1" }),
      row({ fixtureId: "d2-r1", startAt: DAY_B_T0, roundNo: 1, movable: true, divisionId: "d2" }),
    ];
    expect(validateAssignments(a, config).filter((c) => c.reason === "order")).toEqual([]);
  });

  it("scopes round order per pool WITHIN one division (a pooled group stage runs one independent round-robin sequence per pool)", () => {
    // Found via schedule.test.ts's "8-team group+KO division" end-to-end
    // case: `kind: "group"` with N pools calls `roundRobinGen` once PER
    // POOL, so pool A's round 2 and pool B's round 2 are two unrelated
    // "round 2"s, the same way two divisions' rounds are unrelated. Without
    // scoping by poolId this pair reads as pool B's round 1 (day B, later)
    // sitting after pool A's round 2 (day A, earlier) -- day_2 <= day_1 is
    // false, so it wrongly flags.
    const a = [
      row({
        fixtureId: "poolA-r2", startAt: DAY_A_T0, roundNo: 2, movable: true,
        divisionId: "d1", poolId: "A",
      }),
      row({
        fixtureId: "poolB-r1", startAt: DAY_B_T0, roundNo: 1, movable: true,
        divisionId: "d1", poolId: "B",
      }),
    ];
    expect(validateAssignments(a, config).filter((c) => c.reason === "order")).toEqual([]);
  });

  it("still enforces round order WITHIN one pool of a multi-pool division", () => {
    // The converse of the test above: pool scoping must narrow the
    // comparison, not disable it — two rows in the SAME pool are still
    // compared exactly as a single-pool division would be.
    const a = [
      row({
        fixtureId: "poolA-r2", startAt: DAY_A_T0, roundNo: 2, movable: true,
        divisionId: "d1", poolId: "A",
      }),
      row({
        fixtureId: "poolA-r1", startAt: DAY_B_T0, roundNo: 1, movable: true,
        divisionId: "d1", poolId: "A",
      }),
    ];
    const conflicts = validateAssignments(a, config);
    expect(conflicts).toEqual([
      expect.objectContaining({ fixtureId: "poolA-r2", reason: "order", direct: true }),
    ]);
  });

  it("scopes round order per stage WITHIN one division (C1 fix-loop, Finding 2: two round-robin-kind stages, NEITHER pooled, run independent sequences)", () => {
    // The stage-cardinality sibling of the pool test above. A division can
    // carry more than one round-robin-kind stage — two `league` stages, or
    // a `league` beside an unpooled `group` (`stages.ts`'s
    // `stages.per_division.max` caps COUNT, not kind-uniqueness) — and
    // `roundrobin.ts`'s `generateRoundRobin` restarts at round 1 for each
    // one independently, the same way it does per pool. Neither stage has
    // a pool here, so BOTH rows read `poolId: undefined`: before `stageId`
    // joined the grouping key this pair collapsed to `(d1, undefined)`, one
    // sequence, and stage B's round 1 (day B, later) read as sitting after
    // stage A's round 2 (day A, earlier) — day_2 <= day_1 is false, the
    // exact false positive the pool test above proves for pools.
    const a = [
      row({
        fixtureId: "stageA-r2", startAt: DAY_A_T0, roundNo: 2, movable: true,
        divisionId: "d1", stageId: "A",
      }),
      row({
        fixtureId: "stageB-r1", startAt: DAY_B_T0, roundNo: 1, movable: true,
        divisionId: "d1", stageId: "B",
      }),
    ];
    expect(validateAssignments(a, config).filter((c) => c.reason === "order")).toEqual([]);
  });

  it("still enforces round order WITHIN one stage that has no pool", () => {
    // The converse of the test above: stage scoping must narrow the
    // comparison, not disable it — two rows in the SAME (unpooled) stage
    // are still compared exactly as before `stageId` joined the key.
    const a = [
      row({
        fixtureId: "stageA-r2", startAt: DAY_A_T0, roundNo: 2, movable: true,
        divisionId: "d1", stageId: "A",
      }),
      row({
        fixtureId: "stageA-r1", startAt: DAY_B_T0, roundNo: 1, movable: true,
        divisionId: "d1", stageId: "A",
      }),
    ];
    const conflicts = validateAssignments(a, config);
    expect(conflicts).toEqual([
      expect.objectContaining({ fixtureId: "stageA-r2", reason: "order", direct: true }),
    ]);
  });

  it("is inert without an org timezone (absent tz skips the whole family)", () => {
    const a = [
      row({ fixtureId: "r2", startAt: DAY_A_T0, roundNo: 2, movable: true }),
      row({ fixtureId: "r1", startAt: DAY_B_T0, roundNo: 1, movable: true }),
    ];
    expect(
      validateAssignments(a, { perEntrantMinRest: 0, gapMinutes: 0 }).filter((c) => c.reason === "order"),
    ).toEqual([]);
  });
});

// The greedy claim at `calendar.ts`'s `SchedulableFixture.roundNo` doc comment
// ("scheduled in ascending round order") was never tested — the screenshot
// board that motivated this whole design came from the PLACEMENT path, not
// greedy. Proven here directly against `slotFixtures`' own output.
describe("slotFixtures — ascending roundNo per division-day (greedy regression)", () => {
  it("emits non-decreasing roundNo as startAt increases within a division-day", () => {
    // Four round-robin fixtures, disjoint entrants (so nothing but round
    // order — soft, via the (roundNo, id) placement comparator — decides
    // where each lands), built out of round order on purpose (round 3, 1, 4,
    // 2) so a comparator that stopped sorting by round would leave this
    // exact input order visible in the output.
    const fixtures: SchedulableFixture[] = [
      { id: "f-round3", roundNo: 3, home: "e1", away: "e2", divisionId: "d1" },
      { id: "f-round1", roundNo: 1, home: "e3", away: "e4", divisionId: "d1" },
      { id: "f-round4", roundNo: 4, home: "e5", away: "e6", divisionId: "d1" },
      { id: "f-round2", roundNo: 2, home: "e7", away: "e8", divisionId: "d1" },
    ];
    const { assignments, conflicts } = slotFixtures({
      fixtures,
      config: baseConfig({ courts: ["C1"], startAt: 0 }), // one court forces a strict placement order
    });
    expect(conflicts).toEqual([]);
    expect(assignments).toHaveLength(4);

    const byStart = [...assignments].sort((a, b) => a.startAt - b.startAt);
    const rounds = byStart.map((a) => a.roundNo);
    expect(rounds).toEqual([1, 2, 3, 4]);

    // And the fact itself survives onto the Assignment, not only the
    // placement ORDER — `validateAssignments`' round-order scan (and any
    // caller re-verifying a greedy board) needs it on the object.
    for (const a of assignments) expect(a.roundNo).toBeDefined();
  });

  it("keeps ascending roundNo per division even when two divisions interleave on shared courts", () => {
    const fixtures: SchedulableFixture[] = [
      { id: "d1-r2", roundNo: 2, home: "e1", away: "e2", divisionId: "d1" },
      { id: "d1-r1", roundNo: 1, home: "e3", away: "e4", divisionId: "d1" },
      { id: "d2-r2", roundNo: 2, home: "e5", away: "e6", divisionId: "d2" },
      { id: "d2-r1", roundNo: 1, home: "e7", away: "e8", divisionId: "d2" },
    ];
    const { assignments, conflicts } = slotFixtures({
      fixtures,
      config: baseConfig({ courts: ["C1", "C2"], startAt: 0 }),
    });
    expect(conflicts).toEqual([]);
    const byDivision = new Map<string, Assignment[]>();
    for (const a of assignments) {
      const key = a.divisionId as string;
      (byDivision.get(key) ?? byDivision.set(key, []).get(key)!).push(a);
    }
    for (const group of byDivision.values()) {
      const byStart = [...group].sort((a, b) => a.startAt - b.startAt);
      expect(byStart.map((a) => a.roundNo)).toEqual([1, 2]);
    }
  });
});

// THE test placer/verifier parity is proven with, not asserted (the recurring
// fork this whole module exists to prevent) — matches
// `calendar-placer-verifier-parity.test.ts`'s own established pattern
// exactly: feed the placer's OWN OUTPUT back into `validateAssignments` and
// require it clean. `services/placement/tests/test_model.py` proves the same
// semantic rules hold on the CP-SAT solver side, over the identical day/round
// shapes used above — the two suites cannot be run against each other
// directly (different languages, different processes), so this is the
// within-repo parity evidence: both sides are written from, and tested
// against, the one spec.
describe("round order — placer/verifier parity", () => {
  it("a greedy board that respects round order verifies clean", () => {
    const fixtures: SchedulableFixture[] = [
      { id: "f-round2", roundNo: 2, home: "e1", away: "e2", divisionId: "d1" },
      { id: "f-round1", roundNo: 1, home: "e3", away: "e4", divisionId: "d1" },
    ];
    const config = baseConfig({ courts: ["C1"], startAt: Date.UTC(2026, 6, 11, 17, 0), tz: "America/Los_Angeles" });
    const { assignments, conflicts } = slotFixtures({ fixtures, config });
    expect(conflicts).toEqual([]);

    // The SAME config drives both sides — one clock, one rule list, exactly
    // the parity file's own established convention.
    const verdict = validateAssignments(assignments, config);
    expect(verdict.filter((c) => c.reason === "order")).toEqual([]);
  });
});
