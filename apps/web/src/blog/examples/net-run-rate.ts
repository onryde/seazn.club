// Post #9, "What is net run rate, and what happens to it after a forfeit?". Cricket only: net run rate exists in cricket
// alone (a claim below sweeps the registry and proves no other sport's order holds it).
//
// THE TABLE: three T20 sides (the variant a new cricket division starts on). Tigers beat Lions in real match one, chasing a
// total that Lions were bowled out for well inside their overs (so one innings is all out and early, and one is a winning
// chase that ends early without being bowled out: the two cases the rule treats differently); Bears beat Tigers in real
// match two (seeded walks, refolded by the app's read fold); Bears then do not turn up against Lions, a walkover with
// nothing played. Every side ends on one win and the same points, so net run rate alone puts them in order. Each result is
// paid by the stage's rule (`tableRulesOf`) and ranked through the app's ranking path, and the net run rate cell is the
// public table's own text for it (`derivedText`, the standings view's one formatter).
//
// WHAT CHECKS IT. The ICC playing conditions (net run rate = runs per over scored minus runs per over conceded, 16.10.7),
// recomputed from the table's own cells; and the forfeit rule against the variant's DECLARED innings length: the side that
// did not turn up is charged its full overs at no runs, and the side that was given the match gains nothing in its rate.
import { builtinModules } from "@seazn/engine/sports";
import { defaultOrderOf, forEachSport } from "@seazn/engine/testkit";
import { standingsLabel } from "@/blog/labels-screens";
import { derivedText } from "@/server/public-site/standings-view";
import { factsRepeatTheTable, placeOf, placeText, playAndRank, rowOf, type MatchView, type Meeting } from "./tie-break-play";
import type { BlogExample, Claim, ExampleResult } from "./types";
import { startingCfg } from "./kit";

export const NET_RUN_RATE_ID = "net-run-rate";

export const COLUMNS = ["Team", "Played", "Won", "Points", "Runs scored", "Overs faced", "Runs conceded", "Overs bowled", "Net run rate", "Place"];
export const C = { team: 0, played: 1, won: 2, points: 3, runsFor: 4, oversFaced: 5, runsAgainst: 6, oversBowled: 7, nrr: 8, place: 9 } as const;

const TEAMS = [
  { id: "lions", name: "Lions" },
  { id: "tigers", name: "Tigers" },
  { id: "bears", name: "Bears" },
];
const nameOf = (id: string) => TEAMS.find((t) => t.id === id)!.name;

/** A completed home win in the normal match: both sides batted, and the result came from play. */
const homeWin = (v: MatchView) =>
  v.outcome.kind === "win" && v.outcome.winner === v.home.entrantId && (v.home.metrics.balls_faced_eff ?? 0) > 0 && (v.away.metrics.balls_faced_eff ?? 0) > 0;

/**
 * The home side wins a chase with overs and wickets to spare, against an innings that was bowled out well inside its
 * overs. The headline writes an all-out innings without wickets ("60 (17.4)") and a chase with them ("61/3 (14.2)").
 */
const chaseWin = (v: MatchView) => {
  const m = /^(\d+)\/(\d+) \(([\d.]+)\) — (\d+) \(([\d.]+)\)$/.exec(v.headline);
  const quota = startCfg().ballsPerInnings;
  if (m === null || quota === null) return false;
  const bpo = startCfg().ballsPerOver ?? 6;
  // A chase that stops at the target (at most a six past it), against a total worth chasing.
  const target = Number(m[4]!);
  const reached = Number(m[1]!);
  return v.outcome.kind === "win" && v.outcome.winner === v.home.entrantId && ballsOf(m[3]!, bpo) < quota && ballsOf(m[5]!, bpo) < quota && target >= 90 && reached > target && reached - target <= 6;
};

const MEETINGS: Meeting[] = [
  { home: "tigers", away: "lions", what: "Tigers chase down Lions' all-out total with overs to spare", want: chaseWin },
  { home: "bears", away: "tigers", what: "Bears beat Tigers", want: homeWin },
  { home: "lions", away: "bears", what: "Bears do not turn up against Lions", walkoverBy: "bears" },
];

const cricket = () => builtinModules.find((m) => m.key === "cricket")!;
const startCfg = () => startingCfg(cricket()) as { ballsPerInnings: number | null; inningsPerSide: number; ballsPerOver?: number };

/** Balls as a scorecard writes overs: 20, or 15.2 for fifteen overs and two balls. */
export function oversText(balls: number, ballsPerOver: number): string {
  const whole = Math.floor(balls / ballsPerOver);
  const rest = balls % ballsPerOver;
  return rest === 0 ? String(whole) : `${whole}.${rest}`;
}
/** The other way: "15.2" overs back to balls. */
export function ballsOf(overs: string, ballsPerOver: number): number {
  const [w, r] = overs.split(".");
  return Number(w) * ballsPerOver + Number(r ?? 0);
}

function build(): ExampleResult {
  const sport = cricket();
  const cfg = startCfg();
  const ranked = playAndRank({ module: sport, cfg, kind: "league", entrants: TEAMS, meetings: MEETINGS });
  const bpo = ranked.rules.ballsPerOver ?? 6;
  const m = (id: string, key: string) => rowOf(ranked.rows, id).metrics[key] ?? 0;
  const rows = [...ranked.rows]
    .sort((a, b) => a.rank! - b.rank!)
    .map((r) => [
      nameOf(r.entrantId),
      r.played,
      r.won,
      r.points,
      m(r.entrantId, "runs_for"),
      oversText(m(r.entrantId, "balls_faced_eff"), bpo),
      m(r.entrantId, "runs_against"),
      oversText(m(r.entrantId, "balls_bowled_eff"), bpo),
      derivedText(r, "nrr", ranked.layout),
      placeText(r.rank!),
    ]);
  const facts: ExampleResult["facts"] = {};
  const played = (home: string, away: string) => ranked.played.find((p) => p.meeting.home === home && p.meeting.away === away)!;
  const tl = played("tigers", "lions");
  const bt = played("bears", "tigers");
  const wo = played("lions", "bears");
  facts.tigersBeatLions = tl.view.headline;
  facts.bearsBeatTigers = bt.view.headline;
  // What the played matches alone put on each side's ledger (the credited balls: a side bowled out counts its full quota).
  facts.lionsOversInTheirMatch = oversText(tl.view.away.metrics.balls_faced_eff ?? 0, bpo);
  facts.lionsRunsInTheirMatch = tl.view.away.metrics.runs_for ?? 0;
  facts.bearsOversInTheirMatch = oversText(bt.view.home.metrics.balls_faced_eff ?? 0, bpo);
  facts.bearsRunsInTheirMatch = bt.view.home.metrics.runs_for ?? 0;
  // The overs each innings of match one really lasted, as the scorecard (the headline) writes them: Lions bowled out, Tigers chasing.
  const innings = /^\d+\/\d+ \(([\d.]+)\) — \d+ \(([\d.]+)\)$/.exec(tl.view.headline);
  if (innings === null) throw new Error(`net-run-rate: match one reads '${tl.view.headline}', not a chase against an all-out innings`);
  facts.tigersChaseOvers = innings[1]!;
  facts.lionsOversLasted = innings[2]!;
  // What the walkover put there.
  facts.walkoverOversCharged = oversText(wo.view.away.metrics.balls_faced_eff ?? 0, bpo);
  facts.walkoverRunsCharged = wo.view.away.metrics.runs_for ?? 0;
  facts.walkoverOversToLions = oversText(wo.view.home.metrics.balls_faced_eff ?? 0, bpo);
  for (const t of TEAMS) {
    const r = rowOf(ranked.rows, t.id);
    facts[`${t.id}NetRunRate`] = derivedText(r, "nrr", ranked.layout);
    facts[`${t.id}OversFaced`] = oversText(m(t.id, "balls_faced_eff"), bpo);
    facts[`${t.id}Points`] = r.points;
    facts[`${t.id}Place`] = placeText(r.rank!);
  }
  facts.levelWins = rowOf(ranked.rows, "lions").won;
  facts.levelPoints = rowOf(ranked.rows, "lions").points;
  facts.inningsOvers = cfg.ballsPerInnings === null ? "none" : oversText(cfg.ballsPerInnings, bpo);
  facts.cricketOrder = ranked.rules.tiebreakers.slice(1).map((k) => standingsLabel(k, "cricket")).join(", ");
  facts.netRunRateStep = ranked.rules.tiebreakers.indexOf("nrr") + 1;
  const result: ExampleResult = {
    facts,
    table: { caption: "", columns: COLUMNS, rows },
    text: [
      `Tigers ${tl.view.headline} Lions.`,
      `Bears ${bt.view.headline} Tigers.`,
      "Lions against Bears: Bears did not turn up, a walkover to Lions.",
    ],
  };
  result.table!.caption = captionOf(result);
  return result;
}

/** The table's caption, said from its own cells and the example's facts: nothing the cells can say is typed. */
export function captionOf(r: Pick<ExampleResult, "facts" | "table">): string {
  const rows = r.table?.rows ?? [];
  const at = (place: number) => rows.find((x) => placeOf(x[C.place]) === place)?.[C.team];
  const walkedOver = nameOf(MEETINGS.find((m) => m.walkoverBy !== undefined)?.walkoverBy ?? "");
  return `${rows.length} T20 sides, each on ${r.facts.levelWins} win and ${r.facts.levelPoints} points: net run rate puts ${String(at(1))} first and ${String(at(rows.length))} last, and ${walkedOver} are charged a full innings for not turning up.`;
}

// ---- claims ----

const rowNamed = (r: ExampleResult, name: string) => (r.table?.rows ?? []).find((x) => x[C.team] === name);
const BPO = () => (startCfg().ballsPerOver ?? 6);

/** ICC 16.10.7: runs scored per over faced, minus runs conceded per over bowled, from the cells; to three places. */
function nrrFromCells(x: (string | number)[]): number {
  const bpo = BPO();
  const faced = ballsOf(String(x[C.oversFaced]), bpo);
  const bowled = ballsOf(String(x[C.oversBowled]), bpo);
  return (Number(x[C.runsFor]) * bpo) / faced - (Number(x[C.runsAgainst]) * bpo) / bowled;
}

/** A cricket headline "61/9 (20) — 35 (5)": each side's runs (wickets and overs allowed), home first; or null. */
function inningsOf(text: unknown): [number, number] | null {
  const m = /^(\d+)(?:\/\d+)? \([\d.]+\) — (\d+)(?:\/\d+)? \([\d.]+\)$/.exec(String(text));
  return m === null ? null : [Number(m[1]), Number(m[2])];
}

/** The ICC's points for a T20 league match (ICC Men's T20 World Cup Playing Conditions, points table: a win earns 2). */
const ICC_WIN_POINTS = 2;

/** One side's innings as the scorecard writes it: an innings written without "/wickets" is a side bowled out. */
interface Innings {
  runs: number;
  allOut: boolean;
  balls: number;
}
function inningsPair(text: unknown): [Innings, Innings] | null {
  const bpo = BPO();
  const m = /^(\d+)(\/\d+)? \(([\d.]+)\) — (\d+)(\/\d+)? \(([\d.]+)\)$/.exec(String(text));
  return m === null
    ? null
    : [
        { runs: Number(m[1]), allOut: m[2] === undefined, balls: ballsOf(m[3]!, bpo) },
        { runs: Number(m[4]), allOut: m[5] === undefined, balls: ballsOf(m[6]!, bpo) },
      ];
}

const tableClaims: Claim[] = [
  factsRepeatTheTable(TEAMS, C.team, { NetRunRate: C.nrr, OversFaced: C.oversFaced, Points: C.points, Place: C.place }),
  {
    says: "each side's played, won, runs scored and runs conceded are its matches': the two played results and the walkover to Lions",
    source: "the fixture (three matches, one a walkover) and the two played headlines, home side first",
    check(r) {
      const tl = inningsOf(r.facts.tigersBeatLions);
      const bt = inningsOf(r.facts.bearsBeatTigers);
      if (tl === null || bt === null) return `a headline reads '${String(r.facts.tigersBeatLions)}' / '${String(r.facts.bearsBeatTigers)}'`;
      if (!(tl[0] > tl[1]) || !(bt[0] > bt[1])) return "a played match was not won by the home side";
      // [played, won, runs scored, runs conceded]: Tigers (home) beat Lions, Bears (home) beat Tigers, Lions are given the walkover.
      const want: Record<string, [number, number, number, number]> = {
        Lions: [2, 1, tl[1], tl[0]],
        Tigers: [2, 1, tl[0] + bt[1], tl[1] + bt[0]],
        Bears: [2, 1, bt[0], bt[1]],
      };
      for (const [name, [played, won, scored, conceded]] of Object.entries(want)) {
        const x = rowNamed(r, name);
        if (x === undefined) return `no ${name} row`;
        if (x[C.played] !== played || x[C.won] !== won) return `${name}: played ${String(x[C.played])}, won ${String(x[C.won])}`;
        if (x[C.runsFor] !== scored || x[C.runsAgainst] !== conceded) return `${name}: runs ${String(x[C.runsFor])} for, ${String(x[C.runsAgainst])} against`;
      }
      return true;
    },
  },
  {
    says: "points are two a win, the three sides are level on points and wins, so net run rate alone puts them in order (points, then wins, then net run rate)",
    source: "ICC Men's T20 World Cup Playing Conditions (points table) and defaultOrderOf(cricket, \"league\")",
    check(r) {
      const declared = defaultOrderOf(cricket(), "league");
      if (declared.slice(0, 3).join() !== "points,wins,nrr") return `cricket's order is [${declared.join(", ")}]`;
      const rows = r.table?.rows ?? [];
      for (const x of rows) if (x[C.points] !== Number(x[C.won]) * ICC_WIN_POINTS) return `${String(x[C.team])}: ${String(x[C.points])} points for ${String(x[C.won])} wins`;
      if (new Set(rows.map((x) => x[C.points])).size !== 1 || new Set(rows.map((x) => x[C.won])).size !== 1) return "the sides are not level on points and wins: net run rate would not be what orders them";
      if (new Set(rows.map((x) => nrrFromCells(x).toFixed(3))).size !== rows.length) return "two sides share a net run rate";
      if (r.facts.levelWins !== rows[0]?.[C.won] || r.facts.levelPoints !== rows[0]?.[C.points]) return `levelWins ${String(r.facts.levelWins)}, levelPoints ${String(r.facts.levelPoints)}`;
      const sorted = [...rows].sort((a, b) => Number(b[C.points]) - Number(a[C.points]) || Number(b[C.won]) - Number(a[C.won]) || nrrFromCells(b) - nrrFromCells(a));
      for (const [i, x] of sorted.entries()) if (placeOf(x[C.place]) !== i + 1) return `${String(x[C.team])}: ${String(x[C.place])}, the order gives ${i + 1}`;
      return true;
    },
  },
];

const claims: Claim[] = [
  ...tableClaims,
  {
    says: "the caption is the one said from the table's own cells and the facts",
    source: "the table's cells and the example's facts (nothing in it is typed)",
    check(r) {
      const want = captionOf(r);
      return r.table?.caption === want || `caption is '${String(r.table?.caption)}', the cells give '${want}'`;
    },
  },
  {
    says: "net run rate is in cricket's declared order and in no other sport's",
    source: "defaultOrderOf(module, \"league\") over the registry (the single-sport reason)",
    check() {
      const holders: string[] = [];
      const visited = forEachSport(({ module }) => {
        if (defaultOrderOf(module, "league").includes("nrr")) holders.push(module.key);
      });
      if (visited === 0) return "the registry is empty";
      return (holders.length === 1 && holders[0] === "cricket") || `net run rate is in [${holders.join(", ")}]`;
    },
  },
  {
    says: "every net run rate cell is runs per over scored minus runs per over conceded, from the row's own cells",
    source: "ICC Men's T20 World Cup Playing Conditions 16.10.7",
    check(r) {
      const rows = r.table?.rows ?? [];
      if (rows.length !== TEAMS.length) return `${rows.length} rows`;
      for (const x of rows) {
        const want = nrrFromCells(x);
        const got = Number(String(x[C.nrr]).replace("+", "").replace("−", "-"));
        if (!Number.isFinite(got) || Math.abs(got - want) > 0.0005) return `${String(x[C.team])}: the cell says ${String(x[C.nrr])}, the formula gives ${want.toFixed(3)}`;
      }
      return true;
    },
  },
  {
    says: "the side that did not turn up is charged the variant's full innings at no runs, on top of its played match, and only on the batting side of its ledger",
    source: "the T20 variant's declared ballsPerInnings × inningsPerSide (ICC 16.10.7: a forfeit's overs; CK-WO-1: the defaulter charged its full quota at 0 runs, nothing on its runs conceded or overs bowled)",
    check(r) {
      const cfg = startCfg();
      if (cfg.ballsPerInnings === null) return "the starting variant has no innings length";
      const bpo = BPO();
      const quota = cfg.ballsPerInnings * cfg.inningsPerSide;
      if (ballsOf(String(r.facts.inningsOvers), bpo) !== cfg.ballsPerInnings) return `inningsOvers is ${String(r.facts.inningsOvers)}`;
      if (ballsOf(String(r.facts.walkoverOversCharged), bpo) !== quota) return `charged ${String(r.facts.walkoverOversCharged)} overs, the variant's innings is ${quota} balls`;
      if (Number(r.facts.walkoverRunsCharged) !== 0) return `charged ${String(r.facts.walkoverRunsCharged)} runs`;
      const bears = rowNamed(r, "Bears");
      if (bears === undefined) return "no Bears row";
      const faced = ballsOf(String(bears[C.oversFaced]), bpo);
      const played = ballsOf(String(r.facts.bearsOversInTheirMatch), bpo);
      if (faced !== played + quota) return `Bears faced ${faced} balls, the played match ${played} plus the innings ${quota}`;
      // Only the batting side: Bears' overs bowled and runs conceded are what their one played match put there (the Tigers' innings).
      const bt = inningsPair(r.facts.bearsBeatTigers);
      if (bt === null) return "the Bears-Tigers headline does not parse";
      const bowledByBears = bt[1].allOut ? quota : bt[1].balls;
      if (ballsOf(String(bears[C.oversBowled]), bpo) !== bowledByBears) return `Bears bowled ${String(bears[C.oversBowled])} overs: the walkover moved the bowling side (the played match gives ${oversText(bowledByBears, bpo)})`;
      if (bears[C.runsAgainst] !== bt[1].runs) return `Bears conceded ${String(bears[C.runsAgainst])}: the walkover moved the runs conceded (the played match gives ${bt[1].runs})`;
      return Number(bears[C.runsFor]) === Number(r.facts.bearsRunsInTheirMatch) || "Bears' runs moved with the walkover";
    },
  },
  {
    says: "a side bowled out counts as having faced its full innings, a chase won inside its overs counts the overs used: every overs cell is the sum of those innings",
    source: "ICC Men's T20 World Cup 2026 Playing Conditions 16.10.7, as the cricket module's nrrCredits declares it (an all-out innings counts its full allocated quota; any other innings the balls it faced); the quota is the variant's declared ballsPerInnings",
    check(r) {
      const cfg = startCfg();
      if (cfg.ballsPerInnings === null) return "the starting variant has no innings length";
      const bpo = BPO();
      const quota = cfg.ballsPerInnings;
      const tl = inningsPair(r.facts.tigersBeatLions);
      const bt = inningsPair(r.facts.bearsBeatTigers);
      if (tl === null || bt === null) return "a headline does not parse";
      const counted = (i: Innings) => (i.allOut ? quota : i.balls);
      // Home first in each headline: match one is Tigers (home, chasing) against Lions; match two is Bears (home) against Tigers.
      const faced: Record<string, number> = {
        Lions: counted(tl[1]),
        Tigers: counted(tl[0]) + counted(bt[1]),
        Bears: counted(bt[0]) + cfg.ballsPerInnings * cfg.inningsPerSide,
      };
      const bowled: Record<string, number> = { Lions: counted(tl[0]), Tigers: counted(tl[1]) + counted(bt[0]), Bears: counted(bt[1]) };
      // Class 19: an innings bowled out early (counted as the full quota, not as the overs it lasted) AND an innings that ended
      // early without being bowled out (counted as the overs used), or the claim cannot tell either rule from "every innings counts full".
      const all = [...tl, ...bt];
      if (all.filter((i) => i.allOut && i.balls < quota).length === 0) return "no innings in the example was bowled out early, so the all-out rule is not witnessed";
      if (all.filter((i) => !i.allOut && i.balls < quota).length === 0) return "no innings in the example ended early without being bowled out, so the rule that a chase counts its overs used is not witnessed";
      for (const x of r.table?.rows ?? []) {
        const name = String(x[C.team]);
        if (ballsOf(String(x[C.oversFaced]), bpo) !== faced[name]) return `${name}: overs faced ${String(x[C.oversFaced])}, the innings give ${oversText(faced[name] ?? 0, bpo)}`;
        if (ballsOf(String(x[C.oversBowled]), bpo) !== bowled[name]) return `${name}: overs bowled ${String(x[C.oversBowled])}, the innings give ${oversText(bowled[name] ?? 0, bpo)}`;
      }
      // The two overs the post quotes for match one are the headline's own: Lions' innings (bowled out) and Tigers' chase.
      if (!tl[1].allOut || tl[0].allOut) return "match one is not a chase against an all-out innings";
      if (ballsOf(String(r.facts.lionsOversLasted), bpo) !== tl[1].balls) return `lionsOversLasted is ${String(r.facts.lionsOversLasted)}, the headline gives ${oversText(tl[1].balls, bpo)}`;
      if (ballsOf(String(r.facts.tigersChaseOvers), bpo) !== tl[0].balls) return `tigersChaseOvers is ${String(r.facts.tigersChaseOvers)}, the headline gives ${oversText(tl[0].balls, bpo)}`;
      return (r.table?.rows.length ?? 0) === TEAMS.length || "rows missing";
    },
  },
  {
    says: "the side given the match gains nothing in its rate: its runs and overs are its played match's alone",
    source: "CK-WO-1 (the winner's net run rate is untouched by a forfeit)",
    check(r) {
      const lions = rowNamed(r, "Lions");
      if (lions === undefined) return "no Lions row";
      const bpo = BPO();
      if (ballsOf(String(r.facts.walkoverOversToLions), bpo) !== 0) return `the walkover credited Lions ${String(r.facts.walkoverOversToLions)} overs`;
      if (ballsOf(String(lions[C.oversFaced]), bpo) !== ballsOf(String(r.facts.lionsOversInTheirMatch), bpo)) return "Lions' overs include more than their played match";
      return Number(lions[C.runsFor]) === Number(r.facts.lionsRunsInTheirMatch) || "Lions' runs include more than their played match";
    },
  },
  {
    says: "the walkover moves Bears' rate (a wrong rule that left the forfeit out would give another number)",
    source: "class 19: the charged innings against the same row without it",
    check(r) {
      const bears = rowNamed(r, "Bears");
      if (bears === undefined) return "no Bears row";
      const bpo = BPO();
      const without = [...bears];
      without[C.oversFaced] = String(r.facts.bearsOversInTheirMatch);
      return Math.abs(nrrFromCells(bears) - nrrFromCells(without)) > 0.0005 || `the rate is ${nrrFromCells(bears)} with and without the walkover (${bpo} balls an over)`;
    },
  },
  {
    says: "the order fact is cricket's declared order after its first measure, and net run rate's place in it",
    source: "defaultOrderOf(cricket, \"league\")",
    check(r) {
      const declared = defaultOrderOf(cricket(), "league");
      const want = declared.slice(1).map((k) => standingsLabel(k, "cricket")).join(", ");
      if (r.facts.cricketOrder !== want) return `order fact '${String(r.facts.cricketOrder)}', declared '${want}'`;
      return r.facts.netRunRateStep === declared.indexOf("nrr") + 1 || `step ${String(r.facts.netRunRateStep)}`;
    },
  },
];

export const netRunRate: BlogExample = {
  id: NET_RUN_RATE_ID,
  kind: "engine",
  sports: ["cricket"],
  singleSportReason: "cricket only: net run rate exists in cricket alone (a claim sweeps every sport's order for it)",
  build,
  claims,
};
