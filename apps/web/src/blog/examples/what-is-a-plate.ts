// Post #21, "What is a plate competition, and who plays in it?". A seven-player main draw, drawn by the app (`generate`
// through `appDraw`) and played to its end, with results chosen to show every way into, and out of, the plate: two players
// lose their round-one match; the top seed, whose first match is in round two (a bye), loses it; one player loses round one
// by walkover (they did not play), and the player who WON that walkover has not played either, so their first match is the
// next one, which they LOSE (so the plate gains a player the walkover reading would have left out); the rest win their first
// match and lose later or not at all. The plate's field is the engine's `firstLossField`, the reading the app's plate draw is
// built on (`plateFieldOf`, server/usecases/plate-field.ts). The figure is the main draw as played, each plate player tagged.
//
// WHAT CHECKS IT: the claims check the field against the plate's rule (every player's FIRST real match, lost by play; a
// bye holder's first match is in round two; a walkover is no match, and a walkover WON is no first match either), the post's
// two name lists, the figure's tags, the format's own declaration (the plate stage of the Knockout + plate template takes
// first losses, with no count), and the registry's size. None reads `build()`.
import { builtinModules } from "@seazn/engine/sports";
import { firstLossField } from "@seazn/engine/competition";
import { STAGE_TEMPLATES } from "@/lib/format-templates";
import { appDraw, betterSeedWins, bracketModel, offeredSweep, playBracket, type Pick } from "./bracket-play-b4";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const PLATE_ID = "what-is-a-plate";

const PLAYERS = ["Ana", "Ben", "Cy", "Dev", "Eli", "Fay", "Gus"] as const;
const SEEDS = new Map<string, number>(PLAYERS.map((p, i) => [p, i + 1]));
const COLUMNS = ["Player (seed)", "First match", "First match result", "Later", "In the plate?"];
const C = { player: 0, first: 1, result: 2, later: 3, plate: 4 } as const;
export const RESULT = { won: "Won", lost: "Lost", walkedOver: "Did not play: lost by walkover" } as const;
export const LATER = { lost: "Lost a later match", out: "Out", champion: "Won the draw" } as const;
const YES = "Yes";
const NO = "No";

/** The 5 seed beats the 4 seed and then the top seed; the 6 seed does not turn up against the 3 seed, who then LOSES to the
 *  2 seed (the better seed); otherwise the better seed wins, so the 2 seed beats the 5 seed in the final. */
const pick: Pick = (home, away, f) => {
  if ((home === "Cy" && away === "Fay") || (home === "Fay" && away === "Cy")) return { forfeitedBy: "Fay" };
  return betterSeedWins(SEEDS, { "Dev|Eli": "Eli", "Ana|Eli": "Eli" })(home, away, f);
};

function build(): ExampleResult {
  const draw = appDraw("knockout", {}, PLAYERS, SEEDS);
  if ("refused" in draw) throw new Error("what-is-a-plate: the main draw was refused");
  // The main draw is played to its end; the plate's field is the engine's reading of its rows (known after round two).
  const lines = playBracket("knockout", draw, pick);
  const names = new Map(lines.map((l) => [l.gen.id, l.roundName]));
  const field = firstLossField(lines.map((l) => l.row));
  if (!field.complete) throw new Error("what-is-a-plate: the field is still open after round two");
  const inPlate = new Set(field.losers.map((l) => l.entrantId));

  const rows = PLAYERS.map((p) => {
    const mine = lines.filter((l) => l.row.home === p || l.row.away === p);
    // A first match is a played one, or a walkover the player LOST: a bye and a walkover won put off the first match to
    // the next round (first-loss.js:7-9).
    const real = mine.filter((l) => l.gen.award === undefined && !(l.row.status === "walkover" && l.row.winner === p));
    const first = real[0]!;
    const r = first.row;
    const result = r.status === "walkover" ? RESULT.walkedOver : r.winner === p ? RESULT.won : RESULT.lost;
    const later = r.winner === p ? (real.slice(1).some((l) => l.row.loser === p) ? LATER.lost : LATER.champion) : LATER.out;
    return [`${p} (${SEEDS.get(p)})`, names.get(first.gen.id)!, result, later, inPlate.has(p) ? YES : NO];
  });
  const offered = offeredSweep("ko_plate");
  const byeHolder = PLAYERS.find((p) => lines.some((l) => l.gen.award === p))!;
  const walkover = lines.find((l) => l.row.walkedOver === "loser")!;
  const walkoverWinner = walkover.row.winner!;
  const winnersFirst = lines.filter((l) => (l.row.home === walkoverWinner || l.row.away === walkoverWinner) && l.gen.award === undefined && l.row.walkedOver === undefined)[0]!;
  const seat = (p: string) => `${p} (${SEEDS.get(p)})`;
  const firstLossLine = new Map(field.losers.map((l) => [l.fixtureId, l.entrantId]));
  const names2 = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  const diagram = bracketModel(
    `${names2([...inPlate])} lost their first real match, so they go to the plate. ${names2(field.excluded.map((l) => l.entrantId))} lost by walkover without playing, so ${names2(field.excluded.map((l) => l.entrantId))} ${field.excluded.length === 1 ? "does" : "do"} not. ${walkoverWinner} won that walkover, so ${walkoverWinner}'s first match was the next one, and losing it puts ${walkoverWinner} in the plate too.`,
    lines,
    {
      seatName: seat,
      tags: (l) => {
        const out: Record<string, string> = {};
        if (l.row.walkedOver === "loser" && l.row.loser !== undefined) out[l.row.loser] = "w/o";
        const first = firstLossLine.get(l.gen.id);
        if (first !== undefined && l.row.loser === first) out[first] = "plate";
        return out;
      },
    },
  );

  return {
    facts: {
      players: PLAYERS.length,
      plateSize: inPlate.size,
      plateNames: [...inPlate].join(", "),
      excludedNames: field.excluded.map((l) => l.entrantId).join(", "),
      byeHolder,
      walkoverWinner,
      walkoverWinnerRound: names.get(winnersFirst.gen.id)!,
      sportsOffered: offered.offered.length,
      sportCount: offered.visited,
    },
    table: {
      caption: "A seven-player main draw, played to the end. The plate takes every player who lost their first real match. The top seed had a bye, so their first match was in round two; a player who did not turn up is left out, and the player who won that walkover plays their first match in round two.",
      columns: COLUMNS,
      rows,
    },
    diagram,
    text: [`The plate's field is ${[...inPlate].join(", ")}.`],
  };
}

const rowsWhere = (r: ExampleResult, f: (row: (string | number)[]) => boolean) => r.table?.rows.filter(f) ?? [];

const claims: Claim[] = [
  {
    says: "a player is in the plate exactly when they lost their first real match by playing it",
    source: "plate rule: everyone's first loss, a forfeit left out (ENG/competition/first-loss.js:1-9, owner rulings RB4-P1, RB4-P2)",
    check: (r) => {
      const rows = r.table?.rows ?? [];
      if (rows.length === 0) return "no rows";
      const wrong = rows.filter((row) => (row[C.result] === RESULT.lost) !== (row[C.plate] === YES)).map((row) => row[C.player]);
      if (wrong.length > 0) return `wrong: ${wrong.join(", ")}`;
      return rowsWhere(r, (row) => row[C.plate] === YES).length === r.facts.plateSize || `plate size ${r.facts.plateSize}`;
    },
  },
  {
    says: "a player with a bye plays their first match in round two, and losing it puts them in the plate (a round-one-losers-only plate would leave them out)",
    source: "ENG/competition/first-loss.js:1-9 (RB4-P1: a bye holder who loses their first match, in round 2)",
    check: (r) => {
      const bye = rowsWhere(r, (row) => String(row[C.player]).startsWith(`${r.facts.byeHolder} (`))[0];
      if (bye === undefined) return "the bye holder is missing";
      // Round one is the round most players start in (every player without a bye who played it).
      const counts = new Map<unknown, number>();
      for (const row of r.table?.rows ?? []) counts.set(row[C.first], (counts.get(row[C.first]) ?? 0) + 1);
      const roundOne = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (bye[C.first] === roundOne) return `the bye holder's first match (${bye[C.first]}) is a round-one match`;
      return (bye[C.result] === RESULT.lost && bye[C.plate] === YES) || `bye holder: ${bye[C.result]}, plate ${bye[C.plate]}`;
    },
  },
  {
    says: "a first match lost by walkover is not a match, so that player is not in the plate",
    source: "ENG/competition/first-loss.js:3-4 (RB4-P2: a first loss by walkover, withdrawal or retirement is left out)",
    check: (r) => {
      const wo = rowsWhere(r, (row) => row[C.result] === RESULT.walkedOver);
      if (wo.length === 0) return "the example has no walkover, so it cannot show the rule";
      return wo.every((row) => row[C.plate] === NO) || `a walkover loser is in the plate`;
    },
  },
  {
    says: "a player who won their first match and lost later is not in the plate",
    source: "ENG/competition/first-loss.js:6-9 (only the first match counts)",
    check: (r) => {
      const later = rowsWhere(r, (row) => row[C.later] === LATER.lost);
      if (later.length === 0) return "nobody lost a later match, so the example cannot show the rule";
      return later.every((row) => row[C.plate] === NO) || "a later loser is in the plate";
    },
  },
  {
    says: "a player who WON a first-round walkover has not played yet: their first match is the next round's, and losing it puts them in the plate (a plate that counted the walkover win as a first match would leave them out)",
    source: "ENG/competition/first-loss.js:6-9, 84-92 (a bye or a walkover win puts the first match off to round 2; RB4-P1)",
    check: (r) => {
      const won = rowsWhere(r, (row) => String(row[C.player]).startsWith(`${r.facts.walkoverWinner} (`))[0];
      const walked = rowsWhere(r, (row) => row[C.result] === RESULT.walkedOver)[0];
      if (won === undefined || walked === undefined) return "the walkover's winner or loser is missing from the table";
      // Their first match is NOT the round the walkover was played in...
      if (won[C.first] === walked[C.first]) return `the walkover winner's first match (${won[C.first]}) is the walkover's round`;
      if (won[C.first] !== r.facts.walkoverWinnerRound) return `the post says the first match was the ${r.facts.walkoverWinnerRound}; the table says ${won[C.first]}`;
      // ...and the right answer differs from the wrong reading: a walkover win counted as a first match would make this player "won, so not in the plate".
      return (won[C.result] === RESULT.lost && won[C.plate] === YES) || `walkover winner: ${won[C.result]}, plate ${won[C.plate]}`;
    },
  },
  {
    says: "the two name lists the post prints are the table's: the plate is exactly the players marked in, and the left-out names are exactly the walkover losers",
    source: "ENG/competition/first-loss.js:1-9 (losers and excluded of firstLossField)",
    check: (r) => {
      const inPlate = rowsWhere(r, (row) => row[C.plate] === YES).map((row) => String(row[C.player]).replace(/ \(\d+\)$/, "")).sort();
      const left = rowsWhere(r, (row) => row[C.result] === RESULT.walkedOver).map((row) => String(row[C.player]).replace(/ \(\d+\)$/, "")).sort();
      if (inPlate.length === 0 || left.length === 0) return "the example has no plate or no walkover loser, so the lists say nothing";
      const named = String(r.facts.plateNames).split(", ").sort();
      const excluded = String(r.facts.excludedNames).split(", ").sort();
      return (JSON.stringify(named) === JSON.stringify(inPlate) && JSON.stringify(excluded) === JSON.stringify(left)) || `plateNames ${named.join(", ")} vs table ${inPlate.join(", ")}; excludedNames ${excluded.join(", ")} vs table ${left.join(", ")}`;
    },
  },
  {
    says: "the figure tags exactly the plate players with 'plate' (on the match they lost) and the walkover loser with 'w/o', and shows the top seed's bye",
    source: "ENG/competition/first-loss.js:1-9",
    check: (r) => {
      const matches = r.diagram?.kind === "bracket" ? r.diagram.rounds.flatMap((x) => x.matches) : [];
      if (matches.length === 0) return "no bracket diagram";
      const tagged = (tag: string) => matches.flatMap((m) => Object.entries(m.tags ?? {}).filter(([, t]) => t === tag).map(([seat]) => seat.replace(/ \(\d+\)$/, ""))).sort();
      const inPlate = rowsWhere(r, (row) => row[C.plate] === YES).map((row) => String(row[C.player]).replace(/ \(\d+\)$/, "")).sort();
      if (JSON.stringify(tagged("plate")) !== JSON.stringify(inPlate)) return `figure tags ${tagged("plate").join(", ")} as plate; the table has ${inPlate.join(", ")}`;
      if (JSON.stringify(tagged("w/o")) !== JSON.stringify(String(r.facts.excludedNames).split(", ").sort())) return `figure tags ${tagged("w/o").join(", ")} as walkover losers`;
      // A tag sits on the seat that LOST the match it is drawn in.
      const tagOnLoser = matches.every((m) => Object.keys(m.tags ?? {}).every((seat) => m.winner !== seat && (m.home === seat || m.away === seat)));
      const bye = matches.some((m) => m.away === null && m.home !== null && m.home.startsWith(`${r.facts.byeHolder} (`));
      return (tagOnLoser && bye) || (tagOnLoser ? "the bye holder's bye is not drawn" : "a tag is on a seat that won its match");
    },
  },
  {
    says: "the Knockout + plate format's plate stage takes every first loss, with no count",
    source: "STAGE_TEMPLATES ko_plate (WEB/lib/format-templates.ts:275-292, X-PL-6)",
    check: (r) => {
      const t = STAGE_TEMPLATES.find((x) => x.key === "ko_plate");
      if (t === undefined) return "no ko_plate template";
      const stages = t.build({ qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 });
      const take = stages[1]?.progression?.sources[0]?.take ?? [];
      if (!(take.length === 1 && take[0]!.kind === "firstLosses" && !("count" in take[0]!))) return `plate takes ${JSON.stringify(take)}`;
      return Number(r.facts.plateSize) > 0 || "an empty plate";
    },
  },
  {
    says: "the plate is offered to a new division of every sport in the registry (the field reads no sport)",
    source: "templatesForSport (WEB/lib/format-templates.ts: ko_plate) over forEachSport",
    check: (r) => (r.facts.sportCount === builtinModules.length && r.facts.sportsOffered === builtinModules.length) || `${r.facts.sportsOffered} of ${r.facts.sportCount}`,
  },
];

export const whatIsAPlate: BlogExample = {
  id: PLATE_ID,
  kind: "engine",
  sports: "all",
  build,
  claims,
};
