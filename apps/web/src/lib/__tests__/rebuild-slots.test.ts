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
import { carriedSlotCounts, carrySlots, holdsSlot, type CarriedSlot } from "@/lib/rebuild-slots";
import { bracketRoleKey, finalRoundOf } from "@/lib/bracket-role";
import { engineBracketRows } from "./engine-bracket-rows";

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
  // W3 fix round 1: `unscheduled` counts only on a stage that had a layout. A
  // stage nobody laid out was unscheduled before the rebuild and after it, so
  // the rebuild left nothing unscheduled — and the desk says nothing about slots.
  it("X-RB-1 empty before → nothing was laid out: nothing unscheduled, nothing freed", () => {
    const out = carrySlots([], [after("n1", 1, 1), after("n2", 1, 2), after("n3", 2, 1)]);
    expect(out.assign.size).toBe(0);
    expect(out.freed).toEqual([]);
    expect(out.unscheduled).toEqual([]);
  });

  it("X-RB-1 a growth rebuild of a stage nobody laid out reports kept 0, freed 0, unscheduled 0", () => {
    const bare = [1, 2, 3].map((r) => before(r, 1, EMPTY));
    const grown = [1, 2, 3].flatMap((r) => [after(`r${r}a`, r, 1), after(`r${r}b`, r, 2)]);
    expect(carriedSlotCounts(carrySlots(bare, grown))).toEqual({ kept: 0, freed: 0, unscheduled: 0 });
    // The positive pair: ONE slot laid out anywhere makes the new positions count.
    const laid = [before(1, 1, slot("09")), before(2, 1, EMPTY), before(3, 1, EMPTY)];
    expect(carriedSlotCounts(carrySlots(laid, grown))).toEqual({ kept: 1, freed: 0, unscheduled: 3 });
  });

  it("X-RB-1 empty after → every slot that held a time, court, venue or pin is freed, nothing assigned", () => {
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

describe("X-RB-1 holdsSlot — the one \"holds a slot\" predicate", () => {
  it("a time, a court, a venue or a pin each holds a slot alone; none of them holds nothing", () => {
    const at = new Date("2030-06-15T09:00:00.000Z");
    const cases: [Partial<CarriedSlot> | { scheduled_at: Date }, boolean][] = [
      [{}, false],
      [{ scheduled_at: "2030-06-15T09:00:00.000Z" }, true],
      [{ scheduled_at: at }, true],
      [{ court_id: "c" }, true],
      [{ venue_id: "v" }, true],
      [{ schedule_locked: true }, true],
    ];
    let checked = 0;
    for (const [over, want] of cases) {
      expect(holdsSlot({ ...EMPTY, ...over }), JSON.stringify(over)).toBe(want);
      checked++;
    }
    expect(checked).toBe(6);
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

// W3 fix round 1 (controller ruling): a Rebuild that SHRINKS a Swiss round
// chooses which old boards keep a slot in the pre-Start reshape's order
// (`chooseDoomedBoards`): a board holding nothing goes first, so a pinned b4
// hands its slot to the new b3 instead of being freed beside a bare b3.
describe("X-RB-1 carrySlots — a shrinking Swiss round dooms the bare board first", () => {
  it("X-RB-1 b4 holds a slot and b3 does not: b4's slot lands on the new b3, and nothing is freed", () => {
    const old = [
      before(2, 1, slot("09"), "sw-r2-b1"),
      before(2, 2, slot("10"), "sw-r2-b2"),
      before(2, 3, EMPTY, "sw-r2-b3"),
      before(2, 4, slot("12", { schedule_locked: true }), "sw-r2-b4"),
    ];
    const fresh = [
      after("n1", 2, 1, "sw-r2-b1"),
      after("n2", 2, 2, "sw-r2-b2"),
      after("n3", 2, 3, "sw-r2-b3"),
      after("bye", 2, 4, "sw-r2-bye"),
    ];
    const out = carrySlots(old, fresh);
    expect(out.assign.get("n1")).toEqual(slot("09"));
    expect(out.assign.get("n2")).toEqual(slot("10"));
    expect(out.assign.get("n3")).toEqual(slot("12", { schedule_locked: true }));
    expect(out.assign.has("bye")).toBe(false);
    expect(carriedSlotCounts(out)).toEqual({ kept: 3, freed: 0, unscheduled: 0 });
  });

  it("every board laid out: an unlocked board goes before a locked one, and its slot is the one freed", () => {
    const old = [1, 2, 3, 4].map((b) => before(1, b, slot(`0${b}`, { schedule_locked: b === 1 || b === 4 }), `sw-r1-b${b}`));
    const fresh = [after("n1", 1, 1, "sw-r1-b1"), after("n2", 1, 2, "sw-r1-b2"), after("n3", 1, 3, "sw-r1-b3"), after("bye", 1, 4, "sw-r1-bye")];
    const out = carrySlots(old, fresh);
    expect(out.assign.get("n3")).toEqual(slot("04", { schedule_locked: true }));
    expect(out.freed).toEqual([slot("03")]);
  });

  it("a league row is never re-packed: the same seq keeps the same slot", () => {
    const old = [before(1, 1, slot("09")), before(1, 2, EMPTY), before(1, 3, slot("11"))];
    const out = carrySlots(old, [after("a", 1, 1), after("b", 1, 2)]);
    expect(out.assign.get("a")).toEqual(slot("09"));
    expect(out.assign.has("b")).toBe(false);
    expect(out.freed).toEqual([slot("11")]);
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

// W4 app-A Task 4 (gap K3; X-RB-1). A knockout's `round_no` counts from its FIRST round, so carrying by position handed
// an 8-bracket's final slot to a 16-bracket's semi-final. Rebuild now passes role keys for a knockout (`bracketRoleKey`,
// each side against its OWN final), and every row says whether it is a bye line (`bye`): a bye line neither gives nor
// takes a slot. The brackets are the ENGINE's (`engineBracketRows`); every expectation is read off the engine's winner
// feeds (`path`: a line's route to the final) and its baked byes, never off the key function.
describe("W4 T4 carrySlots with knockout role keys (X-RB-1, K3)", () => {
  type Line = ReturnType<typeof engineBracketRows>[number];
  const roleKeys = (b: readonly Line[], a: readonly Line[]) => {
    const fb = finalRoundOf(b);
    const fa = finalRoundOf(a);
    return { before: (r: Line) => bracketRoleKey(r, fb), after: (r: Line) => bracketRoleKey(r, fa) };
  };
  /** A slot per old line, tagged by the line's PATH, so a slot that lands on the wrong role shows in the diff. */
  const slotOfPath = (p: string): CarriedSlot => ({
    scheduled_at: `2030-06-15T09:00:00.000Z#${p || "F"}`,
    court_id: `court-${p || "F"}`,
    venue_id: "venue",
    schedule_locked: p === "",
  });
  const laidOut = (rows: readonly Line[], legacyByes = false) =>
    rows.map((r) => ({ ...r, ...(r.bye && !legacyByes ? EMPTY : slotOfPath(r.path)) }));
  const fresh = (rows: readonly Line[]) => rows.map((r) => ({ ...r, id: `new-${r.path || "F"}` }));

  /** What the rule says, from the engine alone: a new non-bye line inherits the old line on the same path; a new bye
   *  line takes nothing; an old non-bye line with no non-bye heir on its path is freed; an old bye line is never freed. */
  function expected(old: readonly Line[], neu: readonly Line[]) {
    const oldByPath = new Map(old.filter((r) => !r.bye).map((r) => [r.path, r]));
    const assign = new Map<string, CarriedSlot>();
    const unscheduled: string[] = [];
    const heirs = new Set<string>();
    for (const r of neu) {
      if (r.bye) continue;
      const from = oldByPath.get(r.path);
      if (from) {
        assign.set(`new-${r.path || "F"}`, slotOfPath(from.path));
        heirs.add(r.path);
      } else unscheduled.push(`new-${r.path || "F"}`);
    }
    const freed = [...oldByPath.keys()].filter((p) => !heirs.has(p)).map(slotOfPath);
    return { assign, freed, unscheduled };
  }

  const CASES: { name: string; from: number; to: number; counts: { kept: number; freed: number; unscheduled: number } }[] = [
    { name: "equal 8 → 8", from: 8, to: 8, counts: { kept: 8, freed: 0, unscheduled: 0 } },
    { name: "grow 8 → 9", from: 8, to: 9, counts: { kept: 8, freed: 0, unscheduled: 1 } },
    { name: "grow 8 → 16", from: 8, to: 16, counts: { kept: 8, freed: 0, unscheduled: 8 } },
    { name: "shrink 9 → 8", from: 9, to: 8, counts: { kept: 8, freed: 1, unscheduled: 0 } },
    { name: "shrink 8 → 4", from: 8, to: 4, counts: { kept: 4, freed: 4, unscheduled: 0 } },
    { name: "shrink 8 → 6 (two quarter-finals become byes)", from: 8, to: 6, counts: { kept: 6, freed: 2, unscheduled: 0 } },
  ];

  it("equal, grow and shrink: every line keeps the slot of the line on its own path to the final; a new bye line takes none", () => {
    let cases = 0;
    let lines = 0;
    for (const c of CASES) {
      const old = engineBracketRows(c.from, true);
      const neu = engineBracketRows(c.to, true);
      const out = carrySlots(laidOut(old), fresh(neu), roleKeys(old, neu));
      const want = expected(old, neu);
      expect(out.assign, c.name).toEqual(want.assign);
      expect([...out.freed].sort((a, b) => String(a.court_id).localeCompare(String(b.court_id))), c.name).toEqual(
        [...want.freed].sort((a, b) => String(a.court_id).localeCompare(String(b.court_id))),
      );
      expect([...out.unscheduled].sort(), c.name).toEqual([...want.unscheduled].sort());
      expect(carriedSlotCounts(out), `${c.name}: counts`).toEqual(c.counts);
      for (const r of neu) if (r.bye) expect(out.assign.has(`new-${r.path}`), `${c.name}: bye ${r.path} takes nothing`).toBe(false);
      cases++;
      lines += neu.length;
    }
    expect([cases, lines], "anti-vacuity: cases and new lines checked").toEqual([6, 8 + 16 + 16 + 8 + 4 + 8]);
  });

  it("the final keeps the final's slot across 8 → 9, where position hands it to a semi-final", () => {
    const old = engineBracketRows(8, false);
    const neu = engineBracketRows(9, false);
    const finalSlot = slotOfPath("");
    const byRole = carrySlots(laidOut(old), fresh(neu), roleKeys(old, neu));
    expect(byRole.assign.get("new-F"), "by role").toEqual(finalSlot);
    // The premise, by position (no keys): the old final's slot lands on the new home semi-final.
    const byPosition = carrySlots(laidOut(old), fresh(neu));
    expect(byPosition.assign.get("new-H"), "by position (the defect)").toEqual(finalSlot);
  });

  it("a bye line never carries, in either direction: an old bye's legacy slot is given to nobody and never reported freed", () => {
    // 6 → 8: the old bracket's two byes held (legacy) slots; the new bracket plays those quarter-finals for real.
    const old = engineBracketRows(6, false);
    const neu = engineBracketRows(8, false);
    const byes = old.filter((r) => r.bye);
    expect(byes.length, "premise: the engine baked two byes for six").toBe(2);
    const out = carrySlots(laidOut(old, true), fresh(neu), roleKeys(old, neu));
    for (const b of byes) {
      expect(out.assign.has(`new-${b.path}`), `the line on bye ${b.path}'s path starts unscheduled`).toBe(false);
      expect(out.unscheduled).toContain(`new-${b.path}`);
      expect(out.freed, "a bye's slot was never a real one").not.toContainEqual(slotOfPath(b.path));
    }
    expect(carriedSlotCounts(out)).toEqual({ kept: 5, freed: 0, unscheduled: 2 });
  });

  it("the default keys are still the position, and the bye flag defaults to the Swiss shell's ext_key", () => {
    // Position, unchanged for league, group, Swiss and double elimination: the same (pool, round, seq) carries.
    const out = carrySlots([before(3, 1, slot("09"))], [after("a", 3, 1)]);
    expect(out.assign.get("a")).toEqual(slot("09"));
    // An explicit `bye` wins over the ext_key in both directions.
    const flagged = carrySlots([{ ...before(1, 1, slot("09")), bye: false }], [{ ...after("b", 1, 1, "sw-r1-bye"), bye: false }]);
    expect(flagged.assign.get("b"), "bye: false on a shell-shaped key carries").toEqual(slot("09"));
    const blocked = carrySlots([before(1, 1, slot("09"))], [{ ...after("c", 1, 1), bye: true }]);
    expect(blocked.assign.has("c"), "bye: true takes nothing").toBe(false);
    expect(blocked.freed).toEqual([slot("09")]);
  });
});
