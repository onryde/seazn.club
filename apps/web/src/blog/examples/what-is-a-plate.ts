// Post #21, "What is a plate competition, and who plays in it?". A seven-player main draw, drawn by the app (`generate`
// through `appDraw`): the top seed has a bye. Its first two rounds are played with results chosen to show every way into,
// and out of, the plate: two players lose their round-one match; the top seed, whose first match is in round two, loses it;
// one player loses round one by walkover (they did not play); the rest win their first match and lose later or not at all.
// The plate's field is the engine's `firstLossField`, the reading the app's plate draw is built on (`plateFieldOf`,
// server/usecases/plate-field.ts).
//
// WHAT CHECKS IT: the claims check the field against the plate's rule (every player's FIRST real match, lost by play; a
// bye holder's first match is in round two; a walkover is no match), the format's own declaration (the plate stage of the
// Knockout + plate template takes first losses, with no count), and the registry's size. None reads `build()`.
import { builtinModules } from "@seazn/engine/sports";
import { firstLossField } from "@seazn/engine/competition";
import { STAGE_TEMPLATES } from "@/lib/format-templates";
import { appDraw, betterSeedWins, offeredSweep, playBracket, type Pick } from "./bracket-play-b4";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const PLATE_ID = "what-is-a-plate";

const PLAYERS = ["Ana", "Ben", "Cy", "Dev", "Eli", "Fay", "Gus"] as const;
const SEEDS = new Map<string, number>(PLAYERS.map((p, i) => [p, i + 1]));
const COLUMNS = ["Player (seed)", "First match", "First match result", "Later", "In the plate?"];
const C = { player: 0, first: 1, result: 2, later: 3, plate: 4 } as const;
export const RESULT = { won: "Won", lost: "Lost", walkedOver: "Did not play: lost by walkover" } as const;
export const LATER = { lost: "Lost a later match", out: "Out", still: "Still in" } as const;
const YES = "Yes";
const NO = "No";

/** The 5 seed beats the 4 seed and then the top seed; the 6 seed does not turn up against the 3 seed, who then beats the 2
 *  seed; otherwise the better seed wins. */
const pick: Pick = (home, away, f) => {
  if ((home === "Cy" && away === "Fay") || (home === "Fay" && away === "Cy")) return { forfeitedBy: "Fay" };
  return betterSeedWins(SEEDS, { "Dev|Eli": "Eli", "Ana|Eli": "Eli", "Ben|Cy": "Cy" })(home, away, f);
};

function build(): ExampleResult {
  const draw = appDraw("knockout", {}, PLAYERS, SEEDS);
  if ("refused" in draw) throw new Error("what-is-a-plate: the main draw was refused");
  // The plate's field is known after round two: play the first two rounds only.
  const firstTwo = { ...draw, fixtures: draw.fixtures.filter((f) => f.round <= 1) };
  const lines = playBracket("knockout", firstTwo, pick);
  // The round names of the WHOLE draw (round two of seven players is the semi-finals).
  const names = new Map(playBracket("knockout", draw, (h, a, f) => betterSeedWins(SEEDS)(h, a, f)).map((l) => [l.gen.id, l.roundName]));
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
    const later = r.winner === p ? (real.slice(1).some((l) => l.row.loser === p) ? LATER.lost : LATER.still) : LATER.out;
    return [`${p} (${SEEDS.get(p)})`, names.get(first.gen.id)!, result, later, inPlate.has(p) ? YES : NO];
  });
  const offered = offeredSweep("ko_plate");
  const byeHolder = PLAYERS.find((p) => lines.some((l) => l.gen.award === p))!;

  return {
    facts: {
      players: PLAYERS.length,
      plateSize: inPlate.size,
      plateNames: [...inPlate].join(", "),
      excludedNames: field.excluded.map((l) => l.entrantId).join(", "),
      byeHolder,
      sportsOffered: offered.offered.length,
      sportCount: offered.visited,
    },
    table: {
      caption: "A seven-player main draw after its first two rounds. The plate takes every player who lost their first real match. The top seed had a bye, so their first match was in round two; a player who did not turn up is left out.",
      columns: COLUMNS,
      rows,
    },
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
