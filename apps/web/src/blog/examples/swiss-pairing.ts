// Post #13, "How does a Swiss tournament decide who plays whom?". Six chess players, seeded 1 to 6, play a three-round
// Swiss paired the way the app pairs one (swiss-run.ts: the app's history, score, constraints and colour lot, the
// engine's pairRound, real games read back through the app's read fold). The fixture says only who is seeded where (in
// sign-up order, with seeds that are neither that order nor the alphabet's: swiss-claims.ts seedsIndistinguishable) and
// which side wins each board; who meets whom, the colours and every score come out of the run.
//
// Chess only: colours are paired in chess alone. The pairing rules themselves are the same in every sport, and the
// example-wide claim sweeps the registry for the format being offered to each.
import { forEachSport } from "@seazn/engine/testkit";
import { capitalised, captionClaim, col, floatRuleProblem, guarded, numberWord, offeredInEverySportClaim, parseSeededLabel, scoreOf, seededLabel, seedReader, type PairedRound, type Seeded } from "./swiss-claims";
import { roundDiagram, runSwiss, type BoardResult } from "./swiss-run";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const SWISS_PAIRING_ID = "swiss-pairing";

/** The fixture: the players in sign-up order, each with the seed the organiser gave. */
export const SWISS_PAIRING_FIXTURE: readonly Seeded[] = [
  { name: "Eve", seed: 4 },
  { name: "Cy", seed: 1 },
  { name: "Ana", seed: 6 },
  { name: "Fay", seed: 2 },
  { name: "Ben", seed: 3 },
  { name: "Dev", seed: 5 },
];
const seedOf = seedReader(SWISS_PAIRING_FIXTURE);
const ROUNDS = 3;
/** The round the diagram draws and the post's second paragraph reads: the round where scores first split the field. */
const DIAGRAM_ROUND = 2;
/** Which side wins each board, round by round: the fixture's own input. */
const PLAN: Record<number, BoardResult[]> = {
  1: ["home", "draw", "home"],
  2: ["away", "draw", "away"],
  3: ["home", "draw", "home"],
};

const COLUMNS = ["Round", "Board", "White", "Black", "Points before (White, Black)", "Result"];

const names = (ids: string[], name: (id: string) => string) => ids.map(name).sort().join(" and ");

/** `fixture` is a parameter so a test can build the same example on other seeds and see the table move. */
export function buildSwissPairing(fixture: readonly Seeded[] = SWISS_PAIRING_FIXTURE): ExampleResult {
  const seed = seedReader(fixture);
  const run = runSwiss({
    stageId: "blog-example:swiss-pairing",
    sportKey: "boardgame",
    rounds: ROUNDS,
    entrants: fixture.map((p) => ({ id: p.name.toLowerCase(), name: p.name, seed: p.seed })),
    result: (r, b) => {
      const want = PLAN[r]?.[b - 1];
      if (want === undefined) throw new Error(`swiss-pairing: no planned result for round ${r} board ${b}`);
      return want;
    },
  });
  const label = (id: string) => seededLabel(run.name(id), seed(run.name(id)));
  const rows: (string | number)[][] = [];
  const text: string[] = [];
  for (const round of run.rounds) {
    for (const b of round.boards) {
      rows.push([round.round, b.board, label(b.home), label(b.away), `${run.points(b.before[0])}, ${run.points(b.before[1])}`, b.headline]);
      text.push(`Round ${round.round}, board ${b.board}: ${run.name(b.home)} has White against ${run.name(b.away)}, ${b.headline}.`);
    }
  }
  // Round 2, read off the run: the top board, and the players on the same score who had already met (each floats).
  const r2 = run.rounds[DIAGRAM_ROUND - 1]!;
  const top = r2.boards[0]!;
  const r1 = run.rounds[0]!;
  const metAndLevel = r1.boards.filter((b) => {
    const [h, a] = [r1.after.get(b.home), r1.after.get(b.away)];
    return h === a && r2.boards.every((x) => !((x.home === b.home && x.away === b.away) || (x.home === b.away && x.away === b.home)));
  });
  const drawn = metAndLevel.find((b) => b.result === "draw");
  if (drawn === undefined) throw new Error("swiss-pairing: the fixture no longer has a drawn pair level after round 1");
  const sports = forEachSport(() => undefined);
  const facts: ExampleResult["facts"] = {
    playerCount: run.rounds[0]!.field.length,
    roundCount: run.rounds.length,
    boardCount: r1.boards.length,
    sportCount: sports,
    r2TopPair: names([top.home, top.away], run.name),
    r2TopScore: run.points(top.before[0]),
    r1DrawPair: names([drawn.home, drawn.away], run.name),
    r1DrawScore: run.points(r1.after.get(drawn.home)!),
  };
  return {
    facts,
    table: {
      caption: `${capitalised(numberWord(Number(facts.playerCount)))} chess players, ${numberWord(Number(facts.roundCount))} Swiss rounds: who met whom, with which colour, and the points each had going in. The number in brackets is the seed.`,
      columns: COLUMNS,
      rows,
    },
    diagram: roundDiagram(
      run,
      DIAGRAM_ROUND,
      `Round ${DIAGRAM_ROUND}: ${String(facts.r2TopPair)} are level at the top and meet on board 1. ${String(facts.r1DrawPair)} drew each other in round 1, so each plays a player from the score below, and those boards are marked as floats.`,
      label,
    ),
    text,
  };
}

// ---- claims: each reads the committed table and checks it against the FIDE rule it names ----

interface Board {
  round: number;
  board: number;
  white: string;
  black: string;
  /** The seeds as the table prints them beside the names. */
  printed: [number, number];
  before: [number, number];
  result: string;
}
function boardsOf(r: ExampleResult): Board[] {
  const [ro, bo, wh, bl, be, re] = COLUMNS.map((c) => col(r, c));
  return (r.table?.rows ?? []).map((row) => {
    const [w, b] = String(row[be!]).split(",").map((x) => scoreOf(x));
    const [pw, pb] = [parseSeededLabel(row[wh!]!), parseSeededLabel(row[bl!]!)];
    return { round: Number(row[ro!]), board: Number(row[bo!]), white: pw.name, black: pb.name, printed: [pw.seed, pb.seed], before: [w!, b!], result: String(row[re!]) };
  });
}
const pairKey = (a: string, b: string) => [a, b].sort().join("|");

/** FIDE Laws of Chess art. 10.1: a win scores 1, a draw ½, a loss 0, read off a result cell for each side. */
function fideScore(result: string): [number, number] | null {
  const parts = result.split(/\s*[—-]\s*/).map((x) => scoreOf(x));
  if (parts.length !== 2 || parts.some((p) => Number.isNaN(p))) return null;
  const [w, b] = parts as [number, number];
  const ok = (w === 1 && b === 0) || (w === 0 && b === 1) || (w === 0.5 && b === 0.5);
  return ok ? [w, b] : null;
}

/** The scores going into each round, round by round, as the table prints them (a player's row in their own board). */
function roundsOf(r: ExampleResult): PairedRound[] {
  const boards = boardsOf(r);
  return [...new Set(boards.map((b) => b.round))]
    .sort((a, b) => a - b)
    .map((round) => {
      const these = boards.filter((b) => b.round === round);
      const score = new Map<string, number>();
      for (const b of these) {
        score.set(b.white, b.before[0]);
        score.set(b.black, b.before[1]);
      }
      return { round, score, pairs: these.map((b) => [b.white, b.black] as [string, string]), bye: null };
    });
}

/** Each player's points after round `n`, from the results printed in the table. */
function scoresAfter(boards: Board[], n: number): Map<string, number> {
  const total = new Map<string, number>();
  for (const b of boards.filter((x) => x.round <= n)) {
    const s = fideScore(b.result);
    if (s === null) throw new Error(`round ${b.round} board ${b.board}: '${b.result}' is not a chess result`);
    total.set(b.white, (total.get(b.white) ?? 0) + s[0]);
    total.set(b.black, (total.get(b.black) ?? 0) + s[1]);
  }
  return total;
}

const claims: Claim[] = [
  {
    says: "the seed printed beside each name is that player's seed in the fixture",
    source: "the example's fixture (the seeds the organiser gave), read back from the table",
    check: guarded((r) => {
      let n = 0;
      for (const b of boardsOf(r)) {
        if (b.printed[0] !== seedOf(b.white) || b.printed[1] !== seedOf(b.black)) return `round ${b.round} board ${b.board}: printed seeds ${b.printed.join(" and ")}, the fixture has ${seedOf(b.white)} and ${seedOf(b.black)}`;
        n++;
      }
      return n > 0 || "no boards";
    }),
  },
  {
    says: "round 1 pairs the top half against the bottom half: seed k plays seed k + half the field, board k",
    source: "FIDE Handbook C.04.3 (Dutch system, in force from 1 Feb 2026): in a score group the first half (S1) is paired against the second half (S2) in order",
    check: guarded((r) => {
      const round1 = boardsOf(r).filter((b) => b.round === 1);
      const half = SWISS_PAIRING_FIXTURE.length / 2;
      if (round1.length !== half) return `round 1 has ${round1.length} boards, a field of ${SWISS_PAIRING_FIXTURE.length} needs ${half}`;
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
      if (seq.size !== SWISS_PAIRING_FIXTURE.length) return `colours for ${seq.size} players`;
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
      let draws = 0;
      for (const round of [...new Set(boards.map((b) => b.round))].sort((a, b) => a - b)) {
        const total = scoresAfter(boards, round - 1);
        for (const b of boards.filter((x) => x.round === round)) {
          const want: [number, number] = [total.get(b.white) ?? 0, total.get(b.black) ?? 0];
          if (b.before[0] !== want[0] || b.before[1] !== want[1]) return `round ${round} board ${b.board}: before is ${b.before.join(", ")}, the results give ${want.join(", ")}`;
          if (fideScore(b.result) === null) return `round ${round} board ${b.board}: '${b.result}' is not a chess result`;
          if (fideScore(b.result)?.[0] === 0.5) draws++;
        }
      }
      // A draw is worth half a win: a table that booked it as 0 or 1 would fail the sums above, and there must be one.
      return draws > 0 || "the example plays no draw, so it cannot show the half point";
    }),
  },
  {
    says: "each round from round 2 floats as few players out of each score group as any rematch-free pairing can, taking the groups from the top",
    source: "the engine's own statement of the rule (scheduling/swiss.js header: each score group is paired in turn from the top and moves the fewest players to the next) under FIDE Handbook C.04.3 [C1] no rematch; brute force over every rematch-free pairing, never the engine",
    check: guarded((r) => {
      const { problem, checked } = floatRuleProblem(roundsOf(r));
      return problem ?? (checked > 0 || "no round after the first");
    }),
  },
  {
    says: "the post's round-2 sentence is true: the players it names are the only ones level at the top score, and they meet on board 1",
    source: "the committed round-2 boards and the points going in (FIDE Laws of Chess art. 10.1)",
    check: guarded((r) => {
      const round2 = boardsOf(r).filter((b) => b.round === DIAGRAM_ROUND);
      const first = round2.find((b) => b.board === 1);
      if (first === undefined) return "no board 1 in round 2";
      const scores = round2.flatMap((b) => b.before);
      const top = Math.max(...scores);
      if (first.before[0] !== top || first.before[1] !== top) return `board 1 seats ${first.before.join(" and ")}, the top score is ${top}`;
      if (scores.filter((s) => s === top).length !== 2) return `${scores.filter((s) => s === top).length} players are on the top score ${top}, the post says two`;
      if ([first.white, first.black].sort().join(" and ") !== String(r.facts.r2TopPair)) return `the post names '${String(r.facts.r2TopPair)}', board 1 seats ${first.white} and ${first.black}`;
      return scoreOf(r.facts.r2TopScore!) === top || `the post says ${String(r.facts.r2TopScore)} each, the top score is ${top}`;
    }),
  },
  {
    says: "the post's drawn pair are the only players on that score after round 1, drew each other, and each plays a player from the score below in round 2",
    source: "the committed round-1 results (FIDE Laws of Chess art. 10.1) and round-2 boards; FIDE Handbook C.04.1 (2026) rule 2 (no rematch) forces the float",
    check: guarded((r) => {
      const boards = boardsOf(r);
      const after1 = scoresAfter(boards, 1);
      const want = scoreOf(r.facts.r1DrawScore!);
      const onScore = [...after1].filter(([, s]) => s === want).map(([p]) => p).sort();
      if (onScore.join(" and ") !== String(r.facts.r1DrawPair)) return `the players on ${want} after round 1 are ${onScore.join(" and ")}, the post names '${String(r.facts.r1DrawPair)}'`;
      if (onScore.length !== 2) return `${onScore.length} players are on ${want}`;
      const drew = boards.some((b) => b.round === 1 && pairKey(b.white, b.black) === onScore.join("|") && fideScore(b.result)?.[0] === 0.5);
      if (!drew) return `${onScore.join(" and ")} did not draw each other in round 1`;
      const round2 = boards.filter((b) => b.round === 2);
      const below = Math.max(...[...after1.values()].filter((s) => s < want));
      for (const p of onScore) {
        const b = round2.find((x) => x.white === p || x.black === p);
        if (b === undefined) return `${p} has no board in round 2`;
        const opponentScore = b.white === p ? b.before[1] : b.before[0];
        if (opponentScore !== below) return `${p} plays a player on ${opponentScore} in round 2, the score below is ${below}`;
      }
      return true;
    }),
  },
  {
    says: "rounds and boards are numbered in order, every round has the same number of boards, and the table seats every player once a round",
    source: "FIDE Handbook C.04.1 (2026) rule 3 (every player is paired once per round, an even field has no bye)",
    check: guarded((r) => {
      const boards = boardsOf(r);
      const rounds = [...new Set(boards.map((b) => b.round))];
      if (rounds.length !== ROUNDS || rounds.some((n, i) => n !== i + 1)) return `rounds are ${rounds.join(", ")}`;
      let n = 0;
      for (const round of rounds) {
        const these = boards.filter((b) => b.round === round);
        if (these.some((b, i) => b.board !== i + 1)) return `round ${round}: boards are ${these.map((b) => b.board).join(", ")}`;
        if (these.length * 2 !== SWISS_PAIRING_FIXTURE.length) return `round ${round}: ${these.length} boards for ${SWISS_PAIRING_FIXTURE.length} players`;
        if (new Set(these.flatMap((b) => [b.white, b.black])).size !== SWISS_PAIRING_FIXTURE.length) return `round ${round}: a player is seated twice`;
        n++;
      }
      if (Number(r.facts.playerCount) !== SWISS_PAIRING_FIXTURE.length || Number(r.facts.roundCount) !== rounds.length || Number(r.facts.boardCount) !== SWISS_PAIRING_FIXTURE.length / 2) {
        return `the post says ${String(r.facts.playerCount)} players, ${String(r.facts.roundCount)} rounds and ${String(r.facts.boardCount)} boards a round, the table has ${SWISS_PAIRING_FIXTURE.length}, ${rounds.length} and ${SWISS_PAIRING_FIXTURE.length / 2}`;
      }
      return n > 0 || "no rounds";
    }),
  },
  captionClaim("the caption's counts are the post's: the players and the rounds", (f) => [`${capitalised(numberWord(Number(f.playerCount)))} chess players`, `${numberWord(Number(f.roundCount))} Swiss rounds`]),
  {
    says: "the diagram draws the table's own round: the same boards, colours, points going in, results and floats",
    source: "the committed table (the diagram is drawn from the same run)",
    check: guarded((r) => {
      const d = r.diagram;
      if (d === undefined || d.kind !== "swissRound") return "no Swiss round diagram";
      const mine = boardsOf(r).filter((b) => b.round === d.round);
      if (mine.length === 0) return `the table has no round ${d.round}`;
      if (d.pairings.length !== mine.length) return `${d.pairings.length} boards drawn, the table has ${mine.length}`;
      if (d.byes.length !== 0) return "the diagram draws a bye in an even field";
      for (const [i, b] of mine.entries()) {
        const p = d.pairings[i]!;
        const [wantFirst, wantSecond] = [seededLabel(b.white, seedOf(b.white)), seededLabel(b.black, seedOf(b.black))];
        if (p.board !== b.board || p.first !== wantFirst || p.second !== wantSecond) return `board ${b.board}: drawn ${p.first} v ${String(p.second)}, the table has ${wantFirst} v ${wantSecond}`;
        if (p.result !== b.result) return `board ${b.board}: drawn result '${String(p.result)}', the table has '${b.result}'`;
        if (p.firstWhite !== true) return `board ${b.board}: the first player is White in the table`;
        if (p.float !== (b.before[0] !== b.before[1])) return `board ${b.board}: float drawn ${String(p.float)}, the points going in are ${b.before.join(" and ")}`;
        if (scoreOf(p.firstScore!) !== b.before[0] || scoreOf(p.secondScore!) !== b.before[1]) return `board ${b.board}: points drawn ${String(p.firstScore)} and ${String(p.secondScore)}, the table has ${b.before.join(" and ")}`;
      }
      return String(d.title).includes(String(r.facts.r2TopPair)) && String(d.title).includes(String(r.facts.r1DrawPair)) || "the diagram's caption does not name the pairs the post names";
    }),
  },
  offeredInEverySportClaim("swiss", "Swiss", "sportCount"),
];

export const swissPairing: BlogExample = {
  id: SWISS_PAIRING_ID,
  kind: "engine",
  sports: ["boardgame"],
  singleSportReason: "chess only: colours are paired in chess alone; the pairing rules are the same in every sport, and the example-wide claim sweeps the registry for the format",
  build: () => buildSwissPairing(),
  claims,
};
