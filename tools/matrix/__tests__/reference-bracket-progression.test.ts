// W4 app B, Task 14 (design §6.4): the bracket-progression ORACLE (@seazn/reference, written from rulebook-W4-knockout.md)
// against the engine's own functions over a COUNTED grid. The oracle's answers are the rulebook's; the engine is the
// product. A disagreement is a finding routed to the owning task — never an oracle edit to match (brief Step 2).
// Compared here: (a) generateSingleElim's round-1 pairs (RB4-D1, D2) and its late-entry slot (RB4-L3, L4);
// firstLossField (RB4-P1, P2, P3); completeBracketStage's final ranks and title (RB4-T2, T3, T6, C1, C3, C4, R1, R2).
// (b) the app's bracketPlaceLabels is compared in apps/web/src/lib/__tests__/bracket-places-oracle.test.ts — the app's `@/`
// alias does not resolve from this directory, and the matrix CI step refuses any executed file outside tools/matrix.
import { completeBracketStage, firstLossField, type BracketFixture, type BracketFixtureRow } from "@seazn/engine/competition";
import { generateSingleElim, type BracketFixtureGen } from "@seazn/engine/scheduling";
import { ProgressionRuledOut, bracketProgression, type FirstMatch, type LateLine, type RankInput } from "@seazn/reference";
import { describe, expect, it } from "vitest";

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `e${i + 1}`);
const num = (e: string): number => Number(e.slice(1));
const SIZES = Array.from({ length: 32 }, (_, i) => i + 2); // n = 2 … 33

/** A simulated bracket: the engine's generated fixtures, seated by the higher seed (the lower number) winning every match. */
interface Sim {
  gen: BracketFixtureGen[];
  rounds: number;
  rows: Map<string, BracketFixture>;
}
function simulate(n: number, thirdPlace: boolean, title: "champion" | "joint" | "vacant", upTo = Number.POSITIVE_INFINITY, forfeitFirst = false): Sim {
  const order = ids(n);
  const g = generateSingleElim({ entrants: order, seeds: new Map(order.map((e, i) => [e, i + 1])), thirdPlace });
  const rows = new Map<string, BracketFixture>();
  const seat = (ref: { fixtureId: string; side: "winner" | "loser" } | undefined, own: string | undefined): string | undefined => {
    if (own !== undefined) return own;
    if (ref === undefined) return undefined;
    const r = rows.get(ref.fixtureId)!;
    return ref.side === "winner" ? r.winner : r.loser;
  };
  let forfeited = false;
  for (const f of g.fixtures) {
    const home = seat(f.homeFrom, f.home);
    const away = seat(f.awayFrom, f.away);
    const base = { id: f.id, round: f.round, ...(f.isFinal ? { isFinal: true } : {}), ...(f.thirdPlace ? { thirdPlace: true } : {}), ...(f.homeFrom ? { homeFrom: f.homeFrom } : {}), ...(f.awayFrom ? { awayFrom: f.awayFrom } : {}), ...(home === undefined ? {} : { home }), ...(away === undefined ? {} : { away }) };
    if (f.award !== undefined) rows.set(f.id, { ...base, status: "walkover", winner: f.award });
    else if (f.round > upTo) rows.set(f.id, { ...base, status: "scheduled" });
    else if (home !== undefined && away !== undefined) {
      const winner = num(home) < num(away) ? home : away;
      const loser = winner === home ? away : home;
      if (f.isFinal && title === "joint") rows.set(f.id, { ...base, status: "decided", jointWinners: true });
      else if (f.isFinal && title === "vacant") rows.set(f.id, { ...base, status: "walkover", walkedOver: "both" });
      else if (forfeitFirst && !forfeited && f.round === 0) {
        forfeited = true;
        rows.set(f.id, { ...base, status: "walkover", winner, loser, walkedOver: "loser" });
      } else rows.set(f.id, { ...base, status: "decided", winner, loser });
    } else rows.set(f.id, { ...base, status: "scheduled" });
  }
  return { gen: g.fixtures, rounds: g.rounds, rows };
}

describe("draw / generateSingleElim — RB4-D1, D2: the oracle's round-1 pairs are the engine's", () => {
  it("every n 2..33, all seeded: the same pairs in the same bracket order, byes included (counted)", () => {
    let checked = 0;
    for (const n of SIZES) {
      const d = bracketProgression.draw(ids(n), new Map(ids(n).map((e, i) => [e, i + 1])), 1);
      const g = generateSingleElim({ entrants: [...d.order], seeds: new Map(d.order.map((e, i) => [e, i + 1])) });
      // a bye line names its lone entrant on both sides (no null in the key); home and away orientation is not a rulebook fact
      const engine = g.fixtures.filter((f) => f.round === 0).map((f) => [f.home, f.away].filter((x) => x !== undefined).sort().join("|"));
      const oracle = Array.from({ length: d.size / 2 }, (_, i) => [d.slots[2 * i] ?? null, d.slots[2 * i + 1] ?? null].filter((x) => x !== null).sort().join("|"));
      expect(engine, `n=${n}`).toEqual(oracle);
      checked++;
    }
    expect(checked).toBe(32);
  });

  it("a partly seeded, partly drawn field: the engine places the oracle's order on the same pairs (counted)", () => {
    let checked = 0;
    for (const n of [6, 9, 12, 17, 25, 31]) {
      for (const drawSeed of [1, 2, 3]) {
        const seeded = new Map(ids(n).slice(0, Math.floor(n / 3)).map((e, i) => [e, i + 1]));
        const d = bracketProgression.draw(ids(n), seeded, drawSeed);
        const g = generateSingleElim({ entrants: [...d.order], seeds: new Map(d.order.map((e, i) => [e, i + 1])) });
        const engine = g.fixtures.filter((f) => f.round === 0).map((f) => [f.home, f.away].filter((x) => x !== undefined).sort().join("|"));
        const oracle = Array.from({ length: d.size / 2 }, (_, i) => [d.slots[2 * i] ?? null, d.slots[2 * i + 1] ?? null].filter((x) => x !== null).sort().join("|"));
        expect(engine, `n=${n} seed=${drawSeed}`).toEqual(oracle);
        checked++;
      }
    }
    expect(checked).toBe(18);
  });
});

describe("lateEntryCase — RB4-L3, L4: the reversed bye is the slot a fresh fold gives the (n+1)th entrant", () => {
  it("for every n 3..32 that has a bye, the oracle's holder meets the new entrant in the engine's n+1 draw (counted)", () => {
    let checked = 0;
    for (let n = 3; n <= 32; n++) {
      const d = bracketProgression.draw(ids(n), new Map(ids(n).map((e, i) => [e, i + 1])), 1);
      if (d.byeHolders.length === 0) continue; // a full bracket has no bye to reverse
      const lines: LateLine[] = [];
      for (let i = 0; i < d.size; i += 2) {
        const [a, b] = [d.slots[i] ?? null, d.slots[i + 1] ?? null];
        lines.push(a === null || b === null ? { kind: "bye", position: i / 2, seed: num((a ?? b)!), holderStarted: false } : { kind: "played", position: i / 2 });
      }
      const answer = bracketProgression.lateEntryCase(lines, false);
      expect(answer.case, `n=${n}`).toBe("bye");
      const holder = d.slots[(answer as { position: number }).position * 2] ?? d.slots[(answer as { position: number }).position * 2 + 1];
      const g = generateSingleElim({ entrants: ids(n + 1), seeds: new Map(ids(n + 1).map((e, i) => [e, i + 1])) });
      const newcomer = g.fixtures.find((f) => f.round === 0 && (f.home === `e${n + 1}` || f.away === `e${n + 1}`))!;
      expect([newcomer.home, newcomer.away].filter((x) => x !== undefined && x !== `e${n + 1}`), `n=${n}`).toEqual([holder]);
      checked++;
    }
    expect(checked).toBe(30 - 4); // n = 3..32 less the full brackets 4, 8, 16, 32
  });
});

describe("plateField vs firstLossField — RB4-P1, P2, P3", () => {
  const rowsOf = (sim: Sim): BracketFixtureRow[] =>
    sim.gen.map((g) => {
      const r = sim.rows.get(g.id)!;
      return { round: r.round, id: r.id, status: r.status, ...(r.home ? { home: r.home } : {}), ...(r.away ? { away: r.away } : {}), ...(r.winner ? { winner: r.winner } : {}), ...(r.loser ? { loser: r.loser } : {}), ...(r.walkedOver ? { walkedOver: r.walkedOver } : {}), ...(r.thirdPlace ? { thirdPlace: true } : {}), ...(r.homeFrom ? { homeFrom: r.homeFrom } : {}), ...(r.awayFrom ? { awayFrom: r.awayFrom } : {}) };
    });
  /** Each entrant's first match, in the rulebook's terms: the first non-bye fixture they are seated in. */
  const firstMatches = (sim: Sim, n: number): FirstMatch[] => {
    const out: FirstMatch[] = [];
    const perRound = new Map<number, number>();
    const position = new Map<string, number>();
    for (const g of sim.gen) {
      const i = perRound.get(g.round) ?? 0;
      perRound.set(g.round, i + 1);
      position.set(g.id, i);
    }
    for (const e of ids(n)) {
      // the first fixture the entrant PLAYS or forfeits: a bye and a win by walkover are not a first match (A4)
      let advancedBy: Sim["gen"][number] | undefined;
      let found = false;
      for (const g of sim.gen) {
        const r = sim.rows.get(g.id)!;
        if (g.thirdPlace || (r.home !== e && r.away !== e)) continue;
        if (g.award !== undefined || (r.status === "walkover" && r.winner === e)) {
          advancedBy = g;
          continue;
        }
        const result: FirstMatch["result"] = r.status === "scheduled" ? "pending" : r.loser === e ? (r.walkedOver === "loser" ? "lost_by_forfeit" : "lost") : "won";
        out.push({ entrant: e, round: r.round, position: position.get(g.id)!, result });
        found = true;
        break;
      }
      // advanced by walkover but not yet seated in round 2: the first match is still to come
      if (!found && advancedBy !== undefined && advancedBy.award === undefined) out.push({ entrant: e, round: advancedBy.round + 1, position: 0, result: "pending" });
    }
    return out;
  };

  it("complete, round-1 only (bye holders' first matches pending) and a round-1 forfeit, for every n 4..33 — the plate is not offered below 4 (RB4-E4) (counted)", () => {
    let checked = 0;
    for (const n of SIZES.filter((s) => s >= 4)) {
      for (const variant of ["complete", "round1-only", "forfeit"] as const) {
        const sim = simulate(n, false, "champion", variant === "round1-only" ? 0 : Number.POSITIVE_INFINITY, variant === "forfeit");
        const engine = firstLossField(rowsOf(sim));
        const oracle = bracketProgression.plateField(firstMatches(sim, n));
        const tag = `n=${n} ${variant}`;
        expect(oracle.losers, tag).toEqual(engine.losers.map((l) => l.entrantId));
        expect(oracle.excluded, tag).toEqual(engine.excluded.map((l) => l.entrantId));
        expect(oracle.complete, tag).toBe(engine.complete);
        expect(oracle.pending.length > 0, `${tag} pending`).toBe(engine.pending.length > 0);
        checked++;
      }
    }
    expect(checked).toBe(90);
  });
});

describe("ranks vs completeBracketStage — RB4-T2, T3, T6, C1, C3, C4, R1, R2", () => {
  const inputOf = (sim: Sim, n: number, thirdPlace: "shared" | "playoff", title: "champion" | "joint" | "vacant"): RankInput => {
    const fixtures = sim.gen.map((g) => ({ g, r: sim.rows.get(g.id)! }));
    const final = fixtures.find((x) => x.g.isFinal)!.r;
    const finalists = [final.home!, final.away!] as const;
    const semis = fixtures.filter((x) => !x.g.thirdPlace && !x.g.isFinal && x.g.round === sim.rounds - 2 && x.r.loser !== undefined);
    const semiLosers = semis.map((x) => x.r.loser!);
    const others = fixtures
      .filter((x) => !x.g.thirdPlace && !x.g.isFinal && x.g.round < sim.rounds - 2 && x.r.loser !== undefined)
      .map((x) => ({ entrant: x.r.loser!, eliminatedRound: x.r.round, seed: num(x.r.loser!) }));
    const tp = fixtures.find((x) => x.g.thirdPlace)?.r;
    const t: RankInput["title"] =
      title === "champion" ? { kind: "champion", champion: final.winner!, runnerUp: final.loser! } : title === "joint" ? { kind: "joint", winners: finalists } : { kind: "vacant", finalists };
    return { thirdPlace, title: t, semiLosers, others, ...(tp ? { playoff: { kind: "decided" as const, winner: tp.winner!, loser: tp.loser! } } : {}) };
  };

  it("every n 2..33 × Shared / Play-off × champion / joint / vacant: the oracle's places are the engine's, and the title agrees (counted)", () => {
    let checked = 0;
    let refusedBelowFour = 0;
    for (const n of SIZES) {
      for (const thirdPlace of ["shared", "playoff"] as const) {
        if (thirdPlace === "playoff" && n < 4) {
          // RB4-T4 / E5: refused by the oracle AND by the engine's generator, never a bracket
          expect(() => bracketProgression.ranks({ thirdPlace, title: { kind: "champion", champion: "a", runnerUp: "b" }, semiLosers: n === 3 ? ["c"] : [], others: [] }), `n=${n} oracle`).toThrow(ProgressionRuledOut);
          if (n === 3) expect(() => generateSingleElim({ entrants: ids(n), thirdPlace: true }), `n=${n} engine`).toThrow();
          refusedBelowFour++;
          continue;
        }
        for (const title of ["champion", "joint", "vacant"] as const) {
          const sim = simulate(n, thirdPlace === "playoff", title);
          const order = ids(n);
          const stage = { id: "s", kind: "knockout" as const, entrants: order, seeds: new Map(order.map((e, i) => [e, i + 1])) };
          const done = completeBracketStage(stage, [...sim.rows.values()]);
          const engine = Object.fromEntries(done.finalRanks.map((p) => [p.entrantId, p.rank]));
          const oracle = Object.fromEntries(bracketProgression.ranks(inputOf(sim, n, thirdPlace, title)).map((p) => [p.entrant, p.rank]));
          const tag = `n=${n} ${thirdPlace} ${title}`;
          expect(oracle, tag).toEqual(engine);
          expect(Object.keys(oracle).length, `${tag} covers everyone`).toBe(n); // RB4-R1
          expect(done.title.kind, tag).toBe(title === "champion" ? "champion" : title);
          checked++;
        }
      }
    }
    expect(checked).toBe(32 * 3 + 30 * 3);
    expect(refusedBelowFour).toBe(2);
  });
  it("RB4-T6: a play-off with BOTH sides out — 3rd is vacant, both rank 4th, everyone below ranks as the oracle says — for every n 4..33 (counted)", () => {
    let checked = 0;
    for (const n of SIZES.filter((s) => s >= 4)) {
      const sim = simulate(n, true, "champion");
      const tp = sim.gen.find((g) => g.thirdPlace)!;
      const row = sim.rows.get(tp.id)!;
      sim.rows.set(tp.id, { id: row.id, round: row.round, thirdPlace: true, status: "walkover", walkedOver: "both", ...(row.home ? { home: row.home } : {}), ...(row.away ? { away: row.away } : {}), ...(row.homeFrom ? { homeFrom: row.homeFrom } : {}), ...(row.awayFrom ? { awayFrom: row.awayFrom } : {}) });
      const order = ids(n);
      const done = completeBracketStage({ id: "s", kind: "knockout", entrants: order, seeds: new Map(order.map((e, i) => [e, i + 1])) }, [...sim.rows.values()]);
      const input = inputOf(sim, n, "playoff", "champion");
      const oracle = Object.fromEntries(bracketProgression.ranks({ ...input, playoff: { kind: "both_out" } }).map((p) => [p.entrant, p.rank]));
      expect(oracle, `n=${n}`).toEqual(Object.fromEntries(done.finalRanks.map((p) => [p.entrantId, p.rank])));
      checked++;
    }
    expect(checked).toBe(30);
  });
});
