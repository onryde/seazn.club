// Post #23, "How does mexicano choose each next round?". Eight players on the mexicano template's courts. Round one is
// drawn with everybody on zero; its two matches are scored through the app's own read fold (`foldFrom`, so the stored
// state is what a real fixture stores), and each player's personal points are read off that state the way the app's
// generator reads them (usecases/stages/generators.ts: the pair's `state.score` side, summed per person). Round two is
// then drawn by the engine's mexicano pairing (`pairMexicanoRound`, the generator's own call).
//
// ONE SPORT, "Any other game" (generic): personal points are the score a pair posted, read from `state.score`, and the
// generic result card is the only scoring that stores one. In badminton, table tennis, tennis and carrom the division
// page's score boxes post that card and are refused ("unknown event type"), and on every sport the page offers no way to
// draw round two once round one is scored (driven on the shared env; both under "Found, not fixed").
//
// IDS (fix round 1, M1). The engine orders players by points, then by PLAYER ID (`pairMexicanoRound`; the app hands it the
// person ids). The players here carry ids that do NOT sort like their names or their seeds (`ID_OF`), so round one is not
// the seed order and the example shows what a reader is told: Seazn's own order, not the seeds. The ids never reach the page.
//
// WHAT CHECKS IT. The claims rank the players again from the table's own points with their own sort, and compare round two
// to the engine's fixed rotation (americano), which a mexicano must NOT reproduce.
import type { EventEnvelope } from "@seazn/engine/core";
import { generateAmericano, pairMexicanoRound } from "@seazn/engine/scheduling";
import { resolvePositions } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { declaredCfgs, lineupFromCatalog } from "@seazn/engine/testkit";
import { buildTemplateStages } from "@/lib/format-templates";
import { foldFrom } from "@/server/engine-db/fold";
import { startingVariantKey } from "./starting-variant";
import type { Claim, EngineExample, ExampleResult } from "./types";

export const MEXICANO_NEXT_ROUND_ID = "mexicano-next-round";

/** Fictional players in SEED order (the order a division lists them). */
const PLAYERS = ["Ana", "Ben", "Cy", "Dev", "Eli", "Fay", "Gus", "Hal"] as const;
/** The id each player carries: sorted, it is Dev, Fay, Ben, Hal, Ana, Eli, Gus, Cy, which is neither the seeds nor the names. */
const ID_OF: Readonly<Record<(typeof PLAYERS)[number], string>> = { Ana: "p5", Ben: "p3", Cy: "p8", Dev: "p1", Eli: "p6", Fay: "p2", Gus: "p7", Hal: "p4" };
const NAME_OF = new Map<string, string>(PLAYERS.map((p) => [ID_OF[p], p]));
const byId = (a: string, b: string) => (ID_OF[a as (typeof PLAYERS)[number]]! < ID_OF[b as (typeof PLAYERS)[number]]! ? -1 : 1);
/** Round one's typed scores, court by court: [first pair, second pair]. Every pair ends on a different total. */
const ROUND_ONE_SCORES: readonly (readonly [number, number])[] = [
  [24, 20],
  [17, 21],
];
const KNOBS = { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 } as const;

function mexicanoCourts(): number {
  const [stage] = buildTemplateStages("mexicano", KNOBS);
  const cfg = (stage?.config ?? {}) as { mode?: unknown; courtCount?: unknown };
  if (stage?.kind !== "americano" || cfg.mode !== "mexicano" || typeof cfg.courtCount !== "number") {
    throw new Error("mexicano-next-round: the mexicano template no longer declares a mexicano stage with courts");
  }
  return cfg.courtCount;
}

const generic = () => builtinModules.find((m) => m.key === "generic")!;

/** One generic match scored as the console records it (start, then the result card), folded by the app's read fold;
 *  returns the score the stored state holds, the field the generator sums. */
function scoreOf(home: string, away: string, p1Score: number, p2Score: number, n: number): { home: number; away: number } {
  const sport = generic();
  const variant = startingVariantKey(sport);
  const cfg = declaredCfgs(sport).find((c) => c.name === variant)!.cfg;
  const catalog = resolvePositions(sport, cfg);
  const lineups = { home: lineupFromCatalog(catalog, home), away: lineupFromCatalog(catalog, away) };
  const at = "2026-11-01T10:00:00.000Z";
  const envelopes: EventEnvelope[] = [
    { id: `mx-${n}-1`, fixtureId: `mx-${n}`, seq: 1, type: "core.start", payload: {}, recordedAt: at, recordedBy: null },
    { id: `mx-${n}-2`, fixtureId: `mx-${n}`, seq: 2, type: "generic.result", payload: { p1Score, p2Score }, recordedAt: at, recordedBy: null },
  ];
  const folded = foldFrom(`blog-example:mexicano:${n}`, { sportKey: sport.key, module: sport, cfg, lineups, envelopes, stageKind: "league" } as never);
  const score = (folded.state as { score?: { home?: unknown; away?: unknown } | null }).score;
  if (typeof score?.home !== "number" || typeof score.away !== "number") throw new Error("mexicano-next-round: the generic fold stored no score");
  if (folded.outcome === null) throw new Error("mexicano-next-round: the round-one match is not decided");
  return { home: score.home, away: score.away };
}

/** A pair of ids as the names a reader sees ("Dev and Hal"). */
const pairWords = (p: readonly string[]) => `${NAME_OF.get(p[0]!)} and ${NAME_OF.get(p[1]!)}`;
const matchWords = (m: { team1: readonly string[]; team2: readonly string[] }) => `${pairWords(m.team1)} against ${pairWords(m.team2)}`;

function build(): ExampleResult {
  const courtCount = mexicanoCourts();
  const zero = PLAYERS.map((p) => ({ playerId: ID_OF[p], points: 0 }));
  const one = pairMexicanoRound(zero, { courtCount }, 1);

  // Everything below is keyed by NAME, from the engine's id-keyed draw.
  const points = new Map<string, number>(PLAYERS.map((p) => [p, 0]));
  const partnerOne = new Map<string, string>();
  one.matches.forEach((m, i) => {
    const [p1, p2] = ROUND_ONE_SCORES[i]!;
    const s = scoreOf(m.team1.join("+"), m.team2.join("+"), p1, p2, i + 1);
    for (const id of m.team1) points.set(NAME_OF.get(id)!, points.get(NAME_OF.get(id)!)! + s.home);
    for (const id of m.team2) points.set(NAME_OF.get(id)!, points.get(NAME_OF.get(id)!)! + s.away);
    for (const side of [m.team1, m.team2]) {
      partnerOne.set(NAME_OF.get(side[0])!, NAME_OF.get(side[1])!);
      partnerOne.set(NAME_OF.get(side[1])!, NAME_OF.get(side[0])!);
    }
  });

  const two = pairMexicanoRound(PLAYERS.map((p) => ({ playerId: ID_OF[p], points: points.get(p)! })), { courtCount }, 2);
  const partnerTwo = new Map<string, string>();
  const courtTwo = new Map<string, number>();
  for (const m of two.matches)
    for (const side of [m.team1, m.team2]) {
      partnerTwo.set(NAME_OF.get(side[0])!, NAME_OF.get(side[1])!);
      partnerTwo.set(NAME_OF.get(side[1])!, NAME_OF.get(side[0])!);
      courtTwo.set(NAME_OF.get(side[0])!, m.court);
      courtTwo.set(NAME_OF.get(side[1])!, m.court);
    }

  // Ranked the way the draw ranks them: points, then the id.
  const ranked = [...PLAYERS].sort((a, b) => points.get(b)! - points.get(a)! || byId(a, b));
  const top = two.matches[0]!;
  const bottom = two.matches[two.matches.length - 1]!;
  return {
    facts: {
      leader: ranked[0]!,
      leaderPoints: points.get(ranked[0]!)!,
      leaderPartnerOne: partnerOne.get(ranked[0]!)!,
      topCourtMatch: matchWords(top),
      bottomCourtMatch: matchWords(bottom),
      roundOneFirstMatch: matchWords(one.matches[0]!),
      roundOneFirstScore: `${ROUND_ONE_SCORES[0]![0]}-${ROUND_ONE_SCORES[0]![1]}`,
    },
    table: {
      caption: `${PLAYERS.length} players on ${courtCount} courts. Round one is drawn with everyone on zero; round two is drawn from the points each player's pair scored in round one. Players level on points are listed in the order the draw uses.`,
      columns: ["Player", "Round 1 partner", "Points after round 1", "Round 2 court", "Round 2 partner"],
      rows: ranked.map((p) => [p, partnerOne.get(p)!, points.get(p)!, `Court ${courtTwo.get(p)!}`, partnerTwo.get(p)!]),
    },
    text: [],
  };
}

// ---- claims: re-rank from the table with their own sort; compare to the fixed rotation a mexicano must not repeat ----

interface Row {
  player: string;
  partnerOne: string;
  points: number;
  court: number;
  partnerTwo: string;
}
function rowsOf(r: ExampleResult): Row[] | string {
  const rows = (r.table?.rows ?? []).map((row) => ({
    player: String(row[0]),
    partnerOne: String(row[1]),
    points: Number(row[2]),
    court: Number(/^Court (\d+)$/.exec(String(row[3]))?.[1] ?? NaN),
    partnerTwo: String(row[4]),
  }));
  if (rows.length !== PLAYERS.length) return `${rows.length} rows, ${PLAYERS.length} players`;
  if (rows.some((x) => Number.isNaN(x.points) || Number.isNaN(x.court))) return "a points or court cell is not a number";
  return rows;
}
/** "A and B against C and D" as two sets of names, or null. */
function sidesOf(text: unknown): [string[], string[]] | null {
  const m = /^(\S+) and (\S+) against (\S+) and (\S+)$/.exec(String(text));
  return m === null ? null : [[m[1]!, m[2]!], [m[3]!, m[4]!]];
}
const sameSides = (a: [string[], string[]] | null, b: [string[], string[]]) =>
  a !== null && ((same(a[0], b[0]) && same(a[1], b[1])) || (same(a[0], b[1]) && same(a[1], b[0])));
const same = (a: readonly string[], b: readonly string[]) => [...a].sort().join("|") === [...b].sort().join("|");
/** The draw's own ranking, recomputed: points high to low, level players in id order. */
const rank = (rows: Row[]) => [...rows].sort((a, b) => b.points - a.points || byId(a.player, b.player));

const claims: Claim[] = [
  {
    says: "a player's points after round one are the score their pair posted, so two partners always share a total, and round one's two scores are the ones the example typed",
    source: "mexicano rule: personal points are the pair's game score (usecases/stages/generators.ts personal-points read)",
    check(r) {
      const rows = rowsOf(r);
      if (typeof rows === "string") return rows;
      const by = new Map(rows.map((x) => [x.player, x]));
      const typed = new Set(ROUND_ONE_SCORES.flat());
      for (const x of rows) {
        if (by.get(x.partnerOne)?.points !== x.points) return `${x.player} and ${x.partnerOne} differ`;
        if (by.get(x.partnerOne)?.partnerOne !== x.player) return `${x.player}'s round-one partner does not partner back`;
        if (!typed.has(x.points)) return `${x.player}'s ${x.points} is no score a pair posted`;
      }
      return [...new Set(rows.map((x) => x.points))].length === ROUND_ONE_SCORES.flat().length || "the four pairs do not hold the four typed scores";
    },
  },
  {
    says: "round one is drawn in the engine's own order, players on zero sorted by player id, one against four and two against three on each court, and it is not the seed order",
    source: "mexicano rule: with nobody on a point, ties fall to the player id (engine americano.js pairMexicanoRound); class 19: the seed order would give another first match",
    check(r) {
      const rows = rowsOf(r);
      if (typeof rows === "string") return rows;
      const ordered = [...PLAYERS].sort(byId);
      const expected: [string[], string[]][] = [];
      for (let q = 0; q < ordered.length; q += 4) expected.push([[ordered[q]!, ordered[q + 3]!], [ordered[q + 1]!, ordered[q + 2]!]]);
      const seedFirst: [string[], string[]] = [[PLAYERS[0], PLAYERS[3]], [PLAYERS[1], PLAYERS[2]]];
      if (sameSides(sidesOf(r.facts.roundOneFirstMatch), seedFirst)) return "round one's first match is the seed order's";
      if (!sameSides(sidesOf(r.facts.roundOneFirstMatch), expected[0]!)) return `the first match is '${String(r.facts.roundOneFirstMatch)}'`;
      // Every row's round-one partner is the draw's, and the first match's two pairs hold the first typed score each way round.
      const partner = new Map<string, string>();
      for (const [a, b] of expected.flat() as [string, string][]) {
        partner.set(a, b);
        partner.set(b, a);
      }
      for (const x of rows) if (partner.get(x.player) !== x.partnerOne) return `${x.player}'s round-one partner is ${x.partnerOne}`;
      const first = sidesOf(r.facts.roundOneFirstMatch)!;
      const pts = (n: string) => rows.find((x) => x.player === n)!.points;
      const [s1, s2] = ROUND_ONE_SCORES[0]!;
      if (r.facts.roundOneFirstScore !== `${s1}-${s2}` || pts(first[0][0]!) !== s1 || pts(first[1][0]!) !== s2) return "round one's first score is not the first match's";
      return true;
    },
  },
  {
    says: "round two puts the four players with the most points on court 1 and the four with the fewest on the last court",
    source: "mexicano rule: re-rank by points each round, quartets by rank (engine americano.js pairMexicanoRound)",
    check(r) {
      const rows = rowsOf(r);
      if (typeof rows === "string") return rows;
      const sorted = rank(rows);
      const courts = Math.floor(rows.length / 4);
      for (const [i, x] of sorted.entries()) if (x.court !== Math.floor(i / 4) + 1) return `${x.player} (${x.points}) is on court ${x.court}`;
      if (JSON.stringify(rows.map((x) => x.player)) !== JSON.stringify(sorted.map((x) => x.player))) return "the table is not ranked as the draw ranks it";
      return (courts >= 2 && sorted[3]!.points > sorted[4]!.points) || "anti-vacuity: the fixture must separate the top four by points";
    },
  },
  {
    says: "on each court the first-ranked player partners the fourth, and the second the third, so round one's leading pair is split up",
    source: "mexicano rule: 1+4 against 2+3 inside each quartet (engine americano.js quartets)",
    check(r) {
      const rows = rowsOf(r);
      if (typeof rows === "string") return rows;
      const sorted = rank(rows);
      for (let q = 0; q < sorted.length; q += 4) {
        const [a, b, c, d] = sorted.slice(q, q + 4) as [Row, Row, Row, Row];
        if (a.partnerTwo !== d.player || b.partnerTwo !== c.player || c.partnerTwo !== b.player || d.partnerTwo !== a.player) return `quartet ${q / 4 + 1}: ${a.player}+${a.partnerTwo}, ${b.player}+${b.partnerTwo}`;
      }
      const leader = sorted[0]!;
      if (r.facts.leader !== leader.player || r.facts.leaderPoints !== leader.points || r.facts.leaderPartnerOne !== leader.partnerOne) return "the leader facts are not the top row";
      return leader.partnerTwo !== leader.partnerOne || "the leader kept their round-one partner";
    },
  },
  {
    says: "the top and the last court's matches in the facts are the table's quartets: first with fourth against second with third",
    source: "mexicano rule: 1+4 against 2+3 inside each quartet; the table recounted with the claim's own ranking",
    check(r) {
      const rows = rowsOf(r);
      if (typeof rows === "string") return rows;
      const sorted = rank(rows);
      const quartet = (q: number): [string[], string[]] => {
        const [a, b, c, d] = sorted.slice(q, q + 4) as [Row, Row, Row, Row];
        return [[a.player, d.player], [b.player, c.player]];
      };
      if (!sameSides(sidesOf(r.facts.topCourtMatch), quartet(0))) return `the top court is '${String(r.facts.topCourtMatch)}'`;
      return sameSides(sidesOf(r.facts.bottomCourtMatch), quartet(sorted.length - 4)) || `the last court is '${String(r.facts.bottomCourtMatch)}'`;
    },
  },
  {
    says: "round two is not the fixed rotation americano would play next: mexicano re-draws from the points",
    source: "class 19 witness: the americano rotation's round two (engine generateAmericano) differs from the drawn one",
    check(r) {
      const rows = rowsOf(r);
      if (typeof rows === "string") return rows;
      const rotation = generateAmericano([...PLAYERS], { mode: "americano", courtCount: mexicanoCourts(), rounds: 2 })[1]!;
      const key = (a: string, b: string) => [a, b].sort().join("+");
      const rotationPairs = new Set(rotation.matches.flatMap((m) => [key(...m.team1), key(...m.team2)]));
      const drawn = new Set(rows.map((x) => key(x.player, x.partnerTwo)));
      return [...drawn].some((p) => !rotationPairs.has(p)) || "round two equals the fixed rotation";
    },
  },
];

export const mexicanoNextRound: EngineExample = {
  id: MEXICANO_NEXT_ROUND_ID,
  kind: "engine",
  sports: ["generic"],
  singleSportReason:
    "personal points are the score a pair posts, and only the 'Any other game' result card stores one; in the other sports the page's score boxes are refused (Found, not fixed)",
  build,
  claims,
};
