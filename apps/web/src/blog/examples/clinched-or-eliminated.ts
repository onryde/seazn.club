// Post #31, "How does Seazn know a team is through, or out?". Six football teams play a round robin (five rounds) and the top two go on.
// Four rounds are played through the engine's event stream and ranked as the standings snapshot ranks (`playAndRank`); the app's own
// builder of the standings status (`buildQualificationView`, the one behind every standings page) is asked for each row's words with one
// round still to play, and again once the fifth round is played and the table is finished. The words come from that builder and the real
// English dictionary, never typed here.
//
// WHAT CHECKS IT. The claims restate the engine's published rule in plain arithmetic and run it on the printed table: a team's fewest
// and most possible points are its points plus its matches left times football's fewest and most per match (read off football's declared
// league points); it is Through when fewer rivals than places can still reach its fewest (a rival that can only draw level counts), Out
// when as many rivals as places are already strictly ahead of its most, "Win k and in" when winning k of its matches is enough, and
// otherwise needs help. The finished table's words are Qualified for the first places and Out for the rest, and no team called Through
// went out, nor one called Out went through.
import { builtinModules } from "@seazn/engine/sports";
import { isHeadToHeadKey } from "@seazn/engine/competition";
import { declaredCfgs, defaultOrderOf, forEachSport } from "@seazn/engine/testkit";
import { boundsInForce, buildQualificationView, stageQualMeta, type QualFixture, type QualificationViewInput, type StageQualMeta } from "@/server/public-site/qualification-view";
import publicDict from "@/dictionaries/en/public.json";
import { plural, t, type TKey } from "@/lib/i18n-runtime";
import { declaredLeaguePoints, pointsPhrase, startingCfg } from "./kit";
import { TIE_BREAK_MSG_KEYS } from "@/server/public-site/standings-view";
import { startingVariantKey } from "./starting-variant";
import { playAndRank, type Meeting, type MatchView, type RankedStage } from "./tie-break-play";
import { capitalised, col, guarded, numberWord } from "./swiss-claims";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const CLINCHED_ID = "clinched-or-eliminated";

/** Best seed first. */
const TEAMS = ["Hawks", "Rockets", "Comets", "Dynamos", "Wolves", "Tigers"] as const;
const CUT = 2;
const NEXT_STAGE = "Knockout";
const PLAYED_ROUNDS = 4;
const ALL_ROUNDS = 5;
const idOf = (name: string) => name.toLowerCase();
const nameOfId = (id: string) => TEAMS.find((x) => idOf(x) === id) ?? id;
const goals = (h: number, a: number) => (v: MatchView) => v.home.metrics.gf === h && v.away.metrics.gf === a;
const DICT = publicDict as Record<string, string>;

/** The fifteen matches in the order of their rounds, home side first. Rounds one to four are played when the table is read with one round
 *  to go; round five settles it. Each team meets each other once. */
const SCORES: { round: number; home: string; away: string; h: number; a: number; seed: number }[] = [
  { round: 1, home: "hawks", away: "tigers", h: 2, a: 0, seed: 0 },
  { round: 1, home: "rockets", away: "wolves", h: 1, a: 0, seed: 0 },
  { round: 1, home: "comets", away: "dynamos", h: 0, a: 1, seed: 0 },
  { round: 2, home: "hawks", away: "wolves", h: 1, a: 0, seed: 0 },
  { round: 2, home: "tigers", away: "dynamos", h: 1, a: 0, seed: 0 },
  { round: 2, home: "rockets", away: "comets", h: 1, a: 1, seed: 0 },
  { round: 3, home: "hawks", away: "dynamos", h: 2, a: 0, seed: 0 },
  { round: 3, home: "wolves", away: "comets", h: 0, a: 0, seed: 0 },
  { round: 3, home: "tigers", away: "rockets", h: 0, a: 1, seed: 0 },
  { round: 4, home: "hawks", away: "comets", h: 0, a: 1, seed: 0 },
  { round: 4, home: "dynamos", away: "rockets", h: 0, a: 0, seed: 0 },
  { round: 4, home: "wolves", away: "tigers", h: 1, a: 0, seed: 0 },
  { round: 5, home: "hawks", away: "rockets", h: 0, a: 1, seed: 0 },
  { round: 5, home: "comets", away: "tigers", h: 1, a: 0, seed: 0 },
  { round: 5, home: "dynamos", away: "wolves", h: 1, a: 0, seed: 0 },
];

const football = () => builtinModules.find((m) => m.key === "football")!;

/** The app's translator over the real English dictionary, as the standings builder is handed it. */
const msg = (k: TKey, v?: Record<string, string | number>) => t(publicDict as never, k, v);
const pl = (k: string, n: number, v?: Record<string, string | number>) => plural(publicDict as never, k, n, "en", v);

interface Words {
  status: string;
  label: string;
  headline: string;
  ifYouLose: string | null;
  whatIf: string | null;
}

/** The stage's qualification facts as the app reads them: the cut, where it goes, and the rule the table is paid by (the loader's). */
function metaOf(ranked: RankedStage): StageQualMeta {
  return { ...stageQualMeta({ kind: "league", qualify_count: CUT, qualify_per_group: false, next_stage_name: NEXT_STAGE, swiss_rounds: null, points_rule: null, has_rank_overrides: false }), tablePointsRule: ranked.rules.points };
}

/** One table read through the app's standings-status builder: every row's words, or null where the builder shows none. */
function wordsOf(ranked: RankedStage, fixtures: QualFixture[], names: Record<string, string>): Map<string, Words> | null {
  const meta = metaOf(ranked);
  const input: QualificationViewInput = {
    stage: { id: "blog-stage", kind: "league", meta },
    poolId: null,
    rows: ranked.rows,
    fixtures,
    entrantStatuses: Object.fromEntries(ranked.rows.map((r) => [r.entrantId, "confirmed"])),
    // Every stage has a rule in force, so the sport's own bounds never stand in for it (the production caller passes none).
    bounds: null,
    // The loader's document carries the sport's own primary measure (`stageTableRulesDocOf`: `primary: module.primaryTableKey`).
    primary: football().primaryTableKey,
    awardAddsToLedger: false,
    cascade: ranked.rules.tiebreakers,
    reachable: ranked.rules.reachable,
    entrantNames: names,
    msg,
    plural: pl,
  };
  const view = buildQualificationView(input);
  if (view === null) return null;
  return new Map(ranked.rows.map((r) => {
    const q = view.rows[r.entrantId];
    if (q === undefined) throw new Error(`clinched-or-eliminated: the builder shows no status for ${nameOfId(r.entrantId)}`);
    return [r.entrantId, { status: q.status, label: q.label, headline: q.headline, ifYouLose: q.ifYouLose, whatIf: q.whatIf }] as const;
  }));
}

function fixturesOf(scores: typeof SCORES, playedRounds: number, ranked: RankedStage): QualFixture[] {
  const outcomeOf = new Map(ranked.played.map((p) => [`${p.meeting.home}|${p.meeting.away}`, p.view.outcome] as const));
  return scores.map((s, i) => {
    const decided = s.round <= playedRounds;
    return {
      id: `blog-fixture-${i + 1}`,
      stage_id: "blog-stage",
      pool_id: null,
      round_no: s.round,
      status: decided ? "decided" : "scheduled",
      home_entrant_id: s.home,
      away_entrant_id: s.away,
      outcome: decided ? outcomeOf.get(`${s.home}|${s.away}`) ?? null : null,
      played: false,
      has_active_abandon: false,
      expunged: false,
      no_result: false,
    } as QualFixture;
  });
}

function rank(sport: ReturnType<typeof football>, cfg: unknown, playedRounds: number): RankedStage {
  const entrants = TEAMS.map((name, i) => ({ id: idOf(name), name, seed: i + 1 }));
  const meetings: Meeting[] = SCORES.map((s) =>
    s.round <= playedRounds
      ? { home: s.home, away: s.away, round: s.round, what: `${nameOfId(s.home)} ${s.h}-${s.a} ${nameOfId(s.away)}`, want: goals(s.h, s.a), ...(s.seed > 0 ? { seed: s.seed } : {}) }
      : { home: s.home, away: s.away, round: s.round, what: `${nameOfId(s.home)} v ${nameOfId(s.away)}`, pending: true as const },
  );
  return playAndRank({ module: sport, cfg, kind: "league", entrants, meetings });
}

function build(): ExampleResult {
  const sport = football();
  const cfg = startingCfg(sport);
  const names = Object.fromEntries(TEAMS.map((n) => [idOf(n), n]));
  const before = rank(sport, cfg, PLAYED_ROUNDS);
  const after = rank(sport, cfg, ALL_ROUNDS);
  const beforeWords = wordsOf(before, fixturesOf(SCORES, PLAYED_ROUNDS, before), names);
  if (beforeWords === null) throw new Error("clinched-or-eliminated: the builder shows no status with one round to play");
  const afterWords = wordsOf(after, fixturesOf(SCORES, ALL_ROUNDS, after), names);
  if (afterWords === null) throw new Error("clinched-or-eliminated: the builder shows no status for a finished table");
  // Before a ball is kicked there is nothing to read: the builder shows no status at all.
  const none = rank(sport, cfg, 0);
  const noneWords = wordsOf(none, fixturesOf(SCORES, 0, none), names);
  const bounds = boundsInForce(metaOf(before), null);
  if (bounds === null) throw new Error("clinched-or-eliminated: the table's rule gives no per-match bounds");
  const leftOf = (id: string) => SCORES.filter((s) => s.round > PLAYED_ROUNDS && (s.home === id || s.away === id)).length;
  const rows = before.rows.map((r) => ({
    id: r.entrantId,
    name: nameOfId(r.entrantId),
    points: r.points,
    left: leftOf(r.entrantId),
    worst: r.points + leftOf(r.entrantId) * bounds.min,
    best: r.points + leftOf(r.entrantId) * bounds.max,
    words: beforeWords.get(r.entrantId)!,
    final: after.rows.find((x) => x.entrantId === r.entrantId)!,
    finalWords: afterWords.get(r.entrantId)!,
  }));
  const byLabel = (status: string) => rows.filter((x) => x.words.status === status);
  const through = byLabel("through")[0];
  const winAndIn = byLabel("win_k")[0];
  const needsHelp = byLabel("needs_help");
  const out = byLabel("out");
  if (through === undefined || winAndIn === undefined || needsHelp.length === 0 || out.length === 0) throw new Error("clinched-or-eliminated: the example does not show every status");
  // The row the post's "level does not count" paragraph is about: a team that would be Through if a rival that can only draw level did not count.
  const rivalsAtBest = (x: (typeof rows)[number]) => rows.filter((o) => o.id !== x.id && o.best >= x.worst);
  const levelOnly = rows.find((x) => x.words.status !== "through" && rivalsAtBest(x).length === CUT && rows.filter((o) => o.id !== x.id && o.best > x.worst).length < CUT);
  if (levelOnly === undefined) throw new Error("clinched-or-eliminated: no team is held back by a rival that can only draw level");
  const levelRival = rivalsAtBest(levelOnly).find((o) => o.best === levelOnly.worst);
  if (levelRival === undefined) throw new Error("clinched-or-eliminated: no rival can finish exactly level with the held-back team");
  const outFirst = out[0]!;
  const aheadOfOut = rows.filter((o) => o.id !== outFirst.id && o.worst > outFirst.best);
  // In the finished table's order, which is the order the post names them in.
  const qualified = after.rows.filter((x) => afterWords.get(x.entrantId)!.status === "qualified").map((x) => ({ name: nameOfId(x.entrantId) }));
  const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  const tableRows = rows.map((x) => [x.name, x.points, x.left, `${x.worst} to ${x.best}`, x.words.label, `${pointsPhrase(x.final.points)}, ${x.finalWords.label}`]);
  return {
    facts: {
      teams: TEAMS.length,
      cut: CUT,
      matchesEach: ALL_ROUNDS,
      roundsPlayed: PLAYED_ROUNDS,
      leftEach: ALL_ROUNDS - PLAYED_ROUNDS,
      mostPerMatch: bounds.max,
      fewestPerMatch: bounds.min,
      throughTeam: through.name,
      throughHeadline: through.words.headline,
      throughPoints: through.worst,
      throughRivals: list(rows.filter((o) => o.id !== through.id && o.best >= through.worst).map((o) => o.name)),
      winAndInTeam: winAndIn.name,
      winAndInLabel: winAndIn.words.label,
      winAndInIfLose: winAndIn.words.ifYouLose ?? "",
      winAndInBest: winAndIn.best,
      winManyLabel: pl("table.qual.status.winK", 2, { count: 2 }),
      winAndInRivalsAfterWin: list(rows.filter((o) => o.id !== winAndIn.id && o.best >= winAndIn.worst + bounds.winFloor).map((o) => o.name)),
      needsHelpTeams: list(needsHelp.map((x) => x.name)),
      needsHelpHeadline: needsHelp[0]!.words.headline,
      needsHelpPoints: needsHelp[0]!.worst,
      needsHelpBest: needsHelp[0]!.best,
      outTeams: list(out.map((x) => x.name)),
      outHeadline: outFirst.words.headline,
      outFirstTeam: outFirst.name,
      outFirstBest: outFirst.best,
      aheadOfOut: list(aheadOfOut.map((x) => x.name)),
      aheadOfOutFewest: list(aheadOfOut.map((x) => String(x.worst))),
      levelTeam: levelOnly.name,
      levelTeamPoints: levelOnly.worst,
      levelRival: levelRival.name,
      levelRivalBest: levelRival.best,
      levelRivals: list(rivalsAtBest(levelOnly).map((o) => o.name)),
      levelWhatIf: levelOnly.words.whatIf ?? "",
      noStatusBeforePlay: noneWords === null ? "none" : "shown",
      qualifiedTeams: list(qualified.map((x) => x.name)),
      finalOutHeadline: afterWords.get(rows.find((x) => x.finalWords.status === "out")!.id)!.headline,
      sportCount: forEachSport(() => undefined),
    },
    table: {
      caption: `${capitalised(numberWord(TEAMS.length))} teams play ${numberWord(ALL_ROUNDS)} rounds and the top ${numberWord(CUT)} go on. The table is read with ${numberWord(ALL_ROUNDS - PLAYED_ROUNDS)} round to play, then again once it is played.`,
      columns: ["Team", "Points", "Matches left", "Can finish on", "With one round to play", "After the last round"],
      rows: tableRows,
    },
    diagram: {
      kind: "pointsRanges",
      title: `Each bar runs from the fewest points a team can finish on to the most. A team is out when ${numberWord(CUT)} rivals are already ahead of the most it can reach, and through when fewer than ${numberWord(CUT)} rivals can still reach its fewest.`,
      axisMax: Math.max(...rows.map((x) => x.best)),
      rows: rows.map((x) => ({ team: x.name, label: x.words.label, now: x.points, worst: x.worst, best: x.best })),
    },
    text: SCORES.map((s) => `Round ${s.round}: ${nameOfId(s.home)} ${s.h} — ${s.a} ${nameOfId(s.away)}.`),
  };
}

// ---- claims ----

interface Row {
  team: string;
  points: number;
  left: number;
  worst: number;
  best: number;
  label: string;
  after: string;
}

function rowsOf(r: ExampleResult): Row[] {
  const c = { team: col(r, "Team"), points: col(r, "Points"), left: col(r, "Matches left"), range: col(r, "Can finish on"), label: col(r, "With one round to play"), after: col(r, "After the last round") };
  return (r.table?.rows ?? []).map((row) => {
    const m = /^(\d+) to (\d+)$/.exec(String(row[c.range]));
    if (m === null) throw new Error(`'${String(row[c.range])}' is not 'N to M'`);
    if (typeof row[c.points] !== "number" || typeof row[c.left] !== "number") throw new Error("a points or matches-left cell is not a number");
    return { team: String(row[c.team]), points: row[c.points] as number, left: row[c.left] as number, worst: Number(m[1]), best: Number(m[2]), label: String(row[c.label]), after: String(row[c.after]) };
  });
}

interface Results {
  home: string;
  away: string;
  h: number;
  a: number;
  round: number;
}

function resultsOf(r: ExampleResult): Results[] {
  return r.text.map((line) => {
    const m = /^Round (\d+): (.+) (\d+) — (\d+) (.+)\.$/.exec(line);
    if (m === null) throw new Error(`'${line}' is not a result line`);
    return { round: Number(m[1]), home: m[2]!, away: m[5]!, h: Number(m[3]), a: Number(m[4]) };
  });
}

/** football's declared points a match pays: win, draw, loss, and the per-match fewest and most. */
function pointsPerMatch(): { win: number; draw: number; loss: number; min: number; max: number } {
  const sport = football();
  const cfg = startingCfg(sport);
  const rule = declaredLeaguePoints(sport, cfg);
  const win = rule.win.regulation;
  const loss = rule.loss.regulation;
  const draw = rule.draw ?? Number.NaN;
  return { win, draw, loss, min: Math.min(win, draw, loss), max: Math.max(win, draw, loss) };
}

/** The rule, written out: the status of `team` among `rows`, with `cut` places. `level` says whether a rival that can only draw level
 *  counts against a team (it does), and `strictOut` whether Out needs rivals strictly ahead (it does). */
type Status = { kind: "through" } | { kind: "out" } | { kind: "win"; k: number } | { kind: "help" };
function statusOf(rows: readonly { team: string; points: number; left: number }[], team: string, cut: number, per: { min: number; max: number; win: number; loss?: number }, own?: { lo: number; hi: number; left: number }): Status {
  const me = rows.find((x) => x.team === team)!;
  const lo = own?.lo ?? me.points;
  const hi = own?.hi ?? me.points;
  const left = own?.left ?? me.left;
  const rivals = rows.filter((x) => x.team !== team);
  const best = (x: { points: number; left: number }) => x.points + x.left * per.max;
  const worst = (x: { points: number; left: number }) => x.points + x.left * per.min;
  const myWorst = lo + left * per.min;
  const myBest = hi + left * per.max;
  if (rivals.filter((x) => best(x) >= myWorst).length < cut) return { kind: "through" };
  if (rivals.filter((x) => worst(x) > myBest).length >= cut) return { kind: "out" };
  for (let k = 1; k <= left; k++) {
    const target = lo + k * per.win + (left - k) * per.min;
    if (rivals.filter((x) => best(x) >= target).length < cut) return { kind: "win", k };
  }
  return { kind: "help" };
}

const labelOf = (s: Status): string => (s.kind === "through" ? DICT["table.qual.status.through"]! : s.kind === "out" ? DICT["table.qual.status.out"]! : s.kind === "help" ? DICT["table.qual.status.needsHelp"]! : s.k === 1 ? DICT["table.qual.status.winK.one"]! : DICT["table.qual.status.winK.other"]!.replace("{count}", String(s.k)));

/**
 * Every sport's own per-match points spread (`matchPointsBounds`) under one declared variant, and which variant that was: `read`
 * names it per sport, so a test holds it to the variant a new division starts on. `flat` lists the sports whose win does not pay
 * more than their loss (a status cannot be read there); `visited` counts the sports swept (zero is a failure for the caller).
 */
export function perMatchSpread(): { visited: number; flat: string[]; read: { sport: string; variant: string }[] } {
  const flat: string[] = [];
  const read: { sport: string; variant: string }[] = [];
  const visited = forEachSport(({ key, module: sportModule }) => {
    // The variant a new division starts on (the builder's own pick), not the first entry of `declaredCfgs`: that one is the bare schema default.
    const start = startingVariantKey(sportModule);
    const declared = declaredCfgs(sportModule).find((c) => c.name === start);
    if (declared === undefined) throw new Error(`clinched-or-eliminated: ${key}: no declared cfg for the starting variant '${start}'`);
    read.push({ sport: key, variant: declared.name });
    const parsed = sportModule.configSchema.safeParse(declared.cfg);
    const b = parsed.success ? sportModule.matchPointsBounds(parsed.data) : null;
    if (b === null || !(b.max > b.min)) flat.push(key);
  });
  return { visited, flat, read };
}

const claims: Claim[] = [
  {
    says: "each team's points and matches left are what the printed results say: football's declared points for the first rounds, and the matches of the last round still to play",
    source: "the printed results paid by football's declared league points, and a round robin of six teams (every pair once, five matches each)",
    check: guarded((r) => {
      const per = pointsPerMatch();
      const results = resultsOf(r);
      if (results.length !== (TEAMS.length * (TEAMS.length - 1)) / 2) return `${results.length} results, a round robin of ${TEAMS.length} is ${(TEAMS.length * (TEAMS.length - 1)) / 2}`;
      const rounds = Number(r.facts.roundsPlayed);
      const rows = rowsOf(r);
      if (rows.length !== Number(r.facts.teams)) return `${rows.length} rows, ${String(r.facts.teams)} teams`;
      for (const x of rows) {
        const mine = results.filter((m) => m.home === x.team || m.away === x.team);
        if (mine.length !== Number(r.facts.matchesEach)) return `${x.team} plays ${mine.length} matches, matchesEach is ${String(r.facts.matchesEach)}`;
        const done = mine.filter((m) => m.round <= rounds);
        const points = done.reduce((n, m) => {
          const [f, a] = m.home === x.team ? [m.h, m.a] : [m.a, m.h];
          return n + (f > a ? per.win : f === a ? per.draw : per.loss);
        }, 0);
        if (x.points !== points) return `${x.team}: ${x.points} points in the table, ${points} from the results`;
        if (x.left !== mine.length - done.length) return `${x.team}: ${x.left} matches left, ${mine.length - done.length} from the schedule`;
        if (x.left !== Number(r.facts.leftEach)) return `${x.team}: ${x.left} left, leftEach is ${String(r.facts.leftEach)}`;
      }
      const pairs = new Set(results.map((m) => [m.home, m.away].sort().join("|")));
      return pairs.size === results.length || "a pair of teams meets twice";
    }),
  },
  {
    says: "a team's range is its points plus its matches left times the fewest and the most a match pays, and the rows are in table order, best points first",
    source: "football's declared league points: a match pays at most the win and at least the loss",
    check: guarded((r) => {
      const per = pointsPerMatch();
      if (Number(r.facts.mostPerMatch) !== per.max || Number(r.facts.fewestPerMatch) !== per.min) return `a match pays ${String(r.facts.fewestPerMatch)} to ${String(r.facts.mostPerMatch)}, football declares ${per.min} to ${per.max}`;
      const rows = rowsOf(r);
      for (const x of rows) {
        if (x.worst !== x.points + x.left * per.min || x.best !== x.points + x.left * per.max) return `${x.team}: ${x.worst} to ${x.best}, expected ${x.points + x.left * per.min} to ${x.points + x.left * per.max}`;
      }
      return rows.every((x, i) => i === 0 || rows[i - 1]!.points >= x.points) || "the rows are not best points first";
    }),
  },
  {
    says: "each team's words with one round to play are what the rule gives: Through when fewer rivals than places can still reach its fewest points (a rival that can only draw level counts), Out when that many are already strictly ahead of its most, Win k and in when k wins are enough, else Needs help",
    source: "the published rule of the engine's qualification (R4 `≥` for Through, strict `>` for Out), restated as arithmetic over the table and football's declared points per match; the words are the English dictionary's table.qual.status.* strings",
    check: guarded((r) => {
      const per = { ...pointsPerMatch() };
      const rows = rowsOf(r);
      let seen = 0;
      for (const x of rows) {
        const want = labelOf(statusOf(rows, x.team, Number(r.facts.cut), { min: per.min, max: per.max, win: per.win }));
        if (x.label !== want) return `${x.team}: '${x.label}', the rule gives '${want}'`;
        seen++;
      }
      return seen === rows.length && seen > 0;
    }),
  },
  {
    says: "every status the post names is in the example: one Through, one Win and in, a team that needs help, and teams that are out",
    source: "the rule above run over the table",
    check: guarded((r) => {
      const per = pointsPerMatch();
      const rows = rowsOf(r);
      const kinds = rows.map((x) => statusOf(rows, x.team, Number(r.facts.cut), { min: per.min, max: per.max, win: per.win }).kind);
      for (const k of ["through", "win", "help", "out"] as const) if (!kinds.includes(k)) return `no team is '${k}'`;
      const nameOf = (k: Status["kind"]) => rows.filter((x) => statusOf(rows, x.team, Number(r.facts.cut), { min: per.min, max: per.max, win: per.win }).kind === k).map((x) => x.team);
      const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
      if (r.facts.throughTeam !== nameOf("through")[0]) return `throughTeam is '${String(r.facts.throughTeam)}'`;
      if (r.facts.winAndInTeam !== nameOf("win")[0]) return `winAndInTeam is '${String(r.facts.winAndInTeam)}'`;
      if (r.facts.needsHelpTeams !== list(nameOf("help"))) return `needsHelpTeams is '${String(r.facts.needsHelpTeams)}'`;
      // The figures the post quotes for each, from the table's own range cells.
      const through = rows.find((x) => x.team === r.facts.throughTeam)!;
      const win = rows.find((x) => x.team === r.facts.winAndInTeam)!;
      const help = rows.find((x) => x.team === nameOf("help")[0])!;
      const reach = (x: Row) => list(rows.filter((o) => o.team !== x.team && o.best >= x.worst).map((o) => o.team));
      if (Number(r.facts.throughPoints) !== through.worst) return `throughPoints is ${String(r.facts.throughPoints)}, the fewest ${through.team} can finish on is ${through.worst}`;
      if (r.facts.throughRivals !== reach(through)) return `throughRivals is '${String(r.facts.throughRivals)}', the table gives '${reach(through)}'`;
      if (r.facts.winAndInLabel !== labelOf({ kind: "win", k: 1 })) return `winAndInLabel is '${String(r.facts.winAndInLabel)}'`;
      if (r.facts.winManyLabel !== labelOf({ kind: "win", k: 2 })) return `winManyLabel is '${String(r.facts.winManyLabel)}', the dictionary gives '${labelOf({ kind: "win", k: 2 })}'`;
      if (Number(r.facts.winAndInBest) !== win.best) return `winAndInBest is ${String(r.facts.winAndInBest)}, the table gives ${win.best}`;
      // After the win that is enough, fewer rivals than places can still reach the new total: the rule's own test for "Win k and in".
      const afterWin = win.worst + per.win;
      const catching = list(rows.filter((o) => o.team !== win.team && o.best >= afterWin).map((o) => o.team));
      if (r.facts.winAndInRivalsAfterWin !== catching) return `winAndInRivalsAfterWin is '${String(r.facts.winAndInRivalsAfterWin)}', the table gives '${catching}' (the ${afterWin} points a win leaves ${win.team} on)`;
      if (Number(r.facts.needsHelpPoints) !== help.worst || Number(r.facts.needsHelpBest) !== help.best) return `needsHelpPoints/Best are ${String(r.facts.needsHelpPoints)}/${String(r.facts.needsHelpBest)}, the table gives ${help.worst}/${help.best}`;
      return r.facts.outTeams === list(nameOf("out")) || `outTeams is '${String(r.facts.outTeams)}', the rule gives '${list(nameOf("out"))}'`;
    }),
  },
  {
    says: "a rival that can only draw level still counts: the team held back would be Through if it did not, because exactly one fewer rival could finish above it",
    source: "the rule's `≥` (R4: a rival who can draw level counts as a rival who can beat you), checked on the table against the same rule with `>`",
    check: guarded((r) => {
      const per = pointsPerMatch();
      const rows = rowsOf(r);
      const cut = Number(r.facts.cut);
      const team = rows.find((x) => x.team === r.facts.levelTeam);
      const rival = rows.find((x) => x.team === r.facts.levelRival);
      if (team === undefined || rival === undefined) return "the level team or its rival is not in the table";
      if (rival.best !== team.worst) return `${rival.team} can reach ${rival.best}, ${team.team} can finish on ${team.worst}: not level`;
      if (Number(r.facts.levelTeamPoints) !== team.worst || Number(r.facts.levelRivalBest) !== rival.best) return "levelTeamPoints or levelRivalBest is not the table's";
      const atLeast = rows.filter((x) => x.team !== team.team && x.points + x.left * per.max >= team.worst).length;
      const strictly = rows.filter((x) => x.team !== team.team && x.points + x.left * per.max > team.worst).length;
      if (!(atLeast === cut && strictly < cut)) return `${atLeast} rivals reach it, ${strictly} strictly above: the level rival makes no difference`;
      const reaching = rows.filter((x) => x.team !== team.team && x.points + x.left * per.max >= team.worst).map((x) => x.team);
      const named = reaching.length <= 1 ? reaching.join("") : `${reaching.slice(0, -1).join(", ")} and ${reaching[reaching.length - 1]}`;
      if (r.facts.levelRivals !== named) return `levelRivals is '${String(r.facts.levelRivals)}', the table gives '${named}'`;
      // What a person is told about a level finish: the dictionary's own sentence, naming the rival and the rule that decides. The rule
      // is the word for the first step the sport's declared table order takes after points.
      const order = defaultOrderOf(football()).map(String);
      const afterPoints = order[order.indexOf("points") + 1];
      if (afterPoints === undefined || !isHeadToHeadKey(afterPoints as never)) return `football's table order after points is '${String(afterPoints)}' in [${order.join(", ")}], not a head-to-head step`;
      const ruleWord = DICT[TIE_BREAK_MSG_KEYS[afterPoints]!];
      if (ruleWord === undefined) return `no dictionary word for the tie-break '${afterPoints}'`;
      const sentence = DICT["table.qual.whatIf.rule"]!.replace("{rival}", rival.team).replace("{rule}", ruleWord);
      if (r.facts.levelWhatIf !== sentence) return `levelWhatIf is '${String(r.facts.levelWhatIf)}', the dictionary gives '${sentence}'`;
      return statusOf(rows, team.team, cut, { min: per.min, max: per.max, win: per.win }).kind !== "through" || `${team.team} is Through, so the level rival makes no difference`;
    }),
  },
  {
    says: "a team is out when as many rivals as places are strictly ahead of the most it can reach, and the facts name the first of them and who is ahead",
    source: "the rule's Out test: rivals whose fewest points are more than this team's most",
    check: guarded((r) => {
      const per = pointsPerMatch();
      const rows = rowsOf(r);
      const cut = Number(r.facts.cut);
      const team = rows.find((x) => x.team === r.facts.outFirstTeam);
      if (team === undefined) return "outFirstTeam is not in the table";
      const ahead = rows.filter((x) => x.team !== team.team && x.points + x.left * per.min > team.best);
      if (ahead.length < cut) return `${ahead.length} rivals are strictly ahead of ${team.team}'s most (${team.best}), ${cut} are needed`;
      if (Number(r.facts.outFirstBest) !== team.best) return `outFirstBest is ${String(r.facts.outFirstBest)}, the table gives ${team.best}`;
      const list = ahead.map((x) => x.team);
      const text = list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
      if (r.facts.aheadOfOut !== text) return `aheadOfOut is '${String(r.facts.aheadOfOut)}', the table gives '${text}'`;
      const fewest = ahead.map((x) => String(x.points + x.left * per.min));
      const fewestText = fewest.length <= 1 ? fewest.join("") : `${fewest.slice(0, -1).join(", ")} and ${fewest[fewest.length - 1]}`;
      if (r.facts.aheadOfOutFewest !== fewestText) return `aheadOfOutFewest is '${String(r.facts.aheadOfOutFewest)}', the table gives '${fewestText}'`;
      // The positive pair: a team one rival short of that is not out (the strict test is not a `>=`).
      const notOut = rows.filter((x) => statusOf(rows, x.team, cut, { min: per.min, max: per.max, win: per.win }).kind !== "out");
      return notOut.some((x) => rows.filter((o) => o.team !== x.team && o.points + o.left * per.min >= x.best).length >= cut) || "no team is kept alive by a rival that is only level with its most";
    }),
  },
  {
    says: "the words are the product's own: the Through headline, the Needs help headline, the Out headline and the sentence for losing the next match are the English dictionary's, filled from the table",
    source: "the English dictionary's table.qual.headline.* and table.qual.ifYouLose.* strings, and the rule's status after the next match is lost (fewest +0 over one match fewer)",
    check: guarded((r) => {
      const per = pointsPerMatch();
      const rows = rowsOf(r);
      const cut = Number(r.facts.cut);
      const throughHeadline = DICT["table.qual.headline.through"]!.replace("{next}", NEXT_STAGE);
      if (r.facts.throughHeadline !== throughHeadline) return `throughHeadline is '${String(r.facts.throughHeadline)}', the dictionary gives '${throughHeadline}'`;
      if (r.facts.needsHelpHeadline !== DICT["table.qual.headline.needsHelp"]) return `needsHelpHeadline is '${String(r.facts.needsHelpHeadline)}'`;
      const outHeadline = DICT[cut === 1 ? "table.qual.headline.out.one" : "table.qual.headline.out.other"]!.replace("{n}", String(cut));
      if (r.facts.outHeadline !== outHeadline) return `outHeadline is '${String(r.facts.outHeadline)}', the dictionary gives '${outHeadline}'`;
      const team = rows.find((x) => x.team === r.facts.winAndInTeam);
      if (team === undefined) return "winAndInTeam is not in the table";
      const lost = statusOf(rows, team.team, cut, { min: per.min, max: per.max, win: per.win }, { lo: team.points + per.min, hi: team.points + per.loss, left: team.left - 1 });
      const sentence = lost.kind === "help" ? DICT["table.qual.ifYouLose.needsHelp"]! : lost.kind === "out" ? DICT["table.qual.ifYouLose.out"]! : lost.kind === "through" ? DICT["table.qual.ifYouLose.through"]! : "";
      if (sentence === "") return `losing leaves ${team.team} '${lost.kind}', which this claim has no sentence for`;
      return r.facts.winAndInIfLose === sentence || `winAndInIfLose is '${String(r.facts.winAndInIfLose)}', the dictionary gives '${sentence}'`;
    }),
  },
  {
    says: "once the last round is played the words stop being a forecast: the first places read Qualified and the rest Out, and in this example no team that was Through went out nor one that was Out went through",
    source: "the table finished by the printed results, ranked by points (no tie at the line), and the English dictionary's table.qual.status.qualified / headline strings",
    check: guarded((r) => {
      const per = pointsPerMatch();
      const rows = rowsOf(r);
      const results = resultsOf(r);
      const cut = Number(r.facts.cut);
      const final = rows.map((x) => ({
        team: x.team,
        points: results.filter((m) => m.home === x.team || m.away === x.team).reduce((n, m) => {
          const [f, a] = m.home === x.team ? [m.h, m.a] : [m.a, m.h];
          return n + (f > a ? per.win : f === a ? per.draw : per.loss);
        }, 0),
      }));
      final.sort((a, b) => b.points - a.points);
      if (final[cut - 1]!.points === final[cut]!.points) return "a tie at the line: the example is meant to have none";
      const wantAfter = new Map(final.map((x, i) => [x.team, `${x.points} ${x.points === 1 ? "point" : "points"}, ${i < cut ? DICT["table.qual.status.qualified"] : DICT["table.qual.status.out"]}`] as const));
      for (const x of rows) {
        if (x.after !== wantAfter.get(x.team)) return `${x.team}: '${x.after}', the finished table gives '${String(wantAfter.get(x.team))}'`;
        const kind = statusOf(rows, x.team, cut, { min: per.min, max: per.max, win: per.win }).kind;
        const qualified = x.after.endsWith(DICT["table.qual.status.qualified"]!);
        if (kind === "through" && !qualified) return `${x.team} was Through and did not qualify`;
        if (kind === "out" && qualified) return `${x.team} was Out and qualified`;
      }
      const list = final.slice(0, cut).map((x) => x.team);
      const text = list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
      if (r.facts.qualifiedTeams !== text) return `qualifiedTeams is '${String(r.facts.qualifiedTeams)}', the finished table gives '${text}'`;
      const finalOut = DICT["table.qual.headline.outFrozen"]!.replace("{next}", NEXT_STAGE);
      return r.facts.finalOutHeadline === finalOut || `finalOutHeadline is '${String(r.facts.finalOutHeadline)}', the dictionary gives '${finalOut}'`;
    }),
  },
  {
    says: "before any match is played there is nothing to read, so the builder shows no status at all",
    source: "the engine's rule: an open table with nothing played shows none (anyPlayed is false); asked of the app's builder on the same teams with no result",
    check: guarded((r) => r.facts.noStatusBeforePlay === "none" || `noStatusBeforePlay is '${String(r.facts.noStatusBeforePlay)}'`),
  },
  {
    says: "the table's caption and the picture's caption say what the example is, in words, and the picture draws every row's range and words",
    source: "the example's own facts and table, read back into the caption, the title and the picture",
    check: guarded((r) => {
      const f = r.facts;
      const cap = `${capitalised(numberWord(Number(f.teams)))} teams play ${numberWord(Number(f.matchesEach))} rounds and the top ${numberWord(Number(f.cut))} go on. The table is read with ${numberWord(Number(f.leftEach))} round to play, then again once it is played.`;
      if (r.table?.caption !== cap) return `the caption is '${r.table?.caption ?? ""}', expected '${cap}'`;
      const title = `Each bar runs from the fewest points a team can finish on to the most. A team is out when ${numberWord(Number(f.cut))} rivals are already ahead of the most it can reach, and through when fewer than ${numberWord(Number(f.cut))} rivals can still reach its fewest.`;
      const d = r.diagram;
      if (d?.kind !== "pointsRanges") return "no points-ranges diagram";
      if (d.title !== title) return `the picture's caption is '${d.title}', expected '${title}'`;
      const rows = rowsOf(r);
      if (d.rows.length !== rows.length) return `${d.rows.length} bars, ${rows.length} rows`;
      if (d.axisMax !== Math.max(...rows.map((x) => x.best))) return `axisMax is ${d.axisMax}`;
      for (const [i, x] of rows.entries()) {
        const b = d.rows[i]!;
        if (b.team !== x.team || b.label !== x.label || b.now !== x.points || b.worst !== x.worst || b.best !== x.best) return `bar ${i + 1} (${b.team}) is not row ${i + 1} (${x.team})`;
      }
      return true;
    }),
  },
  {
    says: "in every sport the rule runs on that sport's own points per match, which pay more for a win than a loss, so a status can be read; and the sport count is the registry's",
    source: "each sport's own declaration of the points a match can pay under the variant a new division starts on (the module's matchPointsBounds), swept with forEachSport",
    check: guarded((r) => {
      const { visited, flat } = perMatchSpread();
      if (visited === 0) return "the sweep visited no sport";
      if (flat.length > 0) return `no per-match spread for ${flat.join(", ")}`;
      return Number(r.facts.sportCount) === visited || `sportCount is ${String(r.facts.sportCount)}, the registry has ${visited}`;
    }),
  },
];

export const clinchedOrEliminated: BlogExample = {
  id: CLINCHED_ID,
  kind: "engine",
  sports: "all",
  build: () => build(),
  claims,
};
