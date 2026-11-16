// W5 app PR A, Task 2 (X-CU-6; RB5-G7, RB5-L17) — the pure planner of a round robin's Generate over lines that already exist.
//
// Expected values: the ENGINE is the oracle. Every set of lines below is `generateRoundRobin(...).fixtures` (its `leg`, its
// `rounds[].bye`), and every expected key set is computed from the engine's own schedule for the other field — never from the
// planner's output. Each sweep counts what it checked (TEST-STRATEGY: zero checked is a failure).
import { describe, expect, it } from "vitest";
import { generateRoundRobin } from "@seazn/engine/scheduling";
import {
  RR_MAX_LEG,
  roundSpan,
  RrKeyError,
  planRoundRobinReconcile,
  roundRobinShape,
  rrExtKey,
  rrKey,
  rrLegOfExtKey,
  rrLegacyExtKey,
  rrLinesOfRows,
  type RrStoredRow,
  type RrLine,
} from "../roundrobin-reconcile";

const NO_CHANGE = { parityFlipped: false, poolMembershipChanged: false } as const;

const entrantsOf = (n: number, prefix = "e"): string[] => Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(2, "0")}`);

/** The engine's schedule of an n-entrant field as planner lines (stored: with ids), plus the pools holding a bye. */
function linesOf(n: number, legs: number, opts: { pool?: string | null; stored?: boolean; prefix?: string } = {}) {
  const pool = opts.pool ?? null;
  const schedule = generateRoundRobin({ entrants: entrantsOf(n, opts.prefix), config: { legs } });
  const lines: RrLine[] = schedule.fixtures.map((f) => ({
    key: rrKey(f.home, f.away, f.leg, pool),
    ...(opts.stored ? { id: `${pool ?? "x"}-${f.id}` } : {}),
    home: f.home,
    away: f.away,
    roundNo: f.roundNo,
    leg: f.leg,
    pool,
  }));
  const byePools = new Set<string | null>(schedule.rounds.some((r) => r.bye !== undefined) ? [pool] : []);
  return { lines, byePools, schedule };
}

const keysOf = (lines: readonly RrLine[]) => new Set(lines.map((l) => l.key));
const minus = (a: Set<string>, b: Set<string>) => [...a].filter((k) => !b.has(k)).sort();

describe("rrKey (RB5-G7: the unordered pair, the leg and the pool)", () => {
  it("is order-free in the pair, and distinct per leg and per pool", () => {
    expect(rrKey("b", "a", 1, null)).toBe(rrKey("a", "b", 1, null));
    expect(rrKey("a", "b", 1, null)).not.toBe(rrKey("a", "b", 2, null));
    expect(rrKey("a", "b", 1, "poolA")).not.toBe(rrKey("a", "b", 1, "poolB"));
    expect(rrKey("a", "b", 1, "poolA")).not.toBe(rrKey("a", "b", 1, null));
    // The text is the engine's `roundRobinLineKey` shape (app PR B pins the two together): bare for an unpooled stage, and
    // `pool|`-prefixed only when a pool names it (the engine has no pool).
    expect(rrKey("b", "a", 2, null)).toBe("rr:a:b:L2");
    expect(rrKey("b", "a", 2, "P")).toBe("P|rr:a:b:L2");
  });

  it("orders the pair by code unit, not by locale", () => {
    // "B" (66) < "a" (97) in code units; a locale compare would put "a" first.
    expect(rrKey("a", "B", 1, null)).toBe("rr:B:a:L1");
  });

  it("refuses by name: a self-pair, a leg outside 1..8, an empty id, an id with ':', a bad pool", () => {
    const refused: [string, () => unknown][] = [
      ["self-pair", () => rrKey("a", "a", 1, null)],
      ["leg 0", () => rrKey("a", "b", 0, null)],
      ["leg 9", () => rrKey("a", "b", RR_MAX_LEG + 1, null)],
      ["leg 1.5", () => rrKey("a", "b", 1.5, null)],
      ["leg NaN", () => rrKey("a", "b", Number.NaN, null)],
      ["empty first", () => rrKey("", "b", 1, null)],
      ["empty second", () => rrKey("a", "", 1, null)],
      ["colon first", () => rrKey("a:x", "b", 1, null)],
      ["colon second", () => rrKey("a", "b:x", 1, null)],
      ["empty pool", () => rrKey("a", "b", 1, "")],
      ["pool with a bar", () => rrKey("a", "b", 1, "p|q")],
    ];
    for (const [name, call] of refused) expect(call, name).toThrow(RrKeyError);
    expect(refused.length).toBe(11);
    // And every leg the generator can write is accepted.
    let accepted = 0;
    for (let leg = 1; leg <= RR_MAX_LEG; leg++) {
      expect(rrKey("a", "b", leg, null)).toContain(`:L${leg}`);
      accepted++;
    }
    expect(accepted).toBe(8);
  });
});

describe("the stored leg (never derived from a round number)", () => {
  it("reads the leg off the ext_key's tail, and returns null for a line drawn before the leg was stored", () => {
    expect(rrLegOfExtKey(rrExtKey("", 4, 2, 2))).toBe(2);
    expect(rrLegOfExtKey(rrExtKey("pA-", 7, 1, 8))).toBe(8);
    expect(rrExtKey("pA-", 7, 1, 8)).toBe("pA-rr-r7-c1-L8");
    expect(rrLegOfExtKey("rr-r4-c2")).toBeNull();
    expect(rrLegOfExtKey("pA-rr-r4-c2")).toBeNull();
    expect(rrLegOfExtKey(null)).toBeNull();
    expect(rrLegacyExtKey(rrExtKey("pA-", 7, 1, 8))).toBe("pA-rr-r7-c1");
    expect(rrLegacyExtKey("rr-r4-c2")).toBe("rr-r4-c2");
  });

  it("round-trips for every (round, court, leg) the engine writes for 3..6 entrants over 3 legs", () => {
    let checked = 0;
    for (let n = 3; n <= 6; n++) {
      for (const f of generateRoundRobin({ entrants: entrantsOf(n), config: { legs: 3 } }).fixtures) {
        // The engine's positional id is the legacy key; the stored key is that plus its leg.
        const key = rrExtKey("", f.roundNo, f.court, f.leg);
        expect(rrLegacyExtKey(key)).toBe(f.id);
        expect(rrLegOfExtKey(key)).toBe(f.leg);
        checked++;
      }
    }
    // 3: 3 pairs, 4: 6, 5: 10, 6: 15 — times three legs.
    expect(checked).toBe((3 + 6 + 10 + 15) * 3);
  });
});

describe("planRoundRobinReconcile", () => {
  it("the empty case first: no lines on either side is a no-op, not a patch of nothing", () => {
    expect(planRoundRobinReconcile([], [], NO_CHANGE)).toEqual({ kind: "noop" });
  });

  it("the same field is a no-op: n = 2..9 x legs 1..3, the engine's lines on both sides", () => {
    let checked = 0;
    for (let n = 2; n <= 9; n++) {
      for (let legs = 1; legs <= 3; legs++) {
        const a = linesOf(n, legs, { stored: true });
        const b = linesOf(n, legs);
        expect(a.lines.length, `n=${n} legs=${legs}`).toBe(((n * (n - 1)) / 2) * legs);
        expect(planRoundRobinReconcile(a.lines, b.lines, roundRobinShape(a.lines, b.lines, { stored: a.byePools, fresh: b.byePools })), `n=${n} legs=${legs}`).toEqual({ kind: "noop" });
        checked++;
      }
    }
    expect(checked).toBe(8 * 3);
  });

  it("n -> n+2 with the parity kept is a patch whose inserts are EXACTLY the engine's missing pair-legs (even n), and regenerate for an odd pool", () => {
    let patched = 0;
    let regenerated = 0;
    for (let n = 2; n <= 8; n++) {
      for (let legs = 1; legs <= 3; legs++) {
        const a = linesOf(n, legs, { stored: true });
        const b = linesOf(n + 2, legs);
        const shape = roundRobinShape(a.lines, b.lines, { stored: a.byePools, fresh: b.byePools });
        const plan = planRoundRobinReconcile(a.lines, b.lines, shape);
        if (n % 2 === 1) {
          // An odd pool's byes are recorded per round (FX-G21); a patch cannot keep them true.
          expect(plan, `n=${n} legs=${legs}`).toEqual({ kind: "regenerate" });
          regenerated++;
          continue;
        }
        expect(plan.kind, `n=${n} legs=${legs}`).toBe("patch");
        if (plan.kind !== "patch") continue;
        expect(plan.remove, `n=${n} legs=${legs}: nothing is removed`).toEqual([]);
        const expected = minus(keysOf(b.lines), keysOf(a.lines));
        // C(n+2,2) - C(n,2) pairs, per leg.
        expect(expected.length, `n=${n} legs=${legs}`).toBe(((((n + 2) * (n + 1)) / 2) - (n * (n - 1)) / 2) * legs);
        expect(plan.insert.map((l) => l.key).sort(), `n=${n} legs=${legs}`).toEqual(expected);
        patched++;
      }
    }
    // n in {2,4,6,8} patch, n in {3,5,7} regenerate; three leg counts each.
    expect(patched).toBe(4 * 3);
    expect(regenerated).toBe(3 * 3);
  });

  it("the explicit contract: with the shape flags clear, n -> n+2 is a patch for EVERY n (the planner takes its shape as given)", () => {
    let checked = 0;
    for (let n = 2; n <= 9; n++) {
      const a = linesOf(n, 2, { stored: true });
      const b = linesOf(n + 2, 2);
      const plan = planRoundRobinReconcile(a.lines, b.lines, NO_CHANGE);
      expect(plan.kind, `n=${n}`).toBe("patch");
      if (plan.kind === "patch") expect(plan.insert.map((l) => l.key).sort()).toEqual(minus(keysOf(b.lines), keysOf(a.lines)));
      checked++;
    }
    expect(checked).toBe(8);
  });

  it("n -> n+1 flips the parity: regenerate, for n = 2..9", () => {
    let checked = 0;
    for (let n = 2; n <= 9; n++) {
      const a = linesOf(n, 1, { stored: true });
      const b = linesOf(n + 1, 1);
      const shape = roundRobinShape(a.lines, b.lines, { stored: a.byePools, fresh: b.byePools });
      expect(shape.parityFlipped, `n=${n}`).toBe(true);
      expect(planRoundRobinReconcile(a.lines, b.lines, shape), `n=${n}`).toEqual({ kind: "regenerate" });
      checked++;
    }
    expect(checked).toBe(8);
  });

  it("a delete leaves the stored byes but not the lines: n -> n-1 is a parity flip even though every surviving pair is still fresh", () => {
    // The pre-Start delete drops the victim's lines and leaves the OTHER lines in their old rounds. The key sets then agree
    // (every surviving pair is in the fresh schedule), so only the stored byes can tell the table was drawn for another size.
    let checked = 0;
    for (let n = 3; n <= 9; n++) {
      const old = linesOf(n, 1, { stored: true });
      const victim = entrantsOf(n)[n - 1]!;
      const survivors = old.lines.filter((l) => l.home !== victim && l.away !== victim);
      const fresh = linesOf(n - 1, 1);
      expect(keysOf(survivors), `n=${n}: the surviving pairs ARE the fresh pairs`).toEqual(keysOf(fresh.lines));
      const shape = roundRobinShape(survivors, fresh.lines, { stored: old.byePools, fresh: fresh.byePools });
      expect(shape.parityFlipped, `n=${n}`).toBe(true);
      expect(planRoundRobinReconcile(survivors, fresh.lines, shape), `n=${n}`).toEqual({ kind: "regenerate" });
      checked++;
    }
    expect(checked).toBe(7);
  });

  it("a removed pair is dropped: an even field losing two players removes exactly the pairs they were in (ids, not keys)", () => {
    let checked = 0;
    for (const n of [4, 6, 8]) {
      const a = linesOf(n, 2, { stored: true });
      const b = linesOf(n - 2, 2);
      const shape = roundRobinShape(a.lines, b.lines, { stored: a.byePools, fresh: b.byePools });
      const plan = planRoundRobinReconcile(a.lines, b.lines, shape);
      expect(plan.kind, `n=${n}`).toBe("patch");
      if (plan.kind !== "patch") continue;
      const gone = new Set(entrantsOf(n).slice(n - 2));
      const expectedIds = a.lines.filter((l) => gone.has(l.home) || gone.has(l.away)).map((l) => l.id!).sort();
      expect(plan.remove.slice().sort(), `n=${n}`).toEqual(expectedIds);
      expect(plan.insert, `n=${n}: nothing new`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("a duplicate key on either side is a regenerate, never a patch", () => {
    const a = linesOf(4, 1, { stored: true });
    const b = linesOf(6, 1);
    const dupStored = [...a.lines, { ...a.lines[0]!, id: "dup" }];
    expect(planRoundRobinReconcile(dupStored, b.lines, NO_CHANGE)).toEqual({ kind: "regenerate" });
    const dupFresh = [...b.lines, { ...b.lines[0]! }];
    expect(planRoundRobinReconcile(a.lines, dupFresh, NO_CHANGE)).toEqual({ kind: "regenerate" });
    // The control: the same two sides without the duplicate patch.
    expect(planRoundRobinReconcile(a.lines, b.lines, NO_CHANGE).kind).toBe("patch");
  });

  it("a structural change is a regenerate whatever the keys say", () => {
    const a = linesOf(4, 1, { stored: true });
    const b = linesOf(6, 1);
    expect(planRoundRobinReconcile(a.lines, b.lines, { parityFlipped: true, poolMembershipChanged: false })).toEqual({ kind: "regenerate" });
    expect(planRoundRobinReconcile(a.lines, b.lines, { parityFlipped: false, poolMembershipChanged: true })).toEqual({ kind: "regenerate" });
  });

  it("a patched table never seats an entrant twice in a round, whatever round the engine's fresh schedule asked for", () => {
    let checked = 0;
    let moved = 0;
    for (const n of [2, 4, 6, 8]) {
      for (let legs = 1; legs <= 3; legs++) {
        const a = linesOf(n, legs, { stored: true });
        const b = linesOf(n + 2, legs);
        const plan = planRoundRobinReconcile(a.lines, b.lines, NO_CHANGE);
        if (plan.kind !== "patch") throw new Error(`n=${n} legs=${legs}: expected a patch`);
        const table = [...a.lines, ...plan.insert];
        const seen = new Set<string>();
        for (const l of table) {
          for (const e of [l.home, l.away]) {
            const at = `${l.roundNo}|${e}`;
            expect(seen.has(at), `n=${n} legs=${legs}: ${e} twice in round ${l.roundNo}`).toBe(false);
            seen.add(at);
          }
        }
        // Differential: the engine's own n+2 schedule seats the newcomer's pairs in rounds the old table already filled, so the
        // placement had to move at least some of them (the n >= 4 cases always do).
        const freshRound = new Map(b.lines.map((l) => [l.key, l.roundNo]));
        moved += plan.insert.filter((l) => l.roundNo !== freshRound.get(l.key)).length;
        // And no line moved EARLIER than the engine put it.
        for (const l of plan.insert) expect(l.roundNo).toBeGreaterThanOrEqual(freshRound.get(l.key)!);
        checked++;
      }
    }
    expect(checked).toBe(4 * 3);
    expect(moved, "the collision-free placement moved something").toBeGreaterThan(0);
  });

  it("scoped by pool: a pool's change leaves the other pool alone", () => {
    // Two pools of four, no entrant in both (an entrant plays in one pool); pool pa grows to six.
    const a1 = linesOf(4, 1, { pool: "pa", stored: true });
    const a2 = linesOf(4, 1, { pool: "pb", stored: true, prefix: "q" });
    const f1 = linesOf(6, 1, { pool: "pa" });
    const f2 = linesOf(4, 1, { pool: "pb", prefix: "q" });
    const before = [...a1.lines, ...a2.lines];
    const fresh = [...f1.lines, ...f2.lines];
    expect(keysOf(before).size).toBe(before.length);
    const shape = roundRobinShape(before, fresh, { stored: new Set(), fresh: new Set() });
    expect(shape).toEqual(NO_CHANGE);
    const plan = planRoundRobinReconcile(before, fresh, shape);
    expect(plan.kind).toBe("patch");
    if (plan.kind !== "patch") return;
    expect(plan.insert.every((l) => l.pool === "pa"), "only pool pa grew").toBe(true);
    expect(plan.insert.map((l) => l.key).sort()).toEqual(minus(keysOf(f1.lines), keysOf(a1.lines)));
    expect(plan.insert.length).toBe(9);
  });

  it("scoped by leg: a missing leg-2 line inserts that line alone, and a leg-2 key is not the leg-1 key", () => {
    const a = linesOf(4, 2, { stored: true });
    const b = linesOf(4, 2);
    const dropped = a.lines.filter((l) => l.leg === 2).slice(0, 1);
    const before = a.lines.filter((l) => l !== dropped[0]);
    const plan = planRoundRobinReconcile(before, b.lines, NO_CHANGE);
    expect(plan.kind).toBe("patch");
    if (plan.kind !== "patch") return;
    expect(plan.insert.map((l) => l.key)).toEqual([dropped[0]!.key]);
    expect(plan.insert[0]!.leg).toBe(2);
    // The line went back into its own fresh round, so this patched table is no longer than a fresh draw.
    expect(roundSpan([...before, ...plan.insert])).toBe(roundSpan(b.lines));
    // The same pair's leg-1 line is still there, so it was not mistaken for the missing leg-2 one.
    expect(before.some((l) => l.leg === 1 && l.home !== "" && rrKey(l.home, l.away, 1, null) === rrKey(dropped[0]!.home, dropped[0]!.away, 1, null))).toBe(true);
  });

  // rulebook silent on round count; X-CU-6 keeps lines. A league patch keeps every surviving line and adds only the missing pairs,
  // even though the table then runs more rounds than a fresh draw. Spans derived by hand (the old table fills its rounds, so a
  // newcomer meets the old players only after them):
  //  - 1 leg, 4 -> 6: a fresh 6-field is n-1 = 5 rounds; the patched table is 8 (E and F need four distinct rounds each after the
  //    old three, and the E-F line one more).
  //  - 2 legs, 6 -> 8: a fresh 8-field is 2 x 7 = 14 rounds; the patched table is 23.
  describe("patch keeps lines: the round count may grow", () => {
    const cases = [
      { n: 4, m: 6, legs: 1, patched: 8, fresh: 5 },
      { n: 6, m: 8, legs: 2, patched: 23, fresh: 14 },
    ] as const;

    it("a longer patch is still a patch: every surviving line is kept (nothing removed) and exactly the missing pairs are inserted", () => {
      let checked = 0;
      for (const c of cases) {
        const a = linesOf(c.n, c.legs, { stored: true });
        const b = linesOf(c.m, c.legs);
        const shape = roundRobinShape(a.lines, b.lines, { stored: a.byePools, fresh: b.byePools });
        expect(shape, `${c.n}->${c.m}: the shape alone would patch`).toEqual(NO_CHANGE);
        const plan = planRoundRobinReconcile(a.lines, b.lines, shape);
        expect(plan.kind, `${c.n}->${c.m} legs ${c.legs}`).toBe("patch");
        if (plan.kind !== "patch") continue;
        expect(plan.remove, "nothing the old table holds is dropped").toEqual([]);
        const have = new Set(a.lines.map((l) => l.key));
        expect(plan.insert.map((l) => l.key).sort(), "exactly the pairs the fresh schedule has and the old table lacks").toEqual(
          b.lines.filter((l) => !have.has(l.key)).map((l) => l.key).sort(),
        );
        expect(roundSpan([...a.lines, ...plan.insert]), `${c.n}->${c.m} legs ${c.legs}: patched span`).toBe(c.patched);
        expect(roundSpan(b.lines), `${c.n}->${c.m} legs ${c.legs}: fresh span`).toBe(c.fresh);
        expect(c.patched, "the premise: the patch IS longer, and is still kept").toBeGreaterThan(c.fresh);
        checked++;
      }
      expect(checked).toBe(2);
    });

    it("a removal that leaves a late line is a patch too (no redraw to shorten the table)", () => {
      const line = (key: string, home: string, away: string, roundNo: number, id?: string): RrLine => ({ key, home, away, roundNo, leg: 1, pool: null, ...(id ? { id } : {}) });
      const fresh = [line("rr:a:b:L1", "a", "b", 1)];
      const late = [line("rr:a:b:L1", "a", "b", 3, "ab"), line("rr:c:d:L1", "c", "d", 3, "cd")];
      expect(planRoundRobinReconcile(late, fresh, NO_CHANGE)).toEqual({ kind: "patch", insert: [], remove: ["cd"] });
      expect(roundSpan([])).toBe(0);
    });
  });

  it("a stored line to remove with no id is a defect refused by name, not an empty remove", () => {
    const a = linesOf(6, 1); // no ids
    const b = linesOf(4, 1);
    expect(() => planRoundRobinReconcile(a.lines, b.lines, NO_CHANGE)).toThrow(/no id to remove/);
  });
});

describe("roundRobinShape", () => {
  it("a pool appearing or vanishing, or an entrant changing pool, is a membership change", () => {
    const one = linesOf(4, 1, { pool: "pa" });
    const two = linesOf(4, 1, { pool: "pb" });
    // (`two` reuses `one`'s entrants on purpose: the same entrants in a different pool is the re-snake.)
    expect(roundRobinShape(one.lines, [...one.lines, ...two.lines], { stored: new Set(), fresh: new Set() }).poolMembershipChanged).toBe(true);
    expect(roundRobinShape([...one.lines, ...two.lines], one.lines, { stored: new Set(), fresh: new Set() }).poolMembershipChanged).toBe(true);
    // Same entrants, a different pool: a re-snake.
    expect(roundRobinShape(one.lines, two.lines, { stored: new Set(), fresh: new Set() }).poolMembershipChanged).toBe(true);
    // The control: the same pools, the same members.
    expect(roundRobinShape(one.lines, one.lines, { stored: new Set(), fresh: new Set() })).toEqual(NO_CHANGE);
  });

  it("an even pool growing is not a flip; an odd pool that does not change is not either", () => {
    const four = linesOf(4, 1);
    const six = linesOf(6, 1);
    expect(roundRobinShape(four.lines, six.lines, { stored: four.byePools, fresh: six.byePools }).parityFlipped).toBe(false);
    const five = linesOf(5, 1);
    expect(five.byePools.size).toBe(1);
    expect(roundRobinShape(five.lines, five.lines, { stored: five.byePools, fresh: five.byePools }).parityFlipped).toBe(false);
    // And an odd pool that does change flips.
    const seven = linesOf(7, 1);
    expect(roundRobinShape(five.lines, seven.lines, { stored: five.byePools, fresh: seven.byePools }).parityFlipped).toBe(true);
  });
});

describe("rrLinesOfRows (the stored side of the planner)", () => {
  /** The engine's schedule as stored rows: `stored` keeps the `-L{leg}` tail, otherwise the pre-change positional key. */
  function rowsOfSchedule(n: number, legs: number, stored: boolean, pool: string | null = null): RrStoredRow[] {
    return generateRoundRobin({ entrants: entrantsOf(n), config: { legs } }).fixtures.map((f) => ({
      id: `${pool ?? "x"}-${f.id}`,
      ext_key: stored ? rrExtKey("", f.roundNo, f.court, f.leg) : f.id,
      pool_id: pool,
      round_no: f.roundNo,
      seq_in_round: f.court,
      home_entrant_id: f.home,
      away_entrant_id: f.away,
    }));
  }

  it("a stored leg is read off the ext_key; a row drawn before the leg was stored gets the same leg from the order its pair appears in (n = 2..7 x legs 1..3)", () => {
    let checked = 0;
    for (let n = 2; n <= 7; n++) {
      for (let legs = 1; legs <= 3; legs++) {
        const engineLegOf = new Map(generateRoundRobin({ entrants: entrantsOf(n), config: { legs } }).fixtures.map((f) => [`${f.id}`, f.leg]));
        for (const stored of [true, false]) {
          const rows = rowsOfSchedule(n, legs, stored);
          const lines = rrLinesOfRows(rows);
          for (const [i, line] of lines.entries()) {
            const row = rows[i]!;
            const want = engineLegOf.get(rrLegacyExtKey(row.ext_key!))!;
            expect(line, `n=${n} legs=${legs} stored=${stored}`).not.toBeNull();
            expect(line!.leg, `${row.ext_key}`).toBe(want);
            expect(line!.key).toBe(rrKey(row.home_entrant_id!, row.away_entrant_id!, want, null));
            checked++;
          }
        }
      }
    }
    // Sum over n=2..7 of C(n,2) = 1+3+6+10+15+21 = 56 lines, times 6 (legs 1..3 summed = 1+2+3) times two shapes.
    expect(checked).toBe(56 * 6 * 2);
  });

  it("the stored leg wins over the order: a leg-2 line that sorts before its leg-1 pair is still leg 2", () => {
    // RB5-L3 puts a leg-2 bye-slot line AHEAD of a leg-1 append, so round order does not name the leg.
    const rows: RrStoredRow[] = [
      { id: "late", ext_key: rrExtKey("", 9, 1, 1), pool_id: null, round_no: 9, seq_in_round: 1, home_entrant_id: "a", away_entrant_id: "b" },
      { id: "early", ext_key: rrExtKey("", 2, 1, 2), pool_id: null, round_no: 2, seq_in_round: 1, home_entrant_id: "b", away_entrant_id: "a" },
    ];
    expect(rrLinesOfRows(rows).map((l) => l!.leg)).toEqual([1, 2]);
  });

  it("a row with an empty seat has no line (null), and the same pair in two pools counts its legs per pool", () => {
    const rows: RrStoredRow[] = [
      { id: "r1", ext_key: "rr-r1-c1", pool_id: "pa", round_no: 1, seq_in_round: 1, home_entrant_id: "a", away_entrant_id: "b" },
      { id: "r2", ext_key: "rr-r1-c1", pool_id: "pb", round_no: 1, seq_in_round: 1, home_entrant_id: "a", away_entrant_id: "b" },
      { id: "r3", ext_key: "rr-r2-c1", pool_id: "pa", round_no: 2, seq_in_round: 1, home_entrant_id: null, away_entrant_id: "b" },
      { id: "r4", ext_key: "rr-r3-c1", pool_id: "pa", round_no: 3, seq_in_round: 1, home_entrant_id: "b", away_entrant_id: "a" },
    ];
    const lines = rrLinesOfRows(rows);
    expect(lines.map((l) => l?.leg ?? null)).toEqual([1, 1, null, 2]);
    expect(lines[2]).toBeNull();
  });
});
