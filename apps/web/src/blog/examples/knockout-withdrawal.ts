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
const PLAYERS = ["Ana", "Ben", "Cy", "Dev", "Eli", "Fay", "Gus", "Hal"] as const;
const WITHDRAWN = "Dev";
const ROUND_NAMES = ["Quarter-final", "Semi-final", "Final"] as const;

interface Line {
  id: string;
  round: number;
  home?: string;
  away?: string;
  status: BracketFixture["status"];
  winner?: string;
  loser?: string;
}

/** The bracket after round one: every seed beat the lower seed, and the winners are seated in the next round. */
function bracketAfterRoundOne(): Line[] {
  const seeds = new Map(PLAYERS.map((p, i) => [p as string, i + 1]));
  const { fixtures } = generateSingleElim({ entrants: [...PLAYERS], seeds });
  const lines = new Map<string, Line>(fixtures.map((f) => [f.id, { id: f.id, round: f.round, home: f.home, away: f.away, status: "scheduled" }]));
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

const vs = (l: Line) => (l.home === undefined && l.away === undefined ? "Not drawn yet" : `${l.home ?? "not known yet"} against ${l.away ?? "not known yet"}`);

function build(): ExampleResult {
  const lines = bracketAfterRoundOne();
  const plan = withdrawBracketEntrant(
    { id: "ko", kind: "knockout", entrants: [...PLAYERS] },
    WITHDRAWN,
    lines.map((l) => ({ id: l.id, round: l.round, status: l.status, home: l.home, away: l.away, winner: l.winner, loser: l.loser })),
  );
  const updates = new Map(plan.updates.map((u) => [u.fixtureId, u]));
  const counter = new Map<number, number>();
  const inRound = (round: number) => lines.filter((x) => x.round === round).length;
  const rows = lines.map((l) => {
    const n = (counter.get(l.round) ?? 0) + 1;
    counter.set(l.round, n);
    const name = inRound(l.round) === 1 ? ROUND_NAMES[l.round]! : `${ROUND_NAMES[l.round]} ${n}`;
    const before = l.status === "decided" ? `${vs(l)}: ${l.winner} won` : vs(l);
    const u = updates.get(l.id);
    const after = u === undefined ? (l.status === "decided" ? "Unchanged: the result stands" : "Unchanged") : `Walkover: ${u.walkoverTo} goes through`;
    return [name, before, after];
  });
  const walkover = plan.updates[0];

  const facts: Record<string, string | number> = {
    withdrawn: WITHDRAWN,
    withdrawnSeed: PLAYERS.indexOf(WITHDRAWN) + 1,
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
  return {
    facts,
    table: {
      caption: `An eight-player knockout after round one. ${WITHDRAWN}, the fourth seed, withdraws before the semi-final.`,
      columns: ["Match", "Before the withdrawal", "After it"],
      rows,
    },
    text: [],
  };
}

// ---- claims: the rule recomputed from the fixture input, and the fold held to the engine's bracket rule ----

const claims: Claim[] = [
  {
    says: "every result already played stands: no quarter-final changes",
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
