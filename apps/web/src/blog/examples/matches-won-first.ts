// Post #5, "Why does volleyball rank by matches won, not points?". Volleyball, with a sweep of the registry for the sports
// that rank on matches won first and for the sports where that choice can change an order.
//
// WHICH MATCHES: a four-team indoor round robin, six real volleyball matches played to the end through the engine's own
// event stream (kit.ts), each to the set score the table below names, paid by the rules the standings read. The table is
// the engine's own stage fold (`completeTableStage`) run twice over the SAME results: once by the order volleyball ranks by
// (the web's one table-rules loader), and once with points moved to the front of that order.
//
// WHAT CHECKS IT. The claims recompute the points and the two orders from the module's own declarations (the indoor
// points rule by set score, `primaryTableKey`, the order the loader returns), with the standings summed by hand from the
// per-match points, in code that shares no formatter with `build()`.
import { completeTableStage, pointsText, type FixtureResult } from "@seazn/engine/competition";
import type { TiebreakerKey } from "@seazn/engine/sport";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { declaredCfgs, forEachSport } from "@seazn/engine/testkit";
import { sportLabel, tiebreakLabel, variantLabel } from "@/blog/labels";
import { leagueRules, moduleOf, play, sentenceList, variantsOf, winnerSetScore, type Cfg, declaredLeaguePoints, joinAnd } from "./kit";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const MATCHES_WON_FIRST_ID = "matches-won-first";

const COLUMNS = ["Team", "Matches won", "Points", "Place, matches won first", "Place, points first"];
const C = { team: 0, won: 1, points: 2, placeWins: 3, placePoints: 4 } as const;

const TEAMS = [
  { id: "reds", name: "Reds" },
  { id: "blues", name: "Blues" },
  { id: "greens", name: "Greens" },
  { id: "golds", name: "Golds" },
] as const;
const nameOf = (id: string): string => TEAMS.find((t) => t.id === id)!.name;

/** The six matches of the round robin: who beat whom, and the set score they won by. Reds lose both 3-2 matches they play,
 *  so they collect points without matches; Blues win both of theirs. */
const MATCHES: readonly { winner: string; loser: string; score: "3-2" | "3-0" }[] = [
  { winner: "blues", loser: "reds", score: "3-2" },
  { winner: "reds", loser: "greens", score: "3-0" },
  { winner: "golds", loser: "reds", score: "3-2" },
  { winner: "greens", loser: "blues", score: "3-0" },
  { winner: "blues", loser: "golds", score: "3-2" },
  { winner: "greens", loser: "golds", score: "3-0" },
];

/** The six matches in words, in the order they are listed above: what a post prints to say who beat whom and by what score. */
const matchList = (): string => MATCHES.map((x) => `${nameOf(x.winner)} beat ${nameOf(x.loser)} ${x.score}`).join(", ");

const volleyball = (): AnySportModule => moduleOf("volleyball");
const INDOOR = "indoor";
const indoorCfg = (m: AnySportModule): Cfg => {
  const hit = declaredCfgs(m).find((c) => c.name === INDOOR);
  if (hit === undefined) throw new Error("matches-won-first: no indoor volleyball variant declared");
  return hit.cfg;
};

interface Placed {
  id: string;
  won: number;
  points: number;
  placeWins: number;
  placePoints: number;
}

/** The table over `results`, ranked by `order`, by the engine's own stage fold. Returns the ids in rank order. */
function rankedBy(m: AnySportModule, cfg: Cfg, order: readonly TiebreakerKey[], results: readonly FixtureResult[]): { id: string; won: number; points: number }[] {
  const rules = leagueRules(m, cfg);
  const done = completeTableStage(
    {
      id: "blog-example:matches-won-first",
      kind: "league",
      entrants: TEAMS.map((t) => t.id),
      rules: { points: rules.points, tiebreakers: order, crossGroup: rules.crossGroup },
      swiss: false,
      rngSeed: 1,
    },
    results.map((result, i) => ({ id: `f${i}`, status: "decided" as const, result, roundNo: 1 })),
  );
  const pool = done.tables.pools[0];
  if (pool === undefined || pool.rows.length !== TEAMS.length) throw new Error(`matches-won-first: the fold holds ${pool?.rows.length ?? 0} rows, expected ${TEAMS.length}`);
  if (pool.rows.some((r) => r.level === true || r.tieUnbroken === true)) throw new Error("matches-won-first: the example's table leaves a tie unbroken");
  return pool.rows.map((r) => ({ id: r.entrantId, won: r.won, points: r.points }));
}


function build(): ExampleResult {
  const m = volleyball();
  const cfg = indoorCfg(m);
  const results: FixtureResult[] = MATCHES.map((x) => play(m, cfg, `${INDOOR} ${x.winner} beat ${x.loser} ${x.score}`, [x.winner, x.loser], (o, pair) => o.kind === "win" && o.winner === x.winner && winnerSetScore(pair) === x.score, { variantKey: INDOOR }).paid);
  const real = leagueRules(m, cfg).tiebreakers;
  const pointsFirst: TiebreakerKey[] = ["points" as TiebreakerKey, ...real.filter((k) => k !== "points")];
  const byWins = rankedBy(m, cfg, real, results);
  const byPoints = rankedBy(m, cfg, pointsFirst, results);
  const placed: Placed[] = byWins.map((r, i) => ({ id: r.id, won: r.won, points: r.points, placeWins: i + 1, placePoints: byPoints.findIndex((x) => x.id === r.id) + 1 }));
  const rows = placed.map((p) => [nameOf(p.id), p.won, pointsText(p.points, "whole"), p.placeWins, p.placePoints]);

  const facts: ExampleResult["facts"] = {
    firstKey: tiebreakLabel(real[0]!),
    winsFirstOrder: joinAnd(byWins.map((r) => nameOf(r.id))),
    pointsFirstOrder: joinAnd(byPoints.map((r) => nameOf(r.id))),
  };
  for (const p of placed) {
    const k = p.id;
    facts[`${k}Won`] = p.won;
    facts[`${k}Points`] = pointsText(p.points, "whole");
    facts[`${k}PlaceWins`] = p.placeWins;
    facts[`${k}PlacePoints`] = p.placePoints;
  }
  // The registry sweep: which sports put matches won first, and in which of them points could ever disagree.
  const winsFirst: string[] = [];
  const notWinsFirst: string[] = [];
  const canDiffer: string[] = [];
  const alwaysAgree: string[] = [];
  const visited = forEachSport(({ module }) => {
    if (module.primaryTableKey === "wins") winsFirst.push(sportLabel(module.key));
    else notWinsFirst.push(sportLabel(module.key));
    const differing = variantsOf(module).filter((v) => payPairsOf(module, v.cfg).size > 1);
    if (module.primaryTableKey === "wins" && differing.length > 0) canDiffer.push(...differing.map((v) => `${variantLabel(module.key, v.key).toLowerCase()} ${sportLabel(module.key).toLowerCase()}`));
    if (module.primaryTableKey === "wins" && differing.length === 0) alwaysAgree.push(sportLabel(module.key));
  });
  facts.matchList = matchList();
  facts.sportCount = visited;
  facts.sportsNotWinsFirst = notWinsFirst.length;
  facts.notWinsFirstList = sentenceList(notWinsFirst);
  facts.sportsWinsFirst = winsFirst.length;
  facts.winsFirstList = joinAnd(winsFirst);
  facts.sportsWhereOrdersCanDiffer = canDiffer.length;
  facts.whereOrdersCanDiffer = joinAnd(canDiffer);
  facts.sportsAlwaysAgree = alwaysAgree.length;
  facts.alwaysAgreeList = joinAnd(alwaysAgree);
  const indoorPays = declaredLeaguePoints(m, cfg).bySetScore;
  facts.indoorWinThree = pointsText(indoorPays?.["3-0"]?.[0] ?? -1, "whole");
  facts.winnerAt31 = pointsText(indoorPays?.["3-1"]?.[0] ?? -1, "whole");
  facts.winnerAt32 = pointsText(indoorPays?.["3-2"]?.[0] ?? -1, "whole");
  facts.loserAt32 = pointsText(indoorPays?.["3-2"]?.[1] ?? -1, "whole");
  // The shape of the six results, read off them: how many teams and matches, and Reds' narrow defeats.
  facts.teamCount = TEAMS.length;
  facts.matchCount = MATCHES.length;
  facts.redsNarrowLosses = MATCHES.filter((x) => x.loser === "reds" && x.score === "3-2").length;
  return {
    facts,
    table: { caption: "Four volleyball teams, six matches, the same results ranked twice: matches won first, then points first.", columns: COLUMNS, rows },
    text: [
      "Four indoor volleyball teams play each other once. Each match is a real volleyball match played to the end, won by the set score the example names.",
      `Ranked by matches won first, the table reads ${facts.winsFirstOrder}; ranked by points first it reads ${facts.pointsFirstOrder}.`,
    ],
  };
}

/** The distinct [winner, loser] point pairs a sport's league pays across the set scores its format can end on. One pair:
 *  points are a function of matches won alone, so a points-first and a wins-first order cannot differ. */
function payPairsOf(module: AnySportModule, cfg: Cfg): Set<string> {
  const rule = declaredLeaguePoints(module, cfg);
  const scores: readonly (string | null)[] = module.reachableSetScores?.(cfg as never) ?? [null];
  const pairs = new Set<string>();
  for (const score of scores) {
    let w = rule.win.regulation;
    let l = rule.loss.regulation;
    if (rule.bySetScore !== undefined && score !== null) {
      const hit = rule.bySetScore[score] ?? rule.bySetScore["*"];
      if (hit === undefined) throw new Error(`${module.key}: the declared rule pays no ${score}`);
      [w, l] = hit;
    }
    pairs.add(`${w}/${l}`);
  }
  return pairs;
}

// ---- claims ----

const DECLARED = "the indoor volleyball points rule by set score (the sport's league points declaration, bySetScore), summed over the six matches";

/** Each team's matches won and points, summed by hand from the declared per-score points. */
function expectedTotals(m: AnySportModule): Map<string, { won: number; points: number }> {
  const rule = declaredLeaguePoints(m, indoorCfg(m));
  const totals = new Map(TEAMS.map((t) => [t.id as string, { won: 0, points: 0 }]));
  for (const x of MATCHES) {
    const hit = rule.bySetScore?.[x.score] ?? rule.bySetScore?.["*"];
    if (hit === undefined) throw new Error(`matches-won-first: the declared rule pays no ${x.score}`);
    const w = totals.get(x.winner)!;
    const l = totals.get(x.loser)!;
    w.won += 1;
    w.points += hit[0];
    l.points += hit[1];
  }
  return totals;
}

/** A place order from totals: the sorted ids by the key list, ties never reached (the example's design). */
function orderBy(totals: Map<string, { won: number; points: number }>, keys: ("won" | "points")[]): string[] {
  return [...totals.entries()]
    .sort((a, b) => {
      for (const k of keys) if (a[1][k] !== b[1][k]) return b[1][k] - a[1][k];
      return 0;
    })
    .map(([id]) => id);
}

function claimsFor(m: AnySportModule): Claim[] {
  const mine = (says: string, source: string, check: Claim["check"]): Claim => ({ says: `Volleyball: ${says}`, source, sport: "volleyball", check });
  const totals = expectedTotals(m);
  // Matches won, then points; the declared order puts `wins` first, then `points`. Distinct on both keys in this design.
  const winsFirst = orderBy(totals, ["won", "points"]);
  const pointsFirst = orderBy(totals, ["points", "won"]);
  return [
    mine("each team's matches won and points are the six matches summed by the declared rule", DECLARED, (r) => {
      for (const t of TEAMS) {
        const e = totals.get(t.id)!;
        const row = (r.table?.rows ?? []).find((x) => x[C.team] === t.name);
        if (row === undefined) return `no row for ${t.name}`;
        if (row[C.won] !== e.won || row[C.points] !== pointsText(e.points, "whole")) return `${t.name}: ${String(row[C.won])} won and ${String(row[C.points])} points, the declaration gives ${e.won} and ${e.points}`;
        if (r.facts[`${t.id}Won`] !== e.won || r.facts[`${t.id}Points`] !== pointsText(e.points, "whole")) return `${t.name}'s facts disagree with the declaration`;
      }
      // The post prints the six matches as one sentence; each team's record above is folded from exactly these.
      const listed = MATCHES.map((x) => [TEAMS.find((t) => t.id === x.winner)!.name, "beat", TEAMS.find((t) => t.id === x.loser)!.name, x.score].join(" ")).join(", ");
      if (r.facts.matchList !== listed || MATCHES.length !== 6) return `matchList is '${String(r.facts.matchList)}', the six matches read '${listed}'`;
      // The post quotes the 3-0 win's points; take it from the declared per-score map, never from the example's own fact.
      const sweep = declaredLeaguePoints(m, indoorCfg(m)).bySetScore?.["3-0"]?.[0];
      if (sweep === undefined) return "the indoor rule declares no 3-0 pair";
      return r.facts.indoorWinThree === pointsText(sweep, "whole") || `indoorWinThree is ${String(r.facts.indoorWinThree)}, the declaration gives ${pointsText(sweep, "whole")}`;
    }),
    mine("a win in four sets pays the winner what straight sets pays, and only a five-set win pays less (the winner's and the loser's amount)", "the indoor volleyball points rule by set score (bySetScore)", (r) => {
      const pays = declaredLeaguePoints(m, indoorCfg(m)).bySetScore;
      const at = (score: string): readonly [number, number] | undefined => pays?.[score] ?? pays?.["*"];
      const [w30, w31, w32] = [at("3-0"), at("3-1"), at("3-2")];
      if (w30 === undefined || w31 === undefined || w32 === undefined) return "the indoor rule declares no pair for one of 3-0, 3-1 or 3-2";
      if (w31[0] !== w30[0]) return `a four-set win pays ${w31[0]}, a straight-sets win ${w30[0]}`;
      if (!(w32[0] < w30[0])) return `a five-set win pays ${w32[0]}, not less than the ${w30[0]} of straight sets`;
      const f = r.facts;
      if (f.winnerAt31 !== pointsText(w31[0], "whole") || f.winnerAt32 !== pointsText(w32[0], "whole") || f.loserAt32 !== pointsText(w32[1], "whole")) return `winnerAt31 ${String(f.winnerAt31)}, winnerAt32 ${String(f.winnerAt32)}, loserAt32 ${String(f.loserAt32)} disagree with ${w31[0]}, ${w32[0]}, ${w32[1]}`;
      return true;
    }),
    mine("the narrative shape of the six results: Blues' every win went to five sets, Reds' every win was straight sets, and the facts count the teams, the matches and Reds' narrow defeats", "the six matches (the example's scenario) against the per-team record", (r) => {
      const wins = (id: string) => MATCHES.filter((x) => x.winner === id);
      if (wins("blues").length === 0 || !wins("blues").every((x) => x.score === "3-2")) return "not every Blues win went to five sets";
      if (wins("reds").length === 0 || !wins("reds").every((x) => x.score === "3-0")) return "not every Reds win was in straight sets";
      const narrow = MATCHES.filter((x) => x.loser === "reds" && x.score === "3-2").length;
      const n = (r.table?.rows ?? []).length;
      if (r.facts.teamCount !== n || r.facts.matchCount !== (n * (n - 1)) / 2) return `teamCount ${String(r.facts.teamCount)} and matchCount ${String(r.facts.matchCount)}, the table has ${n} teams (${(n * (n - 1)) / 2} matches in a round robin)`;
      if (r.facts.redsNarrowLosses !== narrow || narrow === 0) return `redsNarrowLosses is ${String(r.facts.redsNarrowLosses)}, the results give ${narrow}`;
      return r.facts.redsWon === wins("reds").length && r.facts.bluesWon === wins("blues").length || "the won facts disagree with the six results";
    }),
    mine("the table's two place columns are the two orders by the declared keys, and the two orders DIFFER", `${DECLARED}; primaryTableKey`, (r) => {
      if (m.primaryTableKey !== "wins") return "volleyball no longer ranks on matches won first";
      if (JSON.stringify(winsFirst) === JSON.stringify(pointsFirst)) return "the example's results no longer separate the two orders";
      for (const [i, id] of winsFirst.entries()) {
        const row = (r.table?.rows ?? []).find((x) => x[C.team] === nameOf(id));
        if (row === undefined || row[C.placeWins] !== i + 1) return `${nameOf(id)} should be ${i + 1} when matches won come first, the table says ${String(row?.[C.placeWins])}`;
        if (r.facts[`${id}PlaceWins`] !== i + 1) return `${nameOf(id)}'s PlaceWins fact is ${String(r.facts[`${id}PlaceWins`])}, the declared order gives ${i + 1}`;
      }
      for (const [i, id] of pointsFirst.entries()) {
        const row = (r.table?.rows ?? []).find((x) => x[C.team] === nameOf(id));
        if (row === undefined || row[C.placePoints] !== i + 1) return `${nameOf(id)} should be ${i + 1} when points come first, the table says ${String(row?.[C.placePoints])}`;
        if (r.facts[`${id}PlacePoints`] !== i + 1) return `${nameOf(id)}'s PlacePoints fact is ${String(r.facts[`${id}PlacePoints`])}, the declared order gives ${i + 1}`;
      }
      const rows = (r.table?.rows ?? []).map((x) => String(x[C.team]));
      if (JSON.stringify(rows) !== JSON.stringify(winsFirst.map(nameOf))) return `the rows read ${rows.join(", ")}, the real order is ${winsFirst.map(nameOf).join(", ")}`;
      return r.facts.winsFirstOrder === joinAnd(winsFirst.map(nameOf)) && r.facts.pointsFirstOrder === joinAnd(pointsFirst.map(nameOf)) || "the order facts disagree with the declarations";
    }),
    mine("a team with MORE points than another can be ranked BELOW it: there is a pair where the points order and the matches-won order disagree, and the table's two place columns differ for those teams", "the per-score points of the declared rule", (r) => {
      let flips = 0;
      for (const [a, ta] of totals) for (const [b, tb] of totals) if (a < b && ta.points > tb.points && ta.won < tb.won) flips++;
      for (const [a, ta] of totals) for (const [b, tb] of totals) if (a < b && tb.points > ta.points && tb.won < ta.won) flips++;
      if (flips === 0) return "no pair of teams disagrees on the two orders";
      const moved = (r.table?.rows ?? []).filter((x) => x[C.placeWins] !== x[C.placePoints]).length;
      // A pair that swaps moves both of its teams: at least two rows differ between the two place columns.
      return moved >= 2 || `only ${moved} rows differ between the two place columns`;
    }),
    mine("the order the loader returns for the sport starts on matches won, and the example's counterfactual moves only points to the front", "primaryTableKey and the table-rules loader's order", (r) => {
      const real = leagueRules(m, indoorCfg(m)).tiebreakers;
      if (!(real[0] === "wins" && real.includes("points" as TiebreakerKey))) return `the order starts ${String(real[0])}`;
      return r.facts.firstKey === tiebreakLabel(m.primaryTableKey) || `firstKey is ${String(r.facts.firstKey)}, the sport's primary key reads ${tiebreakLabel(m.primaryTableKey)}`;
    }),
  ];
}

function acrossSports(): Claim[] {
  return [
    {
      says: "the sports that rank on matches won first are counted from the registry, and points could disagree with that order only where the rule pays a winner or loser differently by set score",
      source: "primaryTableKey of every sport module; the declared points pairs of every set score the format can end on",
      check(result) {
        const winsFirst: string[] = [];
        const differ: string[] = [];
        const visited = forEachSport(({ module }) => {
          if (module.primaryTableKey !== "wins") return;
          winsFirst.push(sportLabel(module.key));
          for (const v of variantsOf(module)) if (payPairsOf(module, v.cfg).size > 1) differ.push(`${variantLabel(module.key, v.key).toLowerCase()} ${sportLabel(module.key).toLowerCase()}`);
        });
        const f = result.facts;
        if (f.sportCount !== visited) return `sportCount is ${String(f.sportCount)}, the registry has ${visited}`;
        const rest = builtinModules.filter((b) => b.primaryTableKey !== "wins").map((b) => sportLabel(b.key));
        if (rest.length === 0) return "no sport was left that ranks on something other than matches won";
        if (f.sportsNotWinsFirst !== rest.length || f.notWinsFirstList !== sentenceList(rest)) return `notWinsFirstList is '${String(f.notWinsFirstList)}' (${String(f.sportsNotWinsFirst)}), the registry leaves ${rest.length}: '${sentenceList(rest)}'`;
        if (f.sportsWinsFirst !== winsFirst.length || f.winsFirstList !== joinAnd(winsFirst)) return `winsFirst: ${String(f.sportsWinsFirst)} '${String(f.winsFirstList)}', the declarations give ${winsFirst.length} '${joinAnd(winsFirst)}'`;
        if (f.sportsWhereOrdersCanDiffer !== differ.length || f.whereOrdersCanDiffer !== joinAnd(differ)) return `canDiffer: ${String(f.sportsWhereOrdersCanDiffer)} '${String(f.whereOrdersCanDiffer)}', the declarations give ${differ.length} '${joinAnd(differ)}'`;
        if (winsFirst.length < 2) return `only ${winsFirst.length} sports rank on matches won`;
        return differ.length > 0 || "no sport can have the orders disagree";
      },
    },
    {
      says: "in every other wins-first sport (badminton and tennis, in the registry today) a winner and a loser are paid the same by every set score and the loser gets nothing, so matches won and points always give one order",
      source: "payPairs of every declared variant of every wins-first sport",
      check(result) {
        let checked = 0;
        const bad: string[] = [];
        const agree: string[] = [];
        const losersPaid: string[] = [];
        forEachSport(({ module }) => {
          if (module.primaryTableKey !== "wins") return;
          let all = true;
          for (const v of variantsOf(module)) {
            checked++;
            const pairs = [...payPairsOf(module, v.cfg)];
            const flat = pairs.length === 1;
            if (flat && pairs[0]!.split("/")[1] !== "0") losersPaid.push(`${module.key}/${v.key}`);
            if (!flat) all = false;
            if (!flat && !(module.key === "volleyball" && v.key === INDOOR)) bad.push(`${module.key}/${v.key}`);
          }
          if (all) agree.push(sportLabel(module.key));
        });
        if (checked === 0) return "no wins-first variant was checked";
        if (bad.length > 0) return `variants that pay unevenly beyond indoor volleyball: ${bad.join(", ")}`;
        if (losersPaid.length > 0) return `flat variants whose loser is paid something: ${losersPaid.join(", ")}`;
        if (agree.length < 2) return `only ${agree.length} sports always agree`;
        const f = result.facts;
        return (f.sportsAlwaysAgree === agree.length && f.alwaysAgreeList === joinAnd(agree)) || `alwaysAgree: ${String(f.sportsAlwaysAgree)} '${String(f.alwaysAgreeList)}', the declarations give ${agree.length} '${joinAnd(agree)}'`;
      },
    },
  ];
}

const claims: Claim[] = [...acrossSports(), ...claimsFor(volleyball())];

export const matchesWonFirst: BlogExample = {
  id: MATCHES_WON_FIRST_ID,
  kind: "engine",
  sports: ["volleyball"],
  singleSportReason: "volleyball only: the table needs a rule that pays a winner differently by set score, which only indoor volleyball does (the sweep in the claims counts the registry)",
  build,
  claims,
};
