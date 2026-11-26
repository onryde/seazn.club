// How an auto pass takes placements back until the write gate accepts the proposal (`schedule/final-board.ts`).
// Most cases use a stand-in gate, so each shape of refusal can be put to it, including the ones a real board
// rarely produces; the last two blocks use the real gate over synthetic rows. `schedule-auto-start-floor.test.ts`
// drives it through `autoSchedule` and `applySchedule`. No database, no solver.
import { describe, expect, it } from "vitest";
import { roundOrderConflicts, isBlockingConflict, type Assignment, type Conflict } from "@seazn/engine/scheduling";
import { applyRefusals } from "../schedule/apply-gate";
import { MAX_GATE_CALLS, PRECISE_GATE_CALLS, settleProposal } from "../schedule/final-board";
import { toAssignment } from "../schedule/engine-inputs";
import type { FixtureLite } from "../schedule/types";

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
const CONFIG = { startAt: 0, matchMinutes: 30, gapMinutes: 0, perEntrantMinRest: 0, courts: ["C1", "C2"], tz: "UTC" };

/** The board is `stored` unless a case adds cards the pass does not run over (played ones). */
const settle = (over: Partial<Parameters<typeof settleProposal>[0]>) =>
  settleProposal({
    proposed: [],
    held: [],
    stored: new Map(),
    standing: over.stored ?? new Map(),
    config: CONFIG,
    keepStored: false,
    refuses: () => [],
    ...over,
  });

const byId = (rows: readonly Assignment[]) => new Map(rows.map((r) => [r.fixtureId, r]));
const HOUR = 3_600_000;

/** A round-bearing card of pool `pool`, on its own court unless one is named. */
const inPool = (pool: string, fixtureId: string, roundNo: number, startAt: number, court = `${pool}-${fixtureId}`): Assignment => ({
  fixtureId,
  court,
  startAt,
  endAt: startAt + HOUR / 2,
  entrants: [],
  people: [],
  divisionId: "D",
  stageId: "S",
  poolId: pool,
  roundNo,
});

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

  it("takes every move back when a refusal names no card it moved, and gives each its own plain reason", () => {
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
    // The refusal is about another card, so it is not repeated on this one.
    expect(out.refused.get("a")).toEqual({ fixtureId: "a", reason: "no_slot", rule: expect.any(String) });
  });

  it("throws rather than loop when a proposal that moves nothing is refused", () => {
    const stored = new Map([["a", at("a", 100)]]);
    expect(() =>
      settle({ proposed: [at("a", 100)], stored, keepStored: true, refuses: () => [clash("a")] }),
    ).toThrow("moves no card");
  });
});

describe("settleProposal: a refusal on a card that did not move", () => {
  /** The stand-in for the gate's round order: the engine's own rule over the rows and the played cards. */
  const roundGate =
    (standing: readonly Assignment[]) =>
    (rows: readonly Assignment[]): Conflict[] => {
      const listed = new Set(rows.map((r) => r.fixtureId));
      return roundOrderConflicts([...rows, ...standing.filter((a) => !listed.has(a.fixtureId))], "UTC").filter(
        isBlockingConflict,
      );
    };
  const playedR2 = { ...inPool("A", "played", 2, 10 * HOUR), movable: true };

  it("takes back only the round it names, only the cards of it that break the order, and only in that pool", () => {
    const proposed = [
      inPool("A", "a1-late", 1, 20 * HOUR),
      inPool("A", "a1-early", 1, 9 * HOUR),
      inPool("A", "a3", 3, 21 * HOUR),
      inPool("B", "b1", 1, 20 * HOUR),
      inPool("B", "b2", 2, 21 * HOUR),
    ];
    let calls = 0;
    const gate = roundGate([playedR2]);
    const out = settle({
      proposed,
      standing: byId([playedR2]),
      refuses: (rows) => (calls++, gate(rows)),
    });
    expect(ids(out.fresh)).toEqual(["a1-early", "a3", "b1", "b2"]);
    expect([...out.refused.keys()]).toEqual(["a1-late"]);
    expect(out.refused.get("a1-late")).toMatchObject({
      fixtureId: "a1-late",
      details: { kind: "round_order_same_day", roundNo: 2, otherRoundNo: 1, otherFixtureId: "played" },
    });
    expect(calls).toBe(2);
  });

  it("takes back the cards that fill an over-full day, in that pool and on that day only", () => {
    const standing = [inPool("A", "played", 1, 10 * HOUR)];
    const proposed = [
      inPool("A", "same-day", 2, 12 * HOUR),
      inPool("A", "next-day", 3, 36 * HOUR),
      inPool("B", "other-pool", 2, 12 * HOUR),
    ];
    const over: Conflict = {
      fixtureId: "played",
      reason: "order",
      direct: true,
      details: { kind: "rounds_per_day", day: "1970-01-01", requiredCount: 1 },
    };
    const out = settle({
      proposed,
      standing: byId(standing),
      refuses: (rows) => (rows.some((r) => r.fixtureId === "same-day") ? [over] : []),
    });
    expect([...out.refused.keys()]).toEqual(["same-day"]);
    expect(ids(out.fresh)).toEqual(["next-day", "other-pool"]);
  });

  it("with no card of the named round moved, widens to that sequence alone, each card with its own reason", () => {
    const standing = [inPool("A", "played-a", 2, 10 * HOUR), inPool("B", "played-b", 2, 10 * HOUR)];
    const refusal = (card: string): Conflict => ({
      fixtureId: card,
      reason: "order",
      direct: true,
      // No moved card is of round 9.
      details: { kind: "round_order_end", roundNo: 2, otherRoundNo: 9 },
    });
    const out = settle({
      proposed: [inPool("A", "a1", 1, 20 * HOUR), inPool("B", "b1", 1, 20 * HOUR), inPool("C", "c1", 1, 20 * HOUR)],
      standing: byId(standing),
      refuses: (rows) => [
        ...(rows.some((r) => r.fixtureId === "a1") ? [refusal("played-a")] : []),
        ...(rows.some((r) => r.fixtureId === "b1") ? [refusal("played-b")] : []),
      ],
    });
    expect(ids(out.fresh)).toEqual(["c1"]);
    expect(out.refused.get("a1")).toMatchObject({ details: { otherFixtureId: "played-a" } });
    expect(out.refused.get("b1")).toMatchObject({ details: { otherFixtureId: "played-b" } });
  });
});

describe("settleProposal: the number of gate calls", () => {
  const counted = (gate: (rows: readonly Assignment[]) => readonly Conflict[]) => {
    const seen = { calls: 0 };
    return { seen, refuses: (rows: readonly Assignment[]) => (seen.calls++, gate(rows)) };
  };

  // Each card is placed on the slot the next one has now, so one card falling back takes the next with it.
  it("follows a chain down one court without asking the gate again for each link", () => {
    const N = 100;
    const stored = byId(Array.from({ length: N }, (_, i) => at(`f${i}`, (i + 1) * 100)));
    const blocker = at("blocker", 0);
    const proposed = [...Array.from({ length: N }, (_, i) => at(`f${i}`, i * 100)), at("free", 99_000)];
    const { seen, refuses } = counted((rows) => {
      const listed = new Set(rows.map((r) => r.fixtureId));
      return oneCardPerSlot(([x, y]) => (x === "blocker" ? [x, y] : [y, x]))([
        blocker,
        ...rows,
        ...[...stored.values()].filter((a) => !listed.has(a.fixtureId)),
      ]);
    });
    const out = settle({ proposed, stored, standing: byId([...stored.values(), blocker]), refuses });
    expect(ids(out.fresh)).toEqual(["free"]);
    expect(out.refused.size).toBe(N);
    expect(out.refused.get("f50")).toMatchObject({ details: { kind: "court_double_booking", otherFixtureId: "f49" } });
    expect(seen.calls).toBe(2);
  });

  // Round r is brought just ahead of where round r-1 is now, every card on a court of its own.
  it("follows a chain of rounds, each card behind the one before it falls back", () => {
    const N = 40;
    const stored = byId(Array.from({ length: N }, (_, i) => inPool("A", `r${i + 1}`, i + 1, (i + 2) * HOUR)));
    const proposed = Array.from({ length: N }, (_, i) => inPool("A", `r${i + 1}`, i + 1, (i + 1) * HOUR - HOUR / 60));
    const { seen, refuses } = counted((rows) => {
      if (rows.some((r) => r.fixtureId === "r1" && r.startAt === proposed[0]!.startAt)) return [clash("r1")];
      const listed = new Set(rows.map((r) => r.fixtureId));
      const board = [...rows, ...[...stored.values()].filter((a) => !listed.has(a.fixtureId))];
      return roundOrderConflicts(board, "UTC").filter((c) => listed.has(c.fixtureId));
    });
    const out = settle({ proposed, stored, refuses });
    expect(out.refused.size).toBe(N);
    expect(out.refused.get("r9")).toMatchObject({
      fixtureId: "r9",
      details: { kind: "round_order_same_day", otherFixtureId: "r8" },
    });
    expect(seen.calls).toBe(2);
  });

  // The same chain through one player, who is on every card, with every card on a court of its own.
  it("follows a chain through a player the cards share", () => {
    const N = 40;
    const card = (i: number, startAt: number): Assignment => ({ ...at(`p${i}`, startAt, `C${i}`), entrants: ["p"] });
    const stored = byId(Array.from({ length: N }, (_, i) => card(i, (i + 1) * HOUR)));
    const proposed = Array.from({ length: N }, (_, i) => card(i, i * HOUR));
    const { seen, refuses } = counted((rows) =>
      rows.some((r) => r.fixtureId === "p0" && r.startAt === 0) ? [clash("p0")] : [],
    );
    const out = settle({ proposed, stored, refuses });
    expect(out.refused.size).toBe(N);
    expect(out.refused.get("p9")).toMatchObject({ details: { kind: "entrant_overlap", otherFixtureId: "p8" } });
    expect(seen.calls).toBe(2);
  });

  // One of two moved cards in a clash is enough: the other may then stand.
  it("takes back one card of a clash filed on both", () => {
    const out = settle({
      proposed: [at("a", 100), at("b", 100)],
      refuses: (rows) => (rows.length === 2 ? [clash("a", "b"), clash("b", "a")] : []),
    });
    expect(ids(out.fresh)).toEqual(["b"]);
  });

  it("takes back every unrelated refusal of one verdict in the same call", () => {
    let calls = 0;
    const out = settle({
      proposed: [at("a", 100), at("b", 200)],
      refuses: (rows) => (calls++, rows.filter((r) => r.fixtureId !== "ok").map((r) => clash(r.fixtureId))),
    });
    expect([...out.refused.keys()]).toEqual(["a", "b"]);
    expect(calls).toBe(2);
  });

  // `late` is round 1 after the played round 2, and `r3` (moved) is filed against round 1 too.
  it("leaves a card the gate also filed against a round that is already going back", () => {
    const played = inPool("A", "played", 2, 10 * HOUR);
    const order = (fixtureId: string): Conflict => ({
      fixtureId,
      reason: "order",
      direct: true,
      details: { kind: "round_order_same_day", roundNo: 2, otherRoundNo: 1 },
    });
    const out = settle({
      proposed: [inPool("A", "late", 1, 20 * HOUR), inPool("A", "r3", 3, 15 * HOUR)],
      standing: byId([played]),
      refuses: (rows) => (rows.some((r) => r.fixtureId === "late") ? [order("r3"), order("played")] : []),
    });
    expect(ids(out.fresh)).toEqual(["r3"]);
  });

  // What the pass moved off a slot that already clashed is no worse for the clash staying behind.
  it("does not take a card along for a clash it already has where it is now", () => {
    // `a` and `b` are double-booked now. `b` moves by ten minutes, still on top of where `a` is.
    const stored = byId([at("a", 500), at("b", 500)]);
    const out = settle({
      proposed: [at("a", 100), at("b", 510)],
      stored,
      refuses: (rows) => (rows.some((r) => r.fixtureId === "a") ? [clash("a")] : []),
    });
    expect([...out.refused.keys()]).toEqual(["a"]);
    expect(ids(out.fresh)).toEqual(["b"]);
  });

  // A gate that owns up to one card per call is the worst a real board could do.
  it("stops narrowing after a fixed number of calls, and then spares the sequences no refusal is in", () => {
    const poolA = Array.from({ length: 40 }, (_, i) => inPool("A", `a${i}`, 1, 20 * HOUR));
    const poolB = Array.from({ length: 5 }, (_, i) => inPool("B", `b${i}`, 1, 20 * HOUR));
    const { seen, refuses } = counted((rows) => {
      const first = rows.find((r) => r.poolId === "A");
      return first === undefined ? [] : [clash(first.fixtureId)];
    });
    const out = settle({ proposed: [...poolA, ...poolB], refuses });
    expect(seen.calls).toBe(PRECISE_GATE_CALLS + 2);
    expect(ids(out.fresh)).toEqual(ids(poolB));
    expect(out.refused.size).toBe(poolA.length);
  });

  it("takes every move back in the end, so no gate can hold it past the cap", () => {
    // One card per call, each in a sequence of its own: narrowing and widening never get ahead of it.
    const proposed = Array.from({ length: 40 }, (_, i) => inPool(`P${i}`, `f${i}`, 1, 20 * HOUR));
    const { seen, refuses } = counted((rows) => (rows.length === 0 ? [] : [clash(rows[0]!.fixtureId)]));
    const out = settle({ proposed, refuses });
    expect(out.fresh).toEqual([]);
    expect(out.refused.size).toBe(proposed.length);
    expect(out.refused.get("f39")).toEqual({ fixtureId: "f39", reason: "no_slot", rule: expect.any(String) });
    expect(seen.calls).toBe(MAX_GATE_CALLS);
  });
});

describe("settleProposal against the real write gate", () => {
  const T0 = Date.UTC(2030, 0, 1);
  const row = (
    id: string,
    pool: string,
    round: number,
    seats: [string, string],
    slot: { at: number; court: string } | null,
    status = "scheduled",
  ): FixtureLite => ({
    id,
    stage_id: "S",
    division_id: "D",
    pool_id: pool,
    round_no: round,
    seq_in_round: 1,
    ext_key: null,
    home_entrant_id: seats[0],
    away_entrant_id: seats[1],
    outcome: null,
    home_slot_label: null,
    away_slot_label: null,
    scheduled_at: slot === null ? null : new Date(slot.at).toISOString(),
    court_id: slot?.court ?? null,
    venue_id: null,
    court_label: null,
    venue: null,
    status,
    schedule_locked: false,
    winner_to_fixture: null,
    loser_to_fixture: null,
  });

  /** A full round robin: round r (1-based) pairs by the circle method. */
  const roundRobin = (n: number): [number, string, string][] => {
    const seats = Array.from({ length: n }, (_, i) => i);
    const out: [number, string, string][] = [];
    for (let r = 1; r < n; r++) {
      for (let i = 0; i < n / 2; i++) out.push([r, `e${seats[i]}`, `e${seats[n - 1 - i]}`]);
      seats.splice(1, 0, seats.pop()!);
    }
    return out;
  };

  const gateOver = (fixtures: FixtureLite[], courts: string[]) => {
    const config = { ...CONFIG, courts, startAt: T0 };
    const roundStages = new Map([["S", {}]]);
    const board = fixtures
      .filter((f) => f.scheduled_at !== null)
      .map((f) => toAssignment(f, 30, new Map(), roundStages));
    const refuses = (rows: readonly Assignment[]) =>
      applyRefusals({
        rows: rows.map((a) => ({ fixture_id: a.fixtureId, scheduled_at: new Date(a.startAt).toISOString(), court_id: a.court })),
        fixtures,
        matchMinutes: 30,
        people: new Map(),
        roundRobin: roundStages,
        siblingBoard: [],
        config,
      });
    const placement = (f: FixtureLite, at: number, court: string): Assignment => ({
      ...toAssignment({ ...f, scheduled_at: new Date(at).toISOString(), court_id: court }, 30, new Map(), roundStages),
    });
    return { config, board, refuses, placement };
  };

  it("leaves out one open round-1 card behind played rounds, in one pool of three", () => {
    const courts = ["C1", "C2", "C3"];
    const fixtures: FixtureLite[] = [];
    const slots: { f: FixtureLite; at: number; court: string }[] = [];
    for (const [p, pool] of ["A", "B", "C"].entries()) {
      for (const [i, [round, h, a]] of roundRobin(6).entries()) {
        const f = row(`${pool}${i}`, pool, round, [`${pool}${h}`, `${pool}${a}`], null);
        fixtures.push(f);
        slots.push({ f, at: T0 + (20 + round * 10) * HOUR + (i % 3) * HOUR, court: courts[p]! });
      }
    }
    // Pool A also holds a played round-2 card from before every new slot.
    fixtures.push(row("played", "A", 2, ["x", "y"], { at: T0 + HOUR, court: "C1" }, "decided"));
    const { config, board, refuses, placement } = gateOver(fixtures, courts);
    const proposed = slots.map((s) => placement(s.f, s.at, s.court));
    expect(proposed).toHaveLength(45);
    const out = settleProposal({ proposed, held: [], stored: new Map(), standing: byId(board), config, keepStored: false, refuses });
    // Every round-1 card of pool A would start after the played round 2; nothing else is touched.
    const roundOneA = fixtures.filter((f) => f.pool_id === "A" && f.round_no === 1).map((f) => f.id);
    expect(roundOneA).toHaveLength(3);
    expect([...out.refused.keys()].sort()).toEqual(roundOneA.sort());
    expect(out.fresh).toHaveLength(42);
    expect(refuses(out.fresh)).toEqual([]);
  });

  // 32 entrants in one pool: 496 cards, 31 rounds, 16 courts. Every card is moved one round earlier onto the
  // slot its predecessor has, and round 1 stays put, so the rounds fall back one after another.
  it("settles a 496-card pool whose rounds fall back one after another in a handful of gate calls", () => {
    const courts = Array.from({ length: 18 }, (_, i) => `C${i + 1}`);
    const slot = (round: number, i: number) => ({ at: T0 + round * HOUR, court: courts[i % 16]! });
    const cards = roundRobin(32).map(([round, h, a], i) => row(`f${i}`, "A", round, [h, a], slot(round, i)));
    const other = [row("other", "B", 1, ["p", "q"], { at: T0 + 100 * HOUR, court: "C17" })];
    const { config, board, refuses, placement } = gateOver([...cards, ...other], courts);
    expect(cards).toHaveLength(496);
    const proposed = [
      ...cards.filter((f) => f.round_no > 1).map((f) => placement(f, T0 + (f.round_no - 1) * HOUR, f.court_id!)),
      placement(other[0]!, T0 + 90 * HOUR, "C18"),
    ];
    let calls = 0;
    const started = performance.now();
    const out = settleProposal({
      proposed,
      held: [],
      stored: byId(board),
      standing: byId(board),
      config,
      keepStored: false,
      refuses: (rows) => (calls++, refuses(rows)),
    });
    console.log(`496-card settle: ${calls} gate calls, ${Math.round(performance.now() - started)} ms`);
    expect(calls).toBeLessThanOrEqual(3);
    // The unrelated pool's move survives, and apply accepts what is offered.
    expect(out.fresh.map((a) => a.fixtureId)).toContain("other");
    expect(out.refused.size).toBe(480);
    expect(refuses([...out.fresh])).toEqual([]);
  }, 300_000);
});
