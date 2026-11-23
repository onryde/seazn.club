// Post #11, second example: "What are Buchholz and Sonneborn-Berger, and why do they decide Swiss ties?" - a round with no game.
//
// THE TABLE, chess: five players play three Swiss rounds, and in each round one of them has the bye (five is odd: somebody
// sits out). The pairings are the fixture (set up for the example, as the table would be after a real draw); every game is a
// real one (a seeded walk refolded by the app's read fold) and every bye is the app's own (`awardByeDelta`, the producer of a
// Swiss bye's table row). Ranked through the app's ranking path for a Swiss stage, as the six-player example is.
//
// Two players, Cy and Dev, finish on the same points with a bye each. Their byes are worth the same (each is read as a game
// against an imaginary opponent on the player's own points), so what separates them is who they really played.
//
// WHAT CHECKS IT. FIDE C.07 article 16 (unplayed rounds), recomputed from the table's own cells: a bye is read as a game
// against a dummy opponent who finished on the same points as the player (16.4) and as a win (a bye awards a win's points,
// 16.3.1); a real opponent counts at its final score. The dummy's score is the player's own as long as it is not above a draw in
// every round (the cap the engine also applies); a guard in the claim refuses an example in which a bye holder is above it, so
// the claim never rests on a cap it does not model. The places follow chess's DECLARED Swiss order (`defaultOrderOf`).
import { resultColumnText } from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import { declaredCfgs, defaultOrderOf } from "@seazn/engine/testkit";
import { standingsLabel } from "@/blog/labels-screens";
import { derivedText } from "@/server/public-site/standings-view";
import { C, COLUMNS, halves, separatedByClaim } from "./buchholz-sonneborn-berger";
import { startingVariantKey } from "./starting-variant";
import { factsRepeatTheTable, placeOf, placeText, playAndRank, rowOf, type MatchView, type Meeting } from "./tie-break-play";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const BUCHHOLZ_BYE_ID = "buchholz-bye";

const PLAYERS = [
  { id: "ana", name: "Ana" },
  { id: "ben", name: "Ben" },
  { id: "cy", name: "Cy" },
  { id: "dev", name: "Dev" },
  { id: "eve", name: "Eve" },
];
const ROUNDS = 3;
const nameOf = (id: string) => PLAYERS.find((p) => p.id === id)!.name;
const homeWins = (v: MatchView) => v.outcome.kind === "win" && v.outcome.winner === v.home.entrantId;
const drawn = (v: MatchView) => v.outcome.kind === "draw";

/** Each round one of the five sits out: Eve, then Dev, then Cy. Nobody meets anyone twice. */
const MEETINGS: Meeting[] = [
  { round: 1, home: "ana", away: "ben", what: "round 1: Ana beats Ben", seed: 5, want: homeWins },
  { round: 1, home: "cy", away: "dev", what: "round 1: Cy draws with Dev", seed: 2, want: drawn },
  { round: 1, home: "eve", away: "", what: "round 1: Eve has the bye", bye: true },
  { round: 2, home: "ana", away: "cy", what: "round 2: Ana beats Cy", seed: 5, want: homeWins },
  { round: 2, home: "ben", away: "eve", what: "round 2: Ben beats Eve", seed: 5, want: homeWins },
  { round: 2, home: "dev", away: "", what: "round 2: Dev has the bye", bye: true },
  { round: 3, home: "ana", away: "eve", what: "round 3: Ana beats Eve", seed: 5, want: homeWins },
  { round: 3, home: "ben", away: "dev", what: "round 3: Ben beats Dev", seed: 5, want: homeWins },
  { round: 3, home: "cy", away: "", what: "round 3: Cy has the bye", bye: true },
];

const chess = () => builtinModules.find((m) => m.key === "boardgame")!;

function gamesText(id: string, ranked: ReturnType<typeof playAndRank>): string {
  const cards: { round: number; text: string }[] = [];
  for (const p of ranked.played) {
    if (p.meeting.home !== id && p.meeting.away !== id) continue;
    const opp = nameOf(p.meeting.home === id ? p.meeting.away : p.meeting.home);
    const o = p.view.outcome;
    cards.push({ round: p.meeting.round ?? 0, text: o.kind === "draw" ? `drew with ${opp}` : o.kind === "win" && o.winner === id ? `beat ${opp}` : `lost to ${opp}` });
  }
  for (const b of ranked.byes) if (b.home === id) cards.push({ round: b.round ?? 0, text: "had a bye" });
  return cards.sort((a, b) => a.round - b.round).map((c) => c.text).join(", ");
}

function build(): ExampleResult {
  const sport = chess();
  const cfg = declaredCfgs(sport).find((c) => c.name === startingVariantKey(sport))!.cfg;
  const ranked = playAndRank({ module: sport, cfg, kind: "swiss", entrants: PLAYERS, meetings: MEETINGS, rounds: ROUNDS });
  if (ranked.byes.length !== ROUNDS || ranked.played.length !== 6) throw new Error("buchholz-bye: the fixture has the wrong rounds");
  const L = ranked.layout;
  const rows = [...ranked.rows]
    .sort((a, b) => a.rank! - b.rank!)
    .map((r) => [
      nameOf(r.entrantId),
      resultColumnText(r, "points", L),
      gamesText(r.entrantId, ranked),
      derivedText(r, "buchholz_cut1", L),
      derivedText(r, "buchholz", L),
      derivedText(r, "sberger", L),
      placeText(r.rank!),
      r.tieBreak === undefined ? "Points" : standingsLabel(r.tieBreak.key, "boardgame"),
    ]);
  const facts: ExampleResult["facts"] = {};
  for (const p of PLAYERS) {
    const r = rowOf(ranked.rows, p.id);
    facts[`${p.id}Points`] = resultColumnText(r, "points", L);
    facts[`${p.id}Cut1`] = derivedText(r, "buchholz_cut1", L);
    facts[`${p.id}Buchholz`] = derivedText(r, "buchholz", L);
    facts[`${p.id}SonnebornBerger`] = derivedText(r, "sberger", L);
    facts[`${p.id}Place`] = placeText(r.rank!);
    facts[`${p.id}Games`] = gamesText(p.id, ranked);
  }
  facts.rounds = ROUNDS;
  facts.players = PLAYERS.length;
  const result: ExampleResult = {
    facts,
    table: { caption: "", columns: COLUMNS, rows },
    text: [
      ...ranked.played.map((p) => `Round ${p.meeting.round}: ${nameOf(p.meeting.home)} ${p.view.headline} ${nameOf(p.meeting.away)}.`),
      ...ranked.byes.map((b) => `Round ${b.round}: ${nameOf(b.home)} has the bye.`),
    ],
  };
  result.table!.caption = captionOf(result);
  return result;
}

/** The caption, said from the table's own cells: the players with a bye who finish level, and what separates them. */
export function captionOf(r: Pick<ExampleResult, "facts" | "table">): string {
  const rows = r.table?.rows ?? [];
  const byeHolders = rows.filter((x) => String(x[C.games]).includes("had a bye"));
  const level = byeHolders.filter((x) => byeHolders.some((y) => y !== x && halves(y[C.points]) === halves(x[C.points])));
  const names = level.map((x) => String(x[C.player]));
  const by = level.find((x) => x[C.by] !== "Points")?.[C.by];
  return `${String(r.facts.players)} players, ${String(r.facts.rounds)} Swiss rounds, one bye in each. ${names.join(" and ")} finish level on ${String(level[0]?.[C.points])} points with a bye each, and ${String(by)} separates them.`;
}

// ---- claims: FIDE C.07 art. 16, from the table's own cells ----

interface Card {
  opp: string | null;
  result: "won" | "drew" | "lost";
}
function cardsOf(x: (string | number)[]): Card[] {
  return String(x[C.games])
    .split(", ")
    .map((g): Card => {
      if (g === "had a bye") return { opp: null, result: "won" };
      const m = g.match(/^(beat|drew with|lost to) (.+)$/);
      if (m === null) throw new Error(`a game reads '${g}'`);
      return { opp: m[2]!, result: m[1] === "beat" ? "won" : m[1] === "drew with" ? "drew" : "lost" };
    });
}

/** The figures under art. 16.3 / 16.4: a bye is a win against a dummy on the player's own points; a real game, the opponent's final score. */
function figures(r: ExampleResult): Map<string, { points: number; cut1: number; buchholz: number; sb: number; naive: number }> | string {
  const rows = r.table?.rows ?? [];
  const points = new Map(rows.map((x) => [String(x[C.player]), halves(x[C.points])]));
  const out = new Map<string, { points: number; cut1: number; buchholz: number; sb: number; naive: number }>();
  for (const x of rows) {
    const own = points.get(String(x[C.player]))!;
    const cards = cardsOf(x);
    // Assumptions are guards: the dummy is on the player's own points only while that is no more than a draw in every round.
    if (cards.some((c) => c.opp === null) && own > 0.5 * ROUNDS) return `${String(x[C.player])} has a bye and ${own} points, above a draw a round (${0.5 * ROUNDS}): the capped rule applies and this claim does not model it`;
    const contributions = cards.map((c) => (c.opp === null ? own : (points.get(c.opp) ?? Number.NaN)));
    const buchholz = contributions.reduce((a, b) => a + b, 0);
    const sb = cards.reduce((a, c, i) => a + (c.result === "won" ? contributions[i]! : c.result === "drew" ? contributions[i]! / 2 : 0), 0);
    const naive = cards.reduce((a, c, i) => a + (c.opp === null ? 0 : contributions[i]!), 0);
    out.set(String(x[C.player]), { points: own, cut1: buchholz - Math.min(...contributions), buchholz, sb, naive });
  }
  return out;
}

const caseClaims: Claim[] = [
  {
    says: "each player's points are their games, a bye counting as a win: a win 1, a draw ½, a loss 0",
    source: "FIDE Laws of Chess (the game score), FIDE C.07 art. 16.3.1 (a bye is evaluated as the points it was awarded) and chess's declared half-point table",
    check(r) {
      for (const x of r.table?.rows ?? []) {
        const want = cardsOf(x).reduce((a, c) => a + (c.result === "won" ? 1 : c.result === "drew" ? 0.5 : 0), 0);
        if (halves(x[C.points]) !== want) return `${String(x[C.player])}: ${String(x[C.points])} points, the games give ${want}`;
      }
      return (r.table?.rows.length ?? 0) === PLAYERS.length || "rows missing";
    },
  },
  {
    says: "every Buchholz, Buchholz Cut-1 and Sonneborn–Berger cell is FIDE's figure with each bye read as a game against a dummy on the player's own points",
    source: "FIDE C.07 art. 16.3 and 16.4 (an unplayed round is evaluated as a game played against a dummy that finished with the same points, the result being the points awarded), over the table's cells",
    check(r) {
      const fide = figures(r);
      if (typeof fide === "string") return fide;
      for (const x of r.table?.rows ?? []) {
        const f = fide.get(String(x[C.player]))!;
        if (halves(x[C.buchholz]) !== f.buchholz) return `${String(x[C.player])}: Buchholz ${String(x[C.buchholz])}, FIDE gives ${f.buchholz}`;
        if (halves(x[C.cut1]) !== f.cut1) return `${String(x[C.player])}: Cut-1 ${String(x[C.cut1])}, FIDE gives ${f.cut1}`;
        const sb = String(x[C.sb]).includes(".") ? Number(x[C.sb]) : halves(x[C.sb]);
        if (Math.abs(sb - f.sb) > 1e-9) return `${String(x[C.player])}: Sonneborn–Berger ${String(x[C.sb])}, FIDE gives ${f.sb}`;
      }
      return true;
    },
  },
  {
    says: "the places follow chess's declared Swiss order: points, Buchholz Cut-1, Buchholz, Sonneborn–Berger",
    source: "defaultOrderOf(boardgame, \"swiss\")",
    check(r) {
      const declared = defaultOrderOf(chess(), "swiss");
      if (declared.slice(0, 4).join() !== "points,buchholz_cut1,buchholz,sberger") return `chess's Swiss order is [${declared.join(", ")}]`;
      const fide = figures(r);
      if (typeof fide === "string") return fide;
      const names = [...fide.keys()].sort((a, b) => {
        const x = fide.get(a)!;
        const y = fide.get(b)!;
        return y.points - x.points || y.cut1 - x.cut1 || y.buchholz - x.buchholz || y.sb - x.sb;
      });
      for (const x of r.table?.rows ?? []) {
        const want = names.indexOf(String(x[C.player])) + 1;
        if (placeOf(x[C.place]) !== want) return `${String(x[C.player])}: ${String(x[C.place])}, the order gives ${want}`;
      }
      return true;
    },
  },
  {
    says: "two players with a bye each finish level on points, and the bye is worth the same to both, so their real opponents separate them; leaving the bye out would change the figure (class 19)",
    source: "the case's premise, read off the table (each of the pair's byes adds the player's own points; the opponents' scores differ)",
    check(r) {
      const fide = figures(r);
      if (typeof fide === "string") return fide;
      const rows = r.table?.rows ?? [];
      const byeHolders = rows.filter((x) => cardsOf(x).some((c) => c.opp === null));
      const pair = byeHolders.filter((x) => byeHolders.some((y) => y !== x && halves(y[C.points]) === halves(x[C.points])));
      if (pair.length !== 2) return `${pair.length} players with a bye share their points`;
      const [a, b] = pair.map((x) => fide.get(String(x[C.player]))!);
      if (a!.cut1 === b!.cut1) return "the pair is level on Cut-1: the example would need the next figure";
      // A reader who skipped the bye round would read a different Buchholz for each, so the cells witness the rule.
      for (const x of pair) {
        const f = fide.get(String(x[C.player]))!;
        if (f.naive === f.buchholz) return `${String(x[C.player])}: ignoring the bye gives the same Buchholz`;
      }
      return true;
    },
  },
  {
    says: "the caption is the one said from the table's own cells and the facts",
    source: "the table's cells and the example's facts (nothing in it is typed)",
    check(r) {
      const want = captionOf(r);
      return r.table?.caption === want || `caption is '${String(r.table?.caption)}', the cells give '${want}'`;
    },
  },
  {
    says: "five players, three rounds: every player has three cards, a bye or a game, and each round has exactly one bye",
    source: "the fixture's three rounds (two boards and a bye)",
    check(r) {
      const rows = r.table?.rows ?? [];
      if (r.facts.players !== rows.length) return `players ${String(r.facts.players)}, rows ${rows.length}`;
      let byes = 0;
      for (const x of rows) {
        const cards = cardsOf(x);
        if (cards.length !== r.facts.rounds) return `${String(x[C.player])} has ${cards.length} cards, rounds is ${String(r.facts.rounds)}`;
        byes += cards.filter((c) => c.opp === null).length;
      }
      return byes === r.facts.rounds || `${byes} byes in ${String(r.facts.rounds)} rounds`;
    },
  },
];

const claims: Claim[] = [
  ...caseClaims,
  separatedByClaim,
  factsRepeatTheTable(PLAYERS, C.player, { Points: C.points, Cut1: C.cut1, Buchholz: C.buchholz, SonnebornBerger: C.sb, Place: C.place, Games: C.games }),
];

export const buchholzBye: BlogExample = {
  id: BUCHHOLZ_BYE_ID,
  kind: "engine",
  sports: ["boardgame"],
  singleSportReason: "chess: Buchholz and Sonneborn-Berger are chess's figures; the per-sport Swiss orders are the six-player example's sweep",
  build,
  claims,
};
