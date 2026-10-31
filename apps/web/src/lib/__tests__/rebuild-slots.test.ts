// W3 Task 1 (X-RB-1, design G3, #840, FX-G13) — Rebuild keeps times and courts.
//
// `carrySlots` is the pure half of the rebuild: given the rows a Rebuild is
// about to delete and the rows its regenerate has just inserted, it decides
// which new row inherits which old row's slot. The rule is POSITIONAL —
// `(pool_id, round_no, seq_in_round)` — because a rebuild re-draws who plays
// whom, never where a stage's n-th match of round r sits on the timetable. It
// is format-agnostic on purpose: W5 consumes it for league rows (#879 part 3)
// and the Swiss app-A tasks for the shell set.
//
// Every expected value below is written out by hand from the rule as the brief
// states it, never read off `carrySlots` itself.
import { describe, expect, it } from "vitest";
import { carrySlots, type CarriedSlot } from "@/lib/rebuild-slots";

type BeforeRow = Parameters<typeof carrySlots>[0][number];
type AfterRow = Parameters<typeof carrySlots>[1][number];

const EMPTY: CarriedSlot = { scheduled_at: null, court_id: null, venue_id: null, schedule_locked: false };

/** A distinct, recognisable slot per position, so a slot landing on the wrong
 *  row is visible in the diff rather than equal by coincidence. */
function slot(tag: string, over: Partial<CarriedSlot> = {}): CarriedSlot {
  return {
    scheduled_at: `2030-06-15T${tag}:00.000Z`,
    court_id: `court-${tag}`,
    venue_id: `venue-${tag}`,
    schedule_locked: false,
    ...over,
  };
}

function before(
  round_no: number,
  seq_in_round: number,
  s: CarriedSlot,
  ext_key: string | null = null,
  pool_id: string | null = null,
): BeforeRow {
  return { round_no, seq_in_round, pool_id, ext_key, ...s };
}

function after(
  id: string,
  round_no: number,
  seq_in_round: number,
  ext_key: string | null = null,
  pool_id: string | null = null,
): AfterRow {
  return { id, round_no, seq_in_round, pool_id, ext_key };
}

describe("X-RB-1 carrySlots — the empty cases first (R13)", () => {
  it("X-RB-1 empty before → every new row unscheduled, freed = []", () => {
    const out = carrySlots([], [after("n1", 1, 1), after("n2", 1, 2), after("n3", 2, 1)]);
    expect(out.assign.size).toBe(0);
    expect(out.freed).toEqual([]);
    expect(out.unscheduled).toEqual(["n1", "n2", "n3"]);
  });

  it("X-RB-1 empty after → every slot that held a time or court is freed, nothing assigned", () => {
    const a = slot("09");
    const out = carrySlots([before(1, 1, a), before(1, 2, EMPTY)], []);
    expect(out.assign.size).toBe(0);
    expect(out.freed).toEqual([a]);
    expect(out.unscheduled).toEqual([]);
  });

  it("both empty → nothing at all", () => {
    expect(carrySlots([], [])).toEqual({ assign: new Map(), freed: [], unscheduled: [] });
  });
});

describe("X-RB-1 carrySlots — a league (pool null)", () => {
  it("X-RB-1 carrySlots keeps every slot whose (pool, round, seq) survives", () => {
    // A 4-entrant single round robin: 3 rounds × 2 matches, every one laid out.
    const slots = {
      "1:1": slot("09"),
      "1:2": slot("10", { schedule_locked: true }),
      "2:1": slot("11"),
      "2:2": slot("12"),
      "3:1": slot("13"),
      "3:2": slot("14"),
    };
    const old = Object.entries(slots).map(([k, s]) => {
      const [r, q] = k.split(":").map(Number);
      return before(r!, q!, s, `rr-${k}`);
    });
    const fresh = Object.keys(slots).map((k) => {
      const [r, q] = k.split(":").map(Number);
      return after(`new-${k}`, r!, q!, `rr-${k}`);
    });

    const out = carrySlots(old, fresh);

    expect(out.assign.size).toBe(6);
    for (const [k, s] of Object.entries(slots)) expect(out.assign.get(`new-${k}`)).toEqual(s);
    expect(out.freed).toEqual([]);
    expect(out.unscheduled).toEqual([]);
  });

  it("X-RB-1 carrySlots frees a slot whose position no longer exists and reports it", () => {
    // A 6-board round 1 becoming 5: exactly the round-1 seq-6 slot is freed.
    const old = [1, 2, 3, 4, 5, 6].map((q) => before(1, q, slot(`0${q}`)));
    const fresh = [1, 2, 3, 4, 5].map((q) => after(`n${q}`, 1, q));

    const out = carrySlots(old, fresh);

    expect(out.freed).toEqual([slot("06")]);
    expect(out.assign.size).toBe(5);
    for (const q of [1, 2, 3, 4, 5]) expect(out.assign.get(`n${q}`)).toEqual(slot(`0${q}`));
    expect(out.unscheduled).toEqual([]);
  });

  it("a new position with no old row is unscheduled; a matched row that held nothing is neither kept nor unscheduled", () => {
    const old = [before(1, 1, slot("09")), before(1, 2, EMPTY)];
    const fresh = [after("a", 1, 1), after("b", 1, 2), after("c", 1, 3)];

    const out = carrySlots(old, fresh);

    expect([...out.assign.keys()]).toEqual(["a"]);
    expect(out.unscheduled).toEqual(["c"]);
    expect(out.freed).toEqual([]);
  });

  it("a slot holding only a venue, or only a lock, is still a slot — carried, and freed when it has no taker", () => {
    const venueOnly: CarriedSlot = { ...EMPTY, venue_id: "venue-x" };
    const lockedOnly: CarriedSlot = { ...EMPTY, schedule_locked: true };
    const out = carrySlots([before(1, 1, venueOnly), before(1, 2, lockedOnly)], [after("a", 1, 1)]);
    expect(out.assign.get("a")).toEqual(venueOnly);
    expect(out.freed).toEqual([lockedOnly]);
  });
});

describe("X-RB-1 carrySlots — a group (two pools)", () => {
  it("the same (round, seq) in each pool never crosses pools", () => {
    const A = "pool-a";
    const B = "pool-b";
    const old = [before(1, 1, slot("09"), "pA-1", A), before(1, 1, slot("10"), "pB-1", B)];
    const fresh = [after("b1", 1, 1, "pB-1", B), after("a1", 1, 1, "pA-1", A)];

    const out = carrySlots(old, fresh);

    expect(out.assign.get("a1")).toEqual(slot("09"));
    expect(out.assign.get("b1")).toEqual(slot("10"));
    expect(out.freed).toEqual([]);
    expect(out.unscheduled).toEqual([]);
  });

  it("a pool that loses a position frees its own slot; the other pool's new position does not take it", () => {
    const A = "pool-a";
    const B = "pool-b";
    // Pool B had a round-1 seq-2 board; after the rebuild only pool A has one.
    const old = [before(1, 1, slot("09"), null, A), before(1, 1, slot("10"), null, B), before(1, 2, slot("11"), null, B)];
    const fresh = [after("a1", 1, 1, null, A), after("a2", 1, 2, null, A), after("b1", 1, 1, null, B)];

    const out = carrySlots(old, fresh);

    expect(out.assign.get("a1")).toEqual(slot("09"));
    expect(out.assign.get("b1")).toEqual(slot("10"));
    expect(out.assign.has("a2")).toBe(false);
    expect(out.unscheduled).toEqual(["a2"]);
    expect(out.freed).toEqual([slot("11")]);
  });
});

describe("X-RB-1 carrySlots — a Swiss shell set", () => {
  it("X-RB-1 carrySlots a bye row neither gives nor takes a slot", () => {
    // Eight entrants (4 boards) re-drawn for seven (3 boards + a bye at seq 4).
    // The bye shell sits exactly where board 4 stood, and must NOT take its
    // slot (RB3-23: a bye is never on a court): board 4's slot is freed.
    const old = [1, 2, 3, 4].map((b) => before(1, b, slot(`0${b}`), `sw-r1-b${b}`));
    const fresh = [
      after("b1", 1, 1, "sw-r1-b1"),
      after("b2", 1, 2, "sw-r1-b2"),
      after("b3", 1, 3, "sw-r1-b3"),
      after("bye", 1, 4, "sw-r1-bye"),
    ];

    const out = carrySlots(old, fresh);

    expect(out.assign.has("bye")).toBe(false);
    expect(out.unscheduled).not.toContain("bye");
    expect(out.freed).toEqual([slot("04")]);
    expect(out.assign.size).toBe(3);

    // The other direction: a (legacy) bye shell holding a slot gives it to
    // nobody, and — since a bye's slot was never a real one — is not reported
    // freed either. The board now at its position starts unscheduled.
    const legacy = [before(2, 1, slot("05"), "sw-r2-b1"), before(2, 2, slot("06"), "sw-r2-bye")];
    const grown = [after("c1", 2, 1, "sw-r2-b1"), after("c2", 2, 2, "sw-r2-b2")];
    const back = carrySlots(legacy, grown);
    expect(back.assign.get("c1")).toEqual(slot("05"));
    expect(back.assign.has("c2")).toBe(false);
    expect(back.unscheduled).toEqual(["c2"]);
    expect(back.freed).toEqual([]);
  });

  it("three rounds of shells: every board that survives keeps its round's slot, the bye takes none", () => {
    const old: BeforeRow[] = [];
    const fresh: AfterRow[] = [];
    for (const r of [1, 2, 3]) {
      for (const b of [1, 2, 3, 4]) old.push(before(r, b, slot(`${r}${b}`), `sw-r${r}-b${b}`));
      for (const b of [1, 2, 3]) fresh.push(after(`r${r}b${b}`, r, b, `sw-r${r}-b${b}`));
      fresh.push(after(`r${r}bye`, r, 4, `sw-r${r}-bye`));
    }

    const out = carrySlots(old, fresh);

    let checked = 0;
    for (const r of [1, 2, 3]) {
      for (const b of [1, 2, 3]) {
        expect(out.assign.get(`r${r}b${b}`)).toEqual(slot(`${r}${b}`));
        checked++;
      }
      expect(out.assign.has(`r${r}bye`)).toBe(false);
    }
    expect(checked).toBe(9); // anti-vacuity: the sweep really looked at nine boards
    expect(out.freed).toEqual([slot("14"), slot("24"), slot("34")]);
    expect(out.unscheduled).toEqual([]);
  });
});

describe("carrySlots — duplicate positions are resolved, never silently dropped", () => {
  it("two old rows on one position: the first keeps it, the second's slot is reported freed", () => {
    const out = carrySlots([before(1, 1, slot("09")), before(1, 1, slot("10"))], [after("a", 1, 1)]);
    expect(out.assign.get("a")).toEqual(slot("09"));
    expect(out.freed).toEqual([slot("10")]);
  });

  it("two new rows on one position: only the first takes the slot, the second is unscheduled", () => {
    const out = carrySlots([before(1, 1, slot("09"))], [after("a", 1, 1), after("b", 1, 1)]);
    expect(out.assign.get("a")).toEqual(slot("09"));
    expect(out.assign.has("b")).toBe(false);
    expect(out.unscheduled).toEqual(["b"]);
    expect(out.freed).toEqual([]);
  });
});
