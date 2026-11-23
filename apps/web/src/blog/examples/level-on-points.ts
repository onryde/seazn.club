// Post #7, "Two teams finish level on points: who finishes higher?". Two parts.
//
// THE TABLE, every sport in the registry: the order a new division's league ranks by, read where every standings read
// reads it (the web's one loader, `tableRulesOf`, for a pending league stage of the variant a new division starts on).
// Every declared variant of a sport ranks by the same order today; `build()` refuses a variant that does not, so a sport
// that starts to differ by variant fails here instead of printing one row for two orders.
//
// THE WORKED CASE, football: four teams play a real round robin (seeded walks, refolded by the app's read fold) in
// which Hawks and Rockets finish level on points, Hawks win the match between them and Rockets have the better goal
// difference. The same results are ranked twice through the app's ranking path: by football's own order, and by the
// "classic" order football also offers (goal difference first). The two orders put a different team higher.
//
// THE MID-SEASON CASE (fix round 1, I2): the same four teams with only two matches played and the Hawks-Rockets match
// still to come. Hawks and Rockets are level on points, but a head-to-head step runs only on a COMPLETE mini-schedule
// (`scheduleComplete`), so the table skips it, says so ("Head-to-head not complete"), and goes on to goal difference: Rockets
// stand above Hawks until the match is played, and Hawks finish above them once it is. The fixture is scheduled, not decided
// (`Meeting.pending`), exactly the row the app's `scheduledPairsOf` reads.
//
// WHAT CHECKS IT. The claims read the sport's DECLARED order (`defaultOrderOf`, the testkit's reading of the module's
// declaration) and football's declared presets, never the loader `build()` reads; the worked case is checked against the
// rulebook reading of the two orders over the table's own cells.
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule, TiebreakerKey } from "@seazn/engine/sport";
import { declaredCfgs, defaultOrderOf, forEachSport } from "@seazn/engine/testkit";
import { sportLabel } from "@/blog/labels";
import publicDict from "@/dictionaries/en/public.json";
import { standingsLabel } from "@/blog/labels-screens";
import { TIE_NOTE_KEYS } from "@/server/public-site/standings-view";
import { startingVariantKey } from "./starting-variant";
import { placeOf, placeText, playAndRank, scoreOf, rowOf, signed, stageRules, type Meeting, type MatchView } from "./tie-break-play";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const LEVEL_ON_POINTS_ID = "level-on-points";

const COLUMNS = ["Sport", "Ranked first by", "When level, then"];
const C = { sport: 0, first: 1, then: 2 } as const;

/** The order a new division's league ranks by, as the loader reads it, for each declared variant of the sport. */
function loadedOrders(module: AnySportModule): { variant: string; order: readonly TiebreakerKey[] }[] {
  return declaredCfgs(module)
    .filter((c) => Object.hasOwn(module.variants, c.name))
    .map((c) => ({ variant: c.name, order: stageRules(module, c.cfg, "league").tiebreakers }));
}

const cfgOf = (module: AnySportModule, variant: string): unknown => {
  const c = declaredCfgs(module).find((x) => x.name === variant);
  if (c === undefined) throw new Error(`${module.key}: no declared variant '${variant}'`);
  return c.cfg;
};

/** The words of the Standings tab's cascade line (and the public "split on" line) for the steps after the first. */
const thenText = (order: readonly TiebreakerKey[], sportKey: string) => order.slice(1).map((k) => standingsLabel(k, sportKey)).join(", ");
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** "a, b and c" */
const listOf = (items: readonly string[]) => (items.length < 2 ? (items[0] ?? "none") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

// ---- the worked case ----

const TEAMS = [
  { id: "hawks", name: "Hawks" },
  { id: "rockets", name: "Rockets" },
  { id: "comets", name: "Comets" },
  { id: "dynamos", name: "Dynamos" },
];
const nameOf = (id: string) => TEAMS.find((t) => t.id === id)!.name;
const goals = (h: number, a: number) => (v: MatchView) => v.home.metrics.gf === h && v.away.metrics.gf === a;

/** Hawks beat Rockets by one goal; Rockets win their other two games well; Comets beat Hawks; Comets and Dynamos draw. */
const MEETINGS: Meeting[] = [
  { home: "hawks", away: "rockets", what: "Hawks 1-0 Rockets", seed: 5, want: goals(1, 0) },
  { home: "hawks", away: "dynamos", what: "Hawks 1-0 Dynamos", seed: 5, want: goals(1, 0) },
  { home: "comets", away: "hawks", what: "Comets 1-0 Hawks", seed: 5, want: goals(1, 0) },
  { home: "rockets", away: "comets", what: "Rockets 3-0 Comets", seed: 202, want: goals(3, 0) },
  { home: "rockets", away: "dynamos", what: "Rockets 2-0 Dynamos", seed: 95, want: goals(2, 0) },
  { home: "comets", away: "dynamos", what: "Comets 0-0 Dynamos", seed: 9, want: goals(0, 0) },
];

function footballPreset(id: string): readonly TiebreakerKey[] {
  const football = builtinModules.find((m) => m.key === "football");
  const preset = football?.tablePresets?.("league").tiebreakers.find((p) => p.id === id);
  if (preset === undefined) throw new Error(`football offers no '${id}' order`);
  return preset.keys;
}

function worked(facts: ExampleResult["facts"], text: string[]): void {
  const football = builtinModules.find((m) => m.key === "football")!;
  const cfg = cfgOf(football, startingVariantKey(football));
  const entrants = TEAMS;
  const own = playAndRank({ module: football, cfg, kind: "league", entrants, meetings: MEETINGS });
  const classic = playAndRank({ module: football, cfg, kind: "league", entrants, meetings: MEETINGS, stageOrder: footballPreset("classic") });
  // The same matches: the search is deterministic, and a drift would compare two different leagues.
  const lines = (r: typeof own) => r.played.map((p) => `${nameOf(p.meeting.home)} ${p.view.headline} ${nameOf(p.meeting.away)}`);
  if (JSON.stringify(lines(own)) !== JSON.stringify(lines(classic))) throw new Error("level-on-points: the two rankings played different matches");
  text.push(...lines(own).map((l) => `${l}.`));
  const h2h = own.played.find((p) => p.meeting.home === "hawks" && p.meeting.away === "rockets")!;
  const hawks = rowOf(own.rows, "hawks");
  const rockets = rowOf(own.rows, "rockets");
  facts.hawksPoints = hawks.points;
  facts.rocketsPoints = rockets.points;
  facts.hawksGoalDifference = signed(hawks.metrics.gd ?? 0);
  facts.rocketsGoalDifference = signed(rockets.metrics.gd ?? 0);
  facts.hawksBeatRockets = h2h.view.headline;
  facts.hawksPlaceOwnOrder = placeText(hawks.rank!);
  facts.rocketsPlaceOwnOrder = placeText(rockets.rank!);
  facts.hawksPlaceClassic = placeText(rowOf(classic.rows, "hawks").rank!);
  facts.rocketsPlaceClassic = placeText(rowOf(classic.rows, "rockets").rank!);
  facts.ownOrderSplitBy = standingsLabel(hawks.tieBreak?.key ?? "points", "football");
  facts.classicSplitBy = standingsLabel(rowOf(classic.rows, "hawks").tieBreak?.key ?? "points", "football");
  midSeason(football, cfg, facts, text);
}

/** The first match played in the final league is Hawks 1-0 Dynamos, the second Rockets 3-0 Comets: the two the mid-season case keeps. */
const MID_PLAYED = new Set(["hawks-dynamos", "rockets-comets"]);

/** The same fixtures with only some of them played: the rest are scheduled and not decided. */
function midSeason(football: AnySportModule, cfg: unknown, facts: ExampleResult["facts"], text: string[]): void {
  const meetings: Meeting[] = MEETINGS.map((m) => (MID_PLAYED.has(`${m.home}-${m.away}`) ? m : { home: m.home, away: m.away, what: `${m.what}, not yet played`, pending: true as const }));
  const mid = playAndRank({ module: football, cfg, kind: "league", entrants: TEAMS, meetings });
  if (mid.played.length !== MID_PLAYED.size || mid.pending.length !== MEETINGS.length - MID_PLAYED.size) throw new Error("level-on-points: the mid-season case played the wrong matches");
  text.push(...mid.played.map((p) => `Part way through: ${nameOf(p.meeting.home)} ${p.view.headline} ${nameOf(p.meeting.away)}.`));
  const hawks = rowOf(mid.rows, "hawks");
  const rockets = rowOf(mid.rows, "rockets");
  facts.midHawksPoints = hawks.points;
  facts.midHawksGoalDifference = signed(hawks.metrics.gd ?? 0);
  facts.midRocketsGoalDifference = signed(rockets.metrics.gd ?? 0);
  facts.midHawksPlace = placeText(hawks.rank!);
  facts.midRocketsPlace = placeText(rockets.rank!);
  facts.midSplitBy = standingsLabel(rockets.tieBreak?.key ?? "points", "football");
  // The note the public table prints beside a team split while its head-to-head was not complete: the row's own note kind, in the
  // public dictionary's words (`TIE_NOTE_KEYS`, standings-view.ts).
  const kind = rockets.tieBreak?.note;
  if (kind !== "h2h_incomplete") throw new Error(`level-on-points: the mid-season split carries note '${String(kind)}', not h2h_incomplete`);
  facts.midNote = (publicDict as Record<string, string>)[TIE_NOTE_KEYS[kind]] ?? "";
}

function build(): ExampleResult {
  const facts: ExampleResult["facts"] = {};
  const rows: (string | number)[][] = [];
  const text: string[] = ["Each row is the order a new division of that sport ranks its league table by, step by step."];
  const winsFirst: string[] = [];
  const visited = forEachSport(({ module }) => {
    const orders = loadedOrders(module);
    const start = orders.find((o) => o.variant === startingVariantKey(module));
    if (start === undefined) throw new Error(`${module.key}: the starting variant is not declared`);
    for (const o of orders) {
      if (o.order.join() !== start.order.join()) throw new Error(`${module.key}: variant '${o.variant}' ranks by another order; the table needs a row per variant`);
    }
    const label = sportLabel(module.key);
    rows.push([label, upperFirst(standingsLabel(start.order[0]!, module.key)), thenText(start.order, module.key)]);
    facts[`${module.key}FirstTieBreak`] = standingsLabel(start.order[1]!, module.key);
    facts[`${module.key}Order`] = thenText(start.order, module.key);
    if (module.primaryTableKey === "wins") winsFirst.push(sportLabel(module.key).toLowerCase());
  });
  facts.sportCount = visited;
  facts.winsFirstSports = upperFirst(listOf(winsFirst));
  worked(facts, text);
  const result: ExampleResult = { facts, table: { caption: "", columns: COLUMNS, rows }, text };
  result.table!.caption = captionOf(result);
  return result;
}

/** The table's caption, said from the facts (the sport count is the registry's). */
export function captionOf(r: Pick<ExampleResult, "facts" | "table">): string {
  return `What the league table of each of the ${String(r.facts.sportCount)} sports checks, in order, when teams are level on its first measure.`;
}

// ---- claims ----

function claimsFor(module: AnySportModule): Claim[] {
  const sport = sportLabel(module.key);
  const declared = defaultOrderOf(module, "league");
  const mine = (says: string, source: string, check: Claim["check"]): Claim => ({ says: `${sport}: ${says}`, source, sport: module.key, check });
  const row = (r: ExampleResult) => (r.table?.rows ?? []).find((x) => x[C.sport] === sport);
  return [
    mine("the row's first measure is the sport's declared first step", "defaultOrderOf(module, \"league\")[0] and primaryTableKey", (r) => {
      const x = row(r);
      if (x === undefined) return `no row '${sport}'`;
      if (declared[0] !== module.primaryTableKey) return `the declared order starts with ${declared[0]}, the primary key is ${module.primaryTableKey}`;
      return x[C.first] === upperFirst(standingsLabel(declared[0]!, module.key)) || `first is ${String(x[C.first])}, the declaration gives ${declared[0]}`;
    }),
    mine("the row lists every later step of the declared order, in order", "defaultOrderOf(module, \"league\")", (r) => {
      const x = row(r);
      if (x === undefined) return `no row '${sport}'`;
      const want = thenText(declared, module.key);
      if (x[C.then] !== want) return `then is '${String(x[C.then])}', the declaration gives '${want}'`;
      return r.facts[`${module.key}Order`] === want || `fact ${module.key}Order is '${String(r.facts[`${module.key}Order`])}'`;
    }),
    mine("the first tie-break fact is the declared second step", "defaultOrderOf(module, \"league\")[1]", (r) => {
      const want = standingsLabel(declared[1]!, module.key);
      return r.facts[`${module.key}FirstTieBreak`] === want || `fact is '${String(r.facts[`${module.key}FirstTieBreak`])}', the declaration gives '${want}'`;
    }),
    // The row's own cell is the previous claim's (it equals the declared order's words); this one is the declaration the post's
    // "every sport's list ends with a drawing of lots" rests on.
    mine("the declared order ends with drawing of lots (the post says every sport's list ends there)", "defaultOrderOf(module, \"league\") last step", () => {
      const last = declared[declared.length - 1];
      return last === "lots" || `the declared order ends with ${String(last)}`;
    }),
  ];
}

const num = (v: unknown) => Number(String(v).replace("+", ""));
const placeNum = placeOf;

function acrossSports(): Claim[] {
  return [
    {
      says: "the caption is the one said from the facts",
      source: "the example's facts (nothing in it is typed)",
      check(r) {
        const want = captionOf(r);
        return r.table?.caption === want || `caption is '${String(r.table?.caption)}', the table gives '${want}'`;
      },
    },
    {
      says: "the table holds every sport of the registry, in registry order, and counts them",
      source: "the sport registry (forEachSport)",
      check(r) {
        const labels: string[] = [];
        const visited = forEachSport(({ module }) => labels.push(sportLabel(module.key)));
        const got = (r.table?.rows ?? []).map((x) => String(x[C.sport]));
        if (r.facts.sportCount !== visited) return `sportCount is ${String(r.facts.sportCount)}, the registry has ${visited}`;
        return JSON.stringify(got) === JSON.stringify(labels) || `rows are ${got.join(", ")}`;
      },
    },
    {
      says: "football: Hawks and Rockets finish level on points, Hawks won the match between them, and Rockets have the better goal difference",
      source: "the worked case's own premise, read off its facts (both halves are needed for the two orders to disagree)",
      check(r) {
        const f = r.facts;
        if (f.hawksPoints === undefined || f.hawksPoints !== f.rocketsPoints) return `points ${String(f.hawksPoints)} and ${String(f.rocketsPoints)}`;
        const score = scoreOf(f.hawksBeatRockets);
        if (score === null || !(score[0] > score[1])) return `the meeting reads '${String(f.hawksBeatRockets)}'`;
        return num(f.rocketsGoalDifference) > num(f.hawksGoalDifference) || `goal differences ${String(f.hawksGoalDifference)} and ${String(f.rocketsGoalDifference)}`;
      },
    },
    {
      says: "football's own order puts the winner of the meeting higher; the classic order puts the better goal difference higher (the two answers differ)",
      source: "football's declared order (head-to-head points right after points) and its declared 'classic' preset (goal difference right after points)",
      check(r) {
        const football = builtinModules.find((m) => m.key === "football")!;
        const own = defaultOrderOf(football, "league");
        const classic = football.tablePresets?.("league").tiebreakers.find((p) => p.id === "classic")?.keys ?? [];
        if (own[1] !== "h2h_points") return `football's declared second step is ${own[1]}`;
        if (classic[1] !== "diff") return `the classic preset's second step is ${classic[1]}`;
        const f = r.facts;
        if (!(placeNum(f.hawksPlaceOwnOrder) < placeNum(f.rocketsPlaceOwnOrder))) return `own order: Hawks ${String(f.hawksPlaceOwnOrder)}, Rockets ${String(f.rocketsPlaceOwnOrder)}`;
        if (!(placeNum(f.rocketsPlaceClassic) < placeNum(f.hawksPlaceClassic))) return `classic: Hawks ${String(f.hawksPlaceClassic)}, Rockets ${String(f.rocketsPlaceClassic)}`;
        if (f.ownOrderSplitBy !== standingsLabel("h2h_points", "football")) return `own order split by ${String(f.ownOrderSplitBy)}`;
        return f.classicSplitBy === standingsLabel("diff", "football") || `classic split by ${String(f.classicSplitBy)}`;
      },
    },
    {
      says: "the sports that sort by matches won first are exactly the ones whose declared first step is wins",
      source: "defaultOrderOf(module, \"league\")[0] over the registry",
      check(r) {
        const firsts: string[] = [];
        forEachSport(({ module }) => {
          if (defaultOrderOf(module, "league")[0] === "wins") firsts.push(sportLabel(module.key).toLowerCase());
        });
        if (firsts.length === 0) return "no sport sorts by wins first: the sentence has nothing to name";
        const want = upperFirst(listOf(firsts));
        return r.facts.winsFirstSports === want || `fact '${String(r.facts.winsFirstSports)}', declared '${want}'`;
      },
    },
    {
      says: "part way through, with the Hawks-Rockets match still to play, they are level on points, head-to-head cannot run, and the better goal difference puts Rockets above Hawks (the opposite of the final table)",
      source: "the schedule rule (a head-to-head step needs every meeting among the level teams decided: `scheduleComplete`, tiebreakers.js) over the part-way results, and the public dictionary's note",
      check(r) {
        const played = r.text
          .filter((l) => l.startsWith("Part way through: "))
          .map((l) => /^Part way through: (\w+) (\d+) — (\d+) (\w+)\.$/.exec(l));
        if (played.length !== 2 || played.some((m) => m === null)) return `${played.length} part-way results`;
        const tally = new Map<string, { pts: number; gd: number }>();
        for (const m of played) {
          const [, home, h, a, away] = m!;
          for (const [t, f, g] of [[home!, Number(h), Number(a)], [away!, Number(a), Number(h)]] as const) {
            const x = tally.get(t) ?? { pts: 0, gd: 0 };
            x.pts += f > g ? 3 : f === g ? 1 : 0;
            x.gd += f - g;
            tally.set(t, x);
          }
        }
        const hawks = tally.get("Hawks");
        const rockets = tally.get("Rockets");
        if (hawks === undefined || rockets === undefined) return "Hawks or Rockets played no part-way match";
        if (played.some((m) => new Set([m![1], m![4]]).has("Hawks") && new Set([m![1], m![4]]).has("Rockets"))) return "Hawks and Rockets have already met";
        if (hawks.pts !== rockets.pts) return `part-way points ${hawks.pts} and ${rockets.pts}`;
        if (r.facts.midHawksPoints !== hawks.pts) return `midHawksPoints ${String(r.facts.midHawksPoints)}, the results give ${hawks.pts}`;
        if (r.facts.midHawksGoalDifference !== signed(hawks.gd) || r.facts.midRocketsGoalDifference !== signed(rockets.gd)) return `goal difference facts ${String(r.facts.midHawksGoalDifference)} / ${String(r.facts.midRocketsGoalDifference)}, the results give ${signed(hawks.gd)} / ${signed(rockets.gd)}`;
        if (hawks.gd === rockets.gd) return "the part-way goal differences are level: nothing would split them";
        const rocketsUp = rockets.gd > hawks.gd;
        if ((placeNum(r.facts.midRocketsPlace) < placeNum(r.facts.midHawksPlace)) !== rocketsUp) return `part-way places: Hawks ${String(r.facts.midHawksPlace)}, Rockets ${String(r.facts.midRocketsPlace)}`;
        if (r.facts.midSplitBy !== standingsLabel("diff", "football")) return `part-way split by ${String(r.facts.midSplitBy)}`;
        if (r.facts.midNote !== (publicDict as Record<string, string>)["table.tieNote.h2hIncomplete"]) return `note '${String(r.facts.midNote)}'`;
        // Class 19: the part-way order is not the final one, or the claim could not see the head-to-head wait.
        const hawksFinalAbove = placeNum(r.facts.hawksPlaceOwnOrder) < placeNum(r.facts.rocketsPlaceOwnOrder);
        return hawksFinalAbove === rocketsUp || "the part-way order equals the final one";
      },
    },
  ];
}

const claims: Claim[] = [...acrossSports()];
const sportsClaimed = forEachSport(({ module }) => {
  claims.push(...claimsFor(module));
});
if (sportsClaimed === 0) throw new Error("level-on-points: the sport registry is empty");

export const levelOnPoints: BlogExample = {
  id: LEVEL_ON_POINTS_ID,
  kind: "engine",
  sports: "all",
  build,
  claims,
};
