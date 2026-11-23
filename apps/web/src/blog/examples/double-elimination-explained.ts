// Post #20, "How does double elimination work, and what is a grand final reset?". Four players, seeded 1 to 4, drawn by the
// app (`generate` through `appDraw`) as a double elimination twice: with the grand final reset on, and with it off. The same
// results are played into both: the better seed wins every match except the grand final, which the losers' bracket champion
// wins. With the reset on, that first loss sends the winners' bracket champion to a second grand final; with it off, the
// title is decided there and the winners' bracket champion finishes second after one defeat. Lanes and round names are the
// product's words, and the places are the engine's `bracketRanks`.
//
// The figure draws the with-reset bracket as played: a solid line carries a winner on, a dashed one carries a winners' bracket
// loser down to the losers' bracket. Its feeds are the generator's own.
//
// WHAT CHECKS IT: the claims check the result against double elimination itself (out after two defeats; a winners'
// bracket loser drops to the losers' bracket; the grand final is the two bracket champions; a reset is played only after
// the winners' bracket champion's first defeat), the app's forfeit rule (a forfeit loser does NOT drop), the figure's wiring,
// and the registry's size. None reads `build()`.
import { builtinModules } from "@seazn/engine/sports";
import { msg } from "@/lib/messages";
import { appDraw, betterSeedWins, bracketModel, forfeitOutClaim, offeredSweep, ordinal, placesOf, playBracket, type Pick, type PlayedLine } from "./bracket-play-b4";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const DOUBLE_ELIM_ID = "double-elimination-explained";

const PLAYERS = ["Ana", "Ben", "Cy", "Dev"] as const;
const SEEDS = new Map<string, number>(PLAYERS.map((p, i) => [p, i + 1]));
const COLUMNS = ["Bracket", "Match", "Players (seed)", "Winner", "Loser's defeats so far"];
const C = { lane: 0, match: 1, players: 2, winner: 3, losses: 4 } as const;
const LANE: Record<string, string> = { WB: msg("bracket.winners"), LB: msg("bracket.losers"), GF: msg("bracket.grandFinal") };
const withSeed = (p: string) => `${p} (${SEEDS.get(p)})`;

/** The better seed wins, except the (first) grand final, which the losers' bracket champion takes; the reset is played only
 *  when the first grand final went to the losers' bracket champion (the generator's `conditional` line). */
const pick: Pick = (home, away, f, played) => {
  if (f.bracket === "GF" && f.conditional !== true) return away; // away = the losers' bracket champion
  if (f.conditional === true) {
    const first = played.find((p) => p.bracket === "GF" && p.isFinal === true && p.status === "decided" && p.id !== f.id);
    if (first === undefined) throw new Error("double-elimination: the reset is read before the grand final");
    if (first.winner === first.home) return null; // the winners' bracket champion won: no reset
    return betterSeedWins(SEEDS)(home, away, f) === home ? away : home; // the reset goes the same way as the first
  }
  return betterSeedWins(SEEDS)(home, away, f);
};

function defeatsIn(lines: readonly PlayedLine[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) if (l.row.loser !== undefined) m.set(l.row.loser, (m.get(l.row.loser) ?? 0) + 1);
  return m;
}

function build(): ExampleResult {
  const withReset = appDraw("double_elim", { bracketReset: true }, PLAYERS, SEEDS);
  const noReset = appDraw("double_elim", {}, PLAYERS, SEEDS);
  if ("refused" in withReset || "refused" in noReset) throw new Error("double-elimination: the four-player draw was refused");
  const lines = playBracket("double_elim", withReset, pick);
  const linesNo = playBracket("double_elim", noReset, pick);
  const places = new Map(placesOf("double_elim", PLAYERS, SEEDS, lines).map((p) => [p.entrantId, p.rank]));
  const placesNo = new Map(placesOf("double_elim", PLAYERS, SEEDS, linesNo).map((p) => [p.entrantId, p.rank]));

  const running = new Map<string, number>();
  const rows = lines
    .filter((l) => l.row.status === "decided")
    .map((l) => {
      running.set(l.row.loser!, (running.get(l.row.loser!) ?? 0) + 1);
      return [LANE[l.gen.bracket!]!, l.roundName, `${withSeed(l.row.home!)} v ${withSeed(l.row.away!)}`, withSeed(l.row.winner!), running.get(l.row.loser!)!];
    });
  const defeats = defeatsIn(lines);
  const defeatsNo = defeatsIn(linesNo);
  const championOf = (p: Map<string, number>) => [...p].find(([, r]) => r === 1)![0];
  const champ = championOf(places);
  const champNo = championOf(placesNo);
  const runnerUpNo = [...placesNo].find(([, r]) => r === 2)![0];
  const wbChampion = lines.find((l) => l.gen.bracket === "GF" && l.gen.conditional !== true)!.row.home!;
  const offered = offeredSweep("double_elim");
  const diagram = bracketModel(
    `${withSeed(wbChampion)} wins the winners bracket but loses the grand final, so both finalists have lost once and the reset is played: ${withSeed(champ)} wins it too, and ${withSeed(wbChampion)} finishes ${ordinal(places.get(wbChampion)!)} after ${defeats.get(wbChampion) ?? 0} defeats. A dashed line is a winners bracket loser dropping into the losers bracket.`,
    lines,
    { seat: withSeed },
  );

  return {
    facts: {
      players: PLAYERS.length,
      matchesWithReset: lines.filter((l) => l.row.status === "decided").length,
      matchesNoReset: linesNo.filter((l) => l.row.status === "decided").length,
      champion: champ,
      championDefeats: defeats.get(champ) ?? 0,
      wbChampion,
      wbChampionPlace: ordinal(places.get(wbChampion)!),
      wbChampionDefeats: defeats.get(wbChampion) ?? 0,
      noResetChampion: champNo,
      noResetRunnerUp: runnerUpNo,
      noResetRunnerUpDefeats: defeatsNo.get(runnerUpNo) ?? 0,
      sportsOffered: offered.offered.length,
      sportCount: offered.visited,
    },
    table: {
      caption: "Four players, double elimination with the grand final reset on. The losers' bracket champion wins the grand final, so the reset is played, and every player but the champion leaves with two defeats.",
      columns: COLUMNS,
      rows,
    },
    diagram,
    text: [`With the reset off, the same results end after ${linesNo.filter((l) => l.row.status === "decided").length} matches.`],
  };
}

const nameOf = (cell: unknown) => String(cell).replace(/ \(\d+\)$/, "");
const sides = (row: (string | number)[]) => String(row[C.players]).split(" v ").map(nameOf);
const loser = (row: (string | number)[]) => sides(row).find((p) => p !== nameOf(row[C.winner]))!;
const rowsIn = (r: ExampleResult, lane: string) => r.table?.rows.filter((row) => row[C.lane] === lane) ?? [];

const claims: Claim[] = [
  forfeitOutClaim(),
  {
    says: "every player except the champion leaves with exactly two defeats, and the champion has at most one",
    source: "double elimination: a player is out after a second defeat (ENG/scheduling/bracket.js:323-330)",
    check: (r) => {
      const rows = r.table?.rows ?? [];
      if (rows.length === 0) return "no matches";
      const total = new Map<string, number>();
      for (const row of rows) total.set(loser(row), (total.get(loser(row)) ?? 0) + 1);
      const champ = String(r.facts.champion);
      const others = [...total].filter(([p]) => p !== champ);
      if (others.length !== Number(r.facts.players) - 1) return `${others.length} players other than the champion lost`;
      if (!others.every(([, n]) => n === 2)) return `defeats ${others.map(([p, n]) => `${p} ${n}`).join(", ")}`;
      // The running count in the table ends at each player's total.
      const last = new Map<string, number>();
      for (const row of rows) last.set(loser(row), Number(row[C.losses]));
      if (![...total].every(([p, n]) => last.get(p) === n)) return "the running defeat count does not end at each player's total";
      return (total.get(champ) ?? 0) <= 1 || `the champion lost ${total.get(champ)} times`;
    },
  },
  {
    says: "a winners' bracket loser is not out: it plays again, in the losers' bracket or the grand final",
    source: "ENG/scheduling/bracket.js:340-385 (each winners' round's losers drop into the losers' bracket)",
    check: (r) => {
      const rows = r.table?.rows ?? [];
      const wb = rowsIn(r, LANE.WB!);
      if (wb.length === 0) return "no winners' bracket matches";
      for (const row of wb) {
        const p = loser(row);
        const after = rows.slice(rows.indexOf(row) + 1).some((x) => x[C.lane] !== LANE.WB && sides(x).includes(p));
        if (!after) return `${p} lost in the winners' bracket and never played again`;
      }
      return true;
    },
  },
  {
    says: "the grand final is the winners' bracket champion against the losers' bracket champion",
    source: "ENG/scheduling/bracket.js:386-399 (grand final: winners' champion home, losers' champion away)",
    check: (r) => {
      const wb = rowsIn(r, LANE.WB!);
      const lb = rowsIn(r, LANE.LB!);
      const gf = rowsIn(r, LANE.GF!)[0];
      if (wb.length === 0 || lb.length === 0 || gf === undefined) return "a bracket is missing";
      const want = [nameOf(wb[wb.length - 1]![C.winner]), nameOf(lb[lb.length - 1]![C.winner])];
      return JSON.stringify(sides(gf)) === JSON.stringify(want) || `grand final ${gf[C.players]}, want ${want.join(" v ")}`;
    },
  },
  {
    says: "the reset is played only because the winners' bracket champion lost the first grand final; with no reset that player finishes second after one defeat",
    source: "ENG/scheduling/bracket.js:400-416 (the reset, conditional on the losers' champion winning the grand final); ENG/competition/stage.js bracketRanks (title)",
    check: (r) => {
      const gf = rowsIn(r, LANE.GF!);
      if (gf.length !== 2) return `${gf.length} grand finals`;
      if (nameOf(gf[0]![C.winner]) === String(r.facts.wbChampion)) return "the winners' champion won the first grand final, yet a reset was played";
      if (Number(r.facts.matchesWithReset) - Number(r.facts.matchesNoReset) !== 1) return `${r.facts.matchesWithReset} and ${r.facts.matchesNoReset} matches`;
      // The right answer differs from the wrong one: without the reset the player out is out after ONE defeat.
      return (r.facts.noResetRunnerUp === r.facts.wbChampion && r.facts.noResetRunnerUpDefeats === 1 && r.facts.wbChampionDefeats === 2) ||
        `no reset: runner-up ${r.facts.noResetRunnerUp} with ${r.facts.noResetRunnerUpDefeats}; reset: ${r.facts.wbChampion} with ${r.facts.wbChampionDefeats}`;
    },
  },
  {
    says: "the post's grand final story holds: the winners bracket champion lost the first grand final to the champion, played the reset, lost it, and finishes 2nd with two defeats",
    source: "double elimination: a player is out after a second defeat; the final's loser is the runner-up (ENG/competition/stage.js bracketRanks title)",
    check: (r) => {
      const gf = rowsIn(r, LANE.GF!);
      if (gf.length !== 2) return `${gf.length} grand finals`;
      const last = gf[1]!;
      if (nameOf(last[C.winner]) !== r.facts.champion) return `the reset's winner is ${nameOf(last[C.winner])}, the post names ${r.facts.champion} as champion`;
      if (loser(last) !== r.facts.wbChampion) return `the reset's loser is ${loser(last)}, the post names ${r.facts.wbChampion} as the winners bracket champion`;
      if (r.facts.wbChampionPlace !== "2nd") return `the winners bracket champion is placed ${r.facts.wbChampionPlace}`;
      return (Number(last[C.losses]) === 2 && r.facts.wbChampionDefeats === 2 && r.facts.championDefeats === 1) || `defeats: reset loser ${last[C.losses]}, fact ${r.facts.wbChampionDefeats}, champion ${r.facts.championDefeats}`;
    },
  },
  {
    says: "the figure draws the winners bracket losers dropping into the losers bracket (dashed lines), and the grand final fed by the two bracket champions",
    source: "ENG/scheduling/bracket.js:340-399 (winners' round losers drop; the grand final is the winners' champion v the losers' champion)",
    check: (r) => {
      const matches = r.diagram?.kind === "bracket" ? r.diagram.rounds.flatMap((x) => x.matches) : [];
      if (matches.length === 0) return "no bracket diagram";
      const byId = new Map(matches.map((m) => [m.id, m] as const));
      const feeds = (m: (typeof matches)[number]) => [m.homeFrom, m.awayFrom].filter((f) => f !== undefined);
      const winnersLabels = new Set([msg("bracket.round.semi"), msg("bracket.round.winnersFinal")]);
      const loserEdges = matches.flatMap((m) => feeds(m).filter((f) => f.side === "loser").map((f) => ({ from: byId.get(f.id)!, to: m })));
      const drops = loserEdges.filter((e) => winnersLabels.has(String(e.from.label)));
      if (drops.length === 0) return "no winners bracket loser is drawn dropping anywhere";
      // A winners bracket loser lands in a match of the losers bracket, never back in the winners bracket.
      if (drops.some((e) => winnersLabels.has(String(e.to.label)))) return "a winners bracket loser is drawn dropping into the winners bracket";
      // The only other loser edge is the first grand final's loser, who plays the reset.
      const rest = loserEdges.filter((e) => !winnersLabels.has(String(e.from.label)));
      if (!rest.every((e) => e.from.label === msg("bracket.round.grandFinal") && e.to.label === msg("bracket.round.grandFinalReset"))) return "a loser edge comes from a match that is not in the winners bracket";
      const gf = matches.find((m) => m.label === msg("bracket.round.grandFinal"));
      if (gf === undefined) return "no grand final drawn";
      const gfFrom = feeds(gf).map((f) => byId.get(f.id)?.label);
      return (feeds(gf).length === 2 && feeds(gf).every((f) => f.side === "winner") && gfFrom.includes(msg("bracket.round.winnersFinal")) && gfFrom.includes(msg("bracket.round.losersFinal"))) || `the grand final is fed by ${gfFrom.join(", ")}`;
    },
  },
  {
    says: "double elimination is offered to a new division of every sport in the registry (the draw reads no sport)",
    source: "templatesForSport (WEB/lib/format-templates.ts: double_elim) over forEachSport",
    check: (r) => (r.facts.sportCount === builtinModules.length && r.facts.sportsOffered === builtinModules.length) || `${r.facts.sportsOffered} of ${r.facts.sportCount}`,
  },
];

export const doubleEliminationExplained: BlogExample = {
  id: DOUBLE_ELIM_ID,
  kind: "engine",
  sports: "all",
  build,
  claims,
};
