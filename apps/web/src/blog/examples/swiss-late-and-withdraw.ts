// Post #15, "Can a player join or leave a Swiss tournament after round one?". Six chess players start a four-round Swiss;
// Fay leaves once round 2 is paired, and Gil is added late and joins from round 3. Everything is the app's own path
// (swiss-run.ts): the round's field (`swissFieldForRound`) leaves Gil out until his first round, the engine's Swiss
// withdrawal rule (`withdrawTableEntrant`) decides what happens to Fay's paired board, and later rounds are paired without
// her. Every score is read back through the app's read fold and paid by the web's one rules loader.
//
// Chess only, with the reason: neither rule reads the sport (the round's field and the withdrawal rule take none), and the
// example-wide claim sweeps the registry for the Swiss format being offered to every sport.
import { forEachSport } from "@seazn/engine/testkit";
import { col, guarded, offeredInEverySportClaim, scoreOf } from "./swiss-claims";
import { runSwiss, type BoardResult } from "./swiss-run";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const SWISS_LATE_AND_WITHDRAW_ID = "swiss-late-and-withdraw";

const PLAYERS = ["Ana", "Ben", "Cy", "Dev", "Eve", "Fay"] as const;
const LATE = { name: "Gil", firstRound: 3 } as const;
const LEAVER = { name: "Fay", round: 2 } as const;
const ROUNDS = 4;
/** Which side wins each board, round by round: the fixture's own input (a walked-over board ignores it). */
const PLAN: Record<number, BoardResult[]> = {
  1: ["home", "draw", "away"],
  2: ["home", "home", "home"],
  3: ["away", "home", "draw"],
  4: ["home", "draw", "home"],
};

const NOT_YET = "Not entered yet";
const LEFT = "Left";
const roundColumn = (r: number) => `Round ${r}`;
const COLUMNS = ["Player", ...Array.from({ length: ROUNDS }, (_, i) => roundColumn(i + 1)), "Total"];

function build(): ExampleResult {
  const everyone: { id: string; name: string; seed: number; firstRound?: number }[] = [...PLAYERS.map((n, i) => ({ id: n.toLowerCase(), name: n, seed: i + 1 })), { id: LATE.name.toLowerCase(), name: LATE.name, seed: PLAYERS.length + 1, firstRound: LATE.firstRound }];
  const run = runSwiss({
    stageId: "blog-example:swiss-late-and-withdraw",
    sportKey: "boardgame",
    rounds: ROUNDS,
    entrants: everyone,
    withdrawnAfterPairing: { entrant: LEAVER.name.toLowerCase(), round: LEAVER.round },
    result: (r, b) => {
      const want = PLAN[r]?.[b - 1];
      if (want === undefined) throw new Error(`swiss-late-and-withdraw: no planned result for round ${r} board ${b}`);
      return want;
    },
  });
  const cells = new Map<string, string[]>(everyone.map((e) => [e.id, []]));
  const text: string[] = [];
  for (const round of run.rounds) {
    const done = new Set<string>();
    for (const b of round.boards) {
      const [h, a] = [run.name(b.home), run.name(b.away)];
      if (b.walkoverTo !== undefined) {
        const winner = b.walkoverTo;
        const leaver = winner === b.home ? b.away : b.home;
        cells.get(winner)!.push(`Won without playing (${run.name(leaver)} left)`);
        cells.get(leaver)!.push(`${LEFT}: ${run.name(winner)} wins without playing`);
        text.push(`Round ${round.round}: ${run.name(leaver)} left after the round was paired, so ${run.name(winner)} wins that board without playing.`);
      } else if (b.result === "draw") {
        cells.get(b.home)!.push(`Drew with ${a}`);
        cells.get(b.away)!.push(`Drew with ${h}`);
      } else {
        const [w, l] = b.result === "home" ? [b.home, b.away] : [b.away, b.home];
        cells.get(w)!.push(`Beat ${run.name(l)}`);
        cells.get(l)!.push(`Lost to ${run.name(w)}`);
      }
      done.add(b.home).add(b.away);
    }
    if (round.bye !== null) {
      cells.get(round.bye.entrant)!.push("Bye");
      done.add(round.bye.entrant);
    }
    for (const e of everyone) {
      if (done.has(e.id)) continue;
      cells.get(e.id)!.push(round.round < (e.firstRound ?? 1) ? NOT_YET : LEFT);
    }
  }
  const final = run.rounds[run.rounds.length - 1]!.after;
  const rows = everyone.map((e) => [e.name, ...cells.get(e.id)!, run.points(final.get(e.id) ?? 0)]);
  const late = LATE.name.toLowerCase();
  const leaver = LEAVER.name.toLowerCase();
  const leftBoard = run.rounds[LEAVER.round - 1]!.boards.find((b) => b.walkoverTo !== undefined);
  if (leftBoard === undefined || run.withdrawal === null) throw new Error("swiss-late-and-withdraw: the leaver's board was not walked over");
  const lateBefore = run.rounds[LATE.firstRound - 2]!.after.get(late) ?? 0;
  return {
    facts: {
      playerCount: PLAYERS.length,
      roundCount: run.rounds.length,
      sportCount: forEachSport(() => undefined),
      lateName: LATE.name,
      lateFirstRound: LATE.firstRound,
      lateMissedRounds: LATE.firstRound - 1,
      lateScoreBeforeFirst: run.points(lateBefore),
      lateTotal: run.points(final.get(late) ?? 0),
      leaverName: LEAVER.name,
      leaverRound: LEAVER.round,
      leaverTotal: run.points(final.get(leaver) ?? 0),
      walkoverWinner: run.name(leftBoard.walkoverTo!),
      fieldAfterLeaving: run.rounds[LEAVER.round]!.field.length,
      // The players who started, are still in, and play the round after the leaver left: the field without the latecomer.
      regularsAfterLeaving: run.rounds[LEAVER.round]!.field.filter((id) => id !== late).length,
    },
    table: { caption: "A four-round chess Swiss: Fay leaves once round 2 is paired, and Gil joins from round 3.", columns: COLUMNS, rows },
    text,
  };
}

// ---- claims: each reads the committed grid and checks it against the rule it names ----

type Grid = Map<string, { rounds: string[]; total: number }>;
function gridOf(r: ExampleResult): Grid {
  const p = col(r, "Player");
  const t = col(r, "Total");
  const rs = Array.from({ length: ROUNDS }, (_, i) => col(r, roundColumn(i + 1)));
  return new Map((r.table?.rows ?? []).map((row) => [String(row[p]), { rounds: rs.map((i) => String(row[i])), total: scoreOf(row[t]!) }]));
}
/** What a cell scores: FIDE Laws of Chess art. 10.1 (win 1, draw ½, loss 0), C.04.1 (2026) rule 3 (a bye, a win's points), and a
 *  game won because the opponent left counts as a win; a round not played (not entered yet, or after leaving) scores 0. */
function cellScore(cell: string): number {
  if (/^Beat /.test(cell) || /^Won without playing/.test(cell) || cell === "Bye") return 1;
  if (/^Drew with /.test(cell)) return 0.5;
  if (/^Lost to /.test(cell) || cell === NOT_YET || cell.startsWith(LEFT)) return 0;
  return Number.NaN;
}
const opponentIn = (cell: string): string | null => /^(?:Beat|Lost to|Drew with) (.+)$/.exec(cell)?.[1] ?? null;

const claims: Claim[] = [
  {
    says: "every total is the sum of the player's rounds: 1 a win or a bye, ½ a draw, 0 a loss or a round not played",
    source: "FIDE Laws of Chess art. 10.1; FIDE Handbook C.04.1 (2026) rule 3 (a bye scores a win); C.04.2 (2026) art. 2.4 (a round a late entrant missed scores 0)",
    check: guarded((r) => {
      const g = gridOf(r);
      if (g.size !== PLAYERS.length + 1) return `${g.size} players listed`;
      for (const [p, row] of g) {
        const sum = row.rounds.reduce((a, c) => a + cellScore(c), 0);
        if (Number.isNaN(sum)) return `${p}: a cell reads as no result (${row.rounds.join(" | ")})`;
        if (sum !== row.total) return `${p}: rounds add to ${sum}, the total is ${row.total}`;
      }
      return true;
    }),
  },
  {
    says: "a late player is in no round before their first: they miss it and score nothing for it, then are paired like everyone else",
    source: "FIDE Handbook C.04.2 (2026) art. 2.4 (a player joining late scores 0 for the rounds missed); the app's round field (a late entrant joins from their first round)",
    check: guarded((r) => {
      const row = gridOf(r).get(LATE.name);
      if (row === undefined) return "no late player";
      for (let i = 0; i < LATE.firstRound - 1; i++) if (row.rounds[i] !== NOT_YET) return `${LATE.name} round ${i + 1}: ${row.rounds[i]}`;
      for (let i = LATE.firstRound - 1; i < ROUNDS; i++) if (row.rounds[i] === NOT_YET || row.rounds[i]!.startsWith(LEFT)) return `${LATE.name} round ${i + 1}: ${row.rounds[i]}`;
      return String(r.facts.lateScoreBeforeFirst) === "0" || `the late player starts on ${String(r.facts.lateScoreBeforeFirst)}`;
    }),
  },
  {
    says: "a player who leaves keeps every result already played, and is in no pairing after leaving",
    source: "the Swiss withdrawal rule (engine withdrawTableEntrant): played results stand, later rounds pair without the player (FIDE Handbook C.04.2 (2026) art. 3.2: a withdrawn player is not paired again)",
    check: guarded((r) => {
      const row = gridOf(r).get(LEAVER.name);
      if (row === undefined) return "no leaver";
      for (let i = 0; i < LEAVER.round - 1; i++) if (Number.isNaN(cellScore(row.rounds[i]!)) || row.rounds[i]!.startsWith(LEFT)) return `${LEAVER.name} round ${i + 1} was struck: ${row.rounds[i]}`;
      const kept = row.rounds.slice(0, LEAVER.round - 1).reduce((a, c) => a + cellScore(c), 0);
      if (kept === 0) return "the leaver scored nothing before leaving, so this case cannot show a kept result";
      for (let i = LEAVER.round - 1; i < ROUNDS; i++) if (!row.rounds[i]!.startsWith(LEFT)) return `${LEAVER.name} round ${i + 1}: ${row.rounds[i]}`;
      return row.total === kept || `${LEAVER.name}'s total ${row.total}, the kept results give ${kept}`;
    }),
  },
  {
    says: "the board the leaver was already paired on is won by the opponent without playing, and scores them a win",
    source: "the Swiss withdrawal rule (engine withdrawTableEntrant): the paired board is walked over to the opponent and scores them a win; FIDE Handbook C.07 (2026) art. 16.2 category 2 reads a forfeit win as a win",
    check: guarded((r) => {
      const g = gridOf(r);
      const i = LEAVER.round - 1;
      const winners = [...g].filter(([, row]) => row.rounds[i] === `Won without playing (${LEAVER.name} left)`);
      if (winners.length !== 1) return `${winners.length} players won without playing in round ${LEAVER.round}`;
      return winners[0]![0] === String(r.facts.walkoverWinner) || `the post names ${String(r.facts.walkoverWinner)}`;
    }),
  },
  {
    says: "nobody meets the same opponent twice, and each round seats every player in its field once",
    source: "FIDE Handbook C.04.1 (2026) rule 2 (no rematch) and rule 3 (a bye is the one unpaired player of an odd field, so one at most per round)",
    check: guarded((r) => {
      const g = gridOf(r);
      const met = new Set<string>();
      for (let i = 0; i < ROUNDS; i++) {
        let byes = 0;
        for (const [p, row] of g) {
          const o = opponentIn(row.rounds[i]!);
          if (row.rounds[i] === "Bye") byes++;
          if (o === null) continue;
          const back = g.get(o)?.rounds[i];
          if (back === undefined || opponentIn(back) !== p) return `round ${i + 1}: ${p} v ${o} is not on both rows`;
          const k = [p, o].sort().join("|");
          if (p < o) {
            if (met.has(k)) return `${p} and ${o} meet twice`;
            met.add(k);
          }
        }
        if (byes > 1) return `round ${i + 1} has ${byes} byes`;
      }
      return met.size > 0 || "no games";
    }),
  },
  offeredInEverySportClaim("swiss", "Swiss", "sportCount"),
];

export const swissLateAndWithdraw: BlogExample = {
  id: SWISS_LATE_AND_WITHDRAW_ID,
  kind: "engine",
  sports: ["boardgame"],
  singleSportReason: "chess only: neither rule reads the sport (the round's field and the withdrawal rule take none); the example-wide claim sweeps the Swiss format across every sport",
  build,
  claims,
};
