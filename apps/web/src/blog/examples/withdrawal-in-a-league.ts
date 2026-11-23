// Post #32, "What happens to a team's results when it withdraws from a league?". Five football teams play a one-leg league
// (the schedule is the app's own league draw, as in the round-robin post). The same league is run twice with the same team,
// Dynamos, leaving at two moments: after round 1, when they have played one of their four matches, and after round 3, when
// they have played two. The rule that decides what happens to their matches is the engine's (`withdrawTableEntrant`), fed the
// way the app's withdrawal and the qualification builder feed it (`tableWithdrawalInputs`); its answer (void every match of the
// leaver, or walk the unplayed ones over to the opponents) is then applied to the stage, and the finished table is ranked by
// the app's own producer, each result played through the engine's event stream. A walkover is recorded the way the cascade
// records it (`core.forfeit` with the reason "withdrew").
//
// WHAT CHECKS IT. The claims hold the engine's rule to the half-way line written in the product's rule (fewer than half played:
// the leaver's matches are voided; half or more: the played results stand and the rest are walkovers), at every count of a
// schedule of every size from one to eight; they recompute both tables from the printed results and football's declared points;
// they check that every other team is compared on the same number of matches in each case; and they sweep the registry for
// the walkover being a win for the opponent in every sport.
import { withdrawTableEntrant } from "@seazn/engine/competition";
import { declaredCfgs, forEachSport } from "@seazn/engine/testkit";
import { tableWithdrawalInputs, type WithdrawalFixtureRow } from "@/lib/table-withdrawal";
import { withdrawalNoteText } from "@/lib/table-withdrawal-note";
import publicDict from "@/dictionaries/en/public.json";
import { t, type TKey } from "@/lib/i18n-runtime";
import { builtinModules } from "@seazn/engine/sports";
import { forfeitFold } from "./forfeit-scores";
import { declaredLeaguePoints } from "./kit";
import { draw } from "./round-robin-schedule";
import { startingVariantKey } from "./starting-variant";
import { playAndRank, type Meeting, type RankedStage } from "./tie-break-play";
import { capitalised, col, guarded, numberWord } from "./swiss-claims";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const WITHDRAWAL_IN_A_LEAGUE_ID = "withdrawal-in-a-league";

/** Best seed first: the order the league's schedule is drawn from. */
const TEAMS = ["Hawks", "Rockets", "Comets", "Dynamos", "Wolves"] as const;
const LEAVER = "Dynamos";
/** The two moments the same team leaves: after this many rounds are played. */
const EARLY = 1;
const LATE = 3;
const idOf = (name: string) => name.toLowerCase();
const pairKey = (a: string, b: string) => [a, b].sort().join("|");
const pointsText = (n: number) => `${n} ${n === 1 ? "point" : "points"}`;

/** The goals each side scores in the match between a pair, by team: the example's own input. A pair the leaver is in has a score only
 *  where it is played before they leave (the first and the third round); the other two never are. */
const GOALS: Record<string, Record<string, number>> = {
  [pairKey("Hawks", "Dynamos")]: { Hawks: 2, Dynamos: 0 },
  [pairKey("Rockets", "Comets")]: { Rockets: 1, Comets: 1 },
  [pairKey("Hawks", "Rockets")]: { Hawks: 1, Rockets: 0 },
  [pairKey("Wolves", "Comets")]: { Wolves: 0, Comets: 1 },
  [pairKey("Dynamos", "Rockets")]: { Dynamos: 1, Rockets: 0 },
  [pairKey("Wolves", "Hawks")]: { Wolves: 1, Hawks: 2 },
  [pairKey("Comets", "Hawks")]: { Comets: 0, Hawks: 0 },
  [pairKey("Rockets", "Wolves")]: { Rockets: 1, Wolves: 0 },
};

const PUBLIC = publicDict as Record<string, string>;
/** The line the public table prints under a table for the leaver, in the real English dictionary (`withdrawalNoteText`). */
const footnote = (s: { mode: string; played: number; total: number }): string => {
  const line = withdrawalNoteText(
    { entrantId: idOf(LEAVER), name: LEAVER, status: "withdrawn", policy: s.mode === "voided" ? "expunge" : "walkover", played: s.played, scheduled: s.total },
    (key: TKey, vars?: Record<string, string | number>) => t(publicDict as never, key, vars),
  );
  return `${line.lead} ${line.body}`;
};

const football = () => builtinModules.find((m) => m.key === "football")!;

interface Line {
  id: string;
  round: number;
  home: string;
  away: string;
}

/** What the engine's rule did to one of the leaver's matches, by schedule line id. */
type Fate = "stands" | "removed" | "walkover";

interface Scene {
  leaveAfter: number;
  played: number;
  total: number;
  mode: "voided" | "awarded";
  lines: Line[];
  fates: Map<string, Fate>;
  ranked: RankedStage;
}

const scoreOf = (l: Line) => {
  const g = GOALS[pairKey(l.home, l.away)];
  return g === undefined ? undefined : ([g[l.home]!, g[l.away]!] as const);
};

function scene(sport: ReturnType<typeof football>, cfg: unknown, schedule: Line[], leaveAfter: number): Scene {
  const leaverId = idOf(LEAVER);
  const mine = schedule.filter((l) => l.home === LEAVER || l.away === LEAVER);
  // The leaver's matches as the app reads them when they leave: decided where the round is played, else still to play.
  const rows: WithdrawalFixtureRow[] = mine.map((l) => ({
    id: l.id,
    status: l.round <= leaveAfter ? "decided" : "scheduled",
    home_entrant_id: idOf(l.home),
    away_entrant_id: idOf(l.away),
    outcome: l.round <= leaveAfter ? { kind: "win" } : null,
  }));
  const input = tableWithdrawalInputs(leaverId, rows);
  const plan = withdrawTableEntrant({ id: "blog-stage", kind: "league" }, leaverId, input);
  const event = plan.events[0];
  if (event === undefined || event.type !== "entrant_withdrawn" || event.policy !== "void_remaining") throw new Error("withdrawal-in-a-league: the withdrawal is not a table withdrawal");
  if (event.played === undefined || event.scheduled === undefined) throw new Error("withdrawal-in-a-league: the engine's withdrawal event carries no played and scheduled counts");
  const updates = new Map(plan.updates.map((u) => [u.fixtureId, u] as const));
  const fates = new Map<string, Fate>();
  const meetings: Meeting[] = [];
  for (const l of schedule) {
    const update = updates.get(l.id);
    if (update?.status === "void") {
      fates.set(l.id, "removed");
      continue;
    }
    if (update?.status === "walkover") {
      fates.set(l.id, "walkover");
      meetings.push({ home: idOf(l.home), away: idOf(l.away), round: l.round, what: `${l.home} v ${l.away}, walked over`, walkoverBy: leaverId, walkoverReason: "withdrew" });
      continue;
    }
    if (l.home === LEAVER || l.away === LEAVER) fates.set(l.id, "stands");
    const goals = scoreOf(l);
    if (goals === undefined) throw new Error(`withdrawal-in-a-league: no score for ${l.home} v ${l.away}, a match that is played`);
    meetings.push({ home: idOf(l.home), away: idOf(l.away), round: l.round, what: `${l.home} ${goals[0]}-${goals[1]} ${l.away}`, want: (v) => v.home.metrics.gf === goals[0] && v.away.metrics.gf === goals[1] });
  }
  const entrants = TEAMS.map((name, i) => ({ id: idOf(name), name, seed: i + 1 }));
  const ranked = playAndRank({ module: sport, cfg, kind: "league", entrants, meetings });
  return { leaveAfter, played: event.played, total: event.scheduled, mode: event.mode === "expunge" ? "voided" : "awarded", lines: mine, fates, ranked };
}

function build(): ExampleResult {
  const sport = football();
  const variant = startingVariantKey(sport);
  const cfg = declaredCfgs(sport).find((c) => c.name === variant)?.cfg;
  if (cfg === undefined) throw new Error(`withdrawal-in-a-league: football has no declared variant '${variant}'`);
  const drawn = draw(TEAMS, 1);
  const schedule: Line[] = drawn.lines.map((l, i) => ({ id: `blog-line-${i + 1}`, round: l.round, home: l.home, away: l.away }));
  const early = scene(sport, cfg, schedule, EARLY);
  const late = scene(sport, cfg, schedule, LATE);
  const rowOf = (s: Scene, name: string) => {
    const r = s.ranked.rows.find((x) => x.entrantId === idOf(name));
    if (r === undefined) throw new Error(`withdrawal-in-a-league: no row for ${name}`);
    return r;
  };
  const others = TEAMS.filter((t) => t !== LEAVER);
  const firstRound = schedule.find((l) => l.round === 1 && (l.home === LEAVER || l.away === LEAVER))!;
  const firstOpponent = firstRound.home === LEAVER ? firstRound.away : firstRound.home;
  const walkedOver = late.lines.filter((l) => late.fates.get(l.id) === "walkover");
  const walkoverWinners = walkedOver.map((l) => (l.home === LEAVER ? l.away : l.home));
  const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  const matchesCounted = (s: Scene, name: string) => rowOf(s, name).played;
  const facts: Record<string, string | number> = {
    teams: TEAMS.length,
    matchesEach: TEAMS.length - 1,
    signUpOrder: list([...TEAMS]),
    leaver: LEAVER,
    earlyRound: EARLY,
    earlyPlayed: early.played,
    earlyTotal: early.total,
    earlyMode: early.mode,
    lateRound: LATE,
    latePlayed: late.played,
    lateTotal: late.total,
    lateMode: late.mode,
    half: late.total / 2,
    earlyCounted: matchesCounted(early, others[0]!),
    lateCounted: matchesCounted(late, others[0]!),
    firstOpponent,
    firstOpponentPointsEarly: rowOf(early, firstOpponent).points,
    firstOpponentPointsLate: rowOf(late, firstOpponent).points,
    walkoverWinners: list(walkoverWinners),
    walkoverRounds: list(walkedOver.map((l) => String(l.round))),
    leaverEarlyPoints: rowOf(early, LEAVER).points,
    leaverEarlyPlayed: rowOf(early, LEAVER).played,
    leaverLatePoints: rowOf(late, LEAVER).points,
    earlyNote: footnote({ mode: early.mode, played: early.played, total: early.total }),
    lateNote: footnote({ mode: late.mode, played: late.played, total: late.total }),
    sportCount: forEachSport(() => undefined),
  };
  const columns = ["Team", `Played (out after round ${EARLY})`, `Points (out after round ${EARLY})`, `Played (out after round ${LATE})`, `Points (out after round ${LATE})`];
  const rows = TEAMS.map((name) => {
    const a = rowOf(early, name);
    const b = rowOf(late, name);
    return [name, a.played, pointsText(a.points), b.played, pointsText(b.points)];
  });
  const fateText = (s: Scene, l: Line): string => {
    const f = s.fates.get(l.id)!;
    const winner = l.home === LEAVER ? l.away : l.home;
    return f === "walkover" ? `Walkover to ${winner}` : f === "stands" ? "Result stands" : l.round <= s.leaveAfter ? "Result removed" : "Match removed";
  };
  const sceneModel = (s: Scene) => ({
    heading: `${LEAVER} leave after round ${s.leaveAfter}`,
    lead: `${s.played} of ${s.total} played, ${s.played * 2 < s.total ? "under half" : "half or more"}:`,
    effect: s.mode === "voided" ? "every match is removed" : "results stand, the rest are walkovers",
    lines: s.lines.map((l) => ({ round: `Round ${l.round}`, opponent: l.home === LEAVER ? l.away : l.home, fate: fateText(s, l), tone: s.fates.get(l.id) === "removed" ? ("drop" as const) : s.fates.get(l.id) === "walkover" ? ("award" as const) : ("keep" as const) })),
  });
  const resultLines = schedule.flatMap((l) => {
    const g = scoreOf(l);
    if (g === undefined) return [`Round ${l.round}: ${l.home} v ${l.away} is never played.`];
    return [`Round ${l.round}: ${l.home} ${g[0]} — ${g[1]} ${l.away}.`];
  });
  return {
    facts,
    table: {
      caption: `${capitalised(numberWord(TEAMS.length))} football teams play one league. The same league is run twice: ${LEAVER} withdraw after round ${EARLY} in one, and after round ${LATE} in the other. Both tables are the league's last.`,
      columns,
      rows,
    },
    diagram: {
      kind: "fixtureList",
      title: `The same team, ${LEAVER}, leaves at two moments. Under half of their matches played, all of them are removed. Half or more, the results stand and the rest are walkovers.`,
      scenes: [sceneModel(early), sceneModel(late)],
    },
    text: resultLines,
  };
}

// ---- claims ----

interface Result {
  round: number;
  home: string;
  away: string;
  h: number;
  a: number;
}

function resultsOf(r: ExampleResult): { played: Result[]; never: { round: number; home: string; away: string }[] } {
  const played: Result[] = [];
  const never: { round: number; home: string; away: string }[] = [];
  for (const line of r.text) {
    const p = /^Round (\d+): (.+) (\d+) — (\d+) (.+)\.$/.exec(line);
    if (p !== null) {
      played.push({ round: Number(p[1]), home: p[2]!, away: p[5]!, h: Number(p[3]), a: Number(p[4]) });
      continue;
    }
    const n = /^Round (\d+): (.+) v (.+) is never played\.$/.exec(line);
    if (n === null) throw new Error(`'${line}' is not a result line`);
    never.push({ round: Number(n[1]), home: n[2]!, away: n[3]! });
  }
  return { played, never };
}

/** The product's withdrawal rule for a league: fewer than half of the leaver's matches played voids them, half or more keeps them. */
const modeOfRule = (played: number, total: number): "voided" | "awarded" => (played * 2 < total ? "voided" : "awarded");

function pointsPerResult(): { win: number; draw: number; loss: number } {
  const sport = football();
  const variant = startingVariantKey(sport);
  const cfg = declaredCfgs(sport).find((c) => c.name === variant)?.cfg;
  const rule = declaredLeaguePoints(sport, cfg);
  return { win: rule.win.regulation, draw: rule.draw ?? Number.NaN, loss: rule.loss.regulation };
}

interface Cells {
  team: string;
  playedEarly: number;
  pointsEarly: number;
  playedLate: number;
  pointsLate: number;
}

function cellsOf(r: ExampleResult): Cells[] {
  const c = {
    team: col(r, "Team"),
    pe: col(r, `Played (out after round ${EARLY})`),
    ge: col(r, `Points (out after round ${EARLY})`),
    pl: col(r, `Played (out after round ${LATE})`),
    gl: col(r, `Points (out after round ${LATE})`),
  };
  const points = (v: unknown) => {
    const m = /^(\d+) points?$/.exec(String(v));
    if (m === null) throw new Error(`'${String(v)}' is not a points cell`);
    return Number(m[1]);
  };
  return (r.table?.rows ?? []).map((row) => {
    if (typeof row[c.pe] !== "number" || typeof row[c.pl] !== "number") throw new Error("a played cell is not a number");
    return { team: String(row[c.team]), playedEarly: row[c.pe] as number, pointsEarly: points(row[c.ge]), playedLate: row[c.pl] as number, pointsLate: points(row[c.gl]) };
  });
}

/** What each team's table row must be, from the printed schedule and the rule: the matches that count are those the rule keeps. */
function expected(r: ExampleResult, leaveAfter: number): Map<string, { played: number; points: number }> {
  const per = pointsPerResult();
  const { played, never } = resultsOf(r);
  const leaver = String(r.facts.leaver);
  const all = [...played.map((m) => ({ ...m, result: true })), ...never.map((m) => ({ ...m, h: 0, a: 0, result: false }))];
  const involves = (m: { home: string; away: string }) => m.home === leaver || m.away === leaver;
  const mine = all.filter(involves);
  const mode = modeOfRule(mine.filter((m) => m.result && m.round <= leaveAfter).length, mine.length);
  const out = new Map<string, { played: number; points: number }>((r.table?.rows ?? []).map((row) => [String(row[0]), { played: 0, points: 0 }] as const));
  const add = (team: string, pts: number) => {
    const cur = out.get(team);
    if (cur === undefined) throw new Error(`${team} is not a team of the table`);
    out.set(team, { played: cur.played + 1, points: cur.points + pts });
  };
  for (const m of all) {
    if (!involves(m)) {
      add(m.home, m.h > m.a ? per.win : m.h === m.a ? per.draw : per.loss);
      add(m.away, m.a > m.h ? per.win : m.h === m.a ? per.draw : per.loss);
      continue;
    }
    if (mode === "voided") continue; // every match of the leaver is removed, the played one included
    if (m.result && m.round <= leaveAfter) {
      add(m.home, m.h > m.a ? per.win : m.h === m.a ? per.draw : per.loss);
      add(m.away, m.a > m.h ? per.win : m.h === m.a ? per.draw : per.loss);
    } else {
      // Not played before they left: a walkover for the opponent.
      add(m.home === leaver ? m.away : m.home, per.win);
      add(leaver, per.loss);
    }
  }
  return out;
}

const claims: Claim[] = [
  {
    says: "the leaver's matches are removed when fewer than half were played and kept when half or more were, and the example hits the half-way line exactly",
    source: "the product's withdrawal rule for a league (spec 05 section 5; help: Withdrawals): under half played, every result is voided; half or more, played results stand and the rest are walkovers",
    check: guarded((r) => {
      const f = r.facts;
      const early = modeOfRule(Number(f.earlyPlayed), Number(f.earlyTotal));
      const late = modeOfRule(Number(f.latePlayed), Number(f.lateTotal));
      if (f.earlyMode !== early) return `earlyMode is '${String(f.earlyMode)}', ${String(f.earlyPlayed)} of ${String(f.earlyTotal)} gives '${early}'`;
      if (f.lateMode !== late) return `lateMode is '${String(f.lateMode)}', ${String(f.latePlayed)} of ${String(f.lateTotal)} gives '${late}'`;
      if (early === late) return "both moments give the same outcome";
      if (Number(f.latePlayed) * 2 !== Number(f.lateTotal)) return `${String(f.latePlayed)} of ${String(f.lateTotal)} is not exactly half`;
      if (Number(f.half) !== Number(f.lateTotal) / 2) return `half is ${String(f.half)}, half of ${String(f.lateTotal)} is ${Number(f.lateTotal) / 2}`;
      return Number(f.earlyTotal) === Number(f.lateTotal) && Number(f.earlyTotal) === Number(f.matchesEach) || "the leaver's schedule is not the same length at both moments, or not one match against each other team";
    }),
  },
  {
    says: "under the table the app prints one line for the leaver, naming how many of their matches were played and what became of the rest, in the dictionary's own words",
    source: "the English public dictionary's table.withdrawalNote.* sentences, filled with the played and scheduled counts of each case, chosen by the half-way rule",
    check: guarded((r) => {
      const f = r.facts;
      let seen = 0;
      for (const [fact, played, total] of [["earlyNote", Number(f.earlyPlayed), Number(f.earlyTotal)], ["lateNote", Number(f.latePlayed), Number(f.lateTotal)]] as const) {
        const remaining = total - played;
        const key = modeOfRule(played, total) === "voided" ? "table.withdrawalNote.expunged" : remaining === 1 ? "table.withdrawalNote.walkedOverOne" : "table.withdrawalNote.walkedOver";
        const body = PUBLIC[key]!.replace("{played}", String(played)).replace("{scheduled}", String(total)).replace("{remaining}", String(remaining));
        const want = `${PUBLIC["table.withdrawalNote.lead"]!.replace("{name}", String(f.leaver)).replace("{status}", PUBLIC["table.withdrawalNote.status.withdrawn"]!)} ${body}`;
        if (f[fact] !== want) return `${fact} is '${String(f[fact])}', the dictionary gives '${want}'`;
        seen++;
      }
      return seen === 2;
    }),
  },
  {
    says: "the engine applies exactly the half-way line to a league at every count of a schedule of one to eight matches, and a Swiss never removes",
    source: "the product's withdrawal rule restated as arithmetic (under half played voids, half or more awards), against the engine's `withdrawTableEntrant` for league, group and Swiss",
    check: guarded((r) => {
      // The example's own two cases are among those swept, and the engine's answer for each is the one the example reports.
      const ours = [[Number(r.facts.earlyPlayed), Number(r.facts.earlyTotal), r.facts.earlyMode], [Number(r.facts.latePlayed), Number(r.facts.lateTotal), r.facts.lateMode]] as const;
      let cases = 0;
      const oursHit = new Set<string>();
      for (let total = 1; total <= 8; total++) {
        for (let played = 0; played <= total; played++) {
          const rows = [
            ...Array.from({ length: played }, (_, i) => ({ id: `p${i}`, status: "decided", home_entrant_id: "x", away_entrant_id: `o${i}`, outcome: { kind: "win" } })),
            ...Array.from({ length: total - played }, (_, i) => ({ id: `s${i}`, status: "scheduled", home_entrant_id: "x", away_entrant_id: `q${i}`, outcome: null })),
          ] as WithdrawalFixtureRow[];
          const input = tableWithdrawalInputs("x", rows);
          for (const kind of ["league", "group"] as const) {
            const event = withdrawTableEntrant({ id: "s", kind }, "x", input).events[0];
            if (event?.type !== "entrant_withdrawn" || event.policy !== "void_remaining") return "the engine's answer is not a table withdrawal";
            const want = played * 2 < total ? "expunge" : "award";
            if (event.mode !== want) return `${kind}: ${played} of ${total} played gives '${event.mode}', the rule gives '${want}'`;
            const mine = ours.find(([p, t]) => p === played && t === total);
            if (mine !== undefined && mine[2] !== (event.mode === "expunge" ? "voided" : "awarded")) return `the example says '${String(mine[2])}' for ${played} of ${total}, the engine says '${event.mode}'`;
            if (mine !== undefined) oursHit.add(`${played}/${total}`);
            cases++;
          }
          const swiss = withdrawTableEntrant({ id: "s", kind: "swiss" }, "x", input).events[0];
          if (swiss?.type !== "entrant_withdrawn" || swiss.policy !== "void_remaining" || swiss.mode !== "award") return `swiss: ${played} of ${total} played does not award`;
          cases++;
        }
      }
      if (oursHit.size !== 2) return `the example's two cases were not both swept (${[...oursHit].join(", ")})`;
      return cases === 3 * (2 + 3 + 4 + 5 + 6 + 7 + 8 + 9) || `${cases} cases swept`;
    }),
  },
  {
    says: "each table is what the printed results and the rule give: football's declared points for the results that count, a walkover win for the opponent of each match the leaver never plays, and nothing at all for a removed match",
    source: "the printed results paid by football's declared league points, with the leaver's matches voided or awarded by the half-way line",
    check: guarded((r) => {
      const cells = cellsOf(r);
      if (cells.length !== Number(r.facts.teams)) return `${cells.length} rows, ${String(r.facts.teams)} teams`;
      const order = cells.map((c) => c.team);
      const said = order.length <= 1 ? order.join("") : `${order.slice(0, -1).join(", ")} and ${order[order.length - 1]}`;
      if (r.facts.signUpOrder !== said) return `the rows are in the order '${said}', signUpOrder says '${String(r.facts.signUpOrder)}'`;
      const early = expected(r, EARLY);
      const late = expected(r, LATE);
      let checked = 0;
      for (const c of cells) {
        const e = early.get(c.team);
        const l = late.get(c.team);
        if (e === undefined || l === undefined) return `no expected row for ${c.team}`;
        if (c.playedEarly !== e.played || c.pointsEarly !== e.points) return `${c.team} out after round ${EARLY}: ${c.playedEarly} played and ${c.pointsEarly} points, the results give ${e.played} and ${e.points}`;
        if (c.playedLate !== l.played || c.pointsLate !== l.points) return `${c.team} out after round ${LATE}: ${c.playedLate} played and ${c.pointsLate} points, the results give ${l.played} and ${l.points}`;
        checked++;
      }
      return checked === cells.length && checked > 0;
    }),
  },
  {
    says: "every other team is compared on the same number of matches in each case, and the leaver's early row reads as if they never entered",
    source: "the table rows, read against the schedule: a league of n teams gives each team n-1 matches; a removed match is no match for either side",
    check: guarded((r) => {
      const cells = cellsOf(r);
      const leaver = String(r.facts.leaver);
      const others = cells.filter((c) => c.team !== leaver);
      if (others.length !== Number(r.facts.teams) - 1) return `${others.length} other teams, ${Number(r.facts.teams) - 1} expected`;
      const earlyCounted = new Set(others.map((c) => c.playedEarly));
      const lateCounted = new Set(others.map((c) => c.playedLate));
      if (earlyCounted.size !== 1 || lateCounted.size !== 1) return `the other teams' matches differ: ${[...earlyCounted].join("/")} and ${[...lateCounted].join("/")}`;
      const [e] = [...earlyCounted];
      const [l] = [...lateCounted];
      if (e !== Number(r.facts.earlyCounted) || l !== Number(r.facts.lateCounted)) return `earlyCounted/lateCounted are ${String(r.facts.earlyCounted)}/${String(r.facts.lateCounted)}, the table gives ${e}/${l}`;
      // Removed: one fewer match for each (their match against the leaver is gone); awarded: all of them, the walkovers included.
      if (l !== Number(r.facts.matchesEach) || e !== Number(r.facts.matchesEach) - 1) return `the other teams have ${e} and ${l} matches, expected ${Number(r.facts.matchesEach) - 1} and ${String(r.facts.matchesEach)}`;
      const row = cells.find((c) => c.team === leaver);
      if (row === undefined) return "the leaver is not in the table";
      if (row.playedEarly !== 0 || row.pointsEarly !== 0) return `${leaver}'s early row is ${row.playedEarly} played and ${row.pointsEarly} points, not zero`;
      return (Number(r.facts.leaverEarlyPlayed) === 0 && Number(r.facts.leaverEarlyPoints) === 0 && Number(r.facts.leaverLatePoints) === row.pointsLate) || "the leaver facts are not the table's";
    }),
  },
  {
    says: "the right answer differs from the wrong constant: the team that beat the leaver in round one finishes on different points in the two cases, by exactly a win",
    source: "football's declared win points; the same league played with the first match removed and with it kept",
    check: guarded((r) => {
      const per = pointsPerResult();
      const cells = cellsOf(r);
      const team = cells.find((c) => c.team === r.facts.firstOpponent);
      if (team === undefined) return "the first opponent is not in the table";
      const { played } = resultsOf(r);
      const first = played.find((m) => m.round === 1 && (m.home === r.facts.leaver || m.away === r.facts.leaver));
      if (first === undefined) return "no round 1 result for the leaver";
      const beat = (first.home === team.team && first.h > first.a) || (first.away === team.team && first.a > first.h);
      if (!beat) return `${team.team} did not beat the leaver in round 1`;
      if (Number(r.facts.firstOpponentPointsEarly) !== team.pointsEarly || Number(r.facts.firstOpponentPointsLate) !== team.pointsLate) return "firstOpponentPoints are not the table's";
      // They also gain the walkover wins in the late case only when they are the walked-over opponents, so subtract those.
      const walkovers = String(r.facts.walkoverWinners).split(/, | and /).filter((x) => x === team.team).length;
      return team.pointsLate - team.pointsEarly - walkovers * per.win === per.win || `${team.team} differs by ${team.pointsLate - team.pointsEarly}, expected a win (${per.win}) for the match${walkovers > 0 ? ` and ${walkovers} walkover win(s)` : ""}`;
    }),
  },
  {
    says: "the walkovers are won by the leaver's opponents in the rounds they never played, in the late case only",
    source: "the printed schedule: the leaver's matches after the round they left, which the rule awards when half or more were played",
    check: guarded((r) => {
      const { played, never } = resultsOf(r);
      const leaver = String(r.facts.leaver);
      const left = Number(r.facts.lateRound);
      const unplayed = [...never.filter((m) => m.home === leaver || m.away === leaver), ...played.filter((m) => (m.home === leaver || m.away === leaver) && m.round > left)].sort((a, b) => a.round - b.round);
      const winners = unplayed.map((m) => (m.home === leaver ? m.away : m.home));
      const text = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
      if (r.facts.walkoverWinners !== text(winners)) return `walkoverWinners is '${String(r.facts.walkoverWinners)}', the schedule gives '${text(winners)}'`;
      if (r.facts.walkoverRounds !== text(unplayed.map((m) => String(m.round)))) return `walkoverRounds is '${String(r.facts.walkoverRounds)}', the schedule gives '${text(unplayed.map((m) => String(m.round)))}'`;
      return unplayed.length > 0 && unplayed.length === Number(r.facts.lateTotal) - Number(r.facts.latePlayed);
    }),
  },
  {
    says: "the caption and the picture say what the example is, in words, and the picture draws every one of the leaver's matches in both cases with what became of it",
    source: "the example's own facts and table, read back into the caption, the picture's title and its lines",
    check: guarded((r) => {
      const f = r.facts;
      const cap = `${capitalised(numberWord(Number(f.teams)))} football teams play one league. The same league is run twice: ${String(f.leaver)} withdraw after round ${String(f.earlyRound)} in one, and after round ${String(f.lateRound)} in the other. Both tables are the league's last.`;
      if (r.table?.caption !== cap) return `the caption is '${r.table?.caption ?? ""}', expected '${cap}'`;
      const d = r.diagram;
      if (d?.kind !== "fixtureList") return "no fixture-list diagram";
      const title = `The same team, ${String(f.leaver)}, leaves at two moments. Under half of their matches played, all of them are removed. Half or more, the results stand and the rest are walkovers.`;
      if (d.title !== title) return `the picture's caption is '${d.title}', expected '${title}'`;
      if (d.scenes.length !== 2) return `${d.scenes.length} scenes`;
      const leaver = String(f.leaver);
      const { played, never } = resultsOf(r);
      const schedule = [...played.map((m) => ({ round: m.round, home: m.home, away: m.away })), ...never].filter((m) => m.home === leaver || m.away === leaver).sort((a, b) => a.round - b.round);
      let checked = 0;
      for (const [i, s] of d.scenes.entries()) {
        const after = i === 0 ? Number(f.earlyRound) : Number(f.lateRound);
        const mode = modeOfRule(i === 0 ? Number(f.earlyPlayed) : Number(f.latePlayed), i === 0 ? Number(f.earlyTotal) : Number(f.lateTotal));
        if (s.heading !== `${leaver} leave after round ${after}`) return `scene ${i + 1}'s heading is '${s.heading}'`;
        const playedHere = i === 0 ? Number(f.earlyPlayed) : Number(f.latePlayed);
        const totalHere = i === 0 ? Number(f.earlyTotal) : Number(f.lateTotal);
        const lead = `${playedHere} of ${totalHere} played, ${playedHere * 2 < totalHere ? "under half" : "half or more"}:`;
        const effect = mode === "voided" ? "every match is removed" : "results stand, the rest are walkovers";
        if (s.lead !== lead || s.effect !== effect) return `scene ${i + 1}'s verdict is '${s.lead} ${s.effect}', expected '${lead} ${effect}'`;
        if (s.lines.length !== schedule.length) return `scene ${i + 1} draws ${s.lines.length} matches, the leaver has ${schedule.length}`;
        for (const [j, m] of schedule.entries()) {
          const line = s.lines[j]!;
          const opponent = m.home === leaver ? m.away : m.home;
          const done = m.round <= after;
          const want = mode === "voided" ? (done ? "Result removed" : "Match removed") : done ? "Result stands" : `Walkover to ${opponent}`;
          const tone = mode === "voided" ? "drop" : done ? "keep" : "award";
          if (line.round !== `Round ${m.round}` || line.opponent !== opponent || line.fate !== want || line.tone !== tone) return `scene ${i + 1} line ${j + 1}: '${line.round} ${line.opponent} ${line.fate}' (${line.tone}), expected 'Round ${m.round} ${opponent} ${want}' (${tone})`;
          checked++;
        }
      }
      return checked === 2 * schedule.length && checked > 0;
    }),
  },
  {
    says: "in every sport the walkover a withdrawal gives is recorded as a win for the opponent with the reason withdrew, and the sport count is the registry's",
    source: "the cascade's write (`core.forfeit` by the leaver, reason withdrew), folded by the app's read fold in each sport and read for the outcome it decides",
    check: guarded((r) => {
      const bad: string[] = [];
      const visited = forEachSport(({ key, module: sportModule }) => {
        const { outcome } = forfeitFold(sportModule, "ben", "withdrew");
        if (outcome.kind !== "award" || outcome.winner !== "ana" || outcome.loser !== "ben" || outcome.reason !== "withdrew") bad.push(key);
      });
      if (visited === 0) return "the sweep visited no sport";
      if (bad.length > 0) return `not a win for the opponent in: ${bad.join(", ")}`;
      return Number(r.facts.sportCount) === visited || `sportCount is ${String(r.facts.sportCount)}, the registry has ${visited}`;
    }),
  },
];

export const withdrawalInALeague: BlogExample = {
  id: WITHDRAWAL_IN_A_LEAGUE_ID,
  kind: "engine",
  sports: "all",
  build: () => build(),
  claims,
};
