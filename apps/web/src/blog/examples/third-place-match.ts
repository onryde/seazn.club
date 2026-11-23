// Post #17, "When is there a third-place match, and who shares third without one?". One eight-player knockout, drawn
// TWICE by the app's own `generate` (server/usecases/stages/generators.ts, the Generate write's producer): once with the
// stage's Third place on Shared, once on Play-off match. The same results are played into both (the better seed wins every
// match, except the third-place match itself, which the lower seed wins, so the play-off visibly moves a place). The places
// are the engine's `bracketRanks`. The app's own refusal of a play-off below four players is asked of `generate` for every
// field from 2 to 8, so the smallest field that can have one comes from the producer, never a typed number.
//
// The figure is the play-off draw as played: every match a box, a solid line for a winner going on, a dashed one for the two
// semi-final losers going to the third-place match. Its feeds are the generator's own.
//
// WHAT CHECKS IT: the claims read the engine's shared-place declaration (`BRACKET_SHARED_RANKS`), the app's size rule
// (`THIRD_PLACE_MIN`), standard competition ranking (a shared 3rd uses up 4th, so the next place is 5th), the app's forfeit
// rule (a forfeit loser never drops to the play-off), the figure's own wiring, and the registry's size. None reads `build()`.
import { BRACKET_SHARED_RANKS } from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import { THIRD_PLACE_MIN } from "@/lib/third-place";
import { msg } from "@/lib/messages";
import { appDraw, betterSeedWins, bracketModel, forfeitOutClaim, offeredSweep, ordinal, placesOf, playBracket } from "./bracket-play-b4";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const THIRD_PLACE_MATCH_ID = "third-place-match";

const PLAYERS = ["Ana", "Ben", "Cy", "Dev", "Eli", "Fay", "Gus", "Hal"] as const;
const SEEDS = new Map<string, number>(PLAYERS.map((p, i) => [p, i + 1]));
const COLUMNS = ["Player (seed)", "Knocked out in", "Place, third shared", "Place, with a third-place match"];
const C = { player: 0, out: 1, shared: 2, playoff: 3 } as const;
const CHAMPION = "Won the final";

const drawn = (players: readonly string[], thirdPlace: boolean) => appDraw("knockout", { thirdPlace }, players, SEEDS);

function build(): ExampleResult {
  return buildFrom(drawn);
}

export function buildFrom(draw: typeof drawn): ExampleResult {
  // The smallest field the app will draw a play-off for: ask every field from 2 to 8.
  const fieldRefusals: Record<number, string | null> = {};
  for (let n = 2; n <= PLAYERS.length; n++) {
    const d = draw(PLAYERS.slice(0, n), true);
    fieldRefusals[n] = "refused" in d ? d.refused : null;
  }
  const smallest = Object.entries(fieldRefusals).find(([, r]) => r === null)?.[0];
  if (smallest === undefined) throw new Error("third-place-match: no field up to 8 draws a play-off");

  const shared = draw(PLAYERS, false);
  const playoff = draw(PLAYERS, true);
  if ("refused" in shared || "refused" in playoff) throw new Error("third-place-match: the eight-player draw was refused");
  // The better seed wins, except the third-place match, which the lower seed takes.
  const thirdPlaceLine = playoff.fixtures.find((f) => f.thirdPlace === true);
  if (thirdPlaceLine === undefined) throw new Error("third-place-match: Play-off match drew no third-place line");
  const pick = betterSeedWins(SEEDS);
  const upsetPick: typeof pick = (home, away, f) =>
    f.thirdPlace === true ? ((SEEDS.get(home)! > SEEDS.get(away)!) ? home : away) : pick(home, away, f);

  const sharedLines = playBracket("knockout", shared, pick);
  const playoffLines = playBracket("knockout", playoff, upsetPick);
  const sharedPlaces = new Map(placesOf("knockout", PLAYERS, SEEDS, sharedLines).map((p) => [p.entrantId, p.rank]));
  const playoffPlaces = new Map(placesOf("knockout", PLAYERS, SEEDS, playoffLines).map((p) => [p.entrantId, p.rank]));

  // Where each player went out, in the bracket with no play-off (the main draw is the same in both).
  const outIn = new Map<string, string>();
  for (const l of sharedLines) if (l.row.loser !== undefined) outIn.set(l.row.loser, l.roundName);
  const rows = PLAYERS.map((p) => [
    `${p} (${SEEDS.get(p)})`,
    outIn.get(p) ?? CHAMPION,
    ordinal(sharedPlaces.get(p)!),
    ordinal(playoffPlaces.get(p)!),
  ]);
  const semiName = sharedLines.find((l) => l.gen.isFinal === true)!;
  const semis = sharedLines.filter((l) => l.gen.round === semiName.gen.round - 1);
  const semiLosers = semis.map((l) => l.row.loser!).sort((a, b) => SEEDS.get(a)! - SEEDS.get(b)!);
  const tp = playoffLines.find((l) => l.gen.thirdPlace === true)!;
  const offered = offeredSweep("knockout");
  const seat = (p: string) => `${p} (${SEEDS.get(p)})`;
  const diagram = bracketModel(
    `With a third-place match, ${tp.row.home} and ${tp.row.away}, who both lost their semi-finals, play each other once more. ${tp.row.winner}, the lower seed, wins it and is placed ${ordinal(playoffPlaces.get(tp.row.winner!)!)}, and ${tp.row.loser} is placed ${ordinal(playoffPlaces.get(tp.row.loser!)!)}. Without the match, both would share ${ordinal(sharedPlaces.get(semiLosers[0]!)!)}.`,
    playoffLines,
    { seatName: seat },
  );

  return {
    facts: {
      semiLoserA: semiLosers[0]!,
      semiLoserB: semiLosers[1]!,
      sharedPlace: ordinal(sharedPlaces.get(semiLosers[0]!)!),
      nextPlaceAfterShared: ordinal(Math.min(...PLAYERS.filter((p) => !semiLosers.includes(p) && sharedPlaces.get(p)! > 2).map((p) => sharedPlaces.get(p)!))),
      playoffWinner: tp.row.winner!,
      playoffWinnerPlace: ordinal(playoffPlaces.get(tp.row.winner!)!),
      playoffLoser: tp.row.loser!,
      playoffLoserPlace: ordinal(playoffPlaces.get(tp.row.loser!)!),
      matchesShared: sharedLines.filter((l) => l.row.status === "decided").length,
      matchesPlayoff: playoffLines.filter((l) => l.row.status === "decided").length,
      smallestPlayoffField: Number(smallest),
      players: PLAYERS.length,
      sportsOffered: offered.offered.length,
      sportCount: offered.visited,
    },
    table: {
      caption: `The same ${PLAYERS.length}-player knockout, played twice with the same results: once with third place shared, once with a third-place match that the lower seed wins.`,
      columns: COLUMNS,
      rows,
    },
    diagram,
    text: [
      `Fields of ${Object.entries(fieldRefusals).filter(([, r]) => r !== null).map(([n]) => n).join(", ")} players are refused a third-place match.`,
      `The third-place match is ${tp.row.home} against ${tp.row.away}.`,
    ],
  };
}

const rowOf = (r: ExampleResult, player: string) => r.table?.rows.find((row) => String(row[C.player]).startsWith(`${player} (`));
const place = (cell: unknown) => (typeof cell === "string" ? Number.parseInt(cell, 10) : Number.NaN);
// The product's own round names (the table's and the figure's labels are `roundRoleLabel`'s, which reads these keys).
const semiName = msg("bracket.round.semi");
const quarterName = msg("bracket.round.quarter");
const finalName = msg("bracket.round.final");
const thirdName = msg("bracket.round.thirdPlace");

const nameOf = (cell: unknown) => String(cell).replace(/ \(\d+\)$/, "");

const claims: Claim[] = [
  forfeitOutClaim(),
  {
    says: "with third place shared, both beaten semi-finalists are placed 3rd, a place the engine declares may be shared",
    source: "BRACKET_SHARED_RANKS (ENG/competition/stage.js:40); bracketRanks third-place block (stage.js:808-822)",
    check: (r) => {
      const semi = r.table?.rows.filter((row) => row[C.out] === semiName) ?? [];
      if (semi.length !== 2) return `expected two semi-final losers, found ${semi.length}`;
      if (!BRACKET_SHARED_RANKS.has(3)) return "the engine no longer declares 3rd a shared place";
      return semi.every((row) => place(row[C.shared]) === 3) || `semi-final losers placed ${semi.map((x) => x[C.shared]).join(", ")}`;
    },
  },
  {
    says: "a shared 3rd uses up 4th: no one is 4th, and the next place is 5th, not 4th (standard competition ranking)",
    source: "standard competition ranking, 1-2-3-3-5; ENG/competition/stage.js:764-767 (X-FR-2)",
    check: (r) => {
      const places = r.table?.rows.map((row) => place(row[C.shared])) ?? [];
      if (places.length === 0) return "no rows";
      if (places.includes(4)) return "someone is 4th although 3rd is shared";
      const after = Math.min(...places.filter((p) => p > 3));
      return (after === 5 && r.facts.nextPlaceAfterShared === "5th") || `next place after the shared 3rd is ${after} (fact ${r.facts.nextPlaceAfterShared})`;
    },
  },
  {
    says: "with a third-place match, every place from 1st to the last is held by exactly one player",
    source: "a knockout with a third-place match ranks 3rd and 4th apart (ENG/competition/stage.js:823-829)",
    check: (r) => {
      const places = (r.table?.rows.map((row) => place(row[C.playoff])) ?? []).sort((a, b) => a - b);
      const want = Array.from({ length: Number(r.facts.players) }, (_, i) => i + 1);
      return (places.length > 0 && JSON.stringify(places) === JSON.stringify(want)) || `places ${places.join(", ")}`;
    },
  },
  {
    says: "the third-place match decides 3rd and 4th by its own result, not by seed: its winner is 3rd and its loser 4th",
    source: "ENG/competition/stage.js:823-829 (a decided play-off gives its winner 3rd and its loser 4th)",
    check: (r) => {
      const w = rowOf(r, String(r.facts.playoffWinner));
      const l = rowOf(r, String(r.facts.playoffLoser));
      if (w === undefined || l === undefined) return "play-off players missing from the table";
      if (place(w[C.playoff]) !== 3 || place(l[C.playoff]) !== 4) return `play-off winner ${w[C.playoff]}, loser ${l[C.playoff]}`;
      // The example's own upset: the play-off's winner is the worse seed, so the right answer differs from seed order.
      const seedOf = (row: (string | number)[]) => Number(/\((\d+)\)/.exec(String(row[C.player]))?.[1]);
      return seedOf(w) > seedOf(l) || "the play-off winner is the better seed, so this example cannot tell result from seed";
    },
  },
  {
    says: "the smallest field that can have a third-place match is the app's declared minimum: two real semi-finals need four players",
    source: "THIRD_PLACE_MIN (WEB/lib/third-place.ts:8); ENG/scheduling/bracket.js:147-155 (third_place_needs_two_semis)",
    check: (r) => r.facts.smallestPlayoffField === THIRD_PLACE_MIN || `smallest field ${r.facts.smallestPlayoffField}, declared ${THIRD_PLACE_MIN}`,
  },
  {
    says: "players knocked out in the same earlier round are not placed level: the better seed is placed higher",
    source: "bracketRanks rankRest: elimination round, then seed (ENG/competition/stage.js:731-741)",
    check: (r) => {
      const qf = (r.table?.rows.filter((row) => row[C.out] === quarterName) ?? []).map((row) => ({
        seed: Number(/\((\d+)\)/.exec(String(row[C.player]))?.[1]),
        at: place(row[C.shared]),
      }));
      if (qf.length !== 4) return `expected four quarter-final losers, found ${qf.length}`;
      const bySeed = [...qf].sort((a, b) => a.seed - b.seed).map((x) => x.at);
      return (new Set(bySeed).size === 4 && bySeed.every((p, i) => i === 0 || p > bySeed[i - 1]!)) || `quarter-final places by seed ${bySeed.join(", ")}`;
    },
  },
  {
    says: "the third-place match adds exactly one match to the draw",
    source: "ENG/scheduling/bracket.js:157-163 (one play-off line, fed by the two semi-final losers)",
    check: (r) => Number(r.facts.matchesPlayoff) - Number(r.facts.matchesShared) === 1 || `${r.facts.matchesShared} and ${r.facts.matchesPlayoff}`,
  },
  {
    says: "the two players the post names as sharing third are the two beaten semi-finalists, placed 3rd, and the same two play the third-place match for 3rd and 4th",
    source: "bracketRanks third-place block (ENG/competition/stage.js:808-829): the play-off is fed by the two semi-final losers; BRACKET_SHARED_RANKS has 3",
    check: (r) => {
      const semi = (r.table?.rows.filter((row) => row[C.out] === semiName) ?? []).map((row) => nameOf(row[C.player])).sort();
      if (semi.length !== 2) return `expected two semi-final losers, found ${semi.length}`;
      const named = [String(r.facts.semiLoserA), String(r.facts.semiLoserB)].sort();
      if (JSON.stringify(named) !== JSON.stringify(semi)) return `the post names ${named.join(", ")}; the semi-final losers are ${semi.join(", ")}`;
      if (r.facts.sharedPlace !== "3rd") return `the shared place is ${r.facts.sharedPlace}`;
      const pair = [String(r.facts.playoffWinner), String(r.facts.playoffLoser)].sort();
      return JSON.stringify(pair) === JSON.stringify(semi) || `the play-off is ${pair.join(" v ")}, not the semi-final losers ${semi.join(" v ")}`;
    },
  },
  {
    says: "the post's play-off places are 3rd for the winner and 4th for the loser, and they agree with the table",
    source: "ENG/competition/stage.js:823-829 (a decided play-off gives its winner 3rd and its loser 4th)",
    check: (r) => {
      if (r.facts.playoffWinnerPlace !== "3rd" || r.facts.playoffLoserPlace !== "4th") return `facts say ${r.facts.playoffWinnerPlace} and ${r.facts.playoffLoserPlace}`;
      const w = rowOf(r, String(r.facts.playoffWinner));
      const l = rowOf(r, String(r.facts.playoffLoser));
      if (w === undefined || l === undefined) return "play-off players missing from the table";
      return (w[C.playoff] === r.facts.playoffWinnerPlace && l[C.playoff] === r.facts.playoffLoserPlace) || `table says ${w[C.playoff]} and ${l[C.playoff]}`;
    },
  },
  {
    says: "the figure draws the third-place match between the two beaten semi-finalists, fed by their losses (a dashed line each), and draws the final from the semi-final winners",
    source: "ENG/scheduling/bracket.js:157-163 (the play-off is fed by the semi-final losers); the final is fed by their winners",
    check: (r) => {
      const matches = r.diagram?.kind === "bracket" ? r.diagram.rounds.flatMap((x) => x.matches) : [];
      if (matches.length === 0) return "no bracket diagram";
      const third = matches.filter((m) => m.label === thirdName);
      if (third.length !== 1) return `${third.length} third-place matches drawn`;
      const final = matches.find((m) => m.label === finalName);
      if (final === undefined) return "no final drawn";
      const feeds = (m: (typeof matches)[number]) => [m.homeFrom, m.awayFrom];
      const fromSemis = (m: (typeof matches)[number], side: "winner" | "loser") =>
        feeds(m).length === 2 && feeds(m).every((f) => f !== undefined && f.side === side && matches.find((x) => x.id === f.id)?.label === semiName);
      if (!fromSemis(third[0]!, "loser")) return "the third-place match is not fed by the two semi-final losers";
      if (!fromSemis(final, "winner")) return "the final is not fed by the two semi-final winners";
      const semiNames = matches.filter((m) => m.label === semiName).flatMap((m) => [m.home, m.away].filter((p) => p !== null && p !== m.winner)).map((p) => nameOf(p)).sort();
      const thirdNames = [third[0]!.home, third[0]!.away].map((p) => nameOf(p)).sort();
      return JSON.stringify(semiNames) === JSON.stringify(thirdNames) || `semi-final losers ${semiNames.join(", ")}, third-place match ${thirdNames.join(", ")}`;
    },
  },
  {
    says: "a knockout is offered to a new division of every sport in the registry (the draw reads no sport)",
    source: "templatesForSport (WEB/lib/format-templates.ts) over forEachSport; the registry (ENG/sports/index.js)",
    check: (r) =>
      (r.facts.sportCount === builtinModules.length && r.facts.sportsOffered === builtinModules.length) ||
      `${r.facts.sportsOffered} of ${r.facts.sportCount} offered, registry ${builtinModules.length}`,
  },
];

export const thirdPlaceMatch: BlogExample = {
  id: THIRD_PLACE_MATCH_ID,
  kind: "engine",
  sports: "all",
  build,
  claims,
};
