// Post #1, "How do standings points work in each sport?". For every sport in the registry, under the variant a NEW
// division of that sport starts on (starting-variant.ts: the builder's own pick), real matches are played through the
// engine's own event stream (the testkit's seeded walk, refolded the way the app folds it) and paid by the same rule
// resolver the standings use (`resolveTableRules` then `payout`). So the points in the table are what a division would
// book, not a typed number. A variant whose points differ from the starting one gets a row of its own.
//
// WHICH MATCHES, per row: Ana beats Ben (once per reachable final set score, for a set sport, because its points depend
// on the score); Ana beats Ben after overtime or in a shoot-out, where the variant can reach them; and one match for
// each way a match can end with nobody winning (a draw, a cricket tie, a cricket no result). The seeded search is
// deterministic, so the example needs no typed seed and no typed score.
//
// WHAT CHECKS IT. The claims below recompute every expected cell and fact from the sport module's own declarations
// (`tablePointsRule`, `primaryTableKey`, `reachableResultKinds`, `reachableSetScores`, `reachableDecidedIn`) in code
// that shares no formatter with `build()`, and compare the committed result to it. None reads `build()`.
import { foldMatch } from "@seazn/engine/core";
import type { MatchOutcome } from "@seazn/engine/core";
import { decidedInFor, forfeitShaped, payout, pointsText, resolveTableRules, setsToWinOf, type FixtureResult } from "@seazn/engine/competition";
import { resolvePositions } from "@seazn/engine/sport";
import type { AnySportModule } from "@seazn/engine/sport";
import { buildWalk, declaredCfgs, forEachSport, lineupFromCatalog } from "@seazn/engine/testkit";
import { sportLabel, tiebreakLabel, variantLabel } from "@/blog/labels";
import { startingVariantKey } from "./starting-variant";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const STANDINGS_POINTS_ID = "standings-points";

const NAMES: Record<string, string> = { ana: "Ana", ben: "Ben", cy: "Cy", dev: "Dev" };
/** The seeded search's bounds: far past what any sport needs, so a miss is a real fault and not a short budget. */
const MAX_SEEDS = 20000;
const MAX_EVENTS = 3000;

const COLUMNS = ["Sport", "Winner gets", "Loser gets", "Each side when nobody wins", "After overtime or a shoot-out", "Table sorted by first"];
const C = { sport: 0, winner: 1, loser: 2, nobody: 3, beyond: 4, sorted: 5 } as const;
const NOT_POSSIBLE = "Not possible";

type Cfg = unknown;
type LevelKind = "draw" | "tie" | "noResult";
type Beyond = "ot" | "so";
const LEVEL_KINDS: readonly LevelKind[] = ["draw", "tie", "noResult"];
const OUTCOME_OF: Record<LevelKind, MatchOutcome["kind"]> = { draw: "draw", tie: "tie", noResult: "no_result" };
const LEVEL_WORDS: Record<LevelKind, string> = { draw: "a draw", tie: "a tie", noResult: "no result" };
const BEYOND_WORDS: Record<Beyond, string> = { ot: "overtime", so: "shoot-out" };

/**
 * Result kinds a variant DECLARES reachable that no match can end in. Cricket's `reachableResultKinds` lists no result for
 * every variant, but `core.abandon` in a two-innings match (Test) books a draw, so a Test match is never "no result":
 * 3000 seeded Test walks end in win, draw, tie and award and never in no_result (blog-examples.test.ts re-proves that
 * and fails when the engine starts reaching it, so this entry cannot go stale unseen). An example prints only what a
 * played match can end in. Hockey with a shoot-out is the second: it declares a draw, but a level match always goes to the
 * shoot-out and is booked a win there (1500 seeded walks: win in regulation, win in the shoot-out, or an award; no draw).
 */
export const DECLARED_BUT_UNREACHABLE: Readonly<Record<string, readonly LevelKind[]>> = {
  "cricket/test": ["noResult"],
  "hockey/fih-shootout": ["draw"],
};
const levelKindsOf = (module: AnySportModule, variantKey: string, reach: ReadonlySet<string>): LevelKind[] =>
  LEVEL_KINDS.filter((k) => reach.has(k) && !(DECLARED_BUT_UNREACHABLE[`${module.key}/${variantKey}`] ?? []).includes(k));

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const scoreSuffix = (score: string | null) => (score === null ? "" : score.replace("-", ""));
const compact = (variantKey: string) => upperFirst(variantKey.replace(/[^a-z0-9]/gi, ""));

/** The variants a module declares by name (declaredCfgs also lists the bare schema default, which is no variant). */
function variantsOf(module: AnySportModule): { key: string; cfg: Cfg }[] {
  return declaredCfgs(module)
    .filter((c) => Object.hasOwn(module.variants, c.name))
    .map((c) => ({ key: c.name, cfg: c.cfg as Cfg }));
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

interface Played {
  outcome: MatchOutcome;
  paid: FixtureResult;
  headline: string;
}

/**
 * Plays one match to the wanted result: the first seeded walk, in seed order, whose refolded outcome `accept`
 * takes. The refold is the app's (`foldMatch`), and must agree with the walk's own last state.
 */
function play(module: AnySportModule, cfg: Cfg, what: string, sides: [string, string], accept: (outcome: MatchOutcome, pair: FixtureResult) => boolean): Played {
  const catalog = resolvePositions(module, cfg);
  const lineups = { home: lineupFromCatalog(catalog, sides[0]), away: lineupFromCatalog(catalog, sides[1]) };
  const rules = leagueRules(module, cfg);
  for (let seed = 1; seed <= MAX_SEEDS; seed++) {
    const { events, states } = buildWalk(module, cfg, lineups, seed, MAX_EVENTS);
    const last = states[states.length - 1];
    const walked = last === undefined ? null : module.outcome(last);
    // Cheap filter first: only a decided, played match can be wanted; the refold below is the real read.
    if (walked === null || !["win", "draw", "tie", "no_result"].includes(walked.kind)) continue;
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
  throw new Error(`${module.key}: no seed up to ${MAX_SEEDS} gives the wanted match (${what})`);
}

function winnerSetScore(pair: FixtureResult): string | null {
  const w = pair.find((d) => d.won === 1);
  const won = w?.metrics.sets_won;
  const lost = w?.metrics.sets_lost;
  return won === undefined || lost === undefined ? null : `${won}-${lost}`;
}

/** What the winner and the loser of a decided match were paid, by entrant (a booked shoot-out has no `won` flag). */
function winnerLoserPoints(p: Played): [number, number] {
  const o = p.outcome;
  if (o.kind !== "win") throw new Error("a winner and a loser need a win");
  const w = p.paid.find((d) => d.entrantId === o.winner);
  const l = p.paid.find((d) => d.entrantId === o.loser);
  if (w === undefined || l === undefined) throw new Error("the paid pair does not name the match's winner and loser");
  return [w.points, l.points];
}

interface Tagged<T extends string | null> {
  tag: T;
  winner: number;
  loser: number;
  line: string;
}
interface LevelRun {
  kind: LevelKind;
  points: number;
  line: string;
}
interface Run {
  rowId: string;
  variantKey: string;
  unit: "whole" | "half";
  wins: Tagged<string | null>[];
  beyond: Tagged<Beyond>[];
  levels: LevelRun[];
  rankedBy: string;
}

function runVariant(module: AnySportModule, variantKey: string, cfg: Cfg, rowId: string): Run {
  const rules = leagueRules(module, cfg);
  const scores: readonly (string | null)[] = module.reachableSetScores?.(cfg) ?? [null];
  const wins = scores.map((score): Tagged<string | null> => {
    const p = play(module, cfg, `${variantKey} win ${String(score)}`, ["ana", "ben"], (o, pair) => {
      if (o.kind !== "win" || o.winner !== "ana" || decidedInFor(module, o) !== "regulation") return false;
      return score === null || winnerSetScore(pair) === score;
    });
    const [winner, loser] = winnerLoserPoints(p);
    return { tag: score, winner, loser, line: `${NAMES.ana} beat ${NAMES.ben} ${p.headline}` };
  });
  const decided = module.reachableDecidedIn(cfg, "league");
  const beyond = (["ot", "so"] as const)
    .filter((d) => decided.has(d))
    .map((d): Tagged<Beyond> => {
      const p = play(module, cfg, `${variantKey} win in ${d}`, ["ana", "ben"], (o) => o.kind === "win" && o.winner === "ana" && decidedInFor(module, o) === d);
      const [winner, loser] = winnerLoserPoints(p);
      return { tag: d, winner, loser, line: `${NAMES.ana} beat ${NAMES.ben} in ${BEYOND_WORDS[d]}, ${p.headline}` };
    });
  const reach = module.reachableResultKinds(cfg, "league");
  const levels = levelKindsOf(module, variantKey, reach).map((kind): LevelRun => {
    const p = play(module, cfg, `${variantKey} ${kind}`, ["cy", "dev"], (o) => o.kind === OUTCOME_OF[kind]);
    const [a, b] = p.paid;
    if (a.points !== b.points) throw new Error(`${module.key}: a ${kind} paid ${a.points} and ${b.points}`);
    return { kind, points: a.points, line: `${NAMES.cy} and ${NAMES.dev}, ${LEVEL_WORDS[kind]}, ${p.headline}` };
  });
  return { rowId, variantKey, unit: rules.points.unit, wins, beyond, levels, rankedBy: tiebreakLabel(rules.tiebreakers[0]!) };
}

// ---- how a run prints (build side) ----

function groupBy<T>(items: T[], keyOf: (t: T) => string): T[][] {
  const groups: T[][] = [];
  for (const it of items) {
    const g = groups.find((x) => keyOf(x[0]!) === keyOf(it));
    if (g) g.push(it);
    else groups.push([it]);
  }
  return groups;
}

function joinOr(words: string[]): string {
  return words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}

function sideCell(wins: Tagged<string | null>[], side: "winner" | "loser", unit: "whole" | "half"): string {
  const groups = groupBy(wins, (w) => `${w.winner}/${w.loser}`);
  if (groups.length === 1) return pointsText(groups[0]![0]![side], unit);
  return groups.map((g) => `${pointsText(g[0]![side], unit)} (${g.map((w) => w.tag).join(" or ")})`).join(", ");
}

function nobodyCell(levels: LevelRun[], unit: "whole" | "half"): string {
  if (levels.length === 0) return NOT_POSSIBLE;
  if (levels.length === 1 && levels[0]!.kind === "draw") return pointsText(levels[0]!.points, unit);
  return groupBy(levels, (l) => String(l.points))
    .map((g) => `${pointsText(g[0]!.points, unit)} (${joinOr(g.map((l) => LEVEL_WORDS[l.kind]))})`)
    .join(", ");
}

function beyondCell(beyond: Tagged<Beyond>[], unit: "whole" | "half"): string {
  if (beyond.length === 0) return NOT_POSSIBLE;
  return groupBy(beyond, (b) => `${b.winner}/${b.loser}`)
    .map((g) => `winner ${pointsText(g[0]!.winner, unit)}, loser ${pointsText(g[0]!.loser, unit)} (${joinOr(g.map((b) => BEYOND_WORDS[b.tag]))})`)
    .join("; ");
}

const rowIdOf = (key: string, variantKey: string, isStart: boolean) => (isStart ? key : `${key}${compact(variantKey)}`);

function cellsOf(label: string, run: Run): (string | number)[] {
  return [label, sideCell(run.wins, "winner", run.unit), sideCell(run.wins, "loser", run.unit), nobodyCell(run.levels, run.unit), beyondCell(run.beyond, run.unit), upperFirst(run.rankedBy)];
}

/** Whether a variant's declarations differ from the starting one's in anything a cell prints (the decision to play it). */
function declaredDifferently(module: AnySportModule, a: Cfg, b: Cfg): boolean {
  const view = (cfg: Cfg) =>
    JSON.stringify([
      module.tablePointsRule(cfg as never, "league"),
      [...module.reachableResultKinds(cfg as never, "league")].sort(),
      module.reachableSetScores?.(cfg as never) ?? null,
      [...module.reachableDecidedIn(cfg as never, "league")].sort(),
      module.primaryTableKey,
    ]);
  return view(a) !== view(b);
}

function build(): ExampleResult {
  const facts: ExampleResult["facts"] = {};
  const rows: (string | number)[][] = [];
  const text: string[] = [
    "Each row comes from real matches scored the way a division scores them: Ana beats Ben, and where the sport can end a match with nobody winning, Cy and Dev finish that way.",
  ];
  const visited = forEachSport(({ module }) => {
    const key = module.key;
    const startKey = startingVariantKey(module);
    const variants = variantsOf(module);
    const start = variants.find((v) => v.key === startKey);
    if (start === undefined) throw new Error(`${key}: the starting variant '${startKey}' is not one of the sport's variants`);
    const runs: Run[] = [runVariant(module, start.key, start.cfg, rowIdOf(key, start.key, true))];
    for (const v of variants) {
      if (v.key === start.key || !declaredDifferently(module, start.cfg, v.cfg)) continue;
      const run = runVariant(module, v.key, v.cfg, rowIdOf(key, v.key, false));
      // A variant that differs only in what a cell never prints gets no row.
      if (JSON.stringify(cellsOf("", run)) !== JSON.stringify(cellsOf("", runs[0]!))) runs.push(run);
    }
    for (const run of runs) {
      const label = runs.length > 1 ? `${sportLabel(key)} (${variantLabel(key, run.variantKey)})` : sportLabel(key);
      for (const w of run.wins) {
        facts[`${run.rowId}Win${scoreSuffix(w.tag)}`] = pointsText(w.winner, run.unit);
        facts[`${run.rowId}Loss${scoreSuffix(w.tag)}`] = pointsText(w.loser, run.unit);
        text.push(`${label}: ${w.line}.`);
      }
      for (const b of run.beyond) {
        facts[`${run.rowId}Win${upperFirst(b.tag)}`] = pointsText(b.winner, run.unit);
        facts[`${run.rowId}Loss${upperFirst(b.tag)}`] = pointsText(b.loser, run.unit);
        text.push(`${label}: ${b.line}.`);
      }
      for (const l of run.levels) {
        facts[`${run.rowId}${upperFirst(l.kind)}`] = pointsText(l.points, run.unit);
        text.push(`${label}: ${l.line}.`);
      }
      facts[`${run.rowId}RankedBy`] = run.rankedBy;
      rows.push(cellsOf(label, run));
    }
  });
  facts.sportCount = visited;
  return {
    facts,
    table: { caption: "What one finished match is worth in the standings, by sport and variant.", columns: COLUMNS, rows },
    text,
  };
}

// ---- claims: every expected value below is recomputed from the sport module's own declarations ----

interface ExpectedRow {
  rowId: string;
  label: string;
  cells: string[];
  facts: Record<string, string>;
}

/** The rows the declarations say the table must hold for a sport, and every fact each one carries. */
function expectedRows(module: AnySportModule): ExpectedRow[] {
  const key = module.key;
  const startKey = startingVariantKey(module);
  const per = variantsOf(module).map(({ key: variantKey, cfg }) => {
    const rule = module.tablePointsRule(cfg as never, "league");
    const unit = rule.unit;
    const fmt = (n: number) => pointsText(n, unit);
    const facts: Record<string, string> = {};
    const id = variantKey === startKey ? key : `${key}${compact(variantKey)}`;

    // winner / loser, by set score where the sport keeps one
    const scores: readonly (string | null)[] = module.reachableSetScores?.(cfg as never) ?? [null];
    const winPairs = new Map<string, { w: number; l: number; tags: string[] }>();
    for (const score of scores) {
      let w = rule.win.regulation;
      let l = rule.loss.regulation;
      if (rule.bySetScore !== undefined && score !== null) {
        const hit = rule.bySetScore[score] ?? rule.bySetScore["*"];
        if (hit === undefined) throw new Error(`${key}/${variantKey}: the declared rule pays no ${score}`);
        [w, l] = hit;
      }
      facts[`${id}Win${scoreSuffix(score)}`] = fmt(w);
      facts[`${id}Loss${scoreSuffix(score)}`] = fmt(l);
      const g = winPairs.get(`${w}/${l}`) ?? { w, l, tags: [] };
      g.tags.push(String(score));
      winPairs.set(`${w}/${l}`, g);
    }
    const flat = winPairs.size === 1;
    const side = (pick: "w" | "l") => (flat ? fmt([...winPairs.values()][0]![pick]) : [...winPairs.values()].map((g) => `${fmt(g[pick])} (${g.tags.join(" or ")})`).join(", "));

    // nobody wins
    const reach = module.reachableResultKinds(cfg as never, "league");
    const lv = new Map<string, string[]>();
    const kinds = levelKindsOf(module, variantKey, reach);
    for (const k of kinds) {
      const declared = rule[k];
      if (declared === undefined) throw new Error(`${key}/${variantKey}: the rule declares no points for ${k}`);
      facts[`${id}${upperFirst(k)}`] = fmt(declared);
      lv.set(String(declared), [...(lv.get(String(declared)) ?? []), LEVEL_WORDS[k]]);
    }
    const nobody =
      kinds.length === 0 ? NOT_POSSIBLE : kinds.length === 1 && kinds[0] === "draw" ? fmt(rule.draw!) : [...lv.entries()].map(([pts, ws]) => `${fmt(Number(pts))} (${joinOr(ws)})`).join(", ");

    // overtime and shoot-out: the rule's own fallback chain so -> ot -> regulation (points.d.ts), or the draw plus a bonus
    const decided = module.reachableDecidedIn(cfg as never, "league");
    const bp = new Map<string, { w: number; l: number; tags: string[] }>();
    for (const d of ["ot", "so"] as const) {
      if (!decided.has(d)) continue;
      const bonus = rule.shootoutAs === "draw_plus_bonus" && d === "so";
      const w = bonus ? rule.draw! + (rule.soBonus ?? 1) : d === "so" ? (rule.win.so ?? rule.win.ot ?? rule.win.regulation) : (rule.win.ot ?? rule.win.regulation);
      const l = bonus ? rule.draw! : d === "so" ? (rule.loss.so ?? rule.loss.ot ?? rule.loss.regulation) : (rule.loss.ot ?? rule.loss.regulation);
      facts[`${id}Win${upperFirst(d)}`] = fmt(w);
      facts[`${id}Loss${upperFirst(d)}`] = fmt(l);
      const g = bp.get(`${w}/${l}`) ?? { w, l, tags: [] };
      g.tags.push(BEYOND_WORDS[d]);
      bp.set(`${w}/${l}`, g);
    }
    const beyond = bp.size === 0 ? NOT_POSSIBLE : [...bp.values()].map((g) => `winner ${fmt(g.w)}, loser ${fmt(g.l)} (${joinOr(g.tags)})`).join("; ");

    const first = tiebreakLabel(module.primaryTableKey);
    facts[`${id}RankedBy`] = first;
    return { variantKey, id, facts, cells: [side("w"), side("l"), nobody, beyond, upperFirst(first)] };
  });
  const start = per.find((p) => p.variantKey === startKey);
  if (start === undefined) throw new Error(`${key}: the starting variant '${startKey}' is not declared`);
  const shown = [start, ...per.filter((p) => p.variantKey !== startKey && p.cells.join("|") !== start.cells.join("|"))];
  return shown.map((p) => ({
    rowId: p.id,
    label: shown.length > 1 ? `${sportLabel(key)} (${variantLabel(key, p.variantKey)})` : sportLabel(key),
    cells: p.cells,
    facts: p.facts,
  }));
}

/** The table rows that belong to a sport: its plain name, or its name with a variant in brackets. */
const rowsOfSport = (result: ExampleResult, sport: string) =>
  (result.table?.rows ?? []).filter((r) => r[C.sport] === sport || String(r[C.sport]).startsWith(`${sport} (`));

const isFactOf = (suffix: RegExp) => (k: string, rowId: string) => k.startsWith(rowId) && suffix.test(k.slice(rowId.length));

function claimsFor(module: AnySportModule): Claim[] {
  const sport = sportLabel(module.key);
  const expected = expectedRows(module);
  const mine = (says: string, source: string, check: Claim["check"]): Claim => ({ says: `${sport}: ${says}`, source, sport: module.key, check });
  /** Every expected row, found by label, compared on the given columns and on the facts `pick` selects. */
  const perRow =
    (columns: number[], pick: (key: string, rowId: string) => boolean): Claim["check"] =>
    (result) => {
      for (const e of expected) {
        const row = (result.table?.rows ?? []).find((r) => r[C.sport] === e.label);
        if (row === undefined) return `no row '${e.label}'`;
        for (const c of columns) if (row[c] !== e.cells[c - 1]) return `${e.label}: '${COLUMNS[c]}' is ${String(row[c])}, the declaration gives ${e.cells[c - 1]}`;
        for (const [k, v] of Object.entries(e.facts)) if (pick(k, e.rowId) && result.facts[k] !== v) return `fact ${k} is ${String(result.facts[k])}, the declaration gives ${v}`;
      }
      return true;
    };
  const level = isFactOf(/^(Draw|Tie|NoResult)$/);
  return [
    mine("one row for the variant a new division starts on, and one for each other variant whose points differ", "pickVariant (the builder) and tablePointsRule(cfg, \"league\") of every variant", (r) => {
      const got = rowsOfSport(r, sport).map((x) => String(x[C.sport]));
      const want = expected.map((e) => e.label);
      return JSON.stringify(got) === JSON.stringify(want) || `rows are [${got.join("; ")}], the declarations give [${want.join("; ")}]`;
    }),
    mine("the winner's and the loser's points are what the rule pays", "tablePointsRule(cfg, \"league\") (win, loss, bySetScore)", perRow([C.winner, C.loser], isFactOf(/^(Win|Loss)\d*$/))),
    mine("a match nobody wins pays what the rule pays each side, or is not possible", "reachableResultKinds(cfg, \"league\") and tablePointsRule(cfg, \"league\").draw / .tie / .noResult", (r) => {
      const v = perRow([C.nobody], level)(r);
      if (v !== true) return v;
      // A level fact exists exactly where the declaration reaches one.
      for (const e of expected) {
        const have = Object.keys(r.facts).filter((k) => level(k, e.rowId)).sort();
        const want = Object.keys(e.facts).filter((k) => level(k, e.rowId)).sort();
        if (have.join() !== want.join()) return `${e.label}: level facts are [${have}], the declaration gives [${want}]`;
      }
      return true;
    }),
    mine("overtime and shoot-out pay what the rule's chain pays, or are not possible", "reachableDecidedIn(cfg, \"league\") and tablePointsRule(cfg, \"league\") (ot, so, soBonus)", perRow([C.beyond], isFactOf(/^(Win|Loss)(Ot|So)$/))),
    mine("the table is sorted first by the sport's primary key", "primaryTableKey", perRow([C.sorted], isFactOf(/^RankedBy$/))),
  ];
}

/** Example-wide claims: what the post says ACROSS sports (no `sport`), read from the registry's declarations. */
function acrossSports(): Claim[] {
  return [
    {
      says: "every sport sorts its table first by points or by matches won, points in more sports than wins, and wins in at least two",
      source: "primaryTableKey of every sport module",
      check(result) {
        const declared: Record<string, number> = {};
        forEachSport(({ module }) => {
          const label = upperFirst(tiebreakLabel(module.primaryTableKey));
          declared[label] = (declared[label] ?? 0) + 1;
        });
        const keys = Object.keys(declared).sort().join(",");
        if (keys !== "Points,Wins") return `the registry declares first keys [${keys}], the post says points and wins`;
        if (!((declared.Points ?? 0) > (declared.Wins ?? 0))) return `points (${declared.Points}) must be more sports than wins (${declared.Wins})`;
        if ((declared.Wins ?? 0) < 2) return `wins is first in ${declared.Wins} sport(s); the post says a few`;
        // The table agrees: the rows show exactly the declared keys.
        const shown = new Set((result.table?.rows ?? []).map((r) => String(r[C.sorted])));
        return [...shown].sort().join(",") === keys || `the table shows [${[...shown].sort()}]`;
      },
    },
    {
      says: "the table holds the sports of the registry, in registry order, and counts them",
      source: "the sport registry (builtinModules, via forEachSport)",
      check(result) {
        const labels: string[] = [];
        const visited = forEachSport(({ module }) => labels.push(sportLabel(module.key)));
        const seen: string[] = [];
        for (const r of result.table?.rows ?? []) {
          const name = String(r[C.sport]).replace(/ \(.*\)$/, "");
          if (seen[seen.length - 1] !== name) seen.push(name);
        }
        if (result.facts.sportCount !== visited) return `sportCount is ${String(result.facts.sportCount)}, the registry has ${visited}`;
        return JSON.stringify(seen) === JSON.stringify(labels) || `sports are ${seen.join(", ")}, the registry is ${labels.join(", ")}`;
      },
    },
  ];
}

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
