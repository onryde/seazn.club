// Post #13, "How does a Swiss tournament decide who plays whom?". Six chess players, seeded 1 to 6, play a three-round
// Swiss paired the way the app pairs one (swiss-run.ts: the app's history, score, constraints and colour lot, the
// engine's pairRound, real games read back through the app's read fold). The fixture says only who is seeded where and
// which side wins each board; who meets whom, the colours and every score come out of the run.
//
// Chess only: colours are paired in chess alone. The pairing rules themselves are the same in every sport, and the
// example-wide claim sweeps the registry for the format being offered to each.
import { forEachSport } from "@seazn/engine/testkit";
import { offeredInEverySportClaim, col, guarded, scoreOf } from "./swiss-claims";
import { runSwiss, type BoardResult } from "./swiss-run";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const SWISS_PAIRING_ID = "swiss-pairing";

const PLAYERS = ["Ana", "Ben", "Cy", "Dev", "Eve", "Fay"] as const;
const ROUNDS = 3;
/** Which side wins each board, round by round: the fixture's own input. */
const PLAN: Record<number, BoardResult[]> = {
  1: ["home", "draw", "home"],
  2: ["away", "draw", "away"],
  3: ["home", "draw", "home"],
};

const COLUMNS = ["Round", "Board", "White", "Black", "Points before (White, Black)", "Result"];

const names = (ids: string[], name: (id: string) => string) => ids.map(name).sort().join(" and ");

function build(): ExampleResult {
  const run = runSwiss({
    stageId: "blog-example:swiss-pairing",
    sportKey: "boardgame",
    rounds: ROUNDS,
    entrants: PLAYERS.map((n, i) => ({ id: n.toLowerCase(), name: n, seed: i + 1 })),
    result: (r, b) => {
      const want = PLAN[r]?.[b - 1];
      if (want === undefined) throw new Error(`swiss-pairing: no planned result for round ${r} board ${b}`);
      return want;
    },
  });
  const rows: (string | number)[][] = [];
  const text: string[] = [];
  for (const round of run.rounds) {
    for (const b of round.boards) {
      rows.push([round.round, b.board, run.name(b.home), run.name(b.away), `${run.points(b.before[0])}, ${run.points(b.before[1])}`, b.headline]);
      text.push(`Round ${round.round}, board ${b.board}: ${run.name(b.home)} has White against ${run.name(b.away)}, ${b.headline}.`);
    }
  }
  // Round 2, read off the run: the top board, and the players on the same score who had already met (each floats).
  const r2 = run.rounds[1]!;
  const top = r2.boards[0]!;
  const r1 = run.rounds[0]!;
  const metAndLevel = r1.boards.filter((b) => {
    const [h, a] = [r1.after.get(b.home), r1.after.get(b.away)];
    return h === a && r2.boards.every((x) => !((x.home === b.home && x.away === b.away) || (x.home === b.away && x.away === b.home)));
  });
  const drawn = metAndLevel.find((b) => b.result === "draw");
  if (drawn === undefined) throw new Error("swiss-pairing: the fixture no longer has a drawn pair level after round 1");
  const sports = forEachSport(() => undefined);
  return {
    facts: {
      playerCount: run.rounds[0]!.field.length,
      roundCount: run.rounds.length,
      boardCount: r1.boards.length,
      sportCount: sports,
      r2TopPair: names([top.home, top.away], run.name),
      r2TopScore: run.points(top.before[0]),
      r1DrawPair: names([drawn.home, drawn.away], run.name),
      r1DrawScore: run.points(r1.after.get(drawn.home)!),
    },
    table: { caption: "Six chess players, three Swiss rounds: who met whom, with which colour, and the points each had going in.", columns: COLUMNS, rows },
    text,
  };
}

// ---- claims: each reads the committed table and checks it against the FIDE rule it names ----

interface Board {
  round: number;
  board: number;
  white: string;
  black: string;
  before: [number, number];
  result: string;
}
function boardsOf(r: ExampleResult): Board[] {
  const [ro, bo, wh, bl, be, re] = COLUMNS.map((c) => col(r, c));
  return (r.table?.rows ?? []).map((row) => {
    const [w, b] = String(row[be!]).split(",").map((x) => scoreOf(x));
    return { round: Number(row[ro!]), board: Number(row[bo!]), white: String(row[wh!]), black: String(row[bl!]), before: [w!, b!], result: String(row[re!]) };
  });
}
const seedOf = (name: string) => PLAYERS.indexOf(name as (typeof PLAYERS)[number]) + 1;
const pairKey = (a: string, b: string) => [a, b].sort().join("|");

/** FIDE Laws of Chess art. 10.1: a win scores 1, a draw ½, a loss 0, read off a result cell for each side. */
function fideScore(result: string): [number, number] | null {
  const parts = result.split(/\s*[—-]\s*/).map((x) => scoreOf(x));
  if (parts.length !== 2 || parts.some((p) => Number.isNaN(p))) return null;
  const [w, b] = parts as [number, number];
  const ok = (w === 1 && b === 0) || (w === 0 && b === 1) || (w === 0.5 && b === 0.5);
  return ok ? [w, b] : null;
}

const claims: Claim[] = [
  {
    says: "round 1 pairs the top half against the bottom half: seed k plays seed k + half the field, board k",
    source: "FIDE Handbook C.04.3 (Dutch system, in force from 1 Feb 2026): in a score group the first half (S1) is paired against the second half (S2) in order",
    check: guarded((r) => {
      const round1 = boardsOf(r).filter((b) => b.round === 1);
      const half = PLAYERS.length / 2;
      if (round1.length !== half) return `round 1 has ${round1.length} boards, a field of ${PLAYERS.length} needs ${half}`;
      for (const b of round1) {
        const seeds = [seedOf(b.white), seedOf(b.black)].sort((x, y) => x - y);
        if (seeds[0] !== b.board || seeds[1] !== b.board + half) return `board ${b.board} pairs seeds ${seeds.join(" and ")}`;
      }
      return true;
    }),
  },
  {
    says: "round 1's colours alternate from board to board: the higher seed has White on every other board",
    source: "FIDE Handbook C.04.3 (2026) art. 5.1: the first colour is drawn by lot, and the boards alternate from it",
    check: guarded((r) => {
      const round1 = boardsOf(r).filter((b) => b.round === 1);
      if (round1.length < 2) return "round 1 has under two boards";
      const upperWhite = round1.map((b) => seedOf(b.white) < seedOf(b.black));
      return upperWhite.every((w, i) => i === 0 || w !== upperWhite[i - 1]) || `higher seed on White by board: ${upperWhite.join(", ")}`;
    }),
  },
  {
    says: "nobody plays the same opponent twice",
    source: "FIDE Handbook C.04.1 (2026) rule 2, and C.04.3 absolute criterion [C1]: two players shall not play against each other more than once",
    check: guarded((r) => {
      const seen = new Set<string>();
      let n = 0;
      for (const b of boardsOf(r)) {
        const k = pairKey(b.white, b.black);
        if (seen.has(k)) return `${b.white} and ${b.black} meet twice`;
        seen.add(k);
        n++;
      }
      return n > 0 || "no boards";
    }),
  },
  {
    says: "every player's colours stay within the limits: never more than two more of one colour, never the same colour three times running",
    source: "FIDE Handbook C.04.1 (2026) rules 6 and 7: the colour difference stays between -2 and +2, and no player has one colour three times in a row (the one exception, a topscorer in the final round, C.04.3 Art. 1.8, is not exercised here)",
    check: guarded((r) => {
      const seq = new Map<string, string[]>();
      for (const b of [...boardsOf(r)].sort((x, y) => x.round - y.round)) {
        seq.set(b.white, [...(seq.get(b.white) ?? []), "W"]);
        seq.set(b.black, [...(seq.get(b.black) ?? []), "B"]);
      }
      if (seq.size !== PLAYERS.length) return `colours for ${seq.size} players`;
      for (const [p, s] of seq) {
        const diff = s.filter((c) => c === "W").length - s.filter((c) => c === "B").length;
        if (Math.abs(diff) > 2) return `${p}: colour difference ${diff}`;
        if (s.join("").includes("WWW") || s.join("").includes("BBB")) return `${p}: ${s.join("")}`;
      }
      return true;
    }),
  },
  {
    says: "the points each player takes into a round are the chess points of their earlier games: 1 a win, ½ a draw, 0 a loss",
    source: "FIDE Laws of Chess art. 10.1 (a win scores 1, a draw ½, a loss 0)",
    check: guarded((r) => {
      const boards = boardsOf(r);
      const total = new Map<string, number>();
      let draws = 0;
      for (const round of [...new Set(boards.map((b) => b.round))].sort((a, b) => a - b)) {
        const these = boards.filter((b) => b.round === round);
        for (const b of these) {
          const want: [number, number] = [total.get(b.white) ?? 0, total.get(b.black) ?? 0];
          if (b.before[0] !== want[0] || b.before[1] !== want[1]) return `round ${round} board ${b.board}: before is ${b.before.join(", ")}, the results give ${want.join(", ")}`;
        }
        for (const b of these) {
          const s = fideScore(b.result);
          if (s === null) return `round ${round} board ${b.board}: '${b.result}' is not a chess result`;
          if (s[0] === 0.5) draws++;
          total.set(b.white, (total.get(b.white) ?? 0) + s[0]);
          total.set(b.black, (total.get(b.black) ?? 0) + s[1]);
        }
      }
      // A draw is worth half a win: a table that booked it as 0 or 1 would fail the sums above, and there must be one.
      return draws > 0 || "the example plays no draw, so it cannot show the half point";
    }),
  },
  {
    says: "each round from round 2 pairs as few players outside their own score as any rematch-free pairing of that round can",
    source: "FIDE Handbook C.04.1 (2026) rule 5 (same score pairs, in general) and C.04.3 quality criteria [C6]-[C8] (fewest downfloaters), under [C1] no rematch",
    check: guarded((r) => {
      const boards = boardsOf(r);
      const met = new Set<string>();
      let checked = 0;
      for (const round of [...new Set(boards.map((b) => b.round))].sort((a, b) => a - b)) {
        const these = boards.filter((b) => b.round === round);
        if (round > 1) {
          const score = new Map<string, number>();
          for (const b of these) {
            score.set(b.white, b.before[0]);
            score.set(b.black, b.before[1]);
          }
          const mixed = these.filter((b) => b.before[0] !== b.before[1]).length;
          const fewest = fewestMixed([...score.keys()].sort(), score, met);
          if (fewest === null) return `round ${round}: no rematch-free pairing exists`;
          if (mixed !== fewest) return `round ${round}: ${mixed} boards pair different scores, the fewest possible is ${fewest}`;
          checked++;
        }
        for (const b of these) met.add(pairKey(b.white, b.black));
      }
      return checked > 0 || "no round after the first";
    }),
  },
  offeredInEverySportClaim("swiss", "Swiss", "sportCount"),
];

/** The fewest boards with two different scores over every rematch-free pairing of `players` (brute force; a small field). */
function fewestMixed(players: string[], score: Map<string, number>, met: Set<string>): number | null {
  if (players.length === 0) return 0;
  const [first, ...rest] = players as [string, ...string[]];
  let best: number | null = null;
  for (const other of rest) {
    if (met.has(pairKey(first, other))) continue;
    const sub = fewestMixed(
      rest.filter((p) => p !== other),
      score,
      met,
    );
    if (sub === null) continue;
    const here = sub + (score.get(first) === score.get(other) ? 0 : 1);
    if (best === null || here < best) best = here;
  }
  return best;
}

export const swissPairing: BlogExample = {
  id: SWISS_PAIRING_ID,
  kind: "engine",
  sports: ["boardgame"],
  singleSportReason: "chess only: colours are paired in chess alone; the pairing rules are the same in every sport, and the example-wide claim sweeps the registry for the format",
  build,
  claims,
};
