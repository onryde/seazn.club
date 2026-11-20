// Post #1, "How do standings points work in each sport?". For every sport in the registry, under the sport's own
// declared default config, two real matches are played through the engine's own event stream (the testkit's
// seeded walk, refolded the way the app folds it): Ana beats Ben, and where the sport allows a level result, Cy
// and Dev finish level. Each result is paid by the same rule resolver the standings use (`resolveTableRules` then
// `payout`), so the points in the table are what a division would book, not a typed number.
//
// WHICH MATCH. The walk is seeded and the search for a seed that gives the wanted result is deterministic, so the
// example needs no typed seed and no typed score. A set sport is played once per reachable final set score,
// because that is what its points depend on (volleyball: a 3-2 win pays 2, not 3).
//
// WHAT CHECKS IT. Each claim below reads the sport module's own declaration (`tablePointsRule`, `primaryTableKey`,
// `reachableResultKinds`, `reachableSetScores`) and compares the committed result to it. None reads `build()`.
import { foldMatch } from "@seazn/engine/core";
import type { MatchOutcome } from "@seazn/engine/core";
import { decidedInFor, forfeitShaped, payout, pointsText, resolveTableRules, setsToWinOf, type FixtureResult } from "@seazn/engine/competition";
import { resolvePositions } from "@seazn/engine/sport";
import type { AnySportModule } from "@seazn/engine/sport";
import { buildWalk, declaredCfgs, forEachSport, lineupFromCatalog } from "@seazn/engine/testkit";
import { sportLabel, tiebreakLabel } from "@/blog/labels";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const STANDINGS_POINTS_ID = "standings-points";

const NAMES: Record<string, string> = { ana: "Ana", ben: "Ben", cy: "Cy", dev: "Dev" };
/** The seeded search's bounds: far past what any sport needs, so a miss is a real fault and not a short budget. */
const MAX_SEEDS = 20000;
const MAX_EVENTS = 3000;

const COLUMNS = ["Sport", "Winner gets", "Each side in a level match", "Loser gets", "Table ranks first by"];
const NOT_POSSIBLE = "Not possible";

type Cfg = unknown;
type Level = { kind: "draw" | "tie"; points: number };

interface Played {
  outcome: MatchOutcome;
  paid: FixtureResult;
  headline: string;
}

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const scoreSuffix = (score: string | null) => (score === null ? "" : score.replace("-", ""));

/** The sport's declared default config: the first entry `declaredCfgs` lists, as the sport's schema parsed it. */
function declaredCfgOf(module: AnySportModule): Cfg {
  return declaredCfgs(module)[0]!.cfg;
}

/** The rule a league table pays by, from the engine's one resolver (no stage rule, no division order, no pin). */
function leagueRules(module: AnySportModule, cfg: Cfg) {
  return resolveTableRules({
    module,
    stageKind: "league",
    mergedCfg: cfg,
    stageOwn: { points: null, tiebreakers: null, crossGroup: null },
    divisionTiebreakers: null,
    pinned: null,
  });
}

/**
 * Plays one match to the wanted result: the first seeded walk, in seed order, whose refolded outcome `accept`
 * takes. The refold is the app's (`foldMatch`), and must agree with the walk's own last state.
 */
function play(module: AnySportModule, cfg: Cfg, sides: [string, string], accept: (outcome: MatchOutcome, pair: FixtureResult) => boolean): Played {
  const catalog = resolvePositions(module, cfg);
  const lineups = { home: lineupFromCatalog(catalog, sides[0]), away: lineupFromCatalog(catalog, sides[1]) };
  const rules = leagueRules(module, cfg);
  for (let seed = 1; seed <= MAX_SEEDS; seed++) {
    const { events, states } = buildWalk(module, cfg, lineups, seed, MAX_EVENTS);
    const last = states[states.length - 1];
    const walked = last === undefined ? null : module.outcome(last);
    // Cheap filter first: only a decided, played match can be wanted; the refold below is the real read.
    if (walked === null || (walked.kind !== "win" && walked.kind !== "draw" && walked.kind !== "tie")) continue;
    const state = foldMatch(module, cfg, lineups, events);
    const outcome = module.outcome(state);
    if (JSON.stringify(outcome) !== JSON.stringify(walked)) {
      throw new Error(`${module.key}: seed ${seed}: the app's fold and the walk disagree on the outcome`);
    }
    if (outcome === null || forfeitShaped(outcome)) continue;
    const delta = module.standingsDelta(outcome, cfg as never, { kind: "league" }, state);
    const pair: FixtureResult = [delta[0], delta[1]];
    if (!accept(outcome, pair)) continue;
    const paid = payout(outcome, decidedInFor(module, outcome), pair, true, rules.points, module.awardScoreKeys, setsToWinOf(module, cfg));
    return { outcome, paid, headline: module.summary(state).headline };
  }
  throw new Error(`${module.key}: no seed up to ${MAX_SEEDS} gives the wanted match`);
}

function winnerSetScore(pair: FixtureResult): string | null {
  const w = pair.find((d) => d.won === 1);
  const won = w?.metrics.sets_won;
  const lost = w?.metrics.sets_lost;
  return won === undefined || lost === undefined ? null : `${won}-${lost}`;
}

interface Win {
  score: string | null;
  winner: number;
  loser: number;
  line: string;
}

interface SportRun {
  key: string;
  unit: "whole" | "half";
  wins: Win[];
  level: (Level & { line: string }) | null;
  rankedBy: string;
}

function runSport(module: AnySportModule): SportRun {
  const cfg = declaredCfgOf(module);
  const rules = leagueRules(module, cfg);
  const unit = rules.points.unit;
  const scores: readonly (string | null)[] = module.reachableSetScores?.(cfg) ?? [null];
  const wins: Win[] = scores.map((score) => {
    const p = play(module, cfg, ["ana", "ben"], (o, pair) => {
      if (o.kind !== "win" || o.winner !== "ana") return false;
      if (decidedInFor(module, o) !== "regulation") return false;
      return score === null || winnerSetScore(pair) === score;
    });
    const w = p.paid.find((d) => d.won === 1)!;
    const l = p.paid.find((d) => d.lost === 1)!;
    return { score, winner: w.points, loser: l.points, line: `${NAMES.ana} beat ${NAMES.ben} ${p.headline}` };
  });
  const reach = module.reachableResultKinds(cfg, "league");
  const kind = reach.has("draw") ? "draw" : reach.has("tie") ? "tie" : null;
  let level: SportRun["level"] = null;
  if (kind !== null) {
    const p = play(module, cfg, ["cy", "dev"], (o) => o.kind === kind);
    const [a, b] = p.paid;
    if (a.points !== b.points) throw new Error(`${module.key}: a level match paid ${a.points} and ${b.points}`);
    level = { kind, points: a.points, line: `${NAMES.cy} and ${NAMES.dev} ${kind === "draw" ? "drew" : "tied"} ${p.headline}` };
  }
  return { key: module.key, unit, wins, level, rankedBy: tiebreakLabel(rules.tiebreakers[0]!) };
}

/** "3 (3-0 or 3-1), 2 (3-2)" when a set sport pays by score; just "3" when every score pays the same. */
function composeCell(groups: { points: number; scores: (string | null)[] }[], unit: "whole" | "half"): string {
  if (groups.length === 1) return pointsText(groups[0]!.points, unit);
  return groups.map((g) => `${pointsText(g.points, unit)} (${g.scores.join(" or ")})`).join(", ");
}

/** Groups scores by what they pay (in score order), so a flat rule is one group and volleyball is two. */
function groupBy(entries: { score: string | null; pair: readonly [number, number] }[], side: 0 | 1) {
  const groups: { key: string; points: number; scores: (string | null)[] }[] = [];
  for (const e of entries) {
    const key = `${e.pair[0]}/${e.pair[1]}`;
    const found = groups.find((g) => g.key === key);
    if (found) found.scores.push(e.score);
    else groups.push({ key, points: e.pair[side], scores: [e.score] });
  }
  return groups;
}

const levelCell = (level: Level | null, unit: "whole" | "half") =>
  level === null ? NOT_POSSIBLE : `${pointsText(level.points, unit)}${level.kind === "tie" ? " (a tie)" : ""}`;

function build(): ExampleResult {
  const facts: ExampleResult["facts"] = {};
  const rows: (string | number)[][] = [];
  const text: string[] = [
    "Each row comes from real matches scored the way a division scores them: Ana beats Ben, and where the sport allows a level result, Cy and Dev finish level.",
  ];
  const visited = forEachSport(({ module }) => {
    const run = runSport(module);
    const entries = run.wins.map((w) => ({ score: w.score, pair: [w.winner, w.loser] as const }));
    const winnerGroups = groupBy(entries, 0);
    const loserGroups = groupBy(entries, 1);
    for (const w of run.wins) {
      const suffix = scoreSuffix(w.score);
      facts[`${run.key}Win${suffix}`] = pointsText(w.winner, run.unit);
      facts[`${run.key}Loss${suffix}`] = pointsText(w.loser, run.unit);
      text.push(`${sportLabel(run.key)}: ${w.line}.`);
    }
    if (run.level !== null) {
      facts[`${run.key}Level`] = pointsText(run.level.points, run.unit);
      text.push(`${sportLabel(run.key)}: ${run.level.line}.`);
    }
    facts[`${run.key}RankedBy`] = run.rankedBy;
    rows.push([
      sportLabel(run.key),
      composeCell(winnerGroups, run.unit),
      levelCell(run.level, run.unit),
      composeCell(loserGroups, run.unit),
      upperFirst(run.rankedBy),
    ]);
  });
  facts.sportCount = visited;
  return {
    facts,
    table: { caption: "What one finished match is worth in the standings, by sport.", columns: COLUMNS, rows },
    text,
  };
}

// ---- claims: every expected value below comes from the sport module's own declarations ----

const rowOf = (result: ExampleResult, label: string) => result.table?.rows.find((r) => r[0] === label);

function claimsFor(module: AnySportModule): Claim[] {
  const key = module.key;
  const label = sportLabel(key);
  const cfg = declaredCfgOf(module);
  const rule = module.tablePointsRule(cfg, "league");
  const unit = rule.unit;
  const scores: readonly (string | null)[] = module.reachableSetScores?.(cfg) ?? [null];
  /** What the declaration pays a win at this set score: the exact "W-L" entry, else "*", else the flat win and loss. */
  const pairFor = (score: string | null): readonly [number, number] => {
    const map = rule.bySetScore;
    if (map !== undefined && score !== null) {
      const hit = map[score] ?? map["*"];
      if (hit === undefined) throw new Error(`${key}: the declared rule pays no ${score}`);
      return hit;
    }
    return [rule.win.regulation, rule.loss.regulation];
  };
  const expected = scores.map((score) => ({ score, pair: pairFor(score) }));
  const mine = (says: string, source: string, check: Claim["check"]): Claim => ({ says: `${label}: ${says}`, source, sport: key, check });
  const all = (result: ExampleResult, side: 0 | 1, prefix: "Win" | "Loss") => {
    for (const e of expected) {
      const fact = result.facts[`${key}${prefix}${scoreSuffix(e.score)}`];
      const want = pointsText(e.pair[side], unit);
      if (fact !== want) return `${key}${prefix}${scoreSuffix(e.score)} is ${String(fact)}, the declaration pays ${want}`;
    }
    return true;
  };
  const reach = module.reachableResultKinds(cfg, "league");
  const levelKind = reach.has("draw") ? "draw" : reach.has("tie") ? "tie" : null;
  const declaredLevel = levelKind === "draw" ? rule.draw : levelKind === "tie" ? rule.tie : undefined;
  const claims: Claim[] = [
    mine("the winner's points are what the sport's points rule pays a win", "tablePointsRule(cfg, \"league\").win (and bySetScore for a set sport)", (r) => all(r, 0, "Win")),
    mine("the loser's points are what the sport's points rule pays a loss", "tablePointsRule(cfg, \"league\").loss (and bySetScore for a set sport)", (r) => all(r, 1, "Loss")),
    mine("the winner's cell shows what the rule pays", "tablePointsRule(cfg, \"league\")", (r) => {
      const want = composeCell(groupBy(expected, 0), unit);
      const cell = rowOf(r, label)?.[1];
      return cell === want || `cell is ${String(cell)}, the declaration gives ${want}`;
    }),
    mine("the loser's cell shows what the rule pays", "tablePointsRule(cfg, \"league\")", (r) => {
      const want = composeCell(groupBy(expected, 1), unit);
      const cell = rowOf(r, label)?.[3];
      return cell === want || `cell is ${String(cell)}, the declaration gives ${want}`;
    }),
    mine(levelKind === null ? "a level match cannot happen, so none is shown" : `a level match pays what the rule pays a ${levelKind}`, "reachableResultKinds(cfg, \"league\") and tablePointsRule(cfg, \"league\").draw / .tie", (r) => {
      const cell = rowOf(r, label)?.[2];
      if (levelKind === null) {
        if (cell !== NOT_POSSIBLE) return `cell is ${String(cell)}, the sport cannot end a league match level`;
        return r.facts[`${key}Level`] === undefined || "a level fact exists for a sport that cannot end level";
      }
      if (declaredLevel === undefined) return `the rule declares no points for a ${levelKind}`;
      const want = levelCell({ kind: levelKind, points: declaredLevel }, unit);
      if (cell !== want) return `cell is ${String(cell)}, the declaration gives ${want}`;
      return r.facts[`${key}Level`] === pointsText(declaredLevel, unit) || `fact ${key}Level is ${String(r.facts[`${key}Level`])}`;
    }),
    mine("the table ranks first by the sport's primary table key", "primaryTableKey", (r) => {
      const want = tiebreakLabel(module.primaryTableKey);
      const cell = rowOf(r, label)?.[4];
      if (cell !== upperFirst(want)) return `cell is ${String(cell)}, the declaration gives ${upperFirst(want)}`;
      return r.facts[`${key}RankedBy`] === want || `fact ${key}RankedBy is ${String(r.facts[`${key}RankedBy`])}`;
    }),
  ];
  // Class 19: where the declared pairs differ by score, the narrowest win must pay ITS pair, not the clean sweep's.
  const distinct = new Set(expected.map((e) => e.pair.join("/")));
  if (scores.length > 1 && distinct.size > 1) {
    const clean = expected[0]!;
    const narrow = expected[expected.length - 1]!;
    claims.push(
      mine(`a ${narrow.score} win pays ${narrow.pair[0]}-${narrow.pair[1]}, not the ${clean.pair[0]}-${clean.pair[1]} of a ${clean.score} win`, "tablePointsRule(cfg, \"league\").bySetScore", (r) => {
        const won = r.facts[`${key}Win${scoreSuffix(narrow.score)}`];
        const wrong = pointsText(clean.pair[0], unit);
        if (won === wrong) return `the ${narrow.score} win pays ${String(won)}, which is the clean sweep's`;
        return won === pointsText(narrow.pair[0], unit) || `the ${narrow.score} win pays ${String(won)}`;
      }),
    );
  }
  return claims;
}

/** Example-wide claims: what the post says ACROSS sports (no `sport`), read from the registry's declarations. */
const acrossSports = (): Claim[] => [
  {
    says: "the table's last column names exactly the first ranking keys the registry declares, and the sports do not all share one",
    source: "primaryTableKey of every sport module",
    check(result) {
      const declared = new Set<string>();
      forEachSport(({ module }) => declared.add(upperFirst(tiebreakLabel(module.primaryTableKey))));
      const shown = new Set((result.table?.rows ?? []).map((r) => String(r[4])));
      if (declared.size < 2) return `the registry declares ${declared.size} first key; the post says they differ`;
      return [...declared].sort().join(",") === [...shown].sort().join(",") || `the table shows ${[...shown].join(", ")}, the registry declares ${[...declared].join(", ")}`;
    },
  },
  {
    says: "the table has one row per sport in the registry, in registry order",
    source: "the sport registry (builtinModules, via forEachSport)",
    check(result) {
      const labels: string[] = [];
      const visited = forEachSport(({ module }) => labels.push(sportLabel(module.key)));
      const shown = (result.table?.rows ?? []).map((r) => String(r[0]));
      if (result.facts.sportCount !== visited) return `sportCount is ${String(result.facts.sportCount)}, the registry has ${visited}`;
      return JSON.stringify(shown) === JSON.stringify(labels) || `rows are ${shown.join(", ")}, the registry is ${labels.join(", ")}`;
    },
  },
];

const claims: Claim[] = [...acrossSports()];
const sportsClaimed = forEachSport(({ module }) => {
  claims.push(...claimsFor(module));
});
if (sportsClaimed === 0) throw new Error("standings-points: the sport registry is empty");

export const standingsPoints: BlogExample = {
  id: STANDINGS_POINTS_ID,
  kind: "engine",
  sports: "all",
  build,
  claims,
};
