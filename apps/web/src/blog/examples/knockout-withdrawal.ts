// Post #25, "What happens when a player withdraws in the middle of a knockout?". An eight-player seeded bracket drawn by
// the engine (`generateSingleElim`, the app's own generator call), its first round played with every seed winning. Then
// the fourth seed withdraws before the semi-final, and the engine's withdrawal planner (`withdrawBracketEntrant`, which
// the app's withdrawal cascade calls for knockout, double elimination and stepladder) says what happens to the bracket.
// For every sport in the registry, the walkover it plans is then recorded the way the cascade records it
// (`core.forfeit{by: <withdrawn>, reason: "withdrew"}`) and folded by the app's read fold (`foldFrom`), so the sweep shows
// who goes through and what the match shows, sport by sport.
//
// WHAT CHECKS IT. The claims hold the planner to the rule (a played result stands; only the withdrawn player's unfinished
// matches change, each to a walkover for the other side) by recomputing it from the fixture input, and hold every sport's
// fold to "the opponent wins, and goes on", against the engine's `advancesNobody` rule for the case that would differ.
import { advancesNobody, type MatchOutcome } from "@seazn/engine/core";
import { withdrawBracketEntrant, type BracketFixture } from "@seazn/engine/competition";
import { generateSingleElim } from "@seazn/engine/scheduling";
import { builtinModules } from "@seazn/engine/sports";
import { forEachSport } from "@seazn/engine/testkit";
import { forfeitFold } from "./forfeit-scores";
import type { Claim, EngineExample, ExampleResult } from "./types";

export const KNOCKOUT_WITHDRAWAL_ID = "knockout-withdrawal";

/** Seeded 1 to 8, in this order. */
export const KNOCKOUT_PLAYERS = ["Ana", "Ben", "Cy", "Dev", "Eli", "Fay", "Gus", "Hal"] as const;
const PLAYERS = KNOCKOUT_PLAYERS;
const WITHDRAWN = "Dev";
const ROUND_NAMES = ["Quarter-final", "Semi-final", "Final"] as const;

export interface Line {
  id: string;
  round: number;
  home?: string;
  away?: string;
  status: BracketFixture["status"];
  winner?: string;
  loser?: string;
  /** The fixtures whose winners are seated here (the engine's own feeder wiring). */
  homeFrom?: string;
  awayFrom?: string;
}

/** The eight-player seeded draw the engine makes (`generateSingleElim`), with every seed winning round one and the winners
 *  seated in the next round. Also read by the double walkover's picture (double-walkover.ts). */
export function bracketAfterRoundOne(): Line[] {
  const seeds = new Map(PLAYERS.map((p, i) => [p as string, i + 1]));
  const { fixtures } = generateSingleElim({ entrants: [...PLAYERS], seeds });
  const lines = new Map<string, Line>(
    fixtures.map((f) => [f.id, { id: f.id, round: f.round, home: f.home, away: f.away, status: "scheduled", homeFrom: f.homeFrom?.fixtureId, awayFrom: f.awayFrom?.fixtureId }]),
  );
  for (const f of fixtures.filter((x) => x.round === 0)) {
    const line = lines.get(f.id)!;
    const [w, l] = seeds.get(line.home!)! < seeds.get(line.away!)! ? [line.home!, line.away!] : [line.away!, line.home!];
    Object.assign(line, { status: "decided", winner: w, loser: l });
  }
  for (const f of fixtures.filter((x) => x.round === 1)) {
    const line = lines.get(f.id)!;
    if (f.homeFrom) line.home = lines.get(f.homeFrom.fixtureId)!.winner;
    if (f.awayFrom) line.away = lines.get(f.awayFrom.fixtureId)!.winner;
  }
  return [...lines.values()].sort((a, b) => a.round - b.round || a.id.localeCompare(b.id));
}

const NOT_KNOWN = "not known yet";
const vs = (l: { home?: string; away?: string }) => (l.home === undefined && l.away === undefined ? "Not drawn yet" : `${l.home ?? NOT_KNOWN} against ${l.away ?? NOT_KNOWN}`);

function build(): ExampleResult {
  const lines = bracketAfterRoundOne();
  const plan = withdrawBracketEntrant(
    { id: "ko", kind: "knockout", entrants: [...PLAYERS] },
    WITHDRAWN,
    lines.map((l) => ({ id: l.id, round: l.round, status: l.status, home: l.home, away: l.away, winner: l.winner, loser: l.loser })),
  );
  const updates = new Map(plan.updates.map((u) => [u.fixtureId, u]));
  // The seats AFTER the withdrawal: a seat fed by a match the plan walked over is filled by the player who walks over it
  // (the engine's own feeder wiring + the plan's `walkoverTo`; a seat still waiting stays empty).
  const seatsAfter = new Map(
    lines.map((l) => [l.id, { home: l.home ?? updates.get(l.homeFrom ?? "")?.walkoverTo, away: l.away ?? updates.get(l.awayFrom ?? "")?.walkoverTo }]),
  );
  const counter = new Map<number, number>();
  const inRound = (round: number) => lines.filter((x) => x.round === round).length;
  const nameOf = new Map<string, string>();
  const rows = lines.map((l) => {
    const n = (counter.get(l.round) ?? 0) + 1;
    counter.set(l.round, n);
    const name = inRound(l.round) === 1 ? ROUND_NAMES[l.round]! : `${ROUND_NAMES[l.round]} ${n}`;
    nameOf.set(l.id, name);
    const before = l.status === "decided" ? `${vs(l)}: ${l.winner} won` : vs(l);
    const u = updates.get(l.id);
    const seated = seatsAfter.get(l.id)!;
    const after =
      u !== undefined
        ? `Walkover: ${u.walkoverTo} goes through`
        : l.status === "decided"
          ? "Unchanged: the result stands"
          : seated.home !== l.home || seated.away !== l.away
            ? vs(seated)
            : "Unchanged";
    return [name, before, after];
  });
  const walkover = plan.updates[0];

  const facts: Record<string, string | number> = {
    withdrawn: WITHDRAWN,
    opponent: walkover?.walkoverTo ?? "",
    walkovers: plan.updates.length,
    playedResults: lines.filter((l) => l.status === "decided").length,
  };
  let advancing = 0;
  const visited = forEachSport(({ module }) => {
    // The cascade's write for this line: the withdrawn player forfeits it, with the reason "withdrew".
    const { outcome } = forfeitFold(module, "ben", "withdrew");
    if (outcome.kind === "award" && outcome.winner === "ana" && !advancesNobody(outcome)) advancing++;
    facts[`${module.key}Outcome`] = outcome.kind === "award" ? `award:${outcome.reason}` : outcome.kind;
  });
  facts.sportCount = visited;
  facts.opponentAdvancesIn = advancing;

  // The picture (M9): the semi-finals and the final, from the engine's own wiring. The semi-final that was walked over, and
  // the final its winner is now seated in.
  const semis = lines.filter((l) => l.round === 1);
  const final = lines.find((l) => l.round === 2)!;
  const waitingFor = semis.find((l) => updates.get(l.id) === undefined && (l.id === final.homeFrom || l.id === final.awayFrom));
  return {
    facts,
    table: {
      caption: `An eight-player knockout after round one. ${WITHDRAWN}, the fourth seed, withdraws before the semi-final.`,
      columns: ["Match", "Before the withdrawal", "After it"],
      rows,
    },
    diagram: {
      kind: "walkoverBracket",
      title: `${WITHDRAWN} withdrew before the semi-final. ${walkover?.walkoverTo ?? ""} goes through by walkover and is seated in the final, where the other seat waits for the winner of ${(nameOf.get(waitingFor?.id ?? "") ?? "the other semi-final").toLowerCase()}.`,
      rounds: [
        {
          name: "Semi-finals",
          matches: semis.map((l) => {
            const u = updates.get(l.id);
            return {
              sides: [l.home ?? NOT_KNOWN, l.away ?? NOT_KNOWN] as [string, string],
              ...(u !== undefined ? { struck: [WITHDRAWN], winner: u.walkoverTo } : {}),
              result: u !== undefined ? "Walkover" : "Not played yet",
            };
          }),
        },
        {
          name: "Final",
          matches: [
            {
              sides: [seatsAfter.get(final.id)!.home ?? NOT_KNOWN, seatsAfter.get(final.id)!.away ?? NOT_KNOWN] as [string, string],
              result: "Not played yet",
            },
          ],
        },
      ],
    },
    text: [],
  };
}

// ---- claims: the rule recomputed from the fixture input, and the fold held to the engine's bracket rule ----

/** The first round of an eight-player draw as the rulebook seeds it (standard single-elimination seeding: 1 meets 8, 4 meets 5
 *  on one side of the draw, and 3 meets 6, 2 meets 7 on the other), as seed numbers. The claims read the table against THIS,
 *  never against the engine's draw (which `build()` calls). Home and away order is not part of the rule. */
const SEEDED_FIRST_ROUND: readonly (readonly [number, number])[] = [[1, 8], [4, 5], [3, 6], [2, 7]];
const nameOfSeed = (seed: number): string => KNOCKOUT_PLAYERS[seed - 1]!;
const lowerSeed = (a: number, b: number): number => Math.min(a, b);

/** A "Before"/"After" cell "A against B" or "A against B: W won", as the two names (a set) and the winner. */
function seatsOf(cell: string): { sides: [string, string]; winner?: string } | null {
  const m = /^(.+?) against (.+?)(?:: (.+) won)?$/.exec(cell);
  return m === null ? null : { sides: [m[1]!, m[2]!], ...(m[3] !== undefined ? { winner: m[3] } : {}) };
}
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

const claims: Claim[] = [
  {
    says: "the table is the seeded eight-player draw after round one, every seed having won, and then the withdrawal: names, results and walkover in every row",
    source: "standard single-elimination seeding (1v8, 4v5, 3v6, 2v7; the semi-finals meet the winners of the first two and of the last two); bracket withdrawal rule (spec 05 §5 bracket_walkover): only unfinished matches change",
    check(r) {
      const rows = r.table?.rows ?? [];
      if (rows.length !== 7) return `${rows.length} rows, an eight-player draw has 7 matches`;
      const withdrawnSeed = KNOCKOUT_PLAYERS.indexOf(WITHDRAWN as (typeof KNOCKOUT_PLAYERS)[number]) + 1;
      // Quarter-finals.
      const winners: number[] = [];
      for (const [i, [a, b]] of SEEDED_FIRST_ROUND.entries()) {
        const row = rows[i]!;
        const before = seatsOf(String(row[1]));
        const winner = lowerSeed(a, b);
        winners.push(winner);
        if (row[0] !== `Quarter-final ${i + 1}`) return `row ${i + 1} is named '${String(row[0])}'`;
        if (before === null || !sameSet(before.sides, [nameOfSeed(a), nameOfSeed(b)]) || before.winner !== nameOfSeed(winner)) return `quarter-final ${i + 1}: '${String(row[1])}'`;
        if (row[2] !== "Unchanged: the result stands") return `quarter-final ${i + 1} changed: '${String(row[2])}'`;
      }
      // Semi-finals: winners of QF1+QF2, and of QF3+QF4. The withdrawn seed is in one of them.
      for (const [i, pair] of [[0, 1], [2, 3]].entries()) {
        const row = rows[4 + i]!;
        const seeds = [winners[pair[0]!]!, winners[pair[1]!]!];
        const before = seatsOf(String(row[1]));
        if (row[0] !== `Semi-final ${i + 1}`) return `row ${5 + i} is named '${String(row[0])}'`;
        if (before === null || before.winner !== undefined || !sameSet(before.sides, seeds.map(nameOfSeed))) return `semi-final ${i + 1}: '${String(row[1])}'`;
        if (seeds.includes(withdrawnSeed)) {
          const other = nameOfSeed(seeds.find((s) => s !== withdrawnSeed)!);
          if (row[2] !== `Walkover: ${other} goes through`) return `semi-final ${i + 1} after: '${String(row[2])}'`;
        } else if (row[2] !== "Unchanged") return `semi-final ${i + 1} changed: '${String(row[2])}'`;
      }
      // Final: not drawn before; after, the walkover's winner is seated and the other seat waits.
      const sfWithWithdrawn = [[0, 1], [2, 3]].findIndex((pair) => pair.some((q) => winners[q] === withdrawnSeed));
      const goesThrough = nameOfSeed(winners[[[0, 1], [2, 3]][sfWithWithdrawn]!.find((q) => winners[q] !== withdrawnSeed)!]!);
      const final = rows[6]!;
      const seated = seatsOf(String(final[2]));
      if (final[0] !== "Final" || final[1] !== "Not drawn yet") return `the final reads '${String(final[0])}' / '${String(final[1])}'`;
      return (seated !== null && seated.winner === undefined && sameSet(seated.sides, [goesThrough, NOT_KNOWN])) || `the final after: '${String(final[2])}'`;
    },
  },
  {
    says: "every result already played stands, and the played count is the table's",
    source: "bracket withdrawal rule (spec 05 §5 bracket_walkover): only unfinished matches change",
    check(r) {
      const played = (r.table?.rows ?? []).filter((row) => String(row[1]).includes(" won"));
      if (played.length === 0) return "anti-vacuity: no played result in the example";
      if (r.facts.playedResults !== played.length) return "playedResults differs from the table";
      return played.every((row) => row[2] === "Unchanged: the result stands") || "a played result changed";
    },
  },
  {
    says: "the withdrawn player's unfinished match, and only it, becomes a walkover to the player they were drawn against",
    source: "bracket withdrawal rule: the opponent advances by walkover (fixture input: who meets the fourth seed)",
    check(r) {
      if (r.facts.withdrawn !== WITHDRAWN) return `withdrawn '${String(r.facts.withdrawn)}'`;
      const rows = r.table?.rows ?? [];
      const mine = rows.filter((row) => !String(row[1]).includes(" won") && String(row[1]).split(" against ").includes(WITHDRAWN));
      const walkovers = rows.filter((row) => String(row[2]).startsWith("Walkover"));
      if (mine.length !== 1 || walkovers.length !== 1 || mine[0] !== walkovers[0]) return "the walkover is not exactly the withdrawn player's match";
      const other = String(mine[0]![1]).split(" against ").find((p) => p !== WITHDRAWN);
      if (r.facts.opponent !== other || r.facts.walkovers !== 1) return `opponent '${String(r.facts.opponent)}', expected '${other}'`;
      return String(mine[0]![2]) === `Walkover: ${other} goes through` || `after: ${String(mine[0]![2])}`;
    },
  },
  {
    says: "the picture draws the semi-finals and the final of the table: the walkover to the opponent, the withdrawn player struck, the opponent seated in the final",
    source: "a recount of the table against the diagram model",
    check(r) {
      const d = r.diagram;
      if (d?.kind !== "walkoverBracket") return "no walkover bracket";
      const rows = r.table?.rows ?? [];
      if (rows.length !== 7 || d.rounds.length !== 2 || d.rounds[0]!.matches.length !== 2 || d.rounds[1]!.matches.length !== 1) return "the picture is not two semi-finals and a final";
      for (const [i, m] of d.rounds[0]!.matches.entries()) {
        const row = rows[4 + i]!;
        const before = seatsOf(String(row[1]));
        if (before === null || !sameSet(m.sides, before.sides)) return `semi-final ${i + 1}: the sides differ from the table`;
        const walkover = String(row[2]).startsWith("Walkover");
        const goesThrough = /^Walkover: (.+) goes through$/.exec(String(row[2]))?.[1];
        if (walkover !== (m.winner !== undefined) || (walkover && (m.winner !== goesThrough || !sameSet(m.struck ?? [], [WITHDRAWN])))) return `semi-final ${i + 1}: the walkover differs from the table`;
        if (!walkover && (m.struck !== undefined || m.winner !== undefined)) return `semi-final ${i + 1}: marked but not walked over`;
        if (m.result !== (walkover ? "Walkover" : "Not played yet")) return `semi-final ${i + 1}: the picture says '${m.result}'`;
      }
      if (d.rounds[0]!.name !== "Semi-finals" || d.rounds[1]!.name !== "Final") return `the picture's rounds are '${d.rounds.map((x) => x.name).join("', '")}'`;
      if (d.rounds[1]!.matches[0]!.result !== "Not played yet") return `the final's result line is '${d.rounds[1]!.matches[0]!.result}'`;
      const seated = seatsOf(String(rows[6]![2]));
      return (seated !== null && sameSet(d.rounds[1]!.matches[0]!.sides, seated.sides)) || "the final's seats differ from the table";
    },
  },
  {
    says: "in every sport the withdrawal walkover is won by the opponent, who goes on; it is not a double walkover, which would send nobody on",
    source: "the sport registry (forEachSport) and the engine's advancesNobody (true for a double walkover only)",
    check(r) {
      if (r.facts.sportCount !== builtinModules.length || r.facts.opponentAdvancesIn !== builtinModules.length) return "a sport does not send the opponent on";
      if (!advancesNobody({ kind: "double_walkover" } as MatchOutcome)) return "the witness case no longer differs";
      return builtinModules.every((m) => r.facts[`${m.key}Outcome`] === "award:withdrew") || "a sport books something other than a withdrawal award";
    },
  },
];

export const knockoutWithdrawal: EngineExample = {
  id: KNOCKOUT_WITHDRAWAL_ID,
  kind: "engine",
  sports: "all",
  build,
  claims,
};
