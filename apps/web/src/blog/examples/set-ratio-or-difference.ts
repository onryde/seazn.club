// Post #10, "Set ratio or set difference: which does my sport use?".
//
// THE TABLE, badminton (the sport that ranks by set difference): four players play a real round robin (seeded walks,
// refolded by the app's read fold) in which Ana, Ben and Cy each win two matches. Their set records give Ana and Ben the
// same set DIFFERENCE but different set RATIOS. Ranked through the app's ranking path twice: by badminton's own order
// (difference, then the match between the two still level), and by the same order with ratios in place of differences.
// The two put a different player first. The difference and ratio cells are the public table's own text (`derivedText`).
//
// THE FACTS, every sport: which set, game, board or point measures its declared league order uses, in order.
//
// WHAT CHECKS IT. The difference and ratio cells are recomputed from the sets cells (won minus lost, won over lost); the
// places are recomputed from the cells by BWF General Competition Regulations 16.2 (wins; for two level, their match; for
// three or more, set difference, then the match of any two left level); the per-sport facts read each module's DECLARED
// order (`defaultOrderOf`), never the loader `build()` reads.
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule, TiebreakerKey } from "@seazn/engine/sport";
import { declaredCfgs, defaultOrderOf, forEachSport } from "@seazn/engine/testkit";
import { sportLabel, tiebreakLabel } from "@/blog/labels";
import { derivedText } from "@/server/public-site/standings-view";
import { startingVariantKey } from "./starting-variant";
import { factsRepeatTheTable, placeOf, placeText, playAndRank, scoreOf, rowOf, stageRules, type MatchView, type Meeting } from "./tie-break-play";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const SET_RATIO_OR_DIFFERENCE_ID = "set-ratio-or-difference";

export const COLUMNS = ["Player", "Matches won", "Sets won", "Sets lost", "Set difference", "Set ratio", "Place, badminton's order", "Place, with set ratio instead"];
export const C = { player: 0, won: 1, setsWon: 2, setsLost: 3, diff: 4, ratio: 5, own: 6, ratioOrder: 7 } as const;

const PLAYERS = [
  { id: "ana", name: "Ana" },
  { id: "ben", name: "Ben" },
  { id: "cy", name: "Cy" },
  { id: "dev", name: "Dev" },
];
const nameOf = (id: string) => PLAYERS.find((p) => p.id === id)!.name;
const sets = (h: number, a: number) => (v: MatchView) => v.home.metrics.sets_won === h && v.away.metrics.sets_won === a;

/** Ana beat Ben, Ben beat Cy, Cy beat Ana (taking a set off her), and all three beat Dev, Ana dropping a set to him. */
const MEETINGS: Meeting[] = [
  { home: "ana", away: "ben", what: "Ana beats Ben 2-0", seed: 7, want: sets(2, 0) },
  { home: "ben", away: "cy", what: "Ben beats Cy 2-0", seed: 7, want: sets(2, 0) },
  { home: "cy", away: "ana", what: "Cy beats Ana 2-1", seed: 11, want: sets(2, 1) },
  { home: "ana", away: "dev", what: "Ana beats Dev 2-1", seed: 11, want: sets(2, 1) },
  { home: "ben", away: "dev", what: "Ben beats Dev 2-0", seed: 7, want: sets(2, 0) },
  { home: "cy", away: "dev", what: "Cy beats Dev 2-0", seed: 7, want: sets(2, 0) },
];

/** The measures a league order compares sets, games, boards or points by. */
const MEASURES: ReadonlySet<string> = new Set(["set_diff", "point_diff", "set_ratio", "point_ratio", "game_ratio", "board_ratio", "h2h_set_ratio", "h2h_point_ratio"]);

/** The measures of an order, in a reader's words. */
export function measureWords(order: readonly TiebreakerKey[]): string {
  const found = order.filter((k) => MEASURES.has(k));
  return found.length === 0 ? "no set or point measure" : found.map(tiebreakLabel).join(", then ");
}

/** Badminton's own order with each difference swapped for the ratio of the same ledger (and nothing else moved). */
function ratioOrder(order: readonly TiebreakerKey[]): TiebreakerKey[] {
  return order.map((k) => (k === "set_diff" ? "set_ratio" : k === "point_diff" ? "point_ratio" : k));
}

const badminton = () => builtinModules.find((m) => m.key === "badminton")!;

function build(): ExampleResult {
  const sport = badminton();
  const cfg = declaredCfgs(sport).find((c) => c.name === startingVariantKey(sport))!.cfg;
  const own = playAndRank({ module: sport, cfg, kind: "league", entrants: PLAYERS, meetings: MEETINGS });
  const swapped = ratioOrder(own.rules.tiebreakers);
  const ratio = playAndRank({ module: sport, cfg, kind: "league", entrants: PLAYERS, meetings: MEETINGS, stageOrder: swapped });
  const lines = (r: typeof own) => r.played.map((p) => `${nameOf(p.meeting.home)} ${p.view.headline} ${nameOf(p.meeting.away)}`);
  if (JSON.stringify(lines(own)) !== JSON.stringify(lines(ratio))) throw new Error("set-ratio-or-difference: the two rankings played different matches");

  const rows = [...own.rows]
    .sort((a, b) => a.rank! - b.rank!)
    .map((r) => [
      nameOf(r.entrantId),
      r.won,
      r.metrics.sets_won ?? 0,
      r.metrics.sets_lost ?? 0,
      derivedText(r, "set_diff", own.layout),
      derivedText(r, "set_ratio", own.layout),
      placeText(r.rank!),
      placeText(rowOf(ratio.rows, r.entrantId).rank!),
    ]);

  const facts: ExampleResult["facts"] = {};
  for (const p of PLAYERS) {
    const r = rowOf(own.rows, p.id);
    facts[`${p.id}SetDifference`] = derivedText(r, "set_diff", own.layout);
    facts[`${p.id}SetRatio`] = derivedText(r, "set_ratio", own.layout);
    facts[`${p.id}PlaceOwn`] = placeText(r.rank!);
    facts[`${p.id}PlaceRatio`] = placeText(rowOf(ratio.rows, p.id).rank!);
  }
  facts.levelWins = rowOf(own.rows, "ana").won;
  facts.anaBeatBen = own.played.find((p) => p.meeting.home === "ana" && p.meeting.away === "ben")!.view.headline;
  facts.ownSplitBy = tiebreakLabel(rowOf(own.rows, "ana").tieBreak?.key ?? "wins");
  facts.ratioSplitBy = tiebreakLabel(rowOf(ratio.rows, "ben").tieBreak?.key ?? "wins");
  const visited = forEachSport(({ module: m }) => {
    const order = stageRules(m, declaredCfgs(m).find((c) => c.name === startingVariantKey(m))!.cfg, "league").tiebreakers;
    facts[`${m.key}Measures`] = measureWords(order);
  });
  facts.sportCount = visited;
  return {
    facts,
    table: {
      caption: "Ana, Ben and Cy each win two matches. Badminton's set difference puts Ana first; the same results ranked by set ratio put Ben first.",
      columns: COLUMNS,
      rows,
    },
    text: [...lines(own).map((l) => `${l}.`), ...sportLines(facts)],
  };
}

function sportLines(facts: ExampleResult["facts"]): string[] {
  const out: string[] = [];
  forEachSport(({ module }) => out.push(`${sportLabel(module.key)}: ${String(facts[`${module.key}Measures`])}.`));
  return out;
}

// ---- claims ----

const placeNum = placeOf;
const ratioNum = (v: unknown) => Number(String(v));

/** BWF GCR 16.2, from the cells: wins; two level, their match; three or more, set difference, then two left, their match. */
function bwfPlaces(r: ExampleResult): Map<string, number> | string {
  const rows = r.table?.rows ?? [];
  const beat = scoreOf(r.facts.anaBeatBen);
  if (beat === null) return "no Ana-Ben result";
  const anaBeatBen = beat[0] > beat[1];
  const meeting = (a: string, b: string): number => {
    const pair = new Set([a, b]);
    if (pair.has("Ana") && pair.has("Ben")) return (a === "Ana") === anaBeatBen ? -1 : 1;
    return 0;
  };
  const diff = (x: (string | number)[]) => Number(x[C.setsWon]) - Number(x[C.setsLost]);
  const groups = new Map<number, (string | number)[][]>();
  for (const x of rows) groups.set(Number(x[C.won]), [...(groups.get(Number(x[C.won])) ?? []), x]);
  const out: (string | number)[][] = [];
  for (const w of [...groups.keys()].sort((a, b) => b - a)) {
    const g = groups.get(w)!;
    if (g.length === 2) g.sort((a, b) => meeting(String(a[C.player]), String(b[C.player])));
    else
      g.sort((a, b) => {
        if (diff(a) !== diff(b)) return diff(b) - diff(a);
        return meeting(String(a[C.player]), String(b[C.player]));
      });
    out.push(...g);
  }
  return new Map(out.map((x, i) => [String(x[C.player]), i + 1]));
}

const caseClaims: Claim[] = [
  {
    says: "each set difference cell is sets won minus sets lost, and each set ratio cell sets won over sets lost",
    source: "BWF GCR 16.2.3 (games difference) and the set ratio's definition, over the row's own cells",
    check(r) {
      for (const x of r.table?.rows ?? []) {
        const w = Number(x[C.setsWon]);
        const l = Number(x[C.setsLost]);
        if (Number(String(x[C.diff]).replace("+", "")) !== w - l) return `${String(x[C.player])}: difference cell ${String(x[C.diff])}, sets ${w}-${l}`;
        if (l > 0 && Math.abs(ratioNum(x[C.ratio]) - w / l) > 0.005) return `${String(x[C.player])}: ratio cell ${String(x[C.ratio])}, sets ${w}-${l}`;
      }
      return (r.table?.rows.length ?? 0) === PLAYERS.length || "rows missing";
    },
  },
  {
    says: "three players are level on matches won, and two of them share a set difference but not a set ratio",
    source: "the case's premise, read off the table (what makes the two measures disagree)",
    check(r) {
      const rows = r.table?.rows ?? [];
      const top = rows.filter((x) => x[C.won] === r.facts.levelWins);
      if (top.length !== 3) return `${top.length} players on ${String(r.facts.levelWins)} wins`;
      const ana = rows.find((x) => x[C.player] === "Ana");
      const ben = rows.find((x) => x[C.player] === "Ben");
      if (ana === undefined || ben === undefined) return "Ana or Ben missing";
      if (ana[C.diff] !== ben[C.diff]) return "Ana and Ben differ on set difference";
      return ana[C.ratio] !== ben[C.ratio] || "Ana and Ben share a set ratio";
    },
  },
  {
    says: "badminton's own order is wins, then for two level their match, then set difference (BWF 16.2), and its places are the rulebook's",
    source: "defaultOrderOf(badminton, \"league\") and BWF GCR 16.2, over the table's cells",
    check(r) {
      const declared = defaultOrderOf(badminton(), "league");
      if (declared[0] !== "wins" || declared[1] !== "h2h_two" || declared[2] !== "set_diff") return `badminton declares [${declared.join(", ")}]`;
      const want = bwfPlaces(r);
      if (typeof want === "string") return want;
      for (const x of r.table?.rows ?? []) if (placeNum(x[C.own]) !== want.get(String(x[C.player]))) return `${String(x[C.player])}: ${String(x[C.own])}, BWF gives ${want.get(String(x[C.player]))}`;
      return true;
    },
  },
  {
    says: "with ratios in place of differences, the three level players rank by set ratio, and someone else is first (class 19)",
    source: "the set ratio's definition over the table's cells",
    check(r) {
      const rows = r.table?.rows ?? [];
      const level = rows.filter((x) => x[C.won] === r.facts.levelWins);
      const byRatio = [...level].sort((a, b) => Number(b[C.setsWon]) / Number(b[C.setsLost]) - Number(a[C.setsWon]) / Number(a[C.setsLost]));
      for (const [i, x] of byRatio.entries()) if (placeNum(x[C.ratioOrder]) !== i + 1) return `${String(x[C.player])}: ${String(x[C.ratioOrder])}, the ratio gives ${i + 1}`;
      const firstOwn = rows.find((x) => placeNum(x[C.own]) === 1)?.[C.player];
      const firstRatio = rows.find((x) => placeNum(x[C.ratioOrder]) === 1)?.[C.player];
      return firstOwn !== firstRatio || `both orders put ${String(firstOwn)} first`;
    },
  },
];

function sportClaim(module: AnySportModule): Claim {
  return {
    says: `${sportLabel(module.key)}: the measures fact names the measures of the sport's declared league order, in order`,
    source: "defaultOrderOf(module, \"league\")",
    sport: module.key,
    check(r) {
      const want = measureWords(defaultOrderOf(module, "league"));
      return r.facts[`${module.key}Measures`] === want || `fact '${String(r.facts[`${module.key}Measures`])}', declared '${want}'`;
    },
  };
}

const claims: Claim[] = [
  ...caseClaims,
  factsRepeatTheTable(PLAYERS, C.player, { SetDifference: C.diff, SetRatio: C.ratio, PlaceOwn: C.own, PlaceRatio: C.ratioOrder }),
  {
    says: "Ana and Ben are split by their match under badminton's order, and by set ratio once ratios replace differences",
    source: "defaultOrderOf(badminton, \"league\") (head-to-head between the two) and set ratio's place in the swapped order",
    check(r) {
      if (r.facts.ownSplitBy !== tiebreakLabel("h2h_two")) return `ownSplitBy ${String(r.facts.ownSplitBy)}`;
      return r.facts.ratioSplitBy === tiebreakLabel("set_ratio") || `ratioSplitBy ${String(r.facts.ratioSplitBy)}`;
    },
  },
  {
    says: "the per-sport measures cover the whole registry, and count it",
    source: "the sport registry (forEachSport)",
    check(r) {
      const visited = forEachSport(() => {});
      return r.facts.sportCount === visited || `sportCount ${String(r.facts.sportCount)}, registry ${visited}`;
    },
  },
];
if (forEachSport(({ module }) => claims.push(sportClaim(module))) === 0) throw new Error("set-ratio-or-difference: the sport registry is empty");

export const setRatioOrDifference: BlogExample = {
  id: SET_RATIO_OR_DIFFERENCE_ID,
  kind: "engine",
  sports: "all",
  build,
  claims,
};
