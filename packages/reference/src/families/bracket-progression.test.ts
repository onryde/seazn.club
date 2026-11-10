// The bracket-progression family's tests (W4 app B, Task 14; design §6.4). Every expected value is read from the signed
// rulebook (docs/superpowers/specs/2026-09-27-format-matrix-prompts/rulebook-W4-knockout.md): each `it` names its RB4
// row, and each expected value is hand-derived from that row — never from engine or app code (R8). Every sweep counts
// what it examined and zero is a failure (R25).
import { describe, expect, it } from "vitest";
import { ProgressionOutOfScope, ProgressionRuledOut, bracketProgression, type LateLine, type RankInput } from "./bracket-progression.ts";

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `e${i + 1}`);
const seedsOf = (n: number, k: number): Map<string, number> => new Map(ids(k).map((e, i) => [e, i + 1]));
const place = (r: readonly { entrant: string; rank: number }[]): Record<string, number> => Object.fromEntries(r.map((p) => [p.entrant, p.rank]));

describe("draw — RB4-D1, D2, D3, D4, D5, E1, E2", () => {
  it("RB4-D1: eight seeds sit on the standard fold — 1 top, 2 bottom, 3 above it, 4 under 1's quarter", () => {
    const d = bracketProgression.draw(ids(8), seedsOf(8, 8), 1);
    expect(d.size).toBe(8);
    expect(d.slots).toEqual(["e1", "e8", "e5", "e4", "e3", "e6", "e7", "e2"]);
  });

  it("RB4-D1: sixteen seeds — the classic sheet, round-1 seeds summing to 17 (counted over every round-1 match)", () => {
    const d = bracketProgression.draw(ids(16), seedsOf(16, 16), 1);
    expect(d.slots).toEqual(["e1", "e16", "e9", "e8", "e5", "e12", "e13", "e4", "e3", "e14", "e11", "e6", "e7", "e10", "e15", "e2"]);
    let checked = 0;
    const n = (e: string | null) => Number(e!.slice(1));
    for (let i = 0; i < 16; i += 2) {
      expect(n(d.slots[i]!) + n(d.slots[i + 1]!), `round-1 match at ${i}`).toBe(17); // round 1 pairs sum to 2^4 + 1
      checked++;
    }
    expect(checked).toBe(8);
  });

  it("RB4-D2: five entrants fill eight positions; the three byes face the TOP three seeds", () => {
    const d = bracketProgression.draw(ids(5), seedsOf(5, 5), 1);
    expect(d.slots).toEqual(["e1", null, "e5", "e4", "e3", null, null, "e2"]);
    expect(d.byeHolders).toEqual(["e1", "e2", "e3"]);
  });

  it("RB4-E3: two entrants are one final with no byes", () => {
    const d = bracketProgression.draw(ids(2), seedsOf(2, 2), 1);
    expect(d.slots).toEqual(["e1", "e2"]);
    expect(d.byeHolders).toEqual([]);
  });

  it("RB4-E1, E2: no entrants and one entrant are refused by name, never an empty bracket", () => {
    for (const n of [0, 1]) expect(() => bracketProgression.draw(ids(n), new Map(), 1), `n=${n}`).toThrow(ProgressionRuledOut);
  });

  it("RB4-D2 sweep: for every n 2..33 every entrant sits once and each bye faces a top seed (counted)", () => {
    let checked = 0;
    for (let n = 2; n <= 33; n++) {
      const d = bracketProgression.draw(ids(n), seedsOf(n, n), 7);
      const size = [2, 4, 8, 16, 32, 64].find((s) => s >= n)!;
      expect(d.size, `n=${n}`).toBe(size);
      expect(d.slots.filter((s) => s !== null).sort(), `n=${n}`).toEqual(ids(n).sort());
      expect(d.slots.filter((s) => s === null).length, `n=${n} byes`).toBe(size - n);
      // a bye's opposite number holds seed 1..(size-n): the top seeds
      for (let i = 0; i < size; i += 2) {
        const [a, b] = [d.slots[i], d.slots[i + 1]];
        if (a === null || b === null) {
          const holder = (a ?? b)!;
          expect(Number(holder.slice(1)), `n=${n} bye holder`).toBeLessThanOrEqual(size - n);
        }
      }
      checked++;
    }
    expect(checked).toBe(32);
  });

  it("RB4-D3: the unseeded are drawn, not left in registration order — across ten seeds the order moves", () => {
    const orders = new Set<string>();
    for (let s = 1; s <= 10; s++) orders.add(bracketProgression.draw(ids(8), new Map(), s).order.join());
    expect(orders.size).toBeGreaterThan(1);
    expect(orders.size).toBeGreaterThanOrEqual(5); // ten seeds, ten different shuffles of eight: far from one answer
  });

  it("RB4-D4, D5: the same seed and the same entrants give the same bracket, every time (counted)", () => {
    let checked = 0;
    for (let s = 1; s <= 20; s++) {
      const a = bracketProgression.draw(ids(11), seedsOf(11, 3), s);
      const b = bracketProgression.draw(ids(11), seedsOf(11, 3), s);
      expect(b, `seed ${s}`).toEqual(a);
      checked++;
    }
    expect(checked).toBe(20);
  });

  it("RB4-D1 + D3: a seeded entrant never moves with the draw seed; only the unseeded do (counted)", () => {
    let checked = 0;
    for (let s = 1; s <= 20; s++) {
      const d = bracketProgression.draw(ids(6), seedsOf(6, 2), s);
      expect(d.order.slice(0, 2), `seed ${s}`).toEqual(["e1", "e2"]);
      expect([...d.order.slice(2)].sort(), `seed ${s}`).toEqual(["e3", "e4", "e5", "e6"]);
      checked++;
    }
    expect(checked).toBe(20);
  });

  it("R6: seeds that are not 1..k (a gap, a repeat) are refused — the rows are silent on them", () => {
    expect(() => bracketProgression.draw(ids(4), new Map([["e1", 1], ["e2", 3]]), 1)).toThrow(ProgressionRuledOut);
    expect(() => bracketProgression.draw(ids(4), new Map([["e1", 1], ["e2", 1]]), 1)).toThrow(ProgressionRuledOut);
  });
});

describe("lateEntryCase — RB4-L3 … L8", () => {
  const bye = (position: number, seed: number | null, holderStarted = false): LateLine => ({ kind: "bye", position, seed, holderStarted });
  const withdrawn = (position: number, started = false): LateLine => ({ kind: "withdrawn", position, started });
  const played = (position: number): LateLine => ({ kind: "played", position });

  it("RB4-L3, L4: with several open byes the LOWEST-seeded holder's bye is reversed", () => {
    expect(bracketProgression.lateEntryCase([bye(0, 1), bye(2, 3), bye(4, 2), played(6)], false)).toEqual({ case: "bye", position: 2 });
  });

  it("RB4-L3: a bye whose holder has started round 2 is not open; the next-lowest seed's is", () => {
    expect(bracketProgression.lateEntryCase([bye(0, 1), bye(2, 3, true), bye(4, 2)], true)).toEqual({ case: "bye", position: 4 });
  });

  it("RB4-L4: seeds tie by draw position; an unseeded holder is lowest of all", () => {
    expect(bracketProgression.lateEntryCase([bye(4, null), bye(2, null), bye(0, 1)], false)).toEqual({ case: "bye", position: 2 });
  });

  it("RB4-L5: no open bye, a withdrawn slot before its first match takes the entrant", () => {
    expect(bracketProgression.lateEntryCase([bye(0, 1, true), withdrawn(2, true), withdrawn(4), played(6)], true)).toEqual({ case: "withdrawn_slot", position: 4 });
  });

  it("RB4-L3 before L5: an open bye outranks an open withdrawn slot", () => {
    expect(bracketProgression.lateEntryCase([withdrawn(0), bye(2, 2)], false)).toEqual({ case: "bye", position: 2 });
  });

  it("RB4-L6: nothing open — refused, and Rebuild is offered only while nothing has started", () => {
    const lines = [played(0), played(2), bye(4, 1, true)];
    expect(bracketProgression.lateEntryCase(lines, true)).toEqual({ case: "refused" });
    expect(bracketProgression.lateEntryCase(lines, false)).toEqual({ case: "rebuild_offered" });
  });

  it("RB4-L8: a stepladder or page playoff takes case (2) only — its bye is never reversed", () => {
    expect(bracketProgression.lateEntryCase([bye(0, 1), withdrawn(2)], false, "stepladder")).toEqual({ case: "withdrawn_slot", position: 2 });
    expect(bracketProgression.lateEntryCase([bye(0, 1)], true, "page_playoff")).toEqual({ case: "refused" });
  });

  it("R6: a bracket with no round-1 lines, or two lines at one position, is refused", () => {
    expect(() => bracketProgression.lateEntryCase([], false)).toThrow(ProgressionRuledOut);
    expect(() => bracketProgression.lateEntryCase([played(0), played(0)], false)).toThrow(ProgressionRuledOut);
  });
});

describe("plateField — RB4-P1, P2, E6", () => {
  const fm = (entrant: string, round: number, position: number, result: "won" | "lost" | "lost_by_forfeit" | "pending") => ({ entrant, round, position, result });

  it("RB4-P1: every first loss enters — a round-1 loser and a bye holder's round-2 loss — ordered by round then position", () => {
    const f = bracketProgression.plateField([fm("a", 0, 0, "lost"), fm("b", 0, 1, "won"), fm("c", 1, 0, "lost"), fm("d", 0, 2, "lost")]);
    expect(f).toMatchObject({ complete: true, outcome: "field", losers: ["a", "d", "c"], excluded: [], pending: [] });
  });

  it("RB4-P2: a first loss by walkover, withdrawal or retirement is excluded, never entered", () => {
    const f = bracketProgression.plateField([fm("a", 0, 0, "lost"), fm("b", 0, 1, "lost_by_forfeit"), fm("c", 0, 2, "lost"), fm("d", 0, 3, "won")]);
    expect(f.losers).toEqual(["a", "c"]);
    expect(f.excluded).toEqual(["b"]);
  });

  it("RB4-P3: a first match still to play keeps the field open — the plate waits, it is not 'not enough'", () => {
    const f = bracketProgression.plateField([fm("a", 0, 0, "lost"), fm("b", 1, 0, "pending")]);
    expect(f).toMatchObject({ complete: false, outcome: "waiting", pending: ["b"] });
  });

  it("RB4-E6: a complete field under two is a NAMED outcome, never an empty success", () => {
    expect(bracketProgression.plateField([fm("a", 0, 0, "lost"), fm("b", 0, 1, "won")])).toMatchObject({ complete: true, outcome: "not_enough", losers: ["a"] });
    expect(bracketProgression.plateField([fm("a", 0, 0, "lost_by_forfeit"), fm("b", 0, 1, "won")])).toMatchObject({ complete: true, outcome: "not_enough", losers: [] });
  });

  it("empty case: no first matches at all is no main draw yet — never complete", () => {
    expect(bracketProgression.plateField([])).toMatchObject({ complete: false, outcome: "waiting", losers: [], excluded: [], pending: [] });
  });
});

describe("luckyLoser — RB4-V2 … V5, E7", () => {
  const cand = (entrant: string, rank: number, seed: number | null, lostBy: "play" | "walkover" | "withdrawal" | "disqualification" = "play") => ({ entrant, rank, seed, lostBy });

  it("RB4-V2: the highest-ranked qualifying entrant below the cut is the lucky loser (rank q+1 first)", () => {
    expect(bracketProgression.luckyLoser([cand("c", 6, 6), cand("a", 5, 5), cand("b", 7, 7)], 1, false)).toEqual({ kind: "lucky_loser", entrant: "a" });
  });

  it("RB4-V2: a tie on rank goes to the better seed, an unseeded entrant after every seed", () => {
    expect(bracketProgression.luckyLoser([cand("x", 5, null), cand("y", 5, 9), cand("z", 5, 4)], 1, false)).toEqual({ kind: "lucky_loser", entrant: "z" });
    expect(bracketProgression.luckyLoser([cand("x", 5, null), cand("y", 5, 9)], 1, false)).toEqual({ kind: "lucky_loser", entrant: "y" });
  });

  it("RB4-V2, V5: a tie on rank and seed is random — by the destination stage's draw seed, replayable, and both sides occur (counted)", () => {
    const pool = [cand("p", 5, null), cand("q", 5, null)];
    const seen = new Set<string>();
    let checked = 0;
    for (let s = 1; s <= 40; s++) {
      const a = bracketProgression.luckyLoser(pool, s, false);
      expect(bracketProgression.luckyLoser(pool, s, false), `seed ${s} replays`).toEqual(a);
      if (a.kind === "lucky_loser") seen.add(a.entrant);
      checked++;
    }
    expect(checked).toBe(40);
    expect([...seen].sort()).toEqual(["p", "q"]);
  });

  it("RB4-V5: a loser by walkover, withdrawal or disqualification is not eligible", () => {
    expect(bracketProgression.luckyLoser([cand("a", 5, 1, "walkover"), cand("b", 6, 2, "withdrawal"), cand("c", 7, 3, "disqualification"), cand("d", 8, 4)], 1, false)).toEqual({ kind: "lucky_loser", entrant: "d" });
  });

  it("RB4-E7: an empty pool, or one with no eligible entrant, leaves the vacancy to walk over", () => {
    expect(bracketProgression.luckyLoser([], 1, false)).toEqual({ kind: "walkover" });
    expect(bracketProgression.luckyLoser([cand("a", 5, 1, "walkover")], 1, false)).toEqual({ kind: "walkover" });
  });

  it("RB4-V3: once the qualifier's first main-draw match has started the vacancy is a walkover, whoever is in the pool", () => {
    expect(bracketProgression.luckyLoser([cand("a", 5, 1)], 1, true)).toEqual({ kind: "walkover" });
  });
});

describe("ranks — RB4-T2, T3, T4, T6, C1, C3, C4, R1, R2", () => {
  const base = (over: Partial<RankInput>): RankInput => ({ thirdPlace: "shared", title: { kind: "champion", champion: "A", runnerUp: "B" }, semiLosers: [], others: [], ...over });

  it("RB4-C1: n=2 — the final's winner is 1st, its loser 2nd", () => {
    expect(place(bracketProgression.ranks(base({})))).toEqual({ A: 1, B: 2 });
  });

  it("RB4-E5: n=3 — the single semi-final loser ranks 3rd alone", () => {
    expect(place(bracketProgression.ranks(base({ semiLosers: ["C"] })))).toEqual({ A: 1, B: 2, C: 3 });
  });

  it("RB4-T2: shared — both semi-final losers rank 3rd and nobody ranks 4th", () => {
    expect(place(bracketProgression.ranks(base({ semiLosers: ["C", "D"] })))).toEqual({ A: 1, B: 2, C: 3, D: 3 });
  });

  it("RB4-T2, R2: shared 3rd is followed by 5th, and below the semi-finals ranks are strict: round, then seed, then id", () => {
    const r = place(
      bracketProgression.ranks(
        base({
          semiLosers: ["C", "D"],
          others: [
            { entrant: "q8", eliminatedRound: 0, seed: 8 },
            { entrant: "q5", eliminatedRound: 0, seed: 5 },
            { entrant: "q7", eliminatedRound: 0, seed: 7 },
            { entrant: "q6", eliminatedRound: 0, seed: 6 },
          ],
        }),
      ),
    );
    expect(r).toEqual({ A: 1, B: 2, C: 3, D: 3, q5: 5, q6: 6, q7: 7, q8: 8 });
  });

  it("RB4-R2: a later elimination round beats a better seed; an unseeded entrant ranks after the seeded; the id is the last key", () => {
    const r = place(
      bracketProgression.ranks(
        base({
          semiLosers: ["C", "D"],
          others: [
            { entrant: "early-seed1", eliminatedRound: 0, seed: 1 },
            { entrant: "late-seed9", eliminatedRound: 1, seed: 9 },
            { entrant: "late-none-b", eliminatedRound: 1, seed: null },
            { entrant: "late-none-a", eliminatedRound: 1, seed: null },
          ],
        }),
      ),
    );
    expect(r).toEqual({ A: 1, B: 2, C: 3, D: 3, "late-seed9": 5, "late-none-a": 6, "late-none-b": 7, "early-seed1": 8 });
  });

  it("RB4-T3: a play-off decides 3rd and 4th", () => {
    const r = bracketProgression.ranks(base({ thirdPlace: "playoff", semiLosers: ["C", "D"], playoff: { kind: "decided", winner: "D", loser: "C" } }));
    expect(place(r)).toEqual({ A: 1, B: 2, D: 3, C: 4 });
  });

  it("RB4-T6: a play-off walked over (one side out) is 3rd and 4th as played", () => {
    const r = bracketProgression.ranks(base({ thirdPlace: "playoff", semiLosers: ["C", "D"], playoff: { kind: "walkover", winner: "C", loser: "D" } }));
    expect(place(r)).toEqual({ A: 1, B: 2, C: 3, D: 4 });
  });

  it("RB4-T6: a play-off with both sides out leaves 3rd VACANT and both rank 4th; the entrants below still start at 5th (the four semi-finalists hold places 1 to 4)", () => {
    const r = place(bracketProgression.ranks(base({ thirdPlace: "playoff", semiLosers: ["C", "D"], playoff: { kind: "both_out" }, others: [{ entrant: "x", eliminatedRound: 0, seed: 5 }] })));
    expect(r).toEqual({ A: 1, B: 2, C: 4, D: 4, x: 5 });
  });

  it("RB4-C3: both finalists out — nobody ranks 1st, both rank 2nd, the semi-final losers still 3rd", () => {
    const r = place(bracketProgression.ranks(base({ title: { kind: "vacant", finalists: ["A", "B"] }, semiLosers: ["C", "D"] })));
    expect(r).toEqual({ A: 2, B: 2, C: 3, D: 3 });
  });

  it("RB4-C4: joint winners both rank 1st; the next place is 3rd", () => {
    const r = place(bracketProgression.ranks(base({ title: { kind: "joint", winners: ["A", "B"] }, semiLosers: ["C", "D"] })));
    expect(r).toEqual({ A: 1, B: 1, C: 3, D: 3 });
  });

  it("RB4-C3 / C4 with a play-off, and on a two-entrant bracket", () => {
    const po = { thirdPlace: "playoff" as const, semiLosers: ["C", "D"], playoff: { kind: "decided" as const, winner: "C", loser: "D" } };
    expect(place(bracketProgression.ranks(base({ ...po, title: { kind: "joint", winners: ["A", "B"] } })))).toEqual({ A: 1, B: 1, C: 3, D: 4 });
    expect(place(bracketProgression.ranks(base({ ...po, title: { kind: "vacant", finalists: ["A", "B"] } })))).toEqual({ A: 2, B: 2, C: 3, D: 4 });
    expect(place(bracketProgression.ranks(base({ title: { kind: "vacant", finalists: ["A", "B"] } })))).toEqual({ A: 2, B: 2 });
    expect(place(bracketProgression.ranks(base({ title: { kind: "joint", winners: ["A", "B"] } })))).toEqual({ A: 1, B: 1 });
  });

  it("RB4-R1: every entrant appears exactly once, over a counted grid of title × third-place × field size", () => {
    let checked = 0;
    const titles: RankInput["title"][] = [
      { kind: "champion", champion: "A", runnerUp: "B" },
      { kind: "joint", winners: ["A", "B"] },
      { kind: "vacant", finalists: ["A", "B"] },
    ];
    for (const title of titles) {
      for (const thirdPlace of ["shared", "playoff"] as const) {
        for (let n = 2; n <= 20; n++) {
          if (thirdPlace === "playoff" && n < 4) continue;
          const semi = n === 2 ? [] : n === 3 ? ["s1"] : ["s1", "s2"];
          const others = ids(Math.max(0, n - 2 - semi.length)).map((e, i) => ({ entrant: `o${e}`, eliminatedRound: i % 3, seed: i % 2 === 0 ? i + 3 : null }));
          const r = bracketProgression.ranks({ title, thirdPlace, semiLosers: semi, others, ...(thirdPlace === "playoff" ? { playoff: { kind: "decided" as const, winner: "s1", loser: "s2" } } : {}) });
          expect(r.map((p) => p.entrant).sort(), `${title.kind}/${thirdPlace}/n=${n}`).toEqual(["A", "B", ...semi, ...others.map((o) => o.entrant)].sort());
          checked++;
        }
      }
    }
    expect(checked).toBe(3 * (19 + 17));
  });

  it("RB4-T4, E5, T3: a play-off below four entrants, a play-off result under Shared, and a missing play-off result are refused", () => {
    expect(() => bracketProgression.ranks(base({ thirdPlace: "playoff", semiLosers: ["C"] }))).toThrow(ProgressionRuledOut);
    expect(() => bracketProgression.ranks(base({ thirdPlace: "shared", semiLosers: ["C", "D"], playoff: { kind: "both_out" } }))).toThrow(ProgressionRuledOut);
    expect(() => bracketProgression.ranks(base({ thirdPlace: "playoff", semiLosers: ["C", "D"] }))).toThrow(ProgressionRuledOut);
  });

  it("R6: an entrant named twice, or three semi-final losers, is refused", () => {
    expect(() => bracketProgression.ranks(base({ semiLosers: ["A"] }))).toThrow(ProgressionRuledOut);
    expect(() => bracketProgression.ranks(base({ semiLosers: ["C", "D", "E"] }))).toThrow(ProgressionRuledOut);
  });
});

describe("ladderSeats — RB4-S1 … S5", () => {
  const seeds = (k: number) => ids(k);

  it("RB4-S1: a stepladder of four — the lowest two play first, each winner meets the next seed up, the last rung is against seed 1", () => {
    const r = bracketProgression.ladderSeats({ kind: "stepladder", seeds: seeds(4), withdrawn: [], decide: { 1: "home", 2: "home", 3: "home" } });
    expect(r.matches.map((m) => [m.home, m.away])).toEqual([["e3", "e4"], ["e2", "e3"], ["e1", "e2"]]);
    expect(place(r.ranks)).toEqual({ e1: 1, e2: 2, e3: 3, e4: 4 });
  });

  it("RB4-S1: a climber who wins every rung is champion", () => {
    const r = bracketProgression.ladderSeats({ kind: "stepladder", seeds: seeds(4), withdrawn: [], decide: { 1: "away", 2: "away", 3: "away" } });
    expect(r.matches.map((m) => [m.home, m.away])).toEqual([["e3", "e4"], ["e2", "e4"], ["e1", "e4"]]);
    expect(place(r.ranks)).toEqual({ e4: 1, e1: 2, e2: 3, e3: 4 });
  });

  it("RB4-S3, S4: a withdrawn stepladder seed walks the rung over and ranks as the loser of the rung it was due to enter", () => {
    const r = bracketProgression.ladderSeats({ kind: "stepladder", seeds: seeds(4), withdrawn: ["e2"], decide: { 1: "home", 3: "home" } });
    expect(r.matches.map((m) => m.walkover)).toEqual([null, "away", null]);
    expect(r.matches[1]).toMatchObject({ home: "e2", away: "e3" });
    expect(r.matches[2]).toMatchObject({ home: "e1", away: "e3" });
    expect(place(r.ranks)).toEqual({ e1: 1, e3: 2, e2: 3, e4: 4 });
  });

  it("RB4-S4: a withdrawn bottom seed loses the first rung by walkover and ranks last", () => {
    const r = bracketProgression.ladderSeats({ kind: "stepladder", seeds: seeds(3), withdrawn: ["e3"], decide: { 2: "home" } });
    expect(r.matches[0]).toMatchObject({ home: "e2", away: "e3", walkover: "home" });
    expect(place(r.ranks)).toEqual({ e1: 1, e2: 2, e3: 3 });
  });

  it("RB4-S4: every seed appears once in the ranks, over a counted grid of ladder size × one withdrawn seed", () => {
    let checked = 0;
    for (let k = 3; k <= 8; k++) {
      for (const w of [...seeds(k), null]) {
        const decide: Record<number, "home"> = {};
        for (let j = 1; j < k; j++) decide[j] = "home"; // a walked-over rung ignores its entry: the withdrawn side loses it
        const r = bracketProgression.ladderSeats({ kind: "stepladder", seeds: seeds(k), withdrawn: w === null ? [] : [w], decide });
        expect(r.ranks.map((p) => p.entrant).sort(), `k=${k} w=${w}`).toEqual(seeds(k).sort());
        expect(new Set(r.ranks.map((p) => p.rank)).size, `k=${k} w=${w} distinct`).toBe(k);
        checked++;
      }
    }
    expect(checked).toBe(4 + 5 + 6 + 7 + 8 + 9); // k seeds withdrawn one at a time, plus the unwithdrawn run, for each size
  });

  it("RB4-S2: a page playoff — Q1 1v2, E 3v4, Q2 loser(Q1) v winner(E), Final winner(Q1) v winner(Q2)", () => {
    const r = bracketProgression.ladderSeats({ kind: "page_playoff", seeds: seeds(4), withdrawn: [], decide: { Q1: "home", E: "home", Q2: "home", F: "home" } });
    expect(r.matches.map((m) => [m.label, m.home, m.away])).toEqual([["Q1", "e1", "e2"], ["E", "e3", "e4"], ["Q2", "e2", "e3"], ["F", "e1", "e2"]]);
    expect(place(r.ranks)).toEqual({ e1: 1, e2: 2, e3: 3, e4: 4 });
  });

  it("RB4-S5: a Q1 withdrawal walks Q1 over, then Q2 over to E's winner; the withdrawn ranks below everyone still in the stage", () => {
    const r = bracketProgression.ladderSeats({ kind: "page_playoff", seeds: seeds(4), withdrawn: ["e1"], decide: { E: "home", F: "home" } });
    const byLabel = Object.fromEntries(r.matches.map((m) => [m.label, m]));
    expect(byLabel.Q1).toMatchObject({ home: "e1", away: "e2", walkover: "away" });
    expect(byLabel.Q2).toMatchObject({ home: "e1", away: "e3", walkover: "away" });
    expect(byLabel.F).toMatchObject({ home: "e2", away: "e3", walkover: null });
    expect(place(r.ranks)).toEqual({ e2: 1, e3: 2, e4: 3, e1: 4 });
  });

  it("RB4-S5: Q1's other side withdrawing is the same shape — the withdrawn is last, E's loser 3rd", () => {
    const r = bracketProgression.ladderSeats({ kind: "page_playoff", seeds: seeds(4), withdrawn: ["e2"], decide: { E: "home", F: "away" } });
    expect(r.matches.find((m) => m.label === "Q1")).toMatchObject({ walkover: "home" });
    expect(r.matches.find((m) => m.label === "Q2")).toMatchObject({ home: "e2", away: "e3", walkover: "away" });
    expect(place(r.ranks)).toEqual({ e3: 1, e1: 2, e4: 3, e2: 4 });
  });

  it("RB4-S3: an E withdrawal walks E over and the withdrawn ranks 4th as E's loser", () => {
    const r = bracketProgression.ladderSeats({ kind: "page_playoff", seeds: seeds(4), withdrawn: ["e3"], decide: { Q1: "home", Q2: "home", F: "home" } });
    expect(r.matches.find((m) => m.label === "E")).toMatchObject({ walkover: "away" });
    expect(place(r.ranks)).toEqual({ e1: 1, e2: 2, e4: 3, e3: 4 });
  });

  it("R6: a played match nobody decided, a one-seed ladder, a page playoff of three, two withdrawals in a page playoff and a double walkover on rung one are refused by name", () => {
    expect(() => bracketProgression.ladderSeats({ kind: "stepladder", seeds: seeds(3), withdrawn: [], decide: { 1: "home" } })).toThrow(ProgressionRuledOut);
    expect(() => bracketProgression.ladderSeats({ kind: "stepladder", seeds: seeds(1), withdrawn: [], decide: {} })).toThrow(ProgressionRuledOut);
    expect(() => bracketProgression.ladderSeats({ kind: "page_playoff", seeds: seeds(3), withdrawn: [], decide: {} })).toThrow(ProgressionRuledOut);
    expect(() => bracketProgression.ladderSeats({ kind: "page_playoff", seeds: seeds(4), withdrawn: ["e1", "e3"], decide: {} })).toThrow(ProgressionOutOfScope);
    expect(() => bracketProgression.ladderSeats({ kind: "stepladder", seeds: seeds(4), withdrawn: ["e3", "e4"], decide: { 2: "home", 3: "home" } })).toThrow(ProgressionOutOfScope);
  });
});
