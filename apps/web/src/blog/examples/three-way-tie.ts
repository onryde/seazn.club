// Post #8, "Three teams are level: how does head-to-head work?".
//
// THE TABLE, football: four teams play a real round robin (seeded walks, refolded by the app's read fold) in which Hawks,
// Rockets and Comets all finish on the same points and beat each other in a circle. Among the three, Comets score the
// fewest goals, so the head-to-head steps put them third of the three, and leave Hawks and Rockets level on every
// head-to-head count. What happens next is where football's two orders part:
//   - football's own order (FIFA 2026) runs the head-to-head steps ONCE, then goes to overall goal difference;
//   - the UEFA order it also offers RE-APPLIES the head-to-head steps to the two still level: their own match decides.
// The same results are ranked under both, through the app's ranking path, and the two orders put a different team top.
//
// THE FACTS, every sport: what its declared league order does with a tie of three (the per-sport block of the post).
//
// WHAT CHECKS IT. The claims recompute the places from the table's own cells by the rulebook reading of each order
// (FIFA 2026's head-to-head-first order; UEFA art. 20.01(d), re-application), and the per-sport facts from each module's DECLARED order
// (`defaultOrderOf`), never from the loader `build()` reads.
import { foldResults, resultsAmong } from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule, TiebreakerKey } from "@seazn/engine/sport";
import { declaredCfgs, defaultOrderOf, forEachSport } from "@seazn/engine/testkit";
import { sportLabel, tiebreakLabel } from "@/blog/labels";
import { startingVariantKey } from "./starting-variant";
import { factsRepeatTheTable, placeOf, placeText, playAndRank, scoreOf, rowOf, signed, stageRules, type MatchView, type Meeting } from "./tie-break-play";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const THREE_WAY_TIE_ID = "three-way-tie";

export const COLUMNS = ["Team", "Points", "Goal difference", "Points in the games between the three", "Goals in the games between the three", "Place, football's own order", "Place, UEFA order"];
export const C = { team: 0, points: 1, gd: 2, miniPoints: 3, miniGoals: 4, own: 5, uefa: 6 } as const;

const TEAMS = [
  { id: "hawks", name: "Hawks" },
  { id: "rockets", name: "Rockets" },
  { id: "comets", name: "Comets" },
  { id: "dynamos", name: "Dynamos" },
];
const nameOf = (id: string) => TEAMS.find((t) => t.id === id)!.name;
const goals = (h: number, a: number) => (v: MatchView) => v.home.metrics.gf === h && v.away.metrics.gf === a;

/**
 * Rockets beat Hawks, Hawks beat Comets, Comets beat Rockets: each of the three has the same points against the other two
 * and a goal difference of zero among them, and Comets score one goal to the others' two. All three beat Dynamos, Hawks
 * by the most, so Hawks have the better overall goal difference while Rockets won the match between the two.
 */
const MEETINGS: Meeting[] = [
  { home: "rockets", away: "hawks", what: "Rockets 2-1 Hawks", seed: 7, want: goals(2, 1) },
  { home: "hawks", away: "comets", what: "Hawks 1-0 Comets", seed: 5, want: goals(1, 0) },
  { home: "comets", away: "rockets", what: "Comets 1-0 Rockets", seed: 5, want: goals(1, 0) },
  { home: "hawks", away: "dynamos", what: "Hawks 3-0 Dynamos", seed: 202, want: goals(3, 0) },
  { home: "rockets", away: "dynamos", what: "Rockets 1-0 Dynamos", seed: 5, want: goals(1, 0) },
  { home: "comets", away: "dynamos", what: "Comets 1-0 Dynamos", seed: 5, want: goals(1, 0) },
];
const THREE = ["hawks", "rockets", "comets"];

function footballPreset(id: string): readonly TiebreakerKey[] {
  const preset = builtinModules.find((m) => m.key === "football")?.tablePresets?.("league").tiebreakers.find((p) => p.id === id);
  if (preset === undefined) throw new Error(`football offers no '${id}' order`);
  return preset.keys;
}

// ---- what a sport's order does with three level (shared words; the claims feed it the DECLARED order) ----

const H2H_BLOCK: ReadonlySet<string> = new Set(["h2h_points", "h2h_diff", "h2h_for", "h2h_wins", "h2h_set_ratio", "h2h_point_ratio"]);

/** How a league order treats three teams level on its earlier steps, in a reader's words. */
export function threeWayWords(order: readonly TiebreakerKey[]): string {
  const i = order.findIndex((k) => H2H_BLOCK.has(k) || k === "h2h_two" || k === "direct");
  if (i === -1) return "no head-to-head step: the tie goes straight on to the overall figures";
  const before = order.slice(1, i).map(tiebreakLabel);
  const when = before.length === 0 ? "straight after the first measure" : `after ${before.join(", ")}`;
  const k = order[i]!;
  if (k === "h2h_two") return `head-to-head only between two: with three level it is skipped, and it comes back once a later step leaves exactly two (first checked ${when})`;
  if (k === "direct") return `a mini-league of the games among all the tied players (${when})`;
  if (order.includes("h2h_reapply")) return `a mini-league of the games among the tied teams, re-applied to any smaller group it leaves level (${when})`;
  if (order.includes("h2h_exclusion")) return `a mini-league of the games among the tied players, started again among only those still level each time it separates someone (${when})`;
  // One pass: the block is the run of head-to-head steps; what follows it is where a group the pass leaves level goes next.
  let end = i;
  while (end < order.length && H2H_BLOCK.has(order[end]!)) end++;
  const next = order[end]!;
  return `one pass of a mini-league of the games among the tied teams, then ${tiebreakLabel(next)} (${when})`;
}

function build(): ExampleResult {
  const football = builtinModules.find((m) => m.key === "football")!;
  const cfg = declaredCfgs(football).find((c) => c.name === startingVariantKey(football))!.cfg;
  const own = playAndRank({ module: football, cfg, kind: "league", entrants: TEAMS, meetings: MEETINGS });
  const uefa = playAndRank({ module: football, cfg, kind: "league", entrants: TEAMS, meetings: MEETINGS, stageOrder: footballPreset("uefa") });
  const lines = (r: typeof own) => r.played.map((p) => `${nameOf(p.meeting.home)} ${p.view.headline} ${nameOf(p.meeting.away)}`);
  if (JSON.stringify(lines(own)) !== JSON.stringify(lines(uefa))) throw new Error("three-way-tie: the two rankings played different matches");

  // The games among the three, as the head-to-head steps read them: the same results, folded among those three only.
  const mini = foldResults(THREE, resultsAmong(new Set(THREE), own.played.map((p) => p.result)));
  const miniOf = (id: string) => mini.find((r) => r.entrantId === id);
  const rows = TEAMS.map((t) => {
    const r = rowOf(own.rows, t.id);
    const m = miniOf(t.id);
    return [t.name, r.points, signed(r.metrics.gd ?? 0), m === undefined ? "Not one of the three" : m.points, m === undefined ? "Not one of the three" : (m.metrics.gf ?? 0), placeText(r.rank!), placeText(rowOf(uefa.rows, t.id).rank!)];
  });
  rows.sort((a, b) => Number.parseInt(String(a[C.own]), 10) - Number.parseInt(String(b[C.own]), 10));

  const facts: ExampleResult["facts"] = {};
  for (const t of TEAMS) {
    facts[`${t.id}PlaceOwn`] = placeText(rowOf(own.rows, t.id).rank!);
    facts[`${t.id}PlaceUefa`] = placeText(rowOf(uefa.rows, t.id).rank!);
  }
  facts.levelPoints = rowOf(own.rows, "hawks").points;
  facts.cometsMiniGoals = miniOf("comets")?.metrics.gf ?? 0;
  facts.hawksMiniGoals = miniOf("hawks")?.metrics.gf ?? 0;
  facts.hawksGoalDifference = signed(rowOf(own.rows, "hawks").metrics.gd ?? 0);
  facts.rocketsGoalDifference = signed(rowOf(own.rows, "rockets").metrics.gd ?? 0);
  const headline = (home: string, away: string) => own.played.find((p) => p.meeting.home === home && p.meeting.away === away)!.view.headline;
  facts.rocketsBeatHawks = headline("rockets", "hawks");
  facts.hawksBeatComets = headline("hawks", "comets");
  facts.cometsBeatRockets = headline("comets", "rockets");
  facts.uefaSplitBy = tiebreakLabel(rowOf(uefa.rows, "hawks").tieBreak?.key ?? "points");
  facts.ownSplitBy = tiebreakLabel(rowOf(own.rows, "hawks").tieBreak?.key ?? "points");

  const visited = forEachSport(({ module }) => {
    const order = stageRules(module, declaredCfgs(module).find((c) => c.name === startingVariantKey(module))!.cfg, "league").tiebreakers;
    facts[`${module.key}ThreeWay`] = threeWayWords(order);
  });
  facts.sportCount = visited;

  return {
    facts,
    table: {
      caption: "Hawks, Rockets and Comets finish level on points. Football's own order and the UEFA order rank the same results differently.",
      columns: COLUMNS,
      rows,
    },
    text: [
      ...lines(own).map((l) => `${l}.`),
      ...forEachSportWords(facts),
    ],
  };
}

function forEachSportWords(facts: ExampleResult["facts"]): string[] {
  const out: string[] = [];
  forEachSport(({ module }) => out.push(`${sportLabel(module.key)}: ${String(facts[`${module.key}ThreeWay`])}.`));
  return out;
}

// ---- claims ----

const placeNum = placeOf;
const num = (v: unknown) => Number(String(v).replace("+", ""));

/**
 * The places the rulebook gives the four, from the table's own cells. Points first; among a group level on points, the
 * head-to-head mini-league's points then goals (the mini goal difference is zero by the case's construction: a circle of
 * one-goal wins); then, for what is still level, either overall goal difference (FIFA 2026, one pass) or the
 * head-to-head again among just those (UEFA art. 20.01(d), re-application: for two teams, their own match).
 */
function rulebookPlaces(r: ExampleResult, reapply: boolean, winnerOfPair: (a: string, b: string) => string | null): Map<string, number> | string {
  const rows = r.table?.rows ?? [];
  if (rows.length !== TEAMS.length) return `the table has ${rows.length} rows`;
  const cmp = (a: (string | number)[], b: (string | number)[]): number => {
    if (num(a[C.points]) !== num(b[C.points])) return num(b[C.points]) - num(a[C.points]);
    if (typeof a[C.miniPoints] === "number" && typeof b[C.miniPoints] === "number") {
      if (a[C.miniPoints] !== b[C.miniPoints]) return Number(b[C.miniPoints]) - Number(a[C.miniPoints]);
      if (a[C.miniGoals] !== b[C.miniGoals]) return Number(b[C.miniGoals]) - Number(a[C.miniGoals]);
      if (reapply) {
        const w = winnerOfPair(String(a[C.team]), String(b[C.team]));
        if (w !== null) return w === a[C.team] ? -1 : 1;
      }
    }
    return num(b[C.gd]) - num(a[C.gd]);
  };
  const sorted = [...rows].sort(cmp);
  return new Map(sorted.map((x, i) => [String(x[C.team]), i + 1]));
}

function caseClaims(): Claim[] {
  return [
    {
      says: "Hawks, Rockets and Comets are level on points, each beat one of the others, and their goal difference among themselves is zero",
      source: "the case's premise, read off the table (a circle of three wins is what sends a FIFA tie past head-to-head points)",
      check(r) {
        const rows = (r.table?.rows ?? []).filter((x) => typeof x[C.miniPoints] === "number");
        if (rows.length !== 3) return `${rows.length} teams are in the three-way games`;
        if (new Set(rows.map((x) => x[C.points])).size !== 1) return "the three are not level on points";
        if (new Set(rows.map((x) => x[C.miniPoints])).size !== 1) return "the three are not level in the games among them";
        const score = scoreOf;
        // Each headline is home first, and each names a home win.
        for (const k of ["rocketsBeatHawks", "hawksBeatComets", "cometsBeatRockets"]) {
          const m = score(r.facts[k]);
          if (m === null || !(m[0] > m[1])) return `${k} reads '${String(r.facts[k])}'`;
        }
        return true;
      },
    },
    {
      says: "football's own order is the FIFA 2026 order and does not re-apply head-to-head; the UEFA order it offers does",
      source: "defaultOrderOf(football, \"league\") and football's declared 'uefa' preset (UEFA art. 20.01(d))",
      check() {
        const football = builtinModules.find((m) => m.key === "football")!;
        const own = defaultOrderOf(football, "league");
        const uefa = football.tablePresets?.("league").tiebreakers.find((p) => p.id === "uefa")?.keys ?? [];
        if (own.includes("h2h_reapply")) return "football's own order re-applies";
        return uefa.includes("h2h_reapply") || "the UEFA preset does not re-apply";
      },
    },
    {
      says: "every place in both columns is the rulebook's, and the two orders put a different team first (one by goal difference, the other by the match between the two)",
      source: "FIFA 2026 (one head-to-head pass, then overall goal difference) and UEFA art. 20.01(d) (head-to-head re-applied), over the table's cells",
      check(r) {
        // Of the two still level after the three-way games, the winner of their own match (Rockets at home to Hawks).
        const meeting = scoreOf(r.facts.rocketsBeatHawks);
        const winnerOfPair = (a: string, b: string): string | null => {
          const pair = new Set([a, b]);
          if (!(pair.has("Hawks") && pair.has("Rockets")) || meeting === null) return null;
          return meeting[0] > meeting[1] ? "Rockets" : meeting[1] > meeting[0] ? "Hawks" : null;
        };
        for (const [col, reapply] of [[C.own, false], [C.uefa, true]] as const) {
          const want = rulebookPlaces(r, reapply, winnerOfPair);
          if (typeof want === "string") return want;
          for (const x of r.table?.rows ?? []) {
            if (placeNum(x[col]) !== want.get(String(x[C.team]))) return `${String(x[C.team])}: column ${COLUMNS[col]} says ${String(x[col])}, the rulebook gives ${want.get(String(x[C.team]))}`;
          }
        }
        const firstOwn = (r.table?.rows ?? []).find((x) => placeNum(x[C.own]) === 1)?.[C.team];
        const firstUefa = (r.table?.rows ?? []).find((x) => placeNum(x[C.uefa]) === 1)?.[C.team];
        return firstOwn !== firstUefa || `both orders put ${String(firstOwn)} first`;
      },
    },
  ];
}

/**
 * What the declared order must say about three level, classified from the order's own keys and checked against the fact's
 * phrases. This is the claim's own reading of the declaration: it does not call the function `build()` words the fact with.
 */
export function threeWayPhrases(order: readonly TiebreakerKey[]): { has: string[]; lacks: string[] } {
  const all = ["only between two", "among all the tied players", "started again", "re-applied", "one pass"];
  const has = order.includes("h2h_exclusion") ? ["started again"] : order.includes("h2h_reapply") ? ["re-applied"] : order.includes("h2h_two") ? ["only between two", "skipped"] : order.includes("direct") ? ["among all the tied players"] : ["one pass"];
  if (has[0] === "one pass") {
    // The step the single pass hands a still-level group to: the first key after the run of head-to-head keys.
    const first = order.findIndex((k) => k.startsWith("h2h_"));
    let end = first;
    while (end < order.length && order[end]!.startsWith("h2h_")) end++;
    has.push(`then ${tiebreakLabel(order[end]!)}`);
  }
  // Where in the list the head-to-head step first applies: straight after the first measure, or after the named steps.
  const firstH2h = order.findIndex((k) => k.startsWith("h2h_") || k === "direct");
  const before = order.slice(1, firstH2h).map(tiebreakLabel);
  has.push(before.length === 0 ? "straight after the first measure" : `after ${before.join(", ")}`);
  return { has, lacks: all.filter((p) => !has.includes(p)) };
}

function sportClaims(module: AnySportModule): Claim {
  return {
    says: `${sportLabel(module.key)}: the three-way words describe the sport's declared league order`,
    source: "defaultOrderOf(module, \"league\") (its head-to-head keys: block, re-apply, exclusion, two-way only, direct encounter)",
    sport: module.key,
    check(r) {
      const fact = String(r.facts[`${module.key}ThreeWay`]);
      const declared = defaultOrderOf(module, "league");
      const { has, lacks } = threeWayPhrases(declared);
      for (const p of has) if (!fact.includes(p)) return `fact '${fact}' lacks '${p}', which the declared order [${declared.join(", ")}] needs`;
      for (const p of lacks) if (fact.includes(p)) return `fact '${fact}' says '${p}', which the declared order [${declared.join(", ")}] does not do`;
      // The phrases above are classified from the declared keys alone, so a words function that drifted from the declaration
      // fails them. The equality pins the exact text (nothing added, nothing lost), and is NOT what proves the words right:
      // it reads the same function `build()` uses.
      const want = threeWayWords(declared);
      return fact === want || `fact is '${fact}', the declaration gives '${want}'`;
    },
  };
}

/** The played results, from the example's result lines ("Rockets 2 — 1 Hawks."), home first. */
function resultsOf(r: ExampleResult): { home: string; away: string; h: number; a: number }[] {
  const out: { home: string; away: string; h: number; a: number }[] = [];
  for (const line of r.text) {
    const m = /^(\w+) (\d+) — (\d+) (\w+)\.$/.exec(line);
    if (m !== null) out.push({ home: m[1]!, h: Number(m[2]), a: Number(m[3]), away: m[4]! });
  }
  return out;
}

const tableClaims: Claim[] = [
  factsRepeatTheTable(TEAMS, C.team, { PlaceOwn: C.own, PlaceUefa: C.uefa }),
  {
    says: "every points, goal difference and three-way cell is the six results': 3 a win, 1 a draw, goals for minus against",
    source: "football's league points as FIFA competition regulations set them (3 for a win, 1 for a draw) over the six results, home first",
    check(r) {
      const res = resultsOf(r);
      if (res.length !== 6) return `${res.length} results`;
      const three = new Set(["Hawks", "Rockets", "Comets"]);
      for (const x of r.table?.rows ?? []) {
        const t = String(x[C.team]);
        let pts = 0, gd = 0, miniPts = 0, miniGoals = 0;
        for (const g of res) {
          if (g.home !== t && g.away !== t) continue;
          const [f, a] = g.home === t ? [g.h, g.a] : [g.a, g.h];
          const p = f > a ? 3 : f === a ? 1 : 0;
          pts += p;
          gd += f - a;
          if (three.has(g.home) && three.has(g.away)) { miniPts += p; miniGoals += f; }
        }
        if (x[C.points] !== pts) return `${t}: ${String(x[C.points])} points, the results give ${pts}`;
        if (x[C.gd] !== signed(gd)) return `${t}: goal difference ${String(x[C.gd])}, the results give ${signed(gd)}`;
        if (three.has(t) && (x[C.miniPoints] !== miniPts || x[C.miniGoals] !== miniGoals)) return `${t}: three-way cells ${String(x[C.miniPoints])}/${String(x[C.miniGoals])}, the results give ${miniPts}/${miniGoals}`;
      }
      return true;
    },
  },
  {
    says: "the case's facts are the table's cells and the results' own",
    source: "the example's table and result lines",
    check(r) {
      const row = (n: string) => (r.table?.rows ?? []).find((x) => x[C.team] === n);
      const f = r.facts;
      if (f.levelPoints !== row("Hawks")?.[C.points]) return `levelPoints ${String(f.levelPoints)}`;
      if (f.hawksGoalDifference !== row("Hawks")?.[C.gd] || f.rocketsGoalDifference !== row("Rockets")?.[C.gd]) return "a goal difference fact is not its cell";
      if (f.hawksMiniGoals !== row("Hawks")?.[C.miniGoals] || f.cometsMiniGoals !== row("Comets")?.[C.miniGoals]) return "a three-way goals fact is not its cell";
      const res = resultsOf(r);
      for (const [k, home, away] of [["rocketsBeatHawks", "Rockets", "Hawks"], ["hawksBeatComets", "Hawks", "Comets"], ["cometsBeatRockets", "Comets", "Rockets"]] as const) {
        const g = res.find((x) => x.home === home && x.away === away);
        if (g === undefined || f[k] !== `${g.h} — ${g.a}`) return `${k} is '${String(f[k])}'`;
      }
      return true;
    },
  },
  {
    says: "the step that split Hawks and Rockets is goal difference in football's own order and head-to-head in the UEFA order",
    source: "defaultOrderOf(football, \"league\") (no re-application: overall goal difference next) and the 'uefa' preset (re-applied head-to-head)",
    check(r) {
      if (r.facts.ownSplitBy !== tiebreakLabel("diff")) return `ownSplitBy ${String(r.facts.ownSplitBy)}`;
      return r.facts.uefaSplitBy === tiebreakLabel("h2h_points") || `uefaSplitBy ${String(r.facts.uefaSplitBy)}`;
    },
  },
];

const claims: Claim[] = [
  ...caseClaims(),
  ...tableClaims,
  {
    says: "the per-sport words cover the whole registry, and count it",
    source: "the sport registry (forEachSport)",
    check(r) {
      const visited = forEachSport(() => {});
      return r.facts.sportCount === visited || `sportCount is ${String(r.facts.sportCount)}, the registry has ${visited}`;
    },
  },
];
if (forEachSport(({ module }) => claims.push(sportClaims(module))) === 0) throw new Error("three-way-tie: the sport registry is empty");

export const threeWayTie: BlogExample = {
  id: THREE_WAY_TIE_ID,
  kind: "engine",
  sports: "all",
  build,
  claims,
};
