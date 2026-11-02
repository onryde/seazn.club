// PROMPT-13 item 3: unit-test the freeze selector — which N resources stay
// active after a downgrade (doc 10 §2.4: most recently active first). Pure.
import { describe, expect, it } from "vitest";
import { reconcileFrozen, selectFrozen, type FreezeCandidate, type HeldCandidate } from "../entitlement-freeze";

const c = (id: string, lastActiveAt: string): FreezeCandidate => ({ id, lastActiveAt });

describe("selectFrozen (doc 10 §2.4)", () => {
  const candidates = [
    c("oldest", "2026-01-01T00:00:00Z"),
    c("middle", "2026-03-01T00:00:00Z"),
    c("newest", "2026-06-01T00:00:00Z"),
  ];

  it("keeps the N most recently active; the rest freeze", () => {
    expect(selectFrozen(candidates, 2)).toEqual(new Set(["oldest"]));
    expect(selectFrozen(candidates, 1)).toEqual(new Set(["oldest", "middle"]));
  });

  it("freezes nothing when within quota or unlimited", () => {
    expect(selectFrozen(candidates, 3)).toEqual(new Set());
    expect(selectFrozen(candidates, 99)).toEqual(new Set());
    expect(selectFrozen(candidates, null)).toEqual(new Set());
    expect(selectFrozen([], 0)).toEqual(new Set());
  });

  it("limit 0 freezes everything (feature absent from the plan)", () => {
    expect(selectFrozen(candidates, 0)).toEqual(
      new Set(["oldest", "middle", "newest"]),
    );
  });

  it("input order never matters", () => {
    const shuffled = [candidates[2], candidates[0], candidates[1]];
    expect(selectFrozen(shuffled, 2)).toEqual(selectFrozen(candidates, 2));
  });

  it("ties break deterministically on id", () => {
    const tied = [c("b", "2026-01-01T00:00:00Z"), c("a", "2026-01-01T00:00:00Z")];
    // Same instant: 'a' sorts first (stays active), 'b' freezes — every run.
    expect(selectFrozen(tied, 1)).toEqual(new Set(["b"]));
    expect(selectFrozen([...tied].reverse(), 1)).toEqual(new Set(["b"]));
  });

  it("accepts Date objects as lastActiveAt", () => {
    const dates = [
      { id: "x", lastActiveAt: new Date("2026-01-01") },
      { id: "y", lastActiveAt: new Date("2026-02-01") },
    ];
    expect(selectFrozen(dates, 1)).toEqual(new Set(["x"]));
  });
});

// Match Day PB2, review C1 (owner 2026-11-02, option A: "lock in the frozen set when the org goes over its limit"). The set is
// CHOSEN ONCE — at the read that finds more competitions running than the limit — and stored; activity is read only when the
// set must grow (overflow) or shrink (room). Pure, the persistence is `frozenCompetitionIds`'s.
const h = (id: string, lastActiveAt: string, frozen: boolean): HeldCandidate => ({ id, lastActiveAt, frozen });
const at = (minute: number) => new Date(Date.UTC(2026, 10, 2, 9, minute)).toISOString();

describe("reconcileFrozen — the freeze is chosen once (C1, owner option A)", () => {
  it("EMPTY CASE FIRST: no competitions, nothing to freeze or thaw, at any limit", () => {
    for (const limit of [null, 0, 1, 3]) {
      expect(reconcileFrozen([], limit), `limit ${limit}`).toEqual({ frozen: new Set(), freeze: [], thaw: [] });
    }
  });

  it("the first time over the limit, the least recently active of the running ones freeze (the old selector's choice)", () => {
    const cands = [h("old", at(1), false), h("mid", at(2), false), h("new", at(3), false), h("newest", at(4), false)];
    const moves = reconcileFrozen(cands, 2);
    expect(moves.frozen).toEqual(new Set(["old", "mid"]));
    expect(moves.frozen).toEqual(selectFrozen(cands, 2));
    expect([...moves.freeze].sort()).toEqual(["mid", "old"]);
    expect(moves.thaw).toEqual([]);
  });

  it("C1: a frozen competition becoming the most recently active moves NOTHING — the stored set stands, and nothing new freezes", () => {
    // "old" was frozen when the org went over; then it scored, so it is now the newest activity of all.
    const cands = [h("old", at(59), true), h("a", at(2), false), h("b", at(3), false)];
    expect(selectFrozen(cands, 2), "premise: the OLD rule would rotate the freeze onto 'a'").toEqual(new Set(["a"]));
    expect(reconcileFrozen(cands, 2)).toEqual({ frozen: new Set(["old"]), freeze: [], thaw: [] });
  });

  it("room: exactly as many thaw as there is room, the most recently active frozen ones first (ties on id)", () => {
    const cands = [
      h("frozen-idle", at(1), true),
      h("frozen-scored", at(50), true),
      h("frozen-tie-b", at(30), true),
      h("frozen-tie-a", at(30), true),
      h("running", at(5), false),
    ];
    expect(reconcileFrozen(cands, 2).thaw, "one place free").toEqual(["frozen-scored"]);
    expect(reconcileFrozen(cands, 3).thaw, "two places: the tie breaks on id").toEqual(["frozen-scored", "frozen-tie-a"]);
    const roomy = reconcileFrozen(cands, 9);
    expect(roomy.thaw, "room for all: every one thaws").toHaveLength(4);
    expect(roomy.frozen).toEqual(new Set());
  });

  it("unlimited (an upgrade, a staff grant): every frozen competition thaws", () => {
    const cands = [h("x", at(1), true), h("y", at(2), true), h("z", at(3), false)];
    expect(reconcileFrozen(cands, null)).toEqual({ frozen: new Set(), freeze: [], thaw: ["y", "x"] });
  });

  it("the overflow grows (a pass ends, a downgrade): the running ones pay for it, the frozen stay frozen", () => {
    // "back" re-entered the active set over the limit and is the most recently active; "held" was already frozen.
    const cands = [h("held", at(58), true), h("back", at(59), false), h("a", at(2), false), h("b", at(3), false)];
    const moves = reconcileFrozen(cands, 2);
    expect(moves.freeze).toEqual(["a"]);
    expect(moves.frozen).toEqual(new Set(["held", "a"]));
  });

  it("EVERY small case (n ≤ 6 competitions, every stored mask, limits null and 0–7): the set is the overflow's size, a settled set never moves again whatever the activity does, and a move is only ever the overflow growing or room appearing — counted", () => {
    let checked = 0;
    let settledChecked = 0;
    for (let n = 0; n <= 6; n++) {
      for (let mask = 0; mask < 1 << n; mask++) {
        for (const limit of [null, 0, 1, 2, 3, 4, 5, 6, 7]) {
          const cands = Array.from({ length: n }, (_, i) => h(`c${i}`, at(i), (mask & (1 << i)) !== 0));
          const moves = reconcileFrozen(cands, limit);
          const overflow = limit === null ? 0 : Math.max(0, n - limit);
          expect(moves.frozen.size, `n=${n} mask=${mask} limit=${limit}`).toBe(overflow);
          const wasFrozen = new Set(cands.filter((c) => c.frozen).map((c) => c.id));
          // Never both: the overflow grows OR room appears.
          expect(moves.freeze.length === 0 || moves.thaw.length === 0).toBe(true);
          for (const id of moves.freeze) expect(wasFrozen.has(id), `froze ${id} twice`).toBe(false);
          for (const id of moves.thaw) expect(wasFrozen.has(id), `thawed ${id}, which was not frozen`).toBe(true);
          // Held marks stay held unless room thaws them: nothing frozen is silently swapped for something else.
          for (const id of wasFrozen) expect(moves.frozen.has(id) || moves.thaw.includes(id)).toBe(true);
          checked++;
          // Settled: apply the moves, then turn the activity upside down (the most recent becomes the oldest) — nothing moves.
          const settled = cands.map((c, i) => h(c.id, at(59 - i), moves.frozen.has(c.id)));
          expect(reconcileFrozen(settled, limit), `settled n=${n} mask=${mask} limit=${limit}`).toEqual({
            frozen: moves.frozen,
            freeze: [],
            thaw: [],
          });
          settledChecked++;
        }
      }
    }
    expect(checked, "cases enumerated").toBe(127 * 9);
    expect(settledChecked).toBe(checked);
  });
});
