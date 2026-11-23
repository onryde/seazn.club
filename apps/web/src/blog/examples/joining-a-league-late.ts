// Post #33, "Can a team join a league after it has started?". Five football teams are drawn into a one-leg league (the app's own
// league draw, as in the round-robin post) and three of the five rounds are played. A sixth team, Tigers, is added. The catch-up the
// newcomer owes is the app's own decision (`decideRoundRobinLateEntry`, whose set is the engine's `lateEntryFixtures`), fed what
// the usecase feeds it: the members in seed order, the stage's lines, each team's rest round and whether its round has started. The
// words the organiser reads afterwards come from the app's notice builder (`tableLateEntryLines`) over the real English dictionary.
//
// WHAT CHECKS IT. The claims restate the rule in plain arithmetic over the printed schedule and never call the decision: a newcomer
// owes one match against every team in the league; a team whose rest round has not started plays the newcomer in that round, and every
// other team gets a new round after the last one, one match to a round; no round already played is touched; and the newcomer's home
// and away games differ by at most one. The sentences are rebuilt from the dictionary's own templates.
import { forEachSport } from "@seazn/engine/testkit";
import { decideRoundRobinLateEntry, type ByeSlot, type ExistingLine } from "@/lib/roundrobin-late-entry";
import { tableLateEntryLines, type TableLateEntryLine } from "@/lib/roundrobin-late-entry-notice";
import type { TableLateEntryResult } from "@/server/api-v1/schemas";
import uiDict from "@/dictionaries/en/ui.json";
import { plural, t, type TKey } from "@/lib/i18n-runtime";
import { draw } from "./round-robin-schedule";
import { capitalised, col, guarded, numberWord, offeredInEverySportClaim } from "./swiss-claims";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const JOINING_A_LEAGUE_LATE_ID = "joining-a-league-late";

/** The league's teams, best seed first (the order the schedule is built from). */
const TEAMS = ["Hawks", "Rockets", "Comets", "Dynamos", "Wolves"] as const;
const NEWCOMER = "Tigers";
/** Rounds one to three are played when the newcomer is added. */
const PLAYED_ROUNDS = 3;
const DICT = uiDict as Record<string, string>;
const idOf = (name: string) => name.toLowerCase();
const nameOfId = (id: string) => [...TEAMS, NEWCOMER].find((x) => idOf(x) === id) ?? id;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

const msg = (k: TKey, v?: Record<string, string | number>) => t(uiDict as never, k, v);
const pl = (k: string, n: number, v?: Record<string, string | number>) => plural(uiDict as never, k, n, "en", v);

/** One notice line as the page prints it: its words from the real dictionary. */
const said = (line: TableLateEntryLine): string => ("plural" in line ? pl(line.plural, line.count, line.params) : msg(line.key as TKey, line.params));

function build(): ExampleResult {
  const drawn = draw(TEAMS, 1);
  const rounds = [...new Set(drawn.lines.map((l) => l.round))].sort((a, b) => a - b);
  const lastRound = rounds[rounds.length - 1]!;
  const lines: ExistingLine[] = drawn.lines.map((l) => ({ home: idOf(l.home), away: idOf(l.away), roundNo: l.round, leg: 1 }));
  const byes: ByeSlot[] = [...drawn.rests].map(([roundNo, team]) => ({ entrantId: idOf(team), roundNo, leg: 1, started: roundNo <= PLAYED_ROUNDS }));
  const input = { stageComplete: false, stageStarted: true, members: TEAMS.map(idOf), newcomer: idOf(NEWCOMER), legs: 1, lines, byes, lastRoundNo: lastRound };
  const decision = decideRoundRobinLateEntry(input);
  if (decision.case !== "catch_up") throw new Error(`joining-a-league-late: the decision is '${decision.case}', not a catch-up`);
  const set = [...decision.fixtures].sort((a, b) => a.placement.roundNo - b.placement.roundNo);
  // The wire answer the usecase writes (placement and round per line), run through the app's notice builder.
  const wire: TableLateEntryResult = {
    format: "league",
    entrant_id: idOf(NEWCOMER),
    stage_id: "blog-stage",
    case: "catch_up",
    source: "organiser",
    fixtures: set.map((f, i) => ({ fixture_id: `blog-fixture-${i + 1}`, round_no: f.placement.roundNo, placement: f.placement.kind, scheduled: false })),
    appended_rounds: decision.appendedRounds,
  };
  const notice = tableLateEntryLines(wire, nameOfId, { locale: "en", pooled: false }).map(said);
  const before = decideRoundRobinLateEntry({ ...input, stageStarted: false });
  const finished = decideRoundRobinLateEntry({ ...input, stageComplete: true });
  if (before.case !== "rebuild_offered") throw new Error(`joining-a-league-late: before any match the decision is '${before.case}'`);
  if (finished.case !== "refused") throw new Error(`joining-a-league-late: a finished stage gives '${finished.case}'`);
  const opponentOf = (f: (typeof set)[number]) => nameOfId(f.home === idOf(NEWCOMER) ? f.away : f.home);
  const inRest = set.filter((f) => f.placement.kind === "bye_slot");
  const appended = set.filter((f) => f.placement.kind === "catch_up_round");
  const homeGames = set.filter((f) => f.home === idOf(NEWCOMER)).length;
  const rows = set.map((f) => [f.placement.roundNo, `${nameOfId(f.home)} v ${nameOfId(f.away)}`, f.placement.kind === "bye_slot" ? `In a round ${opponentOf(f)} sit out` : "In a new round"]);
  const scheduleLines = rounds.map((r) => {
    const matches = drawn.lines.filter((l) => l.round === r).map((l) => `${l.home} v ${l.away}`);
    return `Round ${r}: ${matches.join(", ")}. ${drawn.rests.get(r)} rest.`;
  });
  const scene = {
    heading: `${NEWCOMER} join after round ${PLAYED_ROUNDS}`,
    lead: `${set.length} matches owed, one against each team:`,
    effect: `${inRest.length} in a rest round, ${appended.length} in new rounds`,
    lines: set.map((f) => ({
      round: `Round ${f.placement.roundNo}`,
      opponent: opponentOf(f),
      fate: f.placement.kind === "bye_slot" ? "Rest round" : "New round",
      tone: f.placement.kind === "bye_slot" ? ("keep" as const) : ("new" as const),
    })),
  };
  return {
    facts: {
      teams: TEAMS.length,
      signUpOrder: list([...TEAMS]),
      newcomer: NEWCOMER,
      playedRounds: PLAYED_ROUNDS,
      lastRound,
      owed: set.length,
      restFilled: inRest.length,
      restOpponents: list(inRest.map(opponentOf)),
      restRounds: list(inRest.map((f) => String(f.placement.roundNo))),
      appended: appended.length,
      newRounds: list(appended.map((f) => String(f.placement.roundNo))),
      lastRoundAfter: lastRound + decision.appendedRounds,
      homeGames,
      awayGames: set.length - homeGames,
      noticeCatchUp: notice[0] ?? "",
      noticeUnscheduled: notice[1] ?? "",
      noticeOpponents: notice[2] ?? "",
      rebuildOffered: msg("roundrobin.lateEntry.rebuildOffered", { name: NEWCOMER }),
      finishedRefusal: msg(`roundrobin.refusal.${finished.code}` as TKey),
      waitingTitle: msg("roundrobin.waiting.title"),
      addToTable: msg("roundrobin.addToTable"),
      rebuildButton: msg("progression.rosterDrift.rebuildCta"),
      lockedNote: msg("entrants.locked.note"),
      sportCount: forEachSport(() => undefined),
    },
    table: {
      caption: `${capitalised(numberWord(TEAMS.length))} teams play one league and ${numberWord(PLAYED_ROUNDS)} of its ${numberWord(rounds.length)} rounds are played. ${NEWCOMER} join, and owe a match against each of them.`,
      columns: ["Round", "Match", "Where it goes"],
      rows,
    },
    diagram: {
      kind: "fixtureList",
      title: `${NEWCOMER} join after round ${PLAYED_ROUNDS}. A team whose rest round has not been played plays them in it. Every other team gets a new round after the last one.`,
      scenes: [scene],
    },
    text: scheduleLines,
  };
}

// ---- claims ----

function scheduleOf(r: ExampleResult): { rounds: Map<number, string[][]>; rest: Map<number, string> } {
  const rounds = new Map<number, string[][]>();
  const rest = new Map<number, string>();
  for (const line of r.text) {
    const m = /^Round (\d+): (.+)\. (.+) rest\.$/.exec(line);
    if (m === null) throw new Error(`'${line}' is not a schedule line`);
    rounds.set(Number(m[1]), m[2]!.split(", ").map((x) => x.split(" v ")));
    rest.set(Number(m[1]), m[3]!);
  }
  return { rounds, rest };
}

interface Owed {
  round: number;
  home: string;
  away: string;
  where: string;
}

function owedOf(r: ExampleResult): Owed[] {
  const c = { round: col(r, "Round"), match: col(r, "Match"), where: col(r, "Where it goes") };
  return (r.table?.rows ?? []).map((row) => {
    const m = /^(.+) v (.+)$/.exec(String(row[c.match]));
    if (m === null || typeof row[c.round] !== "number") throw new Error(`'${String(row[c.match])}' / '${String(row[c.round])}' is not a round and a match`);
    return { round: row[c.round] as number, home: m[1]!, away: m[2]!, where: String(row[c.where]) };
  });
}

const claims: Claim[] = [
  {
    says: "the newcomer owes exactly one match against each team of the league, never one against itself, and the schedule printed is every team once against every other (a round robin of five)",
    source: "the printed schedule and the definition of a single round robin (every pair once); one match against each existing team is what a late team owes",
    check: guarded((r) => {
      const { rounds } = scheduleOf(r);
      const teams = Number(r.facts.teams);
      const pairs = new Set<string>();
      let matches = 0;
      for (const ms of rounds.values()) for (const [a, b] of ms) { pairs.add([a, b].sort().join("|")); matches++; }
      if (matches !== (teams * (teams - 1)) / 2 || pairs.size !== matches) return `${matches} matches and ${pairs.size} pairs, a round robin of ${teams} is ${(teams * (teams - 1)) / 2}`;
      const owed = owedOf(r);
      const newcomer = String(r.facts.newcomer);
      const opponents = owed.map((o) => (o.home === newcomer ? o.away : o.home));
      if (owed.some((o) => o.home !== newcomer && o.away !== newcomer)) return "a match owed is not the newcomer's";
      const everyone = new Set([...rounds.values()].flat(2));
      const signedUp = String(r.facts.signUpOrder).split(/, | and /);
      if (signedUp.length !== teams || new Set(signedUp).size !== teams || !signedUp.every((x) => everyone.has(x))) return `signUpOrder is '${String(r.facts.signUpOrder)}', the schedule's teams are ${[...everyone].join(", ")}`;
      if (opponents.length !== everyone.size || new Set(opponents).size !== everyone.size || !opponents.every((o) => everyone.has(o))) return `the newcomer meets ${opponents.join(", ")}, the league is ${[...everyone].join(", ")}`;
      return Number(r.facts.owed) === owed.length || `owed is ${String(r.facts.owed)}, the table lists ${owed.length}`;
    }),
  },
  {
    says: "a team whose rest round has not been played meets the newcomer in that round; every other team gets a new round after the last, one match to a round, and no round already played is touched",
    source: "the printed schedule: each team's rest round, and which rounds are played; the rule that a rest round nobody has started is used first and the rest are appended, one match a round",
    check: guarded((r) => {
      const { rounds, rest } = scheduleOf(r);
      const played = Number(r.facts.playedRounds);
      const lastRound = Math.max(...rounds.keys());
      if (Number(r.facts.lastRound) !== lastRound) return `lastRound is ${String(r.facts.lastRound)}, the schedule's is ${lastRound}`;
      const newcomer = String(r.facts.newcomer);
      const owed = owedOf(r);
      const restRoundOf = (team: string) => [...rest].find(([, t2]) => t2 === team)?.[0];
      let inRest = 0;
      const appendedRounds: number[] = [];
      for (const o of owed) {
        const opponent = o.home === newcomer ? o.away : o.home;
        const restRound = restRoundOf(opponent);
        if (restRound === undefined) return `${opponent} has no rest round in the schedule`;
        if (restRound > played) {
          if (o.round !== restRound || o.where !== `In a round ${opponent} sit out`) return `${opponent} rests in round ${restRound}, the match is in round ${o.round} ('${o.where}')`;
          inRest++;
        } else {
          if (o.round <= lastRound || o.where !== "In a new round") return `${opponent}'s rest round is played, so the match is in a new round, not round ${o.round} ('${o.where}')`;
          appendedRounds.push(o.round);
        }
      }
      appendedRounds.sort((a, b) => a - b);
      if (appendedRounds.some((rd, i) => rd !== lastRound + 1 + i)) return `the new rounds are ${appendedRounds.join(", ")}, not one after another after round ${lastRound}`;
      if (inRest !== Number(r.facts.restFilled) || appendedRounds.length !== Number(r.facts.appended)) return `restFilled/appended are ${String(r.facts.restFilled)}/${String(r.facts.appended)}, the table gives ${inRest}/${appendedRounds.length}`;
      if (Number(r.facts.lastRoundAfter) !== lastRound + appendedRounds.length) return `lastRoundAfter is ${String(r.facts.lastRoundAfter)}, expected ${lastRound + appendedRounds.length}`;
      // The facts that name them.
      const restRoundsSaid = owed.filter((o) => o.where !== "In a new round").map((o) => String(o.round));
      const restOpponents = owed.filter((o) => o.where !== "In a new round").map((o) => (o.home === newcomer ? o.away : o.home));
      if (r.facts.restRounds !== list(restRoundsSaid) || r.facts.restOpponents !== list(restOpponents)) return `restRounds/restOpponents are '${String(r.facts.restRounds)}'/'${String(r.facts.restOpponents)}', the table gives '${list(restRoundsSaid)}'/'${list(restOpponents)}'`;
      if (r.facts.newRounds !== list(appendedRounds.map(String))) return `newRounds is '${String(r.facts.newRounds)}', the table gives '${list(appendedRounds.map(String))}'`;
      // The right answer differs from the wrong constant: the league needs more rounds than a plain add-one-round would give.
      return appendedRounds.length > 1 && appendedRounds.length < owed.length || `${appendedRounds.length} new rounds of ${owed.length} owed: the example does not separate the two placements`;
    }),
  },
  {
    says: "the newcomer's home and away games differ by at most one",
    source: "the table's matches: a late team's home sides alternate along the owed matches (engine RB5-G2)",
    check: guarded((r) => {
      const newcomer = String(r.facts.newcomer);
      const owed = owedOf(r);
      const home = owed.filter((o) => o.home === newcomer).length;
      const away = owed.length - home;
      if (Number(r.facts.homeGames) !== home || Number(r.facts.awayGames) !== away) return `homeGames/awayGames are ${String(r.facts.homeGames)}/${String(r.facts.awayGames)}, the table gives ${home}/${away}`;
      return Math.abs(home - away) <= 1 && owed.length > 1 || `${home} home and ${away} away`;
    }),
  },
  {
    says: "the organiser's notice says how many catch-up matches the newcomer has and in which rounds, that the new matches have no time or court yet, and that their opponents are not told: the dictionary's own sentences filled from the table",
    source: "the English dictionary's roundrobin.lateEntry.catchUp, unscheduled and tellOpponents strings, with the rounds listed by Intl.ListFormat from the table's own rounds",
    check: guarded((r) => {
      const owed = owedOf(r);
      const rounds = owed.map((o) => o.round).sort((a, b) => a - b);
      const roundsText = new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(rounds.map(String));
      const catchUp = DICT[owed.length === 1 ? "roundrobin.lateEntry.catchUp.one" : "roundrobin.lateEntry.catchUp.other"]!.replace("{name}", String(r.facts.newcomer)).replace("{count}", String(owed.length)).replace("{rounds}", roundsText);
      if (r.facts.noticeCatchUp !== catchUp) return `noticeCatchUp is '${String(r.facts.noticeCatchUp)}', the dictionary gives '${catchUp}'`;
      const unscheduled = DICT[owed.length === 1 ? "roundrobin.lateEntry.unscheduled.one" : "roundrobin.lateEntry.unscheduled.other"]!.replace("{count}", String(owed.length));
      if (r.facts.noticeUnscheduled !== unscheduled) return `noticeUnscheduled is '${String(r.facts.noticeUnscheduled)}', the dictionary gives '${unscheduled}'`;
      return r.facts.noticeOpponents === DICT["roundrobin.lateEntry.tellOpponents"] || `noticeOpponents is '${String(r.facts.noticeOpponents)}'`;
    }),
  },
  {
    says: "a team that arrives by itself waits in a strip with an add button, and before any match is played the strip offers to draw the league again; a complete league shows no add box and refuses a team sent anyway: all in the dictionary's own words",
    source: "the English dictionary's roundrobin.waiting.title, roundrobin.addToTable, roundrobin.lateEntry.rebuildOffered, progression.rosterDrift.rebuildCta, entrants.locked.note and roundrobin.refusal.RR_LATE_ENTRY_STAGE_COMPLETE strings, as the waiting strip and the entrants page print them",
    check: guarded((r) => {
      const rebuild = DICT["roundrobin.lateEntry.rebuildOffered"]!.replace("{name}", String(r.facts.newcomer));
      if (r.facts.rebuildOffered !== rebuild) return `rebuildOffered is '${String(r.facts.rebuildOffered)}', the dictionary gives '${rebuild}'`;
      for (const [fact, key] of [
        ["waitingTitle", "roundrobin.waiting.title"],
        ["addToTable", "roundrobin.addToTable"],
        ["rebuildButton", "progression.rosterDrift.rebuildCta"],
        ["lockedNote", "entrants.locked.note"],
        ["finishedRefusal", "roundrobin.refusal.RR_LATE_ENTRY_STAGE_COMPLETE"],
      ] as const) {
        if (r.facts[fact] !== DICT[key]) return `${fact} is '${String(r.facts[fact])}', the dictionary gives '${String(DICT[key])}'`;
      }
      return true;
    }),
  },
  {
    says: "the caption and the picture say what the example is, in words, and the picture draws every match the newcomer owes with where it goes",
    source: "the example's own facts and table, read back into the caption, the picture's title and its lines",
    check: guarded((r) => {
      const f = r.facts;
      const cap = `${capitalised(numberWord(Number(f.teams)))} teams play one league and ${numberWord(Number(f.playedRounds))} of its ${numberWord(Number(f.lastRound))} rounds are played. ${String(f.newcomer)} join, and owe a match against each of them.`;
      if (r.table?.caption !== cap) return `the caption is '${r.table?.caption ?? ""}', expected '${cap}'`;
      const d = r.diagram;
      if (d?.kind !== "fixtureList") return "no fixture-list diagram";
      const title = `${String(f.newcomer)} join after round ${String(f.playedRounds)}. A team whose rest round has not been played plays them in it. Every other team gets a new round after the last one.`;
      if (d.title !== title) return `the picture's caption is '${d.title}', expected '${title}'`;
      const scene = d.scenes[0];
      if (d.scenes.length !== 1 || scene === undefined) return `${d.scenes.length} scenes`;
      if (scene.heading !== `${String(f.newcomer)} join after round ${String(f.playedRounds)}`) return `the heading is '${scene.heading}'`;
      if (scene.lead !== `${String(f.owed)} matches owed, one against each team:` || scene.effect !== `${String(f.restFilled)} in a rest round, ${String(f.appended)} in new rounds`) return `the verdict is '${scene.lead} ${scene.effect}'`;
      const owed = owedOf(r);
      if (scene.lines.length !== owed.length) return `${scene.lines.length} lines, ${owed.length} matches owed`;
      const newcomer = String(f.newcomer);
      for (const [i, o] of owed.entries()) {
        const line = scene.lines[i]!;
        const opponent = o.home === newcomer ? o.away : o.home;
        const rest = o.where !== "In a new round";
        if (line.round !== `Round ${o.round}` || line.opponent !== opponent || line.fate !== (rest ? "Rest round" : "New round") || line.tone !== (rest ? "keep" : "new")) return `line ${i + 1} is '${line.round} ${line.opponent} ${line.fate}' (${line.tone}), the table has round ${o.round}, ${opponent}, '${o.where}'`;
      }
      return owed.length > 0;
    }),
  },
  offeredInEverySportClaim("league", "league", "sportCount"),
];

export const joiningALeagueLate: BlogExample = {
  id: JOINING_A_LEAGUE_LATE_ID,
  kind: "engine",
  sports: "all",
  build: () => build(),
  claims,
};
