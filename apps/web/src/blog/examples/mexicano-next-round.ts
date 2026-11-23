// Post #23, "How does mexicano choose each next round?". Eight players on the mexicano template's courts. Round one is
// drawn with everybody on zero; its two matches are scored through the app's own read fold (`foldFrom`, so the stored
// state is what a real fixture stores), and each player's personal points are read off that state the way the app's
// generator reads them (usecases/stages/generators.ts: the pair's `state.score` side, summed per person). Round two is
// then drawn by the engine's mexicano pairing (`pairMexicanoRound`, the generator's own call).
//
// ONE SPORT, "any other sport" (generic): personal points are the score a pair posted, read from `state.score`, and the
// generic result card is the only scoring that stores one. In badminton, table tennis, tennis and carrom the division
// page's score boxes post that card and are refused ("unknown event type"), and on every sport the page offers no way to
// draw round two once round one is scored (driven on the shared env; both under "Found, not fixed").
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

const PLAYERS = ["Ana", "Ben", "Cy", "Dev", "Eli", "Fay", "Gus", "Hal"] as const;
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
  const module = generic();
  const variant = startingVariantKey(module);
  const cfg = declaredCfgs(module).find((c) => c.name === variant)!.cfg;
  const catalog = resolvePositions(module, cfg);
  const lineups = { home: lineupFromCatalog(catalog, home), away: lineupFromCatalog(catalog, away) };
  const at = "2026-11-01T10:00:00.000Z";
  const envelopes: EventEnvelope[] = [
    { id: `mx-${n}-1`, fixtureId: `mx-${n}`, seq: 1, type: "core.start", payload: {}, recordedAt: at, recordedBy: null },
    { id: `mx-${n}-2`, fixtureId: `mx-${n}`, seq: 2, type: "generic.result", payload: { p1Score, p2Score }, recordedAt: at, recordedBy: null },
  ];
  const folded = foldFrom(`blog-example:mexicano:${n}`, { sportKey: module.key, module, cfg, lineups, envelopes, stageKind: "league" } as never);
  const score = (folded.state as { score?: { home?: unknown; away?: unknown } | null }).score;
  if (typeof score?.home !== "number" || typeof score.away !== "number") throw new Error("mexicano-next-round: the generic fold stored no score");
  if (folded.outcome === null) throw new Error("mexicano-next-round: the round-one match is not decided");
  return { home: score.home, away: score.away };
}

const pairWords = (p: readonly string[]) => `${p[0]} and ${p[1]}`;

function build(): ExampleResult {
  const courtCount = mexicanoCourts();
  const zero = PLAYERS.map((p) => ({ playerId: p, points: 0 }));
  const one = pairMexicanoRound(zero, { courtCount }, 1);

  const points = new Map<string, number>(PLAYERS.map((p) => [p, 0]));
  const partnerOne = new Map<string, string>();
  const courtOne = new Map<string, number>();
  one.matches.forEach((m, i) => {
    const [p1, p2] = ROUND_ONE_SCORES[i]!;
    const s = scoreOf(m.team1.join("+"), m.team2.join("+"), p1, p2, i + 1);
    for (const p of m.team1) points.set(p, points.get(p)! + s.home);
    for (const p of m.team2) points.set(p, points.get(p)! + s.away);
    for (const side of [m.team1, m.team2]) {
      partnerOne.set(side[0], side[1]);
      partnerOne.set(side[1], side[0]);
      courtOne.set(side[0], m.court);
      courtOne.set(side[1], m.court);
    }
  });

  const two = pairMexicanoRound(PLAYERS.map((p) => ({ playerId: p, points: points.get(p)! })), { courtCount }, 2);
  const partnerTwo = new Map<string, string>();
  const courtTwo = new Map<string, number>();
  for (const m of two.matches)
    for (const side of [m.team1, m.team2]) {
      partnerTwo.set(side[0], side[1]);
      partnerTwo.set(side[1], side[0]);
      courtTwo.set(side[0], m.court);
      courtTwo.set(side[1], m.court);
    }

  const ranked = [...PLAYERS].sort((a, b) => points.get(b)! - points.get(a)! || a.localeCompare(b));
  const top = two.matches[0]!;
  const bottom = two.matches[two.matches.length - 1]!;
  return {
    facts: {
      players: PLAYERS.length,
      courts: courtCount,
      leader: ranked[0]!,
      leaderPoints: points.get(ranked[0]!)!,
      leaderPartnerOne: partnerOne.get(ranked[0]!)!,
      second: ranked[1]!,
      fourth: ranked[3]!,
      fifth: ranked[4]!,
      last: ranked[ranked.length - 1]!,
      lastPoints: points.get(ranked[ranked.length - 1]!)!,
      topCourtMatch: `${pairWords(top.team1)} against ${pairWords(top.team2)}`,
      bottomCourtMatch: `${pairWords(bottom.team1)} against ${pairWords(bottom.team2)}`,
      roundOneFirstMatch: `${pairWords(one.matches[0]!.team1)} against ${pairWords(one.matches[0]!.team2)}`,
      roundOneFirstScore: `${ROUND_ONE_SCORES[0]![0]}-${ROUND_ONE_SCORES[0]![1]}`,
    },
    table: {
      caption: `${PLAYERS.length} players on ${courtCount} courts. Round one is drawn with everyone on zero; round two is drawn from the points each player's pair scored in round one.`,
      columns: ["Player", "Round 1 partner", "Points after round 1", "Round 2 court", "Round 2 partner"],
      rows: ranked.map((p) => [p, partnerOne.get(p)!, points.get(p)!, `Court ${courtTwo.get(p)!}`, partnerTwo.get(p)!]),
    },
    text: [`Round one court ${courtOne.get(PLAYERS[0])}: ${ROUND_ONE_SCORES.map((s) => s.join("-")).join(", ")}`],
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

const claims: Claim[] = [
  {
    says: "a player's points after round one are the score their pair posted, so two partners always share a total",
    source: "mexicano rule: personal points are the pair's game score (usecases/stages/generators.ts personal-points read)",
    check(r) {
      const rows = rowsOf(r);
      if (typeof rows === "string") return rows;
      const by = new Map(rows.map((x) => [x.player, x]));
      const typed = new Set(ROUND_ONE_SCORES.flat());
      for (const x of rows) {
        if (by.get(x.partnerOne)?.points !== x.points) return `${x.player} and ${x.partnerOne} differ`;
        if (!typed.has(x.points)) return `${x.player}'s ${x.points} is no score a pair posted`;
      }
      return true;
    },
  },
  {
    says: "round two puts the four players with the most points on court 1 and the four with the fewest on the last court",
    source: "mexicano rule: re-rank by points each round, quartets by rank (engine americano.js pairMexicanoRound)",
    check(r) {
      const rows = rowsOf(r);
      if (typeof rows === "string") return rows;
      const sorted = [...rows].sort((a, b) => b.points - a.points);
      const top = new Set(sorted.slice(0, 4).map((x) => x.player));
      const courtOf = (x: Row) => x.court;
      if (top.size !== 4) return "no top four";
      for (const x of rows) if ((courtOf(x) === 1) !== top.has(x.player)) return `${x.player} (${x.points}) is on court ${x.court}`;
      return sorted[3]!.points > sorted[4]!.points || "anti-vacuity: the fixture must separate the top four by points";
    },
  },
  {
    says: "on each court the first-ranked player partners the fourth, and the second the third, so round one's leading pair is split up",
    source: "mexicano rule: 1+4 against 2+3 inside each quartet (engine americano.js quartets)",
    check(r) {
      const rows = rowsOf(r);
      if (typeof rows === "string") return rows;
      const sorted = [...rows].sort((a, b) => b.points - a.points || a.player.localeCompare(b.player));
      for (let q = 0; q < sorted.length; q += 4) {
        const [a, b, c, d] = sorted.slice(q, q + 4) as [Row, Row, Row, Row];
        if (a.partnerTwo !== d.player || b.partnerTwo !== c.player) return `quartet ${q / 4 + 1}: ${a.player}+${a.partnerTwo}, ${b.player}+${b.partnerTwo}`;
      }
      const leader = sorted[0]!;
      if (r.facts.leader !== leader.player) return "the leader fact is not the top row";
      return leader.partnerTwo !== leader.partnerOne || "the leader kept their round-one partner";
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
    "personal points are the score a pair posts, and only the 'any other sport' result card stores one; elsewhere every player stays on zero (Found, not fixed)",
  build,
  claims,
};
