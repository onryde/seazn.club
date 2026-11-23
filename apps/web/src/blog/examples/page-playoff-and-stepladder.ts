// Post #19, "What are a Page playoff and a stepladder final?". The same four players, seeded 1 to 4, go through both
// finals series as the app draws them (`generate`, through `appDraw`), with results chosen to show what each series is for:
// in the Page playoff the top seed loses Qualifier 1 and still wins the title through Qualifier 2; in the stepladder the
// bottom seed climbs two rungs and loses the final. Who meets whom is the generator's own wiring (its feeds), the round
// names are the product's, and the places are the engine's `bracketRanks`. Every field size from 2 to 8 is offered to the
// Page playoff, so the one size it takes is the producer's answer, never a typed number.
//
// The figure draws both series in one picture, each in its own headed block: a solid line carries a winner on, a dashed one
// carries the Qualifier 1 loser to Qualifier 2. Its feeds are the generator's own.
//
// WHAT CHECKS IT: the claims check the result against the Page playoff system (1 v 2 and 3 v 4; the loser of the first
// meets the winner of the second; then the final) and the stepladder (the two lowest seeds play first, each winner meets
// the next seed up; k players play k - 1 matches), the app's forfeit rule (a forfeit loser never reaches Qualifier 2), the
// figure's wiring, and the registry's size. None reads `build()`.
import { builtinModules } from "@seazn/engine/sports";
import { appDraw, betterSeedWins, bracketModel, forfeitOutClaim, mergeBrackets, offeredSweep, ordinal, placesOf, playBracket, type PlayedLine } from "./bracket-play-b4";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const PAGE_STEPLADDER_ID = "page-playoff-and-stepladder";

const PLAYERS = ["Ana", "Ben", "Cy", "Dev"] as const;
const SEEDS = new Map<string, number>(PLAYERS.map((p, i) => [p, i + 1]));
const PAGE = "Page playoff";
const STEP = "Stepladder";
const COLUMNS = ["Series", "Match", "Players (seed)", "Winner", "Where the loser finished"];
const C = { series: 0, match: 1, players: 2, winner: 3, loserPlace: 4 } as const;
const withSeed = (p: string) => `${p} (${SEEDS.get(p)})`;

function rowsOf(series: string, lines: readonly PlayedLine[], places: Map<string, number>): (string | number)[][] {
  return lines.map((l) => [series, l.roundName, `${withSeed(l.row.home!)} v ${withSeed(l.row.away!)}`, withSeed(l.row.winner!), ordinal(places.get(l.row.loser!)!)]);
}

function build(): ExampleResult {
  // The Page playoff takes one field size: ask every size from 2 to 8.
  const pageSizes: number[] = [];
  const names = ["Ana", "Ben", "Cy", "Dev", "Eli", "Fay", "Gus", "Hal"];
  const allSeeds = new Map(names.map((p, i) => [p, i + 1]));
  for (let n = 2; n <= names.length; n++) if (!("refused" in appDraw("page_playoff", {}, names.slice(0, n), allSeeds))) pageSizes.push(n);
  if (pageSizes.length !== 1) throw new Error(`page-playoff: expected one field size, the app draws ${pageSizes.join(", ")}`);

  const page = appDraw("page_playoff", {}, PLAYERS, SEEDS);
  const step = appDraw("stepladder", {}, PLAYERS, SEEDS);
  if ("refused" in page || "refused" in step) throw new Error("page-playoff: a four-player series was refused");
  // Page: the 2 seed beats the 1 seed in Qualifier 1; every other match goes to the better seed.
  const pageLines = playBracket("page_playoff", page, betterSeedWins(SEEDS, { "pp-q1": "Ben" }));
  // Stepladder: the 4 seed wins its first two rungs; the better seed wins the final.
  const stepLines = playBracket("stepladder", step, betterSeedWins(SEEDS, { "Cy|Dev": "Dev", "Ben|Dev": "Dev" }));
  const pagePlaces = new Map(placesOf("page_playoff", PLAYERS, SEEDS, pageLines).map((p) => [p.entrantId, p.rank]));
  const stepPlaces = new Map(placesOf("stepladder", PLAYERS, SEEDS, stepLines).map((p) => [p.entrantId, p.rank]));
  const champion = (lines: readonly PlayedLine[]) => lines.find((l) => l.gen.isFinal === true)!.row.winner!;
  const q1 = pageLines.find((l) => l.gen.id === "pp-q1")!;
  const bottom = PLAYERS[PLAYERS.length - 1]!;
  const offeredPage = offeredSweep("group_playoffs");
  const offeredStep = offeredSweep("group_stepladder");
  const seat = (p: string) => withSeed(p);
  const stepBottomWins = stepLines.filter((l) => l.row.winner === bottom).length;
  const title =
    `Page playoff: ${withSeed(q1.row.loser!)} loses Qualifier 1, wins Qualifier 2 and then the final, so the top seed can lose once and still take the title. ` +
    `Stepladder: ${withSeed(bottom)} wins ${stepBottomWins} matches in a row from the bottom rung, then loses the final to ${withSeed(PLAYERS[0]!)}, who has played only that one match.`;
  const diagram = mergeBrackets(
    title,
    bracketModel("", pageLines, { seat, lane: PAGE, idPrefix: "pp:" }),
    bracketModel("", stepLines, { seat, lane: STEP, idPrefix: "sl:" }),
  );

  return {
    facts: {
      pageField: pageSizes[0]!,
      pageMatches: pageLines.length,
      pageQ1Loser: q1.row.loser!,
      pageChampion: champion(pageLines),
      stepPlayers: PLAYERS.length,
      stepMatches: stepLines.length,
      stepBottom: bottom,
      stepBottomWins,
      stepTop: PLAYERS[0]!,
      stepTopMatches: stepLines.filter((l) => l.row.home === PLAYERS[0] || l.row.away === PLAYERS[0]).length,
      stepChampion: champion(stepLines),
      stepBottomPlace: ordinal(stepPlaces.get(bottom)!),
      sportsOfferedPage: offeredPage.offered.length,
      sportsOfferedStep: offeredStep.offered.length,
      sportCount: offeredPage.visited,
    },
    table: {
      caption: "The same four players through both finals series. In the Page playoff the top seed loses its first match and still wins the title; in the stepladder the bottom seed wins two matches and loses the final.",
      columns: COLUMNS,
      rows: [...rowsOf(PAGE, pageLines, pagePlaces), ...rowsOf(STEP, stepLines, stepPlaces)],
    },
    diagram,
    text: [`The Page playoff is drawn for ${pageSizes[0]} players only.`],
  };
}

const seedsIn = (cell: unknown) => [...String(cell).matchAll(/\((\d+)\)/g)].map((m) => Number(m[1]));
const nameOf = (cell: unknown) => String(cell).replace(/ \(\d+\)$/, "");
const series = (r: ExampleResult, s: string) => r.table?.rows.filter((row) => row[C.series] === s) ?? [];
const byMatch = (r: ExampleResult, s: string, name: string) => series(r, s).find((row) => row[C.match] === name);
const loserOf = (row: (string | number)[]) => String(row[C.players]).split(" v ").find((x) => x !== row[C.winner])!;

const claims: Claim[] = [
  forfeitOutClaim(),
  {
    says: "Page playoff: Qualifier 1 is the 1 seed against the 2 seed, and the Eliminator the 3 seed against the 4 seed",
    source: "Page playoff system (top four: 1 v 2, 3 v 4); ENG/scheduling/bracket.js:419-434",
    check: (r) => {
      const q1 = byMatch(r, PAGE, "Qualifier 1");
      const el = byMatch(r, PAGE, "Eliminator");
      if (q1 === undefined || el === undefined) return "Qualifier 1 or the Eliminator is missing";
      return (JSON.stringify(seedsIn(q1[C.players]).sort()) === "[1,2]" && JSON.stringify(seedsIn(el[C.players]).sort()) === "[3,4]") || `${q1[C.players]}; ${el[C.players]}`;
    },
  },
  {
    says: "Page playoff: the loser of Qualifier 1 is not out; it meets the Eliminator's winner in Qualifier 2 (a one-loss knockout would end it)",
    source: "Page playoff system: Qualifier 2 is the loser of Qualifier 1 against the winner of the Eliminator",
    check: (r) => {
      const q1 = byMatch(r, PAGE, "Qualifier 1");
      const el = byMatch(r, PAGE, "Eliminator");
      const q2 = byMatch(r, PAGE, "Qualifier 2");
      if (q1 === undefined || el === undefined || q2 === undefined) return "a Page playoff match is missing";
      const sides = String(q2[C.players]).split(" v ").map(nameOf).sort();
      const want = [nameOf(loserOf(q1)), nameOf(el[C.winner])].sort();
      return JSON.stringify(sides) === JSON.stringify(want) || `Qualifier 2 is ${q2[C.players]}`;
    },
  },
  {
    says: "Page playoff: the final is the winner of Qualifier 1 against the winner of Qualifier 2, and the Eliminator's loser plays no more",
    source: "Page playoff system; ENG/scheduling/bracket.js:419-434",
    check: (r) => {
      const q1 = byMatch(r, PAGE, "Qualifier 1");
      const q2 = byMatch(r, PAGE, "Qualifier 2");
      const el = byMatch(r, PAGE, "Eliminator");
      const fin = byMatch(r, PAGE, "Final");
      if (q1 === undefined || q2 === undefined || el === undefined || fin === undefined) return "a Page playoff match is missing";
      const sides = String(fin[C.players]).split(" v ").map(nameOf).sort();
      const want = [nameOf(q1[C.winner]), nameOf(q2[C.winner])].sort();
      if (JSON.stringify(sides) !== JSON.stringify(want)) return `the final is ${fin[C.players]}`;
      const out = nameOf(loserOf(el));
      const later = series(r, PAGE).filter((row) => row !== el && String(row[C.players]).includes(`${out} (`));
      return later.length === 0 || `${out} plays again after losing the Eliminator`;
    },
  },
  {
    says: "the Page playoff takes exactly the top four, and has four matches",
    source: "Page playoff system (four teams, four matches); ENG/scheduling/bracket.js:421-423",
    check: (r) => (r.facts.pageField === 4 && r.facts.pageMatches === 4 && series(r, PAGE).length === 4) || `field ${r.facts.pageField}, matches ${r.facts.pageMatches}`,
  },
  {
    says: "stepladder: k players play k - 1 matches; the two lowest seeds play first, and each winner meets the next seed up",
    source: "stepladder final (bowling's step-ladder); ENG/scheduling/bracket.js:436-461",
    check: (r) => {
      const rows = series(r, STEP);
      const k = Number(r.facts.stepPlayers);
      if (rows.length !== k - 1) return `${rows.length} matches for ${k} players`;
      for (let j = 0; j < rows.length; j++) {
        const seeds = seedsIn(rows[j]![C.players]);
        const waiting = k - 1 - j; // the seed that enters at this rung
        if (!seeds.includes(waiting)) return `rung ${j + 1} (${rows[j]![C.players]}) lacks the ${waiting} seed`;
        if (j === 0 && !seeds.includes(k)) return `the first match lacks the ${k} seed`;
        if (j > 0 && !String(rows[j]![C.players]).includes(String(rows[j - 1]![C.winner]))) return `rung ${j + 1} lacks the previous winner`;
      }
      return true;
    },
  },
  {
    says: "stepladder: the top seed plays only the final, and the bottom seed needs k - 1 wins in a row to take the title",
    source: "stepladder final; ENG/scheduling/bracket.js:436-461",
    check: (r) => {
      const k = Number(r.facts.stepPlayers);
      if (r.facts.stepTopMatches !== 1) return `the top seed plays ${r.facts.stepTopMatches} matches`;
      const bottomRows = series(r, STEP).filter((row) => String(row[C.players]).includes(`(${k})`) || String(row[C.players]).includes(`${r.facts.stepBottom} (`));
      return bottomRows.length === k - 1 || `the bottom seed plays ${bottomRows.length} of the ${k - 1} matches it must win`;
    },
  },
  {
    says: "the post's Page playoff story holds: the player it names as losing Qualifier 1 is that match's loser and the title's winner, and the champion won the Final",
    source: "Page playoff system: the Qualifier 1 loser has a second chance in Qualifier 2 (ENG/scheduling/bracket.js:430); the Final's winner is the champion",
    check: (r) => {
      const q1 = byMatch(r, PAGE, "Qualifier 1");
      const fin = byMatch(r, PAGE, "Final");
      if (q1 === undefined || fin === undefined) return "Qualifier 1 or the Final is missing";
      const loser = nameOf(loserOf(q1));
      if (r.facts.pageQ1Loser !== loser) return `the post names ${r.facts.pageQ1Loser} as the Qualifier 1 loser; the table says ${loser}`;
      if (r.facts.pageChampion !== nameOf(fin[C.winner])) return `the post names ${r.facts.pageChampion} as champion; the Final's winner is ${nameOf(fin[C.winner])}`;
      // The example's point: the champion LOST a match on the way (right answer differs from a one-loss knockout's).
      return r.facts.pageChampion === r.facts.pageQ1Loser || `the Qualifier 1 loser (${r.facts.pageQ1Loser}) is not the champion (${r.facts.pageChampion}), so the example cannot show the second chance`;
    },
  },
  {
    says: "the post's stepladder story holds: the bottom seed wins every rung before the final, loses the Final, and is placed 2nd; the top seed is the champion",
    source: "stepladder final (bowling's step-ladder); ENG/scheduling/bracket.js:436-461; the Final's loser is the runner-up (ENG/competition/stage.js bracketRanks title)",
    check: (r) => {
      const rows = series(r, STEP);
      const k = Number(r.facts.stepPlayers);
      const fin = rows[rows.length - 1];
      if (rows.length !== k - 1 || fin === undefined) return `${rows.length} stepladder matches for ${k} players`;
      const bottom = String(r.facts.stepBottom);
      const wins = rows.filter((row) => nameOf(row[C.winner]) === bottom).length;
      if (r.facts.stepBottomWins !== wins) return `the post says ${r.facts.stepBottomWins} wins; the table has ${wins}`;
      if (wins !== k - 2) return `${wins} wins, but the rungs before the Final number ${k - 2}`;
      if (nameOf(fin[C.winner]) === bottom) return "the bottom seed won the Final, so the example cannot show the climb ending";
      return (fin[C.loserPlace] === "2nd" && r.facts.stepBottomPlace === "2nd" && nameOf(fin[C.winner]) === r.facts.stepTop && r.facts.stepChampion === r.facts.stepTop) ||
        `Final loser placed ${fin[C.loserPlace]}, fact ${r.facts.stepBottomPlace}, champion ${r.facts.stepChampion}`;
    },
  },
  {
    says: "the figure draws both series: Qualifier 2 is fed by the Qualifier 1 loser (a dashed line) and the Eliminator winner, and each stepladder rung is fed by the winner of the rung before it",
    source: "Page playoff system and stepladder final; ENG/scheduling/bracket.js:419-461",
    check: (r) => {
      const matches = r.diagram?.kind === "bracket" ? r.diagram.rounds.flatMap((x) => x.matches) : [];
      if (matches.length === 0) return "no bracket diagram";
      const lane = (name: string) => matches.filter((m) => m.lane === name);
      const find = (name: string, label: string) => lane(name).find((m) => m.label === label);
      const q1 = find(PAGE, "Qualifier 1");
      const q2 = find(PAGE, "Qualifier 2");
      const el = find(PAGE, "Eliminator");
      if (q1 === undefined || q2 === undefined || el === undefined) return "a Page playoff match is not drawn";
      const feeds = [q2.homeFrom, q2.awayFrom];
      const loserFeed = feeds.find((f) => f?.side === "loser");
      const winnerFeed = feeds.find((f) => f?.side === "winner");
      if (loserFeed?.id !== q1.id || winnerFeed?.id !== el.id) return "Qualifier 2 is not fed by the Qualifier 1 loser and the Eliminator winner";
      const rungs = lane(STEP);
      if (rungs.length !== Number(r.facts.stepMatches)) return `${rungs.length} stepladder matches drawn, ${r.facts.stepMatches} played`;
      const chained = rungs.slice(1).every((m, i) => [m.homeFrom, m.awayFrom].some((f) => f?.side === "winner" && f.id === rungs[i]!.id));
      return chained || "a stepladder rung is not fed by the winner of the rung before it";
    },
  },
  {
    says: "both finals series are offered to a new division of every sport in the registry (the draws read no sport)",
    source: "templatesForSport (WEB/lib/format-templates.ts: group_playoffs, group_stepladder) over forEachSport",
    check: (r) =>
      (r.facts.sportCount === builtinModules.length && r.facts.sportsOfferedPage === builtinModules.length && r.facts.sportsOfferedStep === builtinModules.length) ||
      `page ${r.facts.sportsOfferedPage}, stepladder ${r.facts.sportsOfferedStep} of ${r.facts.sportCount}`,
  },
];

export const pagePlayoffAndStepladder: BlogExample = {
  id: PAGE_STEPLADDER_ID,
  kind: "engine",
  sports: "all",
  build,
  claims,
};
