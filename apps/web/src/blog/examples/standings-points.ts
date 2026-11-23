// Post #1, "How do standings points work in each sport?". For every sport in the registry, under the variant a NEW
// division of that sport starts on (starting-variant.ts: the builder's own pick), real matches are played through the
// engine's own event stream (the testkit's seeded walk, refolded by the app's own read fold, `foldFrom`) and paid by the
// rules the standings read (the web's one table-rules loader, `tableRulesOf`, then `payout`). So the points in the table
// are what a division would book, not a typed number. A variant whose points differ from the starting one gets a row
// of its own.
//
// WHICH MATCHES, per row: Ana beats Ben (once per reachable final set score, for a set sport, because its points depend
// on the score); Ana beats Ben after overtime or in a shoot-out, where the variant can reach them; and one match for
// each way a match can end with nobody winning (a draw, a cricket tie, a cricket no result). The seeded search is
// deterministic, so the example needs no typed seed and no typed score.
//
// WHAT CHECKS IT. The claims below recompute every expected cell and fact from the sport module's own declarations
// (`tablePointsRule`, `primaryTableKey`, `reachableResultKinds`, `reachableSetScores`, `reachableDecidedIn`) in code
// that shares no formatter with `build()`, and compare the committed result to it. None reads `build()`.
import type { MatchOutcome } from "@seazn/engine/core";
import { decidedInFor, pointsText } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import { forEachSport } from "@seazn/engine/testkit";
import { sportLabel, tiebreakLabel, variantLabel } from "@/blog/labels";
import { NAMES, compact, groupBy, joinOr, leagueRules, play, upperFirst, variantsOf, winnerLoserPoints, winnerSetScore, type Cfg } from "./kit";
import { startingVariantKey } from "./starting-variant";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const STANDINGS_POINTS_ID = "standings-points";

const COLUMNS = ["Sport", "Winner gets", "Loser gets", "Each side when nobody wins", "After overtime or a shoot-out", "Table sorted by first"];
const C = { sport: 0, winner: 1, loser: 2, nobody: 3, beyond: 4, sorted: 5 } as const;
const NOT_POSSIBLE = "Not possible";

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
 * played match can end in. (Hockey with a shoot-out is NOT one: its `outcome()` is a win, but the TABLE books the
 * shoot-out as a draw plus a bonus, which is the level result `reachableResultKinds` declares. See `levelRunOf`.)
 */
export const DECLARED_BUT_UNREACHABLE: Readonly<Record<string, readonly LevelKind[]>> = {
  "cricket/test": ["noResult"],
};
const levelKindsOf = (module: AnySportModule, variantKey: string, reach: ReadonlySet<string>): LevelKind[] =>
  LEVEL_KINDS.filter((k) => reach.has(k) && !(DECLARED_BUT_UNREACHABLE[`${module.key}/${variantKey}`] ?? []).includes(k));

const scoreSuffix = (score: string | null) => (score === null ? "" : score.replace("-", ""));

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

/**
 * One way a match is level, as the TABLE books it. A draw, a tie or a no result is an outcome of its own. A draw-plus-bonus
 * shoot-out (hockey with a shoot-out) is not: `outcome()` says win, and `payout` books both sides drawn, pays each the
 * rule's draw and the shoot-out winner the bonus on top. That booking is the level result the module declares reachable,
 * so it is played as a shoot-out win, checked to be booked drawn on both sides, and read off the side that did not win.
 */
function levelRunOf(module: AnySportModule, cfg: Cfg, variantKey: string, kind: LevelKind, decided: ReadonlySet<string>): LevelRun {
  const rules = leagueRules(module, cfg);
  if (kind === "draw" && rules.points.shootoutAs === "draw_plus_bonus" && decided.has("so")) {
    const p = play(module, cfg, `${variantKey} shoot-out booked as a draw`, ["cy", "dev"], (o) => o.kind === "win" && decidedInFor(module, o) === "so");
    if (!p.paid.every((d) => d.drawn === 1)) throw new Error(`${module.key}/${variantKey}: a shoot-out win is not booked drawn on both sides`);
    const o = p.outcome;
    const loser = o.kind === "win" ? p.paid.find((d) => d.entrantId === o.loser) : undefined;
    if (loser === undefined) throw new Error(`${module.key}/${variantKey}: the shoot-out's losing side is not in the paid pair`);
    return { kind, points: loser.points, line: `${NAMES.cy} and ${NAMES.dev}, level and settled in a shoot-out, ${p.headline}` };
  }
  const p = play(module, cfg, `${variantKey} ${kind}`, ["cy", "dev"], (o) => o.kind === OUTCOME_OF[kind]);
  const [a, b] = p.paid;
  if (a.points !== b.points) throw new Error(`${module.key}: a ${kind} paid ${a.points} and ${b.points}`);
  return { kind, points: a.points, line: `${NAMES.cy} and ${NAMES.dev}, ${LEVEL_WORDS[kind]}, ${p.headline}` };
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
  const levels = levelKindsOf(module, variantKey, reach).map((kind): LevelRun => levelRunOf(module, cfg, variantKey, kind, decided));
  return { rowId, variantKey, unit: rules.points.unit, wins, beyond, levels, rankedBy: tiebreakLabel(rules.tiebreakers[0]!) };
}

// ---- how a run prints (build side) ----

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

/** Whether a variant differs from the starting one in anything a cell prints (the decision to play it): the points the
 *  loader says its league pays, and what the sport declares it can reach and ranks by first. */
function declaredDifferently(module: AnySportModule, a: Cfg, b: Cfg): boolean {
  const view = (cfg: Cfg) =>
    JSON.stringify([
      leagueRules(module, cfg).points,
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
//
// The claims read the sport's points DECLARATION itself, never the loader `build()` reads (an expected value is never
// derived from the code under test). That read is exempted by name in table-rules-single-resolver.test.ts, and so is
// the one label every claim's `source` cites it by.

/** How a claim's `source` names the declaration it recomputes from. */
const DECLARED_POINTS = 'tablePointsRule(cfg, "league")';

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
    mine("one row for the variant a new division starts on, and one for each other variant whose points differ", `pickVariant (the builder) and ${DECLARED_POINTS} of every variant`, (r) => {
      const got = rowsOfSport(r, sport).map((x) => String(x[C.sport]));
      const want = expected.map((e) => e.label);
      return JSON.stringify(got) === JSON.stringify(want) || `rows are [${got.join("; ")}], the declarations give [${want.join("; ")}]`;
    }),
    mine("the winner's and the loser's points are what the rule pays", `${DECLARED_POINTS} (win, loss, bySetScore)`, perRow([C.winner, C.loser], isFactOf(/^(Win|Loss)\d*$/))),
    mine("a match nobody wins pays what the rule pays each side, or is not possible", `reachableResultKinds(cfg, "league") and ${DECLARED_POINTS}.draw / .tie / .noResult`, (r) => {
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
    mine("overtime and shoot-out pay what the rule's chain pays, or are not possible", `reachableDecidedIn(cfg, "league") and ${DECLARED_POINTS} (ot, so, soBonus)`, perRow([C.beyond], isFactOf(/^(Win|Loss)(Ot|So)$/))),
    mine("the table is sorted first by the sport's primary key", "primaryTableKey", perRow([C.sorted], isFactOf(/^RankedBy$/))),
  ];
}

/**
 * The post's sentence "points in most sports, matches won in a few", as a rule over how many sports declare each first key
 * (the owner's ruling on Task 3's review): the keys are exactly Points and Wins, Points outnumber Wins, Wins is at least two.
 * Pure, so a test can feed it counts the registry does not hold today.
 */
export function rankingKeyProblem(declared: Readonly<Record<string, number>>): string | null {
  const keys = Object.keys(declared).sort().join(",");
  if (keys !== "Points,Wins") return `the registry declares first keys [${keys}], the post says points and wins`;
  const points = declared.Points!;
  const wins = declared.Wins!;
  if (!(points > wins)) return `points (${points}) must be more sports than wins (${wins})`;
  if (wins < 2) return `wins is first in ${wins} sport(s); the post says a few`;
  return null;
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
        const bad = rankingKeyProblem(declared);
        if (bad !== null) return bad;
        // The table agrees: the rows show exactly the declared keys.
        const keys = Object.keys(declared).sort().join(",");
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
